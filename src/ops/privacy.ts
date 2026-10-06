import type { TenantScope } from "../db/commerce.js";
import { writeAudit } from "../db/catalog.js";
import { withTransaction, type Db, type Tx } from "../db/pool.js";
import { CLOSED_DISPUTE_STATUSES } from "../db/payments.js";
import { DomainError } from "../domain/errors.js";

/**
 * Run 20: a buyer's personal data on request (Québec Law 25), for the Client that sold the
 * tickets. Both actions start from one of the buyer's orders and cover all of that buyer's
 * orders for the Brand.
 *
 * Personal data in ALKAO lives on the buyer row only (email, name, phone, language). Orders,
 * amounts, taxes, tickets and gate scans hold no personal data and stay as they are.
 * Outside ALKAO, the email also sits with the Client's Stripe account (the checkout) and
 * with the email provider's logs; those are the Client's to handle.
 */

/** Addresses given to anonymized buyers; ".invalid" can never receive mail (RFC 2606). */
export const ANONYMIZED_DOMAIN = "anonyme.invalid";

async function buyerOfOrder(q: Db | Tx, s: TenantScope, orderId: string, lock = false) {
  const { rows } = await q.query<{ id: string; email: string; full_name: string | null; phone: string | null; language: string; created_at: Date; erased_at: Date | null }>(
    `SELECT b.id, b.email, b.full_name, b.phone, b.language, b.created_at, e.erased_at
     FROM public.ticketing_orders o
     JOIN public.ticketing_buyers b ON b.id = o.buyer_id AND b.client_id = o.client_id AND b.brand_id = o.brand_id
     LEFT JOIN public.ticketing_buyer_erasures e ON e.buyer_id = b.id
     WHERE o.id = $1 AND o.client_id = $2 AND o.brand_id = $3${lock ? " FOR UPDATE OF b" : ""}`,
    [orderId, s.clientId, s.brandId],
  );
  if (!rows[0]) throw new DomainError("order_not_found");
  return rows[0];
}

/** Everything ALKAO holds about the buyer, for the Brand, as one JSON document. */
export async function exportBuyerData(db: Db, s: TenantScope, orderId: string, now = new Date()) {
  const buyer = await buyerOfOrder(db, s, orderId);
  const params = [buyer.id, s.clientId, s.brandId];
  const [brand, orders, tickets, refunds, emails] = await Promise.all([
    db.query(`SELECT name FROM public.ticketing_brands WHERE id = $1`, [s.brandId]),
    db.query(
      `SELECT o.id, o.reference, o.status, o.currency, o.subtotal_cents, o.tax_cents, o.total_cents, o.refunded_cents,
              o.created_at, o.paid_at, o.exchange_of_order_id, e.title AS event_title, se.starts_at AS session_starts_at,
              v.name AS venue_name, v.city AS venue_city
       FROM public.ticketing_orders o
       JOIN public.ticketing_events e ON e.id = o.event_id AND e.client_id = o.client_id AND e.brand_id = o.brand_id
       JOIN public.ticketing_sessions se ON se.id = o.session_id AND se.client_id = o.client_id AND se.brand_id = o.brand_id
       JOIN public.ticketing_venues v ON v.id = e.venue_id AND v.client_id = e.client_id AND v.brand_id = e.brand_id
       WHERE o.buyer_id = $1 AND o.client_id = $2 AND o.brand_id = $3
       ORDER BY o.created_at`,
      params,
    ),
    db.query(
      `SELECT k.order_id, k.id, tt.name AS ticket_type, k.status, k.void_reason,
              (SELECT sc.scanned_at FROM public.ticketing_scans sc WHERE sc.ticket_id = k.id AND sc.result = 'admitted') AS admitted_at
       FROM public.ticketing_tickets k
       JOIN public.ticketing_orders o ON o.id = k.order_id AND o.client_id = k.client_id AND o.brand_id = k.brand_id
       JOIN public.ticketing_ticket_types tt ON tt.id = k.ticket_type_id AND tt.client_id = k.client_id AND tt.brand_id = k.brand_id
       WHERE o.buyer_id = $1 AND o.client_id = $2 AND o.brand_id = $3
       ORDER BY k.created_at, k.id`,
      params,
    ),
    db.query(
      `SELECT r.order_id, r.amount_cents, r.status, r.reason, r.created_at, r.completed_at
       FROM public.ticketing_refunds r
       JOIN public.ticketing_orders o ON o.id = r.order_id AND o.client_id = r.client_id AND o.brand_id = r.brand_id
       WHERE o.buyer_id = $1 AND o.client_id = $2 AND o.brand_id = $3
       ORDER BY r.created_at`,
      params,
    ),
    db.query(
      `SELECT x.order_id, x.kind, x.status, x.sent_at
       FROM public.ticketing_email_outbox x
       JOIN public.ticketing_orders o ON o.id = x.order_id AND o.client_id = x.client_id AND o.brand_id = x.brand_id
       WHERE o.buyer_id = $1 AND o.client_id = $2 AND o.brand_id = $3
       ORDER BY x.created_at, x.id`,
      params,
    ),
  ]);
  const of = <T extends { order_id: string }>(rows: T[], orderId: string) => rows.filter((r) => r.order_id === orderId);
  return {
    format: "alkao.buyer-export.v1",
    exportedAt: now.toISOString(),
    seller: brand.rows[0]?.name ?? null,
    buyer: {
      email: buyer.email,
      fullName: buyer.full_name,
      phone: buyer.phone,
      language: buyer.language,
      firstPurchaseAt: buyer.created_at,
      anonymizedAt: buyer.erased_at,
    },
    orders: orders.rows.map((o) => ({
      reference: o.reference,
      status: o.status,
      event: o.event_title,
      sessionStartsAt: o.session_starts_at,
      venue: o.venue_city ? `${o.venue_name}, ${o.venue_city}` : o.venue_name,
      createdAt: o.created_at,
      paidAt: o.paid_at,
      currency: o.currency,
      subtotalCents: o.subtotal_cents,
      taxCents: o.tax_cents,
      totalCents: o.total_cents,
      refundedCents: o.refunded_cents,
      sessionChange: o.exchange_of_order_id !== null,
      tickets: of(tickets.rows, o.id).map((k) => ({ id: k.id, type: k.ticket_type, status: k.status, voidReason: k.void_reason, enteredAt: k.admitted_at })),
      refunds: of(refunds.rows, o.id).map((r) => ({ amountCents: r.amount_cents, status: r.status, reason: r.reason, createdAt: r.created_at, completedAt: r.completed_at })),
      emails: of(emails.rows, o.id).map((e) => ({ kind: e.kind, status: e.status, sentAt: e.sent_at })),
    })),
  };
}

/**
 * Anonymize the buyer: email, name and phone are replaced, staff notes on their refunds are
 * cleared, queued emails are dropped and the personal ticket links stop working. Refused
 * while the buyer still holds a valid ticket for a session that has not ended, while a
 * refund is in progress, or while a Stripe dispute is open: those still need the buyer.
 * Asking again for an anonymized buyer changes nothing.
 */
export async function anonymizeBuyer(db: Db, s: TenantScope, orderId: string, actor: { type: "user"; id: string | null }, now = new Date()) {
  return withTransaction(db, async (tx) => {
    const buyer = await buyerOfOrder(tx, s, orderId, true);
    if (buyer.erased_at) return { anonymizedAt: buyer.erased_at, alreadyAnonymized: true };
    const params = [buyer.id, s.clientId, s.brandId];
    const { rows: blockers } = await tx.query<{ upcoming: boolean; refunding: boolean; disputed: boolean }>(
      `SELECT
         EXISTS (SELECT 1 FROM public.ticketing_tickets k
                 JOIN public.ticketing_orders o ON o.id = k.order_id AND o.client_id = k.client_id AND o.brand_id = k.brand_id
                 JOIN public.ticketing_sessions se ON se.id = k.session_id AND se.client_id = k.client_id AND se.brand_id = k.brand_id
                 WHERE o.buyer_id = $1 AND o.client_id = $2 AND o.brand_id = $3 AND k.status = 'valid'
                   AND coalesce(se.ends_at, se.starts_at) > $4) AS upcoming,
         EXISTS (SELECT 1 FROM public.ticketing_refunds r
                 JOIN public.ticketing_orders o ON o.id = r.order_id AND o.client_id = r.client_id AND o.brand_id = r.brand_id
                 WHERE o.buyer_id = $1 AND o.client_id = $2 AND o.brand_id = $3 AND r.status = 'pending') AS refunding,
         EXISTS (SELECT 1 FROM public.ticketing_payment_disputes d
                 JOIN public.ticketing_orders o ON o.id = d.order_id AND o.client_id = d.client_id AND o.brand_id = d.brand_id
                 WHERE o.buyer_id = $1 AND o.client_id = $2 AND o.brand_id = $3 AND NOT (d.status = ANY($5::text[]))) AS disputed`,
      [...params, now, CLOSED_DISPUTE_STATUSES],
    );
    if (blockers[0]!.upcoming) throw new DomainError("buyer_has_upcoming_tickets");
    if (blockers[0]!.refunding) throw new DomainError("refund_in_progress");
    if (blockers[0]!.disputed) throw new DomainError("dispute_open");

    await tx.query(
      `UPDATE public.ticketing_buyers SET email = 'anonyme-' || id || '@' || $4, full_name = NULL, phone = NULL
       WHERE id = $1 AND client_id = $2 AND brand_id = $3`,
      [...params, ANONYMIZED_DOMAIN],
    );
    const buyerOrders = `SELECT id FROM public.ticketing_orders WHERE buyer_id = $1 AND client_id = $2 AND brand_id = $3`;
    await tx.query(`UPDATE public.ticketing_refunds SET reason = NULL WHERE reason IS NOT NULL AND order_id IN (${buyerOrders})`, params);
    const dropped = await tx.query(
      `UPDATE public.ticketing_email_outbox SET status = 'skipped', last_error = 'buyer_anonymized'
       WHERE status = 'pending' AND order_id IN (${buyerOrders})`,
      params,
    );
    await tx.query(`DELETE FROM public.ticketing_access_tokens WHERE subject_type = 'order' AND subject_id IN (${buyerOrders})`, params);
    const { rows } = await tx.query<{ erased_at: Date }>(
      `INSERT INTO public.ticketing_buyer_erasures (buyer_id, client_id, brand_id, requested_by, erased_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING erased_at`,
      [...params, actor.id ?? "unknown", now],
    );
    const { rows: count } = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${buyerOrders}) x`, params);
    // Run 43: the customer file entry built from these orders is cleared too (bookings stay).
    const customers = await tx.query(
      `UPDATE public.ticketing_customers SET first_name = NULL, last_name = NULL, email = NULL, mobile_phone = NULL, home_phone = NULL,
         work_phone = NULL, address_line = NULL, address_unit = NULL, postal_code = NULL, companion_name = NULL,
         email_consent_at = NULL, anonymized_at = $4
       WHERE client_id = $2 AND brand_id = $3 AND anonymized_at IS NULL AND id IN (
         SELECT b.customer_id FROM public.ticketing_customer_bookings b
         WHERE b.client_id = $2 AND b.brand_id = $3 AND b.source = 'alkao_order' AND b.source_ref IN (SELECT id::text FROM (${buyerOrders}) o))`,
      [...params, now],
    );
    // The audit entry names the buyer row only, never what it held.
    await writeAudit(tx, s, actor, "buyer.anonymized", { type: "buyer", id: buyer.id }, { orders: count[0]!.n, emailsDropped: dropped.rowCount ?? 0, customersAnonymized: customers.rowCount ?? 0 });
    return { anonymizedAt: rows[0]!.erased_at, alreadyAnonymized: false };
  });
}

/** When the buyer of this order was anonymized, if they were. */
export async function buyerAnonymizedAt(db: Db, s: TenantScope, orderId: string): Promise<Date | null> {
  const { rows } = await db.query<{ erased_at: Date }>(
    `SELECT e.erased_at FROM public.ticketing_orders o JOIN public.ticketing_buyer_erasures e ON e.buyer_id = o.buyer_id
     WHERE o.id = $1 AND o.client_id = $2 AND o.brand_id = $3`,
    [orderId, s.clientId, s.brandId],
  );
  return rows[0]?.erased_at ?? null;
}
