import type { TicketTypeRule } from "../domain/catalog.js";
import { DomainError } from "../domain/errors.js";
import { isTaxRegion, type TaxRegion } from "../domain/tax.js";
import type { TenantScope } from "./commerce.js";
import { mapDbErrors } from "./errors.js";
import type { Db, Tx } from "./pool.js";

/**
 * Catalog reads and writes. Every statement is scoped by client_id AND brand_id; ids from
 * the URL are never trusted alone.
 */

type Queryable = Db | Tx;
type Row = Record<string, unknown>;

const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
export function toApi<T extends Row>(row: T): Row {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [camel(k), v]));
}

const VENUE_COLUMNS = "id, name, address_line1, city, region, postal_code, country, timezone, tax_region, created_at, updated_at";
const EVENT_COLUMNS = "id, venue_id, slug, title, description, status, sales_open_at, sales_close_at, created_at, updated_at";
const SESSION_COLUMNS = "id, event_id, starts_at, ends_at, capacity, reserved_count, sold_count, status, created_at, updated_at";
const TYPE_COLUMNS =
  "id, event_id, code, name, description, kind, price_cents, min_quantity, max_quantity, max_adults_in_order, counts_as_adult, add_on_scope, active, sort_order, created_at, updated_at";

/** camelCase body field → column, for whitelisted updates. */
function updateSet(fields: Record<string, unknown>, allowed: Record<string, string>, startAt: number) {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(fields)) {
    const column = allowed[key];
    if (!column || value === undefined) continue;
    values.push(value);
    sets.push(`${column} = $${startAt + values.length - 1}`);
  }
  if (sets.length === 0) throw new DomainError("empty_update");
  return { sql: sets.join(", "), values };
}

async function one(q: Queryable, sql: string, params: unknown[], notFound: string): Promise<Row> {
  const { rows } = await q.query<Row>(sql, params);
  if (!rows[0]) throw new DomainError(notFound);
  return toApi(rows[0]);
}

async function many(q: Queryable, sql: string, params: unknown[]): Promise<Row[]> {
  const { rows } = await q.query<Row>(sql, params);
  return rows.map(toApi);
}

// ── Venues ──────────────────────────────────────────────────────────────────
export const listVenues = (q: Queryable, s: TenantScope) =>
  many(q, `SELECT ${VENUE_COLUMNS} FROM public.ticketing_venues WHERE client_id = $1 AND brand_id = $2 ORDER BY name`, [s.clientId, s.brandId]);

export function createVenue(q: Queryable, s: TenantScope, v: {
  name: string; addressLine1?: string | null; city?: string | null; region?: string | null;
  postalCode?: string | null; country: string; timezone: string; taxRegion: string;
}) {
  return mapDbErrors(() =>
    one(
      q,
      `INSERT INTO public.ticketing_venues (client_id, brand_id, name, address_line1, city, region, postal_code, country, timezone, tax_region)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING ${VENUE_COLUMNS}`,
      [s.clientId, s.brandId, v.name, v.addressLine1 ?? null, v.city ?? null, v.region ?? null, v.postalCode ?? null, v.country, v.timezone, v.taxRegion],
      "venue_not_found",
    ),
  );
}

export function updateVenue(q: Queryable, s: TenantScope, venueId: string, fields: Record<string, unknown>) {
  const set = updateSet(fields, {
    name: "name", addressLine1: "address_line1", city: "city", region: "region",
    postalCode: "postal_code", country: "country", timezone: "timezone", taxRegion: "tax_region",
  }, 4);
  return mapDbErrors(() =>
    one(q, `UPDATE public.ticketing_venues SET ${set.sql} WHERE id = $1 AND client_id = $2 AND brand_id = $3 RETURNING ${VENUE_COLUMNS}`,
      [venueId, s.clientId, s.brandId, ...set.values], "venue_not_found"),
  );
}

// ── Events ──────────────────────────────────────────────────────────────────
export const listEvents = (q: Queryable, s: TenantScope) =>
  many(q, `SELECT ${EVENT_COLUMNS} FROM public.ticketing_events WHERE client_id = $1 AND brand_id = $2 ORDER BY created_at DESC`, [s.clientId, s.brandId]);

export const getEvent = (q: Queryable, s: TenantScope, eventId: string) =>
  one(q, `SELECT ${EVENT_COLUMNS} FROM public.ticketing_events WHERE id = $1 AND client_id = $2 AND brand_id = $3`, [eventId, s.clientId, s.brandId], "event_not_found");

export function createEvent(q: Queryable, s: TenantScope, e: {
  venueId: string; slug: string; title: string; description?: string | null; salesOpenAt?: string | null; salesCloseAt?: string | null;
}) {
  return mapDbErrors(() =>
    one(
      q,
      `INSERT INTO public.ticketing_events (client_id, brand_id, venue_id, slug, title, description, sales_open_at, sales_close_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${EVENT_COLUMNS}`,
      [s.clientId, s.brandId, e.venueId, e.slug, e.title, e.description ?? null, e.salesOpenAt ?? null, e.salesCloseAt ?? null],
      "event_not_found",
    ),
  );
}

export function updateEvent(q: Queryable, s: TenantScope, eventId: string, fields: Record<string, unknown>) {
  const set = updateSet(fields, {
    title: "title", description: "description", status: "status", salesOpenAt: "sales_open_at", salesCloseAt: "sales_close_at",
  }, 4);
  return mapDbErrors(() =>
    one(q, `UPDATE public.ticketing_events SET ${set.sql} WHERE id = $1 AND client_id = $2 AND brand_id = $3 RETURNING ${EVENT_COLUMNS}`,
      [eventId, s.clientId, s.brandId, ...set.values], "event_not_found"),
  );
}

// ── Sessions ────────────────────────────────────────────────────────────────
export const listSessions = (q: Queryable, s: TenantScope, eventId: string) =>
  many(q, `SELECT ${SESSION_COLUMNS} FROM public.ticketing_sessions WHERE event_id = $1 AND client_id = $2 AND brand_id = $3 ORDER BY starts_at`,
    [eventId, s.clientId, s.brandId]);

export function createSession(q: Queryable, s: TenantScope, eventId: string, v: { startsAt: string; endsAt?: string | null; capacity: number }) {
  return mapDbErrors(() =>
    one(
      q,
      `INSERT INTO public.ticketing_sessions (client_id, brand_id, event_id, starts_at, ends_at, capacity)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${SESSION_COLUMNS}`,
      [s.clientId, s.brandId, eventId, v.startsAt, v.endsAt ?? null, v.capacity],
      "session_not_found",
    ),
  );
}

export function updateSession(q: Queryable, s: TenantScope, sessionId: string, fields: Record<string, unknown>) {
  const set = updateSet(fields, { capacity: "capacity", status: "status", endsAt: "ends_at" }, 4);
  return mapDbErrors(async () => {
    try {
      return await one(q, `UPDATE public.ticketing_sessions SET ${set.sql} WHERE id = $1 AND client_id = $2 AND brand_id = $3 RETURNING ${SESSION_COLUMNS}`,
        [sessionId, s.clientId, s.brandId, ...set.values], "session_not_found");
    } catch (error) {
      if ((error as { constraint?: string }).constraint === "ticketing_sessions_capacity_ck") {
        throw new DomainError("capacity_below_committed");
      }
      throw error;
    }
  });
}

// ── Ticket types ────────────────────────────────────────────────────────────
export const listTicketTypes = (q: Queryable, s: TenantScope, eventId: string) =>
  many(q, `SELECT ${TYPE_COLUMNS} FROM public.ticketing_ticket_types WHERE event_id = $1 AND client_id = $2 AND brand_id = $3 ORDER BY sort_order, code`,
    [eventId, s.clientId, s.brandId]);

export function createTicketType(q: Queryable, s: TenantScope, eventId: string, t: {
  code: string; name: string; description?: string | null; kind: string; priceCents: number; minQuantity: number; maxQuantity: number;
  maxAdultsInOrder?: number | null; countsAsAdult: boolean; addOnScope?: string | null; active: boolean; sortOrder: number;
}) {
  return mapDbErrors(() =>
    one(
      q,
      `INSERT INTO public.ticketing_ticket_types
         (client_id, brand_id, event_id, code, name, description, kind, price_cents, min_quantity, max_quantity,
          max_adults_in_order, counts_as_adult, add_on_scope, active, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING ${TYPE_COLUMNS}`,
      [s.clientId, s.brandId, eventId, t.code, t.name, t.description ?? null, t.kind, t.priceCents, t.minQuantity, t.maxQuantity,
        t.maxAdultsInOrder ?? null, t.countsAsAdult, t.addOnScope ?? null, t.active, t.sortOrder],
      "ticket_type_not_found",
    ),
  );
}

export function updateTicketType(q: Queryable, s: TenantScope, ticketTypeId: string, fields: Record<string, unknown>) {
  const set = updateSet(fields, {
    name: "name", description: "description", priceCents: "price_cents", minQuantity: "min_quantity",
    maxQuantity: "max_quantity", maxAdultsInOrder: "max_adults_in_order", active: "active", sortOrder: "sort_order",
  }, 4);
  return mapDbErrors(() =>
    one(q, `UPDATE public.ticketing_ticket_types SET ${set.sql} WHERE id = $1 AND client_id = $2 AND brand_id = $3 RETURNING ${TYPE_COLUMNS}`,
      [ticketTypeId, s.clientId, s.brandId, ...set.values], "ticket_type_not_found"),
  );
}

/** Purchase rules for an event, as the domain sees them. */
export async function loadTicketTypeRules(q: Queryable, s: TenantScope, eventId: string): Promise<TicketTypeRule[]> {
  const { rows } = await q.query<{
    id: string; code: string; name: string; kind: "admission" | "add_on"; price_cents: number; min_quantity: number;
    max_quantity: number; max_adults_in_order: number | null; counts_as_adult: boolean; add_on_scope: "per_admission" | null; active: boolean;
  }>(
    `SELECT id, code, name, kind, price_cents, min_quantity, max_quantity, max_adults_in_order, counts_as_adult, add_on_scope, active
     FROM public.ticketing_ticket_types WHERE event_id = $1 AND client_id = $2 AND brand_id = $3 ORDER BY sort_order, code`,
    [eventId, s.clientId, s.brandId],
  );
  return rows.map((r) => ({
    id: r.id, code: r.code, name: r.name, kind: r.kind, priceCents: r.price_cents, minQuantity: r.min_quantity,
    maxQuantity: r.max_quantity, maxAdultsInOrder: r.max_adults_in_order, countsAsAdult: r.counts_as_adult,
    addOnScope: r.add_on_scope, active: r.active,
  }));
}

// ── Public catalog ──────────────────────────────────────────────────────────
export interface PublicEventContext {
  id: string;
  status: "draft" | "published" | "cancelled" | "archived";
  salesOpenAt: Date | null;
  salesCloseAt: Date | null;
  taxRegion: TaxRegion;
}

/** A published event with its venue tax region, or null when it is not public. */
export async function loadPublicEvent(q: Queryable, s: TenantScope, eventId: string): Promise<PublicEventContext | null> {
  const { rows } = await q.query<{ id: string; status: PublicEventContext["status"]; sales_open_at: Date | null; sales_close_at: Date | null; tax_region: string }>(
    `SELECT e.id, e.status, e.sales_open_at, e.sales_close_at, v.tax_region
     FROM public.ticketing_events e
     JOIN public.ticketing_venues v ON v.id = e.venue_id AND v.client_id = e.client_id AND v.brand_id = e.brand_id
     WHERE e.id = $1 AND e.client_id = $2 AND e.brand_id = $3 AND e.status = 'published'`,
    [eventId, s.clientId, s.brandId],
  );
  const r = rows[0];
  if (!r) return null;
  if (!isTaxRegion(r.tax_region)) throw new DomainError("unsupported_tax_region");
  return { id: r.id, status: r.status, salesOpenAt: r.sales_open_at, salesCloseAt: r.sales_close_at, taxRegion: r.tax_region };
}

export const listPublicEvents = (q: Queryable, s: TenantScope) =>
  many(
    q,
    `SELECT e.id, e.slug, e.title, e.description, e.sales_open_at, e.sales_close_at,
            v.name AS venue_name, v.city AS venue_city, v.timezone AS venue_timezone
     FROM public.ticketing_events e
     JOIN public.ticketing_venues v ON v.id = e.venue_id AND v.client_id = e.client_id AND v.brand_id = e.brand_id
     WHERE e.client_id = $1 AND e.brand_id = $2 AND e.status = 'published'
     ORDER BY e.title`,
    [s.clientId, s.brandId],
  );

/** Sessions open for sale (future, on sale), with remaining availability only. */
export const listPublicSessions = (q: Queryable, s: TenantScope, eventId: string, now: Date) =>
  many(
    q,
    `SELECT id, starts_at, ends_at, GREATEST(capacity - reserved_count - sold_count, 0) AS available
     FROM public.ticketing_sessions
     WHERE event_id = $1 AND client_id = $2 AND brand_id = $3 AND status = 'on_sale' AND starts_at > $4
     ORDER BY starts_at`,
    [eventId, s.clientId, s.brandId, now],
  );

export interface SellableSession {
  id: string;
  eventId: string;
  startsAt: Date;
  status: "draft" | "on_sale" | "paused" | "cancelled" | "closed";
}

export async function loadSession(q: Queryable, s: TenantScope, sessionId: string): Promise<SellableSession | null> {
  const { rows } = await q.query<{ id: string; event_id: string; starts_at: Date; status: SellableSession["status"] }>(
    `SELECT id, event_id, starts_at, status FROM public.ticketing_sessions WHERE id = $1 AND client_id = $2 AND brand_id = $3`,
    [sessionId, s.clientId, s.brandId],
  );
  const r = rows[0];
  return r ? { id: r.id, eventId: r.event_id, startsAt: r.starts_at, status: r.status } : null;
}

// ── Orders and audit (read-only in Run 01) ──────────────────────────────────
export const listOrders = (q: Queryable, s: TenantScope, limit: number, before?: string) =>
  many(
    q,
    `SELECT o.id, o.reference, o.status, o.event_id, o.session_id, o.currency, o.subtotal_cents, o.tax_cents, o.total_cents,
            o.refunded_cents, o.paid_at, o.created_at, b.email AS buyer_email, b.full_name AS buyer_name
     FROM public.ticketing_orders o
     JOIN public.ticketing_buyers b ON b.id = o.buyer_id AND b.client_id = o.client_id AND b.brand_id = o.brand_id
     WHERE o.client_id = $1 AND o.brand_id = $2 AND ($4::timestamptz IS NULL OR o.created_at < $4)
     ORDER BY o.created_at DESC LIMIT $3`,
    [s.clientId, s.brandId, limit, before ?? null],
  );

export async function getOrder(q: Queryable, s: TenantScope, orderId: string): Promise<Row> {
  const order = await one(
    q,
    `SELECT o.id, o.reference, o.status, o.event_id, o.session_id, o.currency, o.subtotal_cents, o.tax_cents, o.total_cents,
            o.commission_cents, o.refunded_cents, o.commission_refunded_cents, o.paid_at, o.created_at,
            b.email AS buyer_email, b.full_name AS buyer_name, b.phone AS buyer_phone
     FROM public.ticketing_orders o
     JOIN public.ticketing_buyers b ON b.id = o.buyer_id AND b.client_id = o.client_id AND b.brand_id = o.brand_id
     WHERE o.id = $1 AND o.client_id = $2 AND o.brand_id = $3`,
    [orderId, s.clientId, s.brandId],
    "order_not_found",
  );
  const params = [orderId, s.clientId, s.brandId];
  const [lines, taxes, tickets] = await Promise.all([
    many(q, `SELECT id, ticket_type_id, kind, code_snapshot, name_snapshot, quantity, unit_price_cents, line_total_cents
             FROM public.ticketing_order_lines WHERE order_id = $1 AND client_id = $2 AND brand_id = $3 ORDER BY created_at, id`, params),
    many(q, `SELECT code, rate_ppm, taxable_cents, amount_cents
             FROM public.ticketing_order_taxes WHERE order_id = $1 AND client_id = $2 AND brand_id = $3 ORDER BY code`, params),
    many(q, `SELECT id, ticket_type_id, status, void_reason, voided_at
             FROM public.ticketing_tickets WHERE order_id = $1 AND client_id = $2 AND brand_id = $3 ORDER BY created_at, id`, params),
  ]);
  return { ...order, lines, taxes, tickets };
}

export const listAudit = (q: Queryable, s: TenantScope, limit: number, before?: string) =>
  many(
    q,
    `SELECT id, brand_id, actor_type, actor_id, action, entity_type, entity_id, data, created_at
     FROM public.ticketing_audit_log
     WHERE client_id = $1 AND (brand_id = $2 OR brand_id IS NULL) AND ($4::timestamptz IS NULL OR created_at < $4)
     ORDER BY created_at DESC, id DESC LIMIT $3`,
    [s.clientId, s.brandId, limit, before ?? null],
  );

export async function writeAudit(
  q: Queryable,
  s: TenantScope,
  actor: { type: "user" | "system" | "public"; id: string | null },
  action: string,
  entity: { type: string; id: string | null },
  data: Record<string, unknown> = {},
): Promise<void> {
  await q.query(
    `INSERT INTO public.ticketing_audit_log (client_id, brand_id, actor_type, actor_id, action, entity_type, entity_id, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [s.clientId, s.brandId, actor.type, actor.id, action, entity.type, entity.id, data],
  );
}
