# ALKAO — Buyer ticket transfer security protocol

Status (2026-10-14): **foundation only; feature disabled and no public route**.
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

## Remaining acceptance requirements (not implemented)

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

The next coding action is to implement the **private transaction-level request
service and cancellable, verified email invitation**. Do not add a public
claim endpoint or buyer-facing button before those checks exist.
