# HTTP API reference

All `/api/*` endpoints require an approved session. Mutations require `Content-Type: application/json`, an exact `Origin` matching `APP_ORIGIN` and `X-CSRF-Token` obtained from `GET /api/me`. Cookies are opaque/HttpOnly. Responses are JSON; errors contain `error` and `requestId`. Domain errors use 400/401/403/404/409/413/415/429/503 as applicable. Success is 200. Direct object IDs do not bypass scope checks.

| Method | Path (under `/api/`) | Purpose |
|---|---|---|
| GET | me | Current user, CSRF token, roles and effective grants |
| GET | appearance | Current theme and allowlisted theme options; approved users only |
| PUT | admin/appearance | System Admin only; `{theme: "mechlin" \| "midnight" \| "ocean"}`; persisted and audited |
| POST | logout | Revoke current session |
| GET/POST | admin/users | List / provision exact Entra identity |
| POST | admin/users/:id/approve,reject,disable,reactivate,force-logout,update | Use one action segment; role/team required for approve/update |
| GET | admin/audit?before=ID&limit=N | Newest first; max 500 records; paginate using last returned ID |
| GET/PUT | pipeline | Read / update ordered `stages` list |
| GET/POST | requisitions | Scoped list / create draft |
| POST | requisitions/:id/submit,approve,reject | One action segment; optional decision `note` |
| GET/POST | candidates | Search with `?q=`, or create |
| POST | resume/parse | `{text}` plain-text extraction |
| POST | jd/draft | `{title,skills:[]}` template generation |
| GET/POST | applications | Scoped list / `{candidate_id,requisition_id}` |
| GET | applications/:id/match | Explained deterministic skill overlap |
| POST | applications/:id/stage | `{stage}` next stage or rejection |
| GET/POST | interviews | List / `{application_id,interviewer_id,scheduled_at,competencies:[]}` |
| GET/POST | interviews/:id/scorecards | Blinded application feedback / submit own `{ratings,recommendation,notes}` |
| GET | interviewers | Assignable users visible to recruiter |
| GET/POST | referrals | Own referrals / `{name,email,requisition_id,note}` |
| GET | analytics | Team-scoped counts |
| GET | integrations | Explicit unavailable later modules |

Requisition create body: `{title,team,headcount,salary_min,salary_max,currency,description,skills:[]}`. Candidate create body: `{name,email,phone,team,skills:[],resume_text,source}`. User provisioning body: `{name,email,oid,tenant,role,team}`. Role assignment is a single role string from `GET /api/me`; Agency cannot be assigned in this phase.

Public routes: `/health` is a database liveness check, `/auth/login` starts OIDC, `/auth/callback` validates callback, `/` serves a non-sensitive application shell. APIs do not expose anonymous candidate intake or public registration.
