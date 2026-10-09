# ALKAO go-live checklist

ALKAO is a separate deployment. Turning it on changes nothing in TAKATAK V1, FESTI-ICE or
any other running system. Every step below is additive and can be undone by turning
ALKAO off again: `ALKAO_OPERATIONAL_API_ENABLED=false`, or stop the processes.

## 0. Check it with one command (Run 38)

`npm run check:golive` says what is missing or wrong, in French, before and after each
step below. It only reads: it never writes to the database, Stripe or anything else, and
it never prints a secret, only whether it is set.

```bash
# Where ALKAO runs, with its settings: the settings and the database.
npm run check:golive
# From any computer: the running service, and optionally one Brand's shop.
npm run check:golive -- --url https://billets.example.ca --client <clientId> --brand <brandId>
```

| Part | What it checks |
|---|---|
| Settings | Every value the server would refuse at startup (an empty value counts). Control keys, staff sign-in, Stripe keys and their mode, onboarding URLs, the QR secret, the public URL, the email worker, the metrics token, the TAKATAK embed origins. Secrets that look like placeholders are refused |
| Database | It answers. Every migration is applied (ALKAO's runner or the Supabase CLI), and none is unknown to this code. Supabase roles and `pg_trgm` are present. **The same RLS and grant rules as the tests, on the real database:** RLS on every `ticketing_*` table, read-only policies for `authenticated` only, nothing for `anon`, no access to `alkao_private`. Clients, Brands and staff are set up, Ticketing is active, and Stripe is finished for each Client that sells. The workers are not behind (sweeper, emails, cancellations, refunds) |
| Running service | HTTPS and HSTS, `/health` and `/health/ready`. `ALKAO_PUBLIC_URL` matches the address. Stripe is in live or test mode, and the webhook refuses unsigned calls (it is probed with an unsigned call, which Stripe's signature check refuses before anything is read). `/ops` sign-in, the `/billets` security headers, and `/metrics` protected by its token. With `--client` and `--brand`: Ticketing is active, events are published, and the shop link works |

Each line is ✔ (fine), ⚠ (advice, e.g. Stripe test mode) or ✘ (blocking). The command exits
with `1` when anything is blocking, so it can also run in a deployment pipeline.

## 1. Infrastructure

On MochaHost (cPanel), next to TAKATAK, follow
[ALKAO_DEPLOY_MOCHAHOST.md](ALKAO_DEPLOY_MOCHAHOST.md) (Run 39). It covers the release,
`.env`, the Supabase database, the cron job instead of the workers, and the Stripe webhook.

| Item | Value |
|---|---|
| Database | A database **dedicated to ALKAO**. Never use the TAKATAK or FESTI-ICE database. Two ways: a dedicated Supabase project, migrated with `supabase db push`; or plain PostgreSQL 15+: run `supabase/tests/supabase_shim.sql` once (it creates the Supabase roles and `auth.uid()`), then `npm run db:migrate`. The migrations install the `pg_trgm` extension (bundled with PostgreSQL and available on Supabase) for the staff order search |
| Auth | The **same Supabase project** as TAKATAK, so staff use their TAKATAK accounts. Set `SUPABASE_JWKS_URL` (or `SUPABASE_JWT_SECRET`), `SUPABASE_URL` and `SUPABASE_ANON_KEY` |
| Processes | `npm start` (API, `/ops`, `/billets`, `/acheter`), `npm run worker:sweeper`, `npm run worker:email`, `npm run worker:cancellations`. On a host without long-running processes, one cron job every minute instead: `npm run cron` (Run 39) |
| Public URL | HTTPS, e.g. `https://billets.example.ca`. Set it as `ALKAO_PUBLIC_URL` for both the server and the email worker |

**Container image.** One image runs the API and every worker:

- `docker build -t alkao .` builds it from the `Dockerfile`; only production dependencies
  are installed, and it runs as the `node` user.
- A `HEALTHCHECK` calls `/health/ready`.
- The default command is the API. A worker uses the same image with
  `node --import tsx scripts/<worker>.ts`.
- `docker compose up` starts a local stack: PostgreSQL, migrations, the API and the sweeper.
  `--profile workers` adds the email and cancellation workers.

## 2. Secrets

Generate long random values, for example with `openssl rand -base64 48`.

| Variable | Notes |
|---|---|
| `ALKAO_CONTROL_KEYS` | `kid:secret`. The same pair goes to whoever runs `control:apply` (or, later, the TAKATAK publisher) |
| `ALKAO_CREDENTIAL_MASTER_SECRET` | Signs QR codes and email links. **Never change it after launch**: every QR code would stop working |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Platform key and the **Connect** webhook endpoint `https://…/v1/webhooks/stripe`. The events to send are listed in [API v1](ALKAO_API_V1.md) |
| `ALKAO_STRIPE_ONBOARDING_REFRESH_URL`, `_RETURN_URL` | Where Stripe sends the Client admin during and after onboarding |
| `RESEND_API_KEY`, `ALKAO_EMAIL_FROM` | Tickets email. The sender's domain must be verified in Resend |
| `ALKAO_OPS_FRAME_ANCESTORS` | The TAKATAK dashboard origin, only if `/ops` is embedded there |

## 3. Set up the Clients (no TAKATAK change needed)

Copy `provisioning.example.json` and fill it in:

| Field | Value |
|---|---|
| `clientId`, `brandId` | The TAKATAK master UUIDs of the Client and Brand. Keep the same ids that TAKATAK uses, so a later TAKATAK integration takes over seamlessly |
| `commission` | The agreed V1 terms: `rateBps` on the pre-tax subtotal, plus `fixedCentsPerPaidAdmission` per paid ticket |
| `members` | Each staff member's Supabase user id and ALKAO role |
| `ticketing` | `{ "status": "active" }` only for the Brands that sell tickets |

Then preview and send the plan:

```bash
npm run control:apply -- plan.json --dry-run    # shows the signed events, sends nothing
ALKAO_URL=https://billets.example.ca ALKAO_CONTROL_KEY_ID=… ALKAO_CONTROL_SECRET=… \
  npm run control:apply -- plan.json
```

How it behaves:

- **Order:** events go out Client, Brands, members, then Ticketing, and the run stops at the
  first refusal.
- **Re-runs are safe:** a newer run wins, and replaying an older plan changes nothing.
- **Removing staff:** set a member's `status` to `removed`.
- **Turning a Brand off:** set its `ticketing.status` to `suspended`.

## 4. Turn it on

1. Set `ALKAO_OPERATIONAL_API_ENABLED=true`. Without step 3, every Brand still answers
   `ticketing_unavailable`.
2. A Client owner opens `/ops`, then **Paiements**, then connects Stripe, and lists the
   Brand's website origins allowed after payment.
3. Staff create the venue, event, sessions and ticket types, then put sessions on sale and
   publish. In **Apparence**, they set the Brand's logo (a PNG on a transparent background),
   its colour and its contact details, and give each event a photo (« Ajouter une photo »).
   The tickets page, the shop, the e-mails and the shared links use them (Runs 50–53);
   `check:golive` names a selling Brand without its look, an SVG logo, and events on sale
   without a photo.
4. Share the shop link `https://…/acheter/<clientId>/<brandId>`, or the Brand's own site can
   call the public API.
5. Run `npm run check:golive -- --url https://… --client … --brand …` until nothing is
   blocking, then make a test purchase. You should see the payment on the Client's Stripe account, the
   tickets email, QR codes on `/billets`, and a scan at the gate.
   - **With Stripe test keys** (`sk_test_…`), ALKAO says so everywhere (Run 32). The shop
     shows a banner: "Mode test : aucun paiement réel". `/ops` shows a badge: "Stripe en
     mode test". The startup log reads `Stripe TEST mode`.
   - **Switching to live keys** (`sk_live_…`) removes the banner and the badge.
   - **Before the first real sale**, check that the banner is gone from the shop.

6. Set up monitoring before the first sale. Point the uptime service at `/health/ready`, set
   `ALKAO_METRICS_TOKEN`, and add the alerts listed in [ALKAO_RUNBOOK.md](ALKAO_RUNBOOK.md).
   Keep the runbook at hand on event days.

## 5. TAKATAK dashboard (optional, later)

takatakca/takatak-v1#95 adds the "ALKAO — Billetterie" menu. It is add-only and off by
default, with no database change. To enable it:

- In TAKATAK, set `ALKAO_OPS_URL` and `ALKAO_TICKETING_CLIENT_IDS`.
- In ALKAO, set `ALKAO_OPS_FRAME_ANCESTORS`.

## 6. Customer file and marketing (Runs 41–48)

Everything here is optional and can wait until after the first ticket sale. `npm run
check:golive` reports each step that is still missing.

1. **Load the history.** On the server, run `npm run customers:import -- --client <uuid>
   --brand <uuid> <report.csv>@<YYYY-MM-DD> […]`, with the Réservation camping.ca reports,
   oldest first. It prints totals only. From then on, staff import each new report from
   `/ops` → **Clients**.
2. **The sender.**
   - Under `/ops` → **Campagnes** → **Expéditeur**, enter the mailing address and a contact.
     No campaign can go out without them; the anti-spam law requires them.
   - **Bounces (Run 48), before the first campaign.** In Resend → **Webhooks**, add
     `https://<ALKAO_PUBLIC_URL>/v1/webhooks/resend` with the events `email.bounced`,
     `email.complained` and `email.suppressed`.
   - Put its signing secret in `RESEND_WEBHOOK_SECRET`, wherever the server runs.
   - Why: an old list has many dead addresses. Without the webhook, ALKAO keeps writing to
     them, and Resend can suspend an account whose bounces pass about 4 %, ticket e-mails
     included.
   - With the webhook, those addresses leave the lists by themselves. A campaign that
     bounces too much stops until someone looks at it, then **Reprendre l'envoi** sends the
     rest.
   - The pace is 300 campaign e-mails an hour (`ALKAO_CAMPAIGN_EMAILS_PER_HOUR`). Keep it for
     the first campaigns on a new domain.
3. **The welcome code.**
   - Under **Campagnes** → **Infolettre**, enter it, for example `HAVANA5`, "5 % sur vos billets".
   - Then create the same code under `/ops` → **Événements** → **Codes promo**, so that it
     works at checkout.
4. **Promo Havana.**
   - Set `ALKAO_URL`, `ALKAO_CLIENT_ID` and `ALKAO_BRAND_ID` on the site.
   - Its newsletter form then hands each sign-up to ALKAO, which sends the confirmation
     e-mail.
5. **Texts (optional).**
   - Set `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN`, plus either
     `TWILIO_MESSAGING_SERVICE_SID` (recommended) or `TWILIO_FROM_NUMBER`. They are needed
     wherever the server and `npm run cron` run.
   - In Twilio, point the Messaging Service's incoming-message webhook to
     `https://<ALKAO_PUBLIC_URL>/v1/webhooks/twilio/sms`, so that STOP and START are
     recorded.
   - Twilio bills per text. French letters such as ê, â, ç cut a text to 70 characters, and
     `/ops` shows the count before you send.
6. **Try it.**
   - Write a campaign and send a test to yourself (e-mail and text).
   - Click its unsubscribe link and check that the customer is marked unsubscribed.
