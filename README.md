# ALKAO — TAKATAK Ticket Hub

ALKAO is the standalone, detachable ticketing engine of GROUPE TAKATAK. Each TAKATAK Client
(for example Havana Resort or FESTI-ICE) uses it as a separate tenant: its own catalog,
inventory, buyers, orders, tickets, permissions and finances.

GROUPE TAKATAK V1 (`takatak-v1`) stays the master control plane: identity, Clients, Brands,
memberships, entitlements, platform billing and the dashboard shell. ALKAO never reads the
TAKATAK database. It keeps local projections, which TAKATAK updates through a signed,
versioned control contract.

## Public venue calendar — Run 75

Each published, opted-in ALKAO venue has a bilingual event page and a real
**Ajouter les événements au calendrier / Add events to calendar** link.
It downloads `/salles/:clientId/:brandId/:venueId/agenda.ics` (text/calendar,
UTF-8). The feed contains only current public sessions, stable calendar IDs,
times in UTC, place details and public purchase URLs. It never exposes tickets,
buyers or private events. The link returns 404 if the venue is no longer public.
Previously imported entries can remain in third-party calendar apps.

## Development continuity

- [Project status](docs/PROJECT_STATUS.md), [task queue](docs/TASK_QUEUE.md),
  [agent handoff](docs/AGENT_HANDOFF.md), [deployment](docs/DEPLOYMENT.md)
  and [decisions](docs/DECISIONS.md).
- The detailed prior record remains in [TAKATAK agent handoff](docs/TAKATAK_AGENT_HANDOFF.md)
  and [WORKLOG.md](WORKLOG.md).
- Successful CI and a MochaHost package do not establish a Coolify deployment. Check the
  independent `Verify deployment` workflow and the live service's `/health` build SHA.

## Stack

- Node 22 and TypeScript (strict)
- PostgreSQL with Supabase-compatible RLS; SQL migrations in `supabase/migrations`
- Hono HTTP API (`alkao.api.v1`), `pg`, Zod, `jose` (Supabase Auth tokens)
- Stripe Connect direct charges with the TAKATAK commission as the application fee (`stripe`)
- Vitest, tested against local ephemeral PostgreSQL only

## Layout

| Path | Contents |
|---|---|
| `src/domain` | Pure rules: money, Québec taxes, cart rules, quotes, commission and refund policy, state machines, entitlement gate, role permissions |
| `src/db` | Pool, transactions, migration runner, inventory/order primitives, catalog, control-contract projections |
| `src/contracts` | API v1 request schemas and the `alkao.control.v1` contract |
| `src/api` | Hono app: public, admin and control routes, gates, auth, signatures |
| `src/payments` | Payment gateway interface, Stripe implementation, checkout, webhook and refund service |
| `src/ops` | Hold sweeper, sales reports, CSV exports, Flex Météo exchange (Run 04) |
| `ops-ui/` | Standalone Operations web app served at `/ops` (Preact + htm, no build step) |
| `src/delivery`, `buyer-ui/` | Buyers' tickets email (outbox, Resend, worker) and the buyer's tickets page at `/billets` (Run 06) |
| `shop-ui/` | Hosted ticket shop at `/acheter/<clientId>/<brandId>[/<eventId>]` (Run 08) |
| `home-ui/` | The platform home's style, script, photos and fonts, served at `/assets/home/` (Run 64; the page itself is `src/api/home-view.ts`) |
| `src/api/venue-view.ts` | Public FR/EN venue directory `/salles` and tenant-scoped venue details (Run 73), in the home's look with photo heroes and a gallery (Run 90); lists only events already approved for the ALKAO platform home |
| `src/ops/events-import.ts`, `catalogs/` | `npm run events:import`: one Brand's event (venue, dates, ticket types) from a file, safe to re-run (Run 91). Havana's Halloween catalog and owner steps: [docs/HAVANA_SUR_ALKAO.md](docs/HAVANA_SUR_ALKAO.md) |
| `src/credentials`, `src/scanner` | Ed25519 QR credentials (`ALK1`), derived per-Client keys, scanner manifest and gate scans |
| `contracts/` | Published JSON Schema of `alkao.control.v1` (generated; drift-tested) |
| `supabase/migrations` | Schema. Every `ticketing_*` table enables RLS in the migration that creates it |
| `supabase/tests/supabase_shim.sql` | Local test stand-in for Supabase roles, `auth.uid()` and default grants |
| `supabase/bootstrap/plain_postgres.sql` | Production: the Supabase roles and `auth.uid()` on plain PostgreSQL, no default grants; run by `npm run db:migrate`, does nothing on Supabase |
| `test/` | Domain, RLS, invariant and migration-rule tests |
| `docs/` | Capability status, [API v1](docs/ALKAO_API_V1.md), [control contract v1](docs/ALKAO_CONTROL_CONTRACT_V1.md), [credentials and gates](docs/ALKAO_SCANNER_V1.md), [go-live](docs/ALKAO_GO_LIVE.md), [MochaHost](docs/ALKAO_DEPLOY_MOCHAHOST.md) and [Coolify](docs/ALKAO_DEPLOY_COOLIFY.md) hosting, [runbook](docs/ALKAO_RUNBOOK.md) |

## Run the checks

```bash
npm ci
npm run db:local:start   # ephemeral PostgreSQL on 127.0.0.1:54329
npm run qa               # typecheck + static migration RLS rules + all tests
npm run db:local:stop
```

Run the server (it starts **disabled**: `ALKAO_OPERATIONAL_API_ENABLED=false`):

```bash
cp .env.example .env    # then fill DATABASE_URL, auth and control keys
npm start
npm run worker:sweeper  # expires lapsed holds every minute
npm run worker:email    # sends buyers their tickets (needs RESEND_API_KEY, ALKAO_EMAIL_FROM, ALKAO_PUBLIC_URL)
npm run worker:cancellations  # finishes session cancellations and retries refunds (needs Stripe)
npm run check:golive    # read-only go-live check: settings, database, and --url for the running service
npm run cron            # every worker once, for a cron job every minute (MochaHost, Run 39)
npm run customers:import -- --client <uuid> --brand <uuid> report.csv@2026-10-02  # customer history (Run 41)
```

Operations app: open `http://localhost:8787/ops` and sign in with a Supabase account that has a
TAKATAK membership (set `SUPABASE_URL` and `SUPABASE_ANON_KEY`). See
[docs/ALKAO_OPERATIONS_APP.md](docs/ALKAO_OPERATIONS_APP.md).

## Security rules (frozen)

- No `ticketing_*` table exists without RLS in the same migration.
- `anon` has no grants and no policies. `authenticated` gets SELECT only, through membership
  policies. Buyer data and order money are visible to owner, admin and manager only.
- No write policies: all writes go through the ALKAO server.
- Ticketing is disabled by default. Every operational route checks, server-side, the
  deployment switch, the Client and Brand status, and the TAKATAK Ticketing entitlement for
  that exact Client and Brand.
- Every business-scoped record carries both `client_id` and `brand_id`. Composite foreign
  keys stop a record from referencing another tenant's parent.

## Roadmap

| Run | Scope |
|---|---|
| Run 01 | PR 1 capability status · PR 2 domain, schema, RLS, invariants · PR 3 API contracts and entitlement gates |
| Run 02 | Stripe Connect onboarding, checkout (direct charges, application fee), webhooks, refunds with the V1 commission policy |
| Run 03 | Signed QR credentials (`ALK1`: stable ids and key id only), key rotation, scanner manifest, online and offline scans with single admission |
| Run 04 | Operations: hold sweeper, sales reports, CSV exports, Flex Météo exchange, standalone Operations app (`/ops`) |
| Run 05 | `/ops` embedded in the TAKATAK dashboard: postMessage session handover. The TAKATAK side is an add-only PR, off by default, with no database change |
| Run 06 | Buyers get their tickets: tickets email queued at payment (worker, retries, never twice), personal `/billets` page with QR codes and self-service Flex Météo |
| Run 07 | `npm run control:apply`: set up Clients, Brands, staff and Ticketing from a plan through the signed control contract, before or without the TAKATAK publisher. [Go-live checklist](docs/ALKAO_GO_LIVE.md) |
| Run 08 | Hosted ticket shop `/acheter`: sessions, quantities, server quote with TPS/TVQ, seat hold with countdown, Stripe Checkout, resume or free seats, then `/billets` |
| Run 09 | Offline gate scanning in `/ops`: manifest stored on the device, Ed25519 checked with WebCrypto, queued scans synced in batches, double entries across gates reported |
| Run 10 | Session cancellation by the organizer: sales stop, every buyer refunded in full (commission included) exactly once with retries, free tickets voided, "Séance annulée" email, late payments refunded |
| Run 11 | Signed `POST /v1/control/state` for reconciliation: the TAKATAK sync reads what ALKAO holds and sends only the differences, removals included |
| Run 12 | Refund emails (staff refunds, late payments), one rotatable personal link per order, `/widget.js` buy button for Brand websites |
| Run 13 | Security review ([report](docs/ALKAO_SECURITY_REVIEW.md)): tenant isolation sweep over every route, body limits, API security headers, proxy-aware rate limiting, production-only HTTPS framing, offline list expiry |
| Run 14 | Order search (reference, email, name), live gate counter, `/health/ready`, request logs without ids or PII, Docker image and local `docker compose` stack |
| Run 15 | Sales-rush stress tests through the real API: no overselling under 200 concurrent buyers, single fulfilment of duplicated webhooks, single payout for double-clicked refunds, exchanges and cancellations |
| Run 16 | English for buyers: shop, `/billets` and emails in French by default or English on request (`?lang=en`, switch, browser), the buyer's language kept for later emails, `data-lang` on the website button |
| Run 17 | Accessibility: axe-core WCAG 2.1 AA audit of every buyer and staff page in light and dark mode; dark-mode contrast fixed in all three apps |
| Run 18 | Volume: indexed order search (reference, email, part of the name), period reports and email worker lookups stay on their indexes at tens of thousands of tickets |
| Run 19 | Stripe disputes (chargebacks) and refunds made directly in Stripe: recorded, audited and shown to staff, with gate entry times as evidence; nothing moves on its own |
| Run 20 | Québec Law 25: export a buyer's data, anonymize a buyer (owner, admin) without touching amounts, tickets or reports |
| Run 21 | "À traiter": everything waiting on staff in one list; cancel tickets without a refund |
| Run 22 | At the gate without a QR code: find the order by reference (no buyer data for gate staff), admit by hand under the scan rules |
| Run 23 | Reminder email during the 24 hours before the session, on or off per Brand |
| Run 24 | `GET /metrics` for monitoring (token, platform-wide counts only), retry button for stuck refunds, [incident runbook](docs/ALKAO_RUNBOOK.md) |
| Run 25 | Isolation sweep extended to every route of Runs 18–24, with a mutation check; security review addendum |
| Run 26 | Sales by period (today, 7 days, month, last month) and by day, with TPS and TVQ, refunds on their own day and commission; CSV for the accountant |
| Run 27 | "Retrouver mes billets" on the shop: the tickets are sent again to the address that bought them; same answer whatever the address, rate-limited |
| Run 28 | Duplicate an event: a draft copy with the same ticket types, and its sessions moved by N days when asked |
| Run 29 | Sessions in bulk: a season of start times (dates, weekdays, every N minutes) in the venue's time, preview first, existing times skipped; upcoming sessions on sale or paused at once |
| Run 30 | Audit journal for owners and admins (filters, paging that skips nothing, the actor's role) and each order's history; read through new indexes |
| Run 31 | "Ajouter à mon calendrier" on the tickets page: an `.ics` file made in the browser, without the personal link |
| Run 32 | Stripe test mode said out loud: a banner in the shop and a badge in `/ops` with `sk_test_` keys, gone with live keys |
| Run 33 | The gate hears and feels each answer: one beep and buzz when a ticket is let in, two otherwise; on or off per device |
| Run 34 | Owner decisions recorded in [ALKAO_DECISIONS.md](docs/ALKAO_DECISIONS.md). A dispute the buyer wins cancels the tickets nobody has used; a partial one waits in "À traiter" |
| Run 35 | Door sales: "Vente à la porte" opens the shop on the staff device, today's sessions only, card through Stripe (same commission), tickets on screen, next sale |
| Run 36 | Promo codes per event: percentage or amount off before taxes (commission on the discounted subtotal), uses counted by the database, dates, on or off; shop field, staff screen, reports |
| Run 37 | "Billet ouvert": an admission type whose date the buyer can change as often as needed, with the whole group, until a ticket has entered; a seat is always held; off by default per type |
| Run 38 | `npm run check:golive`: one read-only go-live check of the settings, the database (migrations, RLS and grants, setup, workers) and the running service (HTTPS, Stripe mode and webhook, sign-in, a Brand's shop), in French, never printing a secret |
| Run 39 | MochaHost hosting next to TAKATAK ([guide](docs/ALKAO_DEPLOY_MOCHAHOST.md)): Passenger startup file `passenger.cjs`, a ready Linux release built by the **Package** workflow (`npm run pack:mochahost`), `npm run cron` for the background work, verified TLS to Supabase, and a check that ALKAO sees each buyer's address |
| Run 40 | `/ops` in the TAKATAK dashboard's look: dark 260 px sidebar, light grey page, white slate cards, indigo buttons, orange brand tile; inside the TAKATAK dashboard no second sidebar (tabs in the top bar); roles in French; light and dark at WCAG AA |
| Run 41 | The customer file (CRM): Réservation camping.ca reports imported (read in the browser, no comments, plates, payments or card numbers), one customer per person, visits counted, colours by frequency (Fidèle, Régulier, Occasionnel…), season status, e-mail permission under the anti-spam law, CSV export, Law 25 anonymization; `/ops` **Clients** page and `npm run customers:import` for the history |
| Run 42 | E-mail campaigns to the customer file under Canada's anti-spam law: only customers who may receive them, once per address; sender's address and contact in every footer; one-click unsubscribe (`/desabonnement`, List-Unsubscribe); `{prénom}`, image and button; test, send to the number shown, stop; sent by the e-mail worker or `npm run cron`; `/ops` **Campagnes** |
| Run 43 | Ticket buyers join the customer file by themselves: each paid order is a "ticket" booking on the buyer's customer (same matching as the imports), moved by a session change, cancelled by a full refund or a cancelled session; anonymizing a buyer clears that customer too |
| Run 44 | Newsletter sign-up confirmed by e-mail (double opt-in): a website posts the address, ALKAO e-mails a signed link, the person's click on `/inscription` records express consent and shows the welcome code (e.g. HAVANA5); limits per address and per Brand; placeholder e-mails now matched on the whole address, so `nathalie@…` is kept |
| Run 45 | Automatic e-mail after each visit: N days after a stay or a ticket ends (chosen kinds of visit), a thank-you with a review link or a return offer and `{visite}`; once per visit, never twice in 7 days to one address, never about visits before it was turned on; on, pause, stop |
| Run 46 | Campaigns by text message through Twilio: mobiles with implied consent and no STOP, once per number; the Brand and "Répondez STOP" in every text (plain hyphen, so one text stays one text); 9:00–21:00 only; Twilio's signed webhook records STOP and START; live preview and cost in `/ops` |
| Run 47 | `check:golive` also covers the customer file and marketing: an incomplete Twilio setup, a welcome code that does not exist as a promo code, campaign e-mails, texts or sign-up confirmations that are late; go-live guide step 6 |
| Run 48 | E-mails that do not arrive: Resend's signed webhook records hard bounces, suppressions and spam complaints; those addresses leave every audience (in every Brand's file, the sending address being shared), waiting messages to them are skipped, a ticket e-mail that bounced shows in "À traiter"; a campaign past 4 % bounces or 3 complaints is held until staff resume it; campaign e-mails go out at most `ALKAO_CAMPAIGN_EMAILS_PER_HOUR` (300) an hour; a new address clears a bounce |
| Run 49 | Add-ons the way a resort sells them: up to one per person, exactly one per person, or any quantity; a stock per session reserved by the cart, sold with the payment, back on expiry or full refund (`add_on_sold_out`), shown as "only N left" in the shop; created off sale until the price is confirmed, price and stock edited in `/ops`; each order keeps the ad's UTM tags (`attribution`) for the new "par provenance" report and the orders CSV |
| Run 50 | Each Brand's look, without code: logo, colour (and its text colour, refused below WCAG AA contrast 4.5:1), website, e-mail, phone and address in `/ops` → Apparence, with a live preview; an event photo; the tickets page with the Brand's band, one ticket card per code ("Billet 1 sur 3") and a **full-screen gate view** (one large code at a time, screen kept awake, swipe or arrows); the shop and every buyer e-mail in the same look |
| Run 51 | Tickets without a network at the gate: once opened with a network, the tickets page opens again offline on the same phone (a service worker keeps the page's files; the page keeps the last copy of the order), with an "Hors ligne" notice; nothing is kept on a door-sale device, and copies go two days after the session |
| Run 52 | QR codes inside the tickets, session-change and reminder e-mails (inline images, up to 10 tickets), the same codes as the tickets page, so the e-mail alone gets a buyer in at the gate, even offline |
| Run 53 | A shared shop link shows the event: the server fills the title, description and Open Graph tags (photo, Brand, address) of `/acheter` pages, for published events of an active Brand only |
| Run 54 | The options bought (meals, activities…), which have no QR code, are listed on the tickets page (« Vos options ») and in the tickets and reminder e-mails, so the buyer can show them on site |
| Run 55 | The options follow the tickets through a session change (tickets page, e-mails), and the gate scan shows « Options à remettre » once per purchase, also in the lookup by reference |
| Run 56 | A session change moves the options' stock per session (meals, activities) to the new evening, refused with a clear message if they are sold out there; a full refund releases them from the evening they are on |
| Run 57 | The scanner shows each session's options to prepare and how many were handed over (« Options de la séance »); a session-change right (Flex Météo) is no longer listed as something to hand over |
| Run 58 | The offline scanner list carries each order's options, so a gate without network still shows « Options à remettre » once per order |
| Run 59 | Tickets grouped by type in the catalog's order (page and e-mail); a session-change right (Flex Météo) shows as a right, without « show this page to receive it » |
| Run 60 | The hosted shop shows the options (meals, activities, Flex Météo) in their own card « Ajoutez des options », available once a ticket is chosen |
| Run 61 | **ALKAO platform home**: independent FR-CA/EN SSR homepage at `/`; only Brands that explicitly opt in from `/ops → Apparence` and have an active entitlement plus a published, currently sellable event with capacity appear; existing `/acheter` shop links, Event JSON-LD, canonical/hreflang; `ALKAO_HOME_URL` provides an HTTPS-only white-label root redirect. Opt-in defaults OFF. |
| Run 62 | **Coolify (Docker)** ([guide](docs/ALKAO_DEPLOY_COOLIFY.md)): one container migrates on start (`ALKAO_MIGRATE_ON_START`, containers take turns), serves, and runs the background jobs every minute (`ALKAO_RUN_WORKERS`); stops at once on `docker stop`; `/health` shows the release's commit (`build`); plain PostgreSQL gets the Supabase roles from a production bootstrap with no default grants, never the test shim |
| Run 63 | **Live watch**: every 3 hours the **Live** workflow checks that `https://alkao.ca` answers (service, database, home page; GET only, no secret) and says when `main` is not deployed yet; a failed run is GitHub's e-mail to the owner. `npm run check:secrets` is its own CI step |
| Run 64 | **ALKAO platform home, premium**: hero carousel of real events with photos and ALKAO's own slides (Ken Burns, progress dots, pause, swipe), search on the server (what, where, when, category; works without JavaScript), category tiles, "this week" rail, cards with date badge, lowest paid admission price before taxes ("From … + taxes", ALKAO adds no fee) and number of dates, quick view, favourites kept in the browser, Ctrl+K search palette, an assistant that answers from the page's help topics and events (no AI service, nothing sent anywhere), FR/EN with a one-time language suggestion, organizer band, FAQ, rich footer; photos and fonts self-hosted (`home-ui/`, credits in `home-ui/CREDITS.md`) under `script-src 'self'` |
| Run 65 | **Quebec's consumer protection office (OPC)**: each Brand's exchange and refund policy (`/ops → Apparence`), shown before payment in the shop and repeated on the tickets page and in the tickets e-mail; a change of a session's end time or of its venue's name or address e-mails every order with valid tickets at once (before → now, tickets still valid, the policy), as the OPC requires since 12 September 2026; `check:golive` warns about a selling Brand without a policy. Competitor benchmark: [ALKAO_COMPETITIVE_FEATURES.md](docs/ALKAO_COMPETITIVE_FEATURES.md) |
| Run 66 | **alkao.ca home, from the benchmark**: filters by price before taxes (Gratuit, under 25 $, 25–50 $, over 50 $), sort by lowest price, organizer chips with logos, all kept on a new search and working without JavaScript; one search-engine Event per date with its lowest price (`offers`, CAD, in stock) and the venue's street; in the quick view, « Ajouter au calendrier » (an .ics made in the browser, for each date) and « Itinéraire » (a map search link, no third-party script); « Vus récemment » on this device only, with a clear button; installable on a phone (manifest and app icons) |
| Run 67 | **alkao.ca home, continued**: « Suivre » an organizer from the quick view or its filter, through the Brand's own newsletter sign-up (Run 44: nothing is saved before the person confirms by e-mail; source `alkao`); an **Agenda** view (`vue=agenda`) listing every date day by day within the chosen window; an accessibility statement at `/accessibilite` (FR/EN, WCAG 2.1 AA aim, venue access and CAL card, how to report an obstacle), linked from every footer and audited by axe |
| Run 68 | **Search engines**: `/robots.txt` (the home and the shops open to indexing; `/ops`, `/billets`, the API and e-mail links closed) and `/sitemap.xml` (the home and the accessibility page in both languages, and the shop of every event the home lists, from the same gated loader) |
| Run 69 | **Event details for buyers**: the organizer sets the category, minimum age (« Pour tous », 18 ans et plus…), when the doors open, the language and accessibility notes (`/ops → event → Fiche de l'événement`). All optional: what is not set is not shown. The shop shows « À savoir » before the choice; the home uses the organizer's category instead of guessing it, shows an age badge and the details in the quick view; search engines get `doorTime`, `typicalAgeRange` and `inLanguage`. A duplicate keeps them (and the photo) |
| Run 70 | **Deploys that cannot serve stay out**: `/health/ready` also checks that every migration of the running build is applied (`"schema": "current"`, `"behind"` → 503, `"unknown"` when the database keeps no ALKAO record); the container's health check then fails and the host keeps the previous version. The live watch (Run 63) reports it in plain words |
| Run 71 | **Waitlist for sold-out sessions**: in the shop, a full session offers « M'avertir » (an e-mail address, never pre-checked anything); when seats come back (refund, cancelled order, expired hold, more capacity) the background pass writes once to the people waiting, oldest first, and seats go to whoever buys first. `/ops` shows how many wait per session. Entries expire when the session starts and are deleted 30 days after it (Law 25: one address, one session, one e-mail) |
| Run 72 | **Presale codes**: per event in `/ops → Prévente` (code, who it is for, from when); before the public sale opens, the shop says « La vente ouvre le … » and asks for a code, and a valid code opens the sale from its own time, at the same prices and in the same seats. Codes never reopen a closed sale and can be turned off at any time. A hold before the opening now answers `sales_not_open` instead of « Cette séance n'est plus en vente » |
| Secrets guard | `npm run check:secrets` (in `npm run qa`, so in CI): no key-shaped value and no filled-in secret in `.env.example` can be merged; it names the file and line, never the value |
| Go-live: look | `check:golive` warns when a selling Brand has neither logo nor colour, when its logo is an SVG (missing in many e-mail apps), and when events on sale have no photo |
| TAKATAK brand | `/ops` in the GROUPE TAKATAK brand (`BRAND.md`): deep navy sidebar, electric-blue tile, brand blue buttons; dark mode in navy and midnight with cyan actions; green, red and amber for status only; WCAG AA in both |
| Engine for every project | `docs/ALKAO_BRANCHES.md`: a new business is a Client and a Brand (data), never code; `main` protected, a stable branch per major version (`release/1.x`); buyer and staff screens name no business (the "Flex Météo" wording becomes "changer de séance") |
