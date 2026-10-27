import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { openDb } from '../src/db.js';
import { createSession } from '../src/auth.js';
import { createApp } from '../src/server.js';
import { service } from '../src/service.js';
import { can, permissionsFor, rolePermissions } from '../src/policy.js';
import { fixture, user, reqBody, candidateBody, testConfig } from './helpers.js';

const call = (f, u, method, path, body) => service(f.db, u, method, path, body);

function hiringFixture() {
  const f = fixture();
  f.req = call(f, f.recruiter, 'POST', 'requisitions', reqBody);
  call(f, f.recruiter, 'POST', `requisitions/${f.req.id}/submit`);
  call(f, f.manager, 'POST', `requisitions/${f.req.id}/approve`, {});
  call(f, f.finance, 'POST', `requisitions/${f.req.id}/approve`, {});
  f.candidate = call(f, f.recruiter, 'POST', 'candidates', candidateBody);
  f.app = call(f, f.recruiter, 'POST', 'applications', {
    candidate_id: f.candidate.id,
    requisition_id: f.req.id
  });
  f.interview = call(f, f.recruiter, 'POST', 'interviews', {
    application_id: f.app.id,
    interviewer_id: f.interviewer.id,
    scheduled_at: new Date(Date.now() + 86400000).toISOString(),
    competencies: ['Technical', 'Communication']
  });
  return f;
}

test('central role matrix applies least privilege for Recruiter, Hiring Manager and Interviewer', () => {
  assert.deepEqual(permissionsFor('Recruiter'), ['recruit', 'review', 'analytics', 'refer', 'jobs', 'interview']);
  assert.deepEqual(permissionsFor('Hiring Manager'), ['requisition', 'approve_manager', 'review', 'refer', 'jobs', 'interview']);
  assert.deepEqual(permissionsFor('Interviewer'), ['interview', 'jobs']);

  const f = fixture();
  assert.equal(can(f.recruiter, 'recruit'), true);
  assert.equal(can(f.recruiter, 'admin'), false);
  assert.equal(can(f.recruiter, 'approve_manager'), false);
  assert.equal(can(f.manager, 'review'), true);
  assert.equal(can(f.manager, 'approve_manager'), true);
  assert.equal(can(f.manager, 'recruit'), false);
  assert.equal(can(f.manager, 'admin'), false);
  assert.equal(can(f.interviewer, 'interview'), true);
  assert.equal(can(f.interviewer, 'recruit'), false);
  assert.equal(can(f.interviewer, 'review'), false);
  assert.equal(can(f.interviewer, 'jobs'), true);

  // Disabled, missing and unknown roles fail closed.
  const disabled = user(f.db, 'Recruiter', 'Engineering', 'disabled');
  assert.equal(can(disabled, 'recruit'), false);
  assert.equal(can(null, 'jobs'), false);
  assert.deepEqual(rolePermissions['Agency'], []);
  f.db.close();
});

test('Interviewer can read only the candidate context for assigned interviews and never sensitive fields', () => {
  const f = hiringFixture();
  const view = call(f, f.interviewer, 'GET', `candidates/${f.candidate.id}`);
  assert.equal(view.access_scope, 'assigned_interviews');
  assert.equal(view.name, candidateBody.name);
  assert.equal(view.email, candidateBody.email);
  assert.deepEqual(view.skills, candidateBody.skills);
  assert.equal(view.applications.length, 1);
  assert.equal(view.applications[0].stage, 'Applied');
  assert.equal(view.interviews[0].id, f.interview.id);
  assert.equal(view.resume_text, undefined, 'resume text must not leak to interviewers');
  assert.equal(view.created_by, undefined);
  assert.equal(view.resume, undefined);
  assert.equal(view.can_delete, false);

  const detail = call(f, f.interviewer, 'GET', `interviews/${f.interview.id}`);
  assert.equal(detail.candidate.id, f.candidate.id);
  assert.equal(detail.candidate.email, candidateBody.email);
  assert.equal(detail.application.stage, 'Applied');
  assert.equal(detail.salary_min, undefined, 'interviewers must not see requisition salary');
  assert.equal(detail.requisition, undefined);

  // Candidate lists, other candidates and interview scheduling remain forbidden.
  assert.throws(() => call(f, f.interviewer, 'GET', 'candidates'), e => e.status === 403);
  const other = call(f, f.recruiter, 'POST', 'candidates', { ...candidateBody, email: 'other@example.com', name: 'Other Person' });
  assert.throws(() => call(f, f.interviewer, 'GET', `candidates/${other.id}`), e => e.status === 403);
  assert.throws(() => call(f, f.interviewer, 'POST', 'interviews', {
    application_id: f.app.id,
    interviewer_id: f.interviewer.id,
    scheduled_at: new Date(Date.now() + 86400000).toISOString(),
    competencies: ['Technical']
  }), e => e.status === 403);

  // A same-team interviewer who is not assigned to the interview is denied.
  const unassigned = user(f.db, 'Interviewer', 'Engineering');
  assert.throws(() => call(f, unassigned, 'GET', `candidates/${f.candidate.id}`), e => e.status === 403);
  assert.throws(() => call(f, unassigned, 'GET', `interviews/${f.interview.id}`), e => e.status === 403);
  f.db.close();
});

test('Hiring Manager reviews within the assigned team but cannot perform recruiter or admin actions', () => {
  const f = hiringFixture();
  const candidate = call(f, f.manager, 'GET', `candidates/${f.candidate.id}`);
  assert.equal(candidate.id, f.candidate.id);
  assert.equal(candidate.resume_text, candidateBody.resume_text);
  assert.equal(call(f, f.manager, 'GET', 'applications').length, 1);
  assert.equal(call(f, f.manager, 'GET', `applications/${f.app.id}/match`).score >= 0, true);

  assert.throws(() => call(f, f.manager, 'POST', 'candidates', {
    ...candidateBody, email: 'manager-created@example.com', name: 'Manager Created'
  }), e => e.status === 403);
  assert.throws(() => call(f, f.manager, 'PUT', `candidates/${f.candidate.id}`, { name: 'Renamed' }), e => e.status === 403);
  assert.throws(() => call(f, f.manager, 'POST', 'applications', {
    candidate_id: f.candidate.id,
    requisition_id: f.req.id
  }), e => e.status === 403);
  assert.throws(() => call(f, f.manager, 'POST', `applications/${f.app.id}/stage`, { stage: 'Screening' }), e => e.status === 403);
  assert.throws(() => call(f, f.manager, 'GET', 'admin/users'), e => e.status === 403);
  assert.throws(() => call(f, f.manager, 'GET', 'analytics'), e => e.status === 403);

  // Team scope still applies to reviewers.
  const salesCandidate = call(f, f.admin, 'POST', 'candidates', {
    ...candidateBody, email: 'sales@example.com', name: 'Sales Candidate', team: 'Sales'
  });
  assert.throws(() => call(f, f.manager, 'GET', `candidates/${salesCandidate.id}`), e => e.status === 403);
  f.db.close();
});

test('Recruiter owns recruiting workflows while approvals, role management and cross-team records stay blocked', () => {
  const f = hiringFixture();
  assert.equal(call(f, f.recruiter, 'GET', 'candidates').length, 1);
  assert.equal(call(f, f.recruiter, 'GET', 'applications').length, 1);
  const pending = call(f, f.recruiter, 'POST', 'requisitions', reqBody);
  call(f, f.recruiter, 'POST', `requisitions/${pending.id}/submit`);
  assert.throws(() => call(f, f.recruiter, 'POST', `requisitions/${pending.id}/approve`, {}), e => e.status === 403);
  assert.throws(() => call(f, f.recruiter, 'GET', 'admin/users'), e => e.status === 403);
  assert.throws(() => call(f, f.recruiter, 'POST', 'admin/users', {
    email: 'escalate@example.com', name: 'Escalate', role: 'System Admin', team: '', oid: '55555555-5555-5555-5555-555555555555', tenant: '11111111-1111-1111-1111-111111111111'
  }), e => e.status === 403);

  const salesRecruiter = user(f.db, 'Recruiter', 'Sales');
  assert.equal(call(f, salesRecruiter, 'GET', 'candidates').length, 0);
  assert.throws(() => call(f, salesRecruiter, 'GET', `candidates/${f.candidate.id}`), e => e.status === 403);
  f.db.close();
});

test('role changes are server-validated, self-escalation is blocked and old sessions stop working', async () => {
  const f = fixture();
  const c = testConfig();
  const recruiterSession = createSession(f.db, f.recruiter, c);
  assert.equal(recruiterSession.value.length > 20, true);

  // No API accepts a caller-supplied role to change the caller's own identity.
  assert.throws(() => call(f, f.recruiter, 'POST', 'admin/users', {
    email: 'self@example.com', name: 'Self', role: 'System Admin', team: '',
    oid: '66666666-6666-6666-6666-666666666666', tenant: '11111111-1111-1111-1111-111111111111'
  }), e => e.status === 403);
  assert.equal(f.db.prepare('SELECT role FROM users WHERE id=?').get(f.recruiter.id).role, 'Recruiter');

  // Administrators cannot change their own role/status.
  assert.throws(() => call(f, f.admin, 'POST', `admin/users/${f.admin.id}/update`, {
    role: 'Interviewer', team: 'Engineering'
  }), e => e.status === 409);

  // Invalid roles, agency roles and missing team assignments are rejected.
  assert.throws(() => call(f, f.admin, 'POST', `admin/users/${f.recruiter.id}/update`, { role: 'SuperUser', team: 'Engineering' }), e => e.status === 400);
  assert.throws(() => call(f, f.admin, 'POST', `admin/users/${f.recruiter.id}/update`, { role: 'Agency', team: 'Engineering' }), e => e.status === 400);
  assert.throws(() => call(f, f.admin, 'POST', `admin/users/${f.recruiter.id}/update`, { role: 'Hiring Manager', team: '' }), e => e.status === 400);

  // A valid role change bumps the session version, so the old session is dead.
  call(f, f.admin, 'POST', `admin/users/${f.recruiter.id}/update`, { role: 'Interviewer', team: 'Engineering' });
  const { sessionUser } = await import('../src/auth.js');
  assert.throws(() => sessionUser(f.db, recruiterSession.value), e => e.status === 401);
  const updated = f.db.prepare('SELECT * FROM users WHERE id=?').get(f.recruiter.id);
  assert.equal(updated.role, 'Interviewer');
  assert.equal(updated.version, 2);
  assert.deepEqual(permissionsFor(updated.role), ['interview', 'jobs']);
  f.db.close();
});

test('HTTP API enforces session, role and assignment checks on direct requests', async t => {
  const f = hiringFixture();
  const c = testConfig();
  const server = createApp({ db: f.db, c });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); f.db.close(); });

  const sessionHeaders = u => {
    const session = createSession(f.db, u, c);
    return { Cookie: `session=${session.value}`, Origin: c.origin, 'X-CSRF-Token': session.csrf, 'Content-Type': 'application/json' };
  };

  // Missing and expired sessions return 401.
  assert.equal((await fetch(`${base}/api/candidates/${f.candidate.id}`)).status, 401);
  const stale = createSession(f.db, f.interviewer, c);
  f.db.prepare('UPDATE sessions SET expires=0 WHERE user_id=?').run(f.interviewer.id);
  assert.equal((await fetch(`${base}/api/candidates/${f.candidate.id}`, {
    headers: { Cookie: `session=${stale.value}` }
  })).status, 401);

  // Interviewer may read their assigned candidate over HTTP but cannot list candidates.
  const interviewerHeaders = sessionHeaders(f.interviewer);
  const assigned = await fetch(`${base}/api/candidates/${f.candidate.id}`, { headers: interviewerHeaders });
  assert.equal(assigned.status, 200);
  const assignedBody = await assigned.json();
  assert.equal(assignedBody.access_scope, 'assigned_interviews');
  assert.equal(assignedBody.resume_text, undefined);
  assert.equal((await fetch(`${base}/api/candidates`, { headers: interviewerHeaders })).status, 403);

  // Hiring Manager cannot create candidates or access admin APIs.
  const managerHeaders = sessionHeaders(f.manager);
  assert.equal((await fetch(`${base}/api/candidates`, {
    method: 'POST', headers: managerHeaders,
    body: JSON.stringify({ ...candidateBody, email: 'http-manager@example.com', name: 'HTTP Manager' })
  })).status, 403);
  assert.equal((await fetch(`${base}/api/admin/users`, { headers: managerHeaders })).status, 403);

  // Recruiter cannot approve or escalate roles.
  const recruiterHeaders = sessionHeaders(f.recruiter);
  const pending = call(f, f.recruiter, 'POST', 'requisitions', reqBody);
  call(f, f.recruiter, 'POST', `requisitions/${pending.id}/submit`);
  assert.equal((await fetch(`${base}/api/requisitions/${pending.id}/approve`, {
    method: 'POST', headers: recruiterHeaders, body: '{}'
  })).status, 403);
  assert.equal((await fetch(`${base}/api/admin/users`, { headers: recruiterHeaders })).status, 403);

  // /api/me returns the effective permission list, not the full catalogue.
  const me = await (await fetch(`${base}/api/me`, { headers: recruiterHeaders })).json();
  assert.ok(me.permissions.includes('recruit'));
  assert.ok(!me.permissions.includes('admin'));
  assert.ok(!me.permissions.includes('approve_manager'));
  assert.equal(me.user.role, 'Recruiter');
});
