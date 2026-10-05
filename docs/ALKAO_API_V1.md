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
| `POST /v1/webhooks/stripe` | Stripe signature (`Stripe-Signature`, Connect endpoint secret). Not behind the Ticketing gate, so a checkout opened while Ticketing was active is still settled or refunded if Ticketing is turned off before the buyer pays | `400` / `503` |
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

### Checkout (Run 02)

| Method | Path | Body | Result |
|---|---|---|---|
| POST | `/holds/:holdId/checkout` | header `X-Alkao-Hold-Token`; `{ buyer: { email, fullName?, phone? }, successUrl, cancelUrl }` | `201 { order: { id, reference, token, status }, checkoutUrl }`. A free order is `paid` at once and `checkoutUrl` is `null`. Calling again for the same hold returns the same Checkout and rotates the order token. Errors: `422 return_url_not_allowed`, `409 payments_unavailable`, `409 hold_not_active`, `502 payment_provider_error` (safe to retry) |
| GET | `/orders/:orderId` | header `X-Alkao-Order-Token` | Order status, lines, taxes and tickets, for the buyer's confirmation page. Each valid ticket has `credential`, its QR payload (Run 03, [format](ALKAO_SCANNER_V1.md)) |

How a payment works:

- **Stripe Connect direct charge on the Client's own account.** Buyers pay the Client
  directly, and the Client is the merchant.
- **TAKATAK's commission is the `application_fee_amount`:** the rate on the pre-tax subtotal,
  plus the fixed amount per paid ticket.
- **Line items** are the paid ticket lines plus one line each for TPS and TVQ. Their sum
  always equals the order total.
- **Cards only,** so a completed Checkout means the payment is confirmed.
- **The hold is extended** to match the Checkout session (31 min) plus 5 minutes for a late webhook.
- **Fulfilment** happens only on a signed `checkout.session.completed` webhook. ALKAO checks
  that the amount, the currency (CAD) and the connected account all match. It tracks each
  Stripe event by its id, so a redelivered event changes nothing.
- **When Checkout expires,** the order expires and the seats return to sale.
- **When a payment arrives after its seats were resold** (the hold had lapsed), the order is
  refunded in full automatically, commission included.

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
| POST | `/payments/onboarding` | `payments.manage`: creates the Client's Stripe Standard account (CA) on the first call and returns a Stripe onboarding link |
| GET | `/payments/account` | `payments.manage`: connection status (`chargesEnabled`, `payoutsEnabled`, `detailsSubmitted`) |
| GET / PUT | `/payments/settings` | `payments.manage`: `checkoutReturnOrigins`, the HTTPS origins of the Brand's site allowed as Checkout return URLs |
| GET | `/orders/:orderId/refunds` | `orders.read` |
| POST | `/orders/:orderId/refunds` | `refunds.create`: `{ amountCents?, ticketIds?, reason? }`. Without an amount, refunds everything still refundable and voids every valid ticket. With an amount, voids only the `ticketIds` given (their seats return to sale) |
| POST | `/refunds/:refundId/retry` | `refunds.create`: completes a refund left pending by a Stripe failure (`502 refund_provider_error` returns its `refundId`) |

### Refunds and the V1 commission policy

A full refund to the buyer refunds the full TAKATAK commission. A partial refund refunds a
proportional share, computed cumulatively, so several partial refunds always add up to the
full commission in the end. Each refund runs in three steps:

1. A pending refund is recorded. Only one refund per order can be in flight at a time.
2. Stripe refunds the buyer on the Client's account, then refunds the application fee on the
   platform. Each call's idempotency key is derived from the refund id.
3. The order totals are updated and the tickets voided.

If Stripe fails, the refund stays pending, and retrying it never pays out twice. At commit,
the database checks that the order's refunded totals equal the sum of its refunds.

Every admin write is recorded in `ticketing_audit_log` in the same transaction.

### Role → permission

| Role | catalog.read · inventory.read · holds.read | catalog.write | orders.read · buyers.read | audit.read |
|---|---|---|---|---|
| owner, admin | ✓ | ✓ | ✓ | ✓ |
| manager | ✓ | ✓ | ✓ | |

Run 02 adds `payments.manage` (owner, admin) and `refunds.create` (owner, admin, manager).
Run 03 adds `scan` (owner, admin, manager, staff), `credentials.manage` (owner, admin, manager)
and `keys.manage` (owner, admin). Its routes are listed in [ALKAO_SCANNER_V1.md](ALKAO_SCANNER_V1.md).
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
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | — | Platform key and the **Connect** webhook endpoint secret. Without both, payments stay off (`payments_unavailable`/`503`) |
| `ALKAO_CREDENTIAL_MASTER_SECRET` | — | Secret (≥ 32 chars) from which each Client's QR signing keys are derived. Without it, there are no QR codes and scanning answers `503`. Changing it invalidates every QR code |
| `ALKAO_STRIPE_ONBOARDING_REFRESH_URL` / `_RETURN_URL` | — | HTTPS pages (TAKATAK dashboard) where Stripe sends a Client admin during and after onboarding |

Stripe webhook events to send to `/v1/webhooks/stripe` (Connect endpoint, events on connected
accounts): `checkout.session.completed`, `checkout.session.expired`,
`checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`,
`account.updated`.
