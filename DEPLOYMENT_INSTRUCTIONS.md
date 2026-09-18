# Deployment instructions

## 1. Prepare the host

Use a supported Linux physical server, VM or Windows development machine with Node 22.17.1. The source was tested on Windows with this version. Linux/container instructions are supplied but were not executed here. There are no package dependencies to install. Run `npm test` and `npm run check` from this directory before deployment.

Use a dedicated operating-system account and an encrypted local disk. SQLite must live on a local filesystem, not NFS/SMB. Start with one application process and one host. Use the backup script before upgrades.

## 2. Register Microsoft Entra

1. Create a single-tenant app registration in the organization’s Entra tenant. Use the **Web** platform and redirect URI `https://YOUR-INTERNAL-HOST/auth/callback`.
2. Record the tenant GUID and application/client GUID. Create a confidential client secret with a rotation owner/date. Keep it server-side.
3. Configure `.env` from `.env.example`. Set the bare HTTPS `APP_ORIGIN`, IDs, secret and comma-separated `ALLOWED_DOMAINS`. For local development use `NODE_ENV=development` and `APP_ORIGIN=http://localhost:3000` with a separately registered localhost callback.
4. If using group restrictions, emit group object-ID claims for the application and set `ALLOWED_GROUP_IDS`. Missing group claims and group-overage responses fail closed; Graph group expansion is not implemented.
5. Enforce MFA/conditional access and enterprise-app assignment in Entra. TalentOS requests only `openid profile email`; it does not request calendar/mail scopes in this phase.
6. Restrict the deployed host to the organization’s private network/VPN. Authentication protects all API data; network controls make the deployment internal-only.

Implementation reference: [Microsoft authorization code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow). Code verification is local only; no credentials or tenant access were provided.

## 3. Bootstrap administrator

Choose a real administrator’s Entra **user object ID**, not their app client ID. From the directory containing this project, run with the same database path that the server will use:

```sh
node --env-file=.env scripts/bootstrap.js admin@company.com "Admin Name" USER_OBJECT_GUID TENANT_GUID
```

This script refuses a second bootstrap if any System Admin exists. It inserts an approved identity and an audit record. A Microsoft sign-in with the matching tenant/object ID is still mandatory. Email is not used to take over or link identities.

For Docker, bootstrap the persistent volume before starting:

```sh
docker compose build
docker compose run --rm app node scripts/bootstrap.js admin@company.com "Admin Name" USER_OBJECT_GUID TENANT_GUID
docker compose up -d
```

Use `docker compose config` to validate locally before running. Docker was not available in the build environment, so these commands remain a deployment validation gate.

## 4. Run

Native development/staging:

```sh
node --env-file=.env src/server.js
```

Production: use the systemd example or Compose with Caddy/Nginx in front. The app binds to loopback by default; Docker publishes only loopback port 3000. Do not expose port 3000 directly. Terminate TLS with your organization’s certificate infrastructure. Never trust arbitrary forwarded host headers; the app uses configured `APP_ORIGIN` for redirects and origin validation.

## 5. Acceptance before real candidate data

- Bootstrap admin signs in using real Microsoft credentials; MFA/conditional-access requirements are enforced by Entra.
- An unapproved employee receives a pending notice and cannot access API records.
- Admin approves, rejects, disables, reactivates and forces logout; existing sessions are invalidated.
- Three distinct users complete requester, manager and finance approval steps.
- Cross-team requests are denied; assigned interviewers cannot see others’ feedback until submitting their own.
- Test HTTPS, trusted certificates, mobile install, keyboard navigation and a backup restore on the target host.
- Run security review, dependency/runtime patch review, penetration testing and load testing; finish retention/privacy operations before production use.

The pinned Docker runtime matches the tested version, not a claim that it contains all current security patches. Review the currently supported patched Node 22 image, pin its digest and rerun the suite before production.
