# ALKAO — TAKATAK Ticket Hub

ALKAO is the standalone, detachable ticketing engine of GROUPE TAKATAK. Each TAKATAK Client
(for example Havana Resort or FESTI-ICE) uses it as a separate tenant: its own catalog,
inventory, buyers, orders, tickets, permissions and finances.

GROUPE TAKATAK V1 (`takatak-v1`) stays the master control plane: identity, Clients, Brands,
memberships, entitlements, platform billing and the dashboard shell. ALKAO never reads the
TAKATAK database. It keeps local projections, which TAKATAK updates through a signed,
versioned control contract.

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
| `src/credentials`, `src/scanner` | Ed25519 QR credentials (`ALK1`), derived per-Client keys, scanner manifest and gate scans |
| `contracts/` | Published JSON Schema of `alkao.control.v1` (generated; drift-tested) |
| `supabase/migrations` | Schema. Every `ticketing_*` table enables RLS in the migration that creates it |
| `supabase/tests/supabase_shim.sql` | Local test stand-in for Supabase roles, `auth.uid()` and default grants |
| `test/` | Domain, RLS, invariant and migration-rule tests |
| `docs/` | Capability status, [API v1](docs/ALKAO_API_V1.md), [control contract v1](docs/ALKAO_CONTROL_CONTRACT_V1.md), [credentials and gates](docs/ALKAO_SCANNER_V1.md), [go-live](docs/ALKAO_GO_LIVE.md), [runbook](docs/ALKAO_RUNBOOK.md) |

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
| Engine for every project | `docs/ALKAO_BRANCHES.md`: a new business is a Client and a Brand (data), never code; `main` protected, a stable branch per major version (`release/1.x`); buyer and staff screens name no business (the "Flex Météo" wording becomes "changer de séance") |
