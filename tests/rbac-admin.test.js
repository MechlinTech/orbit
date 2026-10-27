import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { service } from '../src/service.js';
import { openDb } from '../src/db.js';
import { permissionsForRole, roleByName } from '../src/rbac.js';
import { fixture, user, reqBody, candidateBody } from './helpers.js';

const call = (f, u, method, path, body) => service(f.db, u, method, path, body);
const activeUser = (f, id) => f.db.prepare('SELECT * FROM users WHERE id=?').get(id);

test('custom roles persist, scope records, redact fields and revoke immediately', () => {
  const f = fixture();
  const role = call(f, f.admin, 'POST', 'admin/roles', {
    name: 'Sourcing Specialist',
    description: 'Reviews candidates but cannot edit or create them.',
    scope: 'team',
    permissions: ['jobs.read', 'requisitions.read', 'candidates.read', 'candidates.personal.read', 'candidates.communications.read', 'offers.templates.read', 'signatures.read', 'integrations.read']
  });
  assert.equal(role.is_system, false);
  assert.equal(role.permission_count, 8);

  const target = user(f.db, 'Employee/Referral', 'Engineering');
  call(f, f.admin, 'POST', `admin/users/${target.id}/update`, { role: 'Sourcing Specialist', team: 'Engineering' });
  const sourcing = activeUser(f, target.id);
  assert.equal(sourcing.role_id, role.id);

  const req = call(f, f.recruiter, 'POST', 'requisitions', reqBody);
  const candidate = call(f, f.recruiter, 'POST', 'candidates', candidateBody);

  const candidates = call(f, sourcing, 'GET', 'candidates');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].email, candidate.email);
  const reqView = call(f, sourcing, 'GET', `requisitions/${req.id}`);
  assert.equal(reqView.salary_min, undefined, 'compensation must be omitted without field permission');
  assert.ok(Array.isArray(call(f, sourcing, 'GET', `candidates/${candidate.id}/communications`).communications));
  assert.ok(Array.isArray(call(f, sourcing, 'GET', 'offer-templates')));
  assert.ok(Array.isArray(call(f, sourcing, 'GET', 'signatures')));
  assert.equal(call(f, sourcing, 'GET', 'admin/integrations').length, 8);
  assert.throws(() => call(f, sourcing, 'PUT', 'admin/integrations/microsoft_calendar', { config: {} }), e => e.status === 403);

  assert.throws(() => call(f, sourcing, 'POST', 'candidates', { ...candidateBody, email: 'new@example.com' }), e => e.status === 403);

  const older = call(f, f.admin, 'PUT', `admin/roles/${role.id}`, { description: 'Updated description.', version: role.version });
  assert.equal(older.description, 'Updated description.');
  assert.equal(older.permission_count, 8, 'editing metadata must not drop permissions');

  // Removing candidates.read takes effect on the next request, with no session refresh.
  const updated = call(f, f.admin, 'PUT', `admin/roles/${role.id}`, {
    version: older.version,
    permissions: ['jobs.read', 'candidates.create']
  });
  assert.equal(updated.permission_count, 2);
  assert.throws(() => call(f, sourcing, 'GET', 'candidates'), e => e.status === 403);
  const created = call(f, sourcing, 'POST', 'candidates', { ...candidateBody, email: 'revoked.path@example.com' });
  assert.equal(created.team, 'Engineering');

  const events = f.db.prepare("SELECT event FROM audit WHERE event IN ('role.created','role.updated') ORDER BY id").all();
  assert.deepEqual(events.map(row => row.event), ['role.created', 'role.updated', 'role.updated']);
  f.db.close();
});

test('role management validates identifiers, scopes, duplicates and protected roles', () => {
  const f = fixture();
  assert.throws(() => call(f, f.admin, 'POST', 'admin/roles', {
    name: 'Bad permission role', scope: 'team', permissions: ['candidates.explode']
  }), e => e.status === 400);
  assert.throws(() => call(f, f.admin, 'POST', 'admin/roles', {
    name: 'Bad scope role', scope: 'world', permissions: ['candidates.read']
  }), e => e.status === 400);
  assert.throws(() => call(f, f.admin, 'POST', 'admin/roles', {
    name: 'Recruiter', scope: 'team', permissions: []
  }), e => e.status === 409);

  const adminRole = call(f, f.admin, 'GET', 'admin/roles').find(role => role.name === 'System Admin');
  assert.ok(adminRole.is_system);
  assert.throws(() => call(f, f.admin, 'PUT', `admin/roles/${adminRole.id}`, { description: 'weaker' }), e => e.status === 403);
  assert.throws(() => call(f, f.admin, 'DELETE', `admin/roles/${adminRole.id}`), e => e.status === 403);

  const custom = call(f, f.admin, 'POST', 'admin/roles', {
    name: 'Assigned reviewer', scope: 'team', permissions: ['candidates.read']
  });
  const target = user(f.db, 'Employee/Referral', 'Engineering');
  call(f, f.admin, 'POST', `admin/users/${target.id}/update`, { role: 'Assigned reviewer', team: 'Engineering' });
  assert.throws(() => call(f, f.admin, 'DELETE', `admin/roles/${custom.id}`), e => e.status === 409 && /assigned/.test(e.message));
  assert.throws(() => call(f, f.admin, 'PUT', `admin/roles/${custom.id}`, { description: 'No version' }), e => e.status === 400 && /version/.test(e.message));

  const duplicate = call(f, f.admin, 'POST', `admin/roles/${custom.id}/duplicate`, { name: 'Assigned reviewer copy' });
  assert.equal(duplicate.is_system, false);
  assert.deepEqual(duplicate.permissions, custom.permissions);
  f.db.close();
});

test('operational system role permissions can be customized, enforced and persisted', () => {
  const folder = mkdtempSync(join(tmpdir(), 'orbit-rbac-'));
  const path = join(folder, 'data.sqlite');
  try {
    let db = openDb(path);
    const admin = user(db, 'System Admin');
    const recruiterRole = roleByName(db, 'Recruiter');
    const recruiter = user(db, 'Recruiter', 'Engineering');
    const baseline = permissionsForRole(db, recruiterRole.id);
    assert.ok(!baseline.includes('users.read'));
    assert.throws(() => service(db, recruiter, 'GET', 'admin/users'), e => e.status === 403);

    const withDirectory = service(db, admin, 'PUT', `admin/roles/${recruiterRole.id}`, {
      version: recruiterRole.version,
      permissions: [...baseline, 'users.read']
    });
    assert.equal(withDirectory.is_system, true);
    assert.equal(withDirectory.permissions_customized, true);
    assert.equal(withDirectory.name, 'Recruiter');
    assert.equal(withDirectory.scope, 'team');
    assert.ok(withDirectory.permissions.includes('users.read'));
    const directoryMe = service(db, recruiter, 'GET', 'me');
    assert.ok(directoryMe.grants.includes('users.read'));
    assert.ok(service(db, recruiter, 'GET', 'admin/users').length >= 1);

    const assignedTarget = user(db, 'Employee/Referral', 'Engineering');
    service(db, admin, 'POST', `admin/users/${assignedTarget.id}/update`, { role: 'Recruiter', team: 'Engineering' });
    const assignedUser = db.prepare('SELECT * FROM users WHERE id=?').get(assignedTarget.id);
    assert.ok(service(db, assignedUser, 'GET', 'me').grants.includes('users.read'));
    assert.ok(service(db, assignedUser, 'GET', 'admin/users').length >= 1);

    const withoutDirectory = service(db, admin, 'PUT', `admin/roles/${recruiterRole.id}`, {
      version: withDirectory.version,
      permissions: baseline.filter(permission => permission !== 'analytics.read')
    });
    assert.ok(!withoutDirectory.permissions.includes('users.read'));
    assert.ok(!withoutDirectory.permissions.includes('analytics.read'));
    const reducedMe = service(db, recruiter, 'GET', 'me');
    assert.ok(!reducedMe.grants.includes('analytics.read'));
    assert.ok(!reducedMe.permissions.includes('analytics'), 'removed granular grants must also remove legacy capabilities');
    assert.throws(() => service(db, recruiter, 'GET', 'admin/users'), e => e.status === 403);

    assert.throws(() => service(db, admin, 'PUT', `admin/roles/${recruiterRole.id}`, {
      version: withoutDirectory.version,
      name: 'Renamed Recruiter',
      permissions: baseline
    }), e => e.status === 400 && /names, descriptions and record scopes are protected/.test(e.message));

    const adminRole = roleByName(db, 'System Admin');
    assert.throws(() => service(db, admin, 'PUT', `admin/roles/${adminRole.id}`, {
      version: adminRole.version,
      permissions: baseline
    }), e => e.status === 403 && /protected system role/.test(e.message));

    const persisted = service(db, admin, 'PUT', `admin/roles/${recruiterRole.id}`, {
      version: withoutDirectory.version,
      permissions: [...baseline, 'users.read']
    });
    assert.ok(persisted.permissions.includes('users.read'));
    db.close();

    db = openDb(path);
    const reloaded = roleByName(db, 'Recruiter');
    assert.equal(reloaded.permissions_customized, 1);
    assert.ok(permissionsForRole(db, reloaded.id).includes('users.read'), 'saved system role permissions must survive restart');
    db.close();
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('delegated role administrators cannot exceed their own authority', () => {
  const f = fixture();
  const delegateRole = call(f, f.admin, 'POST', 'admin/roles', {
    name: 'Access Coordinator',
    scope: 'team',
    permissions: ['users.read', 'users.update', 'roles.read', 'roles.create', 'roles.assign', 'candidates.read']
  });
  const coordinator = user(f.db, 'Employee/Referral', 'Engineering');
  const peer = user(f.db, 'Employee/Referral', 'Engineering');
  call(f, f.admin, 'POST', `admin/users/${coordinator.id}/update`, { role: 'Access Coordinator', team: 'Engineering' });
  const actor = activeUser(f, coordinator.id);

  assert.throws(() => call(f, actor, 'POST', 'admin/roles', {
    name: 'Escalated role', scope: 'team', permissions: ['candidates.delete']
  }), e => e.status === 403 && /beyond your own authority/.test(e.message));
  assert.throws(() => call(f, actor, 'POST', 'admin/roles', {
    name: 'Org wide role', scope: 'organization', permissions: ['candidates.read']
  }), e => e.status === 403 && /organization-wide/.test(e.message));
  assert.throws(() => call(f, actor, 'POST', `admin/users/${peer.id}/update`, { role: 'System Admin', team: '' }), e => e.status === 403);
  assert.throws(() => call(f, actor, 'POST', `admin/users/${peer.id}/update`, { role: 'Access Coordinator', team: 'Sales' }), e => e.status === 403 && /outside your team scope/.test(e.message));
  assert.throws(() => call(f, actor, 'POST', `admin/users/${actor.id}/update`, { role: 'Access Coordinator', team: 'Engineering' }), e => e.status === 409);

  const selfScoped = call(f, actor, 'POST', 'admin/roles', {
    name: 'Candidate reader delegate', scope: 'team', permissions: ['candidates.read']
  });
  assert.equal(selfScoped.permission_count, 1);
  f.db.close();
});

test('the last active administrator cannot be disabled', () => {
  const f = fixture();
  call(f, f.admin, 'POST', 'admin/roles', {
    name: 'User suspender', scope: 'team', permissions: ['users.read', 'users.deactivate']
  });
  const target = user(f.db, 'Employee/Referral', 'Engineering');
  call(f, f.admin, 'POST', `admin/users/${target.id}/update`, { role: 'User suspender', team: 'Engineering' });
  const actor = activeUser(f, target.id);
  assert.throws(
    () => call(f, actor, 'POST', `admin/users/${f.admin.id}/disable`, {}),
    e => e.status === 409 && /last administrator/i.test(e.message)
  );
  assert.equal(activeUser(f, f.admin.id).status, 'active');
  f.db.close();
});

test('granular action permissions work without broad module grants', async () => {
  const f = fixture();
  call(f, f.admin, 'POST', 'admin/roles', {
    name: 'Match reviewer', scope: 'team', permissions: ['applications.match', 'signatures.read']
  });
  const target = user(f.db, 'Employee/Referral', 'Engineering');
  call(f, f.admin, 'POST', `admin/users/${target.id}/update`, { role: 'Match reviewer', team: 'Engineering' });
  const reviewer = activeUser(f, target.id);

  const req = call(f, f.recruiter, 'POST', 'requisitions', reqBody);
  call(f, f.recruiter, 'POST', `requisitions/${req.id}/submit`, {});
  call(f, f.manager, 'POST', `requisitions/${req.id}/approve`, { note: 'Manager approved.' });
  call(f, f.finance, 'POST', `requisitions/${req.id}/approve`, { note: 'Finance approved.' });
  const candidate = call(f, f.recruiter, 'POST', 'candidates', candidateBody);
  const application = call(f, f.recruiter, 'POST', 'applications', {
    candidate_id: candidate.id, requisition_id: req.id
  });

  const match = call(f, reviewer, 'POST', `applications/${application.id}/match`, {});
  assert.ok(typeof match.score === 'number', 'applications.match must authorize its own route');
  assert.ok((match.evidence || []).every(entry => entry.snippet === undefined), 'resume snippets must stay hidden without resume permission');
  assert.throws(() => call(f, reviewer, 'GET', 'applications'), e => e.status === 403);

  const signature = await call(f, f.recruiter, 'POST', 'signatures', {
    title: 'Granular offer', candidate_id: candidate.id, salary: '123,000', currency: 'USD',
    signers: [{ name: candidate.name, email: candidate.email, role: 'Candidate' }]
  });
  const offers = call(f, reviewer, 'GET', `candidates/${candidate.id}/signatures`);
  const visible = offers.find(row => row.id === signature.id);
  assert.ok(visible);
  assert.equal(visible.salary, undefined, 'offer compensation must stay redacted on candidate offers');
  f.db.close();
});
