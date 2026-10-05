import type { TenantScope } from "../db/commerce.js";
import type { Db, Tx } from "../db/pool.js";

/**
 * Run 23: a reminder email before the session, with the buyer's tickets link. One per order,
 * queued during the 24 hours before the session starts, unless the order was paid in the
 * last 12 hours (the tickets email just went out), the Brand turned reminders off, the order
 * holds no valid ticket, or the buyer was anonymized.
 */
export const REMINDER_HOURS_BEFORE = 24;
export const REMINDER_MIN_HOURS_SINCE_PAID = 12;

/** Queue the reminders now due. Safe to run as often as wanted: one reminder per order, ever. */
export async function queueReminders(db: Db, now = new Date()): Promise<number> {
  const r = await db.query(
    `INSERT INTO public.ticketing_email_outbox (client_id, brand_id, event_id, order_id, kind)
     SELECT o.client_id, o.brand_id, o.event_id, o.id, 'reminder'
     FROM public.ticketing_sessions se
     JOIN public.ticketing_orders o ON o.session_id = se.id AND o.client_id = se.client_id AND o.brand_id = se.brand_id
     LEFT JOIN public.ticketing_brand_settings bs ON bs.client_id = o.client_id AND bs.brand_id = o.brand_id
     WHERE se.status IN ('on_sale', 'paused', 'closed')
       AND se.starts_at > $1 AND se.starts_at <= $1::timestamptz + make_interval(hours => ${REMINDER_HOURS_BEFORE})
       AND o.status IN ('paid', 'partially_refunded')
       AND o.paid_at < $1::timestamptz - make_interval(hours => ${REMINDER_MIN_HOURS_SINCE_PAID})
       AND coalesce(bs.reminder_emails, true)
       AND EXISTS (SELECT 1 FROM public.ticketing_tickets k WHERE k.order_id = o.id AND k.status = 'valid')
       AND NOT EXISTS (SELECT 1 FROM public.ticketing_buyer_erasures e WHERE e.buyer_id = o.buyer_id)
     ON CONFLICT (order_id, kind, refund_id) DO NOTHING`,
    [now],
  );
  return r.rowCount ?? 0;
}

export async function getReminderSetting(q: Db | Tx, s: TenantScope): Promise<boolean> {
  const { rows } = await q.query<{ on: boolean }>(
    `SELECT reminder_emails AS on FROM public.ticketing_brand_settings WHERE client_id = $1 AND brand_id = $2`,
    [s.clientId, s.brandId],
  );
  return rows[0]?.on ?? true;
}

export async function setReminderSetting(q: Db | Tx, s: TenantScope, on: boolean): Promise<boolean> {
  const { rows } = await q.query<{ on: boolean }>(
    `INSERT INTO public.ticketing_brand_settings (client_id, brand_id, reminder_emails) VALUES ($1, $2, $3)
     ON CONFLICT (client_id, brand_id) DO UPDATE SET reminder_emails = EXCLUDED.reminder_emails
     RETURNING reminder_emails AS on`,
    [s.clientId, s.brandId, on],
  );
  return rows[0]!.on;
}
