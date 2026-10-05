# ALKAO runbook

What to check and what to do when something goes wrong in service. For setup, see
[ALKAO_GO_LIVE.md](ALKAO_GO_LIVE.md).

## Watching ALKAO

| Check | Where | Healthy |
|---|---|---|
| The API is up | `GET /health` | `200` |
| The database answers | `GET /health/ready` (the load balancer's check) | `200`; `503` means the database is down or slow |
| Background work | `GET /metrics` with `Authorization: Bearer $ALKAO_METRICS_TOKEN` (Prometheus text; Run 24) | see the alerts below |
| What staff must handle | The Operations app's dashboard, "À traiter" (Run 21) | empty |

`/metrics` only exists when `ALKAO_METRICS_TOKEN` (at least 32 characters) is set. It holds
platform-wide counts only, never a Client, Brand, buyer or amount.

### Alerts to set

| Alert when | Metric | Likely cause |
|---|---|---|
| over 600 for 5 minutes | `alkao_email_oldest_due_seconds` | The email worker is stopped, or Resend refuses the emails |
| over 0 for 10 minutes | `alkao_holds_unswept_total` | The sweeper is stopped |
| over 0 | `alkao_refunds_stuck_total` | Stripe refused a refund, or never settled one |
| over 0 | `alkao_cancellation_orders_failed_total` | A session cancellation could not refund some buyers |
| over 0 | `alkao_disputes_open_total` | A buyer disputed a payment with their bank (information) |
| `/health/ready` not `200` | — | Database down or unreachable |
| `alkao_payment_events_total{outcome="ignored"}` jumps | — | Webhooks from an unknown account, or a Stripe misconfiguration |

## When something goes wrong

### Buyers do not receive their tickets

1. Check `alkao_email_oldest_due_seconds` and the email worker's logs (`alkao email: …`).
2. Check `RESEND_API_KEY`, and that the sender in `ALKAO_EMAIL_FROM` is verified in Resend.
3. Restart the worker (`npm run worker:email`). Emails queued meanwhile go out. Emails older
   than `ALKAO_EMAIL_MAX_AGE_HOURS` (72 h) are skipped and listed in "À traiter".
4. For one buyer, open the order and use **Renvoyer les billets par courriel**. The buyer can
   also open the personal link from any earlier email.

### Paid orders stay "en attente de paiement"

1. In the Stripe dashboard, check the Connect webhook endpoint's recent deliveries
   (`/v1/webhooks/stripe`).
2. A `400` on every delivery means a wrong `STRIPE_WEBHOOK_SECRET`. A `503` means payments
   are not configured on this deployment.
3. Fix the secret and **resend** the failed events from Stripe. ALKAO handles each event once,
   so resending is always safe.

### A refund is stuck

It shows in "À traiter" under "Remboursements bloqués chez Stripe".

1. Open the order and press **Réessayer** on the pending refund. ALKAO retries the same
   refund, never a second one.
2. A repeated failure is usually the Client's Stripe balance: refunds come out of the
   connected account. The Client must top it up in Stripe.

### A session must be cancelled (weather, closure)

1. On the event page, use **Annuler la séance**. ALKAO refunds every buyer in batches and
   emails them (Run 10).
2. Refunds that fail show in "À traiter". Fix the cause (usually the balance), then press
   **Réessayer** on each order's pending refund. They leave the list once refunded.

### The gate network is weak or down

- Before the doors open, press **Préparer le mode hors ligne** on each scanning device. The
  device then checks QR codes itself and syncs later.
- A ticket let in at two gates while offline is reported at sync ("aussi entré à une autre
  porte").
- A buyer without a working QR code: use **Sans code QR** with the order reference. This
  works online only (Run 22).

### The scanner shows "FAUX BILLET" or "BILLET D'UN AUTRE ORGANISATEUR"

- **"FAUX BILLET":** the code was not signed by ALKAO. **"BILLET D'UN AUTRE ORGANISATEUR":**
  it was signed for another Client. Do not admit on the code.
- Ask for the order reference and use **Sans code QR**. If no order matches, there is no
  ticket.

### A QR code was shared or leaked (screenshot on social media)

Open the order and use **Réémettre le QR** on the ticket. The old code stops working at
once, and the buyer's personal link shows the new one.

### The sweeper is stopped

`alkao_holds_unswept_total` rises. Sales stay correct, because lapsed holds are never shown
as taken. Seats return only when the sweeper runs, so restart it (`npm run worker:sweeper`).

### A buyer disputes a payment (chargeback)

It shows in "À traiter" and on the order, with the response deadline (Run 19).

1. Answer in the Client's Stripe dashboard before the deadline. The order page shows when
   each ticket entered at the gate, which is useful evidence.
2. ALKAO cancels nothing by itself. To stop the tickets from working, check them on the
   order and use **Annuler les billets cochés sans remboursement** (Run 21).

### A buyer asks for their data, or to be forgotten (Law 25)

On one of the buyer's orders, under "Données personnelles (Loi 25)":

- **Exporter les données de l'acheteur** (manager and above);
- **Anonymiser l'acheteur** (owner, admin; Run 20).

The buyer's email also sits in the Client's Stripe account. The Client handles that part in
Stripe.

### Turning ALKAO off

- **One Brand:** TAKATAK suspends its Ticketing activation (the control contract). Sales stop
  at once. Tickets already sold still scan.
- **The whole deployment:** set `ALKAO_OPERATIONAL_API_ENABLED=false` and restart. Stripe
  webhooks are still accepted, so payments made before the switch are settled or refunded.

## Never do this

- **Never change `ALKAO_CREDENTIAL_MASTER_SECRET`:** every QR code ever issued stops working.
  To change signing keys, use the key rotation, which keeps old codes valid.
- **Never delete rows by hand.** Orders, tickets, scans, refunds and emails are append-only
  or protected by triggers, on purpose. Use the Operations app or the API.
- **Never point ALKAO at the TAKATAK or FESTI-ICE database.** ALKAO has its own.
