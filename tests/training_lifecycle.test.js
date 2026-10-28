import test from 'node:test';
import assert from 'node:assert/strict';
import { service } from '../src/service.js';
import { fixture, reqBody, candidateBody, addSignedOffer } from './helpers.js';

const call = (f, u, m, p, b) => service(f.db, u, m, p, b);

function trainingFixture() {
  const f = fixture();
  call(f, f.admin, 'PUT', 'pipeline', { preset: 'smart_hybrid' });
  f.req = call(f, f.recruiter, 'POST', 'requisitions', reqBody);
  call(f, f.recruiter, 'POST', `requisitions/${f.req.id}/submit`);
  call(f, f.manager, 'POST', `requisitions/${f.req.id}/approve`, {});
  call(f, f.finance, 'POST', `requisitions/${f.req.id}/approve`, {});
  f.candidate = call(f, f.recruiter, 'POST', 'candidates', candidateBody);
  f.app = call(f, f.recruiter, 'POST', 'applications', { candidate_id: f.candidate.id, requisition_id: f.req.id });

  // Move candidate to Pre-Onboarding Training
  for (const st of ['Screening Round', 'Interview Round 1', 'Interview Round 2', 'HR Round', 'Offer']) {
    call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: st });
  }
  addSignedOffer(f.db, f.app.id, f.candidate, f.req);
  call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Pre-Onboarding Training' });
  return f;
}

test('1 & 2: Starting training persists start and end dates; training cannot start without valid deadline', () => {
  const f = trainingFixture();
  const startAt = new Date().toISOString();
  const endAt = new Date(Date.now() + 14 * 86400000).toISOString();

  // Invalid: missing deadline
  assert.throws(
    () => call(f, f.recruiter, 'POST', `applications/${f.app.id}/training/start`, { start_at: startAt }),
    /Mandatory training deadline/
  );

  // Invalid: end date before start date
  assert.throws(
    () => call(f, f.recruiter, 'POST', `applications/${f.app.id}/training/start`, {
      start_at: endAt,
      end_at: startAt
    }),
    /strictly after/
  );

  // Valid: start training with valid dates
  const res = call(f, f.recruiter, 'POST', `applications/${f.app.id}/training/start`, {
    start_at: startAt,
    end_at: endAt
  });
  assert.equal(res.training_status, 'in_progress');
  assert.equal(res.training_start_at, startAt);
  assert.equal(res.training_end_at, endAt);
  assert.equal(res.training_original_end_at, endAt);
  assert.equal(res.training_attempt, 1);

  // Verify in database
  const dbApp = f.db.prepare('SELECT * FROM applications WHERE id = ?').get(f.app.id);
  assert.equal(dbApp.training_status, 'in_progress');
  assert.equal(dbApp.training_end_at, endAt);

  f.db.close();
});

test('3 & 13: Overdue handling and pipeline applications listing reflects current deadline and overdue state', () => {
  const f = trainingFixture();
  // Set training deadline in past
  const pastStart = new Date(Date.now() - 20 * 86400000).toISOString();
  const pastEnd = new Date(Date.now() - 6 * 86400000).toISOString();

  call(f, f.recruiter, 'POST', `applications/${f.app.id}/training/start`, {
    start_at: pastStart,
    end_at: pastEnd
  });

  // Query GET applications
  const apps = call(f, f.recruiter, 'GET', 'applications');
  const app = apps.find(a => a.id === f.app.id);
  assert.ok(app);
  assert.equal(app.is_overdue, true);
  assert.equal(app.effective_training_status, 'overdue');
  assert.equal(app.stage, 'Pre-Onboarding Training'); // Candidate remains in Pre-Onboarding Training!

  f.db.close();
});

test('4 & 5: Failed evaluation is persisted and candidate remains in Pre-Onboarding Training; offer is NOT revoked', () => {
  const f = trainingFixture();
  const startAt = new Date().toISOString();
  const endAt = new Date(Date.now() + 10 * 86400000).toISOString();
  call(f, f.recruiter, 'POST', `applications/${f.app.id}/training/start`, { start_at: startAt, end_at: endAt });

  // Submit failed evaluation
  const evalRes = call(f, f.recruiter, 'POST', `applications/${f.app.id}/training-evaluation`, {
    rating: 2,
    practical_score: 52,
    notes: 'Failed backend practical component.',
    decision: 'rejected'
  });

  assert.equal(evalRes.evaluation.status, 'failed');
  assert.equal(evalRes.evaluation.rating, 2);
  assert.equal(evalRes.evaluation.attempt, 1);
  // Critical business rule: Candidate stays in Pre-Onboarding Training!
  assert.equal(evalRes.application.stage, 'Pre-Onboarding Training');
  assert.equal(evalRes.application.training_status, 'evaluation_failed');
  assert.equal(evalRes.application.offer_status, 'active');

  // Verify in database
  const dbApp = f.db.prepare('SELECT * FROM applications WHERE id = ?').get(f.app.id);
  assert.equal(dbApp.stage, 'Pre-Onboarding Training');
  assert.equal(dbApp.training_status, 'evaluation_failed');
  assert.equal(dbApp.offer_status, 'active');

  f.db.close();
});

test('6, 7, 8, 9: Restarting training creates attempt 2, preserves failed evaluation history, and allows new evaluation', () => {
  const f = trainingFixture();
  const startAt = new Date().toISOString();
  const endAt = new Date(Date.now() + 10 * 86400000).toISOString();
  call(f, f.recruiter, 'POST', `applications/${f.app.id}/training/start`, { start_at: startAt, end_at: endAt });

  // Attempt 1 fails
  call(f, f.recruiter, 'POST', `applications/${f.app.id}/training-evaluation`, {
    rating: 2,
    practical_score: 48,
    notes: 'Attempt 1 failed.',
    decision: 'rejected'
  });

  // Restart training for Attempt 2
  const newStartAt = new Date().toISOString();
  const newEndAt = new Date(Date.now() + 14 * 86400000).toISOString();
  const restartRes = call(f, f.recruiter, 'POST', `applications/${f.app.id}/training/restart`, {
    start_at: newStartAt,
    end_at: newEndAt,
    reason: 'Candidate provided additional 2 weeks of mentored retraining on API architecture.'
  });

  assert.equal(restartRes.attempt, 2);
  assert.equal(restartRes.application.training_attempt, 2);
  assert.equal(restartRes.application.training_status, 'retraining');
  assert.equal(restartRes.application.training_start_at, newStartAt);
  assert.equal(restartRes.application.training_end_at, newEndAt);
  assert.equal(restartRes.application.stage, 'Pre-Onboarding Training');

  // Verify Attempt 1 evaluation is still in database and not overwritten!
  const evals = f.db.prepare('SELECT * FROM training_evaluations WHERE application_id = ? ORDER BY attempt ASC').all(f.app.id);
  assert.equal(evals.length, 1);
  assert.equal(evals[0].attempt, 1);
  assert.equal(evals[0].rating, 2);

  // Submit new evaluation on Attempt 2 (Passes!)
  const eval2 = call(f, f.recruiter, 'POST', `applications/${f.app.id}/training-evaluation`, {
    rating: 5,
    practical_score: 96,
    notes: 'Candidate completed all retraining exercises with excellence.',
    decision: 'next'
  });

  assert.equal(eval2.evaluation.attempt, 2);
  assert.equal(eval2.evaluation.rating, 5);
  assert.equal(eval2.evaluation.status, 'passed');
  assert.equal(eval2.application.stage, 'Onboarding'); // Advanced to Onboarding!
  assert.equal(eval2.application.training_status, 'completed');

  // Full history query returns both evaluations and application metadata
  const history = call(f, f.recruiter, 'GET', `applications/${f.app.id}/training/history`);
  assert.equal(history.evaluations.length, 2);
  assert.equal(history.evaluations[0].attempt, 1);
  assert.equal(history.evaluations[0].status, 'failed');
  assert.equal(history.evaluations[1].attempt, 2);
  assert.equal(history.evaluations[1].status, 'passed');
  assert.equal(history.application.name, f.candidate.name);
  assert.equal(history.application.title, f.req.title);
  assert.equal(history.application.email, f.candidate.email);

  f.db.close();
});

test('11 & 12: Extending training deadline preserves original deadline and logs extension history', () => {
  const f = trainingFixture();
  const origStart = new Date().toISOString();
  const origEnd = new Date(Date.now() + 7 * 86400000).toISOString();
  call(f, f.recruiter, 'POST', `applications/${f.app.id}/training/start`, {
    start_at: origStart,
    end_at: origEnd
  });

  // Invalid extension: new deadline earlier than current deadline
  const earlierDeadline = new Date(Date.now() + 3 * 86400000).toISOString();
  assert.throws(
    () => call(f, f.recruiter, 'POST', `applications/${f.app.id}/training/extend-deadline`, {
      new_deadline: earlierDeadline,
      reason: 'Medical extension'
    }),
    /strictly later/
  );

  // Valid extension: extend by 7 more days
  const extendedDeadline = new Date(Date.now() + 14 * 86400000).toISOString();
  const extRes = call(f, f.recruiter, 'POST', `applications/${f.app.id}/training/extend-deadline`, {
    new_deadline: extendedDeadline,
    reason: 'Candidate requested 7 days medical extension approved by hiring manager.'
  });

  assert.equal(extRes.application.training_end_at, extendedDeadline);
  assert.equal(extRes.application.training_original_end_at, origEnd); // Original preserved!
  assert.equal(extRes.application.training_status, 'extended');

  // Verify extension recorded in history
  const history = call(f, f.recruiter, 'GET', `applications/${f.app.id}/training/history`);
  assert.equal(history.extensions.length, 1);
  assert.equal(history.extensions[0].previous_deadline, origEnd);
  assert.equal(history.extensions[0].new_deadline, extendedDeadline);
  assert.ok(history.extensions[0].reason.includes('medical extension'));

  f.db.close();
});

test('14 & 15: Revoking offer preserves candidate, application, and training evaluation history', () => {
  const f = trainingFixture();
  const origStart = new Date().toISOString();
  const origEnd = new Date(Date.now() + 7 * 86400000).toISOString();
  call(f, f.recruiter, 'POST', `applications/${f.app.id}/training/start`, {
    start_at: origStart,
    end_at: origEnd
  });

  // Record a failed evaluation
  call(f, f.recruiter, 'POST', `applications/${f.app.id}/training-evaluation`, {
    rating: 1,
    practical_score: 30,
    notes: 'Candidate breached integrity benchmark.',
    decision: 'rejected'
  });

  // Revoke offer
  const revokeRes = call(f, f.recruiter, 'POST', `applications/${f.app.id}/training/revoke-offer`, {
    reason: 'Candidate failed pre-onboarding technical benchmarks and offer was revoked.'
  });

  assert.equal(revokeRes.stage, 'Revoked');
  assert.equal(revokeRes.offer_status, 'revoked');
  assert.equal(revokeRes.application.training_status, 'offer_revoked');
  assert.equal(revokeRes.application.offer_status, 'revoked');

  // Verify candidate, application, and evaluations remain intact in database!
  const cand = f.db.prepare('SELECT * FROM candidates WHERE id = ?').get(f.candidate.id);
  assert.ok(cand);
  const app = f.db.prepare('SELECT * FROM applications WHERE id = ?').get(f.app.id);
  assert.equal(app.stage, 'Revoked');
  assert.equal(app.offer_status, 'revoked');
  const evals = f.db.prepare('SELECT * FROM training_evaluations WHERE application_id = ?').all(f.app.id);
  assert.equal(evals.length, 1);
  assert.equal(evals[0].rating, 1);

  // Cannot perform further training operations once revoked
  assert.throws(
    () => call(f, f.recruiter, 'POST', `applications/${f.app.id}/training/restart`, {
      start_at: new Date().toISOString(),
      end_at: new Date(Date.now() + 86400000).toISOString(),
      reason: 'Try again'
    }),
    /revoked offer/
  );

  f.db.close();
});

test('16: Unauthorized users cannot restart training, extend deadlines, or revoke offers', () => {
  const f = trainingFixture();
  const interviewer = { id: 'u_int_1', role: 'Interviewer', email: 'int@example.com', team: f.req.team };

  assert.throws(
    () => call(f, interviewer, 'POST', `applications/${f.app.id}/training/start`, {
      start_at: new Date().toISOString(),
      end_at: new Date(Date.now() + 86400000).toISOString()
    }),
    /cannot perform this action|Forbidden|permission/i
  );

  assert.throws(
    () => call(f, interviewer, 'POST', `applications/${f.app.id}/training/extend-deadline`, {
      new_deadline: new Date(Date.now() + 86400000).toISOString(),
      reason: 'Unauthorized attempt'
    }),
    /cannot perform this action|Forbidden|permission/i
  );

  assert.throws(
    () => call(f, interviewer, 'POST', `applications/${f.app.id}/training/restart`, {
      start_at: new Date().toISOString(),
      end_at: new Date(Date.now() + 86400000).toISOString(),
      reason: 'Unauthorized attempt'
    }),
    /cannot perform this action|Forbidden|permission/i
  );

  assert.throws(
    () => call(f, interviewer, 'POST', `applications/${f.app.id}/training/revoke-offer`, {
      reason: 'Unauthorized attempt'
    }),
    /cannot perform this action|Forbidden|permission/i
  );

  f.db.close();
});

test('10 & 20: Passing evaluation completes training and transitions pipeline; offer signing and stage flow verified', () => {
  const f = trainingFixture();
  const startAt = new Date().toISOString();
  const endAt = new Date(Date.now() + 14 * 86400000).toISOString();
  call(f, f.recruiter, 'POST', `applications/${f.app.id}/training/start`, { start_at: startAt, end_at: endAt });

  const evalPass = call(f, f.recruiter, 'POST', `applications/${f.app.id}/training-evaluation`, {
    rating: 4,
    practical_score: 88,
    decision: 'next',
    notes: 'Cleared all pre-onboarding milestones.'
  });

  assert.equal(evalPass.evaluation.rating, 4);
  assert.equal(evalPass.evaluation.status, 'passed');
  assert.equal(evalPass.application.stage, 'Onboarding');
  assert.equal(evalPass.application.training_status, 'completed');
  assert.ok(evalPass.application.training_completed_at);

  // Transition Onboarding -> Hired
  const hired = call(f, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Hired' });
  assert.equal(hired.stage, 'Hired');

  f.db.close();
});

test('18: Invalid dates and invalid transitions are rejected by backend', () => {
  const f = trainingFixture();

  // Non-existent dates
  assert.throws(
    () => call(f, f.recruiter, 'POST', `applications/${f.app.id}/training/start`, { start_at: 'invalid-date', end_at: 'bad-date' }),
    /Invalid|required/i
  );

  // Practical score > 100
  assert.throws(
    () => call(f, f.recruiter, 'POST', `applications/${f.app.id}/training-evaluation`, { rating: 5, practical_score: 150 }),
    /between 0 and 100/
  );

  // Rating out of bounds (1-5)
  assert.throws(
    () => call(f, f.recruiter, 'POST', `applications/${f.app.id}/training-evaluation`, { rating: 6 }),
    /between 1 and 5/
  );

  f.db.close();
});

test('19: Data persists authoritatively across database reopening', () => {
  const f = trainingFixture();
  const startAt = new Date().toISOString();
  const endAt = new Date(Date.now() + 10 * 86400000).toISOString();
  call(f, f.recruiter, 'POST', `applications/${f.app.id}/training/start`, { start_at: startAt, end_at: endAt });

  call(f, f.recruiter, 'POST', `applications/${f.app.id}/training-evaluation`, {
    rating: 2,
    practical_score: 50,
    decision: 'rejected',
    notes: 'Failed attempt 1.'
  });

  const extDeadline = new Date(Date.now() + 20 * 86400000).toISOString();
  call(f, f.recruiter, 'POST', `applications/${f.app.id}/training/extend-deadline`, {
    new_deadline: extDeadline,
    reason: 'Approved extension for retraining preparation.'
  });

  // Query raw SQLite database
  const appDb = f.db.prepare('SELECT * FROM applications WHERE id = ?').get(f.app.id);
  assert.equal(appDb.training_status, 'evaluation_failed');
  assert.equal(appDb.training_end_at, extDeadline);
  assert.equal(appDb.training_original_end_at, endAt);

  const extDb = f.db.prepare('SELECT * FROM training_deadline_extensions WHERE application_id = ?').all(f.app.id);
  assert.equal(extDb.length, 1);
  assert.equal(extDb[0].previous_deadline, endAt);
  assert.equal(extDb[0].new_deadline, extDeadline);

  f.db.close();
});

test('21: Starting training strictly validates only start/end dates and never demands rating; invalid training subaction returns 404', () => {
  const f = trainingFixture();
  const startAt = new Date().toISOString();
  const endAt = new Date(Date.now() + 14 * 86400000).toISOString();

  // Starting training payload has NO rating, only start_at and end_at
  const res = call(f, f.recruiter, 'POST', `applications/${f.app.id}/training/start`, {
    start_at: startAt,
    end_at: endAt
  });
  assert.equal(res.training_status, 'in_progress');
  assert.equal(res.training_start_at, startAt);
  assert.equal(res.training_end_at, endAt);

  // Calling an unrecognized training subaction does NOT fall through to evaluateTraining (which would complain about rating)
  assert.throws(
    () => call(f, f.recruiter, 'POST', `applications/${f.app.id}/training/nonexistent`, { foo: 'bar' }),
    /Unknown training action/
  );

  f.db.close();
});

