import type { TenantScope } from "./commerce.js";
import type { Db, Tx } from "./pool.js";

type Queryable = Db | Tx;

export interface OrderOption {
  /** Run 56: so the tickets page can check each session's stock before a change. */
  ticketTypeId: string;
  name: string;
  quantity: number;
  /** Run 59: a session-change right (Flex Météo), nothing to receive on site. Absent otherwise. */
  sessionChange?: true;
}

/**
 * Run 55: the options (add-ons: a meal, an activity…) bought with an order, which have no QR
 * code of their own. A session change makes a new order with the admissions only, pointing to
 * the original order (src/ops/exchange.ts), so the options are read from the order and the
 * original it points to.
 *
 * Run 57: `handOver` keeps only what staff hand over on site, leaving out a session-change
 * right (Flex Météo), which is a promise, not an item.
 */
export async function orderOptions(q: Queryable, s: TenantScope, orderId: string, { handOver = false } = {}): Promise<OrderOption[]> {
  const { rows } = await q.query<{ ticket_type_id: string; name: string; quantity: number; session_change: boolean }>(
    `SELECT l.ticket_type_id, l.name_snapshot AS name, l.quantity, t.grants_session_change AS session_change
     FROM public.ticketing_orders o
     JOIN public.ticketing_order_lines l ON l.order_id IN (o.id, o.exchange_of_order_id) AND l.client_id = o.client_id AND l.brand_id = o.brand_id
     JOIN public.ticketing_ticket_types t ON t.id = l.ticket_type_id AND t.client_id = l.client_id AND t.brand_id = l.brand_id
     WHERE o.id = $1 AND o.client_id = $2 AND o.brand_id = $3 AND l.kind = 'add_on' AND l.quantity > 0
       AND NOT ($4 AND t.grants_session_change)
     ORDER BY l.created_at, l.id`,
    [orderId, s.clientId, s.brandId, handOver],
  );
  return rows.map((r) => ({ ticketTypeId: r.ticket_type_id, name: r.name, quantity: Number(r.quantity), ...(r.session_change ? { sessionChange: true as const } : {}) }));
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
  const items = await orderOptions(q, s, row.order_id, { handOver: true });
  return items.length ? { items, already: row.already } : undefined;
}

export interface SessionOption {
  ticketTypeId: string;
  name: string;
  /** Bought with the orders whose valid tickets are for this session. */
  sold: number;
  /** Of those, the ones whose order already had a ticket let in (handed over at the gate). */
  handedOver: number;
}

/**
 * Run 57: what to prepare for a session (meals, inflatables wristbands…) and how much was
 * already handed over at the gate. Counts the orders with valid tickets for the session (after
 * a session change, the new session's), with the options of the original order. Leaves out
 * session-change rights. Read from the session's tickets (ticketing_tickets_session_idx).
 */
export async function sessionOptions(q: Queryable, s: TenantScope, sessionId: string): Promise<SessionOption[]> {
  const { rows } = await q.query<{ ticket_type_id: string; name: string; sold: number; handed_over: number }>(
    `WITH here AS (
       SELECT DISTINCT k.order_id FROM public.ticketing_tickets k
       WHERE k.session_id = $1 AND k.client_id = $2 AND k.brand_id = $3 AND k.status = 'valid'
     ), purchases AS (
       SELECT o.id, o.exchange_of_order_id, EXISTS (
         SELECT 1 FROM public.ticketing_tickets x
         JOIN public.ticketing_scans sc ON sc.ticket_id = x.id AND sc.result = 'admitted' AND sc.client_id = x.client_id AND sc.brand_id = x.brand_id
         WHERE x.order_id = o.id AND x.client_id = o.client_id AND x.brand_id = o.brand_id
       ) AS entered
       FROM here h JOIN public.ticketing_orders o ON o.id = h.order_id AND o.client_id = $2 AND o.brand_id = $3
     )
     SELECT t.id AS ticket_type_id, t.name, sum(l.quantity)::int AS sold,
            coalesce(sum(l.quantity) FILTER (WHERE p.entered), 0)::int AS handed_over
     FROM purchases p
     JOIN public.ticketing_order_lines l ON l.order_id IN (p.id, p.exchange_of_order_id) AND l.client_id = $2 AND l.brand_id = $3
       AND l.kind = 'add_on' AND l.quantity > 0
     JOIN public.ticketing_ticket_types t ON t.id = l.ticket_type_id AND t.client_id = l.client_id AND t.brand_id = l.brand_id
     WHERE NOT t.grants_session_change
     GROUP BY t.id, t.name, t.sort_order
     ORDER BY t.sort_order, t.name`,
    [sessionId, s.clientId, s.brandId],
  );
  return rows.map((r) => ({ ticketTypeId: r.ticket_type_id, name: r.name, sold: r.sold, handedOver: r.handed_over }));
}

/**
 * Run 58: for the offline gate, the options to hand over of each order with valid tickets for
 * the session, and whether the order already had a ticket let in. By order id; orders without
 * options are left out. Names and quantities only, nothing about the buyer.
 */
export async function sessionPurchases(q: Queryable, s: TenantScope, sessionId: string): Promise<Map<string, { items: { name: string; quantity: number }[]; entered: boolean }>> {
  const { rows } = await q.query<{ order_id: string; name: string; quantity: number; entered: boolean }>(
    `WITH here AS (
       SELECT DISTINCT k.order_id FROM public.ticketing_tickets k
       WHERE k.session_id = $1 AND k.client_id = $2 AND k.brand_id = $3 AND k.status = 'valid'
     ), purchases AS (
       SELECT o.id, o.exchange_of_order_id, EXISTS (
         SELECT 1 FROM public.ticketing_tickets x
         JOIN public.ticketing_scans sc ON sc.ticket_id = x.id AND sc.result = 'admitted' AND sc.client_id = x.client_id AND sc.brand_id = x.brand_id
         WHERE x.order_id = o.id AND x.client_id = o.client_id AND x.brand_id = o.brand_id
       ) AS entered
       FROM here h JOIN public.ticketing_orders o ON o.id = h.order_id AND o.client_id = $2 AND o.brand_id = $3
     )
     SELECT p.id AS order_id, l.name_snapshot AS name, l.quantity, p.entered
     FROM purchases p
     JOIN public.ticketing_order_lines l ON l.order_id IN (p.id, p.exchange_of_order_id) AND l.client_id = $2 AND l.brand_id = $3
       AND l.kind = 'add_on' AND l.quantity > 0
     JOIN public.ticketing_ticket_types t ON t.id = l.ticket_type_id AND t.client_id = l.client_id AND t.brand_id = l.brand_id
     WHERE NOT t.grants_session_change
     ORDER BY p.id, l.created_at, l.id`,
    [sessionId, s.clientId, s.brandId],
  );
  const out = new Map<string, { items: { name: string; quantity: number }[]; entered: boolean }>();
  for (const r of rows) {
    const p = out.get(r.order_id) ?? { items: [], entered: r.entered };
    p.items.push({ name: r.name, quantity: Number(r.quantity) });
    out.set(r.order_id, p);
  }
  return out;
}
