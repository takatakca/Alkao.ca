# ALKAO go-live checklist

ALKAO is a separate deployment. Turning it on changes nothing in TAKATAK V1, FESTI-ICE or
any other running system. Every step below is additive and can be undone by turning
ALKAO off again: `ALKAO_OPERATIONAL_API_ENABLED=false`, or stop the processes.

## 1. Infrastructure

| Item | Value |
|---|---|
| Database | A database **dedicated to ALKAO**. Never use the TAKATAK or FESTI-ICE database. Two ways: a dedicated Supabase project, migrated with `supabase db push`; or plain PostgreSQL 15+: run `supabase/tests/supabase_shim.sql` once (it creates the Supabase roles and `auth.uid()`), then `npm run db:migrate` |
| Auth | The **same Supabase project** as TAKATAK, so staff use their TAKATAK accounts. Set `SUPABASE_JWKS_URL` (or `SUPABASE_JWT_SECRET`), `SUPABASE_URL` and `SUPABASE_ANON_KEY` |
| Processes | `npm start` (API, `/ops`, `/billets`, `/acheter`), `npm run worker:sweeper`, `npm run worker:email` |
| Public URL | HTTPS, e.g. `https://billets.example.ca`. Set it as `ALKAO_PUBLIC_URL` for both the server and the email worker |

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
   publish.
4. Share the shop link `https://…/acheter/<clientId>/<brandId>`, or the Brand's own site can
   call the public API.
5. Make a test purchase. You should see the payment on the Client's Stripe account, the
   tickets email, QR codes on `/billets`, and a scan at the gate.

## 5. TAKATAK dashboard (optional, later)

takatakca/takatak-v1#95 adds the "ALKAO — Billetterie" menu. It is add-only and off by
default, with no database change. To enable it:

- In TAKATAK, set `ALKAO_OPS_URL` and `ALKAO_TICKETING_CLIENT_IDS`.
- In ALKAO, set `ALKAO_OPS_FRAME_ANCESTORS`.
