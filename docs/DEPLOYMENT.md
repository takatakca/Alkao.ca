# ALKAO — Deployment state and verification

## Run 81 — pending financial events block recipient transfers (2026-10-16)

Source `7b19da34` and `1debe096` add migration `20261108000100_alkao_transfer_payment_guards.sql` after the three existing transfer migrations. Run it ONLY as part of authorized migrations on the backed-up dedicated ALKAO database; the function replacement rejects new invitations during pending refunds and unresolved or lost disputes. Application and queue enforce equivalent rules while retaining pending invitations for future delivery after temporary payment disputes resolve. Secrets remain server-only.
Latest confirmed strict Verify deployment run for preceding main `e084ca7c` was FAILURE 38855537560 because live build SHA is not attested. Run 81 source CI **SUCCESS** 38883239557, Package **SUCCESS** 38883239522. The separate production verifier has not attested this SHA. A successful CI or Package is not a deployment. Leave `ALKAO_TRANSFER_API_ENABLED=false` on API and workers and all Brand opt-ins false until issue #84 is resolved with health, schema, backups, provider and scanner proof.


## Run 80 — transfer rollout remains gated and unverified (2026-10-16)

- `.env.example` explicitly sets `ALKAO_TRANSFER_API_ENABLED=false` in `e085b59f`; delivery default-off regression was added in `f9203cec`. The flag must remain off until rollout authorization.


Full source QA green: CI 38854862144 and Package 38854861945 on `e085b59f83409a37fd6f76d585b7493d6e5f2ef8`. Coolify still unverified. Code through `fe6abc32` adds full protected sender/recipient routes and static FR/EN recipient page. This is **source completion, not a live deployment**.
- The existing `Dockerfile` accepts `SOURCE_COMMIT` and sets `ALKAO_BUILD_ID`; Coolify must enable “Include Source Commit in Build” or supply the SHA so `/health` matches GitHub `main`.
- Before deployment: confirm dedicated ALKAO PostgreSQL, backup and tested restore, rotate historical leaked secrets, configure `ALKAO_CREDENTIAL_MASTER_SECRET` (stable strong key), Stripe/Resend and deploy workers. Authorized operator runs migrations `20261105000100`, `20261106000100`, `20261107000100` (with other pending migrations) against the correct database. Never migrate an unverified live DB.
- Global `ALKAO_TRANSFER_API_ENABLED` defaults to false. Keep it false in API and the `scripts/email-worker.ts` or `scripts/cron.ts` environment until `/health` proves the deployed SHA, pilot mail tests succeed, old/new signed QR and offline manifest revocation are verified, and payout/refund regressions pass. Both the API and email worker/cron must receive the explicit flag; otherwise requests may remain in the queue.
- Once authorized to activate: enable global flag on API + worker/cron, then an owner/admin authorizes its own Brand in Operations. This two-level default-OFF switch prevents unsolicited transfers during deployment. Confirm message retries, one-use claim URL, recipient-only QR, sender QR denial, cancellation, expired-claim and scanner offline freshness, cross-tenant tests before public promotion.
- **Blocked**: live SHA and actual release not verified by latest strict deployment checks; see issue #84. Do not claim green from `Live` or Package alone.


## Run 79 release evidence (2026-10-15)

Source `a4994017953ed437bcfee50d740195949d9917fd`: CI 38736545944 and Package 38736546000 succeeded. New migrations: `20261106000100_alkao_transfer_invite_delivery.sql`, `20261107000100_alkao_transfer_acceptance.sql`; run only on a backed-up dedicated ALKAO database with authorized operator. Transferring remains default OFF and mail dispatch not wired. Strict Verify deployment 38736880991 was in progress at handoff; older runs failed without public source SHA. An ALKAO HTTP response is not evidence of the requested commit. Refer to issue #84 for migration and Coolify operator approvals; no credentials in GitHub.


## Run 78 release status (2026-10-15)

Code SHA `e3b1777434f72db73110d1c0889e1af84c8adff2` passed CI and packaging. New migration `20261106000100_alkao_transfer_invite_delivery.sql` requires an authorized migration on the dedicated ALKAO database. Invitation dispatch is intentionally NOT wired to the scheduled worker, and no payment or live transfer toggle was enabled. The previous strict deployment verifier (38734266563) failed because live ALKAO did not attest its Git SHA. Do not claim latest main is deployed. Verify build SHA, schema, readiness, and backup in Coolify #84.


## Run 77 — source vs production

CI/Package passed for `c7864c57` (internal transfer foundations only). No transfer routes exposed or production migrations run here. Latest known strict deployment verification failed; the public server does not report an attested build SHA. Operator must resolve issue #84 before declaring any new `main` version live.


## Run 77 migration / rollout warning

A new migration, `20261105000100_alkao_transfer_requests.sql`, adds a
default-disabled transfer switch plus server-only request history and DB guards.
It does **not** expose a working transfer route; leave every Brand's flag OFF.
Apply only after an authorized Coolify operator has validated backups and
the dedicated ALKAO database. The migration is part of the source build and
is checked against ephemeral CI PostgreSQL; CI is not evidence that production
was migrated. Run 77 code `0da240f2` packaged successfully; CI succeeded (run 38630063783). Production check for previous main `2fe6bc50` failed because
`/health` lacks the build SHA. Issue #84 remains an external blocker.


## Verification, October 14, 2026

Run 75 at 73cfd4f1 passed CI and packaging. Strict deployment verification 38624485645 failed after eight attempts because the public /health response did not report the expected build SHA. ALKAO itself responded. Run 76 at d67896fb has no migration and passed packaging. Its live deployment is not confirmed. Coolify setup and source revision attestation remain tracked in GitHub issue #84.


Updated 2026-10-14. Do not treat a GitHub push or a MochaHost Package artifact as a deployment.
Current source: `main`; production target: `https://alkao.ca` via Coolify
(documented in [ALKAO_DEPLOY_COOLIFY.md](ALKAO_DEPLOY_COOLIFY.md)).

## Run 75 evidence

- Code `9a596345de8ede86a3d52cde8d92a006db597ba6` publishes a
  read-only `.ics` per venue after the same opt-in and tenant gate as the
  public venue page. No migration, token exchange, or payment change.
- GitHub Package passed, typecheck/migration and secret guards passed.
  Full tests initially exposed three incorrect .ics assertion assumptions, fixed
  by test-only commit `ce9db10f`. Its CI was still running at the last check;
  re-read Actions for the final documentation HEAD.
- Workflow fix: superseded CI now generates an explicit failure instead of
  reporting a successful deployment check without making one. A verified
  successful release requires an observed live `build` matching main.
- **Deployed revision remains UNVERIFIED.** Do not enable sales based on this run.

## Current evidence

- GitHub CI + Package passed for Run 73 `f339d3eb...`.
- Run 74 source initially at `413f2af...`; test correction `a790c193` passed CI.
  Latest code SHA `92a5c08d04987540108b3a2c7bf4790e6b263274` passed packaging;
  its CI was queued at the most recent check. Inspect newest documentation SHA too.
- Earlier GitHub Live check returned healthy responses, but the public `/health`
  did not publish `build`, so the installed Git revision remains **unverified**.
  A successful `Verify deployment` run for a superseded commit merely skipped the
  obsolete check (confirmed by logs); do not count it as deployment success.
- CI-driven `Verify deployment` reads GET-only health + ready + home and demands
  the exact source SHA, with limited retries. Missing/mismatched build is an
  actionable failure (not proof the service is offline).
- Site was not confirmed newly deployed in this session. Do not activate payments.

## Deployment contract

1. Confirm Coolify application's Git source `takatakca/Alkao.ca`, branch `main`.
   Verify dedicated database ownership and real-order preservation; back up first.
2. Rotate previously exposed secrets, then configure protected runtime variables
   only in Coolify, NOT on GitHub. Never reveal their values in chat or logs.
3. Configure `ALKAO_MIGRATE_ON_START=true` and `ALKAO_RUN_WORKERS=true`
   on the validated ALKAO database. Use healthcheck `/health/ready`.
4. Enable source commit inclusion in the Coolify image so `GET /health`
   returns `build` matching the desired 40-character `main` SHA.
5. Deploy the main branch through authorized Coolify UI or its configured webhook.
   The repository does not include credentials for us to trigger this directly.
6. Check `GET /health` (ALKAO, same SHA), `GET /health/ready` (200, schema current
   or documented Supabase unknown), `/`, `/salles`, and a published venue page.
7. Run `npm run check:golive -- --url https://alkao.ca` from a trusted environment.
   Verify tenancy, Stripe webhook/signature, test payment, email and worker health
   before setting operational API enabled; do not skip live-payment safety.
8. For a failing deployment, inspect Coolify build logs and rollback image. Database
   migration history must remain intact; follow original production runbook.

## GitHub Actions

- `CI`: typecheck/migrations/secret guard/Vitest against disposable PostgreSQL.
- `Package`: ready-to-upload MochaHost tarball, **not** the Coolify live deployment.
- `Live`: scheduled service availability; can warn about SHA lag.
- `Verify deployment`: after CI success for `main` or manual dispatch. Retries and fails
  unless the public endpoint has the matching SHA and readiness is healthy.
  It skips CI runs superseded by a newer main commit. No write to production.

## Operator-only permissions

Coolify application/environment configuration, dedicated DB validation/backups, DNS/TLS
inspection, Stripe/Resend credentials and rotations, and actual deploy trigger if not
already configured. Avoid asking for raw credentials in conversation.

Blocker: [GitHub issue #84](https://github.com/takatakca/Alkao.ca/issues/84).
