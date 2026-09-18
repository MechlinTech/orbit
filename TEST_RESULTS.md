# Mechlin Orbit 0.2 — verification results

Verified 2026-09-17 on Windows with Node.js **22.17.1**. Synthetic data only; no live Microsoft credentials were available.

| Check | Exact result |
|---|---|
| Final backend/security/unit/HTTP suite | **58 passed, 0 failed, 0 cancelled, 0 skipped, 0 todo**; 504.3146 ms in the recorded run |
| JavaScript syntax | **19 files passed** |
| JSON parsing | **2 files passed** (package and PWA manifest) |
| Required handoff documents | **10 of 10 present** |
| Completed automated Chrome UI run | **45 passed, 0 failed**, Chrome 153.0.8010.47; before the final logo contrast correction |
| Final in-app browser acceptance | **22 passed, 0 failed**, including keyboard themes, mobile settings, persistence, all main screens, candidate save/search/escaping/duplicate errors |
| Expanded 51-check CLI UI rerun | **Blocked/incomplete**: browser driver timed out at `Runtime.enable`; no application assertion ran in that retry |
| Logo/design review | Official local logo on white backing verified visually; desktop and mobile screenshots captured |
| Real Entra/MFA/groups | **Not run** — credentials and tenant not supplied |
| Docker/Linux deployment | **Not run** — Docker/target host unavailable |
| Real calendar/email/signature/HRMS | **Not run** — contracts only |
| Penetration, load, assistive-technology certification | **Not performed** |

The final suite adds 10 tests for theme defaults, the allowlist, every non-admin role denial, disabled-admin denial, invalid input, persistent saved settings, audit evidence, anonymous login theme rendering, CSRF and local logo delivery. It retains the original auth/security and ATS workflow tests.

Raw evidence is under `test-results/`: `UNIT_INTEGRATION_RESULTS.txt`, `STATIC_RESULTS.txt`, `BROWSER_RESULTS.txt`, `FINAL_UI_ACCEPTANCE.txt` and `BROWSER_RERUN_LIMITATION.txt`. The final acceptance used the in-app browser after the command-line browser runtime became unavailable. This is disclosed as a test-environment limitation, not presented as a passing 51-check run. The checked-in browser runner now times out rather than hanging indefinitely. Rerun it on your QA host.

Screenshots beginning with `final-` show the final logo/contrast build. Earlier screenshot names belong to the completed automated run and are test evidence, not the latest visual handoff. The dedicated screenshots ZIP contains only final captures. All people and records shown are synthetic fixtures; the production application has no demo login route.

Desktop breakpoint reviewed: 1440 × 1000; mobile: 390 × 844. Native radio controls support arrow-key selection; saving is distinct from preview and reset. Primary candidate workflows were checked again after the visual changes. Full WCAG conformance, real-device PWA installation and exhaustive cross-browser coverage are not claimed.

The built-in SQLite API emits an experimental warning on Node 22.17.1. There is no transpilation step; executable JavaScript syntax and real API/browser behavior were tested.
