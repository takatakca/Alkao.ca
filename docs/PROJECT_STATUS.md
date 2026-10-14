# ALKAO — Project status

Updated: 2026-10-14. Source of truth: `takatakca/Alkao.ca`, branch `main`.
This repository is **ALKAO Ticket Hub**, a standalone ticketing engine, not the separate
ALKAO water-commerce concept. Do not replace its existing product or merge tenant databases.

## Product implemented in the repository

- Node 22, Hono, PostgreSQL + RLS, signed TAKATAK control contract and tenant entitlements.
- Catalog, session capacity, holds, Stripe Connect checkout/refunds/disputes, Québec taxes.
- Signed QR tickets, offline scanning, buyer ticket link, cancellation and notifications.
- Organizer operations (`/ops`), hosted shop (`/acheter`), FR/EN platform home and SEO.
- Marketing, waitlists and presale codes through Run 72.
- Run 73: public bilingual venue directory/detail pages, derived exclusively from gated events.
- Run 74 (code commit `413f2af9388c5052ce485bd0a0e19ee2c3171291`): server-side venue
  filtering and strict SHA-aware deployment verification (see current CI status below).

- Run 75 (code commit `9a596345de8ede86a3d52cde8d92a006db597ba6`):
  downloadable RFC 5545 .ics calendar per public venue (FR/EN), visible CTA and
  tenant-gated API, plus server-side calendar and API tests. No migration.

## Current delivery evidence

- Run 74: CI and Package confirmed successful at `5743ab1d540624a63c2ead00de7addcb7edb3e34`.
- Run 75: Package passed at `9a596345`. CI typecheck/migrations/secrets
  passed; the first full test run failed on test-only ICS line parsing assertions.
  Tests were corrected in `ce9db10f4f707a694c69914e31f015f8513aef38`.
  Its rerun was still in progress. Check CI at final main HEAD.
- Run 73: GitHub Actions CI and Package passed at `f339d3eb19a0f4e073ca89f7612c2c0bb5af5765`.
- Run 74: code changes pushed to main. CI passed for test correction `a790c193`;
  Package passed at `92a5c08d` (English venue navigation fix); newest CI was queued
  at the last check and must not be marked passed without its own result. `.github/workflows/verify-deploy.yml` runs only after a
  successful CI, and can be dispatched manually; its result is authoritative only for
  its own verification of the public service.
- The previous Live workflow on 2026-10-14 showed `/health`, `/health/ready`, and
  homepage responding but did **not** receive a build SHA from the server. No proof yet
  that Run 73/74 is deployed to the live service.

## Blocking external dependencies

See issue [#84](https://github.com/takatakca/Alkao.ca/issues/84):
confirm dedicated ALKAO database and backups, rotate values previously leaked in public
history, enable migration/start workers in Coolify, surface source commit and verify
readiness; configure payments, mail and sign-in through server-side secrets only.
Never mark the whole product launched while these prerequisites remain unresolved.

## Ownership and boundaries

TAKATAK is identity/control authority. ALKAO stores its own event/ticket/order data with
`client_id` and `brand_id` isolation. Tenant data does not flow to other Brands.
Operational APIs default off. Do not publish customer identities in client pages,
workflow logs, issues or this documentation.

Roadmap: [TASK_QUEUE.md](TASK_QUEUE.md). Exact continuation: [AGENT_HANDOFF.md](AGENT_HANDOFF.md).
