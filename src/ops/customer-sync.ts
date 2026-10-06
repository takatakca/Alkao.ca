import { importRows, type ImportRow } from "../db/customers.js";
import { withTransaction, type Db } from "../db/pool.js";
import { localDate } from "../domain/customers.js";

/**
 * Run 43: every ALKAO ticket buyer joins the Brand's customer file. A paid order becomes a
 * booking (source "alkao_order", category "ticket", reference: the order id) on the
 * customer found by the Run 41 rules (same e-mail or phone and the same name), or a new
 * one. Its date follows the session the tickets are for now (after a session change), a
 * full refund or a cancelled session cancels it, and the purchase gives the implied consent
 * of Canada's anti-spam law from the day it was paid.
 *
 * Safe to run as often as wanted: only orders new or changed since their booking are read.
 * Anonymized buyers are never taken (and Run 20's anonymization also clears their customer).
 */
const SOURCE = "alkao_order";

interface OrderRow {
  id: string;
  client_id: string;
  brand_id: string;
  status: string;
  paid_at: Date;
  updated_at: Date;
  total_cents: number;
  refunded_cents: number;
  email: string;
  full_name: string | null;
  phone: string | null;
  event_title: string;
  timezone: string;
  starts_at: Date;
  ends_at: Date | null;
  session_status: string;
  session_updated_at: Date;
  admissions: number;
  checked_in: boolean;
}

function rowOf(o: OrderRow): ImportRow {
  const day = (at: Date) => localDate(at, o.timezone);
  const [first, ...rest] = (o.full_name ?? "").trim().split(/\s+/).filter(Boolean);
  const startsOn = day(o.starts_at);
  const endsOn = o.ends_at ? day(o.ends_at) : startsOn;
  const cancelledOn = o.session_status === "cancelled" ? day(o.session_updated_at) : o.status === "refunded" ? day(o.updated_at) : null;
  return {
    sourceRef: o.id, category: "ticket", item: o.event_title.slice(0, 80), startsOn, endsOn: endsOn < startsOn ? startsOn : endsOn,
    adults: Math.min(o.admissions, 500), checkedIn: o.checked_in, totalCents: Math.max(o.total_cents - o.refunded_cents, 0),
    firstName: first ?? null, lastName: rest.length ? rest.join(" ") : null, email: o.email, mobilePhone: o.phone,
    bookedOn: day(o.paid_at), cancelledOn,
  };
}

export async function syncTicketBuyers(db: Db, now = new Date(), limit = 500): Promise<number> {
  // Money orders (session changes hang off them), new or changed since their booking.
  const { rows: due } = await db.query<{ id: string }>(
    `SELECT o.id FROM public.ticketing_orders o
     LEFT JOIN public.ticketing_customer_bookings b
       ON b.client_id = o.client_id AND b.brand_id = o.brand_id AND b.source = '${SOURCE}' AND b.source_ref = o.id::text
     WHERE o.exchange_of_order_id IS NULL AND o.status IN ('paid', 'partially_refunded', 'refunded')
       AND NOT EXISTS (SELECT 1 FROM public.ticketing_buyer_erasures e WHERE e.buyer_id = o.buyer_id)
       AND (b.id IS NULL OR o.updated_at > b.updated_at
         OR EXISTS (SELECT 1 FROM public.ticketing_orders x
                    WHERE x.exchange_of_order_id = o.id AND x.client_id = o.client_id AND x.brand_id = o.brand_id AND x.updated_at > b.updated_at)
         OR EXISTS (SELECT 1 FROM public.ticketing_orders x JOIN public.ticketing_sessions se ON se.id = x.session_id
                    WHERE (x.id = o.id OR x.exchange_of_order_id = o.id) AND x.client_id = o.client_id AND x.brand_id = o.brand_id
                      AND se.status = 'cancelled' AND se.updated_at > b.updated_at))
     ORDER BY o.paid_at, o.id
     LIMIT $1`,
    [limit],
  );
  if (due.length === 0) return 0;
  const { rows } = await db.query<OrderRow>(
    `SELECT o.id, o.client_id, o.brand_id, o.status, o.paid_at, o.updated_at, o.total_cents, o.refunded_cents,
            bu.email, bu.full_name, bu.phone, e.title AS event_title, v.timezone,
            cur.starts_at, cur.ends_at, cur.status AS session_status, cur.updated_at AS session_updated_at,
            (SELECT coalesce(sum(l.quantity), 0)::int FROM public.ticketing_order_lines l
              WHERE l.order_id = o.id AND l.client_id = o.client_id AND l.brand_id = o.brand_id AND l.kind = 'admission') AS admissions,
            EXISTS (SELECT 1 FROM public.ticketing_scans sc
                    JOIN public.ticketing_tickets k ON k.id = sc.ticket_id AND k.client_id = sc.client_id
                    JOIN public.ticketing_orders x ON x.id = k.order_id AND x.client_id = k.client_id
                    WHERE (x.id = o.id OR x.exchange_of_order_id = o.id) AND x.client_id = o.client_id AND sc.result = 'admitted') AS checked_in
     FROM public.ticketing_orders o
     JOIN public.ticketing_buyers bu ON bu.id = o.buyer_id AND bu.client_id = o.client_id AND bu.brand_id = o.brand_id
     JOIN public.ticketing_events e ON e.id = o.event_id AND e.client_id = o.client_id AND e.brand_id = o.brand_id
     JOIN public.ticketing_venues v ON v.id = e.venue_id AND v.client_id = e.client_id AND v.brand_id = e.brand_id
     JOIN LATERAL (
       SELECT se.starts_at, se.ends_at, se.status, se.updated_at FROM public.ticketing_orders x
       JOIN public.ticketing_sessions se ON se.id = x.session_id AND se.client_id = x.client_id AND se.brand_id = x.brand_id
       WHERE (x.id = o.id OR x.exchange_of_order_id = o.id) AND x.client_id = o.client_id AND x.brand_id = o.brand_id
       ORDER BY (x.id = o.id), x.created_at DESC LIMIT 1
     ) cur ON true
     WHERE o.id = ANY($1::uuid[])`,
    [due.map((d) => d.id)],
  );
  const byTenant = new Map<string, OrderRow[]>();
  for (const r of rows) {
    const key = `${r.client_id}/${r.brand_id}`;
    byTenant.set(key, [...(byTenant.get(key) ?? []), r]);
  }
  for (const orders of byTenant.values()) {
    const scope = { clientId: orders[0]!.client_id, brandId: orders[0]!.brand_id };
    await withTransaction(db, (tx) =>
      importRows(tx, scope, { source: SOURCE, reportDate: localDate(now), rows: orders.map(rowOf) }, { type: "system", id: null }));
  }
  return rows.length;
}
