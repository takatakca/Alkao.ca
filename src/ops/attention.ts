import { toApi, writeAudit } from "../db/catalog.js";
import type { TenantScope } from "../db/commerce.js";
import { listDisputes } from "../db/payments.js";
import { withTransaction, type Db } from "../db/pool.js";
import { DomainError } from "../domain/errors.js";

/**
 * Run 21: everything that waits on the Brand's staff, in one list. Each kind keeps only what
 * someone can still act on, so the list empties as the work gets done.
 */
const LIMIT = 50;
/** A refund still pending after this long is stuck (Stripe failed or never answered). */
const STUCK_REFUND_MINUTES = 15;

export async function attentionList(db: Db, s: TenantScope, now = new Date()) {
  const params = [s.clientId, s.brandId, now];
  const [refunds, emails, disputes, outsideRefunds, cancellations] = await Promise.all([
    // Refunds Stripe has not settled: the buyer is still waiting for the money.
    db.query(
      `SELECT r.id AS refund_id, r.order_id, o.reference, r.amount_cents, r.last_error, r.created_at
       FROM public.ticketing_refunds r
       JOIN public.ticketing_orders o ON o.id = r.order_id AND o.client_id = r.client_id AND o.brand_id = r.brand_id
       WHERE r.client_id = $1 AND r.brand_id = $2 AND r.status = 'pending'
         AND (r.last_error IS NOT NULL OR r.created_at < $3::timestamptz - make_interval(mins => ${STUCK_REFUND_MINUTES}))
       ORDER BY r.created_at LIMIT ${LIMIT}`,
      params,
    ),
    // Emails that never reached the buyer: tickets for a session still to come, or a refund
    // or cancellation notice from the last 30 days.
    db.query(
      `SELECT x.order_id, o.reference, x.kind, x.status, x.last_error, x.updated_at, b.email AS buyer_email
       FROM public.ticketing_email_outbox x
       JOIN public.ticketing_orders o ON o.id = x.order_id AND o.client_id = x.client_id AND o.brand_id = x.brand_id
       JOIN public.ticketing_buyers b ON b.id = o.buyer_id AND b.client_id = o.client_id AND b.brand_id = o.brand_id
       JOIN public.ticketing_sessions se ON se.id = o.session_id AND se.client_id = o.client_id AND se.brand_id = o.brand_id
       WHERE x.client_id = $1 AND x.brand_id = $2
         AND (x.status = 'failed' OR (x.status = 'skipped' AND x.last_error = 'too_old'))
         AND NOT EXISTS (SELECT 1 FROM public.ticketing_buyer_erasures e WHERE e.buyer_id = b.id)
         AND CASE WHEN x.kind IN ('order_tickets', 'exchange_tickets')
                  THEN coalesce(se.ends_at, se.starts_at) > $3 AND o.status IN ('paid', 'partially_refunded')
                  ELSE x.created_at > $3::timestamptz - interval '30 days' END
       ORDER BY x.updated_at DESC LIMIT ${LIMIT}`,
      params,
    ),
    listDisputes(db, s, true, LIMIT),
    // Money refunded in Stripe while the order's tickets can still get someone in.
    db.query(
      `SELECT t.order_id, o.reference, t.refunded_cents - a.alkao AS outside_cents, t.updated_at
       FROM public.ticketing_charge_refund_totals t
       JOIN public.ticketing_orders o ON o.id = t.order_id AND o.client_id = t.client_id AND o.brand_id = t.brand_id
       CROSS JOIN LATERAL (
         SELECT coalesce(sum(r.amount_cents), 0)::int AS alkao FROM public.ticketing_refunds r
         WHERE r.order_id = t.order_id AND r.status IN ('pending', 'succeeded')
       ) a
       WHERE t.client_id = $1 AND t.brand_id = $2 AND t.refunded_cents > a.alkao
         AND EXISTS (SELECT 1 FROM public.ticketing_tickets k
                     JOIN public.ticketing_sessions se ON se.id = k.session_id
                     WHERE (k.order_id = o.id OR k.order_id IN (SELECT id FROM public.ticketing_orders WHERE exchange_of_order_id = o.id))
                       AND k.status = 'valid' AND coalesce(se.ends_at, se.starts_at) > $3)
       ORDER BY t.updated_at DESC LIMIT ${LIMIT}`,
      params,
    ),
    // Cancelled sessions whose buyers could not all be refunded.
    db.query(
      `SELECT c.session_id, c.event_id, se.starts_at, c.status,
              count(*) FILTER (WHERE i.status = 'failed')::int AS failed,
              count(*) FILTER (WHERE i.status = 'pending')::int AS pending
       FROM public.ticketing_session_cancellations c
       JOIN public.ticketing_sessions se ON se.id = c.session_id
       JOIN public.ticketing_session_cancellation_orders i ON i.cancellation_id = c.id
       WHERE c.client_id = $1 AND c.brand_id = $2
       GROUP BY c.session_id, c.event_id, se.starts_at, c.status
       HAVING count(*) FILTER (WHERE i.status = 'failed') > 0
       ORDER BY se.starts_at LIMIT ${LIMIT}`,
      [s.clientId, s.brandId],
    ),
  ]);
  const result = {
    refunds: refunds.rows.map(toApi),
    emails: emails.rows.map(toApi),
    disputes,
    outsideRefunds: outsideRefunds.rows.map(toApi),
    cancellations: cancellations.rows.map(toApi),
  };
  return { ...result, total: Object.values(result).reduce((n, list) => n + list.length, 0) };
}

/**
 * Run 21: cancel some of an order's tickets without refunding them, for example after a
 * Stripe dispute or a refund made directly in Stripe. The seats go back on sale and the QR
 * codes stop working. Tickets already used at the gate stay as they are.
 */
export async function voidTickets(
  db: Db,
  s: TenantScope,
  orderId: string,
  input: { ticketIds: string[]; reason: string | null },
  actor: { type: "user"; id: string | null },
) {
  return withTransaction(db, async (tx) => {
    const { rows: order } = await tx.query(
      `SELECT id FROM public.ticketing_orders WHERE id = $1 AND client_id = $2 AND brand_id = $3 FOR UPDATE`,
      [orderId, s.clientId, s.brandId],
    );
    if (!order[0]) throw new DomainError("order_not_found");
    // The order's tickets, and those of its Flex exchange.
    const { rows: tickets } = await tx.query<{ id: string; status: string; admitted: boolean }>(
      `SELECT k.id, k.status,
              EXISTS (SELECT 1 FROM public.ticketing_scans sc WHERE sc.ticket_id = k.id AND sc.result = 'admitted') AS admitted
       FROM public.ticketing_tickets k
       WHERE k.client_id = $2 AND k.brand_id = $3
         AND (k.order_id = $1 OR k.order_id IN (SELECT id FROM public.ticketing_orders WHERE exchange_of_order_id = $1))
       FOR UPDATE OF k`,
      [orderId, s.clientId, s.brandId],
    );
    const byId = new Map(tickets.map((t) => [t.id, t]));
    const wanted = [...new Set(input.ticketIds)];
    if (wanted.some((id) => byId.get(id)?.status !== "valid")) throw new DomainError("invalid_ticket");
    if (wanted.some((id) => byId.get(id)!.admitted)) throw new DomainError("ticket_already_used");
    await tx.query(
      `UPDATE public.ticketing_tickets SET status = 'void', void_reason = 'admin', voided_at = now() WHERE id = ANY($1::uuid[])`,
      [wanted],
    );
    await writeAudit(tx, s, actor, "tickets.voided", { type: "order", id: orderId }, { ticketIds: wanted, reason: input.reason });
    return { voided: wanted.length };
  });
}
