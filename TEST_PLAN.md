# Test plan

## Available automated checks

Run from the project root using Node 22.17.1:

```sh
npm test
npm run check
npm run test:browser
```

`npm test` uses Node’s test runner and no external dependencies. Suites cover cryptographic ID-token verification, single-use browser-bound OIDC state, mock token exchange, tenant/domain/group policy, strict pending access, identity collision prevention, role/session lifecycle, requisition approvals, duplicate candidates, team isolation, role denial, pipeline/headcount rules, skill explanations, assigned/blinded feedback, referral privacy, analytics scope, audit immutability, HTTP security headers/CSRF/input handling/logout/rate limits, SQLite persistence/snapshot restore, and explicit adapter failures.

`npm run check` checks all JavaScript syntax, parses package/manifest JSON and verifies the ten required handoff documents exist. There is no transpilation/bundle build; the checked source is the executable artifact.

Version 0.2 adds backend tests for all theme permissions, invalid values, disabled admins, persistence after database restart, safe fallback, audit events, login HTML branding and HTTP CSRF enforcement. The browser suite exercises preview/reset, saving and refresh across all themes, mobile settings and keyboard selection. See TEST_RESULTS.md for the distinction between the completed 45-check run, final 22 in-app acceptance checks and the expanded CLI rerun that was blocked by its browser driver.

`npm run test:browser` uses an installed Chrome/Chromium with Node's built-in WebSocket/CDP support, no npm browser dependency. On Windows the default is `C:/Program Files/Google/Chrome/Application/chrome.exe`; set test-only `BROWSER_PATH` to your installed executable elsewhere. It starts its own synthetic in-memory server on loopback port 3000 (which must be free), validates UI flows and writes screenshots/results under `test-results/`. Its fixture injects an identity only inside this test server, never in the production application. The test creates a disposable browser profile in `test-results/chrome-profile`; do not deploy or archive that profile. On Linux run browser tests on a host with a supported Chromium sandbox and display-independent headless dependencies.

Fixtures use in-memory or temporary databases. No real credentials, mailboxes, candidates or calendars are required. No test-only authentication endpoint is shipped. The exact counts and environment are recorded in TEST_RESULTS.md and raw test output is packaged in `test-results/`.

## Staging acceptance

| Area | Expected behavior |
|---|---|
| New Microsoft user | Pending notice; direct API requests denied; request visible to admins |
| Admin lifecycle | Approve/reject/change role/team/disable/reactivate; revoked cookies fail immediately |
| Identity safety | Another tenant/domain denied; missing required group denied; email collision cannot claim provisioned identity |
| Audit | Auth/admin events recorded; historical changes remain visible |
| Headcount | Distinct requester/manager/finance; no hiring beyond approved positions |
| Hiring isolation | Cross-team IDs rejected; low-privilege users cannot retrieve candidate records |
| Feedback | Reviewer cannot submit on another assignment or view peer feedback before their own submission |
| UI | Forms save persisted data; errors leave user input available; HTML-like record text renders as text |
| Mobile/PWA | Narrow screens remain usable; trusted HTTPS install works; offline page exposes no PII |
| Accessibility | Keyboard-only completion, visible focus, screen-reader labels/errors, 200% zoom and contrast review |
| Operations | Restart persists data; monitored health; backup restore validated on another host |

## Required deployment gates not covered by local suite

Real Entra registration/consent/MFA/groups and live callback; Docker build/run; TLS/certificate validation; Linux service ownership; backup encryption/off-host restore; runtime patch review; penetration/DAST and load testing; real-device/browser accessibility and PWA install. Add provider contract tests, sandbox integration tests, idempotency/retry/webhook tests and privacy review for every Phase 3 adapter.
