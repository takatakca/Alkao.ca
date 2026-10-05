# ALKAO — Product decisions

The owner asked ALKAO's builder to make the open product decisions (2026-10-05). Each one
is below with what it changes and how to reverse it. Nothing here changes TAKATAK or another
business's systems.

## 1. Chargebacks (Run 34)

**Decision.** A dispute the buyer **wins** cancels the order's tickets nobody has used yet.
While the dispute is open, nothing changes. If the Client wins, nothing changes.

- **Why:** once the bank has taken the money back, a valid ticket would be a free entry.
  While the dispute is open, the entry times at the gate are the Client's best evidence, so
  tickets stay valid.
- **Details:**
  - A ticket already used stays as it is.
  - The seats of cancelled tickets go back on sale.
  - The buyer is not emailed.
  - A dispute for only part of the order cancels nothing by itself. The order shows in
    "À traiter" so staff choose which tickets to cancel.
- **The TAKATAK commission** is not changed by a dispute. Stripe handles the application fee
  of a disputed charge on its own.
- **To reverse:** remove the `voidAfterLostDispute` call in
  `src/payments/service.ts`. Disputes are then only recorded and shown, as before Run 34.

## 2. Promo codes (Run 36)

**Decision.** Yes.

- **Scope:** one event per code, entered at checkout, one code per order.
- **Discount:** a percentage (1–100 %) or a fixed amount off the order's pre-tax subtotal.
- **Limits, all optional:** a number of uses, a start and an end date, and an on/off switch.
- **Taxes and commission:** TPS and TVQ are computed on the discounted subtotal, and so is
  the TAKATAK commission rate. The fixed commission per paid ticket still applies. An order
  made free by a code is a free order, with no commission.
- **Uses:** counted by the database when an order is created with the code, and given back if
  that order expires unpaid. A refund does not give the use back.
- **To stop using codes:** switch them off on the event page. Orders already made keep their
  discount.

## 3. Door sales (Run 35)

**Decision.** Yes, **by card only, through Stripe**, on the staff member's phone or tablet.

- **Commission:** TAKATAK's commission applies exactly as online, because the payment takes
  the same path.
- **No cash in V1.** A cash sale would bypass Stripe, so the commission could not be
  collected automatically.
- **Mode:** a door sale only offers sessions starting today, and the tickets show on screen
  right after payment.

## 4. FESTI-ICE "billet ouvert" (Run 37)

**Decision.** The buyer picks a date, which reserves a seat. The date can be changed for free
as often as needed, to any session of the season that still has room, as long as the ticket
has not entered.

- **Why:** a seat is always reserved, so the gate can never be over capacity on a busy
  night, and the buyer keeps the "any date" freedom.
