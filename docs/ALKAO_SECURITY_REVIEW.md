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
