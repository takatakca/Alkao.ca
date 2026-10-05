import { toApi, writeAudit } from "../db/catalog.js";
import type { TenantScope } from "../db/commerce.js";
import { withTransaction, type Db } from "../db/pool.js";
import { DomainError } from "../domain/errors.js";
import type { PaymentsService } from "../payments/service.js";

/**
 * Organizer cancels a session (Run 10). The session stops selling at once; then, in
 * batches, every paying order is refunded in full (V1 policy: the TAKATAK commission is
 * refunded too), free tickets are voided, and each buyer gets a "séance annulée" email.
 *
 * Every affected order has its own row, so a crash or a Stripe failure never refunds twice
 * and never forgets anyone: the next batch picks up where the last one stopped.
 */

const SYSTEM = { type: "system" as const, id: null };
const MAX_ATTEMPTS = 10;

export interface CancellationProgress {
  id: string;
  sessionId: string;
  status: "running" | "completed";
  reason: string | null;
  createdAt: Date;
  completedAt: Date | null;
  orders: { total: number; pending: number; refunded: number; voided: number; skipped: number; failed: number };
  refundedCents: number;
  failures: { orderId: string; reference: string; lastError: string | null }[];
}

export async function getCancellation(db: Db, s: TenantScope, sessionId: string): Promise<CancellationProgress | null> {
  const { rows } = await db.query(
    `SELECT id, session_id, status, reason, created_at, completed_at FROM public.ticketing_session_cancellations
     WHERE session_id = $1 AND client_id = $2 AND brand_id = $3`,
    [sessionId, s.clientId, s.brandId],
  );
  const job = rows[0];
  if (!job) return null;
  const { rows: items } = await db.query<{ status: string; n: number; cents: number }>(
    `SELECT status, count(*)::int AS n, coalesce(sum(amount_cents), 0)::int AS cents
     FROM public.ticketing_session_cancellation_orders WHERE cancellation_id = $1 GROUP BY status`,
    [job.id],
  );
  const { rows: failures } = await db.query(
    `SELECT i.order_id, o.reference, i.last_error FROM public.ticketing_session_cancellation_orders i
     JOIN public.ticketing_orders o ON o.id = i.order_id
     WHERE i.cancellation_id = $1 AND i.status = 'failed' ORDER BY o.reference`,
    [job.id],
  );
  const count = (st: string) => items.find((i) => i.status === st)?.n ?? 0;
  return {
    id: job.id,
    sessionId: job.session_id,
    status: job.status,
    reason: job.reason,
    createdAt: job.created_at,
    completedAt: job.completed_at,
    orders: {
      total: items.reduce((n, i) => n + i.n, 0),
      pending: count("pending"),
      refunded: count("refunded"),
      voided: count("voided"),
      skipped: count("skipped"),
      failed: count("failed"),
    },
    refundedCents: items.find((i) => i.status === "refunded")?.cents ?? 0,
    failures: failures.map((f) => toApi(f) as CancellationProgress["failures"][number]),
  };
}

/** Stop the session's sales now and record the cancellation. Asking twice is harmless. */
export async function cancelSession(db: Db, s: TenantScope, sessionId: string, reason: string | null, actor: { type: "user"; id: string | null }) {
  return withTransaction(db, async (tx) => {
    const { rows } = await tx.query<{ event_id: string; status: string }>(
      `SELECT event_id, status FROM public.ticketing_sessions WHERE id = $1 AND client_id = $2 AND brand_id = $3 FOR UPDATE`,
      [sessionId, s.clientId, s.brandId],
    );
    const session = rows[0];
    if (!session) throw new DomainError("session_not_found");
    const { rows: created } = await tx.query<{ id: string }>(
      `INSERT INTO public.ticketing_session_cancellations (client_id, brand_id, event_id, session_id, reason, requested_by)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (session_id) DO NOTHING RETURNING id`,
      [s.clientId, s.brandId, session.event_id, sessionId, reason, actor.id],
    );
    if (session.status !== "cancelled") {
      await tx.query(`UPDATE public.ticketing_sessions SET status = 'cancelled' WHERE id = $1`, [sessionId]);
    }
    if (created[0]) {
      await writeAudit(tx, s, actor, "session.cancelled", { type: "session", id: sessionId }, { reason, cancellationId: created[0].id });
    }
  });
}

interface ItemRow {
  order_id: string;
  event_id: string;
  refund_id: string | null;
  attempts: number;
  total_cents: number;
  refunded_cents: number;
  payment_status: string | null;
}

/**
 * One batch of a cancellation: collect the affected orders, release open holds, then settle
 * up to `limit` orders. Returns the progress afterwards.
 */
export async function runCancellationBatch(db: Db, payments: PaymentsService, s: TenantScope, sessionId: string, limit = 10): Promise<CancellationProgress> {
  const { rows: jobs } = await db.query<{ id: string; status: string }>(
    `SELECT id, status FROM public.ticketing_session_cancellations WHERE session_id = $1 AND client_id = $2 AND brand_id = $3`,
    [sessionId, s.clientId, s.brandId],
  );
  const job = jobs[0];
  if (!job) throw new DomainError("cancellation_not_found");

  if (job.status === "running") {
    await withTransaction(db, async (tx) => {
      // Open holds stop counting at once. A checkout that completes later is refunded in full by
      // the webhook, because a cancelled session issues no ticket.
      await tx.query(
        `UPDATE public.ticketing_holds SET status = 'released' WHERE session_id = $1 AND client_id = $2 AND brand_id = $3 AND status = 'active'`,
        [sessionId, s.clientId, s.brandId],
      );
      // The orders holding a valid ticket for this session; for tickets moved here by a Flex
      // exchange, the original order, which holds the money.
      await tx.query(
        `INSERT INTO public.ticketing_session_cancellation_orders (cancellation_id, client_id, brand_id, event_id, order_id)
         SELECT DISTINCT $1::uuid, m.client_id, m.brand_id, m.event_id, m.id
         FROM public.ticketing_tickets t
         JOIN public.ticketing_orders o ON o.id = t.order_id AND o.client_id = t.client_id AND o.brand_id = t.brand_id
         JOIN public.ticketing_orders m ON m.id = coalesce(o.exchange_of_order_id, o.id) AND m.client_id = o.client_id AND m.brand_id = o.brand_id
         WHERE t.session_id = $2 AND t.client_id = $3 AND t.brand_id = $4 AND t.status = 'valid'
         ON CONFLICT DO NOTHING`,
        [job.id, sessionId, s.clientId, s.brandId],
      );
    });

    // Each order is tried at most once per batch: a Stripe failure waits for the next batch.
    const tried: string[] = [];
    for (let i = 0; i < limit; i++) {
      const done = await withTransaction(db, async (tx) => {
        const { rows } = await tx.query<ItemRow>(
          `SELECT i.order_id, i.event_id, i.refund_id, i.attempts, o.total_cents, o.refunded_cents, p.status AS payment_status
           FROM public.ticketing_session_cancellation_orders i
           JOIN public.ticketing_orders o ON o.id = i.order_id AND o.client_id = i.client_id AND o.brand_id = i.brand_id
           LEFT JOIN public.ticketing_payments p ON p.order_id = o.id AND p.client_id = o.client_id AND p.brand_id = o.brand_id AND p.status = 'paid'
           WHERE i.cancellation_id = $1 AND i.status = 'pending' AND i.order_id <> ALL($2::uuid[])
           ORDER BY i.created_at, i.order_id
           LIMIT 1
           FOR UPDATE OF i SKIP LOCKED`,
          [job.id, tried],
        );
        const item = rows[0];
        if (!item) return true;
        tried.push(item.order_id);
        const settle = (status: string, fields: { refundId?: string | null; amountCents?: number; error?: string | null } = {}) =>
          tx.query(
            `UPDATE public.ticketing_session_cancellation_orders
             SET status = $3, refund_id = coalesce($4, refund_id), amount_cents = coalesce($5, amount_cents), last_error = $6, attempts = attempts + 1
             WHERE cancellation_id = $1 AND order_id = $2`,
            [job.id, item.order_id, status, fields.refundId ?? null, fields.amountCents ?? null, fields.error ?? null],
          );

        const remaining = item.total_cents - item.refunded_cents;
        if (remaining > 0 && item.payment_status === "paid") {
          try {
            const refund = item.refund_id
              ? await payments.retryRefund(s, item.refund_id)
              : await payments.requestRefund(s, item.order_id, { reason: "session_cancelled" }, SYSTEM);
            if (refund.status !== "succeeded") throw new DomainError("refund_not_settled", { refundId: refund.id });
            await settle("refunded", { refundId: refund.id, amountCents: refund.amountCents });
          } catch (error) {
            const code = error instanceof DomainError ? error.code : "unexpected";
            const refundId = error instanceof DomainError && typeof error.details.refundId === "string" ? error.details.refundId : null;
            await settle(item.attempts + 1 >= MAX_ATTEMPTS ? "failed" : "pending", { refundId, error: code });
            return false;
          }
        } else {
          // Free tickets, or nothing left to refund: void what is still valid for this session.
          const { rowCount } = await tx.query(
            `UPDATE public.ticketing_tickets SET status = 'void', void_reason = 'cancelled', voided_at = now()
             WHERE session_id = $1 AND client_id = $2 AND brand_id = $3 AND status = 'valid'
               AND order_id IN (SELECT id FROM public.ticketing_orders WHERE id = $4 OR exchange_of_order_id = $4)`,
            [sessionId, s.clientId, s.brandId, item.order_id],
          );
          await settle(rowCount ? "voided" : "skipped");
        }

        // Tell the buyer, on the order that held this session's tickets: the latest of the
        // group here, since an open-date ticket (Run 37) can come back to a session it left.
        await tx.query(
          `INSERT INTO public.ticketing_email_outbox (client_id, brand_id, event_id, order_id, kind)
           SELECT o.client_id, o.brand_id, o.event_id, o.id, 'session_cancelled'
           FROM public.ticketing_orders o
           WHERE (o.id = $1 OR o.exchange_of_order_id = $1) AND o.session_id = $2 AND o.client_id = $3 AND o.brand_id = $4
           ORDER BY o.created_at DESC LIMIT 1
           ON CONFLICT (order_id, kind, refund_id) DO NOTHING`,
          [item.order_id, sessionId, s.clientId, s.brandId],
        );
        return false;
      });
      if (done) break;
    }

    await withTransaction(db, async (tx) => {
      const { rowCount } = await tx.query(
        `SELECT 1 FROM public.ticketing_session_cancellation_orders WHERE cancellation_id = $1 AND status = 'pending'`,
        [job.id],
      );
      const { rowCount: stillValid } = await tx.query(
        `SELECT 1 FROM public.ticketing_tickets WHERE session_id = $1 AND client_id = $2 AND brand_id = $3 AND status = 'valid' LIMIT 1`,
        [sessionId, s.clientId, s.brandId],
      );
      if (!rowCount && !stillValid) {
        const { rowCount: completed } = await tx.query(
          `UPDATE public.ticketing_session_cancellations SET status = 'completed', completed_at = now() WHERE id = $1 AND status = 'running'`,
          [job.id],
        );
        if (completed) await writeAudit(tx, s, SYSTEM, "session.cancellation_completed", { type: "session", id: sessionId });
      }
    });
  }
  return (await getCancellation(db, s, sessionId))!;
}

/** Worker: advance every running cancellation, across Clients. */
export async function advanceCancellations(db: Db, payments: PaymentsService, limitPerJob = 25): Promise<number> {
  const { rows } = await db.query<{ client_id: string; brand_id: string; session_id: string }>(
    `SELECT client_id, brand_id, session_id FROM public.ticketing_session_cancellations WHERE status = 'running' ORDER BY created_at LIMIT 20`,
  );
  for (const r of rows) {
    await runCancellationBatch(db, payments, { clientId: r.client_id, brandId: r.brand_id }, r.session_id, limitPerJob);
  }
  return rows.length;
}
