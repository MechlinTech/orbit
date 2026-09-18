# Phased delivery and acceptance criteria

## Phase 1 — Identity and internal operations (implemented foundation)

Mandatory Entra sign-in code, strict access approval, exact identity provisioning, nine defined roles (Agency disabled), team checks, admin lifecycle, sessions, audit, PWA shell and portable deployment. Release gate: configure a real tenant and demonstrate all access states and revocation over trusted HTTPS.

## Phase 2 — Core ATS (implemented foundation)

Requisitions/JDs, headcount approvals, candidate intake/plain-text parsing, email duplicates, skill explanations, configurable stages, structured scorecards with blinding, interview planning, employee referrals and basic analytics. Release gate: three users approve a requisition, recruiter adds candidate/application, interviewer submits blinded feedback and the hire consumes approved headcount. Verify team isolation and restore a backup.

The foundation intentionally uses templates and deterministic skill overlap. An AI implementation is a later provider integration, not an implied capability of these labels.

## Phase 3 — Integration workflows (contracts supplied)

1. Microsoft Graph calendar/Teams and Google Calendar/Meet adapters with timezone/availability logic, incremental consent, encrypted connector tokens, durable job outbox, retries, cancellation and idempotency. Gate: provider sandbox invitation lifecycle plus collision and DST tests.
2. Candidate communications with approved templates, consent/preferences, delivery status, bounce handling and scoped mail/SMS providers. Gate: sandbox delivery receipts and opt-out enforcement.
3. Offer entity/versioning and approval controls, document generation, signature adapter, verified signed webhooks and immutable signature evidence. Gate: sandbox offer-to-signed transition and replay-protection tests.
4. Preboarding checklist and HRMS mapping/handoff with approved-field allowlists and retry-safe external identifiers. Gate: isolated HRMS sandbox round-trip without duplicate employees.
5. Quarantined resume file storage, type/size validation, antivirus and PDF/DOCX parsing; explainable AI adapter with human overrides and audited model versions. Gate: malicious-file tests and quality/fairness evaluation on approved data.
6. Fraud signals as reviewable evidence-linked flags with challenge/correction procedures. Gate: no automatic rejection; all adverse decisions require authorized human review.

## Phase 4 — Enterprise hardening and optional agency portal

Per-job permissions, multi-team membership, custom approval graphs, candidate merge/transfer/retention/rights handling, richer source/time-to-hire analytics, semantic candidate search, independent audit export, PostgreSQL migration and multi-process workers if load requires. Optional agency users receive their own isolated submissions and no access to the organization’s candidate pool. Gate: tenant/vendor isolation tests, provider contract tests, operational runbooks and privacy/security sign-off.

No calendar, email, signature, HRMS or agency capability should be enabled by silently treating an unconfigured stub as successful.
