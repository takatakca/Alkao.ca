import { withTransaction, type Db } from "../db/pool.js";
import { EmailSendError, type EmailMessage, type EmailSender } from "./email.js";
import { orderEmailToken, ticketsUrl } from "./links.js";
import { deliverCampaignEmails } from "./campaigns.js";
import { queueReminders } from "./reminders.js";
import { refundEmail, reminderEmail, sessionCancelledEmail, ticketsEmail } from "./templates.js";

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
  kind: "order_tickets" | "exchange_tickets" | "session_cancelled" | "refund" | "reminder";
  attempts: number;
  created_at: Date;
  reference: string;
  order_status: string;
  email: string;
  full_name: string | null;
  language: "fr" | "en";
  brand_name: string;
  event_title: string;
  starts_at: Date;
  venue_name: string;
  city: string | null;
  timezone: string;
  valid_tickets: number;
  cancel_refund_cents: number;
  buyer_anonymized: boolean;
  session_status: string;
  refund_amount_cents: number | null;
  refund_reason: string | null;
  refund_voided: number | null;
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
                o.reference, o.status AS order_status, b.email, b.full_name, b.language, br.name AS brand_name,
                e.title AS event_title, s.starts_at, v.name AS venue_name, v.city, v.timezone,
                (SELECT count(*)::int FROM public.ticketing_tickets t
                  WHERE t.order_id = o.id AND t.client_id = o.client_id AND t.brand_id = o.brand_id AND t.status = 'valid') AS valid_tickets,
                coalesce((SELECT i.amount_cents FROM public.ticketing_session_cancellation_orders i
                  WHERE i.order_id = coalesce(o.exchange_of_order_id, o.id) AND i.client_id = o.client_id AND i.brand_id = o.brand_id
                  ORDER BY i.created_at DESC LIMIT 1), 0)::int AS cancel_refund_cents,
                r.amount_cents AS refund_amount_cents, r.reason AS refund_reason, cardinality(r.void_ticket_ids) AS refund_voided,
                EXISTS (SELECT 1 FROM public.ticketing_buyer_erasures be WHERE be.buyer_id = b.id) AS buyer_anonymized,
                s.status AS session_status
         FROM public.ticketing_email_outbox x
         LEFT JOIN public.ticketing_refunds r ON r.id = x.refund_id AND r.client_id = x.client_id AND r.brand_id = x.brand_id
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
      // Run 20: an anonymized buyer has no address left; never write to it.
      if (row.buyer_anonymized) return skip("buyer_anonymized");
      const send = async (content: Omit<EmailMessage, "to" | "idempotencyKey">) => {
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
      };
      if (row.kind === "session_cancelled") {
        return send(sessionCancelledEmail({
          language: row.language, brandName: row.brand_name, buyerName: row.full_name, reference: row.reference, eventTitle: row.event_title,
          startsAt: row.starts_at, venueName: row.venue_name, city: row.city, timezone: row.timezone, refundedCents: row.cancel_refund_cents,
        }));
      }
      const personalLink = async () => {
        const scope = { clientId: row.client_id, brandId: row.brand_id };
        const token = await orderEmailToken(tx, cfg.credentialMasterSecret, scope, row.order_id);
        return ticketsUrl(cfg.publicUrl, { ...scope, orderId: row.order_id, token });
      };
      if (row.kind === "refund") {
        return send(refundEmail({
          language: row.language, brandName: row.brand_name, buyerName: row.full_name, reference: row.reference, eventTitle: row.event_title,
          amountCents: row.refund_amount_cents ?? 0, reason: row.refund_reason, voidedTickets: row.refund_voided ?? 0,
          validTickets: row.valid_tickets, link: row.valid_tickets > 0 ? await personalLink() : null,
        }));
      }
      if (!["paid", "partially_refunded"].includes(row.order_status) || row.valid_tickets === 0) return skip("no_valid_ticket");
      if (row.kind === "reminder") {
        // Run 23: too late once the session has started, pointless if it was cancelled.
        if (row.session_status === "cancelled") return skip("session_cancelled");
        if (row.starts_at.getTime() <= now.getTime()) return skip("session_started");
        return send(reminderEmail({
          language: row.language, brandName: row.brand_name, buyerName: row.full_name, reference: row.reference, eventTitle: row.event_title,
          startsAt: row.starts_at, venueName: row.venue_name, city: row.city, timezone: row.timezone, validTickets: row.valid_tickets,
          link: await personalLink(),
        }));
      }
      const link = await personalLink();
      const content = ticketsEmail({
        kind: row.kind,
        language: row.language,
        brandName: row.brand_name,
        buyerName: row.full_name,
        reference: row.reference,
        eventTitle: row.event_title,
        startsAt: row.starts_at,
        venueName: row.venue_name,
        city: row.city,
        timezone: row.timezone,
        validTickets: row.valid_tickets,
        link,
      });
      return send(content);
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
      const queued = await queueReminders(db);
      if (queued > 0) log(`alkao email: ${queued} reminder(s) queued`);
      const r = await deliverTicketEmails(db, cfg);
      if (r.sent + r.skipped + r.retried + r.failed > 0) log(`alkao email: ${JSON.stringify(r)}`);
      // Run 42: campaigns after the buyers' own emails, which never wait behind them.
      const c = await deliverCampaignEmails(db, cfg);
      if (c.sent + c.skipped + c.retried + c.failed + c.finished > 0) log(`alkao campaigns: ${JSON.stringify(c)}`);
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
