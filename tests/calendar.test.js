import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { createSession } from '../src/auth.js';
import { fixture, testConfig, user } from './helpers.js';
import { service } from '../src/service.js';
import { encryptSecret } from '../src/integrations/crypto.js';
import { ensureIntegrationTable } from '../src/integrations/storage.js';
import { CalendarAdapter, CommunicationAdapter, AdapterNotConfigured } from '../src/adapters.js';
import { getGraphAccessToken, resetGraphTokenCache, createTeamsMeetingEvent, updateTeamsMeetingEvent, cancelTeamsMeetingEvent } from '../src/calendar/graph.js';
import { isCalendarConfigured, getCalendarConfig, calculateEndTime, syncScheduleMeeting, syncRescheduleMeeting, syncCancelMeeting } from '../src/calendar/service.js';
import { renderTemplate } from '../src/communication/templates.js';

function createMockGraphTransport({
  tokenSuccess = true,
  createEventSuccess = true,
  updateEventSuccess = true,
  cancelEventSuccess = true,
  joinUrl = 'https://teams.microsoft.com/l/meetup-join/orbit-test-meeting-123',
  eventId = 'graph-evt-' + Math.random().toString(36).slice(2)
} = {}) {
  const calls = [];

  const transport = async (url, options = {}) => {
    calls.push({ url, options });

    // 1. OAuth2 token endpoint
    if (url.includes('/oauth2/v2.0/token')) {
      if (!tokenSuccess) {
        return {
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
          text: async () => 'Invalid client secret or tenant'
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          token_type: 'Bearer',
          expires_in: 3600,
          access_token: 'mock-graph-token-' + Date.now()
        })
      };
    }

    // 2. Events endpoint (create)
    if (url.includes('/events') && options.method === 'POST' && !url.endsWith('/cancel')) {
      if (!createEventSuccess) {
        return {
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          json: async () => ({ error: { message: 'Graph service temporarily unavailable' } })
        };
      }
      const body = JSON.parse(options.body || '{}');
      return {
        ok: true,
        status: 201,
        json: async () => ({
          id: eventId,
          subject: body.subject,
          start: body.start,
          end: body.end,
          onlineMeeting: {
            joinUrl
          },
          webLink: `https://outlook.office365.com/calendar/item/${eventId}`
        })
      };
    }

    // 3. Events endpoint (update / patch)
    if (url.includes('/events/') && options.method === 'PATCH') {
      if (!updateEventSuccess) {
        return {
          ok: false,
          status: 400,
          statusText: 'Bad Request',
          json: async () => ({ error: { message: 'Invalid start/end time range' } })
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: eventId,
          onlineMeeting: { joinUrl }
        })
      };
    }

    // 4. Events endpoint (cancel)
    if (url.endsWith('/cancel') && options.method === 'POST') {
      if (!cancelEventSuccess) {
        return {
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          json: async () => ({ error: { message: 'Failed to cancel remote event' } })
        };
      }
      return {
        ok: true,
        status: 202
      };
    }

    return {
      ok: false,
      status: 404,
      json: async () => ({ error: { message: 'Not found' } })
    };
  };

  transport.calls = calls;
  return transport;
}

test('CalendarAdapter: unconfigured instance throws AdapterNotConfigured', async () => {
  const adapter = new CalendarAdapter();
  assert.equal(adapter.configured, false);
  await assert.rejects(adapter.schedule({}), err => err.code === 'ADAPTER_NOT_CONFIGURED');
  await assert.rejects(adapter.reschedule({}), err => err.code === 'ADAPTER_NOT_CONFIGURED');
  await assert.rejects(adapter.cancel({}), err => err.code === 'ADAPTER_NOT_CONFIGURED');
});

test('CalendarAdapter: configured instance executes Graph schedule, reschedule, and cancel', async () => {
  resetGraphTokenCache();
  const mockTransport = createMockGraphTransport({
    joinUrl: 'https://teams.microsoft.com/l/meetup-join/test-call'
  });

  const adapter = new CalendarAdapter({
    tenant: '00000000-0000-0000-0000-000000000001',
    client: '00000000-0000-0000-0000-000000000002',
    secret: 'mock-secret',
    organizerEmail: 'organizer@mechlin.example',
    transport: mockTransport
  });

  assert.equal(adapter.configured, true);

  // 1. Schedule
  const scheduled = await adapter.schedule({
    subject: 'Interview with Jordan',
    startsAt: '2026-11-10T14:00:00Z',
    endsAt: '2026-11-10T14:45:00Z',
    timeZone: 'UTC',
    attendees: [
      { email: 'candidate@example.com', name: 'Jordan' },
      { email: 'interviewer@example.com', name: 'Interviewer' }
    ]
  });
  assert.ok(scheduled.id);
  assert.equal(scheduled.joinUrl, 'https://teams.microsoft.com/l/meetup-join/test-call');

  // 2. Reschedule
  const rescheduled = await adapter.reschedule({
    providerEventId: scheduled.id,
    subject: 'Interview with Jordan (Updated)',
    startsAt: '2026-11-12T15:00:00Z',
    endsAt: '2026-11-12T15:45:00Z'
  });
  assert.ok(rescheduled.id);

  // 3. Cancel
  const cancelled = await adapter.cancel({
    providerEventId: scheduled.id,
    comment: 'Candidate withdrew'
  });
  assert.equal(cancelled.cancelled, true);

  assert.ok(mockTransport.calls.length >= 4);
});

test('Microsoft Graph Client: token caching, expiry, and error handling', async () => {
  resetGraphTokenCache();
  let tokenCalls = 0;
  const transport = async (url) => {
    if (url.includes('/token')) {
      tokenCalls++;
      return {
        ok: true,
        json: async () => ({ access_token: 'cached-token-abc', expires_in: 3600 })
      };
    }
  };

  const token1 = await getGraphAccessToken({
    tenant: 'tenant-1',
    client: 'client-1',
    secret: 'sec-1',
    transport
  });
  assert.equal(token1, 'cached-token-abc');
  assert.equal(tokenCalls, 1);

  // Re-acquiring uses memory cache without new network call
  const token2 = await getGraphAccessToken({
    tenant: 'tenant-1',
    client: 'client-1',
    secret: 'sec-1',
    transport
  });
  assert.equal(token2, 'cached-token-abc');
  assert.equal(tokenCalls, 1);

  // Force refresh bypasses cache
  const token3 = await getGraphAccessToken({
    tenant: 'tenant-1',
    client: 'client-1',
    secret: 'sec-1',
    transport,
    forceRefresh: true
  });
  assert.equal(token3, 'cached-token-abc');
  assert.equal(tokenCalls, 2);

  // Missing credentials throws immediately
  await assert.rejects(getGraphAccessToken({ tenant: '', client: '', secret: '' }), /missing/i);
});

test('Calendar Service: calculateEndTime handles boundary durations properly', () => {
  const start = '2026-11-01T10:00:00.000Z';
  assert.equal(calculateEndTime(start, 45), '2026-11-01T10:45:00.000Z');
  assert.equal(calculateEndTime(start, 60), '2026-11-01T11:00:00.000Z');
  // Clamped between 15 and 480
  assert.equal(calculateEndTime(start, 5), '2026-11-01T10:15:00.000Z');
  assert.equal(calculateEndTime(start, 1000), '2026-11-01T18:00:00.000Z');
});

test('Calendar Service: handles external provider failures gracefully without corrupting database', async () => {
  resetGraphTokenCache();
  const f = fixture();
  const recruiter = user(f.db, 'Recruiter');
  const interviewer = user(f.db, 'Interviewer');
  const cand = f.db.prepare("INSERT INTO candidates(id, name, email, phone, skills, resume_text, source, team, created_by, created_at) VALUES('c1','Sam','sam@example.com','1234567890','[]','','Direct','Engineering',?,?) RETURNING *").get(recruiter.id, new Date().toISOString());
  const req = f.db.prepare("INSERT INTO requisitions(id, title, team, headcount, salary_min, salary_max, currency, description, skills, status, created_by, created_at) VALUES('r1','Engineer','Engineering',1,10,20,'USD','','[]','open',?,?) RETURNING *").get(recruiter.id, new Date().toISOString());
  const app = f.db.prepare("INSERT INTO applications(id, candidate_id, requisition_id, stage, created_at) VALUES('a1','c1','r1','Interview',?) RETURNING *").get(new Date().toISOString());
  const interviewId = 'int-fail-1';

  f.db.prepare(`
    INSERT INTO interviews(id, application_id, interviewer_id, scheduled_at, competencies, status, calendar_status, created_at)
    VALUES(?, 'a1', ?, '2026-11-15T14:00:00.000Z', '["Problem solving"]', 'planned', 'not_synced', ?)
  `).run(interviewId, interviewer.id, new Date().toISOString());

  // Mock transport where event creation fails (e.g. Graph 500 error)
  const failingTransport = createMockGraphTransport({ createEventSuccess: false });
  const conf = {
    entraTenantId: '00000000-0000-0000-0000-000000000001',
    entraClientId: '00000000-0000-0000-0000-000000000002',
    entraClientSecret: 'secret',
    teamsOrganizerEmail: 'organizer@example.com',
    enableTeamsCalendar: true
  };

  const result = await syncScheduleMeeting({
    db: f.db,
    user: recruiter,
    interviewId,
    scheduledAt: '2026-11-15T14:00:00.000Z',
    durationMinutes: 45,
    timezone: 'UTC',
    candidate: cand,
    req,
    interviewer,
    transport: failingTransport,
    config: conf
  });

  assert.equal(result.synced, false);
  assert.equal(result.calendar_status, 'sync_failed');
  assert.ok(result.error);

  // Local interview record remains intact and not corrupted
  const row = f.db.prepare('SELECT * FROM interviews WHERE id = ?').get(interviewId);
  assert.equal(row.id, interviewId);
  assert.equal(row.calendar_status, 'sync_failed');
  assert.equal(row.status, 'planned');

  // Audit record captures the sync failure safely
  const auditEntry = f.db.prepare("SELECT * FROM audit WHERE event = 'calendar.sync_failed'").get();
  assert.ok(auditEntry);
  assert.equal(auditEntry.target, interviewId);

  f.db.close();
});

test('HTTP API: complete interview scheduling, Teams meeting generation, reschedule, and cancel', async t => {
  resetGraphTokenCache();
  const f = fixture();
  const c = testConfig();

  // Configure Microsoft Teams Calendar and Resend Communication
  c.entraTenantId = '00000000-0000-0000-0000-000000000001';
  c.entraClientId = '00000000-0000-0000-0000-000000000002';
  c.entraClientSecret = 'secret';
  c.teamsOrganizerEmail = 'interviews@mechlin.example';
  c.enableTeamsCalendar = true;

  const mockGraphTransport = createMockGraphTransport({
    joinUrl: 'https://teams.microsoft.com/l/meetup-join/orbit-teams-test-url'
  });
  c.transport = mockGraphTransport;

  const deliveredEmails = [];
  c.communicationAdapter = new CommunicationAdapter({
    configured: true,
    apiKey: 're_test_key',
    from: 'Talent <talent@orbit.example>',
    transport: async (url, options) => {
      deliveredEmails.push(JSON.parse(options.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'email_msg_' + Date.now(), status: 'accepted' })
      };
    }
  });

  f.server = createApp({ db: f.db, c });
  f.server.listen(0, '127.0.0.1');
  await once(f.server, 'listening');
  const url = `http://127.0.0.1:${f.server.address().port}`;

  const recruiter = user(f.db, 'Recruiter', 'Dev');
  const interviewer = user(f.db, 'Interviewer', 'Dev');
  const session = createSession(f.db, recruiter, c);
  const headers = {
    Cookie: `session=${session.value}`,
    Origin: c.origin,
    'X-CSRF-Token': session.csrf,
    'Content-Type': 'application/json'
  };

  t.after(async () => {
    await new Promise(r => f.server.close(r));
    f.db.close();
  });

  // Seed candidate and requisition
  const candRes = await fetch(`${url}/api/candidates`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'Morgan Blake',
      email: 'morgan.blake@example.com',
      phone: '+1 555 019 2834',
      skills: ['TypeScript', 'React', 'Node.js'],
      team: 'Dev',
      source: 'Direct'
    })
  });
  assert.equal(candRes.status, 200);
  const cand = await candRes.json();

  const reqRes = await fetch(`${url}/api/requisitions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      title: 'Senior Frontend Engineer',
      team: 'Dev',
      headcount: 1,
      salary_min: 120000,
      salary_max: 150000,
      currency: 'USD',
      skills: ['TypeScript', 'React'],
      description: 'Role overview'
    })
  });
  assert.equal(reqRes.status, 200);
  const req = await reqRes.json();

  // Approve requisition to open headcount
  const manager = user(f.db, 'Hiring Manager', 'Dev');
  const finance = user(f.db, 'Finance Approver', 'Dev');
  const managerSession = createSession(f.db, manager, c);
  const financeSession = createSession(f.db, finance, c);
  const managerHeaders = {
    Cookie: `session=${managerSession.value}`,
    Origin: c.origin,
    'X-CSRF-Token': managerSession.csrf,
    'Content-Type': 'application/json'
  };
  const financeHeaders = {
    Cookie: `session=${financeSession.value}`,
    Origin: c.origin,
    'X-CSRF-Token': financeSession.csrf,
    'Content-Type': 'application/json'
  };

  await fetch(`${url}/api/requisitions/${req.id}/submit`, { method: 'POST', headers, body: '{}' });
  await fetch(`${url}/api/requisitions/${req.id}/approve`, { method: 'POST', headers: managerHeaders, body: '{}' });
  await fetch(`${url}/api/requisitions/${req.id}/approve`, { method: 'POST', headers: financeHeaders, body: '{}' });

  const appRes = await fetch(`${url}/api/applications`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ candidate_id: cand.id, requisition_id: req.id })
  });
  assert.equal(appRes.status, 200);
  const app = await appRes.json();
  await fetch(`${url}/api/applications/${app.id}/stage`, { method: 'POST', headers, body: JSON.stringify({ stage: 'Interview' }) });

  // 1. Schedule Interview with Teams Meeting and candidate invitation
  const futureDate = new Date(Date.now() + 5 * 86400000).toISOString();
  const scheduleRes = await fetch(`${url}/api/interviews`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      application_id: app.id,
      interviewer_id: interviewer.id,
      scheduled_at: futureDate,
      duration_minutes: 60,
      timezone: 'UTC',
      competencies: ['Problem solving', 'System design'],
      notes: 'Please review technical exercise beforehand.'
    })
  });

  assert.equal(scheduleRes.status, 200);
  const interview = await scheduleRes.json();

  assert.equal(interview.calendar_status, 'synced');
  assert.equal(interview.meeting_url, 'https://teams.microsoft.com/l/meetup-join/orbit-teams-test-url');
  assert.ok(interview.calendar_event_id);
  assert.equal(interview.duration_minutes, 60);

  // Verify email invitation was sent with Teams join link
  assert.ok(deliveredEmails.length >= 1);
  const inviteEmail = deliveredEmails.find(e => e.to.includes('morgan.blake@example.com') && /Interview invitation/.test(e.subject));
  assert.ok(inviteEmail);
  assert.match(inviteEmail.subject, /Interview invitation/);
  assert.match(inviteEmail.html, /Join Microsoft Teams Meeting/);
  assert.match(inviteEmail.html, /orbit-teams-test-url/);

  // 2. Reschedule Interview
  const rescheduledDate = new Date(Date.now() + 7 * 86400000).toISOString();
  const rescheduleRes = await fetch(`${url}/api/interviews/${interview.id}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      scheduled_at: rescheduledDate,
      duration_minutes: 45,
      notes: 'Moved forward by two days.'
    })
  });

  assert.equal(rescheduleRes.status, 200);
  const updatedInterview = await rescheduleRes.json();
  assert.equal(updatedInterview.calendar_status, 'synced');
  assert.equal(updatedInterview.scheduled_at, rescheduledDate);

  // Verify reschedule notification email was sent
  const updateEmail = deliveredEmails.find(e => e.subject.includes('Interview update'));
  assert.ok(updateEmail);
  assert.match(updateEmail.html, /Moved forward by two days/);
  assert.match(updateEmail.html, /orbit-teams-test-url/);

  // 3. Cancel Interview
  const cancelRes = await fetch(`${url}/api/interviews/${interview.id}/cancel`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      reason: 'Schedule conflict on engineering panel'
    })
  });

  assert.equal(cancelRes.status, 200);
  const cancelledInterview = await cancelRes.json();
  assert.equal(cancelledInterview.status, 'cancelled');
  assert.equal(cancelledInterview.calendar_status, 'cancelled');

  // Verify cancellation email was sent to candidate
  const cancelEmail = deliveredEmails.find(e => e.subject.includes('Interview cancelled'));
  assert.ok(cancelEmail);
  assert.match(cancelEmail.html, /Schedule conflict on engineering panel/);

  // Verify audit log entries
  const audits = f.db.prepare('SELECT event FROM audit WHERE target = ?').all(interview.id).map(a => a.event);
  assert.ok(audits.includes('interview.planned'));
  assert.ok(audits.includes('calendar.event_created'));
  assert.ok(audits.includes('interview.updated'));
  assert.ok(audits.includes('calendar.event_updated'));
  assert.ok(audits.includes('interview.cancelled'));
  assert.ok(audits.includes('calendar.event_cancelled'));

  // 4. Integrations endpoint reports Microsoft Teams active
  const intRes = await fetch(`${url}/api/integrations`, { headers });
  assert.equal(intRes.status, 200);
  const integrations = await intRes.json();
  const teamsIntegration = integrations.find(i => i.name === 'Microsoft calendar / Teams');
  assert.ok(teamsIntegration);
  assert.equal(teamsIntegration.status, 'Active (Microsoft Graph / Teams configured)');
  assert.equal(teamsIntegration.externalWrites, true);
});

test('HTTP API: validates interview inputs, past dates, closed applications, and unauthorized assignments', async t => {
  const f = fixture();
  const c = testConfig();
  f.server = createApp({ db: f.db, c });
  f.server.listen(0, '127.0.0.1');
  await once(f.server, 'listening');
  const url = `http://127.0.0.1:${f.server.address().port}`;

  const recruiter = user(f.db, 'Recruiter', 'Engineering');
  const interviewer = user(f.db, 'Interviewer', 'Engineering');
  const salesInterviewer = user(f.db, 'Interviewer', 'Sales');
  const session = createSession(f.db, recruiter, c);
  const headers = {
    Cookie: `session=${session.value}`,
    Origin: c.origin,
    'X-CSRF-Token': session.csrf,
    'Content-Type': 'application/json'
  };

  t.after(async () => {
    await new Promise(r => f.server.close(r));
    f.db.close();
  });

  const cand = f.db.prepare("INSERT INTO candidates(id, name, email, phone, skills, resume_text, source, team, created_by, created_at) VALUES('c2','Alex','alex@example.com','1234567890','[]','','Direct','Engineering',?,?) RETURNING *").get(recruiter.id, new Date().toISOString());
  const req = f.db.prepare("INSERT INTO requisitions(id, title, team, headcount, salary_min, salary_max, currency, description, skills, status, created_by, created_at) VALUES('r2','Engineer','Engineering',1,10,20,'USD','','[]','open',?,?) RETURNING *").get(recruiter.id, new Date().toISOString());
  const app = f.db.prepare("INSERT INTO applications(id, candidate_id, requisition_id, stage, created_at) VALUES('a2','c2','r2','Interview',?) RETURNING *").get(new Date().toISOString());

  // Past date rejected
  const pastRes = await fetch(`${url}/api/interviews`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      application_id: app.id,
      interviewer_id: interviewer.id,
      scheduled_at: '2020-01-01T10:00:00.000Z',
      competencies: ['Skill']
    })
  });
  assert.equal(pastRes.status, 400);

  // Cross-team interviewer rejected
  const teamMismatchRes = await fetch(`${url}/api/interviews`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      application_id: app.id,
      interviewer_id: salesInterviewer.id,
      scheduled_at: new Date(Date.now() + 86400000).toISOString(),
      competencies: ['Skill']
    })
  });
  assert.equal(teamMismatchRes.status, 400);

  // Missing competencies rejected
  const missingCompsRes = await fetch(`${url}/api/interviews`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      application_id: app.id,
      interviewer_id: interviewer.id,
      scheduled_at: new Date(Date.now() + 86400000).toISOString(),
      competencies: []
    })
  });
  assert.equal(missingCompsRes.status, 400);

  // Schedule valid interview
  const validRes = await fetch(`${url}/api/interviews`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      application_id: app.id,
      interviewer_id: interviewer.id,
      scheduled_at: new Date(Date.now() + 86400000).toISOString(),
      competencies: ['Skill']
    })
  });
  assert.equal(validRes.status, 200);
  const created = await validRes.json();

  // Cancel interview
  const cancelRes = await fetch(`${url}/api/interviews/${created.id}/cancel`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ reason: 'Cancelled' })
  });
  assert.equal(cancelRes.status, 200);

  // Cancelling an already cancelled interview returns 409
  const doubleCancelRes = await fetch(`${url}/api/interviews/${created.id}/cancel`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ reason: 'Already cancelled' })
  });
  assert.equal(doubleCancelRes.status, 409);

  // Editing a cancelled interview returns 409
  const editCancelledRes = await fetch(`${url}/api/interviews/${created.id}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      scheduled_at: new Date(Date.now() + 2 * 86400000).toISOString()
    })
  });
  assert.equal(editCancelledRes.status, 409);
});

test('Calendar Integration: Database-configured Microsoft Calendar syncs Teams meeting and attaches meeting_url to interview invitation email', async () => {
  resetGraphTokenCache();
  const f = fixture();
  const recruiter = user(f.db, 'Recruiter', 'Engineering');
  const interviewer = user(f.db, 'Interviewer', 'Engineering');

  // Ensure integration table and insert active Microsoft Calendar in DB
  ensureIntegrationTable(f.db);
  f.db.prepare(`
    INSERT INTO integration_configs(id, category, name, enabled, config_json, encrypted_secrets_json, status, created_at, updated_at)
    VALUES(?, ?, ?, 1, ?, ?, 'healthy', ?, ?)
  `).run(
    'microsoft_calendar',
    'Calendar & Scheduling',
    'Microsoft Calendar',
    JSON.stringify({
      tenantId: '11111111-2222-3333-4444-555555555555',
      clientId: '66666666-7777-8888-9999-000000000000',
      organizerEmail: 'interviews@mechlin.example'
    }),
    JSON.stringify({
      clientSecret: encryptSecret('real-client-secret-abc')
    }),
    new Date().toISOString(),
    new Date().toISOString()
  );

  const mockTeamsJoinUrl = 'https://teams.microsoft.com/l/meetup-join/orbit-db-interview-456';
  const mockGraphTransport = createMockGraphTransport({
    joinUrl: mockTeamsJoinUrl,
    eventId: 'evt-teams-db-1'
  });

  const c = testConfig();
  // Ensure no env vars for calendar are present on c
  delete c.entraTenantId;
  delete c.entraClientId;
  delete c.entraClientSecret;
  delete c.teamsOrganizerEmail;
  c.transport = mockGraphTransport;

  // Create requisition and candidate
  const cand = f.db.prepare("INSERT INTO candidates(id, name, email, phone, skills, resume_text, source, team, created_by, created_at) VALUES('c_db_1','Taylor Swift','taylor@example.com','1234567890','[]','','Direct','Engineering',?,?) RETURNING *").get(recruiter.id, new Date().toISOString());
  const req = f.db.prepare("INSERT INTO requisitions(id, title, team, headcount, salary_min, salary_max, currency, description, skills, status, created_by, created_at) VALUES('r_db_1','Senior Engineer','Engineering',1,10,20,'USD','','[]','open',?,?) RETURNING *").get(recruiter.id, new Date().toISOString());
  const app = f.db.prepare("INSERT INTO applications(id, candidate_id, requisition_id, stage, created_at) VALUES('a_db_1', ?, ?, 'Interview', ?) RETURNING *").get(cand.id, req.id, new Date().toISOString());

  // Check isCalendarConfigured(c, f.db)
  assert.equal(isCalendarConfigured(c, f.db), true);

  // Track email deliveries
  const sentEmails = [];
  c.communicationAdapter = {
    configured: true,
    send: async payload => {
      sentEmails.push(payload);
      return { id: 'msg-email-123' };
    }
  };

  const scheduleResult = await service(f.db, recruiter, 'POST', 'interviews', {
    application_id: app.id,
    interviewer_id: interviewer.id,
    scheduled_at: new Date(Date.now() + 86400000).toISOString(),
    competencies: ['Architecture', 'Communication'],
    notes: 'Please review architecture design beforehand.'
  }, new URLSearchParams(), c);

  assert.ok(scheduleResult);
  assert.equal(scheduleResult.calendar_status, 'synced');
  assert.equal(scheduleResult.meeting_url, mockTeamsJoinUrl);
  assert.equal(scheduleResult.calendar_event_id, 'evt-teams-db-1');

  // Verify email sent to candidate contains meeting_url and Teams link
  assert.equal(sentEmails.length, 1);
  assert.equal(sentEmails[0].recipient, 'taylor@example.com');
  assert.equal(sentEmails[0].variables.meeting_url, mockTeamsJoinUrl);
  assert.ok(sentEmails[0].html.includes(mockTeamsJoinUrl));
  assert.ok(sentEmails[0].html.includes('Join Microsoft Teams Meeting'));

  f.db.close();
});

test('Calendar Integration: Demo Microsoft Calendar credentials generate simulated Teams meeting URL seamlessly', async () => {
  resetGraphTokenCache();
  const f = fixture();
  const recruiter = user(f.db, 'Recruiter', 'Engineering');
  const interviewer = user(f.db, 'Interviewer', 'Engineering');

  // Ensure integration table and insert demo credentials
  ensureIntegrationTable(f.db);
  f.db.prepare(`
    INSERT INTO integration_configs(id, category, name, enabled, config_json, encrypted_secrets_json, status, created_at, updated_at)
    VALUES(?, ?, ?, 1, ?, ?, 'healthy', ?, ?)
  `).run(
    'microsoft_calendar',
    'Calendar & Scheduling',
    'Microsoft Calendar',
    JSON.stringify({
      tenantId: '00000000-0000-0000-0000-demo-entra-tenant',
      clientId: '11111111-1111-1111-1111-demo-client-id',
      organizerEmail: 'interviews@mechlin.example'
    }),
    JSON.stringify({
      clientSecret: encryptSecret('demo-secret-key-ms-teams-orbit')
    }),
    new Date().toISOString(),
    new Date().toISOString()
  );

  const c = testConfig();
  delete c.entraTenantId;
  delete c.entraClientId;
  delete c.entraClientSecret;
  delete c.teamsOrganizerEmail;

  const cand = f.db.prepare("INSERT INTO candidates(id, name, email, phone, skills, resume_text, source, team, created_by, created_at) VALUES('c_demo_1','Alex Rivers','alex@example.com','1234567890','[]','','Direct','Engineering',?,?) RETURNING *").get(recruiter.id, new Date().toISOString());
  const req = f.db.prepare("INSERT INTO requisitions(id, title, team, headcount, salary_min, salary_max, currency, description, skills, status, created_by, created_at) VALUES('r_demo_1','Cloud Architect','Engineering',1,10,20,'USD','','[]','open',?,?) RETURNING *").get(recruiter.id, new Date().toISOString());
  const app = f.db.prepare("INSERT INTO applications(id, candidate_id, requisition_id, stage, created_at) VALUES('a_demo_1', ?, ?, 'Interview', ?) RETURNING *").get(cand.id, req.id, new Date().toISOString());

  const sentEmails = [];
  c.communicationAdapter = {
    configured: true,
    send: async payload => {
      sentEmails.push(payload);
      return { id: 'msg-demo-123' };
    }
  };

  const scheduleResult = await service(f.db, recruiter, 'POST', 'interviews', {
    application_id: app.id,
    interviewer_id: interviewer.id,
    scheduled_at: new Date(Date.now() + 86400000).toISOString(),
    competencies: ['Problem solving']
  }, new URLSearchParams(), c);

  assert.ok(scheduleResult);
  assert.equal(scheduleResult.calendar_status, 'synced');
  assert.ok(scheduleResult.meeting_url.startsWith('https://teams.microsoft.com/l/meetup-join/orbit-demo-meeting-'));

  assert.equal(scheduleResult.timezone, 'Asia/Kolkata');
  assert.equal(sentEmails.length, 1);
  assert.equal(sentEmails[0].variables.meeting_url, scheduleResult.meeting_url);
  assert.ok(sentEmails[0].html.includes(scheduleResult.meeting_url));
  assert.ok(sentEmails[0].html.includes('Join Microsoft Teams Meeting'));
  assert.ok(sentEmails[0].html.includes('Timezone:</strong> IST'));
  assert.ok(sentEmails[0].html.includes('(IST)'));

  f.db.close();
});
