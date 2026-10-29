import { id, now, audit, transaction } from './db.js';
import { HttpError, roles, teams, text, normalizeTeamName } from './policy.js';

export const DEMO_ROLES = [
  { role: 'System Admin', title: 'System Administrator', description: 'Full access to all modules, users, themes, and settings across the organization.' },
  { role: 'TA Director', title: 'Talent Acquisition Director', description: 'Organization-wide recruitment, approvals, pipeline management, and talent analytics.' },
  { role: 'TA Manager', title: 'Talent Acquisition Manager', description: 'Team-level recruitment management, requisition approvals, and pipeline velocity.' },
  { role: 'Recruiter', title: 'Recruiter', description: 'Manages candidate pipeline, plans interviews, updates applications, and sources talent.' },
  { role: 'Hiring Manager', title: 'Hiring Manager', description: 'Creates and approves requisitions, reviews candidates, and makes hiring decisions.' },
  { role: 'Interviewer', title: 'Interviewer', description: 'Conducts assigned interviews and submits structured scorecard ratings.' },
  { role: 'Finance Approver', title: 'Finance Approver', description: 'Reviews and approves requisition headcount and compensation packages.' },
  { role: 'Employee/Referral', title: 'Employee / Referral', description: 'Submits candidate referrals for open positions and tracks personal referral status.' },
  { role: 'Agency', title: 'Agency Partner', description: 'External agency interface with restricted internal ATS access.' }
];

export const DEMO_TEAMS = [...teams];

export function isDemoUser(user) {
  if (!user) return false;
  return Boolean(
    (user.email && user.email.toLowerCase().endsWith('@orbit.local')) ||
    (user.oid && user.oid.startsWith('demo-oid-')) ||
    user.tenant === 'demo-tenant'
  );
}

export function validateDemoRoleAndTeam(role, team = '') {
  if (!roles.includes(role)) {
    throw new HttpError(400, 'Select a supported role.');
  }
  const isOrgRole = ['System Admin', 'TA Director', 'Finance Approver'].includes(role);
  if (isOrgRole && (!team || team === 'Organization')) {
    return { role, team: '' };
  }
  if (!team || !String(team).trim()) {
    throw new HttpError(400, 'Team is required for this role.');
  }
  const cleanTeam = normalizeTeamName(text(team, 'Team', 100, false));
  if (!teams.includes(cleanTeam)) {
    throw new HttpError(400, 'Select a supported team.');
  }
  return { role, team: cleanTeam };
}

export function getOrCreateDemoUser(db, c, inputRole, inputTeam = '') {
  const { role, team } = validateDemoRoleAndTeam(inputRole, inputTeam);
  const roleSlug = role.toLowerCase().replace(/[^a-z0-9]/g, '_');
  const teamSlug = team ? team.toLowerCase().replace(/[^a-z0-9]/g, '_') : 'org';
  const email = `demo.${roleSlug}.${teamSlug}@orbit.local`;
  const oid = `demo-oid-${roleSlug}-${teamSlug}`;
  const tenant = c?.tenant || 'demo-tenant';

  const baseNames = {
    'System Admin': 'Morgan Ellis (Demo Admin)',
    'TA Director': 'Elena Vance (Demo TA Director)',
    'TA Manager': 'Marcus Thorne (Demo TA Manager)',
    'Recruiter': 'Riley Brooks (Demo Recruiter)',
    'Hiring Manager': 'Jordan Lee (Demo Hiring Manager)',
    'Interviewer': 'Devon Chen (Demo Interviewer)',
    'Finance Approver': 'Taylor Quinn (Demo Finance)',
    'Employee/Referral': 'Casey Morgan (Demo Employee)',
    'Agency': 'Alex Taylor (Demo Agency)'
  };
  const name = `${baseNames[role] || `Demo ${role}`} · ${team || 'Organization'}`;

  return transaction(db, () => {
    let user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if (!user) {
      const uid = id();
      db.prepare(
        'INSERT INTO users(id,email,name,oid,tenant,role,team,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)'
      ).run(uid, email, name, oid, tenant, role, team, 'active', now());
      user = db.prepare('SELECT * FROM users WHERE id=?').get(uid);
    } else if (user.role !== role || user.team !== team || user.status !== 'active') {
      db.prepare("UPDATE users SET role=?, team=?, status='active' WHERE id=?").run(role, team, user.id);
      user = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
    }

    ensureRoleSampleData(db, user);
    return user;
  });
}

function getOrCreateSampleRecruiter(db, team, tenant = 'demo-tenant') {
  const userTeam = team || 'Dev';
  let recruiter = db.prepare("SELECT * FROM users WHERE role='Recruiter' AND team=?").get(userTeam);
  if (!recruiter) {
    const recId = id();
    const teamSlug = userTeam.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const email = `demo.recruiter.${teamSlug}@orbit.local`;
    const name = `Riley Brooks (Demo Recruiter) · ${userTeam}`;
    const oid = `demo-oid-recruiter-${teamSlug}`;
    db.prepare(
      'INSERT INTO users(id,email,name,oid,tenant,role,team,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)'
    ).run(recId, email, name, oid, tenant, 'Recruiter', userTeam, 'active', now());
    recruiter = db.prepare('SELECT * FROM users WHERE id=?').get(recId);
  }
  return recruiter;
}

function getOrCreateSampleManager(db, team, tenant = 'demo-tenant') {
  const userTeam = team || 'Dev';
  let manager = db.prepare("SELECT * FROM users WHERE role IN ('TA Manager', 'Hiring Manager') AND team=?").get(userTeam);
  if (!manager) {
    const mgrId = id();
    const teamSlug = userTeam.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const email = `demo.ta_manager.${teamSlug}@orbit.local`;
    const name = `Marcus Thorne (Demo TA Manager) · ${userTeam}`;
    const oid = `demo-oid-ta_manager-${teamSlug}`;
    db.prepare(
      'INSERT INTO users(id,email,name,oid,tenant,role,team,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)'
    ).run(mgrId, email, name, oid, tenant, 'TA Manager', userTeam, 'active', now());
    manager = db.prepare('SELECT * FROM users WHERE id=?').get(mgrId);
  }
  return manager;
}

function ensureRoleSampleData(db, user) {
  const userTeam = user.team || 'Dev';

  if (user.role === 'Interviewer') {
    const existing = db.prepare('SELECT id FROM interviews WHERE interviewer_id=?').get(user.id);
    if (!existing) {
      const app = db.prepare(`
        SELECT a.id FROM applications a
        JOIN requisitions r ON r.id=a.requisition_id
        WHERE r.team=? AND a.stage NOT IN ('Hired','Rejected')
        LIMIT 1
      `).get(userTeam);
      if (app) {
        const iid = id();
        const tomorrow = new Date(Date.now() + 86400000).toISOString();
        db.prepare(
          'INSERT INTO interviews(id,application_id,interviewer_id,scheduled_at,competencies,created_at) VALUES(?,?,?,?,?,?)'
        ).run(iid, app.id, user.id, tomorrow, JSON.stringify(['Problem solving', 'Communication']), now());
      }
    }
  }

  if (['Hiring Manager', 'TA Manager'].includes(user.role)) {
    const pendingReq = db.prepare("SELECT id FROM requisitions WHERE team=? AND status='pending_manager'").get(userTeam);
    if (!pendingReq) {
      const count = db.prepare('SELECT count(*) n FROM requisitions WHERE team=?').get(userTeam).n;
      if (count < 6) {
        const recruiter = getOrCreateSampleRecruiter(db, userTeam, user.tenant);
        const rid = id();
        db.prepare(`
          INSERT INTO requisitions(id,title,team,headcount,salary_min,salary_max,currency,description,skills,status,created_by,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(
          rid,
          'Senior Backend Engineer',
          userTeam,
          1,
          95000,
          135000,
          'USD',
          'Design distributed microservices.',
          JSON.stringify(['Go', 'Kubernetes']),
          'pending_manager',
          recruiter.id,
          now()
        );
        db.prepare('INSERT OR IGNORE INTO approvals VALUES(?,?,?,?,?,?,?)')
          .run(id(), rid, recruiter.id, 'requester', 'approved', 'Requisition submitted for approval.', now());
      }
    }
  }

  if (user.role === 'Finance Approver') {
    const pendingFinance = db.prepare("SELECT id FROM requisitions WHERE status='pending_finance'").get();
    if (!pendingFinance) {
      const recruiter = getOrCreateSampleRecruiter(db, userTeam, user.tenant);
      const manager = getOrCreateSampleManager(db, userTeam, user.tenant);
      const rid = id();
      db.prepare(`
        INSERT INTO requisitions(id,title,team,headcount,salary_min,salary_max,currency,description,skills,status,created_by,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        rid,
        'Principal Infrastructure Architect',
        userTeam,
        1,
        140000,
        190000,
        'USD',
        'Lead core cloud architecture and budget planning.',
        JSON.stringify(['Cloud', 'Architecture']),
        'pending_finance',
        recruiter.id,
        now()
      );
      db.prepare('INSERT OR IGNORE INTO approvals VALUES(?,?,?,?,?,?,?)')
        .run(id(), rid, recruiter.id, 'requester', 'approved', 'Submitted for approvals.', now());
      db.prepare('INSERT OR IGNORE INTO approvals VALUES(?,?,?,?,?,?,?)')
        .run(id(), rid, manager.id, 'manager', 'approved', 'Manager approved.', now());
    }
  }

  if (['Agency', 'Agency Admin', 'Agency Recruiter'].includes(user.role)) {
    let agency = db.prepare("SELECT * FROM agencies WHERE code='APEX'").get();
    const nowStr = now();
    if (!agency) {
      const aid = id();
      db.prepare(`
        INSERT INTO agencies(id, name, code, contact_name, contact_email, contact_phone, status, notes, created_at, updated_at)
        VALUES(?, 'Apex Talent Partners', 'APEX', 'Alex Taylor', 'alex@apex-talent.example.com', '+1-555-0199', 'active', 'Tier 1 external engineering talent agency', ?, ?)
      `).run(aid, nowStr, nowStr);
      agency = db.prepare('SELECT * FROM agencies WHERE id=?').get(aid);
    }

    const member = db.prepare('SELECT * FROM agency_members WHERE user_id=?').get(user.id);
    if (!member) {
      db.prepare(`
        INSERT INTO agency_members(id, agency_id, user_id, role, status, created_at, updated_at)
        VALUES(?, ?, ?, 'Agency Admin', 'active', ?, ?)
      `).run(id(), agency.id, user.id, nowStr, nowStr);
    }

    const openReq = db.prepare("SELECT id FROM requisitions WHERE status='open' LIMIT 1").get();
    if (openReq) {
      const assigned = db.prepare('SELECT id FROM agency_requisitions WHERE agency_id=? AND requisition_id=?').get(agency.id, openReq.id);
      if (!assigned) {
        db.prepare(`
          INSERT INTO agency_requisitions(id, agency_id, requisition_id, assigned_by, status, instructions, deadline, created_at, updated_at)
          VALUES(?, ?, ?, ?, 'active', 'Focus on senior candidates with strong systems fundamentals.', datetime('now', '+14 days'), ?, ?)
        `).run(id(), agency.id, openReq.id, user.id, nowStr, nowStr);
      }
    }
  }
}
