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

Keep origins consistent: `localhost` and `127.0.0.1` are different origins. Production redirects and mutation requests must use precisely the configured HTTPS hostname. Group IDs are case-normalized; team names are not.

There are no AI, mail, calendar, signature or HRMS credentials to configure yet; the later adapter implementations must define and document their settings. No secret is embedded in this package.

Test-only: `BROWSER_PATH` selects the installed Chrome/Chromium executable for `npm run test:browser`. It is not read by the application or required in `.env`.
