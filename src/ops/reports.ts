import type { TenantScope } from "../db/commerce.js";
import type { Db } from "../db/pool.js";

/** Orders that took money (refunded ones included: they still show what was refunded). */
const PAID = `o.status IN ('paid', 'partially_refunded', 'refunded')`;

export interface ReportFilter {
  eventId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

function where(f: ReportFilter, first: number) {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    clauses.push(sql.replace("?", `$${first + params.length - 1}`));
  };
  if (f.eventId) add("o.event_id = ?", f.eventId);
  if (f.from) add("o.paid_at >= ?", f.from);
  if (f.to) add("o.paid_at < ?", f.to);
  return { sql: clauses.map((c) => ` AND ${c}`).join(""), params };
}

/**
 * Sales for one Brand: money (gross, taxes, TAKATAK commission, refunds, net to the Client
 * before Stripe processing fees), sessions (capacity, sold, held, admitted) and ticket types.
 */
export async function salesReport(db: Db, s: TenantScope, f: ReportFilter) {
  const w = where(f, 3);
  const base = [s.clientId, s.brandId, ...w.params];
  const [totals, taxes, types, sessions] = await Promise.all([
    db.query(
      `SELECT count(*)::int AS orders,
              coalesce(sum(o.subtotal_cents), 0)::bigint AS "subtotalCents",
              coalesce(sum(o.tax_cents), 0)::bigint AS "taxCents",
              coalesce(sum(o.total_cents), 0)::bigint AS "grossCents",
              coalesce(sum(o.refunded_cents), 0)::bigint AS "refundedCents",
              coalesce(sum(o.commission_cents), 0)::bigint AS "commissionCents",
              coalesce(sum(o.commission_refunded_cents), 0)::bigint AS "commissionRefundedCents"
       FROM public.ticketing_orders o WHERE o.client_id = $1 AND o.brand_id = $2 AND ${PAID}${w.sql}`,
      base,
    ),
    db.query(
      `SELECT t.code, sum(t.amount_cents)::bigint AS "amountCents"
       FROM public.ticketing_order_taxes t JOIN public.ticketing_orders o ON o.id = t.order_id
       WHERE o.client_id = $1 AND o.brand_id = $2 AND ${PAID}${w.sql}
       GROUP BY t.code ORDER BY t.code`,
      base,
    ),
    db.query(
      `SELECT l.code_snapshot AS code, l.kind, sum(l.quantity)::int AS quantity, sum(l.line_total_cents)::bigint AS "revenueCents"
       FROM public.ticketing_order_lines l JOIN public.ticketing_orders o ON o.id = l.order_id
       WHERE o.client_id = $1 AND o.brand_id = $2 AND ${PAID}${w.sql}
       GROUP BY l.code_snapshot, l.kind ORDER BY l.kind, l.code_snapshot`,
      base,
    ),
    db.query(
      `SELECT s.id AS "sessionId", s.event_id AS "eventId", s.starts_at AS "startsAt", s.status, s.capacity,
              s.sold_count AS sold, s.reserved_count AS held,
              GREATEST(s.capacity - s.sold_count - s.reserved_count, 0) AS available,
              (SELECT count(*)::int FROM public.ticketing_scans sc WHERE sc.session_id = s.id AND sc.result = 'admitted') AS admitted
       FROM public.ticketing_sessions s
       WHERE s.client_id = $1 AND s.brand_id = $2 AND ($3::uuid IS NULL OR s.event_id = $3)
       ORDER BY s.starts_at`,
      [s.clientId, s.brandId, f.eventId ?? null],
    ),
  ]);
  const t = totals.rows[0];
  return {
    currency: "CAD",
    filter: { eventId: f.eventId ?? null, from: f.from ?? null, to: f.to ?? null },
    totals: {
      ...t,
      taxes: Object.fromEntries(taxes.rows.map((r) => [r.code, r.amountCents])),
      // What the Client keeps before Stripe's own processing fees.
      netToClientCents: t.grossCents - t.refundedCents - (t.commissionCents - t.commissionRefundedCents),
    },
    ticketTypes: types.rows,
    sessions: sessions.rows,
  };
}

export async function attendeesRows(db: Db, s: TenantScope, sessionId: string) {
  const { rows } = await db.query(
    `SELECT o.reference, k.id AS ticket_id, tt.code, tt.name, b.full_name, b.email, k.status,
            (SELECT sc.scanned_at FROM public.ticketing_scans sc WHERE sc.ticket_id = k.id AND sc.result = 'admitted') AS admitted_at
     FROM public.ticketing_tickets k
     JOIN public.ticketing_orders o ON o.id = k.order_id AND o.client_id = k.client_id AND o.brand_id = k.brand_id
     JOIN public.ticketing_buyers b ON b.id = o.buyer_id AND b.client_id = o.client_id AND b.brand_id = o.brand_id
     JOIN public.ticketing_ticket_types tt ON tt.id = k.ticket_type_id AND tt.client_id = k.client_id AND tt.brand_id = k.brand_id
     WHERE k.session_id = $1 AND k.client_id = $2 AND k.brand_id = $3
     ORDER BY b.full_name NULLS LAST, o.reference, tt.sort_order, k.id`,
    [sessionId, s.clientId, s.brandId],
  );
  return rows.map((r) => [r.reference, r.ticket_id, r.code, r.name, r.full_name, r.email, r.status, r.admitted_at]);
}

export async function ordersRows(db: Db, s: TenantScope, f: ReportFilter) {
  const w = where(f, 3);
  const { rows } = await db.query(
    `SELECT o.reference, o.status, o.paid_at, b.email, o.subtotal_cents, o.tax_cents, o.total_cents,
            o.refunded_cents, o.commission_cents, o.commission_refunded_cents
     FROM public.ticketing_orders o
     JOIN public.ticketing_buyers b ON b.id = o.buyer_id AND b.client_id = o.client_id AND b.brand_id = o.brand_id
     WHERE o.client_id = $1 AND o.brand_id = $2 AND ${PAID}${w.sql}
     ORDER BY o.paid_at, o.reference`,
    [s.clientId, s.brandId, ...w.params],
  );
  return rows.map((r) => [
    r.reference, r.status, r.paid_at, r.email, r.subtotal_cents, r.tax_cents, r.total_cents,
    r.refunded_cents, r.commission_cents, r.commission_refunded_cents,
  ]);
}
