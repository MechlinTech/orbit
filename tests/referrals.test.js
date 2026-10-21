import test from 'node:test';
import assert from 'node:assert/strict';
import { service } from '../src/service.js';
import { id, now } from '../src/db.js';
import { fixture, user, reqBody } from './helpers.js';

const call = (f, u, m, p, b) => service(f.db, u, m, p, b);

function openRequisition(f, title = reqBody.title) {
  const req = call(f, f.recruiter, 'POST', 'requisitions', { ...reqBody, title });
  call(f, f.recruiter, 'POST', `requisitions/${req.id}/submit`);
  call(f, f.manager, 'POST', `requisitions/${req.id}/approve`, {});
  call(f, f.finance, 'POST', `requisitions/${req.id}/approve`, {});
  return req;
}

function referralBody(req, email = 'ref.candidate@example.com') {
  return { requisition_id: req.id, name: 'Referral Candidate', email, note: 'Worked together previously.' };
}

test('referral list and details expose position/status only within the permitted scope', () => {
  const f = fixture();
  const req = openRequisition(f, 'Senior Platform Engineer');
  const employee = user(f.db, 'Employee/Referral', 'Engineering');
  const colleague = user(f.db, 'Employee/Referral', 'Engineering');
  const salesRecruiter = user(f.db, 'Recruiter', 'Sales');
  const referral = call(f, employee, 'POST', 'referrals', referralBody(req));

  assert.equal(referral.status, 'Submitted');
  assert.equal(referral.requisition_title, 'Senior Platform Engineer');
  assert.equal(referral.requisition_id, req.id);
  assert.equal(referral.can_edit, true);
  assert.equal(referral.can_withdraw, true);
  assert.equal(referral.can_process, false);

  const own = call(f, employee, 'GET', 'referrals');
  assert.equal(own.length, 1);
  assert.equal(own[0].requisition_title, 'Senior Platform Engineer');
  assert.equal(own[0].status, 'Submitted');
  assert.equal(call(f, employee, 'GET', `referrals/${referral.id}`).email, 'ref.candidate@example.com');

  assert.equal(call(f, colleague, 'GET', 'referrals').length, 0);
  assert.throws(() => call(f, colleague, 'GET', `referrals/${referral.id}`), e => e.status === 404);
  assert.throws(() => call(f, colleague, 'PUT', `referrals/${referral.id}`, { note: 'Hijack' }), e => e.status === 404);

  const recruiterView = call(f, f.recruiter, 'GET', 'referrals');
  assert.equal(recruiterView.length, 1);
  assert.equal(recruiterView[0].can_process, true);
  assert.equal(recruiterView[0].referrer_name, employee.name);

  assert.equal(call(f, salesRecruiter, 'GET', 'referrals').length, 0);
  assert.throws(() => call(f, salesRecruiter, 'GET', `referrals/${referral.id}`), e => e.status === 404);
  assert.throws(() => call(f, salesRecruiter, 'POST', `referrals/${referral.id}/process`, {}), e => e.status === 404);

  const adminView = call(f, f.admin, 'GET', 'referrals');
  assert.ok(adminView.some(r => r.id === referral.id));
  f.db.close();
});

test('legacy referrals without a requisition remain readable as Not linked and can be edited', () => {
  const f = fixture();
  const employee = user(f.db, 'Employee/Referral', 'Engineering');
  const rid = id();
  f.db.prepare('INSERT INTO referrals(id,name,email,requisition_id,note,created_by,at,status) VALUES(?,?,?,NULL,?,?,?,?)')
    .run(rid, 'Legacy Referral', 'legacy@example.com', 'Imported before requisitions were mandatory.', employee.id, now(), 'Submitted');

  const list = call(f, employee, 'GET', 'referrals');
  assert.equal(list.length, 1);
  assert.equal(list[0].requisition_id, null);
  assert.equal(list[0].requisition_title, null);
  assert.equal(list[0].status, 'Submitted');
  assert.equal(list[0].can_edit, true);
  assert.equal(list[0].can_process, false);

  const req = openRequisition(f);
  const updated = call(f, employee, 'PUT', `referrals/${rid}`, { requisition_id: req.id, note: 'Linked during cleanup.' });
  assert.equal(updated.requisition_id, req.id);
  assert.equal(updated.requisition_title, reqBody.title);
  f.db.close();
});

test('processing reuses the original referrer and never duplicates candidates or applications', () => {
  const f = fixture();
  const req = openRequisition(f);
  const employee = user(f.db, 'Employee/Referral', 'Engineering');
  const referral = call(f, employee, 'POST', 'referrals', referralBody(req, 'reuse.me@example.com'));

  const first = call(f, f.recruiter, 'POST', `referrals/${referral.id}/process`, {});
  assert.equal(first.candidate_created, true);
  assert.equal(first.application_created, true);
  assert.equal(first.status, 'Applied');
  assert.equal(first.created_by, employee.id);
  assert.equal(f.db.prepare('SELECT count(*) n FROM candidates WHERE email=?').get('reuse.me@example.com').n, 1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM applications WHERE requisition_id=?').get(req.id).n, 1);

  const second = call(f, f.recruiter, 'POST', `referrals/${referral.id}/process`, {});
  assert.equal(second.already_processed, true);
  assert.equal(f.db.prepare('SELECT count(*) n FROM candidates WHERE email=?').get('reuse.me@example.com').n, 1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM applications WHERE requisition_id=?').get(req.id).n, 1);

  call(f, f.recruiter, 'POST', `applications/${first.application_id}/stage`, { stage: 'Screening' });
  call(f, f.recruiter, 'POST', `applications/${first.application_id}/stage`, { stage: 'Interview' });
  const detail = call(f, employee, 'GET', `referrals/${referral.id}`);
  assert.equal(detail.status, 'Interview');
  assert.equal(detail.requisition_application_stage, 'Interview');
  assert.equal(call(f, employee, 'GET', 'referrals')[0].status, 'Interview');
  assert.equal(f.db.prepare('SELECT status FROM referrals WHERE id=?').get(referral.id).status, 'Interview');
  f.db.close();
});

test('processing reuses an existing candidate with the same email', () => {
  const f = fixture();
  const req = openRequisition(f);
  const employee = user(f.db, 'Employee/Referral', 'Engineering');
  const existing = call(f, f.recruiter, 'POST', 'candidates', {
    name: 'Existing Candidate', email: 'existing@example.com', team: 'Engineering', phone: '', skills: ['SQL'], resume_text: '', source: 'Direct'
  });
  const referral = call(f, employee, 'POST', 'referrals', { ...referralBody(req, 'existing@example.com'), name: 'Existing Candidate' });

  const processed = call(f, f.recruiter, 'POST', `referrals/${referral.id}/process`, {});
  assert.equal(processed.candidate_created, false);
  assert.equal(processed.application_created, true);
  assert.equal(processed.candidate_id, existing.id);
  assert.equal(f.db.prepare('SELECT count(*) n FROM candidates WHERE email=?').get('existing@example.com').n, 1);
  f.db.close();
});

test('employees can withdraw eligible referrals but not after the application reaches an ineligible stage', () => {
  const f = fixture();
  const req = openRequisition(f);
  const employee = user(f.db, 'Employee/Referral', 'Engineering');
  const colleague = user(f.db, 'Employee/Referral', 'Engineering');

  const eligible = call(f, employee, 'POST', 'referrals', referralBody(req, 'withdraw.eligible@example.com'));
  assert.throws(() => call(f, colleague, 'POST', `referrals/${eligible.id}/withdraw`, {}), e => e.status === 404);
  const withdrawn = call(f, employee, 'POST', `referrals/${eligible.id}/withdraw`, {});
  assert.equal(withdrawn.status, 'Withdrawn');
  assert.ok(withdrawn.withdrawn_at);
  assert.equal(withdrawn.can_edit, false);
  assert.equal(withdrawn.can_delete, false);
  assert.ok(f.db.prepare("SELECT id FROM audit WHERE event='referral.withdrawn' AND target=?").get(eligible.id));
  assert.throws(() => call(f, employee, 'POST', `referrals/${eligible.id}/withdraw`, {}), e => e.status === 409);

  const linked = call(f, employee, 'POST', 'referrals', referralBody(req, 'withdraw.linked@example.com'));
  const processed = call(f, f.recruiter, 'POST', `referrals/${linked.id}/process`, {});
  call(f, f.recruiter, 'POST', `applications/${processed.application_id}/stage`, { stage: 'Screening' });
  call(f, f.recruiter, 'POST', `applications/${processed.application_id}/stage`, { stage: 'Interview' });
  assert.throws(() => call(f, employee, 'POST', `referrals/${linked.id}/withdraw`, {}), e => e.status === 409 && /Interview stage/.test(e.message));
  assert.equal(f.db.prepare('SELECT stage FROM applications WHERE id=?').get(processed.application_id).stage, 'Interview');
  assert.ok(f.db.prepare('SELECT id FROM candidates WHERE id=?').get(processed.candidate_id));
  f.db.close();
});

test('referral editing follows ownership, team scope and workflow stage', () => {
  const f = fixture();
  const req = openRequisition(f);
  const employee = user(f.db, 'Employee/Referral', 'Engineering');
  const colleague = user(f.db, 'Employee/Referral', 'Engineering');
  const salesRecruiter = user(f.db, 'Recruiter', 'Sales');
  const referral = call(f, employee, 'POST', 'referrals', referralBody(req, 'editable@example.com'));

  const edited = call(f, employee, 'PUT', `referrals/${referral.id}`, { name: 'Referral Candidate Revised', note: 'Updated context.' });
  assert.equal(edited.name, 'Referral Candidate Revised');
  assert.equal(edited.note, 'Updated context.');
  assert.equal(edited.created_by, employee.id);
  assert.throws(() => call(f, colleague, 'PUT', `referrals/${referral.id}`, { note: 'No access' }), e => e.status === 404);
  assert.throws(() => call(f, salesRecruiter, 'PUT', `referrals/${referral.id}`, { note: 'No access' }), e => e.status === 404);

  const processed = call(f, f.recruiter, 'POST', `referrals/${referral.id}/process`, {});
  assert.throws(() => call(f, employee, 'PUT', `referrals/${referral.id}`, { email: 'changed@example.com' }), e => e.status === 409);
  call(f, f.recruiter, 'POST', `applications/${processed.application_id}/stage`, { stage: 'Screening' });
  call(f, f.recruiter, 'POST', `applications/${processed.application_id}/stage`, { stage: 'Interview' });
  assert.throws(() => call(f, employee, 'PUT', `referrals/${referral.id}`, { note: 'Too late' }), e => e.status === 403);
  const recruiterEdited = call(f, f.recruiter, 'PUT', `referrals/${referral.id}`, { note: 'Recruiter reviewed.' });
  assert.equal(recruiterEdited.note, 'Recruiter reviewed.');
  f.db.close();
});

test('referral soft deletion is audited and blocked by linked candidates/applications or withdrawal', () => {
  const f = fixture();
  const req = openRequisition(f);
  const employee = user(f.db, 'Employee/Referral', 'Engineering');

  const deletable = call(f, employee, 'POST', 'referrals', referralBody(req, 'delete.eligible@example.com'));
  const deleted = call(f, employee, 'DELETE', `referrals/${deletable.id}`);
  assert.equal(deleted.ok, true);
  assert.equal(call(f, employee, 'GET', 'referrals').length, 0);
  assert.ok(f.db.prepare('SELECT deleted_at FROM referrals WHERE id=?').get(deletable.id).deleted_at);
  assert.ok(f.db.prepare("SELECT id FROM audit WHERE event='referral.deleted' AND target=?").get(deletable.id));
  assert.throws(() => call(f, employee, 'GET', `referrals/${deletable.id}`), e => e.status === 404);

  const linked = call(f, employee, 'POST', 'referrals', referralBody(req, 'delete.linked@example.com'));
  call(f, f.recruiter, 'POST', `referrals/${linked.id}/process`, {});
  assert.throws(() => call(f, f.recruiter, 'DELETE', `referrals/${linked.id}`), e => e.status === 409 && /linked/.test(e.message));
  assert.ok(f.db.prepare('SELECT id FROM referrals WHERE id=?').get(linked.id));

  const withdrawn = call(f, employee, 'POST', 'referrals', referralBody(req, 'delete.withdrawn@example.com'));
  call(f, employee, 'POST', `referrals/${withdrawn.id}/withdraw`, {});
  assert.throws(() => call(f, employee, 'DELETE', `referrals/${withdrawn.id}`), e => e.status === 409 && /retained for history/.test(e.message));
  f.db.close();
});

test('candidate soft deletion is audited and blocked when applications exist', () => {
  const f = fixture();
  const standAlone = call(f, f.recruiter, 'POST', 'candidates', {
    name: 'Stand Alone', email: 'standalone@example.com', team: 'Engineering', phone: '', skills: [], resume_text: '', source: 'Direct'
  });
  const deleted = call(f, f.recruiter, 'DELETE', `candidates/${standAlone.id}`);
  assert.equal(deleted.ok, true);
  assert.ok(f.db.prepare('SELECT deleted_at FROM candidates WHERE id=?').get(standAlone.id).deleted_at);
  assert.ok(f.db.prepare("SELECT id FROM audit WHERE event='candidate.deleted' AND target=?").get(standAlone.id));
  assert.ok(!call(f, f.recruiter, 'GET', 'candidates').some(c => c.id === standAlone.id));

  const req = openRequisition(f);
  const candidate = call(f, f.recruiter, 'POST', 'candidates', {
    name: 'Applied Candidate', email: 'applied@example.com', team: 'Engineering', phone: '', skills: [], resume_text: '', source: 'Direct'
  });
  call(f, f.recruiter, 'POST', 'applications', { candidate_id: candidate.id, requisition_id: req.id });
  assert.throws(() => call(f, f.recruiter, 'DELETE', `candidates/${candidate.id}`), e => e.status === 409 && /application/.test(e.message));
  assert.ok(f.db.prepare('SELECT id FROM candidates WHERE id=?').get(candidate.id));
  f.db.close();
});

test('requisition soft deletion is audited and blocked by applications, referrals and approvals', () => {
  const f = fixture();
  const draft = call(f, f.recruiter, 'POST', 'requisitions', { ...reqBody, title: 'Deletable Draft' });
  const deleted = call(f, f.recruiter, 'DELETE', `requisitions/${draft.id}`);
  assert.equal(deleted.ok, true);
  assert.ok(f.db.prepare('SELECT deleted_at FROM requisitions WHERE id=?').get(draft.id).deleted_at);
  assert.ok(f.db.prepare("SELECT id FROM audit WHERE event='requisition.deleted' AND target=?").get(draft.id));
  assert.ok(!call(f, f.recruiter, 'GET', 'requisitions').some(r => r.id === draft.id));

  const approved = openRequisition(f, 'Approval Protected');
  assert.throws(() => call(f, f.recruiter, 'DELETE', `requisitions/${approved.id}`), e => e.status === 409 && /approval/.test(e.message));
  assert.ok(f.db.prepare('SELECT id FROM requisitions WHERE id=?').get(approved.id));

  const employee = user(f.db, 'Employee/Referral', 'Engineering');
  const referred = openRequisition(f, 'Referral Protected');
  call(f, employee, 'POST', 'referrals', referralBody(referred, 'req.protected@example.com'));
  assert.throws(() => call(f, f.recruiter, 'DELETE', `requisitions/${referred.id}`), e => e.status === 409 && /referral/.test(e.message));
  f.db.close();
});
