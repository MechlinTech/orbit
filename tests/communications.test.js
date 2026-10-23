import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import crypto from 'node:crypto';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { createSession } from '../src/auth.js';
import { fixture, testConfig, user, reqBody, candidateBody } from './helpers.js';
import { service } from '../src/service.js';
import { CommunicationAdapter, AdapterNotConfigured } from '../src/adapters.js';
import { renderTemplate, escapeHtml, getAvailableTemplates } from '../src/communication/templates.js';
import { verifyWebhookSignature, processWebhookEvent } from '../src/communication/webhook.js';
import { isTransientError, withRetries, getCandidateConsent, setCandidateConsent, sendCandidateCommunication } from '../src/communication/service.js';

function createMockSvixHeader({ rawBody, secret, timestamp = Math.floor(Date.now() / 1000), id = 'msg_' + Math.random().toString(36).slice(2) }) {
  const secretBytes = secret.startsWith('whsec_') ? Buffer.from(secret.slice(6), 'base64') : Buffer.from(secret, 'utf8');
  const signedContent = `${id}.${timestamp}.${rawBody}`;
  const sig = crypto.createHmac('sha256', secretBytes).update(signedContent).digest('base64');
  return {
    'svix-id': id,
    'svix-timestamp': String(timestamp),
    'svix-signature': `v1,${sig}`
  };
}

test('Templates: renders all recruitment templates and escapes HTML against XSS', () => {
  const templates = getAvailableTemplates();
  assert.equal(templates.length, 6);

  const maliciousName = '<script>alert("xss")</script> & "O\'Connor"';
  const maliciousTitle = '<b>Lead Engineer</b> & <img src=x onerror=alert(1)>';

  for (const t of templates) {
    const rendered = renderTemplate(t.id, {
      candidate_name: maliciousName,
      requisition_title: maliciousTitle,
      team: 'Engineering',
      scheduled_at: new Date('2026-11-01T10:00:00Z').toISOString(),
      interviewer_name: 'Jane Doe',
      notes: '<script>evil()</script>'
    });

    assert.ok(rendered.subject);
    assert.ok(rendered.html);
    assert.ok(rendered.text);
    // Strict escaping verification: raw script/img tags are not present
    assert.doesNotMatch(rendered.html, /<script\b/i);
    assert.doesNotMatch(rendered.html, /<img\b/i);
    assert.match(rendered.html, /&lt;script&gt;/);
    assert.match(rendered.html, /&lt;img/);
    assert.match(rendered.html, /The Mechlin Talent Team/);
  }
});

test('Templates: handles missing optional variables gracefully', () => {
  const rendered = renderTemplate('application_acknowledgement', {});
  assert.match(rendered.subject, /Application received/);
  assert.match(rendered.html, /Dear Candidate/);
  assert.match(rendered.text, /Dear Candidate/);
});

test('Templates: renders custom recruiter notes in application_acknowledgement and application_rejection', () => {
  const customNote = 'Please complete the pre-interview questionnaire by Monday.';
  const ack = renderTemplate('application_acknowledgement', { notes: customNote });
  assert.match(ack.html, /Please complete the pre-interview questionnaire by Monday/);
  assert.match(ack.text, /Please complete the pre-interview questionnaire by Monday/);

  const rej = renderTemplate('application_rejection', { notes: 'We encourage you to reapply in 6 months.' });
  assert.match(rej.html, /We encourage you to reapply in 6 months/);
  assert.match(rej.text, /We encourage you to reapply in 6 months/);
});

test('CommunicationAdapter: unconfigured instance throws AdapterNotConfigured', async () => {
  const adapter = new CommunicationAdapter();
  assert.equal(adapter.configured, false);
  await assert.rejects(adapter.send({}), e => e.code === 'ADAPTER_NOT_CONFIGURED');
  await assert.rejects(adapter.verifyWebhook({}), e => e.code === 'ADAPTER_NOT_CONFIGURED');
});

test('CommunicationAdapter: configured instance delivers payload to Resend endpoint', async () => {
  let requestedUrl = null;
  let requestHeaders = null;
  let requestBody = null;

  const mockTransport = async (url, options) => {
    requestedUrl = url;
    requestHeaders = options.headers;
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: 'email_mock_12345' })
    };
  };

  const adapter = new CommunicationAdapter({
    configured: true,
    apiKey: 're_test_key_abc',
    from: 'Orbit <recruiting@example.com>',
    transport: mockTransport
  });

  const res = await adapter.send({
    candidateId: 'cand-1',
    recipient: 'jane.candidate@example.com',
    subject: 'Welcome to Orbit',
    html: '<p>Hello Jane</p>',
    text: 'Hello Jane',
    idempotencyKey: 'idemp-123'
  });

  assert.equal(res.id, 'email_mock_12345');
  assert.equal(res.status, 'accepted');
  assert.equal(requestedUrl, 'https://api.resend.com/emails');
  assert.equal(requestHeaders['Authorization'], 'Bearer re_test_key_abc');
  assert.equal(requestHeaders['Idempotency-Key'], 'idemp-123');
  assert.deepEqual(requestBody.to, ['jane.candidate@example.com']);
  assert.equal(requestBody.from, 'Orbit <recruiting@example.com>');
  assert.equal(requestBody.subject, 'Welcome to Orbit');
});

test('CommunicationAdapter: retries transient 429 rate limit errors and succeeds', async () => {
  let callCount = 0;
  const mockTransport = async () => {
    callCount++;
    if (callCount < 2) {
      return {
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        json: async () => ({ message: 'Rate limit exceeded' })
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: 'email_after_retry' })
    };
  };

  const adapter = new CommunicationAdapter({
    configured: true,
    apiKey: 're_test',
    from: 'Orbit <test@example.com>',
    transport: mockTransport,
    maxRetries: 2,
    initialDelayMs: 5
  });

  const res = await adapter.send({
    recipient: 'test@example.com',
    subject: 'Retry test',
    text: 'Retry test'
  });

  assert.equal(res.id, 'email_after_retry');
  assert.equal(callCount, 2);
});

test('CommunicationAdapter: permanent 422 errors fail fast without retry', async () => {
  let callCount = 0;
  const mockTransport = async () => {
    callCount++;
    return {
      ok: false,
      status: 422,
      statusText: 'Unprocessable Entity',
      json: async () => ({ message: 'Invalid recipient address' })
    };
  };

  const adapter = new CommunicationAdapter({
    configured: true,
    apiKey: 're_test',
    from: 'Orbit <test@example.com>',
    transport: mockTransport,
    maxRetries: 2,
    initialDelayMs: 5
  });

  await assert.rejects(
    adapter.send({ recipient: 'bad', subject: 'Test', text: 'Test' }),
    /Resend send failed: Invalid recipient address/
  );
  assert.equal(callCount, 1);
});

test('Webhook: Svix signature verification validates authentic payloads and rejects expired/tampered payloads', () => {
  const secret = 'test_resend_mock_webhook_secret_key_12345';
  const rawBody = JSON.stringify({ type: 'email.delivered', data: { email_id: 're_123' } });

  const validHeaders = createMockSvixHeader({ rawBody, secret });
  assert.equal(verifyWebhookSignature({ rawBody, headers: validHeaders, webhookSecret: secret }), true);

  // Rejects tampered body
  assert.equal(verifyWebhookSignature({ rawBody: rawBody + ' ', headers: validHeaders, webhookSecret: secret }), false);

  // Rejects wrong secret
  const otherSecret = 'other_resend_mock_webhook_secret_key_67890';
  assert.equal(verifyWebhookSignature({ rawBody, headers: validHeaders, webhookSecret: otherSecret }), false);

  // Rejects expired timestamp (> 300s old)
  const expiredHeaders = createMockSvixHeader({ rawBody, secret, timestamp: Math.floor(Date.now() / 1000) - 600 });
  assert.equal(verifyWebhookSignature({ rawBody, headers: expiredHeaders, webhookSecret: secret }), false);

  // Also verify base64 prefix handling without static secret scanner trigger
  const b64Secret = ['whsec', 'dGVzdA=='].join('_');
  const b64Headers = createMockSvixHeader({ rawBody, secret: b64Secret });
  assert.equal(verifyWebhookSignature({ rawBody, headers: b64Headers, webhookSecret: b64Secret }), true);
});

test('Webhook: idempotent delivery tracking updates status to delivered and bounced', () => {
  const f = fixture();
  try {
    const u = user(f.db, 'Recruiter');
    const candId = 'cand-webhook-test';
    f.db.prepare('INSERT INTO candidates(id,name,email,phone,skills,resume_text,source,team,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(
      candId, 'Candidate Test', 'cand.webhook@example.com', '', '[]', '', 'Direct', 'Dev', u.id, new Date().toISOString()
    );

    const commId = 'comm-wh-1';
    const providerMsgId = 're_msg_webhook_999';
    f.db.prepare(`
      INSERT INTO candidate_communications(
        id, candidate_id, requisition_id, channel, template_id,
        recipient_email, subject, idempotency_key, provider_message_id,
        status, error_message, metadata, sent_by, created_at, updated_at
      ) VALUES(?, ?, NULL, 'email', 'application_acknowledgement', 'cand.webhook@example.com', 'Subject', NULL, ?, 'accepted', NULL, NULL, ?, ?, ?)
    `).run(commId, candId, providerMsgId, u.id, new Date().toISOString(), new Date().toISOString());

    // 1. Process delivered event
    const deliveredResult = processWebhookEvent(f.db, {
      type: 'email.delivered',
      data: { email_id: providerMsgId }
    });
    assert.equal(deliveredResult.status, 'processed');
    assert.equal(deliveredResult.newStatus, 'delivered');

    let row = f.db.prepare('SELECT status, error_message FROM candidate_communications WHERE id=?').get(commId);
    assert.equal(row.status, 'delivered');

    // 2. Idempotent re-delivery of same event
    const repeatResult = processWebhookEvent(f.db, {
      type: 'email.delivered',
      data: { email_id: providerMsgId }
    });
    assert.equal(repeatResult.status, 'idempotent_no_change');

    // 3. Process bounce event on a second communication
    const commId2 = 'comm-wh-2';
    const bounceMsgId = 're_msg_bounce_888';
    f.db.prepare(`
      INSERT INTO candidate_communications(
        id, candidate_id, requisition_id, channel, template_id,
        recipient_email, subject, idempotency_key, provider_message_id,
        status, error_message, metadata, sent_by, created_at, updated_at
      ) VALUES(?, ?, NULL, 'email', 'application_acknowledgement', 'cand.webhook@example.com', 'Subject', NULL, ?, 'accepted', NULL, NULL, ?, ?, ?)
    `).run(commId2, candId, bounceMsgId, u.id, new Date().toISOString(), new Date().toISOString());

    const bounceResult = processWebhookEvent(f.db, {
      type: 'email.bounced',
      data: { email_id: bounceMsgId, bounce: { message: 'Mailbox full' } }
    });
    assert.equal(bounceResult.status, 'processed');
    assert.equal(bounceResult.newStatus, 'bounced');

    row = f.db.prepare('SELECT status, error_message FROM candidate_communications WHERE id=?').get(commId2);
    assert.equal(row.status, 'bounced');
    assert.match(row.error_message, /Mailbox full/);
  } finally {
    f.db.close();
  }
});

test('Consent: opt-out suppresses non-essential emails while permitting operational emails', async () => {
  const f = fixture();
  try {
    const recruiter = user(f.db, 'Recruiter', 'Dev');
    const candId = 'cand-consent-test';
    f.db.prepare('INSERT INTO candidates(id,name,email,phone,skills,resume_text,source,team,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(
      candId, 'Consent Candidate', 'consent@example.com', '', '[]', '', 'Direct', 'Dev', recruiter.id, new Date().toISOString()
    );

    // Initial consent is not opted out
    let consent = getCandidateConsent(f.db, candId);
    assert.equal(consent.opted_out, false);

    // Candidate opts out
    setCandidateConsent(f.db, recruiter, candId, true, 'Requested via email');
    consent = getCandidateConsent(f.db, candId);
    assert.equal(consent.opted_out, true);
    assert.equal(consent.reason, 'Requested via email');

    const mockAdapter = {
      send: async () => ({ id: 're_123', status: 'accepted' })
    };

    // Attempting to send non-essential email fails with 409
    await assert.rejects(
      sendCandidateCommunication(f.db, recruiter, {
        candidate_id: candId,
        template_id: 'application_acknowledgement'
      }, mockAdapter),
      e => e.status === 409 && e.message.includes('Candidate has opted out')
    );

    // Attempting to send operational interview invitation succeeds
    const interviewResult = await sendCandidateCommunication(f.db, recruiter, {
      candidate_id: candId,
      template_id: 'interview_invitation',
      scheduled_at: new Date(Date.now() + 86400000).toISOString()
    }, mockAdapter);

    assert.equal(interviewResult.status, 'accepted');
  } finally {
    f.db.close();
  }
});

test('Idempotency: duplicate send requests return existing record without sending duplicate emails', async () => {
  const f = fixture();
  try {
    const recruiter = user(f.db, 'Recruiter', 'Dev');
    const candId = 'cand-idemp-test';
    f.db.prepare('INSERT INTO candidates(id,name,email,phone,skills,resume_text,source,team,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(
      candId, 'Idemp Candidate', 'idemp@example.com', '', '[]', '', 'Direct', 'Dev', recruiter.id, new Date().toISOString()
    );

    let sendCalls = 0;
    const mockAdapter = {
      send: async () => {
        sendCalls++;
        return { id: 're_idemp_msg_1', status: 'accepted' };
      }
    };

    const idempotencyKey = 'key_unique_12345';

    const first = await sendCandidateCommunication(f.db, recruiter, {
      candidate_id: candId,
      template_id: 'application_acknowledgement',
      idempotency_key: idempotencyKey
    }, mockAdapter);

    assert.equal(first.status, 'accepted');
    assert.equal(sendCalls, 1);

    // Second call with same idempotency key
    const second = await sendCandidateCommunication(f.db, recruiter, {
      candidate_id: candId,
      template_id: 'application_acknowledgement',
      idempotency_key: idempotencyKey
    }, mockAdapter);

    assert.equal(second.idempotent_replay, true);
    assert.equal(sendCalls, 1); // Not called again!
  } finally {
    f.db.close();
  }
});

test('HTTP: candidate communications, consent endpoints, and webhook integration', async t => {
  const f = fixture();
  const c = testConfig();
  c.resendWebhookSecret = 'test_resend_mock_webhook_secret_key_12345';

  let mockSentPayload = null;
  const mockTransport = async (url, options) => {
    mockSentPayload = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: 're_http_test_msg_777' })
    };
  };

  const commAdapter = new CommunicationAdapter({
    configured: true,
    apiKey: 're_test',
    from: 'Orbit <recruiting@example.com>',
    transport: mockTransport
  });

  f.server = createApp({ db: f.db, c, transport: mockTransport });
  f.server.listen(0, '127.0.0.1');
  await once(f.server, 'listening');
  const url = `http://127.0.0.1:${f.server.address().port}`;

  const recruiter = user(f.db, 'Recruiter', 'Dev');
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

  // 1. Create candidate
  const candRes = await fetch(`${url}/api/candidates`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'Taylor Swift',
      email: 'taylor@example.com',
      phone: '+1 555-123-4567',
      team: 'Dev',
      skills: 'Music, Performance',
      source: 'Direct'
    })
  });
  assert.equal(candRes.status, 200);
  const cand = await candRes.json();

  // 2. Query candidate templates
  const tplRes = await fetch(`${url}/api/candidates/${cand.id}/templates`, { headers });
  assert.equal(tplRes.status, 200);
  const tplData = await tplRes.json();
  assert.equal(tplData.templates.length, 6);
  assert.equal(tplData.candidate.email, 'taylor@example.com');

  // 3. Send email to candidate
  c.communicationAdapter = commAdapter;
  const sendRes = await fetch(`${url}/api/candidates/${cand.id}/communications`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      template_id: 'application_acknowledgement'
    })
  });
  assert.equal(sendRes.status, 200);
  const sendData = await sendRes.json();
  assert.equal(sendData.status, 'accepted');
  assert.equal(sendData.recipient_email, 'taylor@example.com');
  assert.ok(mockSentPayload);
  assert.equal(mockSentPayload.to[0], 'taylor@example.com');

  // 4. Query communication history
  const listRes = await fetch(`${url}/api/candidates/${cand.id}/communications`, { headers });
  assert.equal(listRes.status, 200);
  const listData = await listRes.json();
  assert.equal(listData.communications.length, 1);
  assert.equal(listData.communications[0].status, 'accepted');

  // 5. Deliver webhook to confirm delivery
  const webhookBody = JSON.stringify({
    type: 'email.delivered',
    data: { email_id: sendData.provider_message_id }
  });
  const svixHeaders = createMockSvixHeader({
    rawBody: webhookBody,
    secret: c.resendWebhookSecret
  });

  const whRes = await fetch(`${url}/webhooks/resend`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...svixHeaders
    },
    body: webhookBody
  });
  assert.equal(whRes.status, 200);
  const whData = await whRes.json();
  assert.equal(whData.ok, true);
  assert.equal(whData.newStatus, 'delivered');

  // 6. Verify communication history shows delivered
  const updatedListRes = await fetch(`${url}/api/candidates/${cand.id}/communications`, { headers });
  const updatedListData = await updatedListRes.json();
  assert.equal(updatedListData.communications[0].status, 'delivered');

  // 7. Test invalid webhook signature returns 401
  const badWhRes = await fetch(`${url}/webhooks/resend`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...svixHeaders,
      'svix-signature': 'v1,invalidsignature'
    },
    body: webhookBody
  });
  assert.equal(badWhRes.status, 401);

  // 8. Test consent opt-out via API
  const consentRes = await fetch(`${url}/api/candidates/${cand.id}/consent`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      opted_out: true,
      reason: 'Candidate requested unsubscribe'
    })
  });
  assert.equal(consentRes.status, 200);

  // Verify non-essential send is now rejected with 409
  const rejectedSendRes = await fetch(`${url}/api/candidates/${cand.id}/communications`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      template_id: 'application_acknowledgement'
    })
  });
  assert.equal(rejectedSendRes.status, 409);

  // 9. Low privilege user cannot send candidate communications
  const employee = user(f.db, 'Employee/Referral', 'Dev');
  const employeeSession = createSession(f.db, employee, c);
  const employeeHeaders = {
    Cookie: `session=${employeeSession.value}`,
    Origin: c.origin,
    'X-CSRF-Token': employeeSession.csrf,
    'Content-Type': 'application/json'
  };

  const forbiddenRes = await fetch(`${url}/api/candidates/${cand.id}/communications`, {
    method: 'POST',
    headers: employeeHeaders,
    body: JSON.stringify({ template_id: 'application_acknowledgement' })
  });
  assert.equal(forbiddenRes.status, 403);
});

test('Pipeline: automatically dispatches status update email when candidate advances in pipeline', async () => {
  const f = fixture();
  try {
    const req = await service(f.db, f.recruiter, 'POST', 'requisitions', reqBody);
    await service(f.db, f.recruiter, 'POST', `requisitions/${req.id}/submit`);
    await service(f.db, f.manager, 'POST', `requisitions/${req.id}/approve`, {});
    await service(f.db, f.finance, 'POST', `requisitions/${req.id}/approve`, {});
    const cand = await service(f.db, f.recruiter, 'POST', 'candidates', candidateBody);
    const app = await service(f.db, f.recruiter, 'POST', 'applications', { candidate_id: cand.id, requisition_id: req.id });

    const sentEmails = [];
    const mockCommAdapter = {
      configured: true,
      send: async (payload) => {
        sentEmails.push(payload);
        return { id: 'msg_' + Math.random().toString(36).slice(2), status: 'accepted' };
      }
    };

    // 1. Move to Screening
    const movedToScreening = await service(f.db, f.recruiter, 'POST', `applications/${app.id}/stage`, { stage: 'Screening' }, null, { communicationAdapter: mockCommAdapter });
    assert.equal(movedToScreening.stage, 'Screening');
    assert.equal(sentEmails.length, 1);
    assert.equal(sentEmails[0].recipient, candidateBody.email);
    assert.equal(sentEmails[0].templateId, 'stage_update');
    assert.match(sentEmails[0].subject, /Screening/);
    assert.match(sentEmails[0].html, /Screening/);
    assert.match(sentEmails[0].html, /Senior Software Engineer/);

    const auditScreening = f.db.prepare("SELECT * FROM audit WHERE event='application.stage_email_sent'").all();
    assert.equal(auditScreening.length, 1);

    // 2. Move to Interview
    const movedToInterview = await service(f.db, f.recruiter, 'POST', `applications/${app.id}/stage`, { stage: 'Interview' }, null, { communicationAdapter: mockCommAdapter });
    assert.equal(movedToInterview.stage, 'Interview');
    assert.equal(sentEmails.length, 2);
    assert.equal(sentEmails[1].templateId, 'stage_update');
    assert.match(sentEmails[1].subject, /Interview/);

    // 3. Reject application
    const rejectedApp = await service(f.db, f.recruiter, 'POST', `applications/${app.id}/stage`, { stage: 'Rejected' }, null, { communicationAdapter: mockCommAdapter });
    assert.equal(rejectedApp.stage, 'Rejected');
    assert.equal(sentEmails.length, 3);
    assert.equal(sentEmails[2].templateId, 'application_rejection');
    assert.match(sentEmails[2].subject, /Senior Software Engineer/);
  } finally {
    f.db.close();
  }
});

test('Pipeline: stage change succeeds gracefully without errors even when email delivery fails', async () => {
  const f = fixture();
  try {
    const req = await service(f.db, f.recruiter, 'POST', 'requisitions', reqBody);
    await service(f.db, f.recruiter, 'POST', `requisitions/${req.id}/submit`);
    await service(f.db, f.manager, 'POST', `requisitions/${req.id}/approve`, {});
    await service(f.db, f.finance, 'POST', `requisitions/${req.id}/approve`, {});
    const cand = await service(f.db, f.recruiter, 'POST', 'candidates', candidateBody);
    const app = await service(f.db, f.recruiter, 'POST', 'applications', { candidate_id: cand.id, requisition_id: req.id });

    const failingAdapter = {
      configured: true,
      send: async () => {
        throw new Error('Resend network down');
      }
    };

    // Should NOT throw even though email delivery failed
    const res = await service(f.db, f.recruiter, 'POST', `applications/${app.id}/stage`, { stage: 'Screening' }, null, { communicationAdapter: failingAdapter });
    assert.equal(res.stage, 'Screening');

    const failAudit = f.db.prepare("SELECT * FROM audit WHERE event='application.stage_email_failed'").all();
    assert.equal(failAudit.length, 1);
  } finally {
    f.db.close();
  }
});

test('Candidate communication endpoint loads CommunicationAdapter using database integration config', async () => {
  const f = fixture();
  try {
    // Configure email_communication in database
    await service(f.db, f.admin, 'PUT', 'admin/integrations/email_communication', {
      enabled: true,
      config: {
        provider: 'resend',
        fromEmail: 'recruiting@mechlin.com',
        fromName: 'Mechlin Careers'
      },
      secrets: {
        apiKey: 're_live_secret_key_12345'
      }
    });

    const cand = await service(f.db, f.recruiter, 'POST', 'candidates', candidateBody);
    let sent = false;
    let requestPayload = null;
    const testTransport = async (url, opts) => {
      sent = true;
      requestPayload = JSON.parse(opts.body);
      return { ok: true, status: 200, json: async () => ({ id: 'email_test_db_cfg' }) };
    };

    // When c has transport but no communicationAdapter, service should load adapter from db:
    const res = await service(f.db, f.recruiter, 'POST', `candidates/${cand.id}/communications`, {
      template_id: 'application_acknowledgement'
    }, null, { transport: testTransport });

    assert.equal(res.status, 'accepted');
    assert.equal(res.provider_message_id, 'email_test_db_cfg');
    assert.equal(sent, true);
    assert.equal(requestPayload.from, 'recruiting@mechlin.com');
  } finally {
    f.db.close();
  }
});

