import test from 'node:test';
import assert from 'node:assert/strict';
import { service } from '../src/service.js';
import { fixture, user, reqBody, candidateBody, addSignedOffer } from './helpers.js';

const call = (f, u, m, p, b) => service(f.db, u, m, p, b);

function hybridFixture() {
  const f = fixture();
  f.req = call(f, f.recruiter, 'POST', 'requisitions', reqBody);
  call(f, f.recruiter, 'POST', `requisitions/${f.req.id}/submit`);
  call(f, f.manager, 'POST', `requisitions/${f.req.id}/approve`, {});
  call(f, f.finance, 'POST', `requisitions/${f.req.id}/approve`, {});
  f.candidate = call(f, f.recruiter, 'POST', 'candidates', candidateBody);
  f.app = call(f, f.recruiter, 'POST', 'applications', { candidate_id: f.candidate.id, requisition_id: f.req.id });
  return f;
}

test('Smart Hybrid Pipeline: Presets API returns configured workflows', () => {
  const f = hybridFixture();
  const presets = call(f, f.recruiter, 'GET', 'pipeline/presets');
  assert.ok(presets.smart_hybrid);
  assert.ok(presets.smart_hybrid_3rounds);
  assert.ok(presets.standard);
  assert.deepEqual(presets.smart_hybrid, [
    'Applied', 'Screening Round', 'Interview Round 1', 'Interview Round 2',
    'HR Round', 'Pre-Onboarding Training', 'Onboarding', 'Hired', 'Rejected', 'Revoked'
  ]);
  f.db.close();
});

test('Smart Hybrid Pipeline: Admin can switch pipeline to Smart Hybrid workflow', () => {
  const f = hybridFixture();
  const updated = call(f, f.admin, 'PUT', 'pipeline', { preset: 'smart_hybrid' });
  assert.equal(updated.length, 10);
  assert.equal(updated[0], 'Applied');
  assert.equal(updated[1], 'Screening Round');
  assert.equal(updated[4], 'HR Round');
  assert.equal(updated[5], 'Pre-Onboarding Training');
  assert.equal(updated[6], 'Onboarding');
  assert.equal(updated[7], 'Hired');
  assert.equal(updated[9], 'Revoked');
  f.db.close();
});

test('Smart Hybrid Pipeline: Full 2-round sequence from Applied to Hired', () => {
  const f = hybridFixture();
  call(f, f.admin, 'PUT', 'pipeline', { preset: 'smart_hybrid' });

  // 1. Applied -> Screening Round
  const s1 = call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Screening Round' });
  assert.equal(s1.stage, 'Screening Round');

  // 2. Screening Round -> Interview Round 1
  const s2 = call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Interview Round 1' });
  assert.equal(s2.stage, 'Interview Round 1');

  // 3. Interview Round 1 -> Interview Round 2
  const s3 = call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Interview Round 2' });
  assert.equal(s3.stage, 'Interview Round 2');

  // 4. Interview Round 2 -> HR Round
  const s4 = call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'HR Round' });
  assert.equal(s4.stage, 'HR Round');

  // 5. HR Round -> Pre-Onboarding Training
  const s5 = call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Pre-Onboarding Training' });
  assert.equal(s5.stage, 'Pre-Onboarding Training');

  // 6. Pre-Onboarding Training: Submit rating evaluation with 'next' decision -> moves to Onboarding
  const evalRes = call(f, f.recruiter, 'POST', `applications/${f.app.id}/training-evaluation`, {
    rating: 5,
    practical_score: 95.5,
    notes: 'Exceeded all technical and culture orientation benchmarks.',
    decision: 'next'
  });
  assert.equal(evalRes.evaluation.rating, 5);
  assert.equal(evalRes.evaluation.practical_score, 95.5);
  assert.equal(evalRes.evaluation.decision, 'next');
  assert.equal(evalRes.application.stage, 'Onboarding');

  // 7. Onboarding -> Hired (requires signed offer)
  addSignedOffer(f.db, f.app.id, f.candidate, f.req);
  const sFinal = call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Hired' });
  assert.equal(sFinal.stage, 'Hired');

  f.db.close();
});

test('Smart Hybrid Pipeline: Flexible 2-round jumping over optional Interview Round 3 directly to HR Round', () => {
  const f = hybridFixture();
  // Set pipeline with 3 rounds
  call(f, f.admin, 'PUT', 'pipeline', { preset: 'smart_hybrid_3rounds' });

  // Move through screening and round 1, round 2
  call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Screening Round' });
  call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Interview Round 1' });
  call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Interview Round 2' });

  // Candidate is at Interview Round 2. Requisition only requires 2 rounds!
  // Fast-track directly to HR Round without administrative override!
  const hrStage = call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'HR Round' });
  assert.equal(hrStage.stage, 'HR Round');

  f.db.close();
});

test('Smart Hybrid Pipeline: 3-round sequential progression through Interview Round 3', () => {
  const f = hybridFixture();
  call(f, f.admin, 'PUT', 'pipeline', { preset: 'smart_hybrid_3rounds' });

  call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Screening Round' });
  call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Interview Round 1' });
  call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Interview Round 2' });
  const r3 = call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Interview Round 3' });
  assert.equal(r3.stage, 'Interview Round 3');

  const hr = call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'HR Round' });
  assert.equal(hr.stage, 'HR Round');

  f.db.close();
});

test('Smart Hybrid Pipeline: Pre-Onboarding Training rating evaluation can reject or revoke', () => {
  const f = hybridFixture();
  call(f, f.admin, 'PUT', 'pipeline', { preset: 'smart_hybrid' });

  // Move to Pre-Onboarding Training
  for (const st of ['Screening Round', 'Interview Round 1', 'Interview Round 2', 'HR Round', 'Pre-Onboarding Training']) {
    call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: st });
  }

  // Evaluate candidate as failed with 'rejected' decision
  const evalFail = call(f, f.recruiter, 'POST', `applications/${f.app.id}/training-evaluation`, {
    rating: 2,
    practical_score: 45,
    notes: 'Did not pass assessment.',
    decision: 'rejected'
  });
  assert.equal(evalFail.evaluation.rating, 2);
  assert.equal(evalFail.evaluation.status, 'failed');
  assert.equal(evalFail.application.stage, 'Rejected');

  // Verify second candidate test with 'revoked' decision
  const c2 = call(f, f.recruiter, 'POST', 'candidates', { ...candidateBody, email: 'training.revoke@example.com' });
  const a2 = call(f, f.recruiter, 'POST', 'applications', { candidate_id: c2.id, requisition_id: f.req.id });
  for (const st of ['Screening Round', 'Interview Round 1', 'Interview Round 2', 'HR Round', 'Pre-Onboarding Training']) {
    call(f, f.recruiter, 'POST', `applications/${a2.id}/stage`, { stage: st });
  }
  const evalRevoke = call(f, f.recruiter, 'POST', `applications/${a2.id}/training-evaluation`, {
    rating: 1,
    decision: 'revoked',
    notes: 'Offer revoked due to failure to meet pre-onboarding conditions.'
  });
  assert.equal(evalRevoke.application.stage, 'Revoked');

  f.db.close();
});

test('Smart Hybrid Pipeline: Illegal non-sequential jumping is blocked without administrative override', () => {
  const f = hybridFixture();
  call(f, f.admin, 'PUT', 'pipeline', { preset: 'smart_hybrid' });

  // Cannot jump from Applied directly to Hired
  assert.throws(
    () => call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Hired' }),
    e => e.status === 409
  );

  // Cannot jump from Applied directly to Pre-Onboarding Training
  assert.throws(
    () => call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Pre-Onboarding Training' }),
    e => e.status === 409
  );

  f.db.close();
});

test('Smart Hybrid Pipeline: Interviews support multi-round planning and auto-incrementing round numbers', () => {
  const f = hybridFixture();
  call(f, f.admin, 'PUT', 'pipeline', { preset: 'smart_hybrid' });

  const tomorrow = new Date(Date.now() + 86400000).toISOString();

  // Schedule Round 1
  const i1 = call(f, f.recruiter, 'POST', 'interviews', {
    application_id: f.app.id,
    interviewer_id: f.interviewer.id,
    scheduled_at: tomorrow,
    competencies: ['Architecture', 'Problem solving'],
    round: 'Interview Round 1'
  });
  assert.ok(i1.id);

  // Schedule Round 2
  const i2 = call(f, f.recruiter, 'POST', 'interviews', {
    application_id: f.app.id,
    interviewer_id: f.interviewer.id,
    scheduled_at: tomorrow,
    competencies: ['System Design', 'Communication']
  });
  assert.ok(i2.id);

  const interviewRows = f.db.prepare('SELECT * FROM interviews WHERE application_id=? ORDER BY created_at ASC').all(f.app.id);
  assert.equal(interviewRows.length, 2);
  assert.equal(interviewRows[0].round, 'Interview Round 1');
  assert.equal(interviewRows[1].round_number, 2);

  f.db.close();
});

test('Smart Hybrid Pipeline: Custom pipeline supports up to 30 stages and rejects > 30 items', () => {
  const f = hybridFixture();

  // Construct 20 custom stages
  const deepStages = ['Applied'];
  for (let i = 1; i <= 17; i++) {
    deepStages.push(`Assessment Round ${i}`);
  }
  deepStages.push('Hired', 'Rejected');
  assert.equal(deepStages.length, 20);

  const updated = call(f, f.admin, 'PUT', 'pipeline', { stages: deepStages });
  assert.equal(updated.length, 20);
  assert.equal(updated[1], 'Assessment Round 1');
  assert.equal(updated.at(-2), 'Hired');

  // Attempting 31 stages must throw 400
  const overStages = ['Applied'];
  for (let i = 1; i <= 29; i++) {
    overStages.push(`Round ${i}`);
  }
  overStages.push('Hired', 'Rejected');
  assert.ok(overStages.length > 30);

  assert.throws(
    () => call(f, f.admin, 'PUT', 'pipeline', { stages: overStages }),
    e => e.status === 400 && e.message.includes('Stages must be a list with at most 30 items')
  );

  f.db.close();
});

test('Smart Hybrid Pipeline: Stage remapping migrates active applications during pipeline upgrade', () => {
  const f = hybridFixture();

  // Move candidate to legacy 'Screening' stage
  call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Screening' });
  assert.equal(f.db.prepare('SELECT stage FROM applications WHERE id=?').get(f.app.id).stage, 'Screening');

  // Attempting to remove 'Screening' without remap throws descriptive 409
  assert.throws(
    () => call(f, f.admin, 'PUT', 'pipeline', {
      stages: ['Applied', 'Screening Round', 'Interview Round 1', 'Hired', 'Rejected']
    }),
    e => e.status === 409 && e.message.includes('Screening (1 active candidate)')
  );

  // Supplying stage_remap safely migrates the application to 'Screening Round'
  const updated = call(f, f.admin, 'PUT', 'pipeline', {
    stages: ['Applied', 'Screening Round', 'Interview Round 1', 'Hired', 'Rejected'],
    stage_remap: { 'Screening': 'Screening Round' }
  });

  assert.deepEqual(updated, ['Applied', 'Screening Round', 'Interview Round 1', 'Hired', 'Rejected']);
  assert.equal(f.db.prepare('SELECT stage FROM applications WHERE id=?').get(f.app.id).stage, 'Screening Round');

  // Verify stage_events recorded the transition
  const events = f.db.prepare('SELECT * FROM stage_events WHERE application_id=? ORDER BY at DESC, rowid DESC').all(f.app.id);
  assert.equal(events[0].to_stage, 'Screening Round');
  assert.equal(events[0].from_stage, 'Screening');

  f.db.close();
});

test('Smart Hybrid Pipeline: Freely skips intermediate interview rounds while strictly protecting Offer and Hired gates', () => {
  const f = hybridFixture();
  // Configure pipeline with 3 interview rounds, HR Round, Offer, and Hired
  call(f, f.admin, 'PUT', 'pipeline', {
    stages: ['Applied', 'Screening Round', 'Interview Round 1', 'Interview Round 2', 'Interview Round 3', 'HR Round', 'Offer', 'Hired', 'Rejected']
  });

  // 1. Move to Screening Round
  call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Screening Round' });

  // 2. Skip Interview Round 1 directly to Interview Round 2
  const r2 = call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Interview Round 2' });
  assert.equal(r2.stage, 'Interview Round 2');

  // 3. Skip Interview Round 3 directly to HR Round
  const hr = call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'HR Round' });
  assert.equal(hr.stage, 'HR Round');

  // 4. From HR Round move to Offer
  const offer = call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Offer' });
  assert.equal(offer.stage, 'Offer');

  // 5. Test another candidate: skip from Interview Round 1 straight to Offer (bypassing Round 2, Round 3, HR Round)
  const c2 = call(f, f.recruiter, 'POST', 'candidates', { ...candidateBody, email: 'fasttrack.cand@example.com' });
  const a2 = call(f, f.recruiter, 'POST', 'applications', { candidate_id: c2.id, requisition_id: f.req.id });
  call(f, f.recruiter, 'POST', `applications/${a2.id}/stage`, { stage: 'Interview Round 1' });

  // Cannot bypass Offer to jump straight into Hired
  assert.throws(
    () => call(f, f.recruiter, 'POST', `applications/${a2.id}/stage`, { stage: 'Hired' }),
    e => e.status === 409
  );

  // But fast-tracking directly from Interview Round 1 to Offer succeeds
  const fastOffer = call(f, f.recruiter, 'POST', `applications/${a2.id}/stage`, { stage: 'Offer' });
  assert.equal(fastOffer.stage, 'Offer');

  f.db.close();
});



