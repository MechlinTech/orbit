import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/server.js';
import { config, createSession } from '../src/auth.js';
import { fixture, testConfig, user } from './helpers.js';
import { DEMO_ROLES, DEMO_TEAMS, isDemoUser, validateDemoRoleAndTeam, getOrCreateDemoUser } from '../src/demo.js';
import { roles, teams } from '../src/policy.js';

async function createTestServer(t, customConfig = {}) {
  const f = fixture();
  const baseC = testConfig();
  const c = { ...baseC, ...customConfig };
  f.server = createApp({ db: f.db, c });
  f.server.listen(0, '127.0.0.1');
  await once(f.server, 'listening');
  f.url = `http://127.0.0.1:${f.server.address().port}`;
  f.c = c;
  t.after(async () => {
    await new Promise(r => f.server.close(r));
    f.db.close();
  });
  return f;
}

test('Demo config: enabled by default outside production and always disabled in production unless explicitly opted in', () => {
  const devConf = config({ APP_ORIGIN: 'http://localhost:3000', NODE_ENV: 'development' });
  assert.equal(devConf.demoLogin, true, 'Demo login should be enabled by default in non-production');

  const testConf = config({ APP_ORIGIN: 'http://localhost:3000', NODE_ENV: 'test' });
  assert.equal(testConf.demoLogin, true, 'Demo login should be enabled by default in test');

  const disabledDev = config({ APP_ORIGIN: 'http://localhost:3000', ENABLE_DEMO_LOGIN: 'false' });
  assert.equal(disabledDev.demoLogin, false, 'ENABLE_DEMO_LOGIN=false should disable demo login');

  const prodDefault = config({
    APP_ORIGIN: 'https://orbit.mechlin.com',
    NODE_ENV: 'production',
    ENTRA_TENANT_ID: '11111111-1111-1111-1111-111111111111',
    ENTRA_CLIENT_ID: '22222222-2222-2222-2222-222222222222',
    ENTRA_CLIENT_SECRET: 'prod-secret',
    ALLOWED_DOMAINS: 'mechlin.com'
  });
  assert.equal(prodDefault.demoLogin, false, 'Demo login must default to disabled in production');

  const prodExplicitDisabled = config({
    APP_ORIGIN: 'https://orbit.mechlin.com',
    NODE_ENV: 'production',
    ENTRA_TENANT_ID: '11111111-1111-1111-1111-111111111111',
    ENTRA_CLIENT_ID: '22222222-2222-2222-2222-222222222222',
    ENTRA_CLIENT_SECRET: 'prod-secret',
    ALLOWED_DOMAINS: 'mechlin.com',
    ENABLE_DEMO_LOGIN: 'false'
  });
  assert.equal(prodExplicitDisabled.demoLogin, false, 'ENABLE_DEMO_LOGIN=false disables demo login in production');

  const prodExplicitEnabled = config({
    APP_ORIGIN: 'https://orbit.mechlin.com',
    NODE_ENV: 'production',
    ENTRA_TENANT_ID: '11111111-1111-1111-1111-111111111111',
    ENTRA_CLIENT_ID: '22222222-2222-2222-2222-222222222222',
    ENTRA_CLIENT_SECRET: 'prod-secret',
    ALLOWED_DOMAINS: 'mechlin.com',
    ENABLE_DEMO_LOGIN: 'true'
  });
  assert.equal(prodExplicitEnabled.demoLogin, true, 'Production QA environments can explicitly opt in');
});

test('Demo roles and teams: only existing supported roles and teams are available', () => {
  for (const { role } of DEMO_ROLES) {
    assert.ok(roles.includes(role), `Demo role "${role}" must be defined in policy roles`);
  }
  for (const team of DEMO_TEAMS) {
    assert.ok(teams.includes(team), `Demo team "${team}" must be defined in policy teams`);
  }
});

test('Role/team validation: strictly validates inputs on server-side', () => {
  // Valid combinations
  assert.deepEqual(validateDemoRoleAndTeam('Recruiter', 'Dev'), { role: 'Recruiter', team: 'Dev' });
  assert.deepEqual(validateDemoRoleAndTeam('System Admin', ''), { role: 'System Admin', team: '' });
  assert.deepEqual(validateDemoRoleAndTeam('System Admin', 'Organization'), { role: 'System Admin', team: '' });
  assert.deepEqual(validateDemoRoleAndTeam('TA Director', ''), { role: 'TA Director', team: '' });

  // Invalid roles
  assert.throws(() => validateDemoRoleAndTeam('SuperUser', 'Dev'), /Select a supported role/);
  assert.throws(() => validateDemoRoleAndTeam('', 'Dev'), /Select a supported role/);
  assert.throws(() => validateDemoRoleAndTeam(null, 'Dev'), /Select a supported role/);

  // Invalid teams
  assert.throws(() => validateDemoRoleAndTeam('Recruiter', 'SecretHackingTeam'), /Select a supported team/);
  assert.throws(() => validateDemoRoleAndTeam('Recruiter', ''), /Team is required for this role/);
  assert.throws(() => validateDemoRoleAndTeam('Hiring Manager', ''), /Team is required for this role/);
});

test('HTTP GET /auth/demo: returns environment demo status, roles, and teams', async t => {
  const f = await createTestServer(t, { demoLogin: true });
  const res = await fetch(`${f.url}/auth/demo`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.demoLogin, true);
  assert.ok(Array.isArray(data.roles));
  assert.ok(data.roles.some(r => r.role === 'Recruiter'));
  assert.ok(Array.isArray(data.teams));
  assert.ok(data.teams.includes('Dev'));
  assert.ok(data.teams.includes('QA'));
});

test('HTTP POST /auth/demo-login: authenticates predefined demo user and establishes valid session', async t => {
  const f = await createTestServer(t, { demoLogin: true });
  const res = await fetch(`${f.url}/auth/demo-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: f.c.origin },
    body: JSON.stringify({ role: 'Recruiter', team: 'Dev' })
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.user.role, 'Recruiter');
  assert.equal(data.user.team, 'Dev');
  assert.ok(data.csrf);

  const cookie = res.headers.get('set-cookie');
  assert.ok(cookie && cookie.includes('session='));

  // Session can be used to query /api/me
  const meRes = await fetch(`${f.url}/api/me`, {
    headers: { Cookie: cookie.split(';')[0] }
  });
  assert.equal(meRes.status, 200);
  const meData = await meRes.json();
  assert.equal(meData.user.role, 'Recruiter');
  assert.equal(meData.user.team, 'Dev');
  assert.equal(meData.isDemoUser, true);
  assert.ok(meData.permissions.includes('recruit'));

  // Audit entry was created
  const auditEntry = f.db.prepare("SELECT * FROM audit WHERE event='auth.demo_login'").get();
  assert.ok(auditEntry);
  assert.deepEqual(JSON.parse(auditEntry.detail), { role: 'Recruiter', team: 'Dev' });
});

test('HTTP POST /auth/demo-login: rejects requests when demo login is disabled', async t => {
  const f = await createTestServer(t, { demoLogin: false });
  const res = await fetch(`${f.url}/auth/demo-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: f.c.origin },
    body: JSON.stringify({ role: 'Recruiter', team: 'Dev' })
  });
  assert.equal(res.status, 403);
  const data = await res.json();
  assert.match(data.error, /disabled/i);
});

test('HTTP POST /api/demo/switch: switches persona, revokes old session, creates new session and updates permissions', async t => {
  const f = await createTestServer(t, { demoLogin: true });

  // 1. Log in as Recruiter in Dev
  const loginRes = await fetch(`${f.url}/auth/demo-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: f.c.origin },
    body: JSON.stringify({ role: 'Recruiter', team: 'Dev' })
  });
  const loginData = await loginRes.json();
  const cookie1 = loginRes.headers.get('set-cookie').split(';')[0];
  const csrf1 = loginData.csrf;

  // 2. Switch to Hiring Manager in QA
  const switchRes = await fetch(`${f.url}/api/demo/switch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: f.c.origin,
      Cookie: cookie1,
      'X-CSRF-Token': csrf1
    },
    body: JSON.stringify({ role: 'Hiring Manager', team: 'QA' })
  });
  assert.equal(switchRes.status, 200);
  const switchData = await switchRes.json();
  assert.equal(switchData.ok, true);
  assert.equal(switchData.user.role, 'Hiring Manager');
  assert.equal(switchData.user.team, 'QA');
  assert.ok(switchData.csrf);

  const cookie2 = switchRes.headers.get('set-cookie').split(';')[0];

  // 3. Old session is revoked
  const oldMeRes = await fetch(`${f.url}/api/me`, {
    headers: { Cookie: cookie1 }
  });
  assert.equal(oldMeRes.status, 401, 'Old session token must be revoked after switch');

  // 4. New session is active with Hiring Manager permissions and QA team scope
  const newMeRes = await fetch(`${f.url}/api/me`, {
    headers: { Cookie: cookie2 }
  });
  assert.equal(newMeRes.status, 200);
  const newMeData = await newMeRes.json();
  assert.equal(newMeData.user.role, 'Hiring Manager');
  assert.equal(newMeData.user.team, 'QA');
  assert.ok(newMeData.permissions.includes('approve_manager'));
  assert.ok(!newMeData.permissions.includes('admin'), 'Hiring Manager must not have admin permission');

  // 5. Audit entry records transition
  const switchAudit = f.db.prepare("SELECT * FROM audit WHERE event='auth.demo_switch'").get();
  assert.ok(switchAudit);
  assert.deepEqual(JSON.parse(switchAudit.detail), {
    fromRole: 'Recruiter',
    fromTeam: 'Dev',
    toRole: 'Hiring Manager',
    toTeam: 'QA'
  });
});

test('Security: non-demo users cannot switch roles or escalate privileges via /api/demo/switch', async t => {
  const f = await createTestServer(t, { demoLogin: true });

  // Normal corporate user (e.g. Employee/Referral with official company email)
  const corporateUser = user(f.db, 'Employee/Referral', 'Dev');
  const session = createSession(f.db, corporateUser, f.c);
  const headers = {
    Cookie: `session=${session.value}`,
    Origin: f.c.origin,
    'X-CSRF-Token': session.csrf,
    'Content-Type': 'application/json'
  };

  // Attempt to escalate to System Admin
  const res = await fetch(`${f.url}/api/demo/switch`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ role: 'System Admin', team: '' })
  });
  assert.equal(res.status, 403, 'Non-demo user must be denied role switching');
  const data = await res.json();
  assert.match(data.error, /only permitted for demo users/i);

  // Verify corporate user still has original role and permissions
  const meRes = await fetch(`${f.url}/api/me`, { headers });
  assert.equal(meRes.status, 200);
  const meData = await meRes.json();
  assert.equal(meData.user.role, 'Employee/Referral');
  assert.ok(!meData.permissions.includes('admin'));
});

test('Security: invalid parameters and cross-site requests are rejected on demo endpoints', async t => {
  const f = await createTestServer(t, { demoLogin: true });

  // Missing/invalid role
  const badRoleRes = await fetch(`${f.url}/auth/demo-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: f.c.origin },
    body: JSON.stringify({ role: 'Hacker', team: 'Dev' })
  });
  assert.equal(badRoleRes.status, 400);

  // Missing/invalid team for role that requires it
  const badTeamRes = await fetch(`${f.url}/auth/demo-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: f.c.origin },
    body: JSON.stringify({ role: 'Recruiter', team: '' })
  });
  assert.equal(badTeamRes.status, 400);

  // Invalid origin
  const badOriginRes = await fetch(`${f.url}/auth/demo-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' },
    body: JSON.stringify({ role: 'Recruiter', team: 'Dev' })
  });
  assert.equal(badOriginRes.status, 403);
});

test('Idempotency: Repeated demo login reuses existing account without duplicate rows', async t => {
  const f = await createTestServer(t, { demoLogin: true });

  const u1 = getOrCreateDemoUser(f.db, f.c, 'Recruiter', 'Dev');
  const u2 = getOrCreateDemoUser(f.db, f.c, 'Recruiter', 'Dev');
  assert.equal(u1.id, u2.id, 'Repeated calls must return same user ID');

  const count = f.db.prepare("SELECT count(*) n FROM users WHERE email=?").get(u1.email).n;
  assert.equal(count, 1, 'Only one user record should exist for this demo identity');
});

test('HTML injection: index.html includes data-demo-login attribute only when enabled', async t => {
  const fEnabled = await createTestServer(t, { demoLogin: true });
  const htmlEnabled = await (await fetch(`${fEnabled.url}/`)).text();
  assert.match(htmlEnabled, /data-demo-login="true"/);

  const fDisabled = await createTestServer(t, { demoLogin: false });
  const htmlDisabled = await (await fetch(`${fDisabled.url}/`)).text();
  assert.doesNotMatch(htmlDisabled, /data-demo-login="true"/);
});

test('Demo sample data: TA Manager receives sample pending requisition and can review and approve it', async t => {
  const f = await createTestServer(t, { demoLogin: true });

  // Log in as TA Manager in Dev
  const loginRes = await fetch(`${f.url}/auth/demo-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: f.c.origin },
    body: JSON.stringify({ role: 'TA Manager', team: 'Dev' })
  });
  assert.equal(loginRes.status, 200);
  const loginData = await loginRes.json();
  const cookie = loginRes.headers.get('set-cookie').split(';')[0];
  const csrf = loginData.csrf;

  // TA Manager fetches requisitions
  const reqsRes = await fetch(`${f.url}/api/requisitions`, {
    headers: { Cookie: cookie }
  });
  assert.equal(reqsRes.status, 200);
  const reqs = await reqsRes.json();
  const pendingReq = reqs.find(r => r.status === 'pending_manager');
  assert.ok(pendingReq, 'Sample requisition in pending_manager status should exist for TA Manager');
  assert.equal(pendingReq.team, 'Dev');
  assert.notEqual(pendingReq.created_by, loginData.user.id, 'Creator must be distinct from approving TA Manager');

  // TA Manager reviews and approves the requisition
  const approveRes = await fetch(`${f.url}/api/requisitions/${pendingReq.id}/approve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: f.c.origin,
      Cookie: cookie,
      'X-CSRF-Token': csrf
    },
    body: JSON.stringify({ note: 'Looks good to proceed' })
  });
  assert.equal(approveRes.status, 200);
  const approveData = await approveRes.json();
  assert.equal(approveData.status, 'pending_finance');

  // Verify DB state
  const updatedReq = f.db.prepare('SELECT status FROM requisitions WHERE id=?').get(pendingReq.id);
  assert.equal(updatedReq.status, 'pending_finance');

  const approval = f.db.prepare("SELECT * FROM approvals WHERE requisition_id=? AND step='manager'").get(pendingReq.id);
  assert.ok(approval);
  assert.equal(approval.actor, loginData.user.id);
  assert.equal(approval.decision, 'approve');
});

