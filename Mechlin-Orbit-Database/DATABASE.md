# Database

Engine: SQLite through Node 22 `node:sqlite`. Default path `data/talentos.sqlite`; override with `DATABASE_PATH`. Startup enables foreign keys, WAL, a 5-second busy timeout, idempotent schema v1 and append-only audit triggers. SQLite’s Node API is experimental in the tested runtime.

| Table | Key and important relationships | Purpose |
|---|---|---|
| schema_migrations | version PK | Applied schema version |
| users | UUID PK, unique case-insensitive email, unique oid | Entra identity, role, team, status, session version, last login |
| sessions | SHA-256 token hash PK, user FK | CSRF token, user version, absolute expiry |
| oauth_states | SHA-256 state hash PK | One-use verifier/nonce and ten-minute expiry |
| audit | integer PK | Actor, event, target, safe JSON detail, UTC time |
| requisitions | UUID PK, creator FK | Salary range, headcount, job text, JSON skills and approval state |
| approvals | UUID PK, requisition/user FKs, unique requisition + step | Manager and finance decision evidence |
| candidates | UUID PK, unique email, creator FK | Contact, JSON skills, plain-text resume, team, source |
| applications | UUID PK, candidate/requisition FKs, unique pair | Current pipeline stage |
| stage_events | UUID PK, application/user FKs | Immutable-by-API stage history |
| interviews | UUID PK, application/interviewer FKs | UTC schedule, competency list and state |
| scorecards | UUID PK, unique interview FK, author FK | Structured ratings, recommendation, evidence and submission time |
| referrals | UUID PK, requisition/user FKs | Employee’s private referral record |
| settings | text PK | Global ordered pipeline JSON |

Version 0.2 adds the optional `appearance` settings key with `{ "theme": "mechlin" }` (or `midnight`/`ocean`). The record is created on first admin save; existing databases fall back to Mechlin Light. No destructive or schema migration is required. It does not reset the pipeline or change user access.

IDs are generated server-side. User-supplied values use prepared SQL parameters. Dynamic table references come only from internal fixed call sites. Team names are normalized by trimming, not case-folding: use one consistent spelling. Candidate emails are globally unique, so cross-team duplicates require a later controlled transfer/merge workflow; duplicate responses do not reveal the other record ID.

Approved requisition states: `draft`, `pending_manager`, `pending_finance`, `open`, `rejected`. User states: `pending`, `active`, `rejected`, `disabled`. Pipeline stages are configurable, must start with Applied and end with Hired then Rejected. Only next-stage or reject transitions are accepted. Hired and Rejected are terminal. Hiring is blocked when approved headcount is filled.

Future migrations must use increasing schema versions, transactional application and fresh/upgrade tests. No destructive down-migrations are supplied. Backups use `VACUUM INTO`; see SELF_HOSTED_DEPLOYMENT.md.

Audit triggers prevent normal SQL update/delete, but a privileged database/OS operator can alter schema or replace the file. This is not cryptographic tamper evidence. Forward audit events to an independently controlled append-only destination in a production hardening phase.
