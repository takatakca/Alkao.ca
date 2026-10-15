# ALKAO — Task queue (priority ordered)

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
