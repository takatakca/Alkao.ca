import { withTransaction, type Db } from "../db/pool.js";
import { EmailSendError, type EmailSender } from "./email.js";
import { emailLinkToken, ticketsUrl, tokenHash } from "./links.js";
import { ticketsEmail } from "./templates.js";

export interface DeliveryConfig {
  sender: EmailSender;
  /** Public HTTPS origin of ALKAO, where /billets is served. */
  publicUrl: string;
  credentialMasterSecret: string;
  /** Emails queued longer ago than this are skipped, never sent late (default 72 h). */
  maxAgeHours?: number;
  maxAttempts?: number;
}

export interface DeliveryResult {
  sent: number;
  skipped: number;
  retried: number;
  failed: number;
}

const backoffMs = (attempts: number) => Math.min(60_000 * 2 ** attempts, 6 * 3600_000);

interface DueRow {
  id: string;
  client_id: string;
  brand_id: string;
  order_id: string;
  kind: "order_tickets" | "exchange_tickets";
  attempts: number;
  created_at: Date;
  reference: string;
  order_status: string;
  email: string;
  full_name: string | null;
  brand_name: string;
  event_title: string;
  starts_at: Date;
  venue_name: string;
  city: string | null;
  timezone: string;
  valid_tickets: number;
}

/**
 * Send due ticket emails, one row per transaction (FOR UPDATE SKIP LOCKED: several workers
 * never send the same row). A row is skipped, not sent, if the order no longer has a valid
 * ticket (refunded meanwhile) or if it waited longer than maxAgeHours.
 */
export async function deliverTicketEmails(db: Db, cfg: DeliveryConfig, now = new Date(), limit = 50): Promise<DeliveryResult> {
  const result: DeliveryResult = { sent: 0, skipped: 0, retried: 0, failed: 0 };
  const maxAgeMs = (cfg.maxAgeHours ?? 72) * 3600_000;
  const maxAttempts = cfg.maxAttempts ?? 8;
  for (let i = 0; i < limit; i++) {
    const outcome = await withTransaction(db, async (tx) => {
      const { rows } = await tx.query<DueRow>(
        `SELECT x.id, x.client_id, x.brand_id, x.order_id, x.kind, x.attempts, x.created_at,
                o.reference, o.status AS order_status, b.email, b.full_name, br.name AS brand_name,
                e.title AS event_title, s.starts_at, v.name AS venue_name, v.city, v.timezone,
                (SELECT count(*)::int FROM public.ticketing_tickets t
                  WHERE t.order_id = o.id AND t.client_id = o.client_id AND t.brand_id = o.brand_id AND t.status = 'valid') AS valid_tickets
         FROM public.ticketing_email_outbox x
         JOIN public.ticketing_orders o ON o.id = x.order_id AND o.client_id = x.client_id AND o.brand_id = x.brand_id
         JOIN public.ticketing_buyers b ON b.id = o.buyer_id AND b.client_id = o.client_id AND b.brand_id = o.brand_id
         JOIN public.ticketing_brands br ON br.id = x.brand_id AND br.client_id = x.client_id
         JOIN public.ticketing_events e ON e.id = o.event_id AND e.client_id = o.client_id AND e.brand_id = o.brand_id
         JOIN public.ticketing_sessions s ON s.id = o.session_id AND s.client_id = o.client_id AND s.brand_id = o.brand_id
         JOIN public.ticketing_venues v ON v.id = e.venue_id AND v.client_id = e.client_id AND v.brand_id = e.brand_id
         WHERE x.status = 'pending' AND x.next_attempt_at <= $1
         ORDER BY x.next_attempt_at, x.id
         LIMIT 1
         FOR UPDATE OF x SKIP LOCKED`,
        [now],
      );
      const row = rows[0];
      if (!row) return null;
      const skip = async (reason: string) => {
        await tx.query(`UPDATE public.ticketing_email_outbox SET status = 'skipped', last_error = $2 WHERE id = $1`, [row.id, reason]);
        return "skipped" as const;
      };
      if (now.getTime() - row.created_at.getTime() > maxAgeMs) return skip("too_old");
      if (!["paid", "partially_refunded"].includes(row.order_status) || row.valid_tickets === 0) return skip("no_valid_ticket");

      const token = emailLinkToken(cfg.credentialMasterSecret, row.id);
      await tx.query(
        `INSERT INTO public.ticketing_access_tokens (token_hash, client_id, brand_id, subject_type, subject_id, purpose)
         VALUES ($1, $2, $3, 'order', $4, 'email')
         ON CONFLICT (subject_type, subject_id, purpose) DO UPDATE SET token_hash = EXCLUDED.token_hash`,
        [tokenHash(token), row.client_id, row.brand_id, row.order_id],
      );
      const content = ticketsEmail({
        kind: row.kind,
        brandName: row.brand_name,
        buyerName: row.full_name,
        reference: row.reference,
        eventTitle: row.event_title,
        startsAt: row.starts_at,
        venueName: row.venue_name,
        city: row.city,
        timezone: row.timezone,
        validTickets: row.valid_tickets,
        link: ticketsUrl(cfg.publicUrl, { clientId: row.client_id, brandId: row.brand_id, orderId: row.order_id, token }),
      });
      try {
        const messageId = await cfg.sender.send({ ...content, to: row.email, idempotencyKey: `alkao-email-${row.id}-${row.attempts}` });
        await tx.query(
          `UPDATE public.ticketing_email_outbox
           SET status = 'sent', sent_at = $2, attempts = attempts + 1, provider_message_id = $3, last_error = NULL WHERE id = $1`,
          [row.id, now, messageId],
        );
        return "sent" as const;
      } catch (error) {
        const retryable = error instanceof EmailSendError ? error.retryable : true;
        const attempts = row.attempts + 1;
        const giveUp = !retryable || attempts >= maxAttempts;
        await tx.query(
          `UPDATE public.ticketing_email_outbox
           SET status = $2, attempts = $3, next_attempt_at = $4, last_error = left($5, 500) WHERE id = $1`,
          [row.id, giveUp ? "failed" : "pending", attempts, new Date(now.getTime() + backoffMs(attempts)), String((error as Error).message ?? error)],
        );
        return giveUp ? ("failed" as const) : ("retried" as const);
      }
    });
    if (!outcome) break;
    result[outcome]++;
  }
  return result;
}

/** Deliver on an interval until stopped. */
export function startEmailWorker(db: Db, cfg: DeliveryConfig, intervalMs: number, log: (msg: string) => void = console.log): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await deliverTicketEmails(db, cfg);
      if (r.sent + r.skipped + r.retried + r.failed > 0) log(`alkao email: ${JSON.stringify(r)}`);
    } catch (error) {
      log(`alkao email: ${(error as Error).message}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  void tick();
  return () => clearInterval(timer);
}
