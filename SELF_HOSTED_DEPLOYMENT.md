# Physical server / self-hosted deployment

## Supported topology

Browser on corporate network/VPN → HTTPS Caddy or Nginx → one Node process → local SQLite database. Outbound HTTPS to `login.microsoftonline.com` is required for Microsoft authentication and signing keys. No AWS, Azure hosting, Google Cloud, Redis, S3 or managed database is required. The identity provider itself is Microsoft Entra as requested.

Recommended starting allocation for a small internal pilot: 2 CPU cores, 4 GB RAM and encrypted SSD storage with enough room for database growth and backups. These are planning estimates, not benchmarked capacity. Load-test with your expected concurrency before committing to production.

## Linux native service

1. Create a dedicated `talentos` OS account with no interactive login. Install a vetted Node 22 runtime at `/usr/bin/node` or update the service path.
2. Place read-only application files at `/opt/talentos`; create `/var/lib/talentos` writable by `talentos`, mode 0700.
3. Create `/etc/talentos.env` with mode 0600 and `DATABASE_PATH=/var/lib/talentos/talentos.sqlite`, `HOST=127.0.0.1`, `PORT=3000` and the Entra/HTTPS configuration. Do not put secrets into source control.
4. Bootstrap the exact initial administrator using the configured database as the service OS user.
5. Install `deploy/talentos.service` in `/etc/systemd/system`, reload systemd, enable and start the service. Verify `/health` over loopback.
6. Configure Caddy from `deploy/Caddyfile` or equivalent Nginx. Restrict HTTPS ingress to LAN/VPN addresses; block 3000 externally. Set a 128 KB request-body limit and an upstream timeout around 20 seconds in your reverse proxy.
7. Use an internal CA or a publicly trusted certificate for the internal DNS name. For Caddy internal PKI, distribute the root CA through your organization’s device management. Do not disable TLS verification.

## Docker option

Compose provides a non-root app, read-only container filesystem, isolated writable database volume, no capabilities and a health check. Run the reverse proxy on the host. Do not scale the app service to multiple instances against this SQLite file. The initial named volume inherits the image data-directory ownership; verify that UID 1000 can write the mounted volume on your runtime.

## Backups and restore

`npm run backup -- /secure-backups/talentos-YYYY-MM-DD.sqlite` uses SQLite `VACUUM INTO` to take a consistent snapshot. Set `DATABASE_PATH` explicitly if different from `data/talentos.sqlite`. The backup contains candidate PII and must be encrypted, access-controlled and copied off-host under your retention policy. Snapshotting only the main SQLite file while the app is running is unsafe because writes may be in WAL.

For restore: stop the app; keep the old data directory intact as a rollback copy; restore the verified snapshot into a fresh data directory with service ownership; point `DATABASE_PATH` there; start the app; inspect `/health`, user access and representative records. Do not combine a restored main file with old WAL/SHM files. Validate `PRAGMA integrity_check` and run a quarterly restore rehearsal. The automated test suite verifies a snapshot/reopen cycle, not your off-host backup system.

## Operations

Monitor health, disk utilization, failed authentication/authorization events, backup age and certificate/secret expiry. Protect and rotate reverse-proxy access logs; callback query strings can contain authorization codes, so configure query-string redaction or exclude `/auth/callback` from access logging before production. Node error logs exclude request bodies/tokens. The application limiter uses socket IP; behind a loopback proxy it is shared across users. Implement per-client edge limits at your proxy and tune aggregate auth limits for your workforce.

For upgrades: take a snapshot; stop the app; deploy reviewed source/runtime; run tests; start one process; run smoke tests. Schema v1 is idempotent. Future schema changes require versioned forward migrations and a documented rollback/restore plan.

## Windows

The application and tests run on Windows Node 22.17.1. For a Windows production server, run under a dedicated service account using your approved service manager, put the database on a local encrypted volume, and use an approved TLS reverse proxy. A Windows service wrapper is not bundled or validated.
