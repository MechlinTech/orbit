/**
 * Calendar and Microsoft Teams interview scheduling service.
 * Orchestrates Microsoft Graph calendar operations, synchronization,
 * idempotency, and error handling.
 */
import { audit } from '../db.js';
import { getGraphAccessToken, createTeamsMeetingEvent, updateTeamsMeetingEvent, cancelTeamsMeetingEvent } from './graph.js';
import { escapeHtml } from '../communication/templates.js';
import { getEffectiveIntegrationConfig } from '../integrations/storage.js';

export function getCalendarConfig(c = {}, db = null) {
  let targetDb = db;
  let conf = c || {};
  if (c && typeof c.prepare === 'function') {
    targetDb = c;
    conf = {};
  } else if (!targetDb && c?.db) {
    targetDb = c.db;
  }

  let dyn = null;
  if (targetDb) {
    try {
      const eff = getEffectiveIntegrationConfig(targetDb, 'microsoft_calendar');
      if (eff && eff.enabled && eff.isConfigured) {
        dyn = {
          tenant: eff.config.tenantId,
          client: eff.config.clientId,
          secret: eff.secrets.clientSecret,
          organizerEmail: eff.config.organizerEmail
        };
      }
    } catch {}
  }

  const adapter = conf?.calendarAdapter;
  const tenant = conf.entraTenantId || adapter?.tenant || dyn?.tenant || process.env.ENTRA_TENANT_ID || process.env.MICROSOFT_TENANT_ID || null;
  const client = conf.entraClientId || adapter?.client || dyn?.client || process.env.ENTRA_CLIENT_ID || process.env.MICROSOFT_CLIENT_ID || null;
  const secret = conf.entraClientSecret || adapter?.secret || dyn?.secret || process.env.ENTRA_CLIENT_SECRET || process.env.MICROSOFT_CLIENT_SECRET || null;
  const organizerEmail = conf.teamsOrganizerEmail || adapter?.organizerEmail || dyn?.organizerEmail || process.env.TEAMS_ORGANIZER_EMAIL || process.env.MICROSOFT_ORGANIZER_EMAIL || null;
  const enabled = process.env.ENABLE_TEAMS_CALENDAR !== 'false' && (conf.enableTeamsCalendar !== false) && (adapter ? Boolean(adapter.configured) : true);

  return {
    tenant,
    client,
    secret,
    organizerEmail,
    enabled: Boolean(tenant && client && secret && organizerEmail && enabled)
  };
}

export function isCalendarConfigured(c = {}, db = null) {
  return getCalendarConfig(c, db).enabled;
}

/**
 * Calculates end date from start date and duration in minutes.
 */
export function calculateEndTime(startsAt, durationMinutes = 45) {
  const startMs = new Date(startsAt).getTime();
  const dur = Math.max(15, Math.min(480, Number(durationMinutes) || 45));
  return new Date(startMs + dur * 60000).toISOString();
}

/**
 * Schedules a Microsoft Teams meeting and syncs the calendar event with the interview.
 * Never throws on provider errors - safely marks calendar_status as sync_failed and audits.
 */
export async function syncScheduleMeeting({
  db,
  user,
  interviewId,
  scheduledAt,
  durationMinutes = 45,
  timezone = 'UTC',
  title = '',
  notes = '',
  candidate,
  req,
  interviewer,
  transport = fetch,
  config = {}
}) {
  const conf = getCalendarConfig(config, db);
  if (!conf.enabled) {
    return {
      synced: false,
      calendar_status: 'not_synced',
      meeting_url: null,
      calendar_event_id: null
    };
  }

  // Idempotency check: if interview already has a calendar event, do not create duplicate
  const existing = db.prepare('SELECT calendar_event_id, meeting_url, calendar_status FROM interviews WHERE id = ?').get(interviewId);
  if (existing?.calendar_event_id && existing?.calendar_status === 'synced') {
    return {
      synced: true,
      calendar_status: 'synced',
      meeting_url: existing.meeting_url,
      calendar_event_id: existing.calendar_event_id,
      idempotent_replay: true
    };
  }

  const isDemo = Boolean(
    (conf.tenant && conf.tenant.includes('demo')) ||
    (conf.client && conf.client.includes('demo')) ||
    (process.env.SIMULATE_TEAMS_MEETING === 'true')
  );

  if (isDemo && transport === fetch) {
    const demoMeetingUrl = `https://teams.microsoft.com/l/meetup-join/orbit-demo-meeting-${interviewId}`;
    const demoEventId = `teams-evt-demo-${interviewId}`;
    db.prepare(`
      UPDATE interviews
      SET meeting_url = ?, calendar_event_id = ?, calendar_status = 'synced'
      WHERE id = ?
    `).run(demoMeetingUrl, demoEventId, interviewId);

    audit(db, user?.id || 'system', 'calendar.event_created', interviewId, {
      event_id: demoEventId,
      meeting_url: demoMeetingUrl,
      organizer: conf.organizerEmail,
      simulated: true
    });

    return {
      synced: true,
      calendar_status: 'synced',
      meeting_url: demoMeetingUrl,
      calendar_event_id: demoEventId,
      simulated: true
    };
  }

  const endsAt = calculateEndTime(scheduledAt, durationMinutes);
  const subject = title || `Interview: ${candidate.name} — ${req.title}`;
  const bodyHtml = `
    <p>Interview for position: <strong>${escapeHtml(req.title)}</strong></p>
    <p>Candidate: <strong>${escapeHtml(candidate.name)}</strong> (${escapeHtml(candidate.email)})</p>
    <p>Interviewer: <strong>${escapeHtml(interviewer.name)}</strong> (${escapeHtml(interviewer.email)})</p>
    <p>Duration: ${Number(durationMinutes) || 45} minutes</p>
    ${notes ? `<p><strong>Notes:</strong><br>${escapeHtml(notes)}</p>` : ''}
    <p>Scheduled via Orbit Talent Acquisition System.</p>
  `;

  try {
    const token = await getGraphAccessToken({
      tenant: conf.tenant,
      client: conf.client,
      secret: conf.secret,
      transport
    });

    const event = await createTeamsMeetingEvent({
      token,
      organizerEmail: conf.organizerEmail,
      subject,
      bodyHtml,
      startsAt: scheduledAt,
      endsAt,
      timeZone: timezone || 'UTC',
      attendees: [
        { email: candidate.email, name: candidate.name, type: 'required' },
        { email: interviewer.email, name: interviewer.name, type: 'required' }
      ],
      transport
    });

    db.prepare(`
      UPDATE interviews
      SET meeting_url = ?, calendar_event_id = ?, calendar_status = 'synced'
      WHERE id = ?
    `).run(event.joinUrl, event.id, interviewId);

    audit(db, user?.id || 'system', 'calendar.event_created', interviewId, {
      event_id: event.id,
      meeting_url: event.joinUrl,
      organizer: conf.organizerEmail
    });

    return {
      synced: true,
      calendar_status: 'synced',
      meeting_url: event.joinUrl,
      calendar_event_id: event.id
    };
  } catch (err) {
    db.prepare(`
      UPDATE interviews
      SET calendar_status = 'sync_failed'
      WHERE id = ?
    `).run(interviewId);

    audit(db, user?.id || 'system', 'calendar.sync_failed', interviewId, {
      operation: 'schedule',
      error: err.message
    });

    return {
      synced: false,
      calendar_status: 'sync_failed',
      meeting_url: null,
      calendar_event_id: null,
      error: err.message
    };
  }
}

/**
 * Updates an existing Microsoft Teams calendar event on reschedule.
 */
export async function syncRescheduleMeeting({
  db,
  user,
  interviewId,
  scheduledAt,
  durationMinutes = 45,
  timezone = 'UTC',
  title = '',
  notes = '',
  candidate,
  req,
  interviewer,
  transport = fetch,
  config = {}
}) {
  const conf = getCalendarConfig(config, db);
  if (!conf.enabled) {
    return {
      synced: false,
      calendar_status: 'not_synced'
    };
  }

  const current = db.prepare('SELECT calendar_event_id, meeting_url FROM interviews WHERE id = ?').get(interviewId);
  if (!current?.calendar_event_id) {
    // If not previously scheduled on Graph, attempt to schedule it now
    return syncScheduleMeeting({
      db,
      user,
      interviewId,
      scheduledAt,
      durationMinutes,
      timezone,
      title,
      notes,
      candidate,
      req,
      interviewer,
      transport,
      config
    });
  }

  const isDemo = Boolean(
    (conf.tenant && conf.tenant.includes('demo')) ||
    (conf.client && conf.client.includes('demo')) ||
    (process.env.SIMULATE_TEAMS_MEETING === 'true')
  );

  if (isDemo && transport === fetch) {
    const demoMeetingUrl = current.meeting_url || `https://teams.microsoft.com/l/meetup-join/orbit-demo-meeting-${interviewId}`;
    db.prepare(`
      UPDATE interviews
      SET calendar_status = 'synced', meeting_url = ?
      WHERE id = ?
    `).run(demoMeetingUrl, interviewId);

    audit(db, user?.id || 'system', 'calendar.event_updated', interviewId, {
      event_id: current.calendar_event_id,
      meeting_url: demoMeetingUrl,
      simulated: true
    });

    return {
      synced: true,
      calendar_status: 'synced',
      meeting_url: demoMeetingUrl,
      calendar_event_id: current.calendar_event_id,
      simulated: true
    };
  }

  const endsAt = calculateEndTime(scheduledAt, durationMinutes);
  const subject = title || `Interview (Updated): ${candidate.name} — ${req.title}`;
  const bodyHtml = `
    <p>Updated interview for position: <strong>${escapeHtml(req.title)}</strong></p>
    <p>Candidate: <strong>${escapeHtml(candidate.name)}</strong> (${escapeHtml(candidate.email)})</p>
    <p>Interviewer: <strong>${escapeHtml(interviewer.name)}</strong> (${escapeHtml(interviewer.email)})</p>
    <p>Duration: ${Number(durationMinutes) || 45} minutes</p>
    ${notes ? `<p><strong>Update Notes:</strong><br>${escapeHtml(notes)}</p>` : ''}
    <p>Updated via Orbit Talent Acquisition System.</p>
  `;

  try {
    const token = await getGraphAccessToken({
      tenant: conf.tenant,
      client: conf.client,
      secret: conf.secret,
      transport
    });

    const event = await updateTeamsMeetingEvent({
      token,
      organizerEmail: conf.organizerEmail,
      eventId: current.calendar_event_id,
      subject,
      bodyHtml,
      startsAt: scheduledAt,
      endsAt,
      timeZone: timezone || 'UTC',
      attendees: [
        { email: candidate.email, name: candidate.name, type: 'required' },
        { email: interviewer.email, name: interviewer.name, type: 'required' }
      ],
      transport
    });

    db.prepare(`
      UPDATE interviews
      SET calendar_status = 'synced'
      WHERE id = ?
    `).run(interviewId);

    audit(db, user?.id || 'system', 'calendar.event_updated', interviewId, {
      event_id: current.calendar_event_id,
      meeting_url: event.joinUrl || current.meeting_url
    });

    return {
      synced: true,
      calendar_status: 'synced',
      meeting_url: event.joinUrl || current.meeting_url,
      calendar_event_id: current.calendar_event_id
    };
  } catch (err) {
    db.prepare(`
      UPDATE interviews
      SET calendar_status = 'sync_failed'
      WHERE id = ?
    `).run(interviewId);

    audit(db, user?.id || 'system', 'calendar.sync_failed', interviewId, {
      operation: 'reschedule',
      error: err.message
    });

    return {
      synced: false,
      calendar_status: 'sync_failed',
      meeting_url: current.meeting_url,
      calendar_event_id: current.calendar_event_id,
      error: err.message
    };
  }
}

/**
 * Cancels a Microsoft Teams calendar event when an interview is cancelled.
 */
export async function syncCancelMeeting({
  db,
  user,
  interviewId,
  comment = 'Interview cancelled',
  transport = fetch,
  config = {}
}) {
  const conf = getCalendarConfig(config, db);
  const current = db.prepare('SELECT calendar_event_id FROM interviews WHERE id = ?').get(interviewId);

  if (!conf.enabled || !current?.calendar_event_id) {
    db.prepare(`
      UPDATE interviews
      SET calendar_status = 'cancelled'
      WHERE id = ?
    `).run(interviewId);
    return { cancelled: true, remoteCancelled: false };
  }

  const isDemo = Boolean(
    (conf.tenant && conf.tenant.includes('demo')) ||
    (conf.client && conf.client.includes('demo')) ||
    (process.env.SIMULATE_TEAMS_MEETING === 'true')
  );

  if (isDemo && transport === fetch) {
    db.prepare(`
      UPDATE interviews
      SET calendar_status = 'cancelled'
      WHERE id = ?
    `).run(interviewId);

    audit(db, user?.id || 'system', 'calendar.event_cancelled', interviewId, {
      event_id: current.calendar_event_id,
      comment,
      simulated: true
    });

    return { cancelled: true, remoteCancelled: true, simulated: true };
  }

  try {
    const token = await getGraphAccessToken({
      tenant: conf.tenant,
      client: conf.client,
      secret: conf.secret,
      transport
    });

    await cancelTeamsMeetingEvent({
      token,
      organizerEmail: conf.organizerEmail,
      eventId: current.calendar_event_id,
      comment,
      transport
    });

    db.prepare(`
      UPDATE interviews
      SET calendar_status = 'cancelled'
      WHERE id = ?
    `).run(interviewId);

    audit(db, user?.id || 'system', 'calendar.event_cancelled', interviewId, {
      event_id: current.calendar_event_id,
      comment
    });

    return { cancelled: true, remoteCancelled: true };
  } catch (err) {
    db.prepare(`
      UPDATE interviews
      SET calendar_status = 'sync_failed'
      WHERE id = ?
    `).run(interviewId);

    audit(db, user?.id || 'system', 'calendar.sync_failed', interviewId, {
      operation: 'cancel',
      error: err.message
    });

    return {
      cancelled: false,
      remoteCancelled: false,
      error: err.message
    };
  }
}
