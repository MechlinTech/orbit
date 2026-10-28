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

test('Stage Flow: Applied stage does not show pending interview and advancing to Screening Round is not blocked', () => {
  const f = flowFixture();
  assert.equal(f.app.stage, 'Applied');

  // Schedule an interview for Screening Round while application is in Applied
  const interview = service(f.db, f.recruiter, 'POST', 'interviews', {
    application_id: f.app.id,
    interviewer_id: f.interviewer.id,
    scheduled_at: new Date(Date.now() + 86400000).toISOString(),
    competencies: ['Problem solving'],
    round: 'Screening Round'
  });
  assert.ok(interview.id);

  // Applications listing should NOT attach pending_interview while candidate is still in Applied
  const apps = service(f.db, f.recruiter, 'GET', 'applications');
  const appInApplied = apps.find(a => a.id === f.app.id);
  assert.equal(appInApplied.stage, 'Applied');
  assert.equal(appInApplied.pending_interview, null, 'Applied cards must not show pending interview');

  // Recruiter can advance candidate from Applied to Screening Round without error
  const advanced = service(f.db, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Screening Round' });
  assert.equal(advanced.stage, 'Screening Round');

  // Once in Screening Round, the scheduled interview is attached as pending_interview
  const appsAfterMove = service(f.db, f.recruiter, 'GET', 'applications');
  const appInScreening = appsAfterMove.find(a => a.id === f.app.id);
  assert.equal(appInScreening.stage, 'Screening Round');
  assert.ok(appInScreening.pending_interview, 'Screening Round card must now reflect the scheduled interview');
  assert.equal(appInScreening.pending_interview.id, interview.id);

  // Moving forward from Screening Round now requires scorecard rating
  assert.throws(
    () => service(f.db, f.recruiter, 'POST', `applications/${f.app.id}/stage`, { stage: 'Interview Round 1' }),
    err => {
      assert.equal(err.status, 409);
      assert.match(err.message, /scorecard rating is required/i);
      return true;
    }
  );

  f.db.close();
});

test('Requisitions: A user authorized for the QA team can create and save a QA requisition successfully', () => {
  const f = fixture();

  // 1. Hiring Manager authorized for QA creates a QA requisition
  const qaManager = user(f.db, 'Hiring Manager', 'QA');
  const req = service(f.db, qaManager, 'POST', 'requisitions', {
    title: 'QA Lead Automation Engineer',
    team: 'QA',
    headcount: 2,
    salary_min: 80000,
    salary_max: 130000,
    currency: 'USD',
    description: 'Lead automated testing workflows and frameworks.',
    skills: ['Playwright', 'Selenium', 'CI/CD']
  });
  assert.ok(req.id, 'Requisition created successfully');
  assert.equal(req.team, 'QA');
  assert.equal(req.title, 'QA Lead Automation Engineer');

  // 2. Recruiter authorized for QA updates/saves the requisition
  const qaRecruiter = user(f.db, 'Recruiter', 'QA');
  const updatedReq = service(f.db, qaRecruiter, 'PUT', `requisitions/${req.id}`, {
    title: 'Senior QA Lead Automation Engineer',
    team: 'QA',
    headcount: 3
  });
  assert.equal(updatedReq.title, 'Senior QA Lead Automation Engineer');
  assert.equal(updatedReq.headcount, 3);
  assert.equal(updatedReq.team, 'QA');

  // 3. User with lowercase 'qa' creates and saves a requisition
  const lowercaseQaUser = user(f.db, 'Hiring Manager', 'qa');
  const reqLower = service(f.db, lowercaseQaUser, 'POST', 'requisitions', {
    title: 'QA Manual Tester',
    team: 'qa',
    headcount: 1,
    salary_min: 50000,
    salary_max: 75000,
    currency: 'USD',
    description: 'Manual and exploratory QA testing.',
    skills: ['Manual Testing', 'Jira']
  });
  assert.ok(reqLower.id);
  assert.equal(reqLower.team, 'QA', 'Team is normalized to QA');

  const updatedReqLower = service(f.db, lowercaseQaUser, 'PUT', `requisitions/${reqLower.id}`, {
    title: 'Senior QA Manual Tester',
    team: 'qa'
  });
  assert.equal(updatedReqLower.title, 'Senior QA Manual Tester');

  // 4. User with alias 'Quality Assurance' or multi-team 'QA, Dev'
  const aliasUser = user(f.db, 'Recruiter', 'Quality Assurance');
  const multiTeamUser = user(f.db, 'Hiring Manager', 'QA, Dev');

  const reqAlias = service(f.db, aliasUser, 'POST', 'requisitions', {
    title: 'SDET II',
    team: 'Quality Assurance',
    headcount: 1,
    salary_min: 90000,
    salary_max: 120000,
    currency: 'USD',
    description: 'Software development engineer in test.',
    skills: ['Python', 'PyTest']
  });
  assert.ok(reqAlias.id);
  assert.equal(reqAlias.team, 'QA');

  const updatedMulti = service(f.db, multiTeamUser, 'PUT', `requisitions/${reqAlias.id}`, {
    headcount: 2,
    team: 'QA'
  });
  assert.equal(updatedMulti.headcount, 2);

  // 5. Unauthorized user belonging only to 'Dev' gets 403 when creating or saving QA requisition
  const devUser = user(f.db, 'Hiring Manager', 'Dev');
  assert.throws(
    () => service(f.db, devUser, 'POST', 'requisitions', {
      title: 'QA Rogue Position',
      team: 'QA',
      headcount: 1,
      salary_min: 60000,
      salary_max: 90000,
      currency: 'USD',
      description: 'Unauthorized QA creation.',
      skills: ['Testing']
    }),
    err => {
      assert.equal(err.status, 403);
      assert.equal(err.message, 'This record belongs to another team.');
      return true;
    }
  );

  assert.throws(
    () => service(f.db, devUser, 'PUT', `requisitions/${req.id}`, {
      title: 'Hacked Title',
      team: 'QA'
    }),
    err => {
      assert.equal(err.status, 403);
      assert.equal(err.message, 'This record belongs to another team.');
      return true;
    }
  );

  f.db.close();
});

test('Candidate creation: A user authorized for QA can save a candidate to the QA candidate pool successfully', () => {
  const f = fixture();

  // 1. Recruiter authorized for QA creates a candidate in the QA candidate pool
  const qaRecruiter = user(f.db, 'Recruiter', 'QA');
  const candQA = service(f.db, qaRecruiter, 'POST', 'candidates', {
    name: 'Sarah Connor',
    email: 'sarah.connor@example.com',
    team: 'QA',
    skills: ['Selenium', 'Cypress', 'API Testing'],
    source: 'LinkedIn',
    experience: '5 years of automated and manual QA engineering.'
  });
  assert.ok(candQA.id, 'Candidate created successfully');
  assert.equal(candQA.team, 'QA');
  assert.equal(candQA.name, 'Sarah Connor');
  assert.equal(candQA.applications.length, 0, 'Candidate is in pool only (no applications)');

  // 2. TA Manager authorized for QA updates and saves the candidate
  const qaManager = user(f.db, 'TA Manager', 'QA');
  const updatedCand = service(f.db, qaManager, 'PUT', `candidates/${candQA.id}`, {
    name: 'Sarah Connor-Reese',
    team: 'QA',
    skills: ['Selenium', 'Cypress', 'Playwright', 'API Testing']
  });
  assert.equal(updatedCand.name, 'Sarah Connor-Reese');
  assert.equal(updatedCand.team, 'QA');

  // 3. User authorized for QA creates candidate with 'QA candidate pool' alias
  const candPoolAlias = service(f.db, qaRecruiter, 'POST', 'candidates', {
    name: 'Kyle Reese',
    email: 'kyle.reese@example.com',
    team: 'QA candidate pool',
    skills: ['Performance Testing', 'JMeter'],
    source: 'Referral'
  });
  assert.ok(candPoolAlias.id);
  assert.equal(candPoolAlias.team, 'QA', 'Team is normalized to QA');

  // 4. User with alias 'Quality Assurance' or multi-team 'QA, Dev'
  const qaAliasUser = user(f.db, 'Recruiter', 'Quality Assurance');
  const candFromAliasUser = service(f.db, qaAliasUser, 'POST', 'candidates', {
    name: 'John Connor',
    email: 'john.connor@example.com',
    team: 'Quality Assurance',
    skills: ['Security Testing', 'Penetration Testing']
  });
  assert.ok(candFromAliasUser.id);
  assert.equal(candFromAliasUser.team, 'QA');

  const multiTeamRecruiter = user(f.db, 'Recruiter', 'QA, Dev');
  const candFromMultiTeam = service(f.db, multiTeamRecruiter, 'POST', 'candidates', {
    name: 'Miles Dyson',
    email: 'miles.dyson@example.com',
    team: 'QA pool'
  });
  assert.ok(candFromMultiTeam.id);
  assert.equal(candFromMultiTeam.team, 'QA');

  // 5. User authorized for QA omitting team defaults to authorized team
  const candDefaultTeam = service(f.db, qaRecruiter, 'POST', 'candidates', {
    name: 'Marcus Wright',
    email: 'marcus.wright@example.com'
  });
  assert.ok(candDefaultTeam.id);
  assert.equal(candDefaultTeam.team, 'QA');

  // 6. Authorized QA user can query candidate directory / pool
  const qaDirectory = service(f.db, qaRecruiter, 'GET', 'candidates');
  const candidateEmails = qaDirectory.map(c => c.email);
  assert.ok(candidateEmails.includes('sarah.connor@example.com'));
  assert.ok(candidateEmails.includes('kyle.reese@example.com'));
  assert.ok(candidateEmails.includes('john.connor@example.com'));

  // 7. Unauthorized user belonging only to 'Dev' gets 403 when creating candidate for QA pool
  const devRecruiter = user(f.db, 'Recruiter', 'Dev');
  assert.throws(
    () => service(f.db, devRecruiter, 'POST', 'candidates', {
      name: 'Unauthorized Cand',
      email: 'unauth@example.com',
      team: 'QA'
    }),
    err => {
      assert.equal(err.status, 403);
      assert.equal(err.message, 'This record belongs to another team.');
      return true;
    }
  );

  assert.throws(
    () => service(f.db, devRecruiter, 'PUT', `candidates/${candQA.id}`, {
      name: 'Hacked Name',
      team: 'QA'
    }),
    err => {
      assert.equal(err.status, 403);
      assert.equal(err.message, 'This record belongs to another team.');
      return true;
    }
  );

  f.db.close();
});


