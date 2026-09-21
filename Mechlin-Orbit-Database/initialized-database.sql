-- Mechlin Orbit v0.2 / schema version 1
-- SQLite DDL only; no records. Run against a new, empty database.
PRAGMA foreign_keys=ON;
BEGIN;
CREATE TABLE applications(id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL REFERENCES candidates(id),
      requisition_id TEXT NOT NULL REFERENCES requisitions(id), stage TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(candidate_id,requisition_id));

CREATE TABLE approvals(id TEXT PRIMARY KEY, requisition_id TEXT NOT NULL REFERENCES requisitions(id),
      actor TEXT NOT NULL REFERENCES users(id), step TEXT NOT NULL, decision TEXT NOT NULL, note TEXT NOT NULL, at TEXT NOT NULL,
      UNIQUE(requisition_id, step));

CREATE TABLE audit(id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, event TEXT NOT NULL,
      target TEXT NOT NULL, detail TEXT NOT NULL, at TEXT NOT NULL);

CREATE TABLE candidates(id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      phone TEXT NOT NULL, skills TEXT NOT NULL, resume_text TEXT NOT NULL, source TEXT NOT NULL, team TEXT NOT NULL,
      created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL);

CREATE TABLE interviews(id TEXT PRIMARY KEY, application_id TEXT NOT NULL REFERENCES applications(id),
      interviewer_id TEXT NOT NULL REFERENCES users(id), scheduled_at TEXT NOT NULL, competencies TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'planned', created_at TEXT NOT NULL);

CREATE TABLE oauth_states(state_hash TEXT PRIMARY KEY, verifier TEXT NOT NULL, nonce TEXT NOT NULL, expires INTEGER NOT NULL);

CREATE TABLE referrals(id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, requisition_id TEXT NOT NULL REFERENCES requisitions(id),
      note TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES users(id), at TEXT NOT NULL);

CREATE TABLE requisitions(id TEXT PRIMARY KEY, title TEXT NOT NULL, team TEXT NOT NULL, headcount INTEGER NOT NULL CHECK(headcount>0),
      salary_min INTEGER NOT NULL, salary_max INTEGER NOT NULL, currency TEXT NOT NULL, description TEXT NOT NULL, skills TEXT NOT NULL,
      status TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL);

CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);

CREATE TABLE scorecards(id TEXT PRIMARY KEY, interview_id TEXT NOT NULL UNIQUE REFERENCES interviews(id),
      author TEXT NOT NULL REFERENCES users(id), ratings TEXT NOT NULL, recommendation TEXT NOT NULL, notes TEXT NOT NULL, submitted_at TEXT NOT NULL);

CREATE TABLE sessions(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
      version INTEGER NOT NULL, csrf TEXT NOT NULL, expires INTEGER NOT NULL);

CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE stage_events(id TEXT PRIMARY KEY, application_id TEXT NOT NULL REFERENCES applications(id),
      from_stage TEXT NOT NULL, to_stage TEXT NOT NULL, actor TEXT NOT NULL REFERENCES users(id), at TEXT NOT NULL);

CREATE TABLE users(
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
      oid TEXT UNIQUE, tenant TEXT, role TEXT NOT NULL DEFAULT 'Employee/Referral', team TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK(status IN ('pending','active','rejected','disabled')), version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, last_login TEXT);

CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'Audit is append-only'); END;

CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'Audit is append-only'); END;
COMMIT;

-- Initialization records (default pipeline and migration version).
BEGIN;
INSERT INTO "schema_migrations" ("version","applied_at") VALUES (1,'2026-09-17 20:29:51');
INSERT INTO "settings" ("key","value") VALUES ('pipeline','["Applied","Screening","Interview","Offer","Hired","Rejected"]');
COMMIT;
