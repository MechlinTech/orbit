# Security model and production gates

## Implemented

- Mandatory Microsoft authentication for every real user. No password fallback, public sign-up or demo bypass.
- Single-tenant issuer/audience/tenant validation, verified RSA signature, nonce, state cookie binding, one-use state, PKCE and token time checks.
- Explicit new-user approval, immutable Entra identity binding, allowlisted domains and optional group IDs. Missing/overage group claims deny access.
- Hashed opaque session tokens; HttpOnly/SameSite cookies, Secure on HTTPS, absolute lifetime and immediate per-user version revocation.
- Server-side granular permission, record-scope, field-level and workflow checks; no reliance on hidden UI buttons for authorization.
- Persistent custom roles with explicit permission grants, protected built-in roles, optimistic version checks, delegation boundaries and immediate grant re-evaluation on every request.
- Origin and CSRF checks on every API mutation, fixed static-file allowlist, 128 KB JSON body limit, SQL parameters and HTML escaping of record values.
- CSP, frame blocking, no-referrer, nosniff, restrictive permissions policy, HTTPS HSTS and no-store responses.
- No candidate data cached by the service worker; no candidate records or auth tokens in browser local storage.
- Admin/auth events, denied auth/authorization requests and recruiting mutations are audited. Audit updates/deletes are blocked by triggers.
- Self access changes are blocked except force logout; last-active-admin protection and one-time bootstrap prevent common lockout paths.

## Permission matrix

| Role | Scope | Grants |
|---|---|---|
| System Admin | Organization | Users/audit/configuration, recruiting, both approval capabilities, analytics, referrals |
| TA Director | Organization | Recruiting, manager approvals, review, analytics, referrals |
| TA Manager | Assigned team | Recruiting, manager approvals, review, analytics, referrals |
| Recruiter | Assigned team | Recruiting, review, analytics, referrals |
| Hiring Manager | Assigned team | Create requisitions, manager approval, candidate/interview review, referrals |
| Interviewer | Assigned interviews | Interview list; candidate contact/skills and application context for assigned interviews; assigned feedback; open team jobs without salary |
| Finance Approver | Assigned team | Requisition salary/headcount review and finance approval; no candidate records |
| Employee/Referral | Assigned team / own referrals | Open jobs without salary; create/view own referrals |
| Agency | None | Reserved; all business grants denied; cannot be assigned through admin |

The effective matrix lives in `src/policy.js`: protected `systemRoleDefinitions` are reconciled into `rbac_roles`, and custom roles persist direct granular grants in `rbac_role_permissions`. Ten legacy capability tokens remain in `rolePermissions` for client compatibility, but backend checks use granular permissions. `GET /api/me` returns both `permissions` (legacy) and `grants` (granular), plus the permission catalogue and role scope. Backend checks are authoritative; frontend navigation and action hiding only mirror those grants.

Role scopes bound every record read and mutation: `organization` (all teams), `team` (own team), `assigned` (explicitly assigned records) and `none`. Sensitive fields have separate grants: candidate contact/resume fields, requisition compensation and offer compensation/signed documents are redacted or rejected without the corresponding permission. Workflow actions likewise use dedicated permissions (`applications.update`, `interviews.evaluate`, `referrals.process`, and so on) rather than a broad admin bypass. `system.override` is reserved for documented emergency/administrative paths.

System role names, descriptions and record scopes cannot be edited or archived through the API. An administrator with `roles.update` may customize permission grants for operational built-in roles such as Recruiter, Hiring Manager and Interviewer; those customizations persist across restarts without being overwritten by startup seeding. System Admin and agency roles remain fully immutable. Only a System Admin may assign protected system roles or create/assign organization-scoped roles, and delegated administrators cannot grant permissions beyond their own effective grants or edit their own access. Role updates use optimistic `version` checks; assigned roles cannot be archived. Permission changes apply on the next request without a cache, and user role/team changes revoke existing sessions. Interviewers never receive resume text, resume files, offer/salary fields, candidate creator identity or applications outside their assigned interviews. Highly privileged demo identities are disabled by default in production and cannot be used to switch roles for a non-demo session.

The requester and both approvers must be three distinct identities regardless of System Admin permissions. Assigned reviewers remain blinded until all their own scorecards for that application are submitted. Non-assigned authorized hiring reviewers may read submitted feedback. Submitted scorecards have no edit API.

## Scope/limits

This is an application security foundation, not a security certification. OS/database administrators remain privileged. Candidate data and backups are not encrypted by the application; use full-disk encryption and encrypted backup storage. OIDC is implemented using Node cryptographic primitives and requires independent security review before production. No penetration test has been performed. Node’s SQLite API emits an experimental warning on the tested version.

Session revocation is local to TalentOS. Microsoft account disable/group changes are enforced at the next Microsoft sign-in, not continuously on existing ATS sessions. There is no Entra back-channel logout or continuous-access-evaluation integration. Absolute session timeout defaults to eight hours; an idle timeout is not implemented. Consider a shorter lifetime for sensitive roles.

The auth rate limiter is in-memory and uses socket IP, so a reverse proxy makes it aggregate. Edge controls, runtime patching, centralized monitoring, log redaction and independent audit export are host responsibilities. Read endpoints are not yet comprehensively rate-limited or paginated. All TLS/secret settings need target-host verification.

## Operational checklist

1. Keep app ingress on LAN/VPN; use HTTPS with trusted certificates; deny direct access to port 3000.
2. Require Entra MFA/conditional access and explicit enterprise-app assignment.
3. Store `.env` outside source control, restrict permissions and rotate client secrets. Do not log OAuth callback queries.
4. Review team scopes, create at least two System Admins and document a controlled OS-level disaster-recovery process.
5. Review source/runtime dependencies, run tests and an independent assessment before real candidate intake.
6. Rehearse encrypted backups/restores and incident response, including session revocation and affected-record identification.

Report security findings privately to your internal security owner; do not include tokens, secrets or candidate resumes in public issue trackers.
