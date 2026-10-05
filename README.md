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
| `docs/` | Capability status, [API v1](docs/ALKAO_API_V1.md), [control contract v1](docs/ALKAO_CONTROL_CONTRACT_V1.md), [credentials and gates](docs/ALKAO_SCANNER_V1.md) |

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
