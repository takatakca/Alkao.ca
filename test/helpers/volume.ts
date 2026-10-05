import { withTransaction, type Db } from "../../src/db/pool.js";
import type { TenantFixture } from "./seed.js";

export interface VolumeOptions {
  /** Past sessions (closed, scanned at the gate) and future sessions (on sale). */
  pastSessions: number;
  futureSessions: number;
  ordersPerSession: number;
  /** Share of the past sessions' tickets admitted at the gate (0–1). */
  admittedShare?: number;
  /** Prefix of the generated buyer emails and names, unique per call. */
  tag: string;
  /** First letter of the generated order references, unique per call (default V). */
  referencePrefix?: string;
}

export interface VolumeResult {
  sessionIds: string[];
  pastSessionIds: string[];
  futureSessionIds: string[];
  orders: number;
  tickets: number;
  scans: number;
  /** One generated order to search for: its reference, buyer email and name. */
  sample: { reference: string; email: string; fullName: string };
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A season's worth of sales for one Brand, written set-based but through every ALKAO
 * trigger and constraint (orders start pending, lines check totals, tickets need a paid
 * order and bump sold_count, credentials are issued by trigger). Run 18 uses it to check
 * that the hot queries stay on their indexes at volume.
 */
export async function seedVolume(db: Db, t: TenantFixture, o: VolumeOptions): Promise<VolumeResult> {
  const general = t.types.find((x) => x.code === "GENERAL")!;
  const sessions = o.pastSessions + o.futureSessions;
  const capacity = o.ordersPerSession * 4;
  const scannerUser = "00000000-0000-4000-8000-00000000a1c0";

  const { rows: created } = await db.query<{ id: string; past: boolean }>(
    `INSERT INTO public.ticketing_sessions (client_id, brand_id, event_id, starts_at, capacity, status)
     SELECT $1, $2, $3,
            CASE WHEN g <= $5 THEN now() - make_interval(days => g) ELSE now() + make_interval(days => g) END,
            $4, CASE WHEN g <= $5 THEN 'closed' ELSE 'on_sale' END
     FROM generate_series(1, $6) g
     RETURNING id, starts_at < now() AS past`,
    [t.clientId, t.brandId, t.eventId, capacity, o.pastSessions, sessions],
  );
  const sessionIds = created.map((r) => r.id);

  // Planner statistics are refreshed after each bulk step, as autovacuum would in service:
  // otherwise the per-row trigger and foreign-key plans assume the tables are still empty.
  const analyze = (q: Pick<Db, "query">, ...tables: string[]) => q.query(`ANALYZE ${tables.map((x) => `public.${x}`).join(", ")}`);

  // Buyers, then pending orders (one per buyer) with their admission line, in one
  // transaction so the deferred total checks see both.
  await withTransaction(db, async (tx) => {
    await tx.query(
      `INSERT INTO public.ticketing_buyers (client_id, brand_id, email, full_name, language)
       SELECT $1, $2, $3 || '-' || g || '@volume.example', 'Acheteur ' || $3 || ' ' || g, CASE WHEN g % 5 = 0 THEN 'en' ELSE 'fr' END
       FROM generate_series(1, $4) g`,
      [t.clientId, t.brandId, o.tag, sessions * o.ordersPerSession],
    );
    await analyze(tx, "ticketing_buyers");
    await tx.query(
      `WITH b AS (
         SELECT id, row_number() OVER (ORDER BY created_at, id) AS n
         FROM public.ticketing_buyers WHERE client_id = $1 AND brand_id = $2 AND email LIKE $3 || '-%@volume.example'
       ), s AS (
         SELECT id, row_number() OVER (ORDER BY id) - 1 AS k FROM unnest($4::uuid[]) id
       )
       INSERT INTO public.ticketing_orders
         (client_id, brand_id, event_id, session_id, buyer_id, reference, subtotal_cents, tax_cents, total_cents, created_at)
       SELECT $1, $2, $5, s.id, b.id, $8 || substr(ref, 2, 3) || '-' || substr(ref, 5, 4),
              (1 + b.n % 4) * $6, 0, (1 + b.n % 4) * $6, now() - make_interval(mins => (b.n * 7)::int)
       FROM b JOIN s ON s.k = (b.n - 1) % $7
       CROSS JOIN LATERAL (
         SELECT string_agg(substr($9, ((b.n / (32 ^ p)::bigint) % 32)::int + 1, 1), '' ORDER BY p DESC) AS ref
         FROM generate_series(0, 7) p
       ) r`,
      [t.clientId, t.brandId, o.tag, sessionIds, t.eventId, general.priceCents, sessions, o.referencePrefix ?? "V", CROCKFORD],
    );
    await analyze(tx, "ticketing_orders");
    await tx.query(
      `INSERT INTO public.ticketing_order_lines
         (order_id, client_id, brand_id, event_id, ticket_type_id, kind, code_snapshot, name_snapshot, quantity, unit_price_cents, line_total_cents)
       SELECT o.id, o.client_id, o.brand_id, o.event_id, $4, 'admission', 'GENERAL', $5, o.subtotal_cents / $6, $6, o.subtotal_cents
       FROM public.ticketing_orders o WHERE o.client_id = $1 AND o.brand_id = $2 AND o.session_id = ANY($3::uuid[])`,
      [t.clientId, t.brandId, sessionIds, general.id, general.name, general.priceCents],
    );
    await analyze(tx, "ticketing_order_lines");
  });

  // The new sessions hold only these orders.
  const scope = [t.clientId, t.brandId, sessionIds];
  // Paid one minute after creation: the trigger queues each order's tickets email.
  await db.query(
    `UPDATE public.ticketing_orders SET status = 'paid', paid_at = created_at + interval '1 minute'
     WHERE client_id = $1 AND brand_id = $2 AND session_id = ANY($3::uuid[])`,
    scope,
  );
  await analyze(db, "ticketing_orders", "ticketing_email_outbox");
  await db.query(
    `UPDATE public.ticketing_email_outbox x SET status = 'sent', sent_at = o.paid_at, attempts = 1, provider_message_id = 'volume'
     FROM public.ticketing_orders o
     WHERE o.id = x.order_id AND o.client_id = $1 AND o.brand_id = $2 AND o.session_id = ANY($3::uuid[]) AND x.status = 'pending'`,
    scope,
  );

  // Tickets per session, one transaction each so the session row's sold_count updates stay short.
  let tickets = 0;
  for (const sessionId of sessionIds) {
    const r = await db.query(
      `INSERT INTO public.ticketing_tickets (client_id, brand_id, event_id, session_id, order_id, order_line_id, ticket_type_id)
       SELECT l.client_id, l.brand_id, l.event_id, o.session_id, l.order_id, l.id, l.ticket_type_id
       FROM public.ticketing_orders o
       JOIN public.ticketing_order_lines l ON l.order_id = o.id
       CROSS JOIN generate_series(1, l.quantity)
       WHERE o.session_id = $1 AND o.client_id = $2 AND o.brand_id = $3`,
      [sessionId, t.clientId, t.brandId],
    );
    tickets += r.rowCount ?? 0;
    await analyze(db, "ticketing_tickets", "ticketing_credentials", "ticketing_sessions");
  }

  // The gate: most past tickets admitted once, a few presented twice, some unreadable codes.
  const pastSessionIds = created.filter((r) => r.past).map((r) => r.id);
  const share = o.admittedShare ?? 0.85;
  const scans = await db.query(
    `WITH admitted AS (
       INSERT INTO public.ticketing_scans
         (client_id, brand_id, event_id, session_id, credential_id, ticket_id, result, device_id, scanned_by, scanned_at, received_at)
       SELECT c.client_id, c.brand_id, c.event_id, c.session_id, c.id, c.ticket_id, 'admitted', 'gate-' || (abs(hashtext(c.id::text)) % 4),
              $4, s.starts_at + make_interval(secs => abs(hashtext(c.id::text)) % 5400), s.starts_at + make_interval(secs => abs(hashtext(c.id::text)) % 5400)
       FROM public.ticketing_credentials c JOIN public.ticketing_sessions s ON s.id = c.session_id
       WHERE c.session_id = ANY($1::uuid[]) AND c.client_id = $2 AND c.brand_id = $3 AND c.status = 'active'
         AND abs(hashtext(c.id::text)) % 1000 < $5
       RETURNING client_id, brand_id, event_id, session_id, credential_id, ticket_id, scanned_at
     ), again AS (
       INSERT INTO public.ticketing_scans
         (client_id, brand_id, event_id, session_id, credential_id, ticket_id, result, device_id, scanned_by, scanned_at, received_at)
       SELECT client_id, brand_id, event_id, session_id, credential_id, ticket_id, 'already_admitted', 'gate-0', $4,
              scanned_at + interval '2 minutes', scanned_at + interval '2 minutes'
       FROM admitted WHERE abs(hashtext(ticket_id::text)) % 20 = 0
       RETURNING 1
     ), junk AS (
       INSERT INTO public.ticketing_scans (client_id, brand_id, event_id, session_id, result, device_id, scanned_by, scanned_at, received_at)
       SELECT client_id, brand_id, event_id, session_id, 'unknown_credential', 'gate-1', $4, scanned_at, scanned_at
       FROM admitted WHERE abs(hashtext(ticket_id::text)) % 50 = 1
       RETURNING 1
     )
     SELECT (SELECT count(*) FROM admitted) + (SELECT count(*) FROM again) + (SELECT count(*) FROM junk) AS n`,
    [pastSessionIds, t.clientId, t.brandId, scannerUser, Math.round(share * 1000)],
  );

  // A buyer from the middle whose number has the most digits: "festi 96" would also match
  // "festi 960…969" (and more at volume), so part of its name would not name one order.
  const { rows: sample } = await db.query<{ reference: string; email: string; full_name: string }>(
    `WITH longest AS (
       SELECT o.reference, b.email, b.full_name, o.created_at FROM public.ticketing_orders o JOIN public.ticketing_buyers b ON b.id = o.buyer_id
       WHERE o.client_id = $1 AND o.brand_id = $2 AND o.session_id = ANY($3::uuid[])
         AND length(b.full_name) = (SELECT max(length(x.full_name)) FROM public.ticketing_buyers x WHERE x.client_id = $1 AND x.brand_id = $2)
     )
     SELECT reference, email, full_name FROM longest ORDER BY created_at LIMIT 1 OFFSET (SELECT count(*) / 2 FROM longest)`,
    scope,
  );
  await db.query("ANALYZE");
  return {
    sessionIds,
    pastSessionIds,
    futureSessionIds: created.filter((r) => !r.past).map((r) => r.id),
    orders: sessions * o.ordersPerSession,
    tickets,
    scans: Number(scans.rows[0]!.n),
    sample: { reference: sample[0]!.reference, email: sample[0]!.email, fullName: sample[0]!.full_name! },
  };
}
