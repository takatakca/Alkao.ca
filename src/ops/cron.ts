import type { Db } from "../db/pool.js";
import { queueReminders } from "../delivery/reminders.js";
import { deliverCampaignEmails } from "../delivery/campaigns.js";
import { deliverSignupConfirmations } from "../delivery/newsletter.js";
import { deliverTicketEmails, type DeliveryConfig } from "../delivery/worker.js";
import type { PaymentsService } from "../payments/service.js";
import { advanceCancellations } from "./cancellation.js";
import { syncTicketBuyers } from "./customer-sync.js";
import { sweepExpiredHolds } from "./sweeper.js";

/**
 * Run 39: one pass of every background worker, for hosts without long-running processes
 * (MochaHost cPanel: a cron job every minute). The same work as worker:sweeper,
 * worker:email and worker:cancellations, in that order.
 *
 * Runs that overlap (a slow pass, cron firing again) do nothing: a session-level advisory
 * lock lets one pass work at a time. Each step is safe to repeat anyway.
 */
export interface CronDeps {
  /** Without it (no Resend settings), emails wait in the queue. */
  email: DeliveryConfig | null;
  /** Without it (no Stripe keys), cancellations wait. */
  payments: PaymentsService | null;
}

export interface CronResult {
  ran: boolean;
  expiredHolds: number;
  remindersQueued: number;
  emails: { sent: number; skipped: number; retried: number; failed: number } | null;
  /** Run 42: campaign messages, after the buyers' emails; `finished` campaigns marked sent. */
  campaignEmails: { sent: number; skipped: number; retried: number; failed: number; finished: number } | null;
  /** Run 44: newsletter sign-up confirmations. */
  signupEmails: { sent: number; skipped: number; retried: number; failed: number } | null;
  cancellationJobs: number | null;
  /** Run 43: ticket orders brought into the customer file. */
  customersSynced: number;
}

const LOCK = "alkao_cron";

export async function runBackgroundOnce(db: Db, deps: CronDeps, now = new Date()): Promise<CronResult> {
  const result: CronResult = { ran: false, expiredHolds: 0, remindersQueued: 0, emails: null, campaignEmails: null, signupEmails: null, cancellationJobs: null, customersSynced: 0 };
  const lock = await db.connect();
  try {
    const { rows } = await lock.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(hashtext($1)) AS ok`, [LOCK]);
    if (!rows[0]!.ok) return result;
    try {
      result.ran = true;
      result.expiredHolds = await sweepExpiredHolds(db, now);
      result.customersSynced = await syncTicketBuyers(db, now);
      if (deps.email) {
        result.remindersQueued = await queueReminders(db, now);
        const r = await deliverTicketEmails(db, deps.email, now);
        result.emails = { sent: r.sent, skipped: r.skipped, retried: r.retried, failed: r.failed };
        result.signupEmails = await deliverSignupConfirmations(db, deps.email, now);
        result.campaignEmails = await deliverCampaignEmails(db, deps.email, now);
      }
      if (deps.payments) result.cancellationJobs = await advanceCancellations(db, deps.payments);
    } finally {
      await lock.query(`SELECT pg_advisory_unlock(hashtext($1))`, [LOCK]);
    }
  } finally {
    lock.release();
  }
  return result;
}
