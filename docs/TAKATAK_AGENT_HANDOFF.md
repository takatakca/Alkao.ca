# TAKATAK / ALKAO — Agent handoff

This file records the current cross-agent handoff. Do not erase prior repository history; the detailed chronological log remains in `WORKLOG.md`.

## 2026-10-10 — Run 61 / Issue #69

**Repository:** `takatakca/Alkao.ca`  
**Branch:** `work/alkao-platform-home`  
**Pull request:** #70 — ALKAO platform: independent homepage and Brand opt-in  
**Status:** CODE COMPLETE; CI `qa` must be green before merge. Production is not verified by this handoff.

### What was continued

The repository was inspected before implementation. Runs 1–60 were already merged on protected `main`; the existing Hono/PostgreSQL/RLS/Stripe/scanner/Operations implementation was preserved. The stale PR #53 contains only an old Havana go-live worklog claim and was not used as a code base or modified.

### What Run 61 adds

- Independent server-rendered ALKAO platform homepage at `/`, French-Canadian by default and English via `?lang=en`.
- Public event cards reuse the existing hosted shop. A Brand appears only when it explicitly enables **Afficher mes événements sur ALKAO**.
- Directory opt-in lives on the already tenant-scoped/RLS-protected `ticketing_brand_settings` row and defaults to `false`.
- The server rechecks the existing Client/Brand/entitlement gate and only lists published events whose sales window is open and that have a future on-sale session with remaining capacity.
- `ALKAO_HOME_URL` is an HTTPS-only root redirect for a white-label installation; ALKAO API/Operations routes remain local.
- Semantic SSR output, canonical/hreflang/OpenGraph, Event JSON-LD, HTML escaping, strict CSP and no client-side homepage JavaScript.
- Organizer registration links to the verified TAKATAK V1 `/register` flow; organizer sign-in remains the existing ALKAO `/ops`.
- Operations → Apparence exposes the explicit default-off opt-in.
- Deployment docs require the new migration to run before Passenger is pointed at the Run 61 release.

### Security boundaries preserved

- ALKAO remains independent from the TAKATAK V1 database.
- No changes were made to `takatak-v1`.
- Havana Resort and FESTI-ICE remain separate Clients.
- Public homepage has no mutation capability. When the deployment-wide Ticketing switch is disabled, the homepage renders without merchant events.
- The new setting is a column on an existing RLS-enabled table; no new unprotected public table is created.
- No Brand is auto-published by the migration.

### Validation added

- API homepage tests: default-off, FR/EN, active entitlement, sales window, capacity/session state, opt-out, XSS escaping, JSON-LD, white-label redirect and deployment-switch-off.
- Existing route-gate suite explicitly classifies `GET /` as the intentionally public landing page while preserving gating for every operational route.
- Operations Playwright test saves and verifies the opt-in.
- Axe accessibility suite audits the independent homepage.
- Existing isolation snapshot includes `show_on_alkao`.
- Config tests require HTTPS for `ALKAO_HOME_URL`.

### Deployment status / next safe action

Do **not** call this production-deployed solely because #70 merges. Existing deployment architecture packages a MochaHost/Passenger release from `main`, but the repository currently does not contain a production auto-deploy workflow or confirmed ALKAO cPanel transport secrets. `docs/DOMAINS.md` also still records the `alkao.ca` infrastructure owner/provider as unconfirmed.

After #70 is green and merged:

1. Let the existing Package workflow produce the Linux MochaHost release artifact.
2. Confirm the intended `alkao.ca` cutover/DNS target and the actual cPanel application root.
3. Configure the dedicated ALKAO database and production secrets outside GitHub source.
4. Apply all release migrations **before** activating the new release.
5. Run `npm run check:golive` against the real HTTPS service.
6. Verify `/health`, `/health/ready`, `/`, `/ops`, a real Brand shop and the Stripe test/live mode expected by the approved go-live plan.
7. Enable Brand directory opt-in only after the Brand owner intends publication.
8. Record STAGING VERIFIED / PRODUCTION VERIFIED only with evidence.

If deployment automation is added later, keep it in a separate reviewed PR and reuse the release/rollback model already documented in `docs/ALKAO_DEPLOY_MOCHAHOST.md`.
