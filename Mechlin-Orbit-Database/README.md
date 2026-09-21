# Mechlin Orbit database package

This is a **clean initialized SQLite database for Mechlin Orbit v0.2**, schema version 1. No production database was connected or supplied. This is not a backup of live recruitment data or the temporary screenshot demo. It contains the schema migration record and default recruitment pipeline; all business tables are empty. The appearance defaults to Mechlin Light until an administrator saves a theme.

## Files

- `mechlin-orbit-initialized.sqlite`: standalone consistent binary snapshot created using SQLite VACUUM INTO.
- `schema.sql`: all 14 application tables and two audit triggers, without data. SQLite creates its internal indexes/sequence automatically.
- `initialized-database.sql`: schema plus initialization records; an alternative to the binary snapshot.
- `DATABASE.md`: table and relationship reference from the application.
- `VERIFICATION.txt`: actual restore checks and results.
- `SHA256SUMS.txt`: checksums for the database and SQL exports.

## Restore the binary backup

1. Stop the application. Preserve any existing database directory as a rollback copy.
2. Create a fresh data directory owned by the application service account. Copy `mechlin-orbit-initialized.sqlite` into it as `talentos.sqlite`. Do not mix it with existing WAL or SHM files.
3. Set `DATABASE_PATH` to that file's absolute path in the application environment. The app uses SQLite; no separate database server is required.
4. Verify the file using SQLite `PRAGMA integrity_check;` (expected `ok`) and `PRAGMA foreign_key_check;` (expected no rows).
5. Configure the real Microsoft Entra environment values. With that same DATABASE_PATH set, run the application's `npm run bootstrap -- admin@company.com "Admin Name" ENTRA_OBJECT_ID ENTRA_TENANT_ID` using the actual administrator identity.
6. Start the application and check health and Microsoft sign-in. This export does not add a password or bypass Entra authentication. Live Entra sign-in was not tested.

## Restore from SQL instead

Use a new empty SQLite database. With the optional SQLite CLI, run `sqlite3 /absolute/new-directory/talentos.sqlite` and then `.read /absolute/path/initialized-database.sql`. Do not run both SQL files: the initialized export already includes the schema. Follow steps 3–6 above. The schema-only export is useful for review or a fresh schema; application startup adds the default initialization records.

## Back up a populated deployment later

Set DATABASE_PATH explicitly to the existing deployment database and verify the file exists first. From the application directory, run `npm run backup -- /secure-backups/orbit-YYYY-MM-DD.sqlite`. This creates a new consistent snapshot and refuses to overwrite an existing destination. Never copy only a live SQLite main file while WAL writes are active. Store future backups with access restrictions and encryption because they will contain personal data. Deployment secrets and Entra configuration require separate secure backup; they are not stored in this package.

Validation here covers restoring this initialized database and SQL exports, not a live production restore or external authentication.
