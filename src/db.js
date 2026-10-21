import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export const id = () => randomUUID();
export const now = () => new Date().toISOString();
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
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT OR IGNORE INTO settings VALUES('pipeline','["Applied","Screening","Interview","Offer","Hired","Rejected"]');
    INSERT OR IGNORE INTO schema_migrations VALUES(1,datetime('now'));`);
  try { db.exec('ALTER TABLE scorecards ADD COLUMN proxy_for TEXT REFERENCES users(id);'); } catch {}
  try { db.exec('ALTER TABLE scorecards ADD COLUMN proxy_reason TEXT;'); } catch {}

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