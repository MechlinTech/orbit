# Architecture

## Request path

The static responsive browser app communicates with a same-origin JSON HTTP API. `src/server.js` terminates application requests, sets security headers, resolves an opaque database-backed session and enforces origin/CSRF checks. `src/service.js` applies role and team rules before reads or mutations. All mutating workflows write audit records within the same SQLite transaction.

`src/auth.js` implements confidential OIDC authorization-code flow with S256 PKCE. Short-lived state, verifier and nonce are stored server-side; the browser receives only a state cookie. Callback consumes state once, exchanges the code with Microsoft, verifies the RSA signature using the tenant’s HTTPS signing-key endpoint, and checks issuer, audience, tenant, subject, object ID, nonce and token times. Identity mapping uses `(tenant, oid)`; email is contact data, never authority for privileged account linking. Microsoft tokens are not persisted or sent to the browser.

## Session/access lifecycle

```text
Microsoft identity validated
    → tenant/domain/group allow checks
    → unknown identity: pending + access request audit → pending screen
    → rejected/disabled identity: deny workspace
    → approved identity: opaque session cookie → role/team checks on every API request
Admin access change → version increment + session deletion → immediate ATS logout
```

The initial administrator is provisioned with an exact object ID by an explicit OS-level bootstrap command. No first-user promotion occurs. Force logout is ATS-local; it does not revoke Microsoft sessions. MFA and conditional access are Entra policies. Existing ATS sessions do not continuously recheck Entra group changes; use short session lifetimes and explicit admin revocation when needed.

## Components

| Component | Implementation |
|---|---|
| UI | Semantic HTML, CSS, vanilla JavaScript; no build tooling required |
| API | Node HTTP; fixed routes and bounded JSON request bodies |
| Persistence | Built-in Node SQLite, foreign keys, WAL, transactional mutations |
| Auth | Microsoft OIDC, opaque hashed sessions, CSRF + origin checks |
| Authorization | Explicit role grants plus team/assignment checks |
| Audit | Append-only table; update/delete triggers; no mutation API |
| PWA | Manifest, raster/SVG icons, service worker caching only offline page |
| Integration contracts | Explicit unconfigured adapters; no external writes |

## Later integrations

`src/adapters.js` specifies scheduling/cancel, send, signature request/webhook verification, HRMS handoff, resume parsing, matching explanation, AI assistance, and fraud review entry points. Unconfigured adapters reject with `ADAPTER_NOT_CONFIGURED`.

Multi-AI integration (`src/ai/` and `src/matching/ai.js`):
- Multi-provider abstraction (`src/ai/provider.js`): supports OpenAI (`gpt-4o-mini`), Anthropic Claude (`claude-3-5-sonnet-20241022`), Google Gemini (`gemini-1.5-flash`), and xAI Grok (`grok-2-latest`).
- Unified service (`src/ai/service.js`): normalizes provider payloads, enforces bounded retries on transient errors (429, 502, 503, 504), executes strict timeouts (`AbortSignal.timeout`), scrubs secrets from logs/errors, and extracts structured JSON with markdown code fence handling.
- Job description drafting (`src/ai/draft.js`): generates inclusive, structured JDs with prompt injection protection and honest template fallback (`method: 'Template assistant; not generative AI'` when unconfigured).
- Explainable matching (`src/matching/ai.js`): prompt injection tag defense (`<candidate_untrusted_input>`), strict schema validation, skill list hygiene, and automatic deterministic fallback upon provider outage. AI outputs are advisory and never trigger automated candidate rejections.

Scheduling provider: Microsoft Graph events + Teams. Store provider IDs separately from internal interview IDs; handle timezone/DST, cancellations, retries and collision detection. ATS sign-in and scheduling are standardized on Microsoft 365 / Entra.

## Deliberate boundaries

One organization, one process, one local database; no commercial tenants or billing. Team membership is one string per user, not a hierarchy. System Admin and TA Director have organization scope; other roles are team scoped; interviewers only access assigned interview feedback. Hiring Managers have team-wide review access in this foundation, not per-job assignment. Agency role grants nothing.

This architecture suits a pilot foundation, not an unbounded enterprise workload. A PostgreSQL repository layer, jobs queue and shared sessions would be a separate scale phase. There are no hidden vendor hosting dependencies.
