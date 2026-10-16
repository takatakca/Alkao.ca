# ALKAO — Decisions and non-negotiable constraints

## Run 87 — no multi-tab admission without origin-wide locking

The actual two-tab browser regression now loads `/ops/offline.js` as a browser module (source test fix `fa915328`), rather than letting Node's test runner rewrite the import.


Run 87 browser behavior is additionally checked in Chromium with two real tabs sharing origin storage; fixes through `88ae7715` correct the Node-typed test harness. Source CI 38958090144 and Package 38958090354 succeeded for `fa915328`; do not infer live deployment from these tests.


The Run 86 FIFO alone protects one Operations tab, not a second tab in the same browser storage partition. All offline scan/read/reconcile/write flows now acquire one exclusive browser Web Lock for the same session, held until any network operation finishes. This prevents localStorage snapshots from clobbering the latest physical admissions. Web Locks are widely supported only in secure contexts; absence of support MUST deny new offline admissions and direct staff to online scanning. An explicit recovery-only exception permits uploading preexisting local audit records so an old device does not strand guests. Locks do not coordinate separate browser profiles or physical gates; the server remains authoritative and the multi-device pilot is still mandatory.


## Run 86 — offline writes and synchronization share one queue

The first Run 86 CI caught strict TypeScript test callback annotations, corrected in `9fbd33a8`. Run 86 code passed CI 38955598793 and Package 38955598811; this does not certify Coolify.


Because localStorage read/write and network reconciliation are not transactional together, every scan, offline-manifest preparation, manual/automatic synchronization and exit within the same Operations scanner tab must run sequentially. Otherwise delayed acknowledgment of a batch could overwrite a new, already admitted ticket or permit exit before the new admission is durably recorded. Failed operations must not poison the FIFO. If storage writes fail, fail closed: operators must not see "admitted" until the audit queue is stored. This rule is tab-local and does not claim cross-tab or device-level atomicity. Multiple windows and real device storage eviction remain separate required acceptance tests.


## Run 85 — no manual override for unsynced offline admissions

Every attendee admitted offline creates an audit record that must survive network interruption. The Operations scanner must not allow an operator to exit mode and delete the queue while admitted entries remain unacknowledged, even via a confirmation dialog. A disconnected exit attempt leaves the offline queue intact and shows a clear instruction to reconnect and synchronize. Already-synced sessions can exit normally. This is a safety boundary, not a background upload promise.


## Run 84 — offline gate reconciliation may not create new admissions

Only an actual, cryptographically accepted offline entry may enter the upload queue. Offline rejected QR codes and old device queue entries lacking the `admittedOffline` flag must not be replayed after connectivity resumes; otherwise the live server could admit a ticket the gate operator rejected. The batch endpoint must acknowledge every index with a known outcome before pending admissions are removed, regardless of HTTP 4xx errors. A locally accepted entry later rejected by the server (duplicate, revoked, wrong session, etc.) counts as a discrepancy requiring operator review. Refuse silent data loss to preserve auditability. Keep all original backend money/order and tenant authority unchanged.


## Run 83 — absence of Ed25519 verification must deny admission

A QR identifier's presence in a cached offline manifest is not proof of validity. Every offline admission MUST verify its Ed25519 signature using a known trusted key; cryptographic absence or unsupported browser implementations must fail closed with a reconnect/online-scanner instruction. Invalid signatures remain explicit rejects; revoked and expired manifests are also rejects. We do not silently fall back to identifier-only access, even for known ticket IDs.


## Run 82 — cancellation overrides QR reissue

Session cancellation must immediately stop transfer initiation and recipient acceptance regardless of ticket status, because ticket void/refund work may execute asynchronously. Hold a session row lock while checking eligibility and during recipient claim, and reject direct backend request inserts using a private PostgreSQL trigger. Cancelled invitations may be marked skipped by the mail sender; no new QR or email is sent. Existing orders, ticket histories and provider refunds are unchanged. Global and Brand release switches stay OFF pending operator-approved production acceptance.


## Run 81 — payment eligibility must be transaction-safe

A new transfer or claim is forbidden while the source purchase has any pending ALKAO refund or a Stripe dispute except recorded wins / warning_closed / prevented. A lost dispute (including partial losses that leave valid tickets needing review) blocks transfers. Hold the paid order row `FOR UPDATE` before checking eligibility and ticket state to serialize with refund creation and settlement; enforce creation rules in PostgreSQL as a second boundary. Do not send a recipient invitation while payment is unresolved: defer 15 minutes without incrementing provider attempts, retry until resolution or invitation expiration. The recipient's QR must never be rotated in an unsafe payment state. This decision does not automatically refund or cancel an order.


## Run 80 — public transfers guarded by two independent switches

A regression checks that cron never sends transfer invitations with the release flag off, and sends only once after explicit activation (`f9203cec`).


Public transfer routes and recipient view require the usual operational Client/Brand authorization plus `ALKAO_TRANSFER_API_ENABLED` and a configured credential master secret. The Brand must also explicitly opt in; only owner/admin roles may alter this setting, recorded in the audit log. Never return claim proof or recipient email in the original buyer API response. Recipient obtains a distinct ticket access token after one-time confirmation; the sender may never display the recipient QR. The sender may not exchange a whole order with a pending/claimed transfer. Tenant isolation and 404 for bad claim/recipient token prevent enumeration. Email worker/cron processes transfer invitation queue only when global release is explicitly enabled; no feature is enabled merely by deployment. Production acceptance requires matching Coolify source SHA, migrations, and live provider/scan verification.


## Run 79 — revocation before access, scanners fail closed

Ticket transfers preserve immutable original order and ticket identity; recipient acceptance issues a separate ticket-view token while rotating the same ticket's signed credential in one transaction. The buyer's order QR lookup must exclude transferred tickets. Acceptances are one-time and restricted to a Client/Brand; old credentials can never become active again. Admission scanning must lock the ticket and recheck credential status after the lock. Offline manifests expire after ten minutes and the app must refuse missing/expired manifest validity rather than admit stale QR. Transfers are cut off at least fifteen minutes before the session's configured admission window. No public activation before end-to-end QA.


## Run 78 — secure recipient invitations

The future recipient proof is derived deterministically only from a trusted server-side master secret, immutable random invitation UUID, tenant, ticket and normalized recipient. The database stores only its hash, not the raw proof. Invites use a private transactional outbox; sender-side order links are not recipient proof. Email delivery stays disconnected from the production worker and from buyer UI until a validated recipient claim page, atomic QR revocation/reissue, fraud controls and scanner refresh policy are implemented. Existing pending invitations from the earlier random-token prototype are not automatically migrated to the new queue.


## Run 77 — private token handling

A one-time recipient secret is generated by the private transfer service and ONLY its SHA-256 is persisted; never expose the raw value to an original ticket holder or audit records. The private service has no public routes. Organizer transfers remain disabled until recipient mailbox proof, atomic replacement ticket/QR revocation and scanner safety pass tests.


## Run 77 transfer controls

Organizer transfers are explicitly **default OFF** in the database. A
`pending` transfer request is not an accepted transfer and does not affect
ticket ownership or QR validity. Recipient contacts and claim-token hashes
are never exposed to Data API roles. The ticketing engine must preserve
immutable sale/ticket/credential audit history, enforce one active request per
ticket and reject expired, void, admitted and cross-tenant requests. Future
transfer acceptance requires recipient mailbox proof plus an atomic issuance
of the recipient ticket and revocation of the original credential; no public
button may be released before that is implemented and tested. See
`docs/TRANSFER_PROTOCOL.md`.


## Run 76: bearer access expiry

Order-reading and buyer session-change endpoints verify the same scope, order and optional expiry. Expired keys always receive the generic order-not-found response. Existing order links with no expiry remain compatible. Future ownership-transfer functions must use the same authorization invariant.


Updated 2026-10-14. The existing product decisions are preserved in
[ALKAO_DECISIONS.md](ALKAO_DECISIONS.md). This file links engineering and operational
constraints; it does not retroactively change approved product policy.

1. **Product identity.** This repository is the detachable ALKAO Ticket Hub. Do not
   replace it with another ALKAO product or a new scaffold.
2. **TAKATAK authority.** TAKATAK Auth/control is authoritative for identity, client
   membership, entitlement and billing policy; ALKAO keeps independent tenant data
   and a signed projection of the permitted control records.
3. **Isolation.** All business-scoped records require Client + Brand scope;
   database RLS and server-side permission checks. No tenant's events, orders,
   tickets, or buyers may appear to another tenant without explicit authorization.
4. **Public venue pages.** Only an opted-in, entitled Brand with a currently
   publishable event is listed; venue IDs are scoped by Client/Brand and do not
   create a separate disclosure path. Search uses only that same gated list.
5. **Security and checkout.** Ticketing stays disabled by default. Never bypass
   checkouts, Stripe webhook verification, refunds, anti-oversell constraints, or
   incident controls to ship quicker. No raw secrets in this public repository.
6. **Publication evidence.** GitHub pushes, CI, packages and successful public
   health probes are different. A verified release requires exact SHA, readiness
   and product checks. Strict check fails when the SHA is missing or stale.
7. **Operator access.** Never assume Coolify access or mutate an unknown DB.
   Preserve all paid orders and scanner credentials during any migration.
8. **Buyer rights.** Refunds, chargebacks, open-date admissions and door sales
   follow the previously approved decisions in ALKAO_DECISIONS.md. Future
   transfer/Wallet/account features must respect those rules and require
   explicit privacy, entitlement, and scanning-revocation tests.

9. **Venue calendars.** Calendar exports are read-only views of already-public,
   currently on-sale sessions; they include venue/event details and a public shop
   URL only. They never include order links, tokens or identities. Existing
   calendar apps may retain previously imported sessions after they sell out;
   ALKAO does not promise to delete events from a user's own calendar.
10. **Deployment verification.** A CI workflow skipped due to a newer main commit
    cannot be presented as a successful live release verification.

These constraints remain in force while independent backlog tasks continue.
