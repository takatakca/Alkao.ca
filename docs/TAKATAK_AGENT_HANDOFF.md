# TAKATAK / ALKAO — Agent handoff

This file records the current cross-agent handoff. Do not erase prior repository history; the detailed chronological log remains in `WORKLOG.md`.

## 2026-10-13 — Run 66: home extras from the benchmark

- Filters on `/`: `prix` (free, under25, 25to50, over50; before taxes), `tri=prix`,
  `organisateur=<brandId>`; unknown values are dropped (`parseQuery` in `src/api/home-view.ts`).
- JSON-LD: one `Event` per date (the next ten), `offers` from `fromCents`; the venue's street
  comes from `listPublicEvents` (`venueAddress`), session ends from `listPublicSessions`.
- `home-ui/home.js`: .ics per date (same rules as `buyer-ui/calendar.js`), map search link,
  « Vus récemment » in `localStorage` `alkao.recent` (cleared by its button), install prompt.
- `home-ui/manifest.webmanifest` + `img/icon-192.png`, `img/icon-512.png`; CSP `manifest-src 'self'`.
- Next on the home: « Suivre cet organisateur » through the newsletter route (Run 44), agenda
  view, accessibility page. Then the benchmark's back-end gaps.

## 2026-10-13 — Run 65: OPC compliance and competitor benchmark

- `docs/ALKAO_COMPETITIVE_FEATURES.md` (French): ALKAO compared with Ticketmaster/Admission,
  evenko, Le Point de Vente, Showpass, Eventbrite, with sources and a ranked list of gaps.
  Verified at the source (opc.gouv.qc.ca, « nouvelles obligations », in force 12 Sept 2026): a
  ticket seller must tell buyers at once of a cancellation or a change of time or place.
- Done in Run 65: the Brand's exchange and refund policy before payment and after, and an
  e-mail to buyers when a session's end time or its venue's name/address changes
  (`src/ops/change-notice.ts`, table `ticketing_session_changes`, e-mail kind `session_changed`).
- A session's start time cannot be edited in the API (only its end); moving buyers goes
  through a session change or a cancellation, which already e-mail them.
- Next gaps, in the benchmark's order: structured event data (category, age, language, doors,
  accessibility) and venue pages, Apple/Google Wallet, ticket transfer, waitlist, follow an
  organizer, presale codes, light buyer account.

## 2026-10-13 — Run 64: premium platform home (alkao.ca)

The home at `/` is now a full ticketing storefront in the GROUPE TAKATAK brand:
- page: `src/api/home-view.ts`, words: `src/api/home-copy.ts` (FR/EN, categories, help topics);
- files: `home-ui/` (style, script, photos, fonts; credits in `home-ui/CREDITS.md`);
- data: `src/api/app.ts` (opted-in Brands only, as in Run 61).

Rules kept: real data only (prices are the lowest active paid admission before taxes; ALKAO adds no
fee), no countdowns or fake scarcity, works without JavaScript, strict CSP (`script-src 'self'`),
WCAG checks in `test/a11y`. The assistant is rule-based, from `help()` and the events on the page:
no AI service and nothing sent anywhere. A Claude-backed assistant would need a server route, a key
in the server settings and a cost decision by the owner.

Next: categories come from words in the event's title and description; a real category field
in `/ops` would be better. Organizers must turn on « Afficher mes événements sur ALKAO » for events
to appear.

## 2026-10-13 — Run 62: ALKAO deployable on Coolify

**Repository:** `takatakca/Alkao.ca`
**Branch:** `claude/amazing-pascal-tppqd4`
**Status:** code and guide in this PR. Tested with the real image, on a local Docker with an empty
PostgreSQL 16: healthy, migrations applied, every database and security line of the go-live
check ✔, clean stop in 0.1 s. **Not deployed on the Coolify server by this PR.**

### What was live on 2026-10-13 (seen from the internet)

| Address | What answers |
|---|---|
| `alkao.ca` | **ALKAO on the Coolify server** (31.220.96.134): the Run 61 home, `/ops`, `/health/ready` with the database up. No Brand shows an event yet. `/health` has no `build` (deployed before Run 62) |
| `promohavana.ca`, `essai.promohavana.ca` | Promo Havana, on Coolify |
| `billets.promohavana.ca` | ALKAO on MochaHost (Passenger). `/health` and `/health/ready` OK, but older code than `main`: `/` answers a JSON 404 instead of the Run 61 home |
| `festi-ice.ca`, `billets.takatak.ca` | No answer |

- **Run 63:** the **Live** workflow (GitHub Actions) re-checks `alkao.ca` every 3 hours
  (`scripts/live-watch.ts`, GET only). On 2026-10-13, `check:golive --url https://alkao.ca`
  showed everything ✔ except Stripe (not configured on the server) and `/metrics` (no token).
- **Promo Havana does not sell through ALKAO yet.** Its `ALKAO_URL` points at
  `billets.takatak.ca`, which has no DNS, and its `ALKAO_CLIENT_ID` and `ALKAO_BRAND_ID` are not
  set. Its ticket button therefore falls back to Weezevent.
- **Secrets:** the values committed in `c75f797` (`.env.example`, public history) must be
  rotated by the owner before any go-live. Never reuse a value from that commit. CI now
  refuses such a commit (PR #72).
- **Database:** that commit also showed ALKAO's `DATABASE_URL` aimed at TAKATAK's Supabase
  project, against the rule that ALKAO has its own database. Moving ALKAO starts with the
  owner's decision on its dedicated database, and on any real orders to carry over
  (`docs/ALKAO_DEPLOY_COOLIFY.md`, "Moving an address from MochaHost").

### What Run 62 adds

- `scripts/container.ts`, the image's entry:
  - with `ALKAO_MIGRATE_ON_START=true`, it migrates before serving (containers take turns);
  - with `ALKAO_RUN_WORKERS=true`, it runs the background jobs every minute;
  - it stops at once on `docker stop`;
  - without these switches, it does what the image did before.
- `supabase/bootstrap/plain_postgres.sql`: the Supabase roles and `auth.uid()` for a
  production plain PostgreSQL. It grants nothing by default and does nothing on Supabase.
  `npm run db:migrate` runs it, so nobody needs the test shim outside tests.
- `/health` shows `build` (the image's commit, or a MochaHost release's `BUILD_ID`), so anyone
  can see which version answers.
- `docs/ALKAO_DEPLOY_COOLIFY.md`.

### Next safe actions, in order (owner)

1. Rotate the keys from `c75f797`.
2. Confirm that the `alkao.ca` application's database is dedicated to ALKAO, never
   TAKATAK's or FESTI-ICE's. If it is not, choose one (a new Supabase project, or PostgreSQL
   in Coolify with backups) before the first real sale.
3. In that Coolify application, after this PR is deployed:
   - turn on `ALKAO_MIGRATE_ON_START=true`, `ALKAO_RUN_WORKERS=true` and "Include source
     commit in build";
   - set the health check to `/health/ready`;
   - pass `check:golive` (`docs/ALKAO_DEPLOY_COOLIFY.md`).
4. Provision Havana (`control:apply`) and connect its Stripe account in `/ops`.
5. In Promo Havana's Coolify settings:
   - set `ALKAO_URL=https://alkao.ca`;
   - set `ALKAO_CLIENT_ID` and `ALKAO_BRAND_ID` to Havana's ids.
6. `billets.promohavana.ca`: point it at the same application, or retire it. Follow the guide's
   "Moving an address from MochaHost", orders first. Then stop the MochaHost application and
   its cron line.
7. A test purchase. Record STAGING VERIFIED or PRODUCTION VERIFIED only with that evidence.

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
