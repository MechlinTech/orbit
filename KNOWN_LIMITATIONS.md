# Known limitations

## Not verified in this environment

- Version 0.2: the initial 45-check automated browser run passed. After the final logo contrast correction, an expanded 51-check CLI rerun was blocked by a browser driver timeout. The final build received 22 passing in-app UI acceptance checks instead; see TEST_RESULTS.md. No claim of exhaustive browser coverage is made.

- No real Entra credentials/tenant were supplied. The OAuth code, signature/claim checks and mock token exchange are tested, but real login, tenant consent, MFA, groups and conditional access remain unverified.
- Docker is unavailable here. The Dockerfile/Compose and Linux/systemd/Caddy deployment examples have not been executed on a target server.
- No external messaging/calendar/signature/HRMS provider has been connected. No real message, invitation, signature request or HRMS handoff was sent.
- No independent penetration test, performance benchmark, accessibility certification or real-device install testing has been completed.

## Foundation limitations

- One process and local SQLite only. Node 22.17.1 SQLite is experimental. No HA, distributed queue, replica failover or PostgreSQL implementation.
- API candidate/job/application collections load complete scoped sets. Add database indexes, pagination and query-level scoping before scaling to large datasets.
- One team string and one role per user. No team hierarchy, delegated admin, per-module custom permissions or job-level hiring-manager assignment. TA Director/System Admin are organization-wide; others are team scoped.
- Manual provisioning requires known Entra tenant/object IDs. The application does not invite/create users in Microsoft. There is no email-only privileged auto-linking.
- No idle timeout, Entra back-channel logout, Microsoft session revocation, token refresh or group-overage Graph lookup. Local session revocation works immediately.
- Approval graph is fixed at distinct manager and finance approvals. No requisition editing, reopen, resubmit, cancellation or custom approver chains in Phase 2.
- Candidate intake is manual text. No binary resume upload, PDF/DOCX parser, antivirus pipeline, bulk import, fuzzy duplicate merge, candidate transfer or full CRUD/erasure workflows.
- Search is literal keyword search; matching is explicit skill overlap and JD assistance is templated. No semantic candidate intelligence or generative AI is connected.
- Interview times are stored in UTC with local browser display. Planning does not check availability or send calendar invitations. Feedback is immutable after submission; no controlled correction flow.
- Referrals are submitted and visible to their submitter; conversion to candidate is manual. No referral rewards or status notifications.
- Offer/Hired pipeline stages do not generate contracts or prove a signed offer. Offers/e-signatures, preboarding/HRMS and fraud review exist as adapter contracts only, not completed UI workflows.
- Agency role is reserved and has no access. Agency portal is not implemented.
- Analytics provide counts, stage distribution and average application age only; no advanced cohorts, time-in-stage reporting UI, source ROI or fairness reports.
- Audit is append-only through app/database triggers, not independently tamper-proof. Candidate read events are not logged comprehensively. Login history is shown through audit events and last successful login, without device/IP fingerprinting.
- No candidate retention automation, legal holds, consent registry, self-service rights workflows, application-layer encryption or outbound notifications.
- PWA offline mode shows a connectivity page only. No offline records or offline mutation queue by design.
- Frontend is a maintainable small vanilla-JavaScript application, not a full enterprise design system. Accessibility review and broader browser testing remain rollout gates.

This package is suitable for developer review and a controlled staging pilot after real Entra configuration. Resolve the relevant limitations before using it as a production system of record.
