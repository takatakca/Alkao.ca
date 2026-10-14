# ALKAO — Agent handoff (mandatory)

Updated: 2026-10-14. Repository: `takatakca/Alkao.ca`, target branch `main`.
Read `AGENTS.md`, `WORKLOG.md` and this file **before** working. Historical agent notes
remain in [TAKATAK_AGENT_HANDOFF.md](TAKATAK_AGENT_HANDOFF.md).

## Latest completed work / current task

- Run 73: FR/EN public venue directory/detail, home links and sitemap. Validated at
  `f339d3eb19a0f4e073ca89f7612c2c0bb5af5765`.
- Run 74: server-rendered venue name/organizer/city search, locale handling, accent
  normalization, strict deployment SHA checks, CI-driven verification workflow.
- Code commit **pushed**: `413f2af9388c5052ce485bd0a0e19ee2c3171291`.
  Documentation commits may advance `main` again; always run `git rev-parse HEAD`
  or query the GitHub branch ref before making further changes.
- Current task: confirm Run 74 GitHub CI and Package; correct any reported failures.
  Verify whether the new workflow identifies the live version; do not interpret a
  failing verification as a successful deployment.

## Files touched in Run 74

`src/api/venue-view.ts`, `src/api/home.ts`, `home-ui/home.css`,
`test/api/venues.test.ts`, `src/ops/live-watch.ts`, `scripts/live-watch.ts`,
`test/ops/live-watch.test.ts`, `.github/workflows/verify-deploy.yml`,
`WORKLOG.md`, these five standard docs, historical handoff and README.

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
