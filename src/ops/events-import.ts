import { z } from "zod";
import * as catalog from "../db/catalog.js";
import type { Db, Tx } from "../db/pool.js";
import type { TenantScope } from "../db/commerce.js";
import * as promoDb from "../db/promo.js";
import { CreateEvent, CreatePromoCode, CreateSession, CreateTicketType, CreateVenue, UpdateEvent } from "../contracts/api-v1.js";

/**
 * Run 91: load one Brand's event from a file, the same rows /ops would create (venue, event,
 * sessions, ticket types), so an operator can put a Client's season on ALKAO in one command.
 * Prices, dates and texts come only from the file: nothing is guessed. Safe to run again: what
 * already exists (venue by name, event by slug, ticket type by code, session by start) is kept
 * as it is, and past dates are never created.
 * Run 99: presales name their regular ticket by code (`presaleOfCode`), festival passes set
 * `pass`, and coupons come in `promoCodes`, kept by code like the rest.
 */
export const EventFile = z.object({
  venue: CreateVenue,
  // The API's own rules (dates in order, and so on) are checked again on each row below.
  event: z.object(CreateEvent.shape).omit({ venueId: true }),
  /** Capacity per session: here, or for every session with --capacity. */
  sessions: z.array(z.object(CreateSession.shape).extend({ capacity: CreateSession.shape.capacity.optional() })).min(1).max(400),
  // Run 99: a presale names the regular ticket it undercuts by code (the file has no ids).
  ticketTypes: z.array(z.object(CreateTicketType.shape).omit({ presaleOf: true }).extend({
    presaleOfCode: CreateTicketType.shape.code.optional(),
  })).min(1).max(50),
  /** Run 99: promo codes and public coupons for this event. */
  promoCodes: z.array(CreatePromoCode).max(50).default([]),
});
export type EventFile = z.infer<typeof EventFile>;

export interface ImportOptions {
  /** Used for every session that does not set its own. */
  capacity: number | null;
  /** Put the new sessions on sale and publish the event. */
  publish: boolean;
  /** Turn on "Afficher mes événements sur ALKAO" (the Brand's explicit opt-in). */
  listOnAlkao: boolean;
  /** Run 94: on an event already there, take its page from the file (texts, photo, facts, sections, ticket descriptions). */
  updatePage?: boolean;
  now: Date;
}

export interface ImportResult {
  venue: "created" | "kept";
  event: "created" | "kept" | "updated";
  eventId: string;
  ticketTypes: { created: string[]; kept: string[] };
  promoCodes: { created: string[]; kept: string[] };
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

  // Run 94: the page of an event already there, from the file; dates, prices and status are left alone.
  let eventResult: ImportResult["event"] = eventState;
  if (eventState === "kept" && opts.updatePage) {
    const PAGE_FIELDS = ["description", "imageUrl", "category", "minAge", "doorsOpenMinutes", "language", "accessibility", "durationMinutes", "format", "page"] as const;
    const fields = Object.fromEntries(PAGE_FIELDS.filter((k) => file.event[k] !== undefined).map((k) => [k, file.event[k]]));
    if (Object.keys(fields).length) {
      await catalog.updateEvent(q, s, eventId, UpdateEvent.parse(fields));
      await catalog.writeAudit(q, s, ACTOR, "event.updated", { type: "event", id: eventId }, { fields: Object.keys(fields), source: "events:import" });
      eventResult = "updated";
    }
  }

  // Ticket types, by code; the regular tickets first, so each presale finds the one it undercuts.
  const types = await catalog.listTicketTypes(q, s, eventId);
  const idOf = new Map(types.map((t) => [t.code as string, t.id as string]));
  const ticketTypes = { created: [] as string[], kept: [] as string[] };
  const ordered = [...file.ticketTypes.filter((t) => !t.presaleOfCode), ...file.ticketTypes.filter((t) => t.presaleOfCode)];
  for (const { presaleOfCode, ...t } of ordered) {
    if (idOf.has(t.code)) {
      // Run 94: with --update-page, what the ticket includes comes from the file too (never its price).
      const existing = types.find((x) => x.code === t.code)!;
      if (opts.updatePage && t.description !== undefined && (existing.description ?? null) !== (t.description ?? null)) {
        await catalog.updateTicketType(q, s, existing.id as string, { description: t.description ?? null });
        await catalog.writeAudit(q, s, ACTOR, "ticket_type.updated", { type: "ticket_type", id: existing.id as string }, { fields: ["description"], source: "events:import" });
      }
      ticketTypes.kept.push(t.code);
      continue;
    }
    const presaleOf = presaleOfCode ? idOf.get(presaleOfCode) : undefined;
    if (presaleOfCode && !presaleOf) throw new Error(`Ticket type ${t.code}: presaleOfCode ${presaleOfCode} is not a ticket type of this event.`);
    const row = await catalog.createTicketType(q, s, eventId, CreateTicketType.parse({ ...t, ...(presaleOf ? { presaleOf } : {}) }));
    await catalog.writeAudit(q, s, ACTOR, "ticket_type.created", { type: "ticket_type", id: row.id as string }, { source: "events:import" });
    idOf.set(t.code, row.id as string);
    ticketTypes.created.push(t.code);
  }
  // Keep the file's order in the result.
  const order = file.ticketTypes.map((t) => t.code);
  const byFile = (a: string, b: string) => order.indexOf(a) - order.indexOf(b);
  ticketTypes.created.sort(byFile);
  ticketTypes.kept.sort(byFile);

  // Run 99: promo codes and coupons, by code; one already there is left as staff made it.
  const promoCodes = { created: [] as string[], kept: [] as string[] };
  const existingCodes = new Set((await promoDb.listPromoCodes(q, s, eventId)).map((p) => p.code as string));
  for (const p of file.promoCodes) {
    if (existingCodes.has(p.code)) { promoCodes.kept.push(p.code); continue; }
    await promoDb.createPromoCode(q, s, eventId, p, ACTOR);
    promoCodes.created.push(p.code);
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
  return { venue: venueState, event: eventResult, eventId, ticketTypes, promoCodes, sessions, published: opts.publish, listedOnAlkao: opts.listOnAlkao };
}
