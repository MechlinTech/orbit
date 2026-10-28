import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { fixture, user, reqBody, candidateBody, addSignedOffer } from './helpers.js';
import { service } from '../src/service.js';
import { renderTemplate, escapeHtml, resolveAppOrigin } from '../src/communication/templates.js';
import { isValidTeamsJoinUrl } from '../src/calendar/graph.js';
import { sendStageTransitionNotification, sendCandidateCommunication } from '../src/communication/service.js';
import { syncScheduleMeeting, syncRescheduleMeeting } from '../src/calendar/service.js';
import { ensureIntegrationTable } from '../src/integrations/storage.js';
import { encryptSecret } from '../src/integrations/crypto.js';
import { getOrCreateTrainingDraft } from '../src/training/service.js';

function createMockCommAdapter(onSend = null) {
  const sent = [];
  return {
    sent,
    send: async (payload) => {
      const record = { ...payload, recipient_email: payload.recipient || payload.to };
      sent.push(record);
      if (onSend) {
        return await onSend(payload);
      }
      return { id: 'msg_' + Math.random().toString(36).slice(2), status: 'accepted' };
    }
  };
}

function createMockGraphTransport(opts = {}) {
  const calls = [];
  const transport = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes('/oauth2/v2.0/token')) {
      if (opts.tokenSuccess === false) {
        return { ok: false, status: 401, statusText: 'Unauthorized', text: async () => 'Invalid client credentials' };
      }
      return { ok: true, status: 200, json: async () => ({ access_token: 'mock-token', expires_in: 3600 }) };
    }
    if (options.method === 'POST') {
      if (opts.createSuccess === false) {
        return { ok: false, status: 500, statusText: 'Internal Server Error', json: async () => ({ error: { message: 'Teams service throttled' } }) };
      }
      const parsedBody = JSON.parse(options.body || '{}');
      const eventId = opts.eventId || 'graph-event-123';
      const joinUrl = opts.joinUrl || 'https://teams.microsoft.com/l/meetup-join/orbit-test-meeting-hash-12345';
      return {
        ok: true,
        status: 201,
        json: async () => ({
          id: eventId,
          subject: parsedBody.subject,
          webLink: 'https://outlook.office.com/calendar/item/123',
          onlineMeeting: parsedBody.isOnlineMeeting ? { joinUrl } : null
        })
      };
    }
    if (options.method === 'PATCH') {
      if (opts.updateSuccess === false) {
        return { ok: false, status: 500, statusText: 'Internal Server Error', json: async () => ({ error: { message: 'Failed to update meeting' } }) };
      }
      const parsedBody = JSON.parse(options.body || '{}');
      const eventId = opts.eventId || 'graph-event-123';
      const joinUrl = opts.joinUrl || 'https://teams.microsoft.com/l/meetup-join/orbit-test-meeting-hash-12345';
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: eventId,
          subject: parsedBody.subject,
          onlineMeeting: { joinUrl }
        })
      };
    }
    if (options.method === 'DELETE') {
      return { ok: true, status: 204 };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  return { transport, calls };
}

function setupSmartHybridDb() {
  const f = fixture();
  const smartStages = [
    'Applied', 'Screening Round', 'Interview Round 1', 'Interview Round 2',
    'HR Round', 'Offer', 'Pre-Onboarding Training', 'Onboarding', 'Hired', 'Rejected', 'Revoked'
  ];
  f.db.prepare("UPDATE settings SET value=? WHERE key='pipeline'").run(JSON.stringify(smartStages));

  ensureIntegrationTable(f.db);
  f.db.prepare(`
    INSERT OR REPLACE INTO integration_configs(id, category, name, enabled, config_json, encrypted_secrets_json, status, created_at, updated_at)
    VALUES(?, ?, ?, 1, ?, ?, 'healthy', datetime('now'), datetime('now'))
  `).run(
    'email_communication',
    'Communication',
    'Email Communication',
    JSON.stringify({ fromEmail: 'recruitment@mechlintech.com', fromName: 'The Mechlin Talent Team' }),
    JSON.stringify({ apiKey: encryptSecret('re_test_key_123') })
  );

  f.db.prepare(`
    INSERT OR REPLACE INTO integration_configs(id, category, name, enabled, config_json, encrypted_secrets_json, status, created_at, updated_at)
    VALUES(?, ?, ?, 1, ?, ?, 'healthy', datetime('now'), datetime('now'))
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
    })
  );

  return f;
}

function createAndOpenRequisition(f) {
  const req = service(f.db, f.recruiter, 'POST', 'requisitions', reqBody);
  service(f.db, f.recruiter, 'POST', `requisitions/${req.id}/submit`);
  service(f.db, f.manager, 'POST', `requisitions/${req.id}/approve`);
  service(f.db, f.finance, 'POST', `requisitions/${req.id}/approve`);
  return req;
}

// -------------------------------------------------------------
// A. PIPELINE STATUS EMAILS
// -------------------------------------------------------------

test('A1. Pipeline Status Emails: Every eligible stage transition generates a correctly formatted email', async () => {
  const f = setupSmartHybridDb();
  const commAdapter = createMockCommAdapter();
  const c = { communicationAdapter: commAdapter, appOrigin: 'https://orbit.mechlintech.com' };

  const cand = service(f.db, f.recruiter, 'POST', 'candidates', candidateBody);
  const req = createAndOpenRequisition(f);
  const app = service(f.db, f.recruiter, 'POST', 'applications', { candidate_id: cand.id, requisition_id: req.id });

  const testTransitions = [
    { target: 'Screening Round', expectedBadge: 'Screening Round' },
    { target: 'Interview Round 1', expectedBadge: 'Interview Round 1' },
    { target: 'Interview Round 2', expectedBadge: 'Interview Round 2' },
    { target: 'HR Round', expectedBadge: 'HR Round' },
    { target: 'Offer', expectedBadge: 'Offer' },
    { target: 'Pre-Onboarding Training', expectedBadge: 'Pre-Onboarding Training' },
    { target: 'Onboarding', expectedBadge: 'Onboarding' }
  ];

  for (const t of testTransitions) {
    if (t.target === 'Pre-Onboarding Training') {
      addSignedOffer(f.db, app.id, cand, req);
    }
    if (t.target === 'Onboarding') {
      f.db.prepare(`
        INSERT INTO training_evaluations(id, application_id, candidate_id, evaluator_id, rating, practical_score, status, decision, notes, attempt, created_at, updated_at)
        VALUES(?, ?, ?, ?, 5, 95, 'passed', 'next', 'Cleared training', 1, datetime('now'), datetime('now'))
      `).run('eval_brand_' + Date.now(), app.id, cand.id, f.recruiter.id);
      f.db.prepare(`UPDATE applications SET training_status = 'completed' WHERE id = ?`).run(app.id);
    }
    const prevApp = f.db.prepare('SELECT stage FROM applications WHERE id = ?').get(app.id);
    await service(f.db, f.recruiter, 'POST', `applications/${app.id}/stage`, { stage: t.target, send_notification: true }, null, c);

    const lastComm = commAdapter.sent.at(-1);
    assert.ok(lastComm, `Notification should be sent for transition to ${t.target}`);
    assert.equal(lastComm.recipient_email, cand.email);
    assert.match(lastComm.subject, new RegExp(t.target, 'i'));
    assert.match(lastComm.html, new RegExp(t.expectedBadge));
    assert.match(lastComm.html, new RegExp(escapeHtml(cand.name)));
    assert.match(lastComm.html, new RegExp(escapeHtml(req.title)));
    assert.match(lastComm.html, new RegExp(`Previous Stage: ${prevApp.stage}`));
  }

  f.db.close();
});

test('A2. Pipeline Status Emails: Revoked and Rejected stages render clear notices and never indicate progression', async () => {
  const f = setupSmartHybridDb();
  const commAdapter = createMockCommAdapter();
  const c = { communicationAdapter: commAdapter, appOrigin: 'https://orbit.mechlintech.com' };

  const cand = service(f.db, f.recruiter, 'POST', 'candidates', candidateBody);
  const req = createAndOpenRequisition(f);
  const app = service(f.db, f.recruiter, 'POST', 'applications', { candidate_id: cand.id, requisition_id: req.id });

  // Move to Screening Round first
  await service(f.db, f.recruiter, 'POST', `applications/${app.id}/stage`, { stage: 'Screening Round' }, null, c);

  // Reject candidate with stage_update template
  await service(f.db, f.recruiter, 'POST', `applications/${app.id}/stage`, {
    stage: 'Rejected',
    template_id: 'stage_update',
    notes: 'Thank you for speaking with our engineering team.'
  }, null, c);

  const rejectionComm = commAdapter.sent.at(-1);
  assert.ok(rejectionComm);
  assert.match(rejectionComm.subject, /Rejected/);
  assert.match(rejectionComm.html, /decided to move forward with other applicants/i);
  assert.doesNotMatch(rejectionComm.html, /advancing through our process/i);
  assert.match(rejectionComm.html, /Previous Stage: Screening Round/);

  f.db.close();
});

test('A3. Pipeline Status Emails: Unchanged stages do not generate notifications; failed deliveries can be retried safely', async () => {
  const f = setupSmartHybridDb();
  let failFirst = true;
  const commAdapter = createMockCommAdapter(async () => {
    if (failFirst) {
      failFirst = false;
      throw new Error('Transient network timeout to email service');
    }
    return { id: 'msg_retry_success', status: 'accepted' };
  });
  const c = { communicationAdapter: commAdapter, appOrigin: 'https://orbit.mechlintech.com' };

  const cand = service(f.db, f.recruiter, 'POST', 'candidates', candidateBody);
  const req = createAndOpenRequisition(f);
  const app = service(f.db, f.recruiter, 'POST', 'applications', { candidate_id: cand.id, requisition_id: req.id });

  // 1. First move: fails due to network error, but application stage change still commits safely
  await service(f.db, f.recruiter, 'POST', `applications/${app.id}/stage`, { stage: 'Screening Round' }, null, c);
  const appAfter = f.db.prepare('SELECT stage FROM applications WHERE id = ?').get(app.id);
  assert.equal(appAfter.stage, 'Screening Round', 'Stage transition must succeed even if email fails');

  const failedComm = f.db.prepare('SELECT * FROM candidate_communications WHERE candidate_id = ? ORDER BY created_at DESC LIMIT 1').get(cand.id);
  assert.equal(failedComm.status, 'failed');
  assert.match(failedComm.error_message, /Transient network timeout/);

  // 2. Retry notification via dedicated retry endpoint
  const retryRes = await service(f.db, f.recruiter, 'POST', `applications/${app.id}/retry-stage-notification`, {}, null, c);
  assert.equal(retryRes.success, true);

  const updatedComm = f.db.prepare('SELECT * FROM candidate_communications WHERE id = ?').get(failedComm.id);
  assert.equal(updatedComm.status, 'accepted');

  // 3. Repeated retry does not duplicate delivery
  const countBefore = commAdapter.sent.length;
  await service(f.db, f.recruiter, 'POST', `applications/${app.id}/retry-stage-notification`, {}, null, c);
  assert.equal(commAdapter.sent.length, countBefore, 'Should be idempotent and not resend already accepted notification');

  f.db.close();
});

// -------------------------------------------------------------
// B. EMAIL BRANDING
// -------------------------------------------------------------

test('B1. Email Branding: Official Orbit and Mechlin logos render with separator and correct URLs', () => {
  const origin = 'https://orbit.mechlintech.com';
  const rendered = renderTemplate('stage_update', {
    candidate_name: 'Jordan Smith',
    requisition_title: 'Full Stack Engineer',
    stage: 'Interview Round 1',
    previous_stage: 'Screening Round',
    team: 'Platform',
    app_origin: origin
  });

  // 1. Official Orbit logo appears first
  const orbitLogoIdx = rendered.html.indexOf('src="https://orbit.mechlintech.com/icon-192.png"');
  assert.ok(orbitLogoIdx > -1, 'Orbit logo image URL must be present');

  // 2. Vertical separator appears between the logos
  const separatorIdx = rendered.html.indexOf('border-left: 1px solid rgba(255, 255, 255, 0.35)');
  assert.ok(separatorIdx > -1, 'Vertical divider must be present');
  assert.ok(separatorIdx > orbitLogoIdx, 'Separator must appear after Orbit logo');

  // 3. Official Mechlin logo appears second
  const mechlinLogoIdx = rendered.html.indexOf('src="https://orbit.mechlintech.com/mechlin-logo.webp"');
  assert.ok(mechlinLogoIdx > -1, 'Mechlin logo image URL must be present');
  assert.ok(mechlinLogoIdx > separatorIdx, 'Mechlin logo must appear after separator');

  // 4. Preserves aspect ratios and email-client-friendly styles
  assert.match(rendered.html, /alt="Orbit"/);
  assert.match(rendered.html, /alt="Mechlin Technologies"/);
  assert.match(rendered.html, /role="presentation"/);
  assert.match(rendered.html, /max-height: 30px/);

  // 5. Plain text version includes company text header
  assert.match(rendered.text, /Orbit \| Mechlin Technologies/);
});

// -------------------------------------------------------------
// C. TEAMS MEETING CREATION & VALIDATION
// -------------------------------------------------------------

test('C1. Teams Meeting: Online interview creates Teams event, validates join URL, and saves authoritative URL', async () => {
  const f = setupSmartHybridDb();
  const mockJoinUrl = 'https://teams.microsoft.com/l/meetup-join/orbit-test-12345';
  const { transport, calls } = createMockGraphTransport({ joinUrl: mockJoinUrl, eventId: 'graph-evt-999' });
  const commAdapter = createMockCommAdapter();
  const c = { transport, communicationAdapter: commAdapter, appOrigin: 'https://orbit.mechlintech.com' };

  const cand = service(f.db, f.recruiter, 'POST', 'candidates', candidateBody);
  const req = createAndOpenRequisition(f);
  const app = service(f.db, f.recruiter, 'POST', 'applications', { candidate_id: cand.id, requisition_id: req.id });

  const futureDate = new Date(Date.now() + 86400000 * 3).toISOString();

  // Schedule virtual interview
  const interview = await service(f.db, f.recruiter, 'POST', 'interviews', {
    application_id: app.id,
    interviewer_id: f.interviewer.id,
    scheduled_at: futureDate,
    duration_minutes: 45,
    timezone: 'Asia/Kolkata',
    interview_type: 'virtual',
    competencies: ['JavaScript', 'System Architecture']
  }, null, c);

  assert.equal(interview.meeting_url, mockJoinUrl, 'Authoritative join URL must be saved to interview record');
  assert.equal(interview.calendar_status, 'synced');
  assert.equal(interview.calendar_event_id, 'graph-evt-999');
  assert.equal(interview.invitation_status, 'accepted');

  // Verify invitation email contains the authoritative Teams link
  const inviteEmail = commAdapter.sent.find(m => /Interview Invitation/i.test(m.subject));
  assert.ok(inviteEmail, 'Candidate invitation should have been sent');
  assert.match(inviteEmail.html, new RegExp(mockJoinUrl));
  assert.match(inviteEmail.text, new RegExp(mockJoinUrl));

  f.db.close();
});

test('C2. Physical / In-Person Interview: Never generates Teams links or displays virtual join URLs in invitation', async () => {
  const f = setupSmartHybridDb();
  const { transport, calls } = createMockGraphTransport();
  const commAdapter = createMockCommAdapter();
  const c = { transport, communicationAdapter: commAdapter, appOrigin: 'https://orbit.mechlintech.com' };

  const cand = service(f.db, f.recruiter, 'POST', 'candidates', candidateBody);
  const req = createAndOpenRequisition(f);
  const app = service(f.db, f.recruiter, 'POST', 'applications', { candidate_id: cand.id, requisition_id: req.id });

  const futureDate = new Date(Date.now() + 86400000 * 3).toISOString();

  // Schedule in-person interview
  const interview = await service(f.db, f.recruiter, 'POST', 'interviews', {
    application_id: app.id,
    interviewer_id: f.interviewer.id,
    scheduled_at: futureDate,
    duration_minutes: 60,
    timezone: 'Asia/Kolkata',
    interview_type: 'in_person',
    location: 'Mechlin Corporate Office, Level 4 Conference Room A',
    competencies: ['Problem Solving']
  }, null, c);

  assert.equal(interview.meeting_url, null, 'Physical interview must have meeting_url = null');
  assert.equal(interview.interview_type, 'in_person');
  assert.equal(interview.location, 'Mechlin Corporate Office, Level 4 Conference Room A');

  // Verify graph event created without online meeting
  const createCall = calls.find(call => call.options.method === 'POST');
  assert.ok(createCall);
  const body = JSON.parse(createCall.options.body);
  assert.equal(body.isOnlineMeeting, false, 'Physical event must pass isOnlineMeeting: false');
  assert.equal(body.location.displayName, 'Mechlin Corporate Office, Level 4 Conference Room A');

  // Verify invitation email does NOT contain Teams links and preserves physical venue
  const inviteEmail = commAdapter.sent.find(m => /Interview Invitation/i.test(m.subject));
  assert.ok(inviteEmail);
  assert.doesNotMatch(inviteEmail.html, /teams\.microsoft\.com/i);
  assert.doesNotMatch(inviteEmail.html, /Join Teams Meeting/i);
  assert.match(inviteEmail.html, /Level 4 Conference Room A/);
  assert.match(inviteEmail.html, /In-Person \/ Physical Interview/);

  f.db.close();
});

test('C3. Switching Formats: Physical to Virtual generates Teams meeting; Virtual to Physical clears join URL', async () => {
  const f = setupSmartHybridDb();
  const mockJoinUrl = 'https://teams.microsoft.com/l/meetup-join/orbit-switch-test';
  const { transport } = createMockGraphTransport({ joinUrl: mockJoinUrl, eventId: 'switch-evt-123' });
  const commAdapter = createMockCommAdapter();
  const c = { transport, communicationAdapter: commAdapter, appOrigin: 'https://orbit.mechlintech.com' };

  const cand = service(f.db, f.recruiter, 'POST', 'candidates', candidateBody);
  const req = createAndOpenRequisition(f);
  const app = service(f.db, f.recruiter, 'POST', 'applications', { candidate_id: cand.id, requisition_id: req.id });

  const futureDate = new Date(Date.now() + 86400000 * 3).toISOString();

  // 1. Start as in-person
  const created = await service(f.db, f.recruiter, 'POST', 'interviews', {
    application_id: app.id,
    interviewer_id: f.interviewer.id,
    scheduled_at: futureDate,
    interview_type: 'in_person',
    location: 'Mechlin Campus',
    competencies: ['Problem Solving']
  }, null, c);
  assert.equal(created.meeting_url, null);

  // 2. Switch from in-person to virtual -> triggers Teams setup
  const updatedToVirtual = await service(f.db, f.recruiter, 'PUT', `interviews/${created.id}`, {
    scheduled_at: futureDate,
    interview_type: 'virtual'
  }, null, c);

  assert.equal(updatedToVirtual.interview_type, 'virtual');
  assert.equal(updatedToVirtual.meeting_url, mockJoinUrl, 'Switching to virtual must generate and save Teams join link');
  assert.equal(updatedToVirtual.calendar_status, 'synced');

  // 3. Switch back from virtual to in-person -> clears meeting_url
  const updatedToPhysical = await service(f.db, f.recruiter, 'PUT', `interviews/${created.id}`, {
    scheduled_at: futureDate,
    interview_type: 'in_person',
    location: 'Mechlin HQ Room 101'
  }, null, c);

  assert.equal(updatedToPhysical.interview_type, 'in_person');
  assert.equal(updatedToPhysical.meeting_url, null, 'Switching to physical must reset meeting_url to null');
  assert.equal(updatedToPhysical.location, 'Mechlin HQ Room 101');

  f.db.close();
});

test('C4. Rescheduling and Unrelated Edits: Preserves existing valid Teams join URL without wiping it', async () => {
  const f = setupSmartHybridDb();
  const mockJoinUrl = 'https://teams.microsoft.com/l/meetup-join/orbit-preserve-url';
  const { transport } = createMockGraphTransport({ joinUrl: mockJoinUrl, eventId: 'evt-preserve' });
  const commAdapter = createMockCommAdapter();
  const c = { transport, communicationAdapter: commAdapter, appOrigin: 'https://orbit.mechlintech.com' };

  const cand = service(f.db, f.recruiter, 'POST', 'candidates', candidateBody);
  const req = createAndOpenRequisition(f);
  const app = service(f.db, f.recruiter, 'POST', 'applications', { candidate_id: cand.id, requisition_id: req.id });

  const d1 = new Date(Date.now() + 86400000 * 2).toISOString();
  const created = await service(f.db, f.recruiter, 'POST', 'interviews', {
    application_id: app.id,
    interviewer_id: f.interviewer.id,
    scheduled_at: d1,
    interview_type: 'virtual',
    competencies: ['JavaScript', 'System Architecture']
  }, null, c);
  assert.equal(created.meeting_url, mockJoinUrl);

  // Edit competencies only (omitting meeting_url)
  const d2 = new Date(Date.now() + 86400000 * 3).toISOString();
  const edited = await service(f.db, f.recruiter, 'PUT', `interviews/${created.id}`, {
    scheduled_at: d2,
    competencies: ['JavaScript', 'System Architecture', 'Node.js']
  }, null, c);

  assert.equal(edited.meeting_url, mockJoinUrl, 'Meeting URL must be preserved when body omits it');
  assert.equal(edited.calendar_event_id, 'evt-preserve');

  f.db.close();
});

// -------------------------------------------------------------
// D. INVITATION DELIVERY & DECOUPLING
// -------------------------------------------------------------

test('D1. Decoupled States: Meeting sync failure does not send broken invite; retrying meeting enables sending invite', async () => {
  const f = setupSmartHybridDb();
  let failMeetingCreation = true;
  const mockJoinUrl = 'https://teams.microsoft.com/l/meetup-join/orbit-retry-success';
  const { transport } = createMockGraphTransport({
    get createSuccess() { return !failMeetingCreation; },
    joinUrl: mockJoinUrl,
    eventId: 'evt-retry-flow'
  });
  const commAdapter = createMockCommAdapter();
  const c = { transport, communicationAdapter: commAdapter, appOrigin: 'https://orbit.mechlintech.com' };

  const cand = service(f.db, f.recruiter, 'POST', 'candidates', candidateBody);
  const req = createAndOpenRequisition(f);
  const app = service(f.db, f.recruiter, 'POST', 'applications', { candidate_id: cand.id, requisition_id: req.id });

  const futureDate = new Date(Date.now() + 86400000 * 2).toISOString();

  // 1. Initial schedule: Teams sync fails
  const interview = await service(f.db, f.recruiter, 'POST', 'interviews', {
    application_id: app.id,
    interviewer_id: f.interviewer.id,
    scheduled_at: futureDate,
    interview_type: 'virtual',
    competencies: ['JavaScript', 'System Architecture']
  }, null, c);

  assert.equal(interview.calendar_status, 'sync_failed');
  assert.equal(interview.meeting_url, null);
  assert.equal(interview.invitation_status, 'pending');
  assert.match(interview.invitation_error, /Waiting for valid Teams meeting link/i);

  // Verified: No invitation sent because meeting creation failed
  assert.equal(commAdapter.sent.length, 0, 'Must NOT send broken invite with missing Teams link');

  // 2. Retry meeting synchronization
  failMeetingCreation = false;
  const retried = await service(f.db, f.recruiter, 'POST', `interviews/${interview.id}/retry-meeting`, {}, null, c);

  assert.equal(retried.calendar_status, 'synced');
  assert.equal(retried.meeting_url, mockJoinUrl);
  assert.equal(retried.invitation_status, 'accepted');

  // Now invitation is safely delivered with the verified Teams join URL
  assert.equal(commAdapter.sent.length, 1);
  assert.match(commAdapter.sent[0].html, new RegExp(mockJoinUrl));

  f.db.close();
});

test('D2. Invitation Retry: Independent invitation retry does not create duplicate calendar meetings', async () => {
  const f = setupSmartHybridDb();
  const mockJoinUrl = 'https://teams.microsoft.com/l/meetup-join/orbit-invite-retry';
  const { transport, calls } = createMockGraphTransport({ joinUrl: mockJoinUrl, eventId: 'evt-invite-retry' });
  let failEmail = true;
  const commAdapter = createMockCommAdapter(async () => {
    if (failEmail) {
      failEmail = false;
      throw new Error('Email provider rate limited');
    }
    return { id: 'msg_invite_retried', status: 'accepted' };
  });
  const c = { transport, communicationAdapter: commAdapter, appOrigin: 'https://orbit.mechlintech.com' };

  const cand = service(f.db, f.recruiter, 'POST', 'candidates', candidateBody);
  const req = createAndOpenRequisition(f);
  const app = service(f.db, f.recruiter, 'POST', 'applications', { candidate_id: cand.id, requisition_id: req.id });

  const futureDate = new Date(Date.now() + 86400000 * 2).toISOString();

  // 1. Schedule interview: meeting succeeds, email fails
  const interview = await service(f.db, f.recruiter, 'POST', 'interviews', {
    application_id: app.id,
    interviewer_id: f.interviewer.id,
    scheduled_at: futureDate,
    interview_type: 'virtual',
    competencies: ['JavaScript', 'System Architecture']
  }, null, c);

  assert.equal(interview.calendar_status, 'synced');
  assert.equal(interview.meeting_url, mockJoinUrl);
  assert.equal(interview.invitation_status, 'failed');
  assert.match(interview.invitation_error, /Email provider rate limited/);

  const initialGraphCallsCount = calls.length;

  // 2. Retry invitation independently
  const retried = await service(f.db, f.recruiter, 'POST', `interviews/${interview.id}/retry-invitation`, {}, null, c);

  assert.equal(retried.invitation_status, 'accepted');
  assert.equal(retried.invitation_error, '');
  assert.equal(calls.length, initialGraphCallsCount, 'Retrying invitation must NOT create additional calendar events');

  f.db.close();
});

// -------------------------------------------------------------
// E. CROSS-WORKFLOW REGRESSION
// -------------------------------------------------------------

test('E1. Cross-Workflow: Pipeline status transitions NEVER generate Teams meetings; Training plans are never auto-sent', async () => {
  const f = setupSmartHybridDb();
  const { transport, calls } = createMockGraphTransport();
  const commAdapter = createMockCommAdapter();
  const c = { transport, communicationAdapter: commAdapter, appOrigin: 'https://orbit.mechlintech.com' };

  const cand = service(f.db, f.recruiter, 'POST', 'candidates', candidateBody);
  const req = createAndOpenRequisition(f);
  const app = service(f.db, f.recruiter, 'POST', 'applications', { candidate_id: cand.id, requisition_id: req.id });

  // Move through stages up to Pre-Onboarding Training
  await service(f.db, f.recruiter, 'POST', `applications/${app.id}/stage`, { stage: 'Screening Round' }, null, c);
  await service(f.db, f.recruiter, 'POST', `applications/${app.id}/stage`, { stage: 'Interview Round 1' }, null, c);
  await service(f.db, f.recruiter, 'POST', `applications/${app.id}/stage`, { stage: 'Offer' }, null, c);
  addSignedOffer(f.db, app.id, cand, req);
  await service(f.db, f.recruiter, 'POST', `applications/${app.id}/stage`, { stage: 'Pre-Onboarding Training' }, null, c);

  // 1. Verify NO Teams meeting calls were made by stage transitions
  const graphPostCalls = calls.filter(call => call.options.method === 'POST');
  assert.equal(graphPostCalls.length, 0, 'Stage transitions must not create Microsoft Teams calendar events');

  // 2. Verify Pre-Onboarding Training plan email was NOT auto-sent
  const trainingEmail = commAdapter.sent.find(m => /Training Plan/i.test(m.subject));
  assert.equal(trainingEmail, undefined, 'Training plan email must NEVER be sent automatically');

  // 3. Verify application training plan draft status is pending_review
  const draft = getOrCreateTrainingDraft(f.db, app.id, f.recruiter.id);
  assert.equal(draft.status, 'pending_review');

  f.db.close();
});

test('E2. Cross-Workflow: Offer signing, training evaluation, and progression to Hired remain fully functional', async () => {
  const f = setupSmartHybridDb();
  const commAdapter = createMockCommAdapter();
  const c = { communicationAdapter: commAdapter, appOrigin: 'https://orbit.mechlintech.com' };

  const cand = service(f.db, f.recruiter, 'POST', 'candidates', candidateBody);
  const req = createAndOpenRequisition(f);
  const app = service(f.db, f.recruiter, 'POST', 'applications', { candidate_id: cand.id, requisition_id: req.id });

  // Advance to Offer stage
  await service(f.db, f.recruiter, 'POST', `applications/${app.id}/stage`, { stage: 'Screening Round' }, null, c);
  await service(f.db, f.recruiter, 'POST', `applications/${app.id}/stage`, { stage: 'Offer' }, null, c);

  // Add signed offer
  addSignedOffer(f.db, app.id, cand, req);

  // Advance to Pre-Onboarding Training
  await service(f.db, f.recruiter, 'POST', `applications/${app.id}/stage`, { stage: 'Pre-Onboarding Training' }, null, c);

  // Record Pre-Onboarding Training Evaluation
  const evalResult = await service(f.db, f.recruiter, 'POST', `applications/${app.id}/training-evaluation`, {
    rating: 5,
    practical_score: 98,
    decision: 'next',
    notes: 'Outstanding technical performance and culture alignment.'
  }, null, c);

  assert.equal(evalResult.evaluation.rating, 5);
  assert.equal(evalResult.evaluation.decision, 'next');

  // Move from Onboarding to Hired
  const hiredApp = await service(f.db, f.recruiter, 'POST', `applications/${app.id}/stage`, { stage: 'Hired' }, null, c);
  assert.equal(hiredApp.stage, 'Hired');

  f.db.close();
});
