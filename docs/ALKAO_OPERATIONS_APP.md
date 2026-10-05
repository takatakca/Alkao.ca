# ALKAO Operations app (`/ops`)

This is step 1 of the owner's decision: a standalone ALKAO web app. It keeps working for a
Client that leaves the full GROUPE TAKATAK package. Step 2 embeds the same app in the
TAKATAK V1 dashboard (menu "ALKAO — Billetterie"), with no second login. See
[Embedding in the TAKATAK dashboard](#embedding-in-the-takatak-dashboard).

## What staff can do

| Screen | Content | Minimum role |
|---|---|---|
| Choisir un espace | The signed-in person's Clients and Brands (`GET /v1/admin/me`), with Ticketing status | any member |
| Tableau de bord | Gross sales, taxes, refunds, TAKATAK commission, net to the Client; sessions (capacity, sold, held, available, admitted); revenue per ticket type; orders CSV | manager |
| Événements | Create, publish or unpublish; sessions (create, put on sale or pause, capacity); ticket types, including Flex add-ons; attendees CSV per session | editor (read: everyone) |
| Lieux | Venues | editor |
| Commandes | List, detail (lines, TPS/TVQ, tickets), full or partial refund (with ticket voiding, automatic retry), Flex session change, QR reissue | manager |
| Scanner | Event and session, gate window, keyboard-wedge scanner or typed code, camera (BarcodeDetector) when the browser supports it; big, colour-coded results | staff |
| Paiements | Stripe account status, onboarding, sites allowed after payment | owner, admin |

The app shows exactly what the API allows. Permissions, Client isolation and the Ticketing
gate are always enforced by the server, never by the interface.

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
- **No camera.** The TAKATAK dashboard sends `Permissions-Policy: camera=()`, so the embedded
  scanner works with a keyboard-wedge reader or a typed code. For camera scanning, open `/ops`
  directly on the gate device.

Embedding is a convenience, not a security boundary. Every call still carries the user's own
token to the gated admin API.
