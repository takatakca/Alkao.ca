# ALKAO — Buyer ticket transfer security protocol

## Phase 6 — pending refunds and disputes (Run 81, 2026-10-16)

`src/ops/transfer-payment.ts` and order locks reject request creation or recipient claim with an unsettled payment. `20261108000100_alkao_transfer_payment_guards.sql` enforces the same protection against direct backend inserts. Disputes marked lost remain disqualifying until staff's separate remediation, even for partially disputed orders. Unresolved refunds/disputes defer the secure email invitation by 15 minutes without exhausting send attempts, allowing successful delivery after resolution and before the existing expiry. Regression tests in `test/db/transfer-payment.test.ts` cover direct schema bypass, deferred/returned delivery, unchanged QR on failed claim and tenant-local payments. Full source CI 38883239557 and Package 38883239522 passed for `1debe096`. No changes to Brand/global default-OFF flags. Coolify deployment and provider evidence remain outstanding.


## Phase 5 — feature-gated buyer/recipient delivery and interfaces (Run 80, 2026-10-16)

Run 80 test hardening: cron dispatch is checked OFF by default and exactly once after enabling in `test/ops/transfer-worker-gate.test.ts` (`f9203cec`). The Operations toggle labels inactive transfer `non autorisé` (`e085b59f`).


Source commits `59e31276`, `d0f11e21`, `fe6abc32` build an end-to-end API and browser workflow on the prior transaction-safe claim and credential rotation. Buyer page allows ticket-by-ticket invitation, cancellation and pending status only after opt-in. A standalone, noindex/referrer-protected bilingual recipient page confirms the one-use proof and retains a **separate** ticket-view token in the URL fragment after acceptance. The original buyer order responds with `transferred=true`, no recipient QR, and its whole-order exchange is refused when a transfer is pending/claimed. Organizer owner/admin controls Brand opt-in with audit; a separate platform flag `ALKAO_TRANSFER_API_ENABLED` remains false by default. Email worker and cPanel cron dispatch transfer invites through real Resend only when that flag is explicitly on, with retries and private recipient addresses. The backend checks Client/Brand, purpose, expiration, session cutoff, QR revocation and replay; tests include API isolation and real Chromium buyer/recipient flows.

Run 80 source QA: CI 38854862144 and Package 38854861945 **SUCCESS** at `e085b59f`. **Source is NOT automatically live.** Do not activate transfers, email dispatch or pilot brands until exact Coolify SHA, migrations, backups, signed QR/scanner manifest tests and Resend delivery are verified under issue #84. Remaining operational acceptance includes end-to-end provider email delivery, refund/chargeback and offline multi-device races, pilot staff training, production health and accessibility signoff.


Status (2026-10-16): **Run 80 implemented in source, but disabled and not verified live**.
This document describes what remains before any organizer can safely enable a
ticket transfer. ALKAO remains a separate tenant-owned ticketing engine; TAKATAK
owns identity and entitlements.

## Phase 1 — persisted safety boundary (Run 77)

Migration `20261105000100_alkao_transfer_requests.sql` adds:
- `ticketing_brand_settings.ticket_transfers_enabled`, default **false** for all Brands.
- `ticketing_transfer_requests`, scoped by Client, Brand, Event, Session and original
  Ticket with a composite FK. Contact addresses and claim hashes are server-only
  under RLS; anonymous and authenticated roles receive no direct table grants.
- A nonreversible 32-byte hash for the future one-time recipient secret, never a
  claim secret or QR in public records.
- One `pending` transfer per original ticket, 48-hour maximum request lifetime,
  immutable request identity, no deletion, one-way cancellation/expiry.
- A database guard rejecting: transfers without organizer opt-in; a void ticket;
  a non-paid order; a ticket already admitted; past events; or sending to the
  purchase email. The ticket row is locked before a request is accepted.

**Important:** This migration does not move ownership or revoke any QR. It does
not accept claims, send email or expose a button. Organizers must not enable
transfers until later phases and go-live checks have passed.

## Phase 2 — private invitation/cancellation service (Run 77)

`src/ops/transfer-request.ts` now implements transaction-locked
`prepareTransferInvitation` and `cancelTransferInvitation`. Both enforce
an existing order-scoped bearer token with optional expiry, require the correct
Client and Brand, and audit the operation. The invitation returns the one-time
recipient secret **only to the internal service caller**, which must eventually
pass it to an authenticated email delivery worker; the database stores only its
SHA-256. The cancellation is idempotent and leaves the original QR intact.
See `test/db/transfer-service.test.ts` for tenant, expiry, audit, duplicate
and wrong-token regression coverage.
CI/Package passed for the service at `c7864c57` (CI 38631015271).

There is still NO public initiation or claim route; no email is sent; no QR
is reissued. This internal capability is not a complete transfer feature.

## Phase 3 — staged recipient invitation delivery (Run 78, 2026-10-15)

- Source commit `e3b1777434f72db73110d1c0889e1af84c8adff2` adds a service-only
  `ticketing_transfer_invitation_outbox`, with transactional enqueue, per-tenant
  composite FK, no PostgREST read access, immutable delivery identity, retry
  states and idempotency keys. Migration `20261106000100_alkao_transfer_invite_delivery.sql`.
- `src/delivery/transfer-token.ts` derives the recipient proof from a
  server-only master secret, random request UUID, tenant, ticket and recipient
  address; only its SHA-256 is stored in the request. The delivery worker can
  reconstruct a proof after retries, without persisting any raw token.
  Existing requests created before this change cannot be reconstructed and
  are intentionally NOT automatically backfilled or emailed.
- `src/delivery/transfer-invitations.ts` implements a dedicated, testable,
  FR/EN-compatible recipient email and transactional delivery function.
  It checks request status, expiry, ticket/Brand eligibility, actual admission
  and key rotation before dispatching. It does NOT copy sender's QR.
- **Safety gate:** `deliverRecipientInvitations` is intentionally NOT called
  by `startEmailWorker`. No recipient email is dispatched in production, as the
  claim URL/page and atomic transfer/revocation have not been implemented.
  Do not enable the sender, create a buyer transfer button or distribute claim
  URLs until full claim, revocation and offline scanner tests pass.
- Test coverage: transaction queue, deterministic proof/hash, cancellation,
  opt-in disable, mail retry, deduplication, rotated key and HTML escaping.

## Phase 4 — internal claim and QR rotation (Run 79, 2026-10-15)

- Source `99f94e3582b3e8c063fdadf5c0d62e090fe296f1` and migration
  `20261107000100_alkao_transfer_acceptance.sql` add append-only,
  tenant-scoped `ticketing_transfer_acceptances`. Request moves to `claimed`
  only alongside an acceptance in the same database transaction.
- `src/ops/transfer-acceptance.ts` validates recipient's mailbox proof hash,
  one-time status, expiry, Brand opt-in, valid paid ticket, scanner admissions,
  and cutoff before the admission window. It revokes the prior credential,
  creates the new credential for the SAME immutable ticket, writes a PII-free
  audit entry, and gives the recipient a separate access capability.
- Original buyer's order QR lookup excludes accepted-transfer tickets, so
  refreshed buyer pages and embedded QR emails cannot display the new code.
  Recipient-only credential reads require the separate access token; refunds
  void the original ticket and revoke its active credential as before.
- Online scanner locks the ticket and refreshes credential status before
  admitting a scan, serializing claim/entry races. `ops-ui/offline.js` now
  rejects absent or expired `manifest.validUntil` without admitting or
  queuing a scan; staff see a reconnect instruction. Creation/acceptance
  cutoff keeps QR changes outside the old manifest's validity window.
- **Not live:** no public transfer route, no recipient claim page, no
  automatic transfer email and no issuer configuration UI. End-to-end
  payment/refund, browser, offline-device, accessibility and Coolify
  release checks are still required before activation.

## Acceptance controls (implementation varies; live verification outstanding)

1. An authorized order-link holder must select one valid ticket, not an entire
   order. Require the current unexpired scoped bearer token for initiation.
   Apply rate limits, anti-abuse, audit and an explicit opt-in policy.
2. Send a single-use, time-bounded claim invitation to the proposed recipient.
   Do not return the recipient secret to the sender or expose the email in any
   public order response. Mail delivery must be real, retryable and revocable.
3. Recipient must prove mailbox ownership with the one-time secret. Compare
   secret hashes, expiry and recipient address. Prevent replay and cross-tenant
   usage; row locks must make concurrent claims exactly once.
4. Acceptance must atomically create ownership and ticket access for the
   recipient, void the sender's original ticket, revoke its credential, issue
   a fresh signed QR, record an immutable audit trail, and arrange recipient
   notification. Never rewrite immutable order/ticket history or change money.
5. Ensure buyer order GET / offline cache cannot continue to disclose a valid
   transferred QR to the sender. Integrate revocations into online gates and
   offline manifests. An out-of-date offline scanner presents a known replay
   risk: enforce a freshness policy, not just a UI warning.
6. Permit sender cancellation before acceptance, expiry cleanup, organizer
   disablement, refunds, exchanges and incident response without bypassing the
   existing purchase/refund protections. Disallow resale.
7. Tests: no opt-in, wrong tenant, wrong buyer, invalid/replayed claim token,
   expired request, paid/refunded/void/admitted ticket, concurrent claim,
   refund race, scanner revoke/accept, email failure, audit, accessibility
   and FR/EN responsive interfaces.
8. Live enablement requires dedicated ALKAO database, secrets, workers, signed
   QR keys and verified deployment SHA. See `docs/DEPLOYMENT.md` and issue #84.

Next: implement recipient-only token consumption, atomic QR rotation and protected recipient ticket access; validate offline manifest freshness, revocation, refunds and race conditions, then activate the tested mail sender and buyer UI together.
