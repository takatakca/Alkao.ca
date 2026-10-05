import { writeAudit } from "../db/catalog.js";
import type { TenantScope } from "../db/commerce.js";
import { withTransaction, type Db } from "../db/pool.js";
import { DomainError } from "../domain/errors.js";

/**
 * Run 28: a new event from an existing one (next week's evening, next year's festival).
 * The copy starts as a draft, at the same venue, with the same ticket types and door hours.
 * With `shiftDays`, the sessions (except cancelled ones) and the sales window are copied too,
 * moved by that many days, as drafts with nothing sold. Without it, neither is copied and
 * staff set them. Nothing of the original changes; no order, ticket or buyer is copied.
 */
export async function duplicateEvent(
  db: Db,
  s: TenantScope,
  eventId: string,
  input: { title?: string | undefined; shiftDays?: number | null | undefined },
  actor: { type: "user"; id: string | null },
) {
  return withTransaction(db, async (tx) => {
    const { rows } = await tx.query<{ slug: string; title: string }>(
      `SELECT slug, title FROM public.ticketing_events WHERE id = $1 AND client_id = $2 AND brand_id = $3 FOR SHARE`,
      [eventId, s.clientId, s.brandId],
    );
    const source = rows[0];
    if (!source) throw new DomainError("event_not_found");
    const title = (input.title?.trim() || `${source.title} (copie)`).slice(0, 200);
    const shift = input.shiftDays ?? null;

    // A free slug: "<slug>-copie", then "-copie-2", "-copie-3"…
    const base = `${source.slug}-copie`.slice(0, 72).replace(/-+$/, "");
    const { rows: taken } = await tx.query<{ slug: string }>(
      `SELECT slug FROM public.ticketing_events WHERE client_id = $1 AND brand_id = $2 AND (slug = $3 OR slug LIKE $3 || '-%')`,
      [s.clientId, s.brandId, base],
    );
    const used = new Set(taken.map((t) => t.slug));
    let slug = base;
    for (let i = 2; used.has(slug); i++) slug = `${base}-${i}`;

    const { rows: created } = await tx.query<{ id: string }>(
      `INSERT INTO public.ticketing_events
         (client_id, brand_id, venue_id, slug, title, description, status, sales_open_at, sales_close_at,
          admission_opens_before_minutes, admission_closes_after_minutes)
       SELECT client_id, brand_id, venue_id, $4, $5, description, 'draft',
              CASE WHEN $6::int IS NULL THEN NULL ELSE sales_open_at + make_interval(days => $6::int) END,
              CASE WHEN $6::int IS NULL THEN NULL ELSE sales_close_at + make_interval(days => $6::int) END,
              admission_opens_before_minutes, admission_closes_after_minutes
       FROM public.ticketing_events WHERE id = $1 AND client_id = $2 AND brand_id = $3
       RETURNING id`,
      [eventId, s.clientId, s.brandId, slug, title, shift],
    );
    const newId = created[0]!.id;
    const types = await tx.query(
      `INSERT INTO public.ticketing_ticket_types
         (client_id, brand_id, event_id, code, name, description, kind, price_cents, min_quantity, max_quantity,
          max_adults_in_order, counts_as_adult, add_on_scope, active, sort_order, grants_session_change)
       SELECT client_id, brand_id, $4, code, name, description, kind, price_cents, min_quantity, max_quantity,
              max_adults_in_order, counts_as_adult, add_on_scope, active, sort_order, grants_session_change
       FROM public.ticketing_ticket_types WHERE event_id = $1 AND client_id = $2 AND brand_id = $3`,
      [eventId, s.clientId, s.brandId, newId],
    );
    let sessions = 0;
    if (shift !== null) {
      const r = await tx.query(
        `INSERT INTO public.ticketing_sessions (client_id, brand_id, event_id, starts_at, ends_at, capacity, status)
         SELECT client_id, brand_id, $4, starts_at + make_interval(days => $5::int), ends_at + make_interval(days => $5::int), capacity, 'draft'
         FROM public.ticketing_sessions WHERE event_id = $1 AND client_id = $2 AND brand_id = $3 AND status <> 'cancelled'`,
        [eventId, s.clientId, s.brandId, newId, shift],
      );
      sessions = r.rowCount ?? 0;
    }
    await writeAudit(tx, s, actor, "event.duplicated", { type: "event", id: newId }, {
      from: eventId, shiftDays: shift, ticketTypes: types.rowCount ?? 0, sessions,
    });
    return { event: { id: newId, slug, title, status: "draft" }, ticketTypes: types.rowCount ?? 0, sessions };
  });
}
