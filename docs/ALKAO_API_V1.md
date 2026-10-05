# ALKAO API v1 (`alkao.api.v1`)

Request schemas: [`src/contracts/api-v1.ts`](../src/contracts/api-v1.ts). Unknown body fields are
dropped: a client can never send a price, a tenant id or a status it isn't allowed to set.

Errors always look like `{ "error": { "code": "…", "details": … } }` with stable codes.

## Gates

| Surface | Checks, in order | Refusal |
|---|---|---|
| Public `/v1/public/clients/:clientId/brands/:brandId/…` | Ticketing gate (deployment switch, Client/Brand active and paired, entitlement for the pair) | `404 ticketing_unavailable`, with no reason, so tenants cannot be probed |
| Admin `/v1/admin/clients/:clientId/brands/:brandId/…` | 1. Supabase access token → `401` · 2. active membership in the Client → `404` · 3. Ticketing gate → `403 ticketing_disabled {reason}` · 4. role permission → `403 forbidden` | as listed |
| `GET …/status` (admin) | Token and membership only | Returns `{ role, ticketing: { active, reason? } }` so the dashboard can explain why Ticketing is off |
| `POST /v1/control/events` | HMAC signature (see [control contract](ALKAO_CONTROL_CONTRACT_V1.md)) | `401` / `503` |
| `POST /v1/webhooks/stripe` | Stripe signature (`Stripe-Signature`, Connect endpoint secret). Not behind the Ticketing gate, so a checkout opened while Ticketing was active is still settled or refunded if Ticketing is turned off before the buyer pays | `400` / `503` |
| `GET /health` | none | — |

`test/api/gate.test.ts` enumerates every registered route and proves each one refuses to act
while Ticketing is off, and that a refused hold request writes nothing.

## Public (buyer-facing)

| Method | Path | Body | Result |
|---|---|---|---|
| GET | `/events` | — | Published events of the Brand |
| GET | `/events/:eventId` | — | Event, active ticket types and their rules, on-sale future sessions with `available` |
| POST | `/events/:eventId/quote` | `{ items: [{ ticketTypeId, quantity }] }` | Server-priced quote (lines, GST/QST, total) or `422 cart_invalid` listing every violation |
| POST | `/holds` | `{ sessionId, items }` | `201 { hold: { id, token, expiresAt, sessionId, quote } }`. The token is shown once and only its hash is stored. Errors: `409 sold_out`, `409 session_not_available`, `422 cart_invalid`, `429 rate_limited` |
| GET | `/holds/:holdId` | header `X-Alkao-Hold-Token` | Hold status (`active`/`expired`/`released`/`converted`) and items |
| DELETE | `/holds/:holdId` | header `X-Alkao-Hold-Token` | `204`; `409 hold_not_active` if already closed |

### Checkout (Run 02)

| Method | Path | Body | Result |
|---|---|---|---|
| POST | `/holds/:holdId/checkout` | header `X-Alkao-Hold-Token`; `{ buyer: { email, fullName?, phone?, language? }, successUrl, cancelUrl }` | `201 { order: { id, reference, token, status }, checkoutUrl }`. A free order is `paid` at once and `checkoutUrl` is `null`. Calling again for the same hold returns the same Checkout and rotates the order token. Errors: `422 return_url_not_allowed`, `409 payments_unavailable`, `409 hold_not_active`, `502 payment_provider_error` (safe to retry) |
| GET | `/orders/:orderId` | header `X-Alkao-Order-Token` | Order status, lines, taxes and tickets, for the buyer's confirmation page. Each valid ticket has `credential`, its QR payload (Run 03, [format](ALKAO_SCANNER_V1.md)) |

How a payment works:

- **Stripe Connect direct charge on the Client's own account.** Buyers pay the Client
  directly, and the Client is the merchant.
- **TAKATAK's commission is the `application_fee_amount`:** the rate on the pre-tax subtotal,
  plus the fixed amount per paid ticket.
- **Line items** are the paid ticket lines plus one line each for TPS and TVQ. Their sum
  always equals the order total.
- **Cards only,** so a completed Checkout means the payment is confirmed.
- **The hold is extended** to match the Checkout session (31 min) plus 5 minutes for a late webhook.
- **Fulfilment** happens only on a signed `checkout.session.completed` webhook. ALKAO checks
  that the amount, the currency (CAD) and the connected account all match. It tracks each
  Stripe event by its id, so a redelivered event changes nothing.
- **When Checkout expires,** the order expires and the seats return to sale.
- **When a payment arrives after its seats were resold** (the hold had lapsed), the order is
  refunded in full automatically, commission included.

## Admin (TAKATAK dashboard / Client staff)

| Method | Path | Permission |
|---|---|---|
| GET | `/status` | any member |
| GET / POST | `/venues` | `catalog.read` / `catalog.write` |
| PATCH | `/venues/:venueId` | `catalog.write` |
| GET / POST | `/events` | `catalog.read` / `catalog.write` (always created as `draft`) |
| GET / PATCH | `/events/:eventId` | `catalog.read` / `catalog.write` |
| GET / POST | `/events/:eventId/sessions` | `inventory.read` / `catalog.write` (always created as `draft`) |
| PATCH | `/sessions/:sessionId` | `catalog.write`; `409 capacity_below_committed` if capacity drops below what is held + sold |
| GET / POST | `/events/:eventId/ticket-types` | `catalog.read` / `catalog.write` |
| PATCH | `/ticket-types/:ticketTypeId` | `catalog.write` |
| GET | `/orders?limit&before` | `orders.read` |
| GET | `/orders/:orderId` | `orders.read` (buyer, lines, taxes, tickets) |
| GET | `/audit?limit&before&beforeId&action&entityType&entityId` | `audit.read` (filters and `actorRole`: Run 30) |
| POST | `/payments/onboarding` | `payments.manage`: creates the Client's Stripe Standard account (CA) on the first call and returns a Stripe onboarding link |
| GET | `/payments/account` | `payments.manage`: connection status (`chargesEnabled`, `payoutsEnabled`, `detailsSubmitted`) |
| GET / PUT | `/payments/settings` | `payments.manage`: `checkoutReturnOrigins`, the HTTPS origins of the Brand's site allowed as Checkout return URLs |
| GET | `/orders/:orderId/refunds` | `orders.read` |
| POST | `/orders/:orderId/refunds` | `refunds.create`: `{ amountCents?, ticketIds?, reason? }`. Without an amount, refunds everything still refundable and voids every valid ticket. With an amount, voids only the `ticketIds` given (their seats return to sale) |
| POST | `/refunds/:refundId/retry` | `refunds.create`: completes a refund left pending by a Stripe failure (`502 refund_provider_error` returns its `refundId`) |

### Refunds and the V1 commission policy

A full refund to the buyer refunds the full TAKATAK commission. A partial refund refunds a
proportional share, computed cumulatively, so several partial refunds always add up to the
full commission in the end. Each refund runs in three steps:

1. A pending refund is recorded. Only one refund per order can be in flight at a time.
2. Stripe refunds the buyer on the Client's account, then refunds the application fee on the
   platform. Each call's idempotency key is derived from the refund id.
3. The order totals are updated and the tickets voided.

If Stripe fails, the refund stays pending, and retrying it never pays out twice. At commit,
the database checks that the order's refunded totals equal the sum of its refunds.

Every admin write is recorded in `ticketing_audit_log` in the same transaction.

### Flex Météo session change (Run 04)

| Method | Path | Who | Result |
|---|---|---|---|
| POST | `/v1/public/…/orders/:orderId/exchange` `{ sessionId }` | Buyer (header `X-Alkao-Order-Token`) | `201 { exchange: { orderId, reference, token, tickets } }` |
| POST | `/v1/admin/…/orders/:orderId/exchange` `{ sessionId }` | `credentials.manage` (owner, admin, manager) | Same, done by staff |

- **Who can change:** an order that bought an add-on with `grantsSessionChange` (FESTI-ICE
  `FLEX_WEATHER`) can move all its valid tickets, **once**, to another session of the same event.
- **Where to:** the new session must be on sale, in the future and have room. Once any of the
  order's tickets has been scanned in, the order can no longer move.
- **How:** the move creates a zero-amount exchange order. The money and the Stripe payment stay
  on the original order. The new tickets and QR codes belong to the exchange order, and the old
  tickets are voided, so their QR codes no longer open the gates. Prices depend on the ticket
  type, not the session, so in V1 the difference is always zero.
- **Refunds:** refunding the original order also voids the moved tickets. The exchange order
  holds no money. Reports count the sale once.
- Errors: `409 flex_not_purchased`, `409 already_exchanged`, `409 ticket_already_used`,
  `409 session_not_available`, `409 sold_out`.

### Operations (Run 04)

| Method | Path | Permission | Result |
|---|---|---|---|
| GET | `/reports/sales?eventId&from&to` | `orders.read` | Gross, subtotal, taxes (GST/QST), TAKATAK commission, refunds and **net to the Client** (before Stripe processing fees); sessions (capacity, sold, held, available, admitted); revenue per ticket type. Dates filter on payment time |
| GET | `/reports/attendees.csv?sessionId` | `buyers.read` | One row per ticket: order reference, ticket type, buyer, status, admission time. Audited |
| GET | `/reports/orders.csv?eventId&from&to` | `buyers.read` | One row per paid, partially refunded or refunded order, with money columns in cents. Audited |

The CSV exports neutralize spreadsheet formulas: a cell starting with `= + - @` gets a leading
apostrophe, because buyer names are untrusted input.

Run `npm run worker:sweeper` (env `DATABASE_URL`, `ALKAO_SWEEP_INTERVAL_SECONDS`, default 60)
to expire lapsed holds and return their seats. Public availability already ignores lapsed
holds even when the sweeper isn't running.

### Buyer delivery (Run 06)

When an order becomes paid, a database trigger queues a "your tickets" email in the same
transaction, whichever path marked the order paid: the Stripe webhook, a free order, or a
Flex Météo exchange order, which gets its own "Vos nouveaux billets" email.

**Sending.** `npm run worker:email` sends the queue through Resend. The worker refuses to
start without `RESEND_API_KEY`, `ALKAO_EMAIL_FROM`, `ALKAO_PUBLIC_URL` (HTTPS) and
`ALKAO_CREDENTIAL_MASTER_SECRET`. Nothing is sent until it runs. Delivery rules:

- One row per transaction with `FOR UPDATE SKIP LOCKED`: two workers never send the same email.
- The idempotency key is the same across a crashed attempt and its retry.
- Temporary failures (429, 5xx, network) are retried with backoff, 8 times at most.
- Permanent 4xx failures stop at once (`failed`).
- An email is **skipped**, never sent, if the order no longer has a valid ticket, or if it
  waited more than `ALKAO_EMAIL_MAX_AGE_HOURS` (default 72). Starting the worker late never
  sends old emails.

**The link** is `ALKAO_PUBLIC_URL/billets#c=…&b=…&o=…&k=…`:

- **Fragment only.** The order and its token sit after `#`, which browsers never send to a
  server or in `Referer`.
- **Derived, never stored.** The token comes from the server secret and the email id, and
  only its SHA-256 is stored, as an order access token with purpose `email`. A resend or a
  retry carries the same link.
- **Independent of checkout.** The checkout token and the email link are separate:
  rotating one never breaks the other.

**`/billets`** is a static page with a strict CSP, `noindex`, and no data of its own. It shows:

- the Brand, the event, the session and the venue;
- one QR code per valid ticket, rendered in the browser and dark on white even in dark mode;
- a clear notice for voided or replaced tickets;
- the buyer's own **Flex Météo** change, when the order bought it.
- **Ajouter à mon calendrier** (Run 31): an `.ics` file built in the browser from what the
  page shows (event, session times in UTC, venue and address, order reference). It never
  contains the personal link or its token, because calendars are often synced and shared.
  One entry per order (`UID` = order id), so adding it twice updates it.

| Method | Path | Who | Result |
|---|---|---|---|
| GET | `/v1/public/…/orders/:orderId` | Buyer token | Now also `brand`, `event` (title, dates, venue), `exchangeOfOrderId`, `exchanged`, `canChangeSession` |
| GET | `/v1/admin/…/orders/:orderId` | `orders.read` | Now also `emails`: kind, status, attempts, sentAt, lastError. Never the link |
| POST | `/v1/admin/…/orders/:orderId/tickets-email` | `credentials.manage` | `202`: queue the tickets email again, with the same link. Audited. `409 order_has_no_valid_ticket`, `409 email_resend_limit` |

`ticketing_email_outbox` holds personal data. It has RLS on, with no grants and no policy, so
nobody reads it through the Data API.

### Hosted ticket shop (Run 08)

A Brand can sell with a plain link, without changing its website:

| Page | Content |
|---|---|
| `/acheter/<clientId>/<brandId>` | The Brand's published events |
| `/acheter/<clientId>/<brandId>/<eventId>` | Choose a session (live availability), then quantities per ticket type and add-on. The server prices the order, TPS and TVQ included, and explains cart rules in French. Then hold the seats (with a countdown), enter buyer details and pay with Stripe Checkout. Free orders go straight to the tickets |
| `/acheter/merci/<clientId>/<brandId>/<holdId>` | Stripe's success page. It opens the buyer's `/billets`, which checks again while the payment confirms |

How it works:

- **Back without paying:** a buyer who leaves Stripe can resume the same payment, or free
  the seats.
- **Same API as any site:** the pages are static files with a strict CSP. Every price, rule
  and seat comes from the public, gated API, the same API a Brand's own website would call.
- **Return URLs:** ALKAO's own origin (`ALKAO_PUBLIC_URL`) is always an allowed Stripe
  return URL, alongside the Brand's `checkoutReturnOrigins`. Any other origin is refused.
- **Event details:** `GET /v1/public/…/events/:eventId` now also returns `event.brand.name`
  and `event.venue` (name, city, timezone).

**Door sales** (Run 35, owner decision, see [ALKAO_DECISIONS.md](ALKAO_DECISIONS.md)):

- Staff open **Vente à la porte** on the event page in `/ops`. It opens
  `/acheter/<clientId>/<brandId>/<eventId>?porte=1` on the phone or tablet in their hand.
- **Payment and commission:**
  - The payment is the shop's own Stripe Checkout, by card, on the Client's Stripe account,
    so the TAKATAK commission applies exactly as online.
  - There is no cash sale in V1, because the commission could not be collected
    automatically.
- **What door mode changes:**
  - Only today's sessions are offered (venue time).
  - "Retrouver mes billets" is hidden.
  - The buyer's tickets show on screen as soon as Stripe confirms, with a
    **Nouvelle vente à la porte** button for the next customer.
- For short arrival slots, the next slot is minutes away, and the gate opens before it
  starts (door hours), so the buyer can go straight in.
- The tickets email is sent as for any order.
- Door mode only filters what the public shop already shows. It gives no extra right and
  needs no new route.

### Session cancellation (Run 10)

When an organizer cancels a session (weather, ice), every buyer is refunded and told.

| Method | Path | Permission | Result |
|---|---|---|---|
| POST | `/sessions/:sessionId/cancel` `{ reason? }` | `payments.manage` (owner, admin) | `202 { cancellation }`. The session is `cancelled` at once, then a first batch runs. Asking twice is harmless |
| POST | `/sessions/:sessionId/cancellation/continue` | `payments.manage` | The next batch (10 orders). The Operations app calls it until done |
| GET | `/sessions/:sessionId/cancellation` | `orders.read` | Progress: orders refunded, voided, pending, failed; amount refunded; failures with their reference |

**What happens:**

- **Sales stop at once.** Open holds are released.
- **Paying orders are refunded in full,** with the TAKATAK commission returned (V1 policy):
  - partially refunded orders get the rest;
  - for tickets moved into this session by Flex Météo, the original order, which holds the
    money, is refunded.
- **Free tickets are voided** (reason `cancelled`).
- **Each buyer gets a "Séance annulée" email** with the amount refunded.

**Safety:**

- **Exactly once.** Each affected order has its own row (`ticketing_session_cancellation_orders`),
  so it is refunded exactly once. A Stripe failure is retried with the same refund and the same
  idempotency keys, at most once per batch and 10 times in all, then reported as `failed`.
- **Late payments.** A checkout still open at Stripe that completes after the cancellation
  issues no ticket and is refunded in full automatically (reason `session_cancelled`).
- **No silent switch-off.** `PATCH /sessions/:id { status: "cancelled" }` on a session with
  sold or held seats answers `409 use_session_cancellation`.
- **Unattended.** `npm run worker:cancellations` finishes cancellations and retries without
  anyone keeping the page open.

### Refund emails, personal links, website button (Run 12)

**Refund email.** The buyer is emailed for every succeeded refund:

- staff refunds, full or partial: the amount, the voided tickets, and a link to the tickets
  that are still valid;
- payments that arrived after the seats were gone: explained and refunded in full.

An order refunded several times gets one email per refund. A session cancellation sends
only its own "Séance annulée" email.

**One personal link per order.** Every email of an order carries the same `/billets` link.
Its token is derived from the server secret, the order id and a random nonce stored with the
token's hash; the token itself is never stored.

| Method | Path | Permission | Result |
|---|---|---|---|
| POST | `/v1/admin/…/orders/:orderId/tickets-link/rotate` | `credentials.manage` | `202`. The old link stops working at once, and a new email with a new link is queued. Audited. Reissue the QR codes too if they were shared |

**Website button.** A Brand adds this tag to its own site:

```html
<script src="https://<alkao>/widget.js" data-client="<clientId>" data-brand="<brandId>" data-event="<eventId>" data-label="Acheter des billets" async></script>
```

It inserts a plain link to the ALKAO shop: no iframe, no cookie, no data. Options:

- `data-target="_blank"` opens the shop in a new tab;
- `data-color="#0b5cad"` sets the button colour;
- `data-style="none"` lets the site style `.alkao-buy` itself.

The Operations app shows each event's shop link and its button code, ready to copy.

### Operations essentials (Run 14)

| Method | Path | Permission | Result |
|---|---|---|---|
| GET | `/v1/admin/…/orders?q=` | `orders.read` | Search by reference prefix, email prefix (case-insensitive) or part of the buyer's name. At least 2 characters; `%` and `_` are taken literally |
| GET | `/v1/admin/…/sessions/:sessionId/attendance` | `scan` | `{ capacity, valid, admitted }`, the gate's live counter |
| GET | `/health/ready` | none | `200` when the database answers within 2 s, `503` otherwise (for the load balancer). `/health` stays a plain liveness check |

The server logs one JSON line per request: method, **route pattern** (never ids, query
strings or headers), status and duration. Set `ALKAO_LOG_REQUESTS=false` to turn it off.

### English for buyers (Run 16)

The shop, the `/billets` page and the buyer emails are in **French by default**, the
Québec rule, and in **English on request**. Staff pages stay in French. The language is
chosen as follows:

1. `?lang=en` (or `?lang=fr`) in the address;
2. otherwise, the visitor's last choice through the "English" / "Français" switch;
3. otherwise, the browser's language.

The shop sends `buyer.language` (`fr` or `en`, default `fr`) with the checkout, and ALKAO
keeps it on the buyer. The tickets, refund and "session cancelled" emails follow that
choice, including dates and amounts in the right format. The website button accepts
`data-lang="en"`, which links to the English shop and shows "Buy tickets".

### Disputes and refunds made in Stripe (Run 19)

After the sale, two things can happen on the Client's Stripe account without ALKAO:

- **A dispute (chargeback).** The buyer's bank takes the money back. Stripe tells the
  Client, who answers from the Stripe dashboard.
- **A refund made directly in the Stripe dashboard.**

ALKAO records both from the webhooks and shows them to staff. **Neither moves money.**
While a dispute is open, the order keeps its status and its tickets stay valid: gate entry
times are the Client's evidence.

**A dispute the buyer wins** (Run 34, owner decision, see [ALKAO_DECISIONS.md](ALKAO_DECISIONS.md)):

- **For the whole remaining amount:** every ticket of the order (and of its Flex exchange)
  not yet used at the gate is cancelled (`void_reason = 'chargeback'`). Their QR codes stop
  working and their seats go back on sale. A ticket already used stays as it is.
  - The buyer is not emailed.
  - It is logged as `tickets.voided` with `reason: "chargeback"` and the dispute id.
- **For part of the order:** nothing is cancelled automatically, and
  `payment.dispute_lost_partial` is logged. The order shows in "À traiter"
  (`lostDisputes` in `GET /attention`) until staff cancel the tickets it covered from the
  order page.

| Method | Path | Permission | Result |
|---|---|---|---|
| GET | `/v1/admin/…/orders/:orderId` | `orders.read` | Also returns `disputes` (`stripeDisputeId`, `amountCents`, `reason`, `status`, `evidenceDueBy`, `open`), `outsideRefundCents` (the part of Stripe's refunded total that ALKAO did not issue) and, per ticket, `admittedAt` (when it entered at the gate: evidence for a dispute) |
| GET | `/v1/admin/…/disputes?status=open\|all` | `orders.read` | The Brand's disputes with the order reference and buyer. Open first, earliest deadline first. Default `open` |

How ALKAO reads the events:

- `status` and `reason` are Stripe's own values.
- A dispute is `open` until Stripe reports `won`, `lost`, `warning_closed` or `prevented`.
- An event older than the last one applied changes nothing, so a late delivery cannot reopen
  a closed dispute.
- For refunds, ALKAO keeps Stripe's running `amount_refunded` for the charge, which only
  grows. A refund that ALKAO has started counts against it immediately, so ALKAO's own
  refunds never look like outside ones.
- Each new dispute, dispute change and outside refund is written to the audit log
  (`payment.dispute_opened`, `payment.dispute_updated`, `payment.dispute_closed`,
  `payment.outside_refund`).
- Sales reports count only ALKAO's own refunds.

### A buyer's personal data on request: Québec Law 25 (Run 20)

When a buyer asks the Client what it holds about them, or asks to be forgotten:

| Method | Path | Permission | Result |
|---|---|---|---|
| GET | `/v1/admin/…/orders/:orderId/buyer/export` | `buyers.read` | JSON download (`alkao.buyer-export.v1`) with everything ALKAO holds about this order's buyer for the Brand: identity, every order (amounts, session, venue), tickets with their entry time, refunds and emails sent. Logged as `buyer.exported` |
| POST | `/v1/admin/…/orders/:orderId/buyer/anonymize` | `buyers.erase` (owner, admin) | `{ anonymizedAt, alreadyAnonymized }`. Irreversible |

**What anonymizing does.** Personal data in ALKAO lives on the buyer row only. Anonymizing:

- replaces the email with `anonyme-<buyer id>@anonyme.invalid`, an address that can never receive mail;
- clears the name and the phone;
- clears the staff notes on the buyer's refunds;
- drops queued emails and stops any later email to the buyer (`buyer_anonymized`);
- deletes the personal ticket links.

Orders, amounts, taxes, commission, tickets and gate scans stay, so reports remain exact. The
order shows `buyerAnonymizedAt`. The audit entry `buyer.anonymized` names only the buyer row.

**When it is refused (`409`).** While the buyer still needs to be reachable:

- `buyer_has_upcoming_tickets`: a valid ticket for a session that has not ended;
- `refund_in_progress`: a refund in progress;
- `dispute_open`: an open Stripe dispute.

Refund or cancel first, or wait until the session is over. Asking again for an anonymized
buyer changes nothing.

**Outside ALKAO.** The buyer's email also sits in the Client's Stripe account (the
checkout) and in the email provider's logs. Those are the Client's to handle.

### What waits on staff, and tickets cancelled without a refund (Run 21)

| Method | Path | Permission | Result |
|---|---|---|---|
| GET | `/v1/admin/…/attention` | `orders.read` | `{ attention: { refunds, emails, disputes, outsideRefunds, cancellations, total } }`, up to 50 of each, each with what is needed to act |
| POST | `/v1/admin/…/orders/:orderId/tickets/void` | `refunds.create` | `{ ticketIds, reason? }` → `{ voided }`. Cancels those tickets **without a refund**: the seats go back on sale and the QR codes stop working. Logged as `tickets.voided` |

Each list keeps only what someone can still act on, so it empties as the work gets done.

| List | What it holds |
|---|---|
| `refunds` | Pending refunds that Stripe failed on, or that have not settled after 15 minutes. Retried from the order |
| `emails` | Emails that failed or were never sent. Ticket emails are listed while the session is still to come; refund and cancellation notices for 30 days. Anonymized buyers are left out |
| `disputes` | Open Stripe disputes (Run 19) |
| `outsideRefunds` | Refunds made in Stripe on orders whose tickets are still valid for a session to come |
| `cancellations` | Cancelled sessions where some buyers could not be refunded |

**Voiding tickets.** Tickets of the order and of its Flex exchange can be voided. A ticket
already used at the gate, already void or belonging to another order is refused
(`ticket_already_used`, `invalid_ticket`). The order's money and status are untouched.

### Reminder before the session (Run 23)

Each buyer gets one reminder during the 24 hours before their session. It carries the
time, the place and the personal tickets link, in the buyer's language.

**When no reminder is queued.** One is not queued when:

- the order was paid in the last 12 hours (the tickets email just went out);
- the session is cancelled;
- the order holds no valid ticket;
- the buyer was anonymized;
- the Brand turned reminders off.

**When a queued one is dropped.** A queued reminder is dropped (`skipped`) if the session is
cancelled or has already started when it would go out. The email worker queues reminders on
each run, so there is nothing else to schedule.

| Method | Path | Permission | Result |
|---|---|---|---|
| GET | `/v1/admin/…/settings/reminders` | `credentials.manage` | `{ reminders: { enabled } }`, `true` by default |
| PUT | `/v1/admin/…/settings/reminders` | `credentials.manage` | `{ enabled }`. Logged as `settings.reminders_updated` |

### Sales by period and by day (Run 26)

| Method | Path | Permission | Result |
|---|---|---|---|
| GET | `/v1/admin/…/reports/daily?from&to&eventId` | `orders.read` | `{ report: { timeZone, days: [...], totals } }`, one row per day |
| GET | `/v1/admin/…/reports/daily.csv?from&to&eventId` | `orders.read` | The same rows as CSV (amounts in cents). Logged as `reports.daily_exported` |

Each day gives: orders, subtotal before taxes, all taxes with TPS (GST) and TVQ (QST)
apart, gross, refunds (count and amount), commission, commission returned, and net to the
Client before Stripe's fees. This is the total minus refunds minus the net commission.

- **Sales** count on the day they were **paid**. **Refunds** count on the day Stripe
  **completed** them, so a March refund of a February sale is in March, as in the bank.
- The sales report (`/reports/sales`) instead counts refunds against the orders of the
  period. Both are right; they answer different questions.
- Days follow the time zone of the Brand's venues (America/Toronto when there is none). The
  report returns it as `timeZone`.
- In the Operations app, the dashboard has a period picker (today, 7 days, this month, last
  month, since the start) and an event filter. Both drive the totals, the by-day table and
  the two CSV exports.

### "Retrouver mes billets" (Run 27)

| Method | Path | Gate | Result |
|---|---|---|---|
| POST | `/v1/public/…/tickets/resend` | Ticketing gate | `{ email }` → `202 { ok: true }`, **always the same answer**, so it never reveals whether an address bought anything |

For a buyer who lost the email. ALKAO sends the tickets email again for each of that
buyer's orders that still matter: valid tickets for a session that is neither over nor
cancelled, up to 10. It goes to the **same address**, with the usual personal link.

- **Never written to:** anonymized buyers, and other Brands' buyers.
- **Rate limits:** 5 requests per caller per 10 minutes (`429 rate_limited`), and 3 sends
  per address per hour. Past that, the request is answered the same and does nothing, so
  nobody can flood an inbox.
- **Audit:** each order re-sent is logged as `order.tickets_email_requested` with the
  `public` actor.
- **The shop:** "Vous avez déjà acheté ? Retrouvez vos billets" sits under the event list
  and on each event page, in French or English.

### Duplicating an event (Run 28)

| Method | Path | Permission | Result |
|---|---|---|---|
| POST | `/v1/admin/…/events/:eventId/duplicate` | `catalog.write` | `{ title?, shiftDays? }` → `201 { event: { id, slug, title, status: "draft" }, ticketTypes, sessions }` |

This is for next week's evening, or next year's edition.

**Always copied.** The copy is a **draft** at the same venue, with the same description, door
hours and ticket types (prices, limits, Flex Météo option).

**With `shiftDays`** (for example `7`, or `364` for the same weekday next year):

- The sessions are copied, moved by that many days. Cancelled ones are skipped.
- They are drafts with nothing sold or held.
- The sales window moves by the same number of days.

**Without `shiftDays`**, neither the sessions nor the sales window are copied.

**Never copied:** orders, tickets or buyers. The original does not change.

- The slug is the original's with `-copie`, then `-copie-2`, and so on.
- The title defaults to the original's with " (copie)".
- Logged as `event.duplicated`. In the Operations app, use **Dupliquer l'événement** on the
  event page.

### Sessions in bulk (Run 29)

| Method | Path | Permission | Result |
|---|---|---|---|
| POST | `/v1/admin/…/events/:eventId/sessions/batch` | `catalog.write` | see below → `201 { timeZone, requested, created, skipped, sessions: [{ id, startsAt, endsAt }] }`; with `dryRun: true`, `200` and nothing is created |
| POST | `/v1/admin/…/events/:eventId/sessions/status` | `catalog.write` | `{ from: "draft" \| "on_sale" \| "paused", to: "on_sale" \| "paused" }` → `200 { updated }` |

This is for a whole season at once. FESTI-ICE, for example, has arrivals every 15 minutes
from 17:00 to 20:30, every evening.

**Batch body:**

| Field | Meaning |
|---|---|
| `fromDate`, `toDate` | `YYYY-MM-DD`, both included, at most 367 days apart |
| `weekdays` | Optional, ISO numbers (1 = Monday … 7 = Sunday). Absent: every day |
| `firstStart`, `lastStart` | `HH:MM`. Without `lastStart`, one session a day at `firstStart` |
| `everyMinutes` | 5 to 720. Required when `lastStart` is after `firstStart` |
| `durationMinutes` | Optional. Sets each session's end |
| `capacity` | Seats per session |
| `status` | `draft` (default) or `on_sale` |
| `dryRun` | `true`: only list what would be created |

- **Times are the venue's local times.** PostgreSQL turns them into instants, so a clock
  change is handled. A local time skipped when clocks go forward becomes the hour after;
  if that is also asked for, only one session is made.
- **Start times the event already has are skipped** and counted in `skipped`. Those sessions
  are left exactly as they are, so the same batch can be sent again safely.
- At most **1000 sessions** per request (`422 too_many_sessions`, `details.max`).
- Logged once as `sessions.batch_created`, with the request and the counts.

**Status in bulk:**

- Only **upcoming** sessions in `from` are moved. Past, cancelled and closed sessions never
  move. Cancelling a session with buyers stays on its own route, which refunds them.
- Logged as `sessions.status_batch_changed`, with the count.

**In the Operations app**, on the event page:

- **Créer plusieurs séances…**: preview first, then **Créer N séance(s)**.
- **Ouvrir les ventes des brouillons à venir**, **Suspendre toutes les ventes à venir** and
  **Reprendre les ventes suspendues**.

### Audit journal and order history (Run 30)

| Method | Path | Permission | Result |
|---|---|---|---|
| GET | `/v1/admin/…/audit` | `audit.read` | `200 { entries: [{ id, brandId, actorType, actorId, actorRole, action, entityType, entityId, data, createdAt }] }`, newest first |
| GET | `/v1/admin/…/orders/:orderId/history` | `audit.read` | `200 { entries }`, oldest first, at most 500 |

This only reads the log; nothing in it changes.

**`/audit` filters**, each optional:

| Parameter | Meaning |
|---|---|
| `action` | One action (`order.paid`) or a family of actions (`order`, `refund`, `payment`…). `order` does not match `orders.…` |
| `entityType`, `entityId` | What the entry is about |
| `beforeId` | The id of the last entry already shown. The next page starts right after it |
| `before` | Unchanged: strictly earlier than this time |

- **Use `beforeId` for paging.** `before` can skip entries written in the same transaction,
  because the database keeps microseconds and JSON times keep milliseconds. With
  `beforeId`, the exact time is read from the database. An id from another Client returns
  nothing.
- **`actorRole`** is the role the person holds today in the Client (`null` if they left or
  the actor is not a person). Names and emails stay in TAKATAK.

**`/orders/:orderId/history`** gathers, for one order:

- the order's own entries (paid, emails, link replaced, tickets cancelled, exchanged, disputes,
  refunds made in Stripe);
- its refunds (`data.orderId`);
- the exchange that created it (`data.exchangeOrderId`);
- its tickets (QR code reissued, let in without a QR code);
- its buyer (exported, anonymized).

Another Client's entries never appear, even when they name the same id.

**Indexes:** the migration `20261017000100_alkao_audit_lookup.sql` adds indexes only, and the
history reads through them. A test checks this with 30 000 entries.

**In the Operations app:**

- A **Journal** tab, for owners and admins only. It has a filter by family and **Plus ancien**.
- An **Historique** section on each order.

### Role → permission

| Role | catalog.read · inventory.read · holds.read | catalog.write | orders.read · buyers.read | audit.read |
|---|---|---|---|---|
| owner, admin | ✓ | ✓ | ✓ | ✓ |
| manager | ✓ | ✓ | ✓ | |

Run 02 adds `payments.manage` (owner, admin) and `refunds.create` (owner, admin, manager).
Run 03 adds `scan` (owner, admin, manager, staff), `credentials.manage` (owner, admin, manager)
and `keys.manage` (owner, admin). Its routes are listed in [ALKAO_SCANNER_V1.md](ALKAO_SCANNER_V1.md).
Run 20 adds `buyers.erase` (owner, admin).
| editor | ✓ | ✓ | | |
| staff, viewer | ✓ | | | |

These match the RLS policies: buyer data and order money are visible to owner, admin and
manager only.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — | ALKAO PostgreSQL (server connection; RLS is the second layer for the Data API) |
| `ALKAO_OPERATIONAL_API_ENABLED` | `false` | Deployment switch. Off: every operational route refuses |
| `ALKAO_CONTROL_KEYS` | — | `kid:secret` pairs for the control contract |
| `SUPABASE_JWKS_URL` or `SUPABASE_JWT_SECRET` | — | Access-token verification (audience `authenticated`) |
| `SUPABASE_JWT_ISSUER` | — | Optional issuer check |
| `ALKAO_HOLD_TTL_SECONDS` | `600` | Hold lifetime (60–1800) |
| `ALKAO_PUBLIC_HOLDS_PER_MINUTE` | `20` | Per Client and IP, in-process. Also rate-limit at the edge in production |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | — | Platform key and the **Connect** webhook endpoint secret. Without both, payments stay off (`payments_unavailable`/`503`) |
| `ALKAO_CREDENTIAL_MASTER_SECRET` | — | Secret (≥ 32 chars) from which each Client's QR signing keys are derived. Without it, there are no QR codes and scanning answers `503`. Changing it invalidates every QR code |
| `ALKAO_STRIPE_ONBOARDING_REFRESH_URL` / `_RETURN_URL` | — | HTTPS pages (TAKATAK dashboard) where Stripe sends a Client admin during and after onboarding |
| `ALKAO_PUBLIC_URL` | — | Public HTTPS origin of ALKAO: buyers' `/billets` links (email worker) and the hosted shop's Stripe return pages (server) |
| `RESEND_API_KEY` / `ALKAO_EMAIL_FROM` | — | Email worker: Resend API key and the verified sender address (the Brand name is the display name) |
| `ALKAO_EMAIL_MAX_AGE_HOURS` | `72` | Emails queued longer ago are skipped, never sent late |
| `ALKAO_METRICS_TOKEN` | — | Bearer token (≥ 32 chars) for `GET /metrics`: platform-wide health counts in the Prometheus text format (Run 24). Without it, `/metrics` answers `404`. Alerts in [ALKAO_RUNBOOK.md](ALKAO_RUNBOOK.md) |

Stripe webhook events to send to `/v1/webhooks/stripe` (Connect endpoint, events on connected
accounts): `checkout.session.completed`, `checkout.session.expired`,
`checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`,
`account.updated`, and since Run 19 `charge.dispute.created`, `charge.dispute.updated`,
`charge.dispute.closed`, `charge.dispute.funds_withdrawn`, `charge.dispute.funds_reinstated`
and `charge.refunded`.
