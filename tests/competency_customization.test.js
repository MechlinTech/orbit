import test from 'node:test';
import assert from 'node:assert/strict';
import { service } from '../src/service.js';
import { fixture, user, reqBody, candidateBody } from './helpers.js';

const call = (f, u, m, p, b) => service(f.db, u, m, p, b);
const markInterviewReady = (f, interview) =>
  f.db.prepare('UPDATE interviews SET scheduled_at=? WHERE id=?').run(
    new Date(Date.now() - 60000).toISOString(),
    interview.id
  );

function hiringFixture() {
  const f = fixture();
  f.req = call(f, f.recruiter, 'POST', 'requisitions', reqBody);
  call(f, f.recruiter, 'POST', `requisitions/${f.req.id}/submit`);
  call(f, f.manager, 'POST', `requisitions/${f.req.id}/approve`, {});
  call(f, f.finance, 'POST', `requisitions/${f.req.id}/approve`, {});
  f.candidate = call(f, f.recruiter, 'POST', 'candidates', candidateBody);
  f.app = call(f, f.recruiter, 'POST', 'applications', { candidate_id: f.candidate.id, requisition_id: f.req.id });
  return f;
}

test('Hiring Manager / Recruiter creates interview with default planned competencies', () => {
  const f = hiringFixture();
  const scheduledAt = new Date(Date.now() + 86400000).toISOString();

  const interview = call(f, f.recruiter, 'POST', 'interviews', {
    application_id: f.app.id,
    interviewer_id: f.interviewer.id,
    scheduled_at: scheduledAt,
    competencies: ['Problem Solving', 'System Architecture', 'Communication']
  });

  assert.ok(interview.id);
  assert.deepEqual(JSON.parse(interview.competencies), ['Problem Solving', 'System Architecture', 'Communication']);
  f.db.close();
});

test('Assigned interviewer can edit competencies on scheduled interview', () => {
  const f = hiringFixture();
  const secondInterviewer = user(f.db, 'Interviewer');
  const scheduledAt = new Date(Date.now() + 86400000).toISOString();

  const interview = call(f, f.recruiter, 'POST', 'interviews', {
    application_id: f.app.id,
    interviewer_id: f.interviewer.id,
    scheduled_at: scheduledAt,
    competencies: ['Initial Comp 1', 'Initial Comp 2']
  });

  // Assigned interviewer updates competencies
  const updated = call(f, f.interviewer, 'PUT', `interviews/${interview.id}`, {
    scheduled_at: new Date(Date.now() + 86400000).toISOString(),
    competencies: ['Technical Depth', 'System Design', 'Domain Knowledge']
  });

  assert.deepEqual(JSON.parse(updated.competencies), ['Technical Depth', 'System Design', 'Domain Knowledge']);

  // Another interviewer cannot update this interview
  assert.throws(
    () => call(f, secondInterviewer, 'PUT', `interviews/${interview.id}`, {
      scheduled_at: new Date(Date.now() + 86400000).toISOString(),
      competencies: ['Hacking']
    }),
    err => err.status === 403
  );

  f.db.close();
});

test('Interviewer can add custom competencies and remove planned competencies during scorecard submission', () => {
  const f = hiringFixture();
  const interview = call(f, f.recruiter, 'POST', 'interviews', {
    application_id: f.app.id,
    interviewer_id: f.interviewer.id,
    scheduled_at: new Date(Date.now() + 86400000).toISOString(),
    competencies: ['Algorithms', 'System Design', 'Written Communication']
  });

  markInterviewReady(f, interview);

  // Scorecard with:
  // - Kept & marked: 'Algorithms' (4), 'System Design' (5)
  // - Removed: 'Written Communication' (omitted from submission)
  // - Added custom: 'Debugging Skills' (5), 'Team Collaboration' (4)
  const scorecardPayload = {
    ratings: {
      'Algorithms': 4,
      'System Design': 5,
      'Debugging Skills': 5,
      'Team Collaboration': 4
    },
    recommendation: 'Strong yes',
    notes: 'Candidate demonstrated outstanding analytical capability and live debugging skills.'
  };

  const result = call(f, f.interviewer, 'POST', `interviews/${interview.id}/scorecards`, scorecardPayload);
  assert.ok(result.id);

  // Check persisted interview row: competencies updated to reflect evaluated list
  const interviewRow = f.db.prepare('SELECT * FROM interviews WHERE id=?').get(interview.id);
  assert.equal(interviewRow.status, 'completed');
  assert.deepEqual(
    JSON.parse(interviewRow.competencies),
    ['Algorithms', 'System Design', 'Debugging Skills', 'Team Collaboration']
  );

  // Reviewing feedback reveals custom competencies
  const fb = call(f, f.interviewer, 'GET', `interviews/${interview.id}/scorecards`);
  assert.equal(fb.scorecards.length, 1);
  const ratings = JSON.parse(fb.scorecards[0].ratings);
  assert.equal(ratings['Algorithms'], 4);
  assert.equal(ratings['System Design'], 5);
  assert.equal(ratings['Debugging Skills'], 5);
  assert.equal(ratings['Team Collaboration'], 4);
  assert.equal(ratings['Written Communication'], undefined);

  f.db.close();
});

test('Scorecard validation rejects empty ratings, invalid rating values, and out-of-range ratings', () => {
  const f = hiringFixture();
  const interview = call(f, f.recruiter, 'POST', 'interviews', {
    application_id: f.app.id,
    interviewer_id: f.interviewer.id,
    scheduled_at: new Date(Date.now() + 86400000).toISOString(),
    competencies: ['Problem Solving']
  });

  markInterviewReady(f, interview);

  // 1. Empty ratings object
  assert.throws(
    () => call(f, f.interviewer, 'POST', `interviews/${interview.id}/scorecards`, {
      ratings: {},
      recommendation: 'Yes',
      notes: 'No ratings'
    }),
    err => err.status === 400 && err.message.includes('At least one competency rating is required')
  );

  // 2. Non-object ratings
  assert.throws(
    () => call(f, f.interviewer, 'POST', `interviews/${interview.id}/scorecards`, {
      ratings: 'invalid',
      recommendation: 'Yes',
      notes: 'Wrong type'
    }),
    err => err.status === 400 && err.message.includes('Ratings must be an object')
  );

  // 3. Rating score > 5
  assert.throws(
    () => call(f, f.interviewer, 'POST', `interviews/${interview.id}/scorecards`, {
      ratings: { 'Problem Solving': 6 },
      recommendation: 'Yes',
      notes: 'Too high'
    }),
    err => err.status === 400 && err.message.includes('must be between 1 and 5')
  );

  // 4. Rating score < 1
  assert.throws(
    () => call(f, f.interviewer, 'POST', `interviews/${interview.id}/scorecards`, {
      ratings: { 'Problem Solving': 0 },
      recommendation: 'Yes',
      notes: 'Too low'
    }),
    err => err.status === 400 && err.message.includes('must be between 1 and 5')
  );

  // 5. Rating score not an integer (e.g. float or string)
  assert.throws(
    () => call(f, f.interviewer, 'POST', `interviews/${interview.id}/scorecards`, {
      ratings: { 'Problem Solving': 3.5 },
      recommendation: 'Yes',
      notes: 'Float rating'
    }),
    err => err.status === 400 && err.message.includes('must be between 1 and 5')
  );

  // 6. Empty competency name key
  assert.throws(
    () => call(f, f.interviewer, 'POST', `interviews/${interview.id}/scorecards`, {
      ratings: { '   ': 4 },
      recommendation: 'Yes',
      notes: 'Blank competency'
    }),
    err => err.status === 400
  );

  f.db.close();
});

test('Admin proxy scorecard submission supports adding and removing competencies on behalf of interviewer', () => {
  const f = hiringFixture();
  const interview = call(f, f.recruiter, 'POST', 'interviews', {
    application_id: f.app.id,
    interviewer_id: f.interviewer.id,
    scheduled_at: new Date(Date.now() + 86400000).toISOString(),
    competencies: ['Default A', 'Default B']
  });

  markInterviewReady(f, interview);

  const proxyPayload = {
    ratings: {
      'Default A': 4,
      'Interviewer Aspect - Quick Learner': 5
    },
    recommendation: 'Yes',
    notes: 'Interviewer provided ratings over phone call.',
    proxy_reason: 'Interviewer network outage during onsite session'
  };

  const proxyRes = call(f, f.admin, 'POST', `interviews/${interview.id}/scorecards`, proxyPayload);
  assert.ok(proxyRes.id);
  assert.equal(proxyRes.proxy_for, f.interviewer.id);

  const fb = call(f, f.admin, 'GET', `interviews/${interview.id}/scorecards`);
  assert.equal(fb.scorecards.length, 1);
  const sc = fb.scorecards[0];
  assert.equal(sc.proxy_for, f.interviewer.id);
  assert.equal(sc.proxy_reason, 'Interviewer network outage during onsite session');
  const ratings = JSON.parse(sc.ratings);
  assert.equal(ratings['Default A'], 4);
  assert.equal(ratings['Interviewer Aspect - Quick Learner'], 5);
  assert.equal(ratings['Default B'], undefined);

  f.db.close();
});
