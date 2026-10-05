# ALKAO on MochaHost (cPanel, Passenger)

ALKAO goes on the same host as TAKATAK, as **its own application**. It gets its own subdomain,
folder, `.env`, database and cron job. TAKATAK's application, folder and database are left
untouched.

To take ALKAO offline, stop its application in cPanel and remove its cron line. TAKATAK
keeps running either way.

The generic steps (Clients, Stripe connection, test purchase) are in
[ALKAO_GO_LIVE.md](ALKAO_GO_LIVE.md). This page is the MochaHost way to host it.

## Before you start

| What | Where | Notes |
|---|---|---|
| A subdomain | cPanel, then **Domains** | For example `billets.takatak.ca`, with HTTPS (AutoSSL) |
| ALKAO's database | A **new** Supabase project, for example `alkao`, region Canada (Central) | **Never** TAKATAK's project (`pcjfahhlozsseqqevimi`) or FESTI-ICE's. Prefer a paid plan: a free project pauses after a week without activity |
| Staff sign-in | **TAKATAK's** Supabase project | Its URL, anon key and JWKS URL, so staff keep their TAKATAK accounts |
| Payments | The Stripe platform account (Connect) | The secret key, and the signing secret of a Connect webhook (step 7) |
| Emails | Resend | An API key, and a verified sender domain |

## 1. Get the release

Every commit on `main` builds a release:

1. In GitHub, open **Actions**, then **Package**.
2. Open the latest run and download `alkao-mochahost-<commit>` from its **Artifacts**. It is a
   zip that holds `alkao-<id>.tar.gz`.

What is in the release:

- the Linux `node_modules`, so **the host never runs `npm`** (the same lesson as TAKATAK);
- never a `.env`.

To build it yourself on Linux x64, run `npm run pack:mochahost`.

## 2. Folders

The layout is the same as TAKATAK's:

```
/home/<user>/apps/alkao/
  releases/<id>/       the extracted release, one folder per version
  .env                 the settings, copied into each release (step 4)
  supabase-ca.crt      Supabase's certificate (step 3)
```

In cPanel's **File Manager**, upload the tarball into `releases/`, then use **Extract**. The
release's folder is named `alkao-<id>`.

## 3. Database (once)

1. Create the Supabase project.
2. In **Connect**, copy the **Session pooler** connection string (port 5432, works over IPv4).
   Do not use the transaction pooler (port 6543): the cron job takes a session lock.
3. In **Database settings → SSL Configuration**, download the certificate. Upload it as
   `/home/<user>/apps/alkao/supabase-ca.crt`.
4. Build `DATABASE_URL` from the connection string, adding the certificate. This keeps TLS
   **verified**. Never use `sslmode=no-verify`.

   ```
   postgresql://postgres.<ref>:<password>@aws-0-ca-central-1.pooler.supabase.com:5432/postgres?sslmode=verify-full&sslrootcert=/home/<user>/apps/alkao/supabase-ca.crt
   ```
5. Apply the migrations **once the application exists** (step 5): its Node 22 comes with it.
   In cPanel **Terminal**, first run the "enter the virtual environment" command that
   **Setup Node.js App** shows, then:

   ```bash
   cd ~/apps/alkao/releases/alkao-<id>
   node --env-file=.env --import tsx scripts/migrate.ts
   ```

   - Without Terminal, use a one-time cron line with the same command (with `<node>` from
     step 6).
   - Run it again for each new release. It applies only what is missing.

## 4. `.env`

Create `/home/<user>/apps/alkao/.env` and copy it into each release folder. Set its
permissions to `600`, and never put it in the release or in a chat.

- **Generate each secret on the server** with `openssl rand -base64 48`.
- The first value is `ALKAO_OPERATIONAL_API_ENABLED=false`. ALKAO answers, but nothing is
  sold until the last step.

```bash
NODE_ENV=production
ALKAO_OPERATIONAL_API_ENABLED=false
DATABASE_URL=postgresql://…?sslmode=verify-full&sslrootcert=/home/<user>/apps/alkao/supabase-ca.crt
ALKAO_PUBLIC_URL=https://billets.takatak.ca
ALKAO_TRUSTED_PROXY_HOPS=1

# Staff sign-in: TAKATAK's Supabase project (public values)
SUPABASE_URL=https://pcjfahhlozsseqqevimi.supabase.co
SUPABASE_ANON_KEY=<TAKATAK's anon key>
SUPABASE_JWKS_URL=https://pcjfahhlozsseqqevimi.supabase.co/auth/v1/.well-known/jwks.json

# Secrets: openssl rand -base64 48
ALKAO_CONTROL_KEYS=takatak-1:<secret>
ALKAO_CREDENTIAL_MASTER_SECRET=<secret>
ALKAO_METRICS_TOKEN=<secret>

# Stripe (sk_test_ first, sk_live_ for real sales)
STRIPE_SECRET_KEY=sk_test_…
STRIPE_WEBHOOK_SECRET=whsec_…
ALKAO_STRIPE_ONBOARDING_REFRESH_URL=https://billets.takatak.ca/ops
ALKAO_STRIPE_ONBOARDING_RETURN_URL=https://billets.takatak.ca/ops

# Emails
RESEND_API_KEY=re_…
ALKAO_EMAIL_FROM=billets@takatak.ca
```

- **Legacy JWT secret:** if TAKATAK's Supabase project still signs with the legacy JWT secret
  (shown under **JWT Keys**), set `SUPABASE_JWT_SECRET` instead of `SUPABASE_JWKS_URL`.
- **TAKATAK menu, later:** add `ALKAO_OPS_FRAME_ANCESTORS=https://takatak.ca` only when the
  TAKATAK menu is turned on ([ALKAO_GO_LIVE.md](ALKAO_GO_LIVE.md), step 5).

## 5. The application

In cPanel, open **Setup Node.js App**, then **Create application**:

| Field | Value |
|---|---|
| Node.js version | 22 |
| Application mode | Production |
| Application root | `apps/alkao/releases/alkao-<id>` |
| Application URL | the subdomain |
| Application startup file | `passenger.cjs` |

- Do **not** click "Run NPM Install": the release already has its `node_modules`.
- Start the application once, then open `https://<subdomain>/health`. It should answer
  `{"ok":true,"service":"alkao",…}`.
- Now apply the migrations (step 3.5). `/health/ready` then answers `{"ok":true,"database":"up"}`.

## 6. Background jobs (cron)

Hosts like this one do not keep worker processes running, so one cron job does their work
every minute: freeing expired seats, sending emails, finishing cancellations.

- **Overlapping runs are skipped.**
- **Each line in the log holds counts only**, never buyer data.

In cPanel, open **Cron Jobs** and add, every minute (`* * * * *`):

```bash
cd /home/<user>/apps/alkao/releases/alkao-<id> && <node> --env-file=.env --import tsx scripts/cron.ts >> /home/<user>/apps/alkao/cron.log 2>&1
```

- **`<node>`** is the Node 22 that **Setup Node.js App** shows in its "enter the virtual
  environment" command, for example `/home/<user>/nodevenv/apps/alkao/releases/alkao-<id>/22/bin/node`.
- **The log** grows by about 7 MB a month. Empty it now and then.

## 7. Stripe webhook

1. In Stripe, open **Developers**, then **Webhooks**, then **Add endpoint**.
2. Choose **Events on Connected accounts**, with the URL
   `https://<subdomain>/v1/webhooks/stripe`.
3. Select these events:
   - `checkout.session.completed`
   - `checkout.session.expired`
   - `checkout.session.async_payment_succeeded`
   - `checkout.session.async_payment_failed`
   - `account.updated`
   - `charge.dispute.created`, `charge.dispute.updated`, `charge.dispute.closed`
   - `charge.dispute.funds_withdrawn`, `charge.dispute.funds_reinstated`
   - `charge.refunded`
4. Copy its signing secret into `STRIPE_WEBHOOK_SECRET`, then stop and start the application.

## 8. Check, then turn on

1. **On the server**, from the release folder:

   ```bash
   node --env-file=.env --import tsx scripts/golive-check.ts
   ```

2. **From any computer**:

   ```bash
   npm run check:golive -- --url https://<subdomain>
   ```

3. **Fix every ✘.** Pay attention to the line "ALKAO voit l'adresse de chaque acheteur":
   - **If it shows ⚠:** every buyer would share one hold limit during a sales rush. Set
     `ALKAO_TRUSTED_PROXY_HOPS` to `0` (or `2`), stop and start the application, and check again.
4. **Then continue with [ALKAO_GO_LIVE.md](ALKAO_GO_LIVE.md), steps 3 and 4:**
   - `control:apply` for the Clients;
   - `ALKAO_OPERATIONAL_API_ENABLED=true`, then stop and start the application;
   - the Stripe connection in `/ops`;
   - a test purchase.

## A new release

1. Upload and extract it into `releases/`, then copy `.env` into it.
2. Run the migrations from the new folder (step 3.5).
3. Point **Application root** at the new folder, then stop and start the application **once**.
   Update the folder in the cron line.
4. Run the check (step 8).

Keep the previous folder.

## Rollback

1. Point **Application root** and the cron line back at the previous folder.
2. Stop and start the application once.
3. Check `/health`.

Do not touch the database: migrations only add.
