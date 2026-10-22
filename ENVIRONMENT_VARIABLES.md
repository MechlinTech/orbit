# Environment variables

Use `node --env-file=.env src/server.js` locally, systemd `EnvironmentFile`, or Compose `env_file`. Node does not load `.env` automatically through `npm start`. A `.env.example` is supplied with every application variable.

| Variable | Default | Requirement / meaning |
|---|---|---|
| NODE_ENV | unset | Set `production` for production startup validation |
| APP_ORIGIN | `http://localhost:3000` | Exact bare origin; HTTPS required in production; used for redirects and CSRF origin checks |
| HOST | `127.0.0.1` | Listen address; container uses `0.0.0.0` internally with loopback host publication |
| PORT | `3000` | TCP listen port |
| DATABASE_PATH | `data/talentos.sqlite` | Local persistent SQLite file; same path for server/bootstrap/backup |
| ENTRA_TENANT_ID | empty | Organization tenant GUID; no common/multi-tenant endpoint |
| ENTRA_CLIENT_ID | empty | Entra app registration client GUID |
| ENTRA_CLIENT_SECRET | empty | Confidential server-side secret; required for sign-in and production startup |
| ALLOWED_DOMAINS | empty | Comma-separated exact email domains; required in production |
| ALLOWED_GROUP_IDS | empty | Optional comma-separated group object IDs; at least one must appear in validated claims |
| SESSION_SECONDS | `28800` | Absolute session lifetime, integer from 300 to 86400 |
| ENABLE_DEMO_LOGIN | `true` | Set `false` to disable demo/QA login button and endpoints |
| MAX_RESUME_SIZE_BYTES | `5242880` | Maximum upload size for PDF/DOCX resumes (default 5 MB) |
| RESUME_STORAGE_DIR | `data/resumes` | Local directory for quarantined and approved resume files |
| ANTIVIRUS_PROVIDER | `none` | Antivirus provider (`clamav` or `none`) |
| ANTIVIRUS_REQUIRED | `false` | Required in production; when true, rejects uploads if scanner is unavailable |
| CLAMAV_HOST | `127.0.0.1` | ClamAV TCP daemon host for INSTREAM scanning |
| CLAMAV_PORT | `3310` | ClamAV TCP daemon port |
| CLAMAV_TIMEOUT_MS | `5000` | ClamAV socket timeout in milliseconds |
| RESEND_API_KEY | empty | Resend API key for recruitment candidate communications |
| EMAIL_FROM | empty | Canonical sender address (e.g. `Orbit Recruiting <recruiting@example.com>`) |
| RESEND_FROM_EMAIL | empty | Alternate sender address accepted for Rankly compatibility |
| RESEND_WEBHOOK_SECRET | empty | Svix webhook secret for delivery, bounce, and failure tracking verification |
| TEAMS_ORGANIZER_EMAIL | empty | Microsoft 365 organizer mailbox email hosting Teams interview calendar events |
| ENABLE_TEAMS_CALENDAR | `true` | Toggle Microsoft Teams calendar integration (set `false` to disable) |
| AI_DEFAULT_PROVIDER | `openai` | Default AI provider when multiple are configured (`openai`, `anthropic`, `gemini`, `grok`) |
| AI_PROVIDER_API_KEY | empty | Generic / legacy OpenAI API key; when empty, system checks provider-specific keys or falls back to deterministic operations |
| AI_PROVIDER_URL | `https://api.openai.com/v1/chat/completions` | Custom API endpoint for OpenAI or generic completion provider |
| AI_MODEL | `gpt-4o-mini` | Generic model identifier for candidate matching and JD drafting |
| AI_TIMEOUT_MS | `8000` | AI request timeout in milliseconds before falling back to deterministic operations |
| OPENAI_API_KEY | empty | OpenAI API key for matching and JD drafting |
| OPENAI_MODEL | `gpt-4o-mini` | OpenAI model identifier |
| OPENAI_API_URL | `https://api.openai.com/v1/chat/completions` | OpenAI API endpoint |
| ANTHROPIC_API_KEY | empty | Anthropic Claude API key |
| ANTHROPIC_MODEL | `claude-3-5-sonnet-20241022` | Anthropic model identifier |
| ANTHROPIC_API_URL | `https://api.anthropic.com/v1/messages` | Anthropic Messages endpoint |
| GEMINI_API_KEY | empty | Google Gemini API key |
| GEMINI_MODEL | `gemini-1.5-flash` | Google Gemini model identifier |
| GEMINI_API_URL | `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` | Google Gemini generateContent endpoint |
| GROK_API_KEY | empty | xAI Grok API key |
| GROK_MODEL | `grok-2-latest` | xAI Grok model identifier |
| GROK_API_URL | `https://api.x.ai/v1/chat/completions` | xAI Grok completions endpoint |
| ENABLE_FRAUD_REVIEW | `true` | Set `false` to disable candidate consistency and fraud review signals |
| INTEGRATION_ENCRYPTION_KEY | empty | Dedicated 256-bit encryption key or passphrase used to encrypt integration secrets at rest via AES-256-GCM. Falls back to `APP_SECRET` if unset. |

Keep origins consistent: `localhost` and `127.0.0.1` are different origins. Production redirects and mutation requests must use precisely the configured HTTPS hostname. Group IDs are case-normalized; team names are not.

Resume ingestion (Phase 1), candidate email communications (Phase 2 with Resend integration), Microsoft Teams interview scheduling (Phase 3 with Microsoft Graph integration), explainable matching & fraud review (Phase 4), and Multi-AI integration (Phase 5 with OpenAI, Anthropic Claude, Google Gemini, and xAI Grok) are operational. No secret is embedded in this package.

Test-only: `BROWSER_PATH` selects the installed Chrome/Chromium executable for `npm run test:browser`. It is not read by the application or required in `.env`.
