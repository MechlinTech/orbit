# Mechlin Orbit — branding and themes

Orbit is the proposed internal product name, replacing the working title TalentOS. It suggests a shared space for people, opportunity and hiring teams. The UI, sign-in page, browser titles, PWA name and icons use Orbit. Existing directory/database/service identifiers stay compatible with the earlier package; no database rename is needed.

## Official company logo

The Mechlin Technologies logo is an unchanged local copy of the logo used on the official Mechlin website, retrieved 2026-09-17:

- Source page: https://mechlintech.com/
- Source asset: https://mechlintech.com/wp-content/uploads/2026/07/site_logo-3.webp
- Bundled path: `public/mechlin-logo.webp`

It appears on the sidebar, sign-in page and Settings brand panel. A white backing preserves the original black lettering in every theme. The corporate logo is not a generated approximation, and loading the ATS does not contact the Mechlin website. The ring/dot icon is a separate Orbit product symbol, not a replacement for the company logo.

## Admin settings

Sign in as System Admin, open **Settings → Appearance**, and choose Mechlin Light, Midnight or Ocean. Selection previews the full interface immediately in the current browser only. **Reset preview** restores the saved appearance. **Save workspace theme** persists the choice for all users and records `admin.appearance_updated` with before/after theme values in the audit log.

The saved theme is present in the initial HTML, so a fresh page and the login screen use the correct theme before JavaScript loads. Existing sessions receive changes on their next in-app page change or refresh. Saving is organization-wide, not a per-user preference. Non-admin roles may read the current theme but cannot modify it. Themes are allowlisted; arbitrary CSS, uploaded code and external asset URLs cannot be saved.

The appearance record is added to the existing `settings` table only when an admin saves. An absent or malformed setting falls back to Mechlin Light. No schema migration is required and existing recruiting records are preserved. All theme mutations require an approved session, System Admin role, CSRF token and the correct origin.

## Visual changes

The refresh introduces a Mechlin-branded sidebar, consistent navigation icons, lighter card/table layouts, clearer approval summaries, candidate initials and skill chips, cleaner pipeline cards, three coordinated color palettes, and a redesigned sign-in page. Screenshots are real browser captures with synthetic data. They are not evidence of a live Microsoft login or production deployment.
