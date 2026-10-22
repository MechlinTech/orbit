# Security audit — 2026-10-22

Scope: full repository (frontend, backend, scripts, CI/CD, containers, editor
configuration, binary assets and dependencies).

## Confirmed malicious components (removed)

### 1. `api.js` — obfuscated blockchain C2 dropper / loader

- 18.6 KB, four lines, base64-encoded string array unpacked with `eval(atob(...))`
  plus `_0x…` identifier obfuscation.
- Resolves a command-and-control IP from Ethereum mainnet transaction data
  (hard-coded sender `0x1eEf0849EDa15d87f64e51C73C8442Cf3c8bCEF3`, queried via
  `eth.blockscout.com` and public RPC endpoints such as `1rpc.io`, `eth.drpc.org`,
  `ethereum-rpc.publicnode.com`, `eth-mainnet.public.blastapi.io`).
- Fetches second-stage code from `http://<ip>:443/0x/cls` and `/0x/ls`,
  XOR-decodes the response (or the `X-Payload-B64` header), then `eval`s it and
  spawns detached, hidden `node -e` child processes.
- Executed automatically by `npm start` because `package.json` chained
  `node api.js && node src/server.js`.

### 2. `public/fonts/fa-solid-700.otf` — payload disguised as a font

- 18,547 bytes beginning with the same JavaScript payload instead of the
  required `OTTO` OpenType signature.
- Executed on IDE folder-open by `.vscode/tasks.json`, not by the application.

### 3. `.vscode/tasks.json` — hidden auto-execution

- A task labelled `eslint-check`, marked `isBackground`, `hide`, no echo, and
  `"runOn": "folderOpen"`, running
  `node ./public/fonts/fa-solid-700.otf` on both Windows and Unix shells.

### 4. `.vscode/settings.json` — automatic task permission

- `"task.allowAutomaticTasks": true` plus an inline `runOn: folderOpen` task
  (`npm run lint`) and `terminal.integrated.hideOnStartup: "always"`.

## Exposed credential (not in git history)

`ENTRA_CLIENT_SECRET` was stored in plaintext in the untracked `.env.dev` and
`.env.prod` files. The value has been replaced with
`REPLACE_WITH_ROTATED_SECRET`. The secret was never committed (`git log -S`
found no match) but must still be treated as compromised: if `npm start` ever
ran the dropper, any file readable by that user — including `.env*` — was
reachable by the attacker.

**Rotate immediately** in Entra ID, then update the deployment secrets:

1. Entra admin centre → App registrations → the Orbit app → Certificates &
   secrets → delete the exposed secret → create a new one.
2. Update the `ENTRA_CLIENT_SECRET` repository/environment secret in GitHub.
3. Update local `.env` files; never commit them.
4. Review Entra sign-in logs and the app's audit log for unexpected use.
5. Because the dropper executes arbitrary second-stage code, also rotate the
   Docker Hub token and any other secret available on hosts where the project
   was started.

## Files modified

| File | Change |
|---|---|
| `api.js` | Deleted |
| `public/fonts/fa-solid-700.otf` | Deleted |
| `.vscode/tasks.json` | Deleted |
| `.vscode/settings.json` | Disabled automatic tasks; removed inline folder-open task and hidden terminal setting |
| `package.json` | `start` no longer chains `api.js`; added `scan:security`; `check` now runs the scanner |
| `scripts/check.js` | Walks the whole tree instead of four hard-coded directories |
| `scripts/security-scan.js` | New repository-wide scanner (obfuscation, C2, loader, binary/extension mismatch, editor auto-run, start-script tampering) |
| `.github/workflows/test.yml` | Added security scan, `npm ci --ignore-scripts`, `persist-credentials: false`, SHA-pinned actions |
| `.github/workflows/deploy.yml` | `npm ci --ignore-scripts`, `persist-credentials: false`, SHA-pinned actions |
| `Dockerfile` | Creates data/backup dirs owned by `node`; `--ignore-scripts` on installs |
| `docker-compose.prod.yml` | Read-only root FS, `no-new-privileges`, drop all capabilities, `tmpfs /tmp`, log rotation |
| `.gitignore` | Ignores `.env.deploy`, logs, whole `backups/` |
| `.env.dev`, `.env.prod` | Exposed secret replaced with placeholder |
| `FILE_MANIFEST.sha256` | Hashes refreshed; scanner added |

## Preventive controls

- `npm run check` now runs the security scanner; CI runs it on every push/PR.
- Scanner rejects wrong-magic binary assets (a renamed `.otf`/`.png` payload).
- Scanner rejects editor tasks that auto-run on folder open and any script that
  executes a font/image as JavaScript.
- Scanner rejects root-level entrypoint chaining in `package.json`.
- Actions are pinned to immutable commit SHAs and checkout credentials are not
  persisted.
- Zero runtime npm dependencies; installs use `--ignore-scripts`.

## Verification

- `npm run check`: PASS (20 JS syntax checks, security scan clean).
- `npm test`: 63/63 passing.
- No `node.exe` processes or network connections matching the loader were
  present on the audit host.

## Residual risk / required follow-up

1. **Rotate the Entra secret** (above) — this cannot be done from the codebase.
2. **Purge git history.** Removing the files in a new commit does not remove
   the malicious blobs from history or from the remote. After committing the
   removal, rewrite history (`git filter-repo --path api.js --path
   public/fonts/fa-solid-700.otf --path .vscode/tasks.json --invert-paths`) and
   force-push all affected branches, then ask every clone to re-clone. If the
   repository was shared, treat it as an incident.
3. **Audit hosts that ran `npm start`** for persistence (scheduled tasks,
   Run keys, unusual `node -e` processes) and outbound connections.
4. Enable secret scanning/push protection and branch protection on GitHub.
5. The clean `main` branch already has the feature-level fixes, but it also adds
   an optional demo login that defaults to enabled; review it before merging and
   set `ENABLE_DEMO_LOGIN=false` in production.
