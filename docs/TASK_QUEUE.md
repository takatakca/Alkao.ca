# ALKAO — Task queue (priority ordered)

## Run 85 — scanner audit-persistence follow-up (2026-10-16)

- Implemented `62aedcd5`: prevent exit from offline scanning until all locally admitted QR records are acknowledged by the server; show actionable error, no destructive confirmation. E2E browser test covers disconnected exit and authorized exit after sync.
- Source CI 38944264243 **SUCCESS**, Package 38944264279 **SUCCESS** at `62aedcd5`; check docs commit CI independently. P1 next: multi-scanner actual field testing and manual resolution of discrepancies (revoked, double admission, offline time drift). P0 production #84: live SHA attestation, backed-up dedicated ALKAO database, approved migrations, Stripe/Resend/scanner signoff. Global and Brand transfer switches remain OFF.


## Run 84 — offline scanner reconciliation QA and next task (2026-10-16)

- New code `faf44749` and corrected UI/crypto tests `21a7031c`: queue ONLY offline accepted QR, filter legacy denied attempts, preserve unacknowledged batches, verify per-index scan result, increment gate reconciliation incident count when offline admitted QR is later denied by server. Tests for two gates, transferred revoked QR, HTTP failures, incomplete replies, batch sizes and replay behavior.
- Run 84 code at `21a7031c` passed CI 38942936131 and Package 38942935861; check documentation follow-up SHA separately. Address any new failures instead of assuming success.
- P1 acceptance: real devices and simultaneous offline gate scanners, true network interruption during batch commit, attendance discrepancy response and operator training. P0 release: issue #84, enable Coolify Include Source Commit in Build, attest `/health` SHA, backup dedicated DB and run migrations under explicit operator authority, rotate historical leaked secrets and test payment/email/scanner. Keep global/Brand transfer flags OFF and Promo Havana PR #53 isolated.


## Run 83 — cryptographic offline gate (2026-10-16)

- Implemented source `7b004ba2`: fail-closed Ed25519 in offline scanner; support absent -> explicit `signature_unavailable` (online fallback), forged QR rejected, valid signed QR can pass with fresh manifest, revocations and TTL respected. Unit tests added.
- QA: source CI 38885296988 SUCCESS and Package 38885297040 SUCCESS on `7b004ba2`; check docs commit run separately. P1 next: real-device safari/android WebCrypto/Ed25519, offline multi-gate sync, scanner manifest refreshing and refund/chargeback acceptance. P0: Coolify #84 deployment SHA and backup/schema/operator approval, no activation before proof. Keep PR #53 isolated.


## Run 82 — continuation after session cancellation guard (2026-10-16)

- Run 82 `7f5e7d13`: application locks/eligibility for cancelled sessions, additive PostgreSQL trigger and regression tests. Code SHA `7f5e7d13` passed CI 38884229198 and Package 38884229102. Check separate docs follow-up checks.
- Next P1: multi-device offline scanner manifest expiration vs revoked transferred QR, pending payment provider outcomes, clearer paused invitation UI. P0: issue #84 independent Coolify SHA, dedicated database/backup, migration, key rotation, full provider pilot. Flags remain OFF. PR #53 is separate.


## Run 81 — finance/transfer safety continuation (2026-10-16)

- Implemented: order-locked pending refund and dispute gates on create/claim; SQL guard preventing bypass; mail queue defers and retries without burning provider attempts; tenant-scoped regression tests.
- QA: CI 38883239557 **SUCCESS**, Package 38883239522 **SUCCESS** for source `1debe096c9c8ad5421b7c39b1efe68ff744df8d6`; re-check CI of follow-on docs commit before claiming that newer SHA verified.
- Next independent P1: cancelled session acceptance while cancellation/refund workers run; actual refund/chargeback and offline manifest admission races; user-visible handling of deferred invitations. P0 production #84: dedicated ALKAO database backup, source SHA and health proof, approved migrations and secret rotation, Stripe/Resend pilot. Global and Brand transfer flags remain OFF; no production activation.


## Run 80 — next required execution (2026-10-16)

Extension: worker release regression `f9203cec`, UI collision fix and `.env.example` release flag `e085b59f`. Check latest CI before closing.


Run 80 source through `fe6abc32`: tenant-scoped buyer transfer prepare/list/cancel API; one-use recipient claim/new QR API; FR/EN recipient and buyer pages; opt-in admin API/UI; automatic Resend invitations through existing worker or cron gated by global OFF-by-default flag. Full CI 38854862144 and Package 38854861945 succeeded for `e085b59f`. Live release remains pending.
**P0:** Coolify #84: dedicated database backup, run all migrations, restore live build SHA attestation, rotate historical leaked credentials and verify Resend, scanner, Stripe and end-to-end on production. DO NOT turn on `ALKAO_TRANSFER_API_ENABLED` or any Brand opt-in before verified live release and operational sign-off.
**P1:** further harden transfer refund/chargeback races, cross-device/offline scanner E2E, test email provider delivery and regulatory/incident procedures. Apple/Google Wallet and assigned seats remain separate uncompleted backlog.
Next action: inspect CI run for newest main; repair failures; audit actual Coolify `/health` SHA; document operator release if verified.


## Run 79 results and remaining work — 2026-10-15

Implemented and CI validated at `a4994017`: scoped exactly-once recipient claim service, atomic old-QR revocation/new credential, sender-code suppression, scanner ticket row locking/freshness, private immutable acceptance ledger, tests. Production not verified. Public transfer initiation/cancellation and recipient claim/ticket page, email worker activation, FR/EN UX, end-to-end refund/scanner/device tests and Coolify go-live remain P1 TODO; do NOT describe transfers as available to buyers.


## Run 78 QA (2026-10-15)

Source `e3b17774`: full CI and Package passed. Default-inactive recipient mail dispatcher and private transactional invitation outbox implemented. Next mandatory P1 work: recipient-only claim validation and atomic ticket credential replacement, sender access revocation, scan-manifest freshness and accessible bilingual UI. This is not an available customer feature. Deployment remains blocked on Coolify issue #84.


## Run 77 — next required work

Default-off transfer request schema and internal invitation/cancellation service were pushed and passed CI/Package through `c7864c57`. Recipient email proof, one-time claim, transactional issuance/QR revocation, buyer UI, offline scanner policy and production deployment are NOT DONE. Implementation contract: `docs/TRANSFER_PROTOCOL.md`.


## Run 77 — Transfer request foundation

Migration `20261105000100_alkao_transfer_requests.sql` and DB/RLS tests
were pushed at `0da240f2`; CI and Package both passed.
Transfer switch is OFF by default; there is NO recipient claim, email,
QR revocation or buyer-facing UI yet. See [TRANSFER_PROTOCOL.md](TRANSFER_PROTOCOL.md)
for mandatory next steps. Production migrations are blocked pending Coolify #84.


## Run 76 QA

Source implementation and tests completed; CI and Package successful at `1035bcf6`. Production delivery still blocked by issue #84. Next planned P1 feature is recipient-verified ticket transfer; not implemented.


## Current continuation — Run 76

Run 75 CI and Package succeeded at 73cfd4f1. Run 76 (d67896fb) added expiry enforcement to order access authorization; Package succeeded, CI confirmation pending. Production still unverified (Coolify issue #84). Next P1 feature: securely claimed per-Brand buyer ticket transfer with an audit trail and revocable entry credential. Not yet available.


Updated 2026-10-14. Before starting any task, read `AGENTS.md`, the top of
`WORKLOG.md`, and open PR titles. Claim a distinct item; do not duplicate active work.

| Priority | Task | State | Acceptance criterion |
| --- | --- | --- | --- |
| P0 | Run 74: public venue filtering, verified SHA monitoring | CI + Package passed at 5743ab1d; production unverified | Actual deploy separately verified, source SHA matches server |
| P1 | Run 75: public venue event calendar (.ics) | Source pushed; first CI test assertions fixed in ce9db10f; latest CI pending | Full CI success, live 404 controls revalidated after Coolify redeploy |
| P0 | Coolify deployment / dedicated DB / key rotation | BLOCKED — owner infrastructure; issue #84 | Dedicated DB checked, secrets rotated, /health build matches main, /health/ready healthy, payments tested before enablement |
| P1 | Buyer ticket transfer to a friend | Run 77 DB foundation pushed; NOT LIVE | Explicit opt-in per Brand, recipient email proof, owner token, atomic replacement QR, immutable audit, no resale or cross-tenant leakage, tests |
| P1 | Apple / Google Wallet | TODO — provider credentials needed for real passes | Valid signed passes, secure entitlement/refresh/revoke, check gate scan, real device/provider verification |
| P1 | Light buyer account / secure ticket discovery | TODO | Explicit buyer consent/auth, no account enumeration, tickets isolated across tenants and scoped by verified identity, privacy/export/delete |
| P2 | Assigned seats and accessible ticket options | TODO — product scope needed | Inventory atomic, no double booking, accessible options and clear buyer display |
| P2 | Virtual waiting room for large sales | TODO | Fairness, bounded queue, abuse protection, no inventory overselling |
| P2 | Continued accessibility/performance/mobile audits | CONTINUOUS | CI + supported browser/device and WCAG regressions |
| P2 | Merchant integration and deployment runbooks | CONTINUOUS | Tenant endpoints, delegated permissions, migrations and rollback documented |

Features listed as TODO are **not** represented as live. Existing waitlist (Run 71) and
presale codes (Run 72) are distinct from the unimplemented virtual waiting room.

Safe parallel work: tests, monitoring, UX, documentation, non-payment catalog features.
Never enable payment production, migrate an unknown database, import real buyer data, or
rotate secrets by guessing missing access.

Successful feature work: analyze → code → test (at least typecheck/CI/security) →
commit → publish → confirm actual deployment → update handoff.
