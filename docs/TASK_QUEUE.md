# ALKAO — Task queue (priority ordered)

Updated 2026-10-14. Before starting any task, read `AGENTS.md`, the top of
`WORKLOG.md`, and open PR titles. Claim a distinct item; do not duplicate active work.

| Priority | Task | State | Acceptance criterion |
| --- | --- | --- | --- |
| P0 | Run 74: public venue filtering, verified SHA monitoring | CI + Package passed at 5743ab1d; production unverified | Actual deploy separately verified, source SHA matches server |
| P1 | Run 75: public venue event calendar (.ics) | Source pushed; first CI test assertions fixed in ce9db10f; latest CI pending | Full CI success, live 404 controls revalidated after Coolify redeploy |
| P0 | Coolify deployment / dedicated DB / key rotation | BLOCKED — owner infrastructure; issue #84 | Dedicated DB checked, secrets rotated, /health build matches main, /health/ready healthy, payments tested before enablement |
| P1 | Buyer ticket transfer to a friend | TODO | Explicit opt-in per Brand, owner authenticated with scoped token, new credential revokes previous QR, exact-once audit, no sale/resale or cross-tenant leakage, tests |
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
