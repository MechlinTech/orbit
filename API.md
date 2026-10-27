# HTTP API reference

All `/api/*` endpoints require an approved session. Mutations require `Content-Type: application/json`, an exact `Origin` matching `APP_ORIGIN` and `X-CSRF-Token` obtained from `GET /api/me`. Cookies are opaque/HttpOnly. Responses are JSON; errors contain `error` and `requestId`. Domain errors use 400/401/403/404/409/413/415/429/503 as applicable. Success is 200. Direct object IDs do not bypass scope checks.

| Method | Path (under `/api/`) | Purpose |
|---|---|---|
| GET | me | Current user, CSRF token, assignable `roles`, legacy `permissions`, granular `grants`, `permissionRegistry`, `permissionGroups`, `roleScope` and `roleDefinition` |
| GET | appearance | Current theme and allowlisted theme options; approved users only |
| PUT | admin/appearance | Requires `settings.update`; `{theme: "mechlin" \| "midnight" \| "ocean"}`; persisted and audited |
| POST | logout | Revoke current session |
| GET/POST | admin/users | List / provision exact Entra identity; list requires `users.read`, creation requires `users.create` |
| POST | admin/users/:id/approve,reject,disable,reactivate,force-logout,update | Use one action segment; role changes require `roles.assign`, team changes require `users.update` |
| GET | admin/access | Access summary: protected/custom role counts, assignments, elevated roles, unassigned users and recent access changes. Requires `users.read` or `roles.read` |
| GET | admin/permissions | Permission registry and groups. Requires `roles.read` |
| GET/POST | admin/roles | List role definitions / create a custom role `{name, description, scope, permissions[]}`. Scopes: `organization`, `team`, `assigned`, `none` |
| GET/PUT/DELETE | admin/roles/:id | View / update / archive a role. Updates require the last-read `version`; missing versions return 400 and stale versions return 409. System role names, descriptions and scopes are protected; operational system-role permissions can be customized and persist across restarts. System Admin and agency roles remain fully immutable. System roles cannot be archived |
| POST | admin/roles/:id/duplicate | Duplicate a role `{name}`; the copy is always a custom role |
| POST | admin/roles/:id/archive | Archive a custom role `{reason}`; blocked while users are assigned |
| GET | admin/audit?before=ID&limit=N&event=&actor=&q=&from=&to= | Newest first; max 500 records; filter by event substring, exact actor, free-text query, or ISO date bounds; paginate using last returned ID |
| GET/PUT | pipeline | Read / update ordered `stages` list |
| GET/POST | requisitions | Scoped list / create draft |
| GET/PUT | requisitions/:id | Get single requisition / update requisition details (`title`, `team`, `headcount`, `salary_min`, `salary_max`, `currency`, `description`, `skills`) |
| POST | requisitions/:id/submit,approve,reject | One action segment; optional decision `note` |
| GET/POST | candidates | Search with `?q=`, or create |
| GET/PUT/POST | candidates/:id | Get single candidate / update candidate details (`name`, `email`, `skills`, `experience` / `resume_text`, `phone`, `team`, `source`). Interviewers may read only candidates linked to their assigned interviews, with resume text/files, salary and unrelated applications omitted. |
| GET/POST | candidates/:id/communications | List communication history and consent / send email via Resend (`template_id`, `requisition_id`, `subject`, `notes`, `variables`, `idempotency_key`) |
| GET/POST/PUT | candidates/:id/consent | Get candidate consent status / update preferences (`opted_out`, `reason`) |
| GET | candidates/:id/templates | Available email templates and candidate application context |
| POST | resume/upload | Multipart or base64 PDF/DOCX upload, quarantine, scan, text and contact extraction |
| POST | resume/parse | `{text}` plain-text extraction |
| POST | jd/draft | `{title,skills:[],team,context,provider,model}` AI-assisted job description drafting with multi-AI support (OpenAI, Claude, Gemini, Grok) and template assistant fallback |
| GET/POST | applications | Scoped list / `{candidate_id,requisition_id}` |
| GET/POST | applications/:id/match | Explainable candidate-to-requisition match score, skills breakdown, experience/qualification analysis, and attributed evidence with multi-AI provider selection (`provider`, `model`), prompt injection defense, and deterministic fallback (POST re-runs and persists calculation) |
| GET/POST | applications/:id/fraud-review | Candidate fraud and inconsistency review signals for application context (POST re-evaluates or resolves flags) |
| GET/POST | candidates/:id/fraud-review | Consistency and duplicate profile review signals (POST with `{action:"resolve", status, resolution_notes}` records human assessment) |
| POST | fraud-reviews/:id/resolve | Record human assessment decision `{status: "resolved" | "cleared" | "reviewed", resolution_notes}`; logged in audit trail |
| POST | applications/:id/stage | `{stage}` next stage or rejection |
| GET/POST | interviews | List / plan new interview `{application_id, interviewer_id, scheduled_at, competencies:[], duration_minutes, timezone, notes, title, send_invitation}` |
| GET/PUT | interviews/:id | Get single interview / update scheduled interview details, date, duration, notes, interviewer or competencies |
| POST | interviews/:id/cancel | Cancel interview `{reason}`; cancels Microsoft Teams calendar event, updates status, and notifies candidate |
| GET/POST | interviews/:id/scorecards | Blinded application feedback / submit own `{ratings,recommendation,notes}` |
| GET | interviewers | Assignable users visible to recruiter |
| GET/POST | referrals | Own referrals / `{name,email,requisition_id,note}` |
| GET | referrals/:id | Referral details within the caller's permitted scope |
| GET | referrals/:id/requisition | Read-only linked requisition scoped to the referral; salary hidden from employees/interviewers |
| GET | analytics | Team-scoped counts |
| GET | integrations | Status of integration modules |
| GET/POST | agencies | List registered recruitment agencies / register new agency `{name, code, contact_name, contact_email, contact_phone, notes}` (Admin/Recruiter) |
| GET/PUT | agencies/:id | Inspect agency details (recruiters, assigned jobs, submissions) / update agency business info |
| POST | agencies/:id/status | Set agency account status `{status: "active" | "suspended" | "deactivated", reason}` |
| POST | agencies/:id/members | Invite/provision agency recruiter `{name, email, role: "Agency Admin" | "Agency Recruiter"}` |
| POST | agencies/:id/assignments | Assign open requisition to agency `{requisition_id, submission_deadline, sourcing_instructions}` |
| DELETE | agencies/:id/assignments/:reqId | Revoke requisition assignment from agency |
| POST | agencies/submissions/:id/feedback | Publish approved recruiter feedback to agency `{feedback, status}` |
| GET | agency/dashboard | Isolated agency partner dashboard with submission metrics, assigned roles, and recent activity |
| GET | agency/requisitions | List open requisitions assigned to authenticated agency with deadlines and sourcing notes |
| GET | agency/requisitions/:id | Get assigned requisition details (confidential internal fields omitted) |
| POST | agency/submissions | Submit candidate and resume `{requisition_id, name, email, phone, skills:[], resume_text, resume_id, representation_confirmed, notes}` |
| GET | agency/submissions | Track agency candidate submissions and pipeline status |
| GET | agency/submissions/:id | View candidate submission details and approved published feedback |
| GET/POST | agency/members | Agency Admin view / invite recruiters within agency account |
| POST | agency/members/:id/status | Agency Admin suspend or reactivate recruiter access `{status: "active" | "suspended"}` |
| POST | agency/resume/upload | Multi-format resume upload and scan for agency recruiters |
| GET/POST | signatures | List e-signature requests / create new offer signature request `{title, candidate_id, requisition_id, salary, currency, signers:[]}` |
| GET | signatures/:id | Get signature request details, document hashes, and signer statuses |
| POST | signatures/:id/cancel | Cancel active signature request `{reason}` |
| GET | signatures/:id/document | Download original or completed signed document (`?version=original|signed`) |
| GET | admin/integrations | List all 8 supported system integrations, status, capabilities, and fallback policies. Requires `integrations.read`, `integrations.configure` or `integrations.secrets.manage` |
| GET | admin/integrations/:id | Get single integration details with safe configuration and masked secret flags. Requires integration read/configure/secrets access |
| PUT | admin/integrations/:id | Update integration configuration `{config, secrets, removeSecrets, enabled}`. Requires `integrations.configure`; adding, replacing or removing credentials additionally requires `integrations.secrets.manage` |
| POST | admin/integrations/:id/test | Run safe non-destructive connection test with proposed or saved config. Requires `integrations.configure` |
| POST | admin/integrations/:id/toggle | Enable or disable integration `{enabled: true|false}`. Requires `integrations.configure` |

Requisition create/update body: `{title,team,headcount,salary_min,salary_max,currency,description,skills:[]}`. Candidate create/update body: `{name,email,phone,team,skills:[],resume_text,experience,source}`. User provisioning body: `{name,email,oid,tenant,role,team}`. External agency recruiters and admins access dedicated agency portal workspaces with strict boundary isolation and cannot access internal candidate notes, confidential fields, or other agencies' data.

## Roles and permission semantics

The ten legacy capability tokens returned by `GET /api/me` remain for compatibility. Granular permission IDs (for example `candidates.personal.read`, `requisitions.compensation.read`, `roles.assign`, `audit.read`) are authoritative on the server and are returned as `grants`. `can()` accepts both forms, but new role definitions store granular IDs only.

Role record scopes bound reads and mutations: `organization` sees every team; `team` is limited to the user's team; `assigned` is limited to explicitly assigned records such as interviews; `none` grants no record visibility. Field-level checks additionally redact or block candidate contact/resume fields, requisition compensation, and offer compensation or signed-document downloads.

System roles are seeded from `src/policy.js`. Their names, descriptions and record scopes are authoritative and cannot be edited or archived. An administrator with `roles.update` may customize the permission grants of operational system roles such as Recruiter, Hiring Manager and Interviewer; saved customizations survive database restarts and are not overwritten by startup reconciliation. System Admin and agency roles remain fully immutable. Only a System Admin may create or assign organization-scoped roles and assign protected system roles. Non-System-Admin administrators may grant only permissions they already hold. Role updates bump `version`; clients should send the version they read and surface 409 conflicts. Role/permission changes take effect on the next request (no permission cache), and user session versions are revoked when a user's role or team changes.

Public routes: `/health` is a database liveness check, `/webhooks/resend` is the Svix-verified webhook for Resend delivery events, `/auth/login` starts OIDC, `/auth/callback` validates callback, `/sign/:token` is the secure electronic signing portal for candidate offer agreements, `/` serves a non-sensitive application shell. APIs do not expose anonymous candidate intake or public registration.
