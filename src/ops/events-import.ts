import { z } from "zod";
import * as catalog from "../db/catalog.js";
import type { Db, Tx } from "../db/pool.js";
import type { TenantScope } from "../db/commerce.js";
import { CreateEvent, CreateSession, CreateTicketType, CreateVenue } from "../contracts/api-v1.js";

/**
 * Run 91: load one Brand's event from a file, the same rows /ops would create (venue, event,
 * sessions, ticket types), so an operator can put a Client's season on ALKAO in one command.
 * Prices, dates and texts come only from the file: nothing is guessed. Safe to run again: what
 * already exists (venue by name, event by slug, ticket type by code, session by start) is kept
 * as it is, and past dates are never created.
 */
export const EventFile = z.object({
  venue: CreateVenue,
  // The API's own rules (dates in order, and so on) are checked again on each row below.
  event: z.object(CreateEvent.shape).omit({ venueId: true }),
  /** Capacity per session: here, or for every session with --capacity. */
  sessions: z.array(z.object(CreateSession.shape).extend({ capacity: CreateSession.shape.capacity.optional() })).min(1).max(400),
  ticketTypes: z.array(CreateTicketType).min(1).max(50),
});
export type EventFile = z.infer<typeof EventFile>;

export interface ImportOptions {
  /** Used for every session that does not set its own. */
  capacity: number | null;
  /** Put the new sessions on sale and publish the event. */
  publish: boolean;
  /** Turn on "Afficher mes événements sur ALKAO" (the Brand's explicit opt-in). */
  listOnAlkao: boolean;
  now: Date;
}

export interface ImportResult {
  venue: "created" | "kept";
  event: "created" | "kept";
  eventId: string;
  ticketTypes: { created: string[]; kept: string[] };
  sessions: { created: number; kept: number; past: number };
  published: boolean;
  listedOnAlkao: boolean;
}

const ACTOR = { type: "system" as const, id: null };

export async function importEvent(q: Db | Tx, s: TenantScope, file: EventFile, opts: ImportOptions): Promise<ImportResult> {
  const brand = await q.query(`SELECT 1 FROM public.ticketing_brands WHERE id = $1 AND client_id = $2`, [s.brandId, s.clientId]);
  if (!brand.rowCount) throw new Error("This Client and Brand are not in ALKAO yet: provision them first (npm run control:apply).");
  const missing = file.sessions.filter((x) => x.capacity === undefined);
  if (missing.length && opts.capacity === null) throw new Error("Each session needs a capacity: set it in the file or pass --capacity.");

  // Venue, by its exact name in this Brand.
  const venues = await catalog.listVenues(q, s);
  let venue = venues.find((v) => v.name === file.venue.name);
  const venueState = venue ? "kept" : "created";
  if (!venue) {
    venue = await catalog.createVenue(q, s, file.venue);
    await catalog.writeAudit(q, s, ACTOR, "venue.created", { type: "venue", id: venue.id as string }, { source: "events:import" });
  }

  // Event, by its slug in this Brand.
  const existing = await q.query<{ id: string; status: string }>(
    `SELECT id, status FROM public.ticketing_events WHERE client_id = $1 AND brand_id = $2 AND slug = $3`, [s.clientId, s.brandId, file.event.slug]);
  let eventId = existing.rows[0]?.id;
  const eventState = eventId ? "kept" : "created";
  if (!eventId) {
    const e = await catalog.createEvent(q, s, CreateEvent.parse({ ...file.event, venueId: venue.id }));
    eventId = e.id as string;
    await catalog.writeAudit(q, s, ACTOR, "event.created", { type: "event", id: eventId }, { source: "events:import" });
  }

  // Ticket types, by code.
  const types = await catalog.listTicketTypes(q, s, eventId);
  const codes = new Set(types.map((t) => t.code as string));
  const ticketTypes = { created: [] as string[], kept: [] as string[] };
  for (const t of file.ticketTypes) {
    if (codes.has(t.code)) { ticketTypes.kept.push(t.code); continue; }
    const row = await catalog.createTicketType(q, s, eventId, t);
    await catalog.writeAudit(q, s, ACTOR, "ticket_type.created", { type: "ticket_type", id: row.id as string }, { source: "events:import" });
    ticketTypes.created.push(t.code);
  }

  // Sessions, by start; never one in the past.
  const current = await catalog.listSessions(q, s, eventId);
  const byStart = new Map(current.map((x) => [new Date(x.startsAt as string).getTime(), x]));
  const sessions = { created: 0, kept: 0, past: 0 };
  // The file's future dates still in draft: --publish puts them on sale (a paused or
  // cancelled date stays as staff left it).
  const drafts: string[] = [];
  for (const x of file.sessions) {
    const at = Date.parse(x.startsAt);
    const future = at > opts.now.getTime();
    const found = byStart.get(at);
    if (found) {
      sessions.kept++;
      if (future && found.status === "draft") drafts.push(found.id as string);
      continue;
    }
    if (!future) { sessions.past++; continue; }
    const row = await catalog.createSession(q, s, eventId, CreateSession.parse({ ...x, capacity: x.capacity ?? opts.capacity }));
    await catalog.writeAudit(q, s, ACTOR, "session.created", { type: "session", id: row.id as string }, { source: "events:import" });
    drafts.push(row.id as string);
    sessions.created++;
  }

  if (opts.publish) {
    for (const id of drafts) {
      await catalog.updateSession(q, s, id, { status: "on_sale" });
      await catalog.writeAudit(q, s, ACTOR, "session.updated", { type: "session", id }, { status: "on_sale", source: "events:import" });
    }
    if (existing.rows[0]?.status !== "published") {
      await catalog.updateEvent(q, s, eventId, { status: "published" });
      await catalog.writeAudit(q, s, ACTOR, "event.updated", { type: "event", id: eventId }, { fields: ["status"], source: "events:import" });
    }
  }
  if (opts.listOnAlkao) {
    await q.query(
      `INSERT INTO public.ticketing_brand_settings (client_id, brand_id, show_on_alkao) VALUES ($1, $2, true)
       ON CONFLICT (client_id, brand_id) DO UPDATE SET show_on_alkao = true`, [s.clientId, s.brandId]);
    await catalog.writeAudit(q, s, ACTOR, "appearance.updated", { type: "brand", id: s.brandId }, { showOnAlkao: true, source: "events:import" });
  }
  return { venue: venueState, event: eventState, eventId, ticketTypes, sessions, published: opts.publish, listedOnAlkao: opts.listOnAlkao };
}
