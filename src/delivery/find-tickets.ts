import type { TenantScope } from "../db/commerce.js";
import { withTransaction, type Db } from "../db/pool.js";
import { DomainError } from "../domain/errors.js";
import { requestTicketsEmail } from "./db.js";

/** At most this many orders are re-sent per request (the latest sessions first). */
const MAX_ORDERS = 10;

/**
 * Run 27: "Retrouver mes billets". A buyer who lost the email gives their address, and the
 * tickets email of each order still useful to them (valid tickets, session not over) is sent
 * again to that same address. The caller never learns whether the address had orders.
 * Anonymized buyers are never written to.
 */
export async function resendTicketsToBuyer(db: Db, s: TenantScope, email: string, now = new Date()): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT o.id
     FROM public.ticketing_buyers b
     JOIN public.ticketing_orders o ON o.buyer_id = b.id AND o.client_id = b.client_id AND o.brand_id = b.brand_id
     JOIN public.ticketing_sessions se ON se.id = o.session_id AND se.client_id = o.client_id AND se.brand_id = o.brand_id
     WHERE b.client_id = $1 AND b.brand_id = $2 AND b.email_normalized = lower(btrim($3))
       AND NOT EXISTS (SELECT 1 FROM public.ticketing_buyer_erasures e WHERE e.buyer_id = b.id)
       AND o.status IN ('paid', 'partially_refunded')
       AND se.status <> 'cancelled' AND coalesce(se.ends_at, se.starts_at) > $4
       AND EXISTS (SELECT 1 FROM public.ticketing_tickets k WHERE k.order_id = o.id AND k.status = 'valid')
     ORDER BY se.starts_at
     LIMIT ${MAX_ORDERS}`,
    [s.clientId, s.brandId, email, now],
  );
  let queued = 0;
  for (const r of rows) {
    try {
      await withTransaction(db, (tx) => requestTicketsEmail(tx, s, r.id, { type: "public", id: null }));
      queued++;
    } catch (error) {
      // Resend limit reached, or the order changed meanwhile: skip it, say nothing.
      if (!(error instanceof DomainError)) throw error;
    }
  }
  return queued;
}
