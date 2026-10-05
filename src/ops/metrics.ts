import type { Db } from "../db/pool.js";

/**
 * Run 24: platform health in the Prometheus text format, for the uptime and alerting
 * service. Platform-wide counts only: no Client, Brand, buyer or amount ever appears.
 *
 * The ones to alert on (see docs/ALKAO_RUNBOOK.md):
 *   alkao_email_oldest_due_seconds > 600       the email worker is down or failing
 *   alkao_holds_unswept_total > 0 for 10 min   the sweeper is down
 *   alkao_refunds_stuck_total > 0              Stripe refused or never settled a refund
 *   alkao_payment_events_total{outcome="ignored"} rising fast   webhook or account problem
 */
export async function collectMetrics(db: Db, now = new Date()): Promise<string> {
  const { rows } = await db.query<Record<string, number | null>>(
    `SELECT
       (SELECT count(*) FROM public.ticketing_email_outbox WHERE status = 'pending')::int AS email_pending,
       (SELECT extract(epoch FROM $1::timestamptz - min(next_attempt_at)) FROM public.ticketing_email_outbox
         WHERE status = 'pending' AND next_attempt_at <= $1)::float AS email_oldest_due,
       (SELECT count(*) FROM public.ticketing_email_outbox WHERE status = 'failed' AND updated_at > $1::timestamptz - interval '24 hours')::int AS email_failed_24h,
       (SELECT count(*) FROM public.ticketing_email_outbox WHERE status = 'sent' AND sent_at > $1::timestamptz - interval '24 hours')::int AS email_sent_24h,
       (SELECT count(*) FROM public.ticketing_refunds WHERE status = 'pending')::int AS refunds_pending,
       (SELECT count(*) FROM public.ticketing_refunds WHERE status = 'pending'
         AND (last_error IS NOT NULL OR created_at < $1::timestamptz - interval '15 minutes'))::int AS refunds_stuck,
       (SELECT count(*) FROM public.ticketing_holds WHERE status = 'active')::int AS holds_active,
       (SELECT count(*) FROM public.ticketing_holds WHERE status = 'active' AND expires_at < $1::timestamptz - interval '5 minutes')::int AS holds_unswept,
       (SELECT count(*) FROM public.ticketing_session_cancellations WHERE status = 'running')::int AS cancellations_running,
       (SELECT count(*) FROM public.ticketing_session_cancellation_orders i WHERE i.status = 'failed'
         AND NOT EXISTS (SELECT 1 FROM public.ticketing_refunds r WHERE r.id = i.refund_id AND r.status = 'succeeded'))::int AS cancellation_orders_failed,
       (SELECT count(*) FROM public.ticketing_payment_disputes
         WHERE status NOT IN ('won', 'lost', 'warning_closed', 'prevented'))::int AS disputes_open,
       (SELECT count(*) FROM public.ticketing_orders WHERE paid_at > $1::timestamptz - interval '24 hours')::int AS orders_paid_24h,
       (SELECT count(*) FROM public.ticketing_payment_events WHERE outcome = 'processed' AND received_at > $1::timestamptz - interval '1 hour')::int AS events_processed_1h,
       (SELECT count(*) FROM public.ticketing_payment_events WHERE outcome = 'ignored' AND received_at > $1::timestamptz - interval '1 hour')::int AS events_ignored_1h,
       (SELECT count(*) FROM public.ticketing_scans WHERE result = 'admitted' AND received_at > $1::timestamptz - interval '5 minutes')::int AS scans_admitted_5m,
       (SELECT count(*) FROM public.ticketing_scans WHERE result <> 'admitted' AND received_at > $1::timestamptz - interval '5 minutes')::int AS scans_refused_5m`,
    [now],
  );
  const m = rows[0]!;
  const lines: string[] = [];
  const gauge = (name: string, help: string, samples: [labels: string, value: number | null | undefined][]) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
    for (const [labels, value] of samples) lines.push(`${name}${labels} ${Number(value ?? 0)}`);
  };
  gauge("alkao_up", "1 when ALKAO and its database answer.", [["", 1]]);
  gauge("alkao_email_pending_total", "Emails waiting to be sent.", [["", m.email_pending]]);
  gauge("alkao_email_oldest_due_seconds", "How long the oldest due email has waited (0 when none).", [["", Math.max(0, Math.round(m.email_oldest_due ?? 0))]]);
  gauge("alkao_email_failed_24h", "Emails given up on in the last 24 hours.", [["", m.email_failed_24h]]);
  gauge("alkao_email_sent_24h", "Emails sent in the last 24 hours.", [["", m.email_sent_24h]]);
  gauge("alkao_refunds_pending_total", "Refunds not yet settled by Stripe.", [["", m.refunds_pending]]);
  gauge("alkao_refunds_stuck_total", "Pending refunds Stripe failed on, or older than 15 minutes.", [["", m.refunds_stuck]]);
  gauge("alkao_holds_active_total", "Seat holds currently active.", [["", m.holds_active]]);
  gauge("alkao_holds_unswept_total", "Active holds expired for more than 5 minutes (sweeper behind).", [["", m.holds_unswept]]);
  gauge("alkao_cancellations_running_total", "Session cancellations still refunding buyers.", [["", m.cancellations_running]]);
  gauge("alkao_cancellation_orders_failed_total", "Orders a session cancellation could not refund.", [["", m.cancellation_orders_failed]]);
  gauge("alkao_disputes_open_total", "Open Stripe disputes.", [["", m.disputes_open]]);
  gauge("alkao_orders_paid_24h", "Orders paid in the last 24 hours.", [["", m.orders_paid_24h]]);
  gauge("alkao_payment_events_total", "Stripe webhook events received in the last hour.", [
    ['{outcome="processed"}', m.events_processed_1h],
    ['{outcome="ignored"}', m.events_ignored_1h],
  ]);
  gauge("alkao_scans_5m", "Gate scans in the last 5 minutes.", [
    ['{result="admitted"}', m.scans_admitted_5m],
    ['{result="refused"}', m.scans_refused_5m],
  ]);
  return `${lines.join("\n")}\n`;
}
