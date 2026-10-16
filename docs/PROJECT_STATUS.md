# ALKAO — Project status

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
