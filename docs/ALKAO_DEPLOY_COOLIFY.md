# ALKAO on Coolify (Docker)

Coolify builds ALKAO's `Dockerfile` from GitHub and keeps one container running. That one
container does everything:

- it applies the migrations before serving;
- it serves the site (`/`, `/acheter`, `/billets`, `/ops`, the API);
- it runs the background jobs every minute (freeing expired seats, emails, texts,
  cancellations).

It is the same code as the MochaHost release ([ALKAO_DEPLOY_MOCHAHOST.md](ALKAO_DEPLOY_MOCHAHOST.md)),
started by `scripts/container.ts` instead of Passenger and cron. The generic steps (Clients,
Stripe connection, test purchase) are in [ALKAO_GO_LIVE.md](ALKAO_GO_LIVE.md).

ALKAO is **its own application** in Coolify, with its own database. It does not share
Promo Havana's application, nor TAKATAK's or FESTI-ICE's database.

## Before you start

| What | Where | Notes |
|---|---|---|
| ALKAO's database | A **dedicated** PostgreSQL: a new Supabase project (region Canada (Central)), or a PostgreSQL 16 database in Coolify (step 2) | **Never** TAKATAK's Supabase project (`pcjfahhlozsseqqevimi`) or FESTI-ICE's |
| Staff sign-in | **TAKATAK's** Supabase project | Its URL, anon key and JWKS URL, so staff keep their TAKATAK accounts |
| Payments | The Stripe platform account (Connect) | The secret key, and the signing secret of a Connect webhook |
| Emails | Resend | An API key, and a verified sender domain |
| An address | A subdomain pointed at the Coolify server | Coolify's test address (`…sslip.io`) is fine for the first run |

## 1. The application

- **Already running?** `alkao.ca` already answers from the Coolify server (2026-10-13). Keep
  that application. Change its settings to match this page (steps 1 and 3), then redeploy.

In Coolify, open the project, then **+ New**, then the repository `takatakca/Alkao.ca`
(public, or through the GitHub App), branch `main`.

| Setting | Value |
|---|---|
| Build pack | **Dockerfile** |
| Ports exposed | `8787` |
| Domains | `https://<subdomain>` (Coolify gets the HTTPS certificate) |
| Health check | Path `/health/ready`, port `8787` |
| Include source commit in build (Advanced) | **On**: `/health` then shows the commit that answers |

- Keep the health check on: Coolify then starts the new container and waits until it
  answers before stopping the old one.
- With automatic deployment on, each merge to `main` deploys.

## 2. Database (once)

Pick one.

**A. A dedicated Supabase project** (managed backups):

1. Create the project, then copy the **Session pooler** connection string (port 5432). Do not
   use the transaction pooler (port 6543): the background jobs take a session lock.
2. Download its certificate (**Database settings → SSL Configuration**).
3. In the application, **Persistent Storage → Add → File Mount**:
   - destination `/app/certs/supabase-ca.crt`;
   - content: the certificate (a public certificate, not a secret).
4. Use this `DATABASE_URL`, which keeps TLS **verified**. Never use `sslmode=no-verify`.

   ```
   postgresql://postgres.<ref>:<password>@aws-0-ca-central-1.pooler.supabase.com:5432/postgres?sslmode=verify-full&sslrootcert=/app/certs/supabase-ca.crt
   ```

**B. A PostgreSQL database in Coolify** (on the same server):

1. **+ New → Database → PostgreSQL 16**, in the same project, with no public port.
2. Use its **internal** URL as `DATABASE_URL`. It stays on the server's private network.
3. Turn on its **scheduled backups** to an S3 storage, then try a restore once.
   - Without a backup, a lost server means lost orders.

On plain PostgreSQL (B), the migrations first create what they use from Supabase: the
roles `anon`, `authenticated`, `service_role` and `auth.uid()`
(`supabase/bootstrap/plain_postgres.sql`). That file grants nothing by default. On Supabase
(A), it does nothing.

- **Never** apply `supabase/tests/supabase_shim.sql` to this database: it is for tests only.

## 3. Environment variables

In the application, **Environment Variables**. Mark the secrets as **runtime only** (not
available at build time), so they stay out of the image.

- **Generate each secret** with `openssl rand -base64 48`.
- Never paste one in a chat, an issue or a commit.
- The first value is `ALKAO_OPERATIONAL_API_ENABLED=false`. ALKAO answers, but nothing is
  sold until step 6.

```bash
NODE_ENV=production
ALKAO_OPERATIONAL_API_ENABLED=false
DATABASE_URL=<step 2>

# Run 62: the container migrates, then runs the background jobs every minute
ALKAO_MIGRATE_ON_START=true
ALKAO_RUN_WORKERS=true

ALKAO_PUBLIC_URL=https://<subdomain>
# Leave empty on the independent ALKAO platform. A white-label install may set an HTTPS homepage.
ALKAO_HOME_URL=
# Coolify's proxy is one hop. With Cloudflare's proxy in front as well: 2.
ALKAO_TRUSTED_PROXY_HOPS=1
```

The other variables are those of [ALKAO_DEPLOY_MOCHAHOST.md](ALKAO_DEPLOY_MOCHAHOST.md),
step 4, with the same values:

- staff sign-in: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_JWKS_URL`;
- secrets: `ALKAO_CONTROL_KEYS`, `ALKAO_CREDENTIAL_MASTER_SECRET`, `ALKAO_METRICS_TOKEN`;
- Stripe: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `ALKAO_STRIPE_ONBOARDING_REFRESH_URL`,
  `ALKAO_STRIPE_ONBOARDING_RETURN_URL` (both `https://<subdomain>/ops`);
- emails: `RESEND_API_KEY`, `ALKAO_EMAIL_FROM`.

**Several containers:** the background jobs take turns through a database lock, so two
containers with `ALKAO_RUN_WORKERS=true` never run the same pass at once. The migrations also
take turns.

**A Coolify Scheduled Task instead:** a task that runs `node --import tsx scripts/cron.ts` every
minute does the same work. Keep one of the two. Both at once is harmless (same lock), but
pointless.

## 4. Deploy, then look

1. Click **Deploy** and follow the log. The container's first lines are:

   ```
   alkao migrations applied: …        (or "alkao migrations: up to date")
   alkao container: background jobs every 60 s
   alkao listening on :8787 — …
   alkao cron … {"ran":true,…}
   ```

   - If a migration fails, the container stops with the migration's name. The previous
     container keeps serving, and the database keeps the migrations that passed.
2. Open `https://<subdomain>/health`. It answers `{"ok":true,"service":"alkao",…,"build":"<commit>"}`.
3. Open `/health/ready` (`"database":"up"`), then `/`, the ALKAO platform home.

## 5. Stripe webhook

As in [ALKAO_DEPLOY_MOCHAHOST.md](ALKAO_DEPLOY_MOCHAHOST.md), step 7, with the URL
`https://<subdomain>/v1/webhooks/stripe`. Put its signing secret in `STRIPE_WEBHOOK_SECRET`,
then **Restart**.

## 6. Check, then turn on

1. **In the container**, from the application's **Terminal** in Coolify:

   ```bash
   node --import tsx scripts/golive-check.ts
   ```

2. **From any computer**:

   ```bash
   npm run check:golive -- --url https://<subdomain>
   ```

3. **Fix every ✘.**
   - If the line "ALKAO voit l'adresse de chaque acheteur" shows ⚠, change
     `ALKAO_TRUSTED_PROXY_HOPS` (`2` behind Cloudflare), restart, and check again.
4. **Then continue with [ALKAO_GO_LIVE.md](ALKAO_GO_LIVE.md), steps 3 and 4:**
   - `control:apply` for the Clients;
   - `ALKAO_OPERATIONAL_API_ENABLED=true`, then restart;
   - the Stripe connection in `/ops`;
   - a test purchase.

## Moving an address from MochaHost

Applies, for example, to `billets.promohavana.ca`, which runs an older ALKAO on MochaHost.

1. **First check which database the old application uses, and whether it holds real orders.**
   - If it does, **move those orders first**. Starting on an empty database would leave
     those buyers' tickets unknown at the gate.
   - The owner decides this step. Never point ALKAO at TAKATAK's or FESTI-ICE's database.
2. Bring the Coolify application up on its test address and pass step 6.
3. In the domain's DNS, point the subdomain's `A` record at the Coolify server. Then add the
   subdomain in **Domains**.
4. Once Coolify answers on that address, stop the MochaHost application and remove its cron
   line.
   - If both run for a moment against the same database, the jobs still take turns (same lock).

## Watching

The **Live** workflow (GitHub, **Actions**) checks `https://alkao.ca` every 3 hours, GET only:
the service, its database and the home page. A failed run is GitHub's e-mail to the owner.

- It also says when the commit in `/health` is not `main`'s: the latest merge is not deployed
  yet. This needs "Include source commit in build" (step 1).
- To watch another address, add it at the end of the command in `.github/workflows/live.yml`,
  once it serves ALKAO.
- From any computer: `node --import tsx scripts/live-watch.ts https://alkao.ca`.

## Rollback

1. In the application, open **Rollback**, choose the previous image, and deploy it.
2. Check `/health`: `build` shows the commit that answers.

Do not touch the database: migrations only add, so the previous code still runs on it.
