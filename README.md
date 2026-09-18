# Mechlin Orbit

Version 0.2 adds official Mechlin branding, a refreshed interface and **Settings → Appearance** for System Admins. Choose Mechlin Light, Midnight or Ocean; preview/reset locally, then save the theme for the whole organization. Theme changes persist and are audited. See [BRANDING_AND_THEMES.md](BRANDING_AND_THEMES.md).

A working Phase 1–2 internal applicant tracking foundation, with provider-neutral contracts for subsequent phases. This is a development and staging handoff, not a claim of production certification or a completed enterprise ATS.

## Start here

Read [DEPLOYMENT_INSTRUCTIONS.md](DEPLOYMENT_INSTRUCTIONS.md), then [SELF_HOSTED_DEPLOYMENT.md](SELF_HOSTED_DEPLOYMENT.md) for a physical server. Requirements: Node.js 22.17.1 (the tested runtime), a local writable data directory and a Microsoft Entra application registration. There are **no npm runtime dependencies** and no compilation step. No external cloud database is required.

```sh
npm test
npm run check
node src/server.js
```

Without environment configuration, the local server serves the sign-in page at `http://localhost:3000`; sign-in returns an explicit configuration error. There is no password fallback, demo login or production authentication bypass. Tests create synthetic identities directly in isolated test databases.

## Working scope

- Microsoft 365 authorization-code/OIDC integration with PKCE, nonce, signature and claim validation; no live tenant verification was performed.
- New identities enter a strict pending-approval state. Administrators manually provision an exact Entra identity, approve/reject, assign roles/team, disable/reactivate and force logout. Login/admin events appear in audit history.
- Persistent SQLite storage, server-side RBAC, team isolation, expiring/revocable sessions, CSRF protection and append-only application audit log.
- Draft requisition → manager approval → separate finance approval → open job. Creator and both approvers must be distinct people. Salary range, headcount, description and skills are persisted.
- Candidate intake, plain-text resume extraction, case-insensitive email duplicate detection, candidate keyword search and explained skill overlap.
- Configurable pipeline, application history, terminal stages and approved headcount enforcement.
- Interview planning, assigned reviewers, structured competency scorecards and feedback blinding until all of the viewer’s own scorecards for the application are submitted.
- Employee referrals, team-scoped analytics, responsive screens, installable PWA assets and a privacy-preserving offline screen.

No marketing site, sales CRM, billing or public registration is included. “Agency” is reserved and denied all grants until a properly isolated portal is implemented.

## Phases

| Phase | Status | Delivery |
|---|---|---|
| 1: identity and operations | Implemented foundation | Entra integration code, approval workflow, users, roles, teams, sessions, audit, deployment |
| 2: core recruiting | Implemented foundation | Requisitions, two-stage approvals, candidates, applications, pipeline, interviews/scorecards, referrals, basic analytics |
| 3: external workflows | Contracts only | Microsoft/Google scheduling, Teams/Meet, candidate communications, offers/e-signatures, preboarding/HRMS, document parsing, AI assistance, fraud review |
| 4: enterprise depth | Planned | Agency portal, advanced intelligence/semantic search, custom approval graphs, retention automation, richer reporting, HRIS sync, availability/load hardening |

See [ROADMAP.md](ROADMAP.md) for acceptance gates and [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) for what is deliberately incomplete. The scope was derived from the supplied plan referencing Workday, Greenhouse, Lever, iCIMS, SmartRecruiters, Ashby, SAP SuccessFactors, Oracle Recruiting, Jobvite and BambooHR. This handoff does not claim feature parity or a newly verified market ranking.

## Verification

`npm test` exercises the real service layer, SQLite and HTTP server. Cryptographic auth tests use locally generated RSA keys and mocked Microsoft endpoints; these are not live Entra tests. Exact local results are in [TEST_RESULTS.md](TEST_RESULTS.md). Node 22.17.1 emits an experimental warning for its built-in SQLite API.

## Repository map

`src/` server, domain service, authorization, OIDC, database and adapter contracts; `public/` browser application/PWA; `tests/` automated auth, workflow and HTTP tests; `scripts/` bootstrap, validation and backup; `deploy/` reverse proxy/systemd examples.

The bootstrap script creates only the first administrator, requires exact Entra IDs and records an audit event. Afterward, all access is managed through the admin screen. It does not create Microsoft accounts or set passwords.
