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
| interviews | UUID PK, application/interviewer FKs | UTC schedule, duration, timezone, competencies, title, notes, meeting URL, calendar event ID, status (`planned`,`completed`,`cancelled`), calendar status (`not_synced`,`synced`,`sync_failed`), interview format (`virtual`,`in_person`), physical location, invitation delivery status (`pending`,`accepted`,`failed`), meeting errors, and invitation errors |
| scorecards | UUID PK, unique interview FK, author FK | Structured ratings, recommendation, evidence and submission time |
| referrals | UUID PK, requisition/user FKs | Employee’s private referral record |
| candidate_resumes | UUID PK, candidate FK, uploader FK | Resume metadata, server storage ID, format, size, scan and parsing status |
| candidate_communications | UUID PK, candidate FK, requisition FK, sender FK | Delivery tracking, provider message ID, channel, template ID, subject, delivery status (`queued`,`accepted`,`delivered`,`bounced`,`failed`), error details, and idempotency key |
| communication_consents | candidate PK / FK, updater FK | Candidate communication preferences, opt-out status, and timestamp |
| application_matches | UUID PK, application FK | Persistent match evaluation record, score, matched skills, missing skills, experience score, method, explanation, breakdown, evidence snippets, and calculation timestamp |
| fraud_reviews | UUID PK, candidate FK, application FK, reviewer FK | Consistency review signals, risk level (`low`,`medium`,`high`), review status (`pending`,`reviewed`,`resolved`,`cleared`), JSON flags, reviewer notes, and resolution timestamp |
| signature_requests | UUID PK, candidate FK, application FK, requisition FK, template FK | In-house e-signature request lifecycle, status, SHA-256 hashes, salary, currency, start date, template snapshot, expiration, and audit trail |
| signature_documents | UUID PK, document hash PK | Electronic documents and cryptographically verified signatures |
| signature_signers | UUID PK, request FK | Signer identities, raw token, authentication token hashes, signature styles/data, and timestamps |
| offer_letter_templates | UUID PK, creator FK | In-house customizable offer templates, sections, page/header/footer configs, version, default flag, and status |
| offer_letter_assets | UUID PK, creator FK | Processed letterhead images and background branding assets with SHA-256 verification |
| training_evaluations | UUID PK, application FK, candidate FK, evaluator FK | Pre-onboarding technical and culture benchmark ratings (1-5), practical scores, attempt number, notes, and transition decisions (`next`,`rejected`,`revoked`) |
| training_deadline_extensions | UUID PK, application FK, actor FK | Historical training deadline extensions, attempt number, previous deadline, new deadline, actor, and extension reason |
| training_plan_templates | UUID PK, creator FK | Pre-onboarding training curriculum templates, modules, objectives, learning resources, and role mappings |
| training_plan_drafts | UUID PK, application FK, candidate FK, template FK | Candidate-specific pre-onboarding training plans, draft review lifecycle (`pending_review`,`draft_saved`,`sent`), rendered text/HTML, and manual confirmation audit |
| training_plan_assets | UUID PK, creator FK | Document and image resources attached to pre-onboarding training curriculums |
| agencies | UUID PK, name UNIQUE, code UNIQUE | External recruitment partner accounts, business contacts, and status (`active`,`suspended`,`deactivated`) |
| agency_members | UUID PK, agency FK, user FK | Agency partner user membership, external roles (`Agency Admin`,`Agency Recruiter`), and status |
| agency_requisitions | UUID PK, agency FK, requisition FK | Explicit requisition assignments to agencies, sourcing instructions, and submission deadlines |
| agency_submissions | UUID PK, agency FK, requisition FK, candidate FK, application FK | External candidate submissions, ownership tracking, reference codes, affirmative consent, and published feedback |
| integration_configs | text PK (`integration_id`), updated_by FK | Centralized integration configurations, enabled flag, JSON config, AES-256-GCM encrypted secrets, test results and timestamps |
| settings | text PK | Global ordered pipeline JSON |

Version 0.2 adds the optional `appearance` settings key with `{ "theme": "mechlin" }` (or `midnight`/`ocean`). The record is created on first admin save; existing databases fall back to Mechlin Light. No destructive or schema migration is required. It does not reset the pipeline or change user access.

IDs are generated server-side. User-supplied values use prepared SQL parameters. Dynamic table references come only from internal fixed call sites. Team names are normalized by trimming, not case-folding: use one consistent spelling. Candidate emails are globally unique, so cross-team duplicates require a later controlled transfer/merge workflow; duplicate responses do not reveal the other record ID.

Approved requisition states: `draft`, `pending_manager`, `pending_finance`, `open`, `rejected`. User states: `pending`, `active`, `rejected`, `disabled`. Pipeline stages are configurable, must start with Applied and end with Hired then Rejected. Only next-stage or reject transitions are accepted. Hired and Rejected are terminal. Hiring is blocked when approved headcount is filled.

Future migrations must use increasing schema versions, transactional application and fresh/upgrade tests. No destructive down-migrations are supplied. Backups use `VACUUM INTO`; see SELF_HOSTED_DEPLOYMENT.md.

Audit triggers prevent normal SQL update/delete, but a privileged database/OS operator can alter schema or replace the file. This is not cryptographic tamper evidence. Forward audit events to an independently controlled append-only destination in a production hardening phase.
