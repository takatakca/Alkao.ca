import { toApi, writeAudit } from "../db/catalog.js";
import type { TenantScope } from "../db/commerce.js";
import type { Db, Tx } from "../db/pool.js";
import { DomainError } from "../domain/errors.js";

type Queryable = Db | Tx;

/** Delivery state of an order's ticket emails, for staff. Never the link or its token. */
export async function listOrderEmails(q: Queryable, s: TenantScope, orderId: string) {
  const { rows } = await q.query(
    `SELECT id, kind, status, attempts, last_error, sent_at, next_attempt_at, created_at
     FROM public.ticketing_email_outbox WHERE order_id = $1 AND client_id = $2 AND brand_id = $3 ORDER BY created_at, id`,
    [orderId, s.clientId, s.brandId],
  );
  return rows.map(toApi);
}

const RESEND_LIMIT = 50;

/**
 * Queue the order's tickets email again (same personal link). Creates the row for an order
 * paid before email existed. Only orders with a valid ticket.
 */
export async function requestTicketsEmail(tx: Tx, s: TenantScope, orderId: string, actor: { type: "user"; id: string | null }) {
  const { rows } = await tx.query<{ event_id: string; status: string; exchange_of_order_id: string | null; valid: number }>(
    `SELECT o.event_id, o.status, o.exchange_of_order_id,
            (SELECT count(*)::int FROM public.ticketing_tickets t
              WHERE t.order_id = o.id AND t.client_id = o.client_id AND t.brand_id = o.brand_id AND t.status = 'valid') AS valid
     FROM public.ticketing_orders o WHERE o.id = $1 AND o.client_id = $2 AND o.brand_id = $3 FOR UPDATE`,
    [orderId, s.clientId, s.brandId],
  );
  const order = rows[0];
  if (!order) throw new DomainError("order_not_found");
  if (!["paid", "partially_refunded"].includes(order.status) || order.valid === 0) throw new DomainError("order_has_no_valid_ticket");
  const kind = order.exchange_of_order_id ? "exchange_tickets" : "order_tickets";
  const { rows: queued } = await tx.query<{ id: string; attempts: number }>(
    `INSERT INTO public.ticketing_email_outbox (client_id, brand_id, event_id, order_id, kind)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (order_id, kind) DO UPDATE SET status = 'pending', next_attempt_at = now(), sent_at = NULL, last_error = NULL
     WHERE ticketing_email_outbox.attempts < ${RESEND_LIMIT}
     RETURNING id, attempts`,
    [s.clientId, s.brandId, order.event_id, orderId, kind],
  );
  if (!queued[0]) throw new DomainError("email_resend_limit");
  await writeAudit(tx, s, actor, "order.tickets_email_requested", { type: "order", id: orderId }, { kind });
  return toApi(queued[0]);
}

/** What the buyer's ticket page shows besides the order itself. */
export async function publicOrderContext(q: Queryable, s: TenantScope, orderId: string) {
  const { rows } = await q.query(
    `SELECT br.name AS brand_name, e.id AS event_id, e.title AS event_title, se.starts_at, se.ends_at,
            v.name AS venue_name, v.address_line1, v.city, v.timezone, o.exchange_of_order_id,
            (o.exchange_of_order_id IS NULL
              AND o.status IN ('paid', 'partially_refunded')
              AND NOT EXISTS (SELECT 1 FROM public.ticketing_orders x WHERE x.exchange_of_order_id = o.id)
              AND EXISTS (SELECT 1 FROM public.ticketing_order_lines l
                          JOIN public.ticketing_ticket_types t ON t.id = l.ticket_type_id AND t.client_id = l.client_id AND t.brand_id = l.brand_id
                          WHERE l.order_id = o.id AND l.kind = 'add_on' AND t.grants_session_change)) AS can_change_session,
            (SELECT x.id FROM public.ticketing_orders x WHERE x.exchange_of_order_id = o.id) AS exchanged_to_order_id
     FROM public.ticketing_orders o
     JOIN public.ticketing_brands br ON br.id = o.brand_id AND br.client_id = o.client_id
     JOIN public.ticketing_events e ON e.id = o.event_id AND e.client_id = o.client_id AND e.brand_id = o.brand_id
     JOIN public.ticketing_sessions se ON se.id = o.session_id AND se.client_id = o.client_id AND se.brand_id = o.brand_id
     JOIN public.ticketing_venues v ON v.id = e.venue_id AND v.client_id = e.client_id AND v.brand_id = e.brand_id
     WHERE o.id = $1 AND o.client_id = $2 AND o.brand_id = $3`,
    [orderId, s.clientId, s.brandId],
  );
  const r = rows[0];
  if (!r) throw new DomainError("order_not_found");
  return {
    brand: { name: r.brand_name },
    event: {
      id: r.event_id,
      title: r.event_title,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      venue: { name: r.venue_name, addressLine1: r.address_line1, city: r.city, timezone: r.timezone },
    },
    exchangeOfOrderId: r.exchange_of_order_id,
    exchanged: Boolean(r.exchanged_to_order_id),
    canChangeSession: Boolean(r.can_change_session),
  };
}
