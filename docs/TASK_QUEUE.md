# ALKAO — Task queue (priority ordered)

## Automatic deployment (2026-10-28)

1. Merge the `claude/auto-deploy-coolify` PR.
2. Owner, once (`docs/ALKAO_DEPLOY_COOLIFY.md`, "Automatic deployment"): Coolify API access on, a Deploy-only API token, the deploy webhook URL, the `COOLIFY_WEBHOOK` and `COOLIFY_TOKEN` GitHub secrets, Coolify's Auto Deploy off.
3. Then **Actions → Deploy → Run workflow**: its verify job must end green.

## alkao.ca back online (2026-10-26)

1. Done: `/health` 200 with build `cd5f679`.
2. Owner, by October 28 (`docs/CE_SOIR_HAVANA.md`): live Stripe keys and webhook, Resend, Havana's Stripe onboarding, a 1 $ test purchase and its refund, then publish Halloween of the 31st in /ops.
3. Otherwise Weezevent also sells the 31st, and ALKAO takes the next events.


## Run 103 — partner company codes (2026-10-24)

1. Done: merged d58dec6 (PR #98). Run 104 merged 3f6fed5 (PR #99). Run 105 (return offer) merged cd5f679 (PR #100).
2. Still first: alkao.ca back online (Run 102, Coolify Redeploy).
3. Next ideas, in the owner's direction (presales and coupons that bring buyers back):
   - price phases: done in Run 104;
   - a return coupon: done in Run 105 (one code per event, shown to every buyer); a code unique per buyer is a later option.


## Run 102 — alkao.ca back online (2026-10-24)

1. Done: merged 5b02c28 (PR #97).
2. Operator or owner, in Coolify (ALKAO): read the logs, delete the emptied variable or fix the malformed one, Redeploy. `https://alkao.ca/health` must show `"service":"alkao"` (`docs/CE_SOIR_HAVANA.md`, top).
3. Halloween on the 24th stays on Weezevent. The 31st moves to ALKAO only if steps 1 to 6 of `CE_SOIR_HAVANA.md` are done by October 28.


## Run 101 — presale countdown and results (2026-10-22)

1. Done: merged f357d08 (PR #96).
2. Owner: after a presale, read "Codes promo et coupons" in /ops → Tableau de bord to see what each coupon brought.


## Run 99 — catalog files and coupons kept off presales (2026-10-22)

1. Done: merged 7b17b0a (PR #94). Run 100 (pass dates in the e-mails and on alkao.ca) merged f9095a7 (PR #95).
2. Owner: in /ops, tick "Non cumulable avec la prévente" on a coupon meant for regular prices only (`docs/PREVENTES_COUPONS.md`).


## Run 98 — festival passes (2026-10-22)

1. Done: merged 21cc80d (PR #93). Run 99 did the import and the coupon switch.
3. Owner: create a festival pass in /ops (`docs/PASSES_FESTIVAL.md`). It goes live with the next deploy.


## Run 97 — presales and coupons (2026-10-22)

1. Done: merged 2939a27 (PR #92). Run 98 did the festival passes.
3. Owner: create the first presales and coupons in /ops (`docs/PREVENTES_COUPONS.md`). They go live with the next deploy.


## Run 96 — Havana's sale, what remains (2026-10-22)

1. Owner, privately in Coolify:
   - the live TAKATAK Stripe key and webhook secret;
   - a valid Resend key.
   Then Havana's Stripe onboarding in /ops.
2. Operator agent:
   - remove `ALKAO_HOME_URL` and redeploy ALKAO;
   - after a passing paid test ticket, publish Halloween's two sessions, with capacity 3,000 minus each Saturday's Weezevent sales;
   - redeploy Promo Havana (`main` has the Weezevent removal, PR #29, `4e38f98`).
3. Owner: close the Weezevent sale. Tickets already sold there stay valid at the gate (Weezevent app).


## Run 95 — choice B (2026-10-20)

1. Owner: give the real capacity per evening, and approve or rewrite the refund policy proposed in `docs/CE_SOIR_HAVANA.md`, step 6.
2. Operator and owner: steps 1 to 8 of `docs/CE_SOIR_HAVANA.md` before Friday 23 October. Close Weezevent the same day promohavana.ca switches to ALKAO.


## Run 94 — Havana live on alkao.ca (2026-10-18)

1. Merge the Run 94 PR when CI is green.
2. Owner: choose A (separate ALKAO quota, Weezevent keeps selling) or B (everything on ALKAO). Then give the capacity per evening and write the refund policy.
3. Coolify operator and owner: `docs/CE_SOIR_HAVANA.md`, steps 1 to 7 (8 with choice B).


## Run 93 — the event page in full (2026-10-18)

1. Merge the Run 93 PR when CI is green.
2. Owner: fill Havana's event page in /ops → Événements → Page de l'événement. It needs photos (https), highlights, Le jour J, the FAQ and the ticket descriptions. The assistant can draft the texts once it is turned on.
3. Later: buyer reviews, collected after the visit (Run 45 e-mail), before any star is shown on the page.

## Run 92 — executive pass (2026-10-17)

1. Merge the Run 92 PR (home copy, /ops overview, writing assistant) when CI is green.
2. Owner decision: turn the writing assistant on (Anthropic key, budget, model choice; `docs/ASSISTANT_REDACTION.md`). It stays off until then.
3. Next AI steps, each needing the owner's go-ahead (paid):
   - the public home assistant answering with Claude, grounded in the FAQ and the live catalog, with a separate flag and rate limit;
   - a weekly sales summary in plain words for the owner.
4. Still P0: Coolify #84, then `docs/HAVANA_SUR_ALKAO.md`.

## Runs 90–91 — buyer pages and Havana on alkao.ca (2026-10-17)

1. Merge PR #85 (Run 90 premium buyer pages, Run 91 `events:import`) when CI is green.
2. Operator: Coolify #84 (`ALKAO_MIGRATE_ON_START=true`, redeploy, `/health/ready` `"schema":"current"`).
3. Operator and owner: follow `docs/HAVANA_SUR_ALKAO.md` (provision Havana, Stripe, `events:import --capacity … --publish --list-on-alkao`, Apparence, `check:golive`, test purchase).
4. Promo Havana: set `ALKAO_URL`, `ALKAO_CLIENT_ID`, `ALKAO_BRAND_ID` in its Coolify resource once Havana exists in ALKAO.

## Run 89 — local incident report storage failure (2026-10-16)

Code `8b06cf83`: automatic post-close scanner cleanup gracefully retains original audit if incident archive storage is corrupt; accessible staff warning, and regression simulating recovery. CI 38962087021 **SUCCESS** and Package 38962086850 **SUCCESS** for code `8b06cf83`. New docs-only commit needs separate verification. Next P1: actual iOS/Android private mode/storage quota + CSV download acceptance, multi-physical-device attendance conflicts and operations remediation workflow. P0 unchanged: Coolify #84 SHA/DB/backup/migrations/key rotation/Resend/Stripe and transfer pilot, default-OFF global and Brand flags.


## Run 88 — offline incident evidence continuation (2026-10-16)

Implemented `e0dbc920` and `427668f7`: persist reconciliation incidents with redacted identifiers and per-session CSV; archive on offline exit and manifest expiry, fail closed on storage corruption/quota; browser and unit tests. CI 38960997547 and Package 38960997727 **SUCCESS** on source `427668f7`; new documentation commit has its own CI/Package runs. Next P1: real mobile/webview CSV downloads and local storage durability, multi-physical-gate reconciliation/incident response, retention and operator access procedures. P0: Coolify #84 live SOURCE_COMMIT proof, dedicated ALKAO DB backup/migrations/rotation, Resend/Stripe/scanner pilot, transfer switches OFF. Do not alter Promo Havana PR #53.


## Run 87 — cross-tab admission log safety (2026-10-16)

The real Chromium two-tab test required a browser-side module-loading fix (`fa915328`); source CI 38958090144 SUCCESS and Package 38958090354 SUCCESS for `fa915328`. Next check docs follow-up CI and strict live SHA. Initial browser CI 38957592844 failed one test-only dynamic import issue.


Verified `cb184a49` unit source CI 38956850284 and Package 38956850276. Real two-tab Chromium test added at `6032a530`, browser TypeScript fixes through `88ae7715`. Verify 38957592844 CI and 38957592600 Package; fix any failures before release.


Source `cb184a49`: use secure, origin-scoped exclusive Web Locks around each offline scan, sync, preparation and exit in addition to per-tab FIFO. Fail closed for NEW offline admission when Web Locks unsupported; permit only existing audit recovery. Unit tests `test/ops/offline-cross-tab.test.ts` simulate two tabs contending during delayed network sync, unsupported browser and error recovery. Verify latest CI 38956850284 / Package 38956850276, correct any failures. Next P1: real browser cross-tab E2E and iOS/Android embedded contexts, multi-physical-gate/clock-skew pilot, durable auditing under storage eviction and offline access policy. P0: Coolify #84 source SHA, separate DB+backup, migrations, secret rotation and Stripe/Resend/gate signoff; transfer switches OFF.


## Run 86 — scanner local audit concurrency and remaining work (2026-10-16)

Initial CI 38955194282 reported two test-only TS7006 annotations; corrected in `9fbd33a8`. Follow-up CI 38955598793 SUCCESS and Package 38955598811 SUCCESS on `9fbd33a8`. Confirm independent docs CI and strict live SHA separately.


Implemented at `29a5f8f2`: per-Operations-tab FIFO for scan, sync, offline preparation and exit; queue persistence after late network responses; failure to write to storage blocks successful admission; regression tests simulate concurrent actions and HTTP failure recovery. Verify current CI 38955194282 and Package 38955194286, correct any failures; check docs commit separately. P1 next: prevent simultaneous scanner windows on shared browser storage, test quota/privacy-mode write failures on real devices, manage offline multi-gate duplicate admissions and operator discrepancy workflow. P0: Coolify #84 — source SHA absent on live `/health`, dedicated DB, backups, migrations, provider keys and real pilot. Global/Brand transfer flags OFF. Preserve Havana PR #53.


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
