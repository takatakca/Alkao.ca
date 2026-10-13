import type { TenantScope } from "../db/commerce.js";
import type { Tx } from "../db/pool.js";

/**
 * Run 65: since 12 September 2026, a ticket seller "doit, dans les plus brefs délais,
 * informer le consommateur" of any change to an event's time or place (OPC). The routes that
 * can change them (a session's end, a venue's name or address) read the upcoming sessions
 * with valid tickets before and after the change, in the same transaction; each session whose
 * time or place moved gets a change record and one e-mail per order holding its tickets.
 */
export interface SessionPlace {
  sessionId: string;
  eventId: string;
  startsAt: Date;
  endsAt: Date | null;
  /** The venue as buyers read it: name · address · city. */
  place: string;
}

/** Upcoming, not cancelled sessions that have valid tickets, for one session or one venue. */
export async function soldSessions(tx: Tx, s: TenantScope, which: { sessionId: string } | { venueId: string }, now: Date): Promise<Map<string, SessionPlace>> {
  const { rows } = await tx.query<{ session_id: string; event_id: string; starts_at: Date; ends_at: Date | null; place: string }>(
    `SELECT se.id AS session_id, se.event_id, se.starts_at, se.ends_at,
            concat_ws(' · ', v.name, nullif(btrim(v.address_line1), ''), nullif(btrim(v.city), '')) AS place
     FROM public.ticketing_sessions se
     JOIN public.ticketing_events e ON e.id = se.event_id AND e.client_id = se.client_id AND e.brand_id = se.brand_id
     JOIN public.ticketing_venues v ON v.id = e.venue_id AND v.client_id = e.client_id AND v.brand_id = e.brand_id
     WHERE se.client_id = $1 AND se.brand_id = $2 AND se.status <> 'cancelled' AND se.starts_at > $3
       AND ($4::uuid IS NULL OR se.id = $4) AND ($5::uuid IS NULL OR v.id = $5)
       AND EXISTS (SELECT 1 FROM public.ticketing_tickets t
                   WHERE t.session_id = se.id AND t.client_id = se.client_id AND t.brand_id = se.brand_id AND t.status = 'valid')`,
    [s.clientId, s.brandId, now, "sessionId" in which ? which.sessionId : null, "venueId" in which ? which.venueId : null],
  );
  return new Map(rows.map((r) => [r.session_id, { sessionId: r.session_id, eventId: r.event_id, startsAt: r.starts_at, endsAt: r.ends_at, place: r.place }]));
}

const same = (a: Date | null, b: Date | null) => (a?.getTime() ?? null) === (b?.getTime() ?? null);

/** Record what changed and queue the buyers' e-mails; returns how many orders will be told. */
export async function noticeChanges(tx: Tx, s: TenantScope, before: Map<string, SessionPlace>, after: Map<string, SessionPlace>): Promise<number> {
  let queued = 0;
  for (const [id, old] of before) {
    const now = after.get(id);
    if (!now || (same(old.startsAt, now.startsAt) && same(old.endsAt, now.endsAt) && old.place === now.place)) continue;
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO public.ticketing_session_changes
         (client_id, brand_id, event_id, session_id, old_starts_at, new_starts_at, old_ends_at, new_ends_at, old_place, new_place)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [s.clientId, s.brandId, old.eventId, id, old.startsAt, now.startsAt, old.endsAt, now.endsAt, old.place, now.place],
    );
    const { rowCount } = await tx.query(
      `INSERT INTO public.ticketing_email_outbox (client_id, brand_id, event_id, order_id, kind, change_id)
       SELECT DISTINCT o.client_id, o.brand_id, o.event_id, o.id, 'session_changed', $4::uuid
       FROM public.ticketing_tickets t
       JOIN public.ticketing_orders o ON o.id = t.order_id AND o.client_id = t.client_id AND o.brand_id = t.brand_id
       WHERE t.session_id = $1 AND t.client_id = $2 AND t.brand_id = $3 AND t.status = 'valid'
       ON CONFLICT (order_id, kind, refund_id, change_id) DO NOTHING`,
      [id, s.clientId, s.brandId, rows[0]!.id],
    );
    queued += rowCount ?? 0;
  }
  return queued;
}
