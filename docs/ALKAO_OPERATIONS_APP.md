# ALKAO Operations app (`/ops`)

This is step 1 of the owner's decision: a standalone ALKAO web app. It keeps working for a
Client that leaves the full GROUPE TAKATAK package. Step 2, embedding it in the TAKATAK V1
dashboard, is a separate run that will be authorized to write to `takatak-v1`.

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
| `ALKAO_OPS_FRAME_ANCESTORS` | HTTPS origins allowed to embed `/ops` in an iframe (the TAKATAK dashboard in step 2). Empty: no embedding |

Without Supabase settings, the sign-in screen asks for an access token. This is for
development only.

## Security

- **Strict CSP:** `script-src 'self'`, `default-src 'none'`, no inline script or style,
  `frame-ancestors 'none'` by default.
- **Session:** the access token lives in `sessionStorage` (it is cleared when the tab closes)
  and is refreshed through Supabase.
- **No build step:** Preact and htm are served from `node_modules` (`/ops/vendor/htm-preact.js`).
  No third-party CDN is loaded at runtime.
- **Tested end to end** (`test/ui`) with a real server and a real Chromium: sign-in, workspace,
  catalog, order, refund error, gate scanning, and role limits.
