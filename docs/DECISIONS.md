# ALKAO — Decisions and non-negotiable constraints

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
