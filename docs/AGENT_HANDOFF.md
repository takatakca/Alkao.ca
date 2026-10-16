# ALKAO — Agent handoff (mandatory)

## Run 84 — offline gate queue and lossless reconciliation (2026-10-16)

- Repo: `takatakca/Alkao.ca`, branch `main`. Previous confirmed HEAD `3b5846a4b534d4dd162f3a00be23add0ebfc4b5f`: CI 38885842348 **SUCCESS**, Package 38885842312 **SUCCESS**; strict Verify deployment 38886146185 **FAILURE**.
- Run 84 worklog claimed at `f594d7e9833de65a4de34944c47581f886954ea6`, code commits `faf44749151a3614748d1dce1eb88a6546632190` and `21a7031cde9ef7da4ca7077b7ab015bad00022c1` (adapted existing UI and cryptographic regression tests) (check final current SHA). Changed `ops-ui/offline.js`, `ops-ui/app.js`, `test/ops/offline.test.ts`, `test/ops/offline-signature.test.ts`; added `test/ops/offline-reconciliation.test.ts`, and `test/ui/ops-ui.test.ts`.
- Fix: offline scanner now enqueues ONLY locally authenticated/admitted QR. Malformed, unsupported Ed25519, expired manifest and all other locally denied attempts cannot be replayed by the server as unattended admissions. Legacy persisted queues with no `admittedOffline: true` are filtered without submission. `syncOffline` retains the whole admission batch on HTTP errors, malformed/partial acknowledgment, bad index or unknown result; it removes entries only after all 500-or-fewer indexed results are recognized. Any locally admitted QR rejected online (already_admitted/revoked/etc.) increments an incident counter with generic wording rather than asserting another gate was responsible. New unit tests cover two gates, revoked transferred QR, bad HTTP 403, incomplete results, 501 entries and stale queued denials.
- Source code CI **SUCCESS** run 38942936131 (typecheck, migrations, secrets, all tests) and Package **SUCCESS** run 38942935861 for `21a7031cde9ef7da4ca7077b7ab015bad00022c1`. A documentation-only commit will advance HEAD and get independent checks. No migration in Run 84. Production transfer flags still default OFF.
- Deployment: live strict Verify deployment `38886146185` FAILED on previous SHA: logs explicitly say `le serveur ne publie pas le SHA du build (Include source commit in build)` on eight attempts. Issue #84 requires Coolify include source commit, clean dedicated ALKAO DB, backup, migrations, secret rotation, live Stripe/Resend/scanner acceptance; do not infer deployment from `Live` SUCCESS. No production deployment performed.
- NEXT exact action: confirm current CI/Package; repair failures; check current live `/health` SHA and `/health/ready`; coordinate authorized Coolify configuration and DB backup/migration. Independently run real mobile/browser two-gate acceptance and network-loss QA. Do not touch unrelated Promo Havana PR #53. External session orchestrator is not connected.


## Run 83 — fail-closed offline QR signature check (2026-10-16)

- Repo `takatakca/Alkao.ca`, `main`. Prior Run 82 functional SHA `7f5e7d135f35a59e9ac7e5f9d376a3f327992f63` passed CI 38884229198 and Package 38884229102. Run 82 handoff commit `217c01b27f62cd4bda056910e705a3cba21f0d68` preserved.
- Latest Run 83 source SHA `7b004ba2b408d3e0f65ed710927f6c3684503a66`. Modified `ops-ui/offline.js`: a manifest ID match can NEVER compensate for unverified Ed25519 signature. Missing WebCrypto or unsupported Ed25519 returns `signature_unavailable` and does not admit the ticket. Invalid cryptographic signatures return `invalid_signature`. `ops-ui/app.js` instructs staff to switch to online verification instead of admitting without proof.
- New `test/ops/offline-signature.test.ts` covers no WebCrypto, unsupported Ed25519, forged QR, authentic signed QR, revocation on refreshed manifest, and manifest expiry. Tests intentionally use local Node Ed25519 key pairs, not secrets or customer QR.
- Source CI **SUCCESS** 38885296988, Package **SUCCESS** 38885297040 for code SHA `7b004ba2b408d3e0f65ed710927f6c3684503a66`. The documentation commit will advance main and trigger its own CI; a green package does not attest Coolify. No database migration in Run 83, no change to buyer or payment API or Brand data.
- Production is NOT verified. Prior live strict deployment verifier failed to match `/health` build SHA; issue #84 requires Coolify source SHA, dedicated database, backups, migrations, historical secret rotation, Stripe/Resend, and pilot scanner verification. Transfers remain default OFF globally and by Brand. PR #53 belongs to a separate Havana branch.
- NEXT: verify newest `main`, CI/Package and live strict check; fix any test/browser errors. Test actual mobile browser online fallback, multiple offline gates and manifest refresh; then authorized Coolify go-live. No agent restart orchestrator exists.


## Run 82 — cancellation window transfer safety (2026-10-16)

- Repository `takatakca/Alkao.ca`, `main`. Previous Run 81 source `1debe096c9c8ad5421b7c39b1efe68ff744df8d6` passed CI 38883239557 and Package 38883239522. Run 81 docs commit `2529d343dbeb2c0a9abfa0c8a874a0d93ed7c8be` remains in history.
- Run 82 code commit `7f5e7d135f35a59e9ac7e5f9d376a3f327992f63`: `src/ops/transfer-request.ts` locks session FOR SHARE and refuses new invitations after cancellation, `src/ops/transfer-acceptance.ts` locks and checks session while recipient claims, `src/api/http.ts` maps organizer cancellation to 409, new `supabase/migrations/20261109000100_alkao_transfer_cancelled_sessions.sql` enforces insert-time check with session row lock, and `test/db/transfer-cancelled-session.test.ts` verifies pending claim rejection/QR not rotated, new request and SQL bypass rejected, and no email after cancellation.
- QA confirmed for `7f5e7d135f35a59e9ac7e5f9d376a3f327992f63`: CI SUCCESS 38884229198 (TypeScript, migrations, secrets, full tests), Package SUCCESS 38884229102. Docs-only follow-up commit will trigger its own checks.
- Production: still NOT VERIFIED. Coolify strict live SHA checks failed in prior runs; no operator access or secrets were assumed. `ALKAO_TRANSFER_API_ENABLED` and Brand transfer switches remain default OFF. Issue #84 still requires dedicated DB verification, backup, migrations, historical secret rotation, provider tests and current build SHA attestation.
- Next action: verify newest `main` and CI; correct any Run 82 failures; continue offline manifest/chargeback race tests or operator-approved Coolify deployment. Never deploy migrations against an unconfirmed shared DB, do not touch PR #53. No automatic agent restart configured.


## Run 81 — payment dispute/refund hardening (2026-10-16)

- Repository: `takatakca/Alkao.ca`, branch `main`. Previous main `e084ca7cd231cd9ffd6c885547a8ee01a92a1187`: CI 38855328040 SUCCESS; Package 38855327968 SUCCESS; strict Verify deployment 38855537560 FAILURE.
- Run 81 functional commits `7b19da340072c7c11db2049991e97e79c3fa56c9` and `1debe096c9c8ad5421b7c39b1efe68ff744df8d6`. New `src/ops/transfer-payment.ts` checks pending order refunds and disputes other than won/warning_closed/prevented. `src/ops/transfer-request.ts` locks order before ticket and blocks unsafe invitations; `src/ops/transfer-acceptance.ts` checks the same boundary after the order lock before QR rotation.
- `supabase/migrations/20261108000100_alkao_transfer_payment_guards.sql` replaces the private trigger to reject direct DB transfer creation under unsettled payments. `src/delivery/transfer-invitations.ts` defers delivery by 15 minutes without exhausting provider attempts, then sends after resolution or skips on expiry. `src/api/http.ts` maps initiation refusal to HTTP 409 without PII. `test/db/transfer-payment.test.ts` tests pending refund, direct DB write protection, no QR reissue, open/lost/won disputes, and real queued email deferred/resumed once.
- Run 81 verified source SHA `1debe096c9c8ad5421b7c39b1efe68ff744df8d6`: CI **SUCCESS** run 38883239557 (typecheck, check:migrations, check:secrets, full tests), Package **SUCCESS** 38883239522. CI for this documentation-only commit will have its own run. Strict live verification is distinct.
- No deployment or customer release authorized. `ALKAO_TRANSFER_API_ENABLED` remains OFF by default, Brands OFF by default. Latest strict production deployment evidence FAILED: no matching Coolify `/health` SHA. Issue #84 requires authorized operator to confirm separate ALKAO DB, backups, migrations, leak rotation, workers, Resend/Stripe tests and SHA.
- Next exact action: check latest CI and Package on the current main SHA; correct any failing tests; validate full refund + chargeback / cancellation and offline device races before real pilot. Re-verify Coolify and migrate ONLY after operator confirms target DB and backup. Keep PR #53 separate. No automatic agent-session restart configured.


## Run 80 — newest handoff (2026-10-16)

- More code: `f9203cec54a17bcb8d236aef98a55cc529083345` adds `test/ops/transfer-worker-gate.test.ts` (delivery default-off and once-on). `e085b59f83409a37fd6f76d585b7493d6e5f2ef8` fixes a browser selector collision by rendering `non autorisé` for transfer settings and documents `.env.example` default false.


- Repo `takatakca/Alkao.ca`, branch `main`. Source code commits `59e31276b42ff695cadf9e5d90b2221616820fc6`, `d0f11e2107f324167c7535a6ed497ceaabec30d9`, `fe6abc324b93a2c6a8b4162c3d7413da8282f893`. Documentation commit may advance main: re-read live HEAD before edits.
- Last task: Run 80, guarded transfer UX/APIs. API modules `src/api/app.ts`, `src/api/buyer-ui.ts`, `src/api/http.ts`, `src/config.ts`, `src/server.ts`; ops `src/ops/exchange.ts`, `src/ops/transfer-request.ts`; delivery `src/delivery/transfer-invitations.ts`, `src/delivery/worker.ts`, `src/ops/cron.ts`, `scripts/email-worker.ts`, `scripts/cron.ts`; UIs `buyer-ui/app.js`, `buyer-ui/styles.css`, `buyer-ui/transfer.html`, `buyer-ui/transfer.js`, `buyer-ui/transfer.css`, `ops-ui/app.js`; tests `test/api/transfers.test.ts`, `test/api/transfer-settings.test.ts`, `test/api/config.test.ts`, `test/ui/transfer-ui.test.ts`.
- Public endpoints are protected by tenant's operational gate, `ALKAO_TRANSFER_API_ENABLED` (default false), independent Brand opt-in (default false), scoped order or recipient proof, optional expiry and basic in-process rate limits. No recipient claim secret is returned to sender. Buyer email invitation delivered by Resend only once feature enabled on email worker and API, and once queue is eligible; recipient confirms and receives a unique separate QR access token. Owner/admin Brand toggle with audit. Sender QR excluded after claim, order session exchange refused.
- First CI on `59e31276` failed test expectation for a well-formed but wrong secret (404 is correct); second CI on `d0f11e21` failed test expectation for wrong tenant (404 correct). Both test assertions were corrected in later commits. Package passed on both. Run 80 full CI **SUCCESS** 38854862144 and Package **SUCCESS** 38854861945 for `e085b59f83409a37fd6f76d585b7493d6e5f2ef8`. Earlier intermediate CIs failed only test expectations and a UI selector collision, both corrected. This docs commit will advance `main` and trigger its own CI.
- Production: **UNVERIFIED**. Prior strict verify runs failed because Coolify live `/health` did not attest the Git SHA; green CI and successful `Live` probes are not a deployment. Issue #84 requires authorized operator for dedicated DB, backup, historical key rotation, migrations and Coolify source SHA. No live feature flag, billing or production DB was changed.
- NEXT exact action: inspect latest `main` SHA, GitHub CI, fix remaining assertions or browser failures if any; verify live source SHA and migrate only under authorized operation; ensure Resend real delivery, refund/chargeback and scanner offline-device safety tests; then and only then enable `ALKAO_TRANSFER_API_ENABLED=true` in API and email/cron worker and opt in a pilot Brand. Continue unrelated backlog independently. Do not touch unrelated PR #53.
- Automatic session restart/orchestrator was not configured; Actions CI and Live checks are validation jobs only.


## Run 79 — validated internal QR transfer (2026-10-15)

- Source code/main `a4994017953ed437bcfee50d740195949d9917fd`. GitHub CI 38736545944 SUCCESS (typecheck, migrations, secrets, all tests); Package 38736546000 SUCCESS.
- Run 79 initial implementation `99f94e3582b3e8c063fdadf5c0d62e090fe296f1`, corrected a tenant-scoped FK and offline scanner stale-manifest handling in `a4994017`. All new acceptance tests passed before and after the fix.
- New migration: `supabase/migrations/20261107000100_alkao_transfer_acceptance.sql`. New service: `src/ops/transfer-acceptance.ts`; changed `src/delivery/transfer-token.ts`, `src/db/credentials.ts`, `src/scanner/service.ts`, `ops-ui/offline.js`, `ops-ui/app.js`, `test/db/rls.test.ts`; tests `test/db/transfer-acceptance.test.ts` and `test/ops/offline.test.ts`.
- The recipient claim service (INTERNAL ONLY) requires scoped claim secret, live paid and unscanned ticket, brand opt-in and request expiry. Claim locks the order/ticket and atomically revokes old QR, issues fresh credential and records one accepted transfer. The original order QR read excludes transferred tickets. Online scan rechecks revocation after ticket lock. Offline scanners reject expired/missing manifest validity rather than accepting stale QR.
- Buyer-facing initiation, recipient claim page, publicly accessible recipient ticket page, signed invitation auto-delivery and full refund/browser/device E2E are NOT finished. The sender is NOT wired to the production email worker. No public transfer button is available.
- Latest strict deployment verification 38736880991 started after CI; inspect its final result. Historical checks failed because Coolify did not expose the running source SHA. Site availability is not deployment proof. Dedicated ALKAO DB, migrations, old key rotation and Coolify access remain with authorized operator, issue #84; do not change unknown production DB.
- Next exact action: inspect main SHA / latest Actions, finish gated public initiation + cancellation + recipient claim/QR routes, responsive FR/EN buyer/recipient UI, enable email delivery only after real E2E tests; confirm scanner freshness, refunds and live Coolify SHA. No autonomous agent-session restart exists.


## Run 78 — verified source and exact continuation (2026-10-15)

- Current repository `takatakca/Alkao.ca`, main. Functional source SHA `e3b1777434f72db73110d1c0889e1af84c8adff2`.
- CI run 38734506526 SUCCESS: TypeScript, migration checker, secret guard and all tests; Package 38734506570 SUCCESS. Do not mistake packaging for deployment.
- Added `src/delivery/transfer-token.ts`, `src/delivery/transfer-invitations.ts`, migration `20261106000100_alkao_transfer_invite_delivery.sql`, test `test/delivery/transfer-invitations.test.ts`; updated `src/ops/transfer-request.ts`, transfer-service and RLS tests.
- Recipient secret now reproducibly derives from server-only master secret + random request ID, scope, ticket, recipient. Only SHA-256 is retained. Creation transaction enqueues outbox row. Sender has retry, explicit recipient, state/expiry/tenant checks, key-rotation guard and no disclosure in DB.
- **Not live:** new sender is NOT registered with the automatic worker. A functional recipient claim endpoint, one-time acceptance, atomic QR rotation and rights/ownership changes, refund interaction, offline scanner verification, and responsive FR/EN buyer experience are all UNFINISHED.
- Last strict production verification 38734266563 FAILED. Site answers its probes but does not expose the current source SHA. Coolify issue #84: authorized operator must confirm separate database, backup, rotate historic leaks, run migrations, configure build SHA and provide health/Stripe test evidence. No production secrets modified.
- Next action: inspect current main SHA and CI; develop recipient-only claim acceptance with new credential, revoke prior QR and prevent sender token access, plus race/refund/offline-manifest tests. Do not send invitations or show a transfer UI before the entire chain is proven.
- Automated agent restart is NOT configured. GitHub Actions validates source and observes release only.


## Run 77 — latest execution checkpoint (2026-10-14)

- Source: `c7864c5757243ad3835ee1c22f71798240c23732`, internal `src/ops/transfer-request.ts` and `test/db/transfer-service.test.ts`, building on migration `0da240f241e8c1eb9e0fbf8d23ba72f6567d3c7b`.
- Private creation/cancellation validates the buyer order token, Client/Brand and ticket in transactions, stores only a hash of the one-time recipient secret, writes a PII-free audit entry. It DOES NOT deliver email, accept claims or change QR ownership.
- CI **SUCCESS** 38631015271 for `c7864c57`; Package **SUCCESS** 38631014226. Earlier Run 77 migration CI/Package also succeeded on `824672fa`.
- Production: NOT verified. Strict deployment check 38631011448 failed; Coolify `/health` does not attest to current source SHA. Issue #84 needs authorized operator for dedicated database, backups, secrets rotation, migrations and actual deployment.
- This docs commit advances main; check fresh HEAD and its CI rather than assuming `c7864c57` is final.
- Next: implement recipient-only verified email invitation; authenticated one-time claim; atomic new ticket + sender QR revocation + audit; tests for scan manifests/offline, concurrency and refunds. No public transfer UI until this is safe. Reference `docs/TRANSFER_PROTOCOL.md`.


## Run 77 — transfer-request safety foundation (October 14, 2026)

- Read `AGENTS.md`, `WORKLOG.md`, all five standard status documents and open PRs.
  PR #53 is a separate Havana release; do not modify its branch.
- Previous main `2fe6bc503d3c9e05f7725cff1069f12cbc89fda3` passed CI
  38627463072 and Package 38627462930. Strict deploy workflow 38627810742
  failed: `alkao.ca` responds but does not publish the expected `build` SHA.
- Claimed Run 77 in `WORKLOG.md` at `a4d87533a445042498980a6ae958743330d2b78c`.
- Code pushed `0da240f241e8c1eb9e0fbf8d23ba72f6567d3c7b`:
  `supabase/migrations/20261105000100_alkao_transfer_requests.sql`,
  `test/db/transfers.test.ts`, `test/db/rls.test.ts`.
- New schema: Brand-specific default-OFF transfer flag, server-private transfer
  intents with hashed claim secret, short expiry, one pending request per ticket,
  immutable history, tenant composite FK and admission/order eligibility guard.
- Scope is **DB foundation only**. There is intentionally no buyer-facing
  transfer button, no claim endpoint, no email or transferred ownership yet.
  Source QR stays valid until a later verified acceptance implementation.
- Code package passed (run 38630063950). Run 77 CI **passed** at commit 0da240f2 (run 38630063783), including
  TypeScript, migrations, secrets, PostgreSQL/RLS tests. Package also passed.
- No local production migration or Coolify deployment performed. Next steps:
  (1) inspect Run 77 CI and fix any concrete SQL/test error;
  (2) check final `main` SHA and strict deployment logs separately;
  (3) implement recipient email verification + atomic ticket reissuance before
      exposing a transfer feature; reference `docs/TRANSFER_PROTOCOL.md`;
  (4) Coolify owner resolves issue #84 (dedicated DB, key rotation, migration,
      source SHA in build and deployment verification). No secrets in GitHub.
- No external autonomous session orchestrator has been verified or connected.


## Run 76 verified

- Main SHA `1035bcf63941990d6e28fc8d632ddbf2b51b23eb`: CI run 38626850981 SUCCESS (typecheck, migration check, secret check, tests), Package run 38626850976 SUCCESS.
- Run 76 implementation commit `d67896fb317dcbaa6ba7aa373e5843b95b5440b8`; documentation commit advanced main, without source-code differences.
- Strict production verification triggered as run 38627287634. Confirm its final logs before marking deployed. Previous strict verification 38624485645 failed: ALKAO replied but published no build SHA.
- Next action: verify Coolify's build SHA and dedicated ALKAO DB, and implement the next P1 ticket-transfer workflow with sender revocation and recipient authorization. Do not mark transfer as complete before its tests pass.


## Run 76 — October 14, 2026

- Code pushed: d67896fb317dcbaa6ba7aa373e5843b95b5440b8.
- Updated src/api/app.ts; added src/api/order-token.ts and test/api/order-token.test.ts.
- Order GET and session exchange now reject expired tokens while retaining existing non-expiring links.
- Package succeeded. Inspect the latest CI before claiming complete validation.
- Production remains unverified: deployment check 38624485645 failed because /health did not expose a build SHA.
- Next: check latest CI, correct any failures, and continue secure ticket transfers without bypassing tenant checks.


Updated: 2026-10-14. Repository: `takatakca/Alkao.ca`, target branch `main`.
Read `AGENTS.md`, `WORKLOG.md` and this file **before** working. Historical agent notes
remain in [TAKATAK_AGENT_HANDOFF.md](TAKATAK_AGENT_HANDOFF.md).

## 2026-10-14 — Run 75 / current continuation

- Previous `main` SHA: `5743ab1d540624a63c2ead00de7addcb7edb3e34`.
  Its GitHub CI and Package both **passed** (Runs 38615140934, 38615141054).
- Claimed Run 75 in `WORKLOG.md` (commit `b73c56af08e35480cba82ccc85b780f3e42ef3a3`).
- Implemented `GET /salles/:clientId/:brandId/:venueId/agenda.ics`,
  bilingual download link, RFC 5545 escaping/folding with stable public event
  UIDs and every currently on-sale session. Direct requests go through the same
  opted-in/entitled per-Brand catalog gate. Unknown, private, white-label and
  withdrawn venues return 404. No payment changes or DB migration.
- Implementation pushed to main: `9a596345de8ede86a3d52cde8d92a006db597ba6`.
  Changes: `src/api/venue-calendar.ts`, `src/api/venue-view.ts`,
  `src/api/home.ts`, `test/api/venue-calendar.test.ts`,
  `test/api/venues.test.ts`, `test/api/gate.test.ts`,
  `.github/workflows/verify-deploy.yml`, `docs/TASK_QUEUE.md`.
- Eliminated misleading success for superseded CI in Verify deployment:
  obsolete verification exits nonzero and explicitly says no release was verified.
- Validation: GitHub Package **passed** for `9a596345`; GitHub CI
  typecheck, migrations and secret guard passed, but its full test suite
  initially failed on three **test assertions**, not implementation: counting
  an escaped title as a VEVENT and expecting unfolded URL lines. Corrected
  both tests in `ce9db10f4f707a694c69914e31f015f8513aef38`.
  Check its CI run https://github.com/takatakca/Alkao.ca/actions/runs/38623785741.
  This documentation commit advances `main` once more, so verify latest CI.
- Production status: not verified. Public site probes were unavailable through
  public web fetch; there is no evidence Coolify has run the latest SHA. Follow
  production issue #84. No secret values have been accessed or modified.
- **Exact next action:** inspect newest main SHA and CI run; if a test failed,
  read the job logs and correct it. If green, inspect strict verification logs
  for an actual SHA match (not a superseded skip). Continue the P1 buyer transfer
  only after designing a genuinely revocable, tenant-safe ownership workflow.

## Latest completed work / current task

- Run 73: FR/EN public venue directory/detail, home links and sitemap. Validated at
  `f339d3eb19a0f4e073ca89f7612c2c0bb5af5765`.
- Run 74: server-rendered venue name/organizer/city search, locale handling, accent
  normalization, strict deployment SHA checks, CI-driven verification workflow.
- Code commit initially pushed: `413f2af9388c5052ce485bd0a0e19ee2c3171291`.
  Subsequent bugfix/tests: `a790c19395a17c4335ec3c4ec648120dc7a30769`,
  locale navigation `7c6313de0af38238060cf74419466fe173187e7c`,
  corresponding test `92a5c08d04987540108b3a2c7bf4790e6b263274`.
  Workflow concurrency fix: `91515fe55ffdc227929854fa37f44d2689910fe9`.
  The handoff documentation commit itself advances main further: read GitHub HEAD
  before any write; never assume the code SHA is the newest ref.
- Verification: CI **passed** for `a790c193`; `Package` **passed** for
  `92a5c08d`. The CI for `92a5c08d` was **queued** at last observation, not
  verified green. Older CI jobs were cancelled under new concurrency policy.
- The first `Verify deployment` workflow labeled successful merely **skipped
  a superseded CI commit**, as confirmed in its logs. This is NOT proof that
  Coolify serves the latest main commit. Next step: inspect the verification
  run for the latest green CI and the actual public `/health` build SHA.
- Current task: monitor newest GitHub CI and deployment verification, fix any
  concrete failures. Continue the next independent backlog item after release
  evidence is recorded.

## Files touched in Run 74

`src/api/venue-view.ts`, `src/api/home.ts`, `home-ui/home.css`,
`test/api/venues.test.ts`, `src/ops/live-watch.ts`, `scripts/live-watch.ts`,
`test/ops/live-watch.test.ts`, `.github/workflows/verify-deploy.yml`,
`src/api/home-view.ts`, `.github/workflows/ci.yml`, `.github/workflows/package.yml`,
`AGENTS.md`, `WORKLOG.md`, these five standard docs, historical handoff and README.

## Checks and commands

- GitHub Actions CI: TypeScript, migration constraints, secret guard, Vitest using
  disposable PostgreSQL and Playwright; `.github/workflows/ci.yml`.
- Package: `.github/workflows/package.yml`, creates a MochaHost artefact; not a deploy.
- Local: `npm ci && npm run typecheck && npm run check:migrations && npm run check:secrets`
  then `npm test` with disposable test PostgreSQL as documented in README.
- Live (availability only): `node --import tsx scripts/live-watch.ts https://alkao.ca`.
- Live (strict release check):
  `node --import tsx scripts/live-watch.ts --require-build --expect-build <40-char-git-sha> https://alkao.ca`.
- CI-driven `Verify deployment`: observes exact source commit after a successful CI
  (skips superseded runs), retries briefly then **fails** if Coolify did not publish SHA.

No external code-agent orchestrator has been connected or verified. GitHub Actions
automatically checks source, packages and observes releases; it does **not** relaunch
this assistant after a chat ends. Do not claim unattended development without
a separately configured and authorized agent runner.

## Known blockers and risks

- Issue #84: production Coolify cannot be confirmed deployed from GitHub alone.
  The last observed public health response lacked `build` even though live checks
  returned healthy. Live GitHub workflow is deliberately advisory for version lag;
  strict deployment workflow rejects absent/mismatched build.
- Historical public `.env.example` leak (`c75f797`): rotate credentials at providers.
  ALKAO must use a **dedicated** database, never TAKATAK/FESTI-ICE master data.
- Coolify needs an operator with permission to inspect database and app settings:
  `ALKAO_MIGRATE_ON_START=true`, `ALKAO_RUN_WORKERS=true`, source commit in image,
  readiness path `/health/ready`, plus server-only credentials.
- No provider secrets or DB URLs in GitHub docs. Do not flip operational sales on
  without the documented go-live and Stripe test purchase.

## Exact next action

1. Check `main` head and the newest GitHub Actions CI/Package/Verify deployment runs.
2. If CI fails, inspect the failing job logs, correct a concrete cause, push and repeat.
3. If CI passes, record actual SHA and separate deployment result; continue the
   next independent ticketing roadmap task in `TASK_QUEUE.md`.
4. An authorized Coolify operator must complete issue #84 before declaring the
   current code live. Keep legacy worklog and handoff intact.
