import { writeAudit } from "../db/catalog.js";
import type { TenantScope } from "../db/commerce.js";
import { withTransaction, type Db } from "../db/pool.js";
import { DomainError } from "../domain/errors.js";

/**
 * Run 29: a season of sessions in one go (FESTI-ICE: arrivals every 15 minutes, 17:00 to
 * 20:30, every evening of the season). Times are the venue's local times; PostgreSQL turns
 * them into instants, daylight saving time included. Start times the event already has are
 * skipped, so the same batch can be sent again safely. Nothing existing is changed.
 */
export const MAX_BATCH_SESSIONS = 1000;

export interface SessionBatch {
  fromDate: string;
  toDate: string;
  weekdays?: number[] | undefined;
  firstStart: string;
  lastStart?: string | undefined;
  everyMinutes?: number | undefined;
  durationMinutes?: number | null | undefined;
  capacity: number;
  status: "draft" | "on_sale";
  dryRun: boolean;
}

const DAY_MS = 86_400_000;
const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** The local start times ("YYYY-MM-DD HH:MM") a batch asks for, in calendar order. */
export function localStarts(b: Pick<SessionBatch, "fromDate" | "toDate" | "weekdays" | "firstStart" | "lastStart" | "everyMinutes">): string[] {
  const first = minutes(b.firstStart);
  const last = b.lastStart ? minutes(b.lastStart) : first;
  const times: string[] = [];
  for (let m = first; m <= last; m += b.everyMinutes ?? 1440) times.push(hhmm(m));
  const weekdays = b.weekdays ? new Set(b.weekdays) : null;
  const out: string[] = [];
  for (let t = Date.parse(`${b.fromDate}T00:00:00Z`); t <= Date.parse(`${b.toDate}T00:00:00Z`); t += DAY_MS) {
    const day = new Date(t);
    const isoWeekday = ((day.getUTCDay() + 6) % 7) + 1;
    if (weekdays && !weekdays.has(isoWeekday)) continue;
    const date = day.toISOString().slice(0, 10);
    for (const time of times) {
      out.push(`${date} ${time}`);
      if (out.length > MAX_BATCH_SESSIONS) throw new DomainError("too_many_sessions", { max: MAX_BATCH_SESSIONS });
    }
  }
  return out;
}

function checkTimeZone(timeZone: string) {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone });
  } catch {
    throw new DomainError("venue_time_zone_invalid");
  }
}

export async function createSessionBatch(db: Db, s: TenantScope, eventId: string, b: SessionBatch, actor: { type: "user"; id: string | null }) {
  const local = localStarts(b);
  return withTransaction(db, async (tx) => {
    // The event row is locked so two batches for the same event run one after the other.
    const { rows: ev } = await tx.query<{ timezone: string }>(
      `SELECT v.timezone FROM public.ticketing_events e
       JOIN public.ticketing_venues v ON v.id = e.venue_id AND v.client_id = e.client_id AND v.brand_id = e.brand_id
       WHERE e.id = $1 AND e.client_id = $2 AND e.brand_id = $3
       FOR UPDATE OF e`,
      [eventId, s.clientId, s.brandId],
    );
    const timeZone = ev[0]?.timezone;
    if (!timeZone) throw new DomainError("event_not_found");
    checkTimeZone(timeZone);

    // Two local times can be the same instant (a time skipped when clocks go forward): DISTINCT.
    const { rows: wanted } = await tx.query<{ starts_at: Date; ends_at: Date | null; taken: boolean }>(
      `WITH wanted AS (
         SELECT DISTINCT (l::timestamp AT TIME ZONE $4) AS starts_at FROM unnest($5::text[]) AS l
       )
       SELECT w.starts_at,
              CASE WHEN $6::int IS NULL THEN NULL ELSE w.starts_at + make_interval(mins => $6::int) END AS ends_at,
              EXISTS (SELECT 1 FROM public.ticketing_sessions x
                      WHERE x.event_id = $1 AND x.client_id = $2 AND x.brand_id = $3 AND x.starts_at = w.starts_at) AS taken
       FROM wanted w ORDER BY w.starts_at`,
      [eventId, s.clientId, s.brandId, timeZone, local, b.durationMinutes ?? null],
    );
    const fresh = wanted.filter((w) => !w.taken);
    const summary = { timeZone, requested: wanted.length, skipped: wanted.length - fresh.length };
    if (b.dryRun) {
      return { ...summary, created: 0, sessions: fresh.map((w) => ({ startsAt: w.starts_at.toISOString(), endsAt: w.ends_at?.toISOString() ?? null })) };
    }

    const { rows: created } = await tx.query<{ id: string; starts_at: Date; ends_at: Date | null }>(
      `INSERT INTO public.ticketing_sessions (client_id, brand_id, event_id, starts_at, ends_at, capacity, status)
       SELECT $2, $3, $1, x.starts_at, x.ends_at, $6, $7
       FROM unnest($4::timestamptz[], $5::timestamptz[]) AS x(starts_at, ends_at)
       ON CONFLICT (event_id, starts_at) DO NOTHING
       RETURNING id, starts_at, ends_at`,
      [eventId, s.clientId, s.brandId, fresh.map((w) => w.starts_at), fresh.map((w) => w.ends_at), b.capacity, b.status],
    );
    created.sort((x, y) => x.starts_at.getTime() - y.starts_at.getTime());
    await writeAudit(tx, s, actor, "sessions.batch_created", { type: "event", id: eventId }, {
      fromDate: b.fromDate, toDate: b.toDate, weekdays: b.weekdays ?? null, firstStart: b.firstStart, lastStart: b.lastStart ?? b.firstStart,
      everyMinutes: b.everyMinutes ?? null, durationMinutes: b.durationMinutes ?? null, capacity: b.capacity, status: b.status,
      created: created.length, skipped: wanted.length - created.length,
    });
    return {
      ...summary,
      skipped: wanted.length - created.length,
      created: created.length,
      sessions: created.map((r) => ({ id: r.id, startsAt: r.starts_at.toISOString(), endsAt: r.ends_at?.toISOString() ?? null })),
    };
  });
}

/**
 * Put every upcoming session of an event that is in `from` into `to` (on sale, or paused).
 * Cancelled and closed sessions never move; a session cancellation keeps its own route.
 */
export async function setUpcomingSessionsStatus(
  db: Db, s: TenantScope, eventId: string, b: { from: "draft" | "on_sale" | "paused"; to: "on_sale" | "paused" },
  actor: { type: "user"; id: string | null }, now = new Date(),
) {
  return withTransaction(db, async (tx) => {
    const { rows: ev } = await tx.query(
      `SELECT 1 FROM public.ticketing_events WHERE id = $1 AND client_id = $2 AND brand_id = $3 FOR SHARE`,
      [eventId, s.clientId, s.brandId],
    );
    if (!ev[0]) throw new DomainError("event_not_found");
    const { rows } = await tx.query<{ id: string }>(
      `UPDATE public.ticketing_sessions SET status = $5
       WHERE event_id = $1 AND client_id = $2 AND brand_id = $3 AND status = $4 AND starts_at > $6
       RETURNING id`,
      [eventId, s.clientId, s.brandId, b.from, b.to, now],
    );
    await writeAudit(tx, s, actor, "sessions.status_batch_changed", { type: "event", id: eventId }, { from: b.from, to: b.to, sessions: rows.length });
    return { updated: rows.length };
  });
}
