import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, id, now } from '../src/db.js';
import { service } from '../src/service.js';
import { fixture, user, reqBody, candidateBody, addSignedOffer } from './helpers.js';

function flowFixture() {
  const f = fixture();
  f.db.prepare("UPDATE settings SET value=? WHERE key='pipeline'").run(
    '["Applied","Screening Round","Interview Round 1","Interview Round 2","HR Round","Pre-Onboarding Training","Onboarding","Hired","Rejected","Revoked"]'
  );
  const cand = service(f.db, f.recruiter, 'POST', 'candidates', candidateBody);
  const reqRes = service(f.db, f.recruiter, 'POST', 'requisitions', reqBody);
  service(f.db, f.recruiter, 'POST', `requisitions/${reqRes.id}/submit`);
  service(f.db, f.manager, 'POST', `requisitions/${reqRes.id}/approve`, { note: 'Manager approve' });
  service(f.db, f.finance, 'POST', `requisitions/${reqRes.id}/approve`, { note: 'Finance approve' });
  const app = service(f.db, f.recruiter, 'POST', 'applications', { candidate_id: cand.id, requisition_id: reqRes.id });
  return { ...f, candidate: cand, req: reqRes, app };
}

test('Stage Flow: Candidate cannot advance from Pre-Onboarding Training to Onboarding without training rating', () => {
  const f = flowFixture();
  // Move candidate to Pre-Onboarding Training (with signed offer)
  addSignedOffer(f.db, f.app.id, f.candidate, f.req);
  for (const st of ['Screening Round', 'Interview Round 1', 'Interview Round 2', 'HR Round', 'Pre-Onboarding Training']) {
    service(f.db, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: st });
  }

  // Attempt to move candidate to Onboarding directly without evaluation rating
  assert.throws(
    () => service(f.db, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Onboarding' }),
    err => {
      assert.equal(err.status, 409);
      assert.match(err.message, /Pre-onboarding training.*performance rating and.*evaluation are required/i);
      return true;
    }
  );

  // Submit failed rating (rating: 2, status: 'failed', decision: 'rejected')
  service(f.db, f.recruiter, 'POST', `applications/${f.app.id}/training-evaluation`, {
    rating: 2,
    practical_score: 55,
    notes: 'Failed assessment benchmark',
    decision: 'rejected'
  });

  // Attempt to advance to Onboarding after failed evaluation
  assert.throws(
    () => service(f.db, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Onboarding' }),
    err => {
      assert.equal(err.status, 409);
      assert.match(err.message, /Candidate failed training evaluation.*satisfactory rating/i);
      return true;
    }
  );

  // Submit passing evaluation (rating: 4, practical_score: 88, decision: 'next')
  const evalPass = service(f.db, f.recruiter, 'POST', `applications/${f.app.id}/training-evaluation`, {
    rating: 4,
    practical_score: 88,
    notes: 'Cleared training benchmarks with merit',
    decision: 'next'
  });
  assert.equal(evalPass.application.stage, 'Onboarding');
  assert.equal(evalPass.application.training_status, 'completed');

  // Candidate is now in Onboarding; can advance to Hired
  const hired = service(f.db, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Hired' });
  assert.equal(hired.stage, 'Hired');

  f.db.close();
});

test('Stage Flow: Scheduled interview blocks moving forward until scorecard rating is submitted', () => {
  const f = flowFixture();
  // Move to Screening Round
  service(f.db, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Screening Round' });

  // Schedule an interview
  const interview = service(f.db, f.recruiter, 'POST', 'interviews', {
    application_id: f.app.id,
    interviewer_id: f.interviewer.id,
    scheduled_at: new Date(Date.now() + 86400000).toISOString(),
    competencies: ['Problem solving', 'System design'],
    round: 'Screening Round'
  });

  // Attempt to advance to Interview Round 1 while interview is scheduled but unrated
  assert.throws(
    () => service(f.db, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Interview Round 1' }),
    err => {
      assert.equal(err.status, 409);
      assert.match(err.message, /interview with .* is scheduled for Screening Round and has not been rated.*scorecard rating is required/i);
      return true;
    }
  );

  // Mark interview time as past so scorecard can be submitted
  f.db.prepare("UPDATE interviews SET scheduled_at = ? WHERE id = ?").run(new Date(Date.now() - 3600000).toISOString(), interview.id);

  // Submit scorecard with passing recommendation
  service(f.db, f.interviewer, 'POST', `interviews/${interview.id}/scorecards`, {
    ratings: { 'Problem solving': 4, 'System design': 4 },
    recommendation: 'Yes',
    notes: 'Solid understanding of core patterns.'
  });

  // Now advancing to Interview Round 1 succeeds
  const nextStage = service(f.db, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Interview Round 1' });
  assert.equal(nextStage.stage, 'Interview Round 1');

  f.db.close();
});

test('Stage Flow: Negative scorecard recommendation blocks advancing without admin override', () => {
  const f = flowFixture();
  service(f.db, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Screening Round' });

  const interview = service(f.db, f.recruiter, 'POST', 'interviews', {
    application_id: f.app.id,
    interviewer_id: f.interviewer.id,
    scheduled_at: new Date(Date.now() + 86400000).toISOString(),
    competencies: ['Coding'],
    round: 'Screening Round'
  });
  f.db.prepare("UPDATE interviews SET scheduled_at = ? WHERE id = ?").run(new Date(Date.now() - 3600000).toISOString(), interview.id);

  // Submit scorecard with 'No' recommendation
  service(f.db, f.interviewer, 'POST', `interviews/${interview.id}/scorecards`, {
    ratings: { 'Coding': 2 },
    recommendation: 'No',
    notes: 'Candidate struggled with data structure basics.'
  });

  // Recruiter cannot advance candidate with negative recommendation
  assert.throws(
    () => service(f.db, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Interview Round 1' }),
    err => {
      assert.equal(err.status, 409);
      assert.match(err.message, /negative recommendation.*administrative override/i);
      return true;
    }
  );

  // Admin without override reason cannot advance candidate
  assert.throws(
    () => service(f.db, f.admin, 'POST', `applications/${f.app.id}/stage`, { stage: 'Interview Round 1' }),
    err => {
      assert.equal(err.status, 409);
      assert.match(err.message, /requires administrative override/i);
      return true;
    }
  );

  // Admin with explicit override can advance candidate
  const advanced = service(f.db, f.admin, 'POST', `applications/${f.app.id}/stage`, {
    stage: 'Interview Round 1',
    admin_override: true,
    override_reason: 'Hiring Manager approved second chance due to technical platform issue'
  });
  assert.equal(advanced.stage, 'Interview Round 1');

  // Verify audit entry for override
  const auditRow = f.db.prepare("SELECT * FROM audit WHERE event='admin.application_stage_override' AND target=?").get(f.app.id);
  assert.ok(auditRow);
  assert.match(auditRow.detail, /negative_recommendation/);

  f.db.close();
});

test('Stage Flow: Candidate cannot enter Onboarding or Pre-Onboarding Training without signed offer', () => {
  const f = flowFixture();
  for (const st of ['Screening Round', 'Interview Round 1', 'Interview Round 2', 'HR Round']) {
    service(f.db, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: st });
  }

  // Attempting to advance to Pre-Onboarding Training without signed offer fails
  assert.throws(
    () => service(f.db, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Pre-Onboarding Training' }),
    err => {
      assert.equal(err.status, 409);
      assert.match(err.message, /must sign the offer letter/i);
      return true;
    }
  );

  // Attempting to advance to Onboarding without signed offer fails
  assert.throws(
    () => service(f.db, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Onboarding' }),
    err => {
      assert.equal(err.status, 409);
      assert.match(err.message, /must sign the offer letter/i);
      return true;
    }
  );

  f.db.close();
});

test('Stage Flow: Candidate with revoked offer cannot advance to active stages', () => {
  const f = flowFixture();
  addSignedOffer(f.db, f.app.id, f.candidate, f.req);
  for (const st of ['Screening Round', 'Interview Round 1', 'Interview Round 2', 'HR Round', 'Pre-Onboarding Training']) {
    service(f.db, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: st });
  }

  // Revoke offer
  const revokedRes = service(f.db, f.recruiter, 'POST', `applications/${f.app.id}/training/revoke-offer`, {
    reason: 'Candidate breached integrity expectations'
  });
  assert.equal(revokedRes.stage, 'Revoked');
  assert.equal(revokedRes.offer_status, 'revoked');

  // Attempt to advance from Revoked to Onboarding
  assert.throws(
    () => service(f.db, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Onboarding' }),
    err => {
      assert.equal(err.status, 409);
      assert.match(err.message, /candidate offer has been revoked|terminal stage/i);
      return true;
    }
  );

  // If candidate is in Pre-Onboarding Training and offer is revoked, stage transition is strictly blocked
  f.db.prepare("UPDATE applications SET stage='Pre-Onboarding Training', offer_status='revoked' WHERE id=?").run(f.app.id);
  assert.throws(
    () => service(f.db, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Onboarding' }),
    err => {
      assert.equal(err.status, 409);
      assert.match(err.message, /candidate offer has been revoked/i);
      return true;
    }
  );

  // Moving to terminal Revoked stage is allowed when offer is revoked
  const movedToRevoked = service(f.db, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Revoked' });
  assert.equal(movedToRevoked.stage, 'Revoked');

  f.db.close();
});

test('Stage Flow: Moving application to the same stage is rejected with 400', () => {
  const f = flowFixture();
  assert.throws(
    () => service(f.db, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Applied' }),
    err => {
      assert.equal(err.status, 400);
      assert.match(err.message, /already in Applied stage/i);
      return true;
    }
  );
  f.db.close();
});
