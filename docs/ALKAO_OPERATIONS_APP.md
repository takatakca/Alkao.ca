# ALKAO Operations app (`/ops`)

This is step 1 of the owner's decision: a standalone ALKAO web app. It keeps working for a
Client that leaves the full GROUPE TAKATAK package. Step 2 embeds the same app in the
TAKATAK V1 dashboard (menu "ALKAO — Billetterie"), with no second login. See
[Embedding in the TAKATAK dashboard](#embedding-in-the-takatak-dashboard).

## What staff can do

| Screen | Content | Minimum role |
|---|---|---|
| Choisir un espace | The signed-in person's Clients and Brands (`GET /v1/admin/me`), with Ticketing status | any member |
| Tableau de bord | Period (today, 7 days, this month, last month, all) and event filter (Run 26). Gross sales, taxes, refunds, TAKATAK commission, net to the Client; sessions (capacity, sold, held, available, admitted); revenue per ticket type; sales by day with TPS and TVQ, refunds and commission, CSV for the accountant (Run 26); orders CSV; "À traiter": everything waiting on staff (stuck refunds, emails not received, Stripe disputes, refunds made in Stripe, failed cancellation refunds), with a link to each (Run 21); the reminder email the day before, on or off (Run 23) | manager |
| Événements | Create, publish or unpublish; sessions (create, put on sale or pause, capacity); ticket types, including Flex add-ons; attendees CSV per session; duplicate an event, with its sessions moved by N days (Run 28); **many sessions at once** (dates, weekdays, every N minutes, venue time, preview first) and a whole event's upcoming sessions on sale or paused at once (Run 29); **Vente à la porte**: the shop on this device, today's sessions only, card through Stripe, tickets on screen (Run 35); **codes promo** per event, percentage or amount, uses and end date, on or off (Run 36) | editor (read: everyone) |
| Lieux | Venues | editor |
| Commandes | List, detail (lines, TPS/TVQ, tickets and when each entered), full or partial refund (with ticket voiding, automatic retry), Flex session change, QR reissue. A Stripe dispute or a refund made directly in Stripe shows as a notice on the order (Run 19). On a buyer's request (Law 25): export their data; anonymize them (owner, admin) (Run 20). Cancel checked tickets without a refund (Run 21) | manager |
| Scanner | Event and session, gate window, keyboard-wedge scanner or typed code, camera (BarcodeDetector) when the browser supports it; big, colour-coded results; **offline mode** for gates with a weak network (signature checked on the device, scans synced later, double entries reported); **without a QR code**: find the order by its reference and let a ticket in, same rules as a scan (Run 22); **sound and vibration** on each answer, one short high beep when the ticket is let in and two low beeps otherwise, on or off per device (Run 33) | staff |
| Paiements | Stripe account status, onboarding, sites allowed after payment | owner, admin |
| Journal | Who did what and when, in words: "Vous", or the person's role (names stay in TAKATAK), ALKAO, TAKATAK or the buyer; filter by family (orders, refunds, Stripe payments, personal data, sessions, exports…), older entries on request; each order also shows its own **Historique** (Run 30) | owner, admin |

The app shows exactly what the API allows. Permissions, Client isolation and the Ticketing
gate are always enforced by the server, never by the interface.

With Stripe test keys, every screen shows a **Stripe en mode test : aucun paiement réel** badge next to the logo (Run 32).

## Configuration

| Variable | Use |
|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Sign-in with Supabase Auth (email and password), the same accounts as TAKATAK. Both values are public by design |
| `ALKAO_OPS_FRAME_ANCESTORS` | Origins allowed to embed `/ops` in an iframe, comma-separated: the TAKATAK dashboard, e.g. `https://app.takatak.ca`. HTTPS only, plus `http://localhost` for development. Empty: no embedding |

Without Supabase settings, the sign-in screen asks for an access token. This is for
development only.

## Security

- **Strict CSP:** `script-src 'self'`, `default-src 'none'`, no inline script or style,
  `frame-ancestors 'none'` by default.
- **Session:** the access token lives in `sessionStorage` (it is cleared when the tab closes)
  and is refreshed through Supabase.
- **No build step:** Preact and htm are served from `node_modules` (`/ops/vendor/htm-preact.js`).
  No third-party CDN is loaded at runtime.
- **Embedded:** see below.
- **Tested end to end** (`test/ui`) with a real server and a real Chromium: sign-in, workspace,
  catalog, order, refund error, gate scanning, and role limits.

## Embedding in the TAKATAK dashboard

The TAKATAK page `/dashboard/ticketing` frames `/ops` and hands over the user's Supabase
session, so staff sign in once, in TAKATAK.

| Step | Sender → receiver | Message |
|---|---|---|
| 1 | ALKAO → TAKATAK | `{ type: "alkao.ready" }` |
| 2 | TAKATAK → ALKAO | `{ type: "alkao.session", accessToken, expiresAt, email }` (`expiresAt` in ms) |
| 3 | ALKAO → TAKATAK | `{ type: "alkao.session_expired" }`, less than a minute before `expiresAt`, or when the API answers 401 |
| 4 | TAKATAK → ALKAO | a fresh `alkao.session` |

The handover follows these rules:

- **Origins:** both sides check the origin. ALKAO accepts a session only from its parent
  window, and only from an origin in `ALKAO_OPS_FRAME_ANCESTORS`, the same list that
  `frame-ancestors` uses. TAKATAK posts only to the ALKAO origin, and only to its own iframe.
- **Access token only.** The refresh token never crosses. Refreshing inside ALKAO would rotate
  it and sign the user out of TAKATAK, so TAKATAK refreshes and sends the new access token.
- **Memory only.** Embedded, the token is never written to storage.
- **No login form, no logout button.** The TAKATAK session is the only session.
- **No retry loop.** If the API rejects a token, ALKAO asks TAKATAK once more. If TAKATAK sends
  the same token again, ALKAO stops and says that it does not accept the TAKATAK session.
- **Stripe onboarding opens in a new tab,** because Stripe's pages cannot run inside a frame.
- **No camera.** The TAKATAK dashboard sends `Permissions-Policy: camera=()`, so the embedded
  scanner works with a keyboard-wedge reader or a typed code. For camera scanning, open `/ops`
  directly on the gate device.

Embedding is a convenience, not a security boundary. Every call still carries the user's own
token to the gated admin API.
