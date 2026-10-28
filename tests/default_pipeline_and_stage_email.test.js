import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { service, PIPELINE_PRESETS, pipeline } from '../src/service.js';
import { fixture, user, reqBody, candidateBody, addSignedOffer } from './helpers.js';
import { CommunicationAdapter } from '../src/adapters.js';

const EXPECTED_STAGES = [
  'Applied',
  'Screening Round',
  'Interview Round 1',
  'Interview Round 2',
  'HR Round',
  'Offer',
  'Pre-Onboarding Training',
  'Onboarding',
  'Hired',
  'Rejected',
  'Revoked'
];

test('Default Pipeline: Schema and presets default to the 11 user-specified stages in order', () => {
  const db = openDb(':memory:');
  const adminUser = user(db, 'System Admin');
  try {
    // 1. Pipeline setting from fresh database schema initialization
    const current = pipeline(db);
    assert.deepEqual(current, EXPECTED_STAGES, 'Fresh database pipeline settings must default to the 11 stages');

    // 2. PIPELINE_PRESETS.smart_hybrid must match the 11 stages
    assert.deepEqual(PIPELINE_PRESETS.smart_hybrid, EXPECTED_STAGES, 'smart_hybrid preset must match 11 stages');

    // 3. Admin PUT pipeline with preset smart_hybrid
    const applied = service(db, adminUser, 'PUT', 'pipeline', { preset: 'smart_hybrid' });
    assert.deepEqual(applied, EXPECTED_STAGES);
  } finally {
    db.close();
  }
});

test('Resend Email Adapter: Tags and Idempotency-Key headers are strictly sanitized to ASCII alphanumeric, underscore, or dash', async () => {
  let capturedPayload = null;
  let capturedHeaders = null;

  const mockTransport = async (url, options) => {
    capturedPayload = JSON.parse(options.body);
    capturedHeaders = options.headers;
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: 'resend_msg_test_123' })
    };
  };

  const adapter = new CommunicationAdapter({
    apiKey: 're_test_dummy_key',
    from: 'hrms@mechlintech.com',
    transport: mockTransport
  });

  // Test sending with raw stage strings that include spaces and symbols
  const rawIdempotencyKey = 'stage_update_appl-uuid-123_Pre-Onboarding Training_HR Round';
  const result = await adapter.send({
    recipient: 'candidate@example.com',
    subject: 'Stage update notification',
    html: '<p>You have advanced</p>',
    idempotencyKey: rawIdempotencyKey
  });

  assert.equal(result.status, 'accepted');
  assert.equal(result.id, 'resend_msg_test_123');

  // Verify tags in the payload only contain ASCII letters, numbers, underscores, or dashes
  assert.ok(capturedPayload.tags);
  assert.equal(capturedPayload.tags.length, 1);
  assert.equal(capturedPayload.tags[0].name, 'idempotency_key');
  assert.match(capturedPayload.tags[0].value, /^[a-zA-Z0-9_-]+$/, 'Tag value must only contain ASCII letters, numbers, underscores, or dashes');
  assert.doesNotMatch(capturedPayload.tags[0].value, /\s/, 'Tag value must not contain spaces');

  // Verify header is sanitized
  assert.match(capturedHeaders['Idempotency-Key'], /^[a-zA-Z0-9_-]+$/);
  assert.doesNotMatch(capturedHeaders['Idempotency-Key'], /\s/);
});

test('Stage Transitions: Autosends candidate stage update email across all stages without failing', async () => {
  const f = fixture();
  try {
    service(f.db, f.admin, 'PUT', 'pipeline', { preset: 'smart_hybrid' });
    const sentEmails = [];
    const mockCommAdapter = {
      configured: true,
      send: async (payload) => {
        sentEmails.push(payload);
        return { id: 'msg_' + Math.random().toString(36).slice(2), status: 'accepted' };
      }
    };
    const config = { communicationAdapter: mockCommAdapter };

    // Setup requisition and candidate
    const req = await service(f.db, f.recruiter, 'POST', 'requisitions', reqBody);
    await service(f.db, f.recruiter, 'POST', `requisitions/${req.id}/submit`);
    await service(f.db, f.manager, 'POST', `requisitions/${req.id}/approve`, {});
    await service(f.db, f.finance, 'POST', `requisitions/${req.id}/approve`, {});
    const cand = await service(f.db, f.recruiter, 'POST', 'candidates', candidateBody);
    const app = await service(f.db, f.recruiter, 'POST', 'applications', { candidate_id: cand.id, requisition_id: req.id });

    // 1. Move Applied -> Screening Round: autosends email
    const m1 = await service(f.db, f.recruiter, 'POST', `applications/${app.id}/stage`, { stage: 'Screening Round' }, null, config);
    assert.equal(m1.stage, 'Screening Round');
    assert.equal(sentEmails.length, 1);
    assert.equal(sentEmails[0].recipient, cand.email);
    assert.equal(sentEmails[0].templateId, 'stage_update');
    assert.match(sentEmails[0].subject, /Screening Round/);

    // 2. Move Screening Round -> Interview Round 1: autosends email
    const m2 = await service(f.db, f.recruiter, 'POST', `applications/${app.id}/stage`, { stage: 'Interview Round 1' }, null, config);
    assert.equal(m2.stage, 'Interview Round 1');
    assert.equal(sentEmails.length, 2);
    assert.equal(sentEmails[1].templateId, 'stage_update');
    assert.match(sentEmails[1].subject, /Interview Round 1/);

    // 3. Move Interview Round 1 -> Interview Round 2: autosends email
    const m3 = await service(f.db, f.recruiter, 'POST', `applications/${app.id}/stage`, { stage: 'Interview Round 2' }, null, config);
    assert.equal(m3.stage, 'Interview Round 2');
    assert.equal(sentEmails.length, 3);
    assert.equal(sentEmails[2].templateId, 'stage_update');
    assert.match(sentEmails[2].subject, /Interview Round 2/);

    // 4. Move Interview Round 2 -> HR Round: autosends email
    const m4 = await service(f.db, f.recruiter, 'POST', `applications/${app.id}/stage`, { stage: 'HR Round' }, null, config);
    assert.equal(m4.stage, 'HR Round');
    assert.equal(sentEmails.length, 4);
    assert.equal(sentEmails[3].templateId, 'stage_update');
    assert.match(sentEmails[3].subject, /HR Round/);

    // 5. Move HR Round -> Offer: autosends email
    const m5 = await service(f.db, f.recruiter, 'POST', `applications/${app.id}/stage`, { stage: 'Offer' }, null, config);
    assert.equal(m5.stage, 'Offer');
    assert.equal(sentEmails.length, 5);
    assert.equal(sentEmails[4].templateId, 'stage_update');
    assert.match(sentEmails[4].subject, /Offer/);

    // 6. Move Offer -> Pre-Onboarding Training (requires signed offer): autosends email
    addSignedOffer(f.db, app.id, cand, req);
    const m6 = await service(f.db, f.recruiter, 'POST', `applications/${app.id}/stage`, { stage: 'Pre-Onboarding Training' }, null, config);
    assert.equal(m6.stage, 'Pre-Onboarding Training');
    assert.equal(sentEmails.length, 6);
    assert.equal(sentEmails[5].templateId, 'stage_update');
    assert.match(sentEmails[5].subject, /Pre-Onboarding Training/);

    // Verify candidate communications in database
    const comms = f.db.prepare('SELECT * FROM candidate_communications WHERE candidate_id = ?').all(cand.id);
    assert.equal(comms.length, 6);
    for (const c of comms) {
      assert.equal(c.status, 'accepted');
      assert.match(c.idempotency_key, /^[a-zA-Z0-9_-]+$/, 'Stored idempotency_key must be ASCII safe');
    }

    // Verify audit logs
    const auditLogs = f.db.prepare("SELECT * FROM audit WHERE event = 'application.stage_email_sent'").all();
    assert.equal(auditLogs.length, 6);
  } finally {
    f.db.close();
  }
});
