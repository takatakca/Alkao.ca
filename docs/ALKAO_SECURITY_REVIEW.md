# ALKAO security review (Run 13)

This is a review of the whole ALKAO codebase before going live, with the fixes made in this
run. Every point below is covered by an automated test unless it says otherwise.

## What was checked

| Area | Result |
|---|---|
| **Staff sign-in** (Supabase JWT) | Algorithms pinned (HS256, or JWKS ES256/RS256/EdDSA), audience `authenticated`, role `authenticated` and a UUID `sub` required. Metadata is never trusted |
| **Admin authorization** | Every admin route checks, in order: token, active membership in the URL's Client, Ticketing gate, then role permission. Enumerated by `test/api/gate.test.ts` |
| **Client isolation** | **New sweep** (`test/api/isolation.test.ts`): every admin route that takes an id is called with another Client's ids and a valid body. None succeeds, and a full snapshot of the other Client's data is unchanged. The same goes for public hold and order routes |
| **Database** | RLS on every `ticketing_*` table, SELECT-only policies, no access for `anon`. Composite foreign keys carry `client_id` and `brand_id` (structural test). All SQL is parameterized; dynamic column names come from allowlists |
| **Buyer tokens** | Holds, orders and email links use 256-bit random or derived tokens. Only SHA-256 hashes are stored, and email links can be rotated |
| **TAKATAK contract** | HMAC-SHA256 with constant-time comparison, ±300 s window, key ids for rotation, idempotency per event id |
| **Stripe** | Webhook signature checked, connected account matched, amount and currency matched, idempotency per event, idempotency keys on refunds |
| **QR codes** | Ed25519, keys derived per Client and never stored, revocation through the manifest, a single admission per ticket enforced by a unique index |
| **Web pages** | `/ops`, `/billets` and `/acheter` have a strict CSP (`script-src 'self'`, no inline code), `frame-ancestors 'none'` (or the TAKATAK dashboard for `/ops`), and no HTML injection sinks in the code |
| **Emails** | Every value is escaped in HTML. The display name and subject cannot inject headers |
| **CSV** | Spreadsheet formulas neutralized |
| **Dependencies** | `npm audit --omit=dev`: 0 vulnerabilities |
| **Secrets** | No real secret in the repository (scanned). Test secrets are labelled `test-only` |

## Sales-rush safety (Run 15)

`test/stress/rush.test.ts` drives the real API concurrently against real PostgreSQL:

| Scenario | Proven |
|---|---|
| 200 buyers race for 50 seats (1 to 3 each) | Never oversold. Every refusal is a clean `409 sold_out` (no 500). The counters match the holds, then the tickets, after everyone pays at once |
| Checkout double-clicked 6 times | One order, one Stripe Checkout session, one idempotency key |
| The same Stripe webhook delivered 10 times at once | The order is fulfilled once, with exactly the bought number of tickets |
| Full refund double-clicked 6 times | One refund, one Stripe payout, order `refunded` |
| Flex Météo change clicked 5 times | Moved once; the others get `already_exchanged` |
| 3 staff pushing a session cancellation at the same time | Each of the 6 buyers is refunded exactly once |

## Fixed in this run

1. **Spoofable rate limit.** Hold creation was limited per IP taken from the *leftmost*
   `X-Forwarded-For` entry, which the caller controls. ALKAO now uses the entry added by its
   own proxy (`ALKAO_TRUSTED_PROXY_HOPS`, default 1), or the socket address.
2. **Unbounded request bodies.** Every request is limited to 256 KB (Stripe webhooks to
   1 MB). Larger ones get `413 payload_too_large`, before parsing.
3. **API response headers.** `/v1/*` responses now carry `cache-control: no-store` (orders
   and QR codes are never cached), `nosniff`, `no-referrer` and `X-Frame-Options: DENY`.
   HSTS is sent when `ALKAO_PUBLIC_URL` is HTTPS.
4. **Lists under another Client's id.** Sessions, ticket types, refunds and scans of a
   foreign parent answered `200` with an empty list. No data leaked, but they now answer
   `404`, like every other route.
5. **`localhost` framing in production.** `ALKAO_OPS_FRAME_ANCESTORS` accepts
   `http://localhost` only outside production.
6. **Offline gate lists.** A device drops a session's list 24 h after the gates close, once
   everything is synced.
7. **Earlier runs, found on the way:** email links rotated by later emails (Run 12),
   React hooks after an early return, and a foreign key without the tenant ids (Run 12).

## Residual risks and how they are handled

| Risk | Handling |
|---|---|
| A ticket link or a screenshot is shared | Staff rotate the link (`tickets-link/rotate`) and reissue the QR codes. Admission is counted per ticket, so a copied QR code admits only once |
| `ALKAO_CREDENTIAL_MASTER_SECRET` leaks | Someone could forge QR codes and email links. Keep it in a secret manager, never change it casually, and restrict who can read the production configuration |
| Burst traffic on a hot sale | The in-process limiter is per instance. Add rate limiting at the edge (CDN or load balancer) in production |
| Brand sites calling the public API from the browser | No CORS by design. Brand sites use the hosted shop and the `widget.js` button, or call the API from their server |
| A lost gate device in offline mode | It holds credential ids only, with no buyer data. Leave offline mode after the event; the list expires anyway |
| The legacy HS256 Supabase secret | Prefer `SUPABASE_JWKS_URL` (asymmetric keys) in production |

## Owner checklist before go-live

These are not testable from the code.

- [ ] Protect the `main` branch of Alkao.ca, takatak-v1 and festiiceca.
- [ ] Production secrets come from a secret manager. Generate them with
      `openssl rand -base64 48`.
- [ ] A dedicated ALKAO database with automated backups. Never share it with TAKATAK or
      FESTI-ICE.
- [ ] Set `ALKAO_TRUSTED_PROXY_HOPS` to the hosting's proxy depth.
- [ ] Use Stripe live keys only after a full test-mode purchase, refund and cancellation.
- [ ] Edge rate limiting on `/v1/public/*`.

## Accessibility (Run 17)

`test/a11y/axe.test.ts` runs axe-core (WCAG 2.1 A and AA rules) in Chromium, in both light
and dark colour schemes. It covers:

- **Buyer pages:** the event list, the event, the quantities with the quote, the buyer form,
  and the tickets page.
- **Staff pages:** sign-in, workspaces, dashboard, events, an event, venues, orders, an
  order, the scanner, and payments.

The first run found **colour contrast failures in dark mode** on every app: the
green, red, orange and blue foregrounds kept their light-mode values. Each app now has a
dark palette, and the suite reports zero violations. All controls are native buttons, links
and labelled inputs, so keyboard use and screen readers work without extra code.

## Runs 18–24 (Run 25)

The routes added since the review, checked the same way.

| Route | Permission | Tenant check |
|---|---|---|
| `GET /disputes`, `GET /attention` | `orders.read` | Every query filters by the URL's Client and Brand |
| `GET /orders/:id/buyer/export`, `POST /orders/:id/buyer/anonymize` | `buyers.read`; `buyers.erase` (owner, admin) | The order is looked up in the URL's Client and Brand. Another Client's order is `404` |
| `POST /orders/:id/tickets/void` | `refunds.create` | Only tickets of that order, or of its Flex exchange, in the URL's tenant |
| `GET /sessions/:id/lookup`, `POST /scanner/admit` | `scan` | The session, order and ticket are each looked up in the URL's tenant. Gate staff get no buyer data |
| `GET/PUT /settings/reminders` | `credentials.manage` | One row per Client and Brand |
| `GET /metrics` | Its own bearer token, compared in constant time; `404` when no token is set | Platform-wide counts only, never a tenant id, name, email or amount |
| Stripe `charge.dispute.*` and `charge.refunded` | Stripe signature | Matched to a payment by payment intent **and** connected account. A mismatch is audited and ignored |

**Isolation sweep (`test/api/isolation.test.ts`).**

- It now calls these routes with valid bodies and queries, so each reaches the database
  instead of stopping at validation.
- It also covers the routes that take another Client's ids in the body (`/scanner/admit`,
  `/scanner/scans`).
- Its FESTI-ICE snapshot now includes buyers, anonymizations, disputes, Stripe refund
  totals and Brand settings.

**Mutation check.** With the tenant filter removed from the buyer lookup, the sweep fails at
once (`buyer/export answered 200`). With the filter restored, it passes.

The new tables (`ticketing_payment_disputes`, `ticketing_charge_refund_totals`,
`ticketing_buyer_erasures`) are server-only. RLS is on, with no policy and no grant, and the
RLS catalog test lists them.
