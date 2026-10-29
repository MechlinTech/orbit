import test from 'node:test';
import assert from 'node:assert/strict';
import { service } from '../src/service.js';
import { fixture, user } from './helpers.js';

const call = (f, u, method, path, body) => service(f.db, u, method, path, body);
const active = (f, id) => f.db.prepare('SELECT * FROM users WHERE id=?').get(id);
const denied = (fn) => assert.throws(fn, error => error.status === 403);

function assign(f, person, roleName, team = 'QA') {
  call(f, f.admin, 'POST', `admin/users/${person.id}/update`, { role: roleName, team });
  return active(f, person.id);
}

test('custom roles expose only the modules named in their saved grants', () => {
  const f = fixture();
  const hrRole = call(f, f.admin, 'POST', 'admin/roles', {
    name: 'HR',
    description: 'Candidate records only.',
    scope: 'team',
    permissions: ['candidates.read', 'candidates.update']
  });
  const qaRole = call(f, f.admin, 'POST', 'admin/roles', {
    name: 'QA',
    description: 'Assigned interviews only.',
    scope: 'team',
    permissions: ['interviews.read', 'interviews.evaluate']
  });
  const developerRole = call(f, f.admin, 'POST', 'admin/roles', {
    name: 'Developer',
    description: 'Open jobs only.',
    scope: 'team',
    permissions: ['jobs.read']
  });

  const hr = assign(f, user(f.db, 'Employee/Referral', 'HR'), hrRole.name, 'HR');
  const qa = assign(f, user(f.db, 'Employee/Referral', 'QA'), qaRole.name, 'QA');
  const developer = assign(f, user(f.db, 'Employee/Referral', 'Dev'), developerRole.name, 'Dev');
  const untouched = user(f.db, 'Employee/Referral', 'HR');

  assert.doesNotThrow(() => call(f, hr, 'GET', 'candidates'));
  for (const path of ['requisitions', 'applications', 'interviews', 'referrals', 'agencies', 'offer-templates', 'training-plans/templates', 'analytics', 'admin/users', 'admin/audit']) {
    denied(() => call(f, hr, 'GET', path));
  }

  assert.doesNotThrow(() => call(f, qa, 'GET', 'interviews'));
  denied(() => call(f, qa, 'GET', 'candidates'));
  denied(() => call(f, qa, 'GET', 'training-plans/templates'));
  denied(() => call(f, qa, 'GET', 'admin/roles'));

  assert.doesNotThrow(() => call(f, developer, 'GET', 'requisitions'));
  denied(() => call(f, developer, 'GET', 'candidates'));
  denied(() => call(f, developer, 'GET', 'interviews'));

  denied(() => call(f, untouched, 'GET', 'candidates'));
  assert.doesNotThrow(() => call(f, f.recruiter, 'GET', 'training-plans/templates'));
  denied(() => call(f, f.interviewer, 'GET', 'training-plans/templates'));
  f.db.close();
});

test('role permission changes apply on the next request and only to members of that role', () => {
  const f = fixture();
  const role = call(f, f.admin, 'POST', 'admin/roles', {
    name: 'Pipeline reader',
    scope: 'team',
    permissions: ['applications.read']
  });
  const member = assign(f, user(f.db, 'Employee/Referral', 'Engineering'), role.name, 'Engineering');
  const colleague = assign(f, user(f.db, 'Employee/Referral', 'Engineering'), 'Employee/Referral', 'Engineering');

  denied(() => call(f, member, 'GET', 'interviews'));
  const granted = call(f, f.admin, 'PUT', `admin/roles/${role.id}`, {
    version: role.version,
    permissions: ['applications.read', 'interviews.read']
  });
  assert.doesNotThrow(() => call(f, member, 'GET', 'interviews'));
  denied(() => call(f, colleague, 'GET', 'interviews'));

  call(f, f.admin, 'PUT', `admin/roles/${role.id}`, {
    version: granted.version,
    permissions: ['applications.read']
  });
  denied(() => call(f, member, 'GET', 'interviews'));

  const switched = assign(f, member, 'Recruiter', 'Engineering');
  assert.equal(switched.role, 'Recruiter');
  assert.doesNotThrow(() => call(f, switched, 'GET', 'agencies'));
  denied(() => call(f, colleague, 'GET', 'agencies'));
  f.db.close();
});

test('a grant for one module does not authorize a different module through a derived capability', () => {
  const f = fixture();
  call(f, f.admin, 'POST', 'admin/roles', {
    name: 'Candidate viewer',
    scope: 'organization',
    permissions: ['candidates.read']
  });
  const viewer = assign(f, user(f.db, 'Employee/Referral'), 'Candidate viewer', 'Engineering');
  denied(() => call(f, viewer, 'GET', 'offer-templates'));
  denied(() => call(f, viewer, 'GET', 'training-plans/templates'));
  denied(() => call(f, viewer, 'GET', 'agencies'));
  denied(() => call(f, viewer, 'POST', 'training-plans/templates', { name: 'Unauthorized', subject: 'No' }));
  f.db.close();
});
