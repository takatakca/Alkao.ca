import type { TenantScope } from "../db/commerce.js";
import { APPEARANCE_COLUMNS, appearanceOf, type LookRow } from "../db/appearance.js";
import { withTransaction, type Db } from "../db/pool.js";
import { EmailSendError, type EmailSender } from "./email.js";
import { waitlistEmail } from "./templates.js";

/**
 * Run 71: the waitlist of sold-out sessions. A buyer leaves an address when a session is full;
 * when seats come back, the people waiting get one e-mail each, oldest first, and the seats
 * go to whoever buys first. Entries are deleted 30 days after their session.
 */
const MAX_ATTEMPTS = 5;
const KEEP_DAYS = 30;
const backoffMs = (attempt: number) => Math.min(60, 2 ** attempt) * 60_000;

/** Seats a session can sell now (holds past their deadline do not count as taken). */
const FREE_SEATS = `GREATEST(se.capacity - se.sold_count - (se.reserved_count - coalesce((
  SELECT sum(h.quantity) FROM public.ticketing_holds h
  WHERE h.session_id = se.id AND h.status = 'active' AND h.expires_at <= $1), 0)), 0)`;

export type JoinResult = "joined" | "session_not_found" | "session_not_full";

/** Add an address to a full, upcoming session on sale. Joining twice changes nothing. */
export async function joinWaitlist(db: Db, s: TenantScope, sessionId: string, p: { email: string; language: "fr" | "en" }, now: Date): Promise<JoinResult> {
  return withTransaction(db, async (tx) => {
    const { rows } = await tx.query<{ event_id: string; free: number }>(
      `SELECT se.event_id, ${FREE_SEATS}::int AS free
       FROM public.ticketing_sessions se
       JOIN public.ticketing_events e ON e.id = se.event_id AND e.client_id = se.client_id AND e.brand_id = se.brand_id
       WHERE se.id = $2 AND se.client_id = $3 AND se.brand_id = $4 AND se.status = 'on_sale' AND se.starts_at > $1 AND e.status = 'published'`,
      [now, sessionId, s.clientId, s.brandId],
    );
    const session = rows[0];
    if (!session) return "session_not_found";
    if (session.free > 0) return "session_not_full";
    await tx.query(
      `INSERT INTO public.ticketing_waitlist (client_id, brand_id, event_id, session_id, email, language, created_at, next_attempt_at)
       VALUES ($1, $2, $3, $4, lower(btrim($5)), $6, $7, $7)
       ON CONFLICT (session_id, email) WHERE status = 'waiting' DO NOTHING`,
      [s.clientId, s.brandId, session.event_id, sessionId, p.email, p.language, now],
    );
    return "joined";
  });
}

/** How many people wait for each session of an event (for /ops). */
export async function waitingCounts(db: Db, s: TenantScope, eventId: string): Promise<Map<string, number>> {
  const { rows } = await db.query<{ session_id: string; n: number }>(
    `SELECT session_id, count(*)::int AS n FROM public.ticketing_waitlist
     WHERE client_id = $1 AND brand_id = $2 AND event_id = $3 AND status = 'waiting' GROUP BY session_id`,
    [s.clientId, s.brandId, eventId],
  );
  return new Map(rows.map((r) => [r.session_id, r.n]));
}

export interface WaitlistDeliveryConfig {
  sender: EmailSender;
  publicUrl: string;
}

/** Expire what can no longer be served, purge old entries, then e-mail the people waiting for seats that are back. */
export async function notifyWaitlists(db: Db, cfg: WaitlistDeliveryConfig, now = new Date(), limit = 50) {
  const result = { sent: 0, expired: 0, retried: 0, failed: 0, purged: 0 };
  const expired = await db.query(
    `UPDATE public.ticketing_waitlist w SET status = 'expired'
     FROM public.ticketing_sessions se
     WHERE w.status = 'waiting' AND se.id = w.session_id AND (se.starts_at <= $1 OR se.status IN ('cancelled', 'closed'))`,
    [now],
  );
  result.expired = expired.rowCount ?? 0;
  const purged = await db.query(
    `DELETE FROM public.ticketing_waitlist w USING public.ticketing_sessions se
     WHERE se.id = w.session_id AND se.starts_at < $1::timestamptz - make_interval(days => ${KEEP_DAYS})`,
    [now],
  );
  result.purged = purged.rowCount ?? 0;

  for (let i = 0; i < limit; i++) {
    const outcome = await withTransaction(db, async (tx) => {
      // The oldest person waiting for a session on sale that has seats again.
      const { rows } = await tx.query<LookRow & {
        id: string; email: string; language: "fr" | "en"; attempts: number; client_id: string; brand_id: string; event_id: string;
        title: string; starts_at: Date; timezone: string | null; venue: string | null; city: string | null; brand_name: string;
      }>(
        `SELECT w.id, w.email, w.language, w.attempts, w.client_id, w.brand_id, w.event_id,
                e.title, se.starts_at, v.timezone, v.name AS venue, v.city, br.name AS brand_name, ${APPEARANCE_COLUMNS}
         FROM public.ticketing_waitlist w
         JOIN public.ticketing_sessions se ON se.id = w.session_id AND se.client_id = w.client_id AND se.brand_id = w.brand_id
         JOIN public.ticketing_events e ON e.id = w.event_id AND e.client_id = w.client_id AND e.brand_id = w.brand_id
         JOIN public.ticketing_venues v ON v.id = e.venue_id AND v.client_id = e.client_id AND v.brand_id = e.brand_id
         JOIN public.ticketing_brands br ON br.id = w.brand_id AND br.client_id = w.client_id
         LEFT JOIN public.ticketing_brand_settings bs ON bs.client_id = w.client_id AND bs.brand_id = w.brand_id
         WHERE w.status = 'waiting' AND w.next_attempt_at <= $1 AND se.status = 'on_sale' AND se.starts_at > $1
           AND e.status = 'published' AND ${FREE_SEATS} > 0
         ORDER BY w.created_at, w.id LIMIT 1 FOR UPDATE OF w SKIP LOCKED`,
        [now],
      );
      const row = rows[0];
      if (!row) return null;
      const locale = row.language === "en" ? "en-CA" : "fr-CA";
      const content = waitlistEmail({
        language: row.language,
        brandName: row.brand_name,
        eventTitle: row.title,
        when: new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "short", timeZone: row.timezone || "America/Toronto" }).format(row.starts_at),
        place: [row.venue, row.city].filter(Boolean).join(", ") || null,
        shopUrl: new URL(`/acheter/${row.client_id}/${row.brand_id}/${row.event_id}${row.language === "en" ? "?lang=en" : ""}`, cfg.publicUrl).toString(),
        look: appearanceOf(row),
      });
      try {
        const messageId = await cfg.sender.send({ ...content, to: row.email, idempotencyKey: `alkao-waitlist-${row.id}` });
        await tx.query(
          `UPDATE public.ticketing_waitlist SET status = 'notified', notified_at = $2, attempts = attempts + 1, provider_message_id = $3, last_error = NULL WHERE id = $1`,
          [row.id, now, messageId],
        );
        return "sent" as const;
      } catch (error) {
        const retryable = error instanceof EmailSendError ? error.retryable : true;
        const attempts = row.attempts + 1;
        const giveUp = !retryable || attempts >= MAX_ATTEMPTS;
        await tx.query(
          `UPDATE public.ticketing_waitlist SET status = $2, attempts = $3, next_attempt_at = $4, last_error = left($5, 500) WHERE id = $1`,
          [row.id, giveUp ? "failed" : "waiting", attempts, new Date(now.getTime() + backoffMs(attempts)), String((error as Error).message ?? error)],
        );
        return giveUp ? ("failed" as const) : ("retried" as const);
      }
    });
    if (!outcome) break;
    result[outcome]++;
  }
  return result;
}
