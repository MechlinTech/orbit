# Security model and production gates

## Implemented

- Mandatory Microsoft authentication for every real user. No password fallback, public sign-up or demo bypass.
- Single-tenant issuer/audience/tenant validation, verified RSA signature, nonce, state cookie binding, one-use state, PKCE and token time checks.
- Explicit new-user approval, immutable Entra identity binding, allowlisted domains and optional group IDs. Missing/overage group claims deny access.
- Hashed opaque session tokens; HttpOnly/SameSite cookies, Secure on HTTPS, absolute lifetime and immediate per-user version revocation.
- Server-side permission and team/assignment checks; no reliance on hidden UI buttons for authorization.
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
| Interviewer | Assigned interviews | Interview list and assigned feedback; open team jobs without salary |
| Finance Approver | Assigned team | Requisition salary/headcount review and finance approval; no candidate records |
| Employee/Referral | Assigned team / own referrals | Open jobs without salary; create/view own referrals |
| Agency | None | Reserved; all business grants denied; cannot be assigned through admin |

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
