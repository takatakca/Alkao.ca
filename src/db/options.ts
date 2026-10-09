import type { TenantScope } from "./commerce.js";
import type { Db, Tx } from "./pool.js";

type Queryable = Db | Tx;

export interface OrderOption {
  /** Run 56: so the tickets page can check each session's stock before a change. */
  ticketTypeId: string;
  name: string;
  quantity: number;
}

/**
 * Run 55: the options (add-ons: a meal, an activity…) bought with an order, which have no QR
 * code of their own. A session change makes a new order with the admissions only, pointing to
 * the original order (src/ops/exchange.ts), so the options are read from the order and the
 * original it points to.
 */
export async function orderOptions(q: Queryable, s: TenantScope, orderId: string): Promise<OrderOption[]> {
  const { rows } = await q.query<{ ticket_type_id: string; name: string; quantity: number }>(
    `SELECT l.ticket_type_id, l.name_snapshot AS name, l.quantity
     FROM public.ticketing_orders o
     JOIN public.ticketing_order_lines l ON l.order_id IN (o.id, o.exchange_of_order_id) AND l.client_id = o.client_id AND l.brand_id = o.brand_id
     WHERE o.id = $1 AND o.client_id = $2 AND o.brand_id = $3 AND l.kind = 'add_on' AND l.quantity > 0
     ORDER BY l.created_at, l.id`,
    [orderId, s.clientId, s.brandId],
  );
  return rows.map((r) => ({ ticketTypeId: r.ticket_type_id, name: r.name, quantity: Number(r.quantity) }));
}

/**
 * The options to hand over when this ticket is let in, and whether another ticket of the same
 * purchase (this order or the original it points to) was let in first, so they were handed over then.
 */
export async function optionsAtAdmission(q: Queryable, s: TenantScope, ticketId: string): Promise<{ items: OrderOption[]; already: boolean } | undefined> {
  const { rows } = await q.query<{ order_id: string; already: boolean }>(
    // From the purchase's tickets (by order) to their one admission each (ticketing_scans_one_admission).
    `SELECT k.order_id, EXISTS (
       SELECT 1 FROM public.ticketing_tickets x
       JOIN public.ticketing_scans sc ON sc.ticket_id = x.id AND sc.result = 'admitted' AND sc.client_id = x.client_id AND sc.brand_id = x.brand_id
       WHERE x.order_id IN (o.id, o.exchange_of_order_id) AND x.id <> k.id AND x.client_id = k.client_id AND x.brand_id = k.brand_id
     ) AS already
     FROM public.ticketing_tickets k
     JOIN public.ticketing_orders o ON o.id = k.order_id AND o.client_id = k.client_id AND o.brand_id = k.brand_id
     WHERE k.id = $1 AND k.client_id = $2 AND k.brand_id = $3`,
    [ticketId, s.clientId, s.brandId],
  );
  const row = rows[0];
  if (!row) return undefined;
  const items = await orderOptions(q, s, row.order_id);
  return items.length ? { items, already: row.already } : undefined;
}
