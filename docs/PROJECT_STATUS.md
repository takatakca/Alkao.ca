# ALKAO — Project status

## Run 100 — festival passes everywhere the buyer looks (2026-10-22)

A pass buyer finds every date in the confirmation e-mail and the reminder, as on the tickets page. alkao.ca flags the events that sell a pass.


## Run 99 — catalog files and coupons kept off presales (2026-10-22)

A whole event loads from one file: its presales, festival passes and coupons included. An organizer can keep a coupon off presale prices: it then reduces regular-price tickets only. The shop says so, and the amount paid is always the one shown.


## Run 98 — festival passes (2026-10-22)

A festival or a weekend market sells one pass for all its dates: one ticket and one QR code, entering once per date. The database keeps every date within its capacity. The shop offers the pass next to one-day tickets, and the tickets page lists every date. /ops creates a pass with one checkbox.


## Run 97 — presales and discount coupons (2026-10-22)

Organizers sell any event (festival, food, fashion, market) earlier and better:
- a presale price for a limited time or quantity, guarded by the database;
- coupons shown to every buyer, applied in one click or by a shared link.

The shop and alkao.ca show both honestly: real prices, real end dates and what is really left. /ops creates them in a few clicks. Three new categories: Gastronomie, Mode, Marchés et salons.


## Run 94 — Havana's Halloween page, ready to load (2026-10-18)

Havana's Halloween page is complete in its catalog file, from the resort's own public sites: highlights, photos, Le jour J, FAQ and what each ticket includes. One import puts it on sale on alkao.ca. Going live still needs the server side, all listed in `docs/CE_SOIR_HAVANA.md`:
- the Coolify redeploy (#84);
- Stripe platform keys and webhook;
- Havana provisioned and its Stripe connected;
- the capacity per evening and the refund policy.


## Run 93 — the event page in full (2026-10-18)

The event page now follows the structure of the big ticketing sites:
- hero with the facts and the price;
- section tabs;
- highlights, gallery, "Le jour J", description, venue with its map, FAQ;
- a booking calendar, then hours and tickets with "Plus d'infos".

Organizers fill these sections in /ops, by hand or with the assistant. Nothing is invented: no stars, fees or discounts. It goes live with the next deploy (Coolify #84).

## Run 92 — executive pass (2026-10-17)

- **Home copy:** firm and factual, with a calm design. The ALKAO assistant on the home stays.
- **/ops dashboard:** an executive overview.
- **/ops writing assistant:** drafts campaigns and event descriptions from the Brand's own catalog. The code refuses any invented price, discount, code or link. It is off by default because it is paid per use: about 0,04 $ CA per draft with Claude Opus 5.5, capped per Brand per day (`docs/ASSISTANT_REDACTION.md`). Nothing is deployed until Coolify #84.

## Runs 90–91 — premium buyer pages; Havana's catalog ready to load (2026-10-17)

The shop, the tickets wallet, the venues, the home filters and the e-mail landing pages share one premium look: photo heroes with zoom, sticky ticket panel, live totals, ticket cards with a full-screen gate view. `npm run events:import` loads Havana's owner-approved Halloween catalog in one command. Havana is still not provisioned in production ALKAO and the live service is still the old build, so alkao.ca shows no event until the operator steps in `docs/HAVANA_SUR_ALKAO.md` are done. PR #85.

## Run 89 — degraded local incident archive recovery (2026-10-16)

Source commit `8b06cf8368d3a639f607d64a52610ff545fcc04f` ensures that an automatic expiry cleanup cannot crash a scanner view when the device's incident report storage is corrupted or at quota. The original local audit remains available with `incidentArchiveFailed`, staff receive a clear on-screen warning, and once archival storage recovers, old incidents can be preserved and the temporary audit retired normally. New regression in `test/ops/offline-incidents.test.ts`. Run 89 CI **SUCCESS** 38962087021 and Package **SUCCESS** 38962086850 on source `8b06cf83`; Coolify not verified and transfers OFF.


## Run 88 — retain scanner admission discrepancies (2026-10-16)

Source commits `e0dbc920` and `427668f7` introduce a per-session local incident ledger for offline admissions disputed by server reconciliation. Instead of losing only a numeric counter when leaving offline mode, a sanitized report retains credential ID (not the signed QR), server result, offline/reconciliation timestamps and legacy counts; staff can export CSV locally. Exiting mode archives the ledger before clearing the temporary manifest; failed archive writes preserve the original audit. Expired post-close manifests likewise archive discrepancies before auto-removal. New unit and Chromium cross-tab tests. Initial CI failed a test-only TypeScript multiline import (corrected in follow-up). Full CI **SUCCESS** 38960997547 and Package **SUCCESS** 38960997727 for source SHA `427668f7f2a5700e25b294976d0c011bc9aafe28`. Production SHA remains unverified; no changes to global/Brand transfer flags.


## Run 87 — same-origin multi-tab offline audit coordination (2026-10-16)

Browser two-tab E2E initial CI 38957592844 had 606 passes and one test-only Vitest dynamic import error; fixed in `fa915328`, replacement CI 38958090144 **SUCCESS** / Package 38958090354 **SUCCESS** for source `fa9153282e643700de8ee15ff998774be147121c`.


The initial Web Locks unit source `cb184a49` passed CI 38956850284 and Package 38956850276. A real two-tab Chromium test was added and browser-specific TypeScript setup corrected through `88ae7715`; latest CI 38957592844 to be verified.


Source `cb184a497470be50eed7a2e9aaf1cd5f47ce0517`: in addition to Run 86 single-tab FIFO, offline admissions and synchronization now hold `navigator.locks` exclusive locks per session across tabs. No new offline admission is allowed when secure Web Locks support is missing; already-recorded admissions remain eligible for server reconciliation in recovery mode. Realistic unit regressions validate two independent scanner instances racing over a delayed HTTP acknowledgment, lock release after error and other sessions' independence. Check CI 38956850284 and Package 38956850276 for final outcome. No migration/production changes; Coolify live SHA unverified.


## Run 86 — offline scanner same-tab audit durability (2026-10-16)

Initial CI 38955194282 failed TS7006 in two new test callback annotations, corrected by `9fbd33a8`; replacement CI 38955598793 SUCCESS, Package 38955598811 SUCCESS for final Run 86 source SHA `9fbd33a85c2c2ec04d92bdb56bdc88d6892fb1cb`.


Source commit `29a5f8f213fc788653bd933d709c39fe1cae150b` serializes asynchronous scan admission, manual/automatic reconciliation, initial offline preparation and exit in a single FIFO per Operations browser tab, eliminating the stale-snapshot overwrite of unacknowledged audit records. If local storage rejects an admission, the UI tells staff NOT to admit the ticket rather than displaying a success. Added `test/ops/offline-concurrency.test.ts` with network delay and exit races. Check CI 38955194282 and Package 38955194286 for final validation. Multi-tab races require more safeguards; this patch does not guarantee durable write across browser storage eviction. Coolify SHA still not present in live `/health`; issue #84 open.


## Run 85 — offline gate cannot abandon unsynced admissions (2026-10-16)

Source commit `62aedcd5f8b4d75644162eead67267b2be2ec69e` removes the destructive "leave anyway" path from Operations scanner. If an offline-admitted attendee is still in the reconciliation queue, the UI retains the queue and mode and shows reconnection instructions. Browser E2E test verifies rejected exit and successful online sync followed by safe exit. CI **SUCCESS** 38944264243 and Package **SUCCESS** 38944264279 at source SHA `62aedcd5f8b4d75644162eead67267b2be2ec69e`. Production Coolify SHA remains unverified and transfer switches remain default OFF.


## Run 84 — offline admission reconciliation hardened (2026-10-16)

Source `faf44749151a3614748d1dce1eb88a6546632190`, follow-up fix `21a7031cde9ef7da4ca7077b7ab015bad00022c1`: only physically admitted, signature-verified offline scans are queued for server replay; older denied attempts are ignored on reconnection. Interrupted or incomplete batch responses no longer erase pending admissions. The server's explicit acknowledgment validates count, source index and result. Rejected local admissions (including revoked/transfer QR) count as incidents, not silently cleared. New tests in `test/ops/offline-reconciliation.test.ts` and updated signature/expiry expectations. Full source CI **SUCCESS** 38942936131 and Package **SUCCESS** 38942935861 at `21a7031cde9ef7da4ca7077b7ab015bad00022c1`. No production release verified; strict Coolify `/health` did not expose build SHA on eight checks (Verify deployment 38886146185). Transfers remain OFF by default.


## Run 83 — offline scanner cryptography safety (2026-10-16)

Source `7b004ba2b408d3e0f65ed710927f6c3684503a66` hardens the already time-limited offline gate: QR admission now requires a *verified* Ed25519 signature; absence of crypto/browser support is no longer silently treated as valid merely because the QR ID occurs in a manifest. Staff see a reconnect/use-online warning. New real cryptographic unit tests in `test/ops/offline-signature.test.ts` cover signed/forged, unsupported, revoked and expired scenarios. Full GitHub CI **SUCCESS** 38885296988 and Package **SUCCESS** 38885297040 for this SHA. No production version attested; transfer flags remain OFF.


## Run 82 — cancelled-session transfer window (2026-10-16)

Source `7f5e7d135f35a59e9ac7e5f9d376a3f327992f63` adds an application-level session row lock and a PostgreSQL trigger to refuse buyer invitations or recipient claims for cancelled sessions before asynchronous refund and voiding work finishes. New test asserts that even a still-valid ticket cannot be transferred or emailed during this gap. Migration: `20261109000100_alkao_transfer_cancelled_sessions.sql`. Source CI SUCCESS 38884229198 and Package SUCCESS 38884229102 at SHA `7f5e7d135f35a59e9ac7e5f9d376a3f327992f63`. Production Coolify SHA not verified; public transfer release stays OFF.


## Run 81 — payment-boundary transfer safety (2026-10-16)

Source commits `7b19da34`, `1debe096`: prevent new invitations and recipient QR reissues while the buyer's order has a pending refund or unresolved/lost chargeback. Enforced inside order-locked application transactions and a new private PostgreSQL trigger migration `20261108000100_alkao_transfer_payment_guards.sql`. Invitation delivery is now deferred while money is unsettled and can resume if a dispute resolves before expiry; provider failure attempt counts are preserved. New regression suite `test/db/transfer-payment.test.ts`. CI **SUCCESS** 38883239557 and Package **SUCCESS** 38883239522 for `1debe096c9c8ad5421b7c39b1efe68ff744df8d6`. Production Coolify SHA not verified; transfer feature disabled by default.


## Run 80 — public transfer workflow implemented in source (2026-10-16)

Extra commits: `f9203cec` tests worker default-off and one-time delivery; `e085b59f` fixes a dashboard selector collision and documents the default-off environment flag.


Source commits: `59e31276` (guarded REST APIs), `d0f11e21` (buyer/recipient UI and worker integration), `fe6abc324b93a2c6a8b4162c3d7413da8282f893` (organizer opt-in/audit and test fixes).
Buyer link can request/cancel transfer; recipient confirms one-use email claim and receives a separate personal ticket QR. Sender's original order excludes transferred QR and rejects whole-order session exchange. Organizer owner/admin controls Brand opt-in. Tests include two-tenant isolation and real Chromium recipient/sender flows.
**Disabled by default**: `ALKAO_TRANSFER_API_ENABLED=false`; each Brand's separate setting is also default OFF. Mail worker and cron only send transfer invitations when this same release flag is enabled. Full CI **SUCCESS** 38854862144 and Package **SUCCESS** 38854861945 at source SHA `e085b59f83409a37fd6f76d585b7493d6e5f2ef8`. Production deployment still unverified. **No verified Coolify deployment**; production activation, dedicated database/migrations, provider email delivery, backups and SHA proof remain blocked by issue #84.


## Run 79 — validated internal ticket transfer (2026-10-15)

Code SHA `a4994017953ed437bcfee50d740195949d9917fd`: GitHub CI 38736545944 SUCCESS, Package 38736546000 SUCCESS. Atomic recipient claim/credential reissue, tenant-scoped append-only acceptance, sender QR exclusion and online/offline scanner replay mitigations are present and tested. No public claim routes or client transfer UI and email sender remains inactive. New database migration requires authorized operator on dedicated ALKAO DB. Production release is NOT verified (Coolify issue #84).


## Run 78 — 2026-10-15

Source `e3b1777434f72db73110d1c0889e1af84c8adff2` passed full CI 38734506526 and Package 38734506570. Adds a private, RLS-isolated recipient-invitation outbox with deterministic server-derived one-time proofs, queued atomically with the request, and a staged retry-safe bilingual mail dispatcher. No customer mail is automatically sent and no claim or QR ownership transfer is exposed. Production Coolify SHA remains unverified; issue #84.


## Run 77 — current source state

Migration and DB/RLS tests passed CI; private transfer invitation/cancellation service `c7864c5757243ad3835ee1c22f71798240c23732` passed CI run 38631015271 and Package 38631014226. This is NOT the buyer transfer feature yet: no email, no recipient claim or QR replacement. Leave opt-in default OFF. Production is unverified; issue #84 remains blocked.


## Run 77 — Secure transfer request foundation

Code commit `0da240f241e8c1eb9e0fbf8d23ba72f6567d3c7b` introduces a
server-only `ticketing_transfer_requests` table with Brand default-OFF opt-in,
scoped composite FK, private hashed recipient secret, one pending request per
ticket, 48-hour limit and immutable status history. Tests added for tenant
isolation, invalid tickets, self-transfer and database RLS. Package succeeded;
CI passed (run 38630063783). See `docs/TRANSFER_PROTOCOL.md`. This is groundwork,
not a live buyer transfer: no recipient claim, email, QR rotation or UI exists.

Previous main `2fe6bc50` passed CI and packaging. Strict production check
failed because Coolify does not publish the current Git SHA on `/health`.
New production migration must not be applied to an unverified/shared database.


## Run 76 QA evidence

CI and Package both succeeded for SHA `1035bcf63941990d6e28fc8d632ddbf2b51b23eb`. The expiring bearer-token validation is therefore tested in GitHub. Coolify release SHA remains unverified.


## Run 76 (October 14, 2026)

Pushed d67896fb317dcbaa6ba7aa373e5843b95b5440b8: a shared authorization check for buyer order viewing and session exchanges. Expiring order access keys are rejected when their expiry is reached; existing links without expiry remain supported. Tenant-scoped regression tests added. Package succeeded. New CI result must be checked. Previous Run 75 passed CI and Package on 73cfd4f1. Production deployment is not verified: /health does not include the build SHA.


Updated: 2026-10-14. Source of truth: `takatakca/Alkao.ca`, branch `main`.
This repository is **ALKAO Ticket Hub**, a standalone ticketing engine, not the separate
ALKAO water-commerce concept. Do not replace its existing product or merge tenant databases.

## Product implemented in the repository

- Node 22, Hono, PostgreSQL + RLS, signed TAKATAK control contract and tenant entitlements.
- Catalog, session capacity, holds, Stripe Connect checkout/refunds/disputes, Québec taxes.
- Signed QR tickets, offline scanning, buyer ticket link, cancellation and notifications.
- Organizer operations (`/ops`), hosted shop (`/acheter`), FR/EN platform home and SEO.
- Marketing, waitlists and presale codes through Run 72.
- Run 73: public bilingual venue directory/detail pages, derived exclusively from gated events.
- Run 74 (code commit `413f2af9388c5052ce485bd0a0e19ee2c3171291`): server-side venue
  filtering and strict SHA-aware deployment verification (see current CI status below).

- Run 75 (code commit `9a596345de8ede86a3d52cde8d92a006db597ba6`):
  downloadable RFC 5545 .ics calendar per public venue (FR/EN), visible CTA and
  tenant-gated API, plus server-side calendar and API tests. No migration.

## Current delivery evidence

- Run 74: CI and Package confirmed successful at `5743ab1d540624a63c2ead00de7addcb7edb3e34`.
- Run 75: Package passed at `9a596345`. CI typecheck/migrations/secrets
  passed; the first full test run failed on test-only ICS line parsing assertions.
  Tests were corrected in `ce9db10f4f707a694c69914e31f015f8513aef38`.
  Its rerun was still in progress. Check CI at final main HEAD.
- Run 73: GitHub Actions CI and Package passed at `f339d3eb19a0f4e073ca89f7612c2c0bb5af5765`.
- Run 74: code changes pushed to main. CI passed for test correction `a790c193`;
  Package passed at `92a5c08d` (English venue navigation fix); newest CI was queued
  at the last check and must not be marked passed without its own result. `.github/workflows/verify-deploy.yml` runs only after a
  successful CI, and can be dispatched manually; its result is authoritative only for
  its own verification of the public service.
- The previous Live workflow on 2026-10-14 showed `/health`, `/health/ready`, and
  homepage responding but did **not** receive a build SHA from the server. No proof yet
  that Run 73/74 is deployed to the live service.

## Blocking external dependencies

See issue [#84](https://github.com/takatakca/Alkao.ca/issues/84):
confirm dedicated ALKAO database and backups, rotate values previously leaked in public
history, enable migration/start workers in Coolify, surface source commit and verify
readiness; configure payments, mail and sign-in through server-side secrets only.
Never mark the whole product launched while these prerequisites remain unresolved.

## Ownership and boundaries

TAKATAK is identity/control authority. ALKAO stores its own event/ticket/order data with
`client_id` and `brand_id` isolation. Tenant data does not flow to other Brands.
Operational APIs default off. Do not publish customer identities in client pages,
workflow logs, issues or this documentation.

Roadmap: [TASK_QUEUE.md](TASK_QUEUE.md). Exact continuation: [AGENT_HANDOFF.md](AGENT_HANDOFF.md).
