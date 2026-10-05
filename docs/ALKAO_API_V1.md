# ALKAO API v1 (`alkao.api.v1`)

Request schemas: [`src/contracts/api-v1.ts`](../src/contracts/api-v1.ts). Unknown body fields are
dropped: a client can never send a price, a tenant id or a status it isn't allowed to set.

Errors always look like `{ "error": { "code": "…", "details": … } }` with stable codes.

## Gates

| Surface | Checks, in order | Refusal |
|---|---|---|
| Public `/v1/public/clients/:clientId/brands/:brandId/…` | Ticketing gate (deployment switch, Client/Brand active and paired, entitlement for the pair) | `404 ticketing_unavailable`, with no reason, so tenants cannot be probed |
| Admin `/v1/admin/clients/:clientId/brands/:brandId/…` | 1. Supabase access token → `401` · 2. active membership in the Client → `404` · 3. Ticketing gate → `403 ticketing_disabled {reason}` · 4. role permission → `403 forbidden` | as listed |
| `GET …/status` (admin) | Token and membership only | Returns `{ role, ticketing: { active, reason? } }` so the dashboard can explain why Ticketing is off |
| `POST /v1/control/events` | HMAC signature (see [control contract](ALKAO_CONTROL_CONTRACT_V1.md)) | `401` / `503` |
| `GET /health` | none | — |

`test/api/gate.test.ts` enumerates every registered route and proves each one refuses to act
while Ticketing is off, and that a refused hold request writes nothing.

## Public (buyer-facing)

| Method | Path | Body | Result |
|---|---|---|---|
| GET | `/events` | — | Published events of the Brand |
| GET | `/events/:eventId` | — | Event, active ticket types and their rules, on-sale future sessions with `available` |
| POST | `/events/:eventId/quote` | `{ items: [{ ticketTypeId, quantity }] }` | Server-priced quote (lines, GST/QST, total) or `422 cart_invalid` listing every violation |
| POST | `/holds` | `{ sessionId, items }` | `201 { hold: { id, token, expiresAt, sessionId, quote } }`. The token is shown once and only its hash is stored. Errors: `409 sold_out`, `409 session_not_available`, `422 cart_invalid`, `429 rate_limited` |
| GET | `/holds/:holdId` | header `X-Alkao-Hold-Token` | Hold status (`active`/`expired`/`released`/`converted`) and items |
| DELETE | `/holds/:holdId` | header `X-Alkao-Hold-Token` | `204`; `409 hold_not_active` if already closed |

Reserved for Run 02: `POST /holds/:holdId/checkout` (buyer details, order, Stripe Connect
direct charge with application fee).

## Admin (TAKATAK dashboard / Client staff)

| Method | Path | Permission |
|---|---|---|
| GET | `/status` | any member |
| GET / POST | `/venues` | `catalog.read` / `catalog.write` |
| PATCH | `/venues/:venueId` | `catalog.write` |
| GET / POST | `/events` | `catalog.read` / `catalog.write` (always created as `draft`) |
| GET / PATCH | `/events/:eventId` | `catalog.read` / `catalog.write` |
| GET / POST | `/events/:eventId/sessions` | `inventory.read` / `catalog.write` (always created as `draft`) |
| PATCH | `/sessions/:sessionId` | `catalog.write`; `409 capacity_below_committed` if capacity drops below what is held + sold |
| GET / POST | `/events/:eventId/ticket-types` | `catalog.read` / `catalog.write` |
| PATCH | `/ticket-types/:ticketTypeId` | `catalog.write` |
| GET | `/orders?limit&before` | `orders.read` |
| GET | `/orders/:orderId` | `orders.read` (buyer, lines, taxes, tickets) |
| GET | `/audit?limit&before` | `audit.read` |

Every admin write is recorded in `ticketing_audit_log` in the same transaction.

### Role → permission

| Role | catalog.read · inventory.read · holds.read | catalog.write | orders.read · buyers.read | audit.read |
|---|---|---|---|---|
| owner, admin | ✓ | ✓ | ✓ | ✓ |
| manager | ✓ | ✓ | ✓ | |
| editor | ✓ | ✓ | | |
| staff, viewer | ✓ | | | |

These match the RLS policies: buyer data and order money are visible to owner, admin and
manager only.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — | ALKAO PostgreSQL (server connection; RLS is the second layer for the Data API) |
| `ALKAO_OPERATIONAL_API_ENABLED` | `false` | Deployment switch. Off: every operational route refuses |
| `ALKAO_CONTROL_KEYS` | — | `kid:secret` pairs for the control contract |
| `SUPABASE_JWKS_URL` or `SUPABASE_JWT_SECRET` | — | Access-token verification (audience `authenticated`) |
| `SUPABASE_JWT_ISSUER` | — | Optional issuer check |
| `ALKAO_HOLD_TTL_SECONDS` | `600` | Hold lifetime (60–1800) |
| `ALKAO_PUBLIC_HOLDS_PER_MINUTE` | `20` | Per Client and IP, in-process. Also rate-limit at the edge in production |
