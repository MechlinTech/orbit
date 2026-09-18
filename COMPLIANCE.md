# Privacy, governance and accessibility readiness

This document describes engineering status and decisions your organization must make. It does not assert legal compliance, certification or suitability for any particular jurisdiction.

## Data handling

Collected data includes Microsoft object/tenant IDs, work emails, roles/team membership, login/audit events, candidate contact details, plain-text resumes, applications, interview evidence and referral information. Local storage and deployment keep data under your organization’s control. This phase makes no external candidate-data transmissions. Microsoft sign-in exchanges identity information with Microsoft.

Before real use, appoint data/process owners, publish the appropriate candidate and employee notices, establish lawful processing grounds with your privacy/legal team, set retention periods by record category and document access/erasure/correction procedures. Consent capture, automated retention, legal holds, candidate self-service export and deletion/redaction workflows are **not implemented**. A privacy administrator will need a reviewed operational process or the Phase 4 implementation before production approval. Do not assume deleting a candidate database row is a complete erasure process; backups and audit retention need separate treatment.

Restrict collection to job-related evidence. Do not record protected traits, health details or other unnecessary sensitive information in interview notes. The app does not enforce this through content classification. Candidate resume text is treated as data, never as executable instructions or instructions to an AI system.

## Automated assistance

Current matching is transparent keyword skill overlap. It is not an AI model, ability test or hiring recommendation and never auto-rejects candidates. The JD assistant is a template. Human review is required. Future AI adapters must add approved processing agreements, data minimization, model/version provenance, validation, fairness review, explanations, human overrides and an audit trail before activation. Fraud flags must be reviewable hypotheses linked to evidence, not automatic adverse actions; only the adapter contract exists today.

## Access and audit

Role/team checks, pending approval, session revocation and append-only application audit records support access governance. They do not replace periodic entitlement review, independent audit-log storage, training or incident response. No claim of SOC 2, ISO 27001, GDPR, CCPA or other certification/compliance is made.

## Accessibility

The interface uses semantic headings/tables, explicit form labels, keyboard-accessible native controls/dialogs, visible focus, a skip link, live status/error messages, responsive layouts and reduced-motion support. These are a baseline toward WCAG-oriented review, not a certified conformance statement. Conduct assistive-technology testing, contrast checks, keyboard-only testing, 200% zoom, mobile touch/landscape testing and accessible authentication review on the deployed host. Exact automated/manual checks performed are listed in TEST_RESULTS.md; do not infer unlisted checks passed.
