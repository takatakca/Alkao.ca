# ALKAO — Deployment state and verification

Updated 2026-10-14. Do not treat a GitHub push or a MochaHost Package artifact as a deployment.
Current source: `main`; production target: `https://alkao.ca` via Coolify
(documented in [ALKAO_DEPLOY_COOLIFY.md](ALKAO_DEPLOY_COOLIFY.md)).

## Current evidence

- GitHub CI + Package passed for Run 73 `f339d3eb...`.
- Run 74 source `413f2af9388c5052ce485bd0a0e19ee2c3171291` pushed;
  inspect its CI run and newer documentation commits before declaring green.
- Earlier GitHub Live check returned healthy responses, but the public `/health`
  did not publish `build`, so the installed Git revision remains **unverified**.
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
