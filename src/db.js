import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { systemRoleDefinitions } from './policy.js';

export const id = () => randomUUID();
export const now = () => new Date().toISOString();

/**
 * Seed and reconcile the protected built-in roles. System roles are part of
 * the authorization boundary, so their definitions always follow the shipped
 * registry. Custom roles are never touched and existing user assignments are
 * preserved by matching the historical users.role name.
 */
function seedSystemRoles(db) {
  const timestamp = now();
  const selectRole = db.prepare('SELECT * FROM rbac_roles WHERE name=?');
  const insertRole = db.prepare(`INSERT INTO rbac_roles(id,name,description,scope,is_system,version,created_at,updated_at)
    VALUES(?,?,?,?,1,1,?,?)`);
  const updateDefinition = db.prepare('UPDATE rbac_roles SET description=?, scope=?, is_system=1 WHERE id=?');
  const clearPermissions = db.prepare('DELETE FROM rbac_role_permissions WHERE role_id=?');
  const insertPermission = db.prepare('INSERT OR IGNORE INTO rbac_role_permissions(role_id,permission) VALUES(?,?)');
  const assignExisting = db.prepare('UPDATE users SET role_id=? WHERE role_id IS NULL AND role=?');

  for (const [name, definition] of Object.entries(systemRoleDefinitions)) {
    let role = selectRole.get(name);
    if (!role) {
      const roleId = id();
      insertRole.run(roleId, name, definition.description, definition.scope, timestamp, timestamp);
      role = selectRole.get(name);
    } else {
      updateDefinition.run(definition.description, definition.scope, role.id);
    }
    // Reconcile shipped defaults only until an administrator customizes this
    // role. Once customized, saved grants must survive restarts and upgrades.
    if (!role.permissions_customized) {
      clearPermissions.run(role.id);
      for (const permission of definition.permissions) insertPermission.run(role.id, permission);
    }
    assignExisting.run(role.id, name);
  }
}

export function openDb(path = 'data/talentos.sqlite') {
  let db;
  try {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    db = new DatabaseSync(path);
  } catch (cause) {
    if (path === ':memory:') throw cause;
    // errcode 14 (SQLITE_CANTOPEN) in a container almost always means the
    // directory is not writable by this user, i.e. the Docker volume behind it
    // was created as root instead of by the app user.
    const detail = String(cause?.message ?? cause);
    const why = /unable to open database file|readonly database|EACCES|EPERM|EEXIST|ENOTDIR|EROFS/i.test(detail)
      ? `${detail} — check that the directory exists and is owned by uid 1000 (node); a root-owned Docker volume mounted at /app/data is the usual cause (fix: chown -R 1000:1000 <volume>:/app/data)`
      : detail;
    throw new Error(`Cannot open SQLite database at ${resolve(path)} (uid ${process.getuid?.() ?? 'n/a'}, gid ${process.getgid?.() ?? 'n/a'}): ${why}`, { cause });
  }
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users(
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
      oid TEXT UNIQUE, tenant TEXT, role TEXT NOT NULL DEFAULT 'Employee/Referral', team TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK(status IN ('pending','active','rejected','disabled')), version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, last_login TEXT);
    CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
      version INTEGER NOT NULL, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS oauth_states(state_hash TEXT PRIMARY KEY, verifier TEXT NOT NULL, nonce TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, event TEXT NOT NULL,
      target TEXT NOT NULL, detail TEXT NOT NULL, at TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'Audit is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'Audit is append-only'); END;
    CREATE TABLE IF NOT EXISTS requisitions(id TEXT PRIMARY KEY, title TEXT NOT NULL, team TEXT NOT NULL, headcount INTEGER NOT NULL CHECK(headcount>0),
      salary_min INTEGER NOT NULL, salary_max INTEGER NOT NULL, currency TEXT NOT NULL, description TEXT NOT NULL, skills TEXT NOT NULL,
      status TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY, requisition_id TEXT NOT NULL REFERENCES requisitions(id),
      actor TEXT NOT NULL REFERENCES users(id), step TEXT NOT NULL, decision TEXT NOT NULL, note TEXT NOT NULL, at TEXT NOT NULL,
      UNIQUE(requisition_id, step));
    CREATE TABLE IF NOT EXISTS candidates(id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      phone TEXT NOT NULL, skills TEXT NOT NULL, resume_text TEXT NOT NULL, source TEXT NOT NULL, team TEXT NOT NULL,
      created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS applications(id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL REFERENCES candidates(id),
      requisition_id TEXT NOT NULL REFERENCES requisitions(id), stage TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(candidate_id,requisition_id));
    CREATE TABLE IF NOT EXISTS stage_events(id TEXT PRIMARY KEY, application_id TEXT NOT NULL REFERENCES applications(id),
      from_stage TEXT NOT NULL, to_stage TEXT NOT NULL, actor TEXT NOT NULL REFERENCES users(id), at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS interviews(id TEXT PRIMARY KEY, application_id TEXT NOT NULL REFERENCES applications(id),
      interviewer_id TEXT NOT NULL REFERENCES users(id), scheduled_at TEXT NOT NULL, competencies TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'planned', created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS scorecards(id TEXT PRIMARY KEY, interview_id TEXT NOT NULL UNIQUE REFERENCES interviews(id),
      author TEXT NOT NULL REFERENCES users(id), ratings TEXT NOT NULL, recommendation TEXT NOT NULL, notes TEXT NOT NULL, submitted_at TEXT NOT NULL,
      proxy_for TEXT REFERENCES users(id), proxy_reason TEXT);
    CREATE TABLE IF NOT EXISTS referrals(id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL,
      requisition_id TEXT REFERENCES requisitions(id), note TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES users(id), at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Submitted', candidate_id TEXT REFERENCES candidates(id),
      application_id TEXT REFERENCES applications(id), withdrawn_at TEXT, withdrawn_by TEXT REFERENCES users(id),
      deleted_at TEXT, deleted_by TEXT REFERENCES users(id), updated_at TEXT);
    CREATE TABLE IF NOT EXISTS candidate_resumes(id TEXT PRIMARY KEY, candidate_id TEXT REFERENCES candidates(id),
      storage_id TEXT NOT NULL, filename TEXT NOT NULL, file_format TEXT NOT NULL, file_size INTEGER NOT NULL,
      mime_type TEXT NOT NULL, scan_status TEXT NOT NULL, extraction_status TEXT NOT NULL, error_message TEXT,
      uploaded_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_candidate_resumes_candidate ON candidate_resumes(candidate_id);
    CREATE TABLE IF NOT EXISTS candidate_communications(id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL REFERENCES candidates(id),
      requisition_id TEXT REFERENCES requisitions(id), channel TEXT NOT NULL DEFAULT 'email', template_id TEXT NOT NULL,
      recipient_email TEXT NOT NULL, subject TEXT NOT NULL, idempotency_key TEXT UNIQUE, provider_message_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('queued','accepted','delivered','bounced','failed')), error_message TEXT,
      metadata TEXT, sent_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_candidate_comms_candidate ON candidate_communications(candidate_id);
    CREATE INDEX IF NOT EXISTS idx_candidate_comms_provider_id ON candidate_communications(provider_message_id);
    CREATE TABLE IF NOT EXISTS communication_consents(candidate_id TEXT PRIMARY KEY REFERENCES candidates(id),
      opted_out INTEGER NOT NULL DEFAULT 0, opt_out_reason TEXT, updated_by TEXT NOT NULL REFERENCES users(id), updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS application_matches(
      id TEXT PRIMARY KEY, application_id TEXT NOT NULL REFERENCES applications(id), score INTEGER,
      matched_skills TEXT NOT NULL, missing_skills TEXT NOT NULL, experience_score INTEGER,
      method TEXT NOT NULL, explanation TEXT NOT NULL, breakdown TEXT, evidence TEXT, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_application_matches_app ON application_matches(application_id);
    CREATE TABLE IF NOT EXISTS fraud_reviews(
      id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL REFERENCES candidates(id), application_id TEXT REFERENCES applications(id),
      risk_level TEXT NOT NULL CHECK(risk_level IN ('low','medium','high')),
      status TEXT NOT NULL CHECK(status IN ('pending','reviewed','resolved','cleared')),
      flags TEXT NOT NULL, reviewer_id TEXT REFERENCES users(id), resolution_notes TEXT, resolved_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_fraud_reviews_candidate ON fraud_reviews(candidate_id);
    CREATE INDEX IF NOT EXISTS idx_fraud_reviews_application ON fraud_reviews(application_id);
    CREATE TABLE IF NOT EXISTS signature_documents(
      id TEXT PRIMARY KEY, filename TEXT NOT NULL, file_format TEXT NOT NULL DEFAULT 'pdf',
      file_size INTEGER NOT NULL, storage_path TEXT NOT NULL, sha256_hash TEXT NOT NULL,
      is_signed INTEGER DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS signature_requests(
      id TEXT PRIMARY KEY, title TEXT NOT NULL, document_id TEXT NOT NULL REFERENCES signature_documents(id),
      signed_document_id TEXT REFERENCES signature_documents(id), candidate_id TEXT REFERENCES candidates(id),
      application_id TEXT REFERENCES applications(id), requisition_id TEXT REFERENCES requisitions(id),
      status TEXT NOT NULL CHECK(status IN ('draft','pending','viewed','partially_signed','completed','declined','expired','cancelled')),
      original_document_hash TEXT NOT NULL, signed_document_hash TEXT, created_by TEXT NOT NULL REFERENCES users(id),
      expires_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      salary TEXT, currency TEXT, start_date TEXT);
    CREATE INDEX IF NOT EXISTS idx_signature_requests_candidate ON signature_requests(candidate_id);
    CREATE INDEX IF NOT EXISTS idx_signature_requests_application ON signature_requests(application_id);
    CREATE TABLE IF NOT EXISTS signature_signers(
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES signature_requests(id) ON DELETE CASCADE,
      name TEXT NOT NULL, email TEXT NOT NULL COLLATE NOCASE, role TEXT NOT NULL DEFAULT 'Candidate',
      status TEXT NOT NULL CHECK(status IN ('pending','viewed','signed','declined')),
      token_hash TEXT UNIQUE, raw_token TEXT, token_expires_at TEXT, signature_type TEXT CHECK(signature_type IN ('typed','uploaded','drawn')),
      signature_data TEXT, signature_style TEXT, placement_page INTEGER DEFAULT 1,
      placement_x REAL DEFAULT 72, placement_y REAL DEFAULT 150, placement_width REAL DEFAULT 200, placement_height REAL DEFAULT 60,
      signed_at TEXT, ip_address TEXT, user_agent TEXT, consent_confirmed INTEGER DEFAULT 0, declined_reason TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_signature_signers_request ON signature_signers(request_id);
    CREATE TABLE IF NOT EXISTS offer_letter_templates(
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','archived')),
      version INTEGER NOT NULL DEFAULT 1, is_default INTEGER NOT NULL DEFAULT 0,
      page_config TEXT, header_config TEXT, footer_config TEXT, background_config TEXT,
      sections TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_offer_templates_status ON offer_letter_templates(status);
    CREATE TABLE IF NOT EXISTS offer_letter_assets(
      id TEXT PRIMARY KEY, filename TEXT NOT NULL, file_format TEXT NOT NULL,
      file_size INTEGER NOT NULL, mime_type TEXT NOT NULL, storage_path TEXT NOT NULL,
      sha256_hash TEXT NOT NULL, width INTEGER, height INTEGER,
      created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agencies (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, code TEXT NOT NULL UNIQUE COLLATE NOCASE,
      contact_name TEXT NOT NULL, contact_email TEXT NOT NULL COLLATE NOCASE, contact_phone TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK(status IN ('pending','active','suspended','deactivated')) DEFAULT 'active',
      notes TEXT NOT NULL DEFAULT '', created_by TEXT REFERENCES users(id),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agency_members (
      id TEXT PRIMARY KEY, agency_id TEXT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('Agency Admin','Agency Recruiter','Agency')) DEFAULT 'Agency Recruiter',
      status TEXT NOT NULL CHECK(status IN ('active','suspended')) DEFAULT 'active',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_agency_members_agency ON agency_members(agency_id);
    CREATE INDEX IF NOT EXISTS idx_agency_members_user ON agency_members(user_id);
    CREATE TABLE IF NOT EXISTS agency_requisitions (
      id TEXT PRIMARY KEY, agency_id TEXT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
      requisition_id TEXT NOT NULL REFERENCES requisitions(id) ON DELETE CASCADE,
      assigned_by TEXT NOT NULL REFERENCES users(id),
      status TEXT NOT NULL CHECK(status IN ('active','revoked')) DEFAULT 'active',
      instructions TEXT NOT NULL DEFAULT '', deadline TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(agency_id, requisition_id));
    CREATE INDEX IF NOT EXISTS idx_agency_reqs_agency ON agency_requisitions(agency_id);
    CREATE INDEX IF NOT EXISTS idx_agency_reqs_req ON agency_requisitions(requisition_id);
    CREATE TABLE IF NOT EXISTS agency_submissions (
      id TEXT PRIMARY KEY, agency_id TEXT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
      requisition_id TEXT NOT NULL REFERENCES requisitions(id),
      candidate_id TEXT NOT NULL REFERENCES candidates(id),
      application_id TEXT NOT NULL REFERENCES applications(id),
      submitted_by TEXT NOT NULL REFERENCES users(id),
      resume_storage_id TEXT, resume_filename TEXT, notes TEXT NOT NULL DEFAULT '',
      consent_confirmed INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'Submitted',
      ownership_status TEXT NOT NULL DEFAULT 'owned_by_agency' CHECK(ownership_status IN ('owned_by_agency','duplicate_conflict','existing_candidate')),
      agency_feedback TEXT, feedback_published_at TEXT, feedback_published_by TEXT REFERENCES users(id),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_agency_submissions_agency ON agency_submissions(agency_id);
    CREATE INDEX IF NOT EXISTS idx_agency_submissions_req ON agency_submissions(requisition_id);
    CREATE INDEX IF NOT EXISTS idx_agency_submissions_cand ON agency_submissions(candidate_id);
    CREATE INDEX IF NOT EXISTS idx_agency_submissions_app ON agency_submissions(application_id);
    CREATE TABLE IF NOT EXISTS integration_configs (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER DEFAULT 0,
      config_json TEXT NOT NULL DEFAULT '{}',
      encrypted_secrets_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'unconfigured',
      last_test_at TEXT,
      last_test_status TEXT,
      last_error TEXT,
      updated_by TEXT REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_integration_configs_category ON integration_configs(category);
    CREATE TABLE IF NOT EXISTS training_evaluations(
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL REFERENCES applications(id),
      candidate_id TEXT NOT NULL REFERENCES candidates(id),
      evaluator_id TEXT NOT NULL REFERENCES users(id),
      rating INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
      practical_score REAL,
      status TEXT NOT NULL CHECK(status IN ('in_progress','passed','failed')) DEFAULT 'passed',
      decision TEXT NOT NULL CHECK(decision IN ('next','rejected','revoked')) DEFAULT 'next',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_training_eval_app ON training_evaluations(application_id);
    CREATE INDEX IF NOT EXISTS idx_training_eval_cand ON training_evaluations(candidate_id);
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT OR IGNORE INTO settings VALUES('pipeline','["Applied","Screening Round","Interview Round 1","Interview Round 2","HR Round","Pre-Onboarding Training","Onboarding","Hired","Rejected","Revoked"]');
    CREATE TABLE IF NOT EXISTS rbac_roles(
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      description TEXT NOT NULL DEFAULT '', scope TEXT NOT NULL DEFAULT 'team'
        CHECK(scope IN ('organization','team','assigned','none')),
      is_system INTEGER NOT NULL DEFAULT 0, archived_at TEXT, version INTEGER NOT NULL DEFAULT 1,
      permissions_customized INTEGER NOT NULL DEFAULT 0,
      created_by TEXT REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS rbac_role_permissions(
      role_id TEXT NOT NULL REFERENCES rbac_roles(id) ON DELETE CASCADE,
      permission TEXT NOT NULL, PRIMARY KEY(role_id, permission));
    CREATE INDEX IF NOT EXISTS idx_rbac_role_permissions_permission ON rbac_role_permissions(permission);
    INSERT OR IGNORE INTO schema_migrations VALUES(1,datetime('now'));`);
  try { db.exec('ALTER TABLE scorecards ADD COLUMN proxy_for TEXT REFERENCES users(id);'); } catch {}
  try { db.exec('ALTER TABLE scorecards ADD COLUMN proxy_reason TEXT;'); } catch {}
  try { db.exec("ALTER TABLE interviews ADD COLUMN round TEXT DEFAULT 'Round 1';"); } catch {}
  try { db.exec("ALTER TABLE interviews ADD COLUMN round_number INTEGER DEFAULT 1;"); } catch {}
  // v0.2 referrals required a requisition. Existing databases are rebuilt in
  // place so historic referrals without a linked requisition remain readable
  // and future records can be stored with "Not linked" until processed.
  const referralColumns = db.prepare('PRAGMA table_info(referrals)').all();
  const requisitionColumn = referralColumns.find(column => column.name === 'requisition_id');
  if (requisitionColumn && Number(requisitionColumn.notnull) === 1) {
    db.exec('PRAGMA foreign_keys=OFF');
    try {
      db.exec(`BEGIN;
        CREATE TABLE referrals_migrated(id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL,
          requisition_id TEXT REFERENCES requisitions(id), note TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES users(id), at TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'Submitted', candidate_id TEXT REFERENCES candidates(id),
          application_id TEXT REFERENCES applications(id), withdrawn_at TEXT, withdrawn_by TEXT REFERENCES users(id),
          deleted_at TEXT, deleted_by TEXT REFERENCES users(id), updated_at TEXT);
        INSERT INTO referrals_migrated(id,name,email,requisition_id,note,created_by,at,status)
          SELECT id,name,email,requisition_id,note,created_by,at,'Submitted' FROM referrals;
        DROP TABLE referrals;
        ALTER TABLE referrals_migrated RENAME TO referrals;
        COMMIT;`);
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    } finally {
      db.exec('PRAGMA foreign_keys=ON');
    }
  }

  const addColumn = (table, definition) => {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`); } catch {}
  };
  for (const definition of [
    "status TEXT NOT NULL DEFAULT 'Submitted'",
    'candidate_id TEXT REFERENCES candidates(id)',
    'application_id TEXT REFERENCES applications(id)',
    'withdrawn_at TEXT',
    'withdrawn_by TEXT REFERENCES users(id)',
    'deleted_at TEXT',
    'deleted_by TEXT REFERENCES users(id)',
    'updated_at TEXT'
  ]) addColumn('referrals', definition);
  for (const table of ['candidates', 'requisitions']) {
    addColumn(table, 'deleted_at TEXT');
    addColumn(table, 'deleted_by TEXT REFERENCES users(id)');
    addColumn(table, 'updated_at TEXT');
  }
  addColumn('users', 'role_id TEXT REFERENCES rbac_roles(id)');
  addColumn('rbac_roles', 'permissions_customized INTEGER NOT NULL DEFAULT 0');
  seedSystemRoles(db);
  db.exec('CREATE INDEX IF NOT EXISTS idx_users_role_id ON users(role_id);');


  try { db.exec('ALTER TABLE interviews ADD COLUMN title TEXT DEFAULT "";'); } catch {}
  try { db.exec('ALTER TABLE interviews ADD COLUMN duration_minutes INTEGER DEFAULT 45;'); } catch {}
  try { db.exec('ALTER TABLE interviews ADD COLUMN timezone TEXT DEFAULT "Asia/Kolkata";'); } catch {}
  try { db.exec("UPDATE interviews SET timezone = 'Asia/Kolkata' WHERE timezone = 'UTC' OR timezone IS NULL;"); } catch {}
  try { db.exec('ALTER TABLE interviews ADD COLUMN notes TEXT DEFAULT "";'); } catch {}
  try { db.exec('ALTER TABLE interviews ADD COLUMN meeting_url TEXT;'); } catch {}
  try { db.exec('ALTER TABLE interviews ADD COLUMN calendar_event_id TEXT;'); } catch {}
  try { db.exec('ALTER TABLE interviews ADD COLUMN calendar_status TEXT DEFAULT "not_synced";'); } catch {}
  try { db.exec('ALTER TABLE interviews ADD COLUMN interview_type TEXT DEFAULT "virtual";'); } catch {}
  try { db.exec('ALTER TABLE interviews ADD COLUMN location TEXT DEFAULT "";'); } catch {}
  addColumn('signature_signers', 'raw_token TEXT');
  addColumn('signature_requests', 'salary TEXT');
  addColumn('signature_requests', 'currency TEXT');
  addColumn('signature_requests', 'start_date TEXT');
  addColumn('signature_requests', 'template_id TEXT REFERENCES offer_letter_templates(id)');
  addColumn('signature_requests', 'template_snapshot TEXT');
  return db;
}
export function audit(db, actor, event, target = '', detail = {}) {
  db.prepare('INSERT INTO audit(actor,event,target,detail,at) VALUES(?,?,?,?,?)').run(actor || 'anonymous', event, target, JSON.stringify(detail), now());
}
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}