import type { TenantScope } from "../db/commerce.js";
import type { Tx } from "../db/pool.js";

/** Conservative payment boundary for transferring ownership of an admission.
 * The caller must hold the order's FOR UPDATE lock before checking this
 * predicate, serializing it with creation/finalization of a Stripe refund.
 * A dispute whose outcome still threatens the purchase, including a lost
 * partial dispute awaiting staff action, also blocks transfer.
 */
export async function transferPaymentIsClear(
  db: Tx, scope: TenantScope, orderId: string,
): Promise<boolean> {
  const { rows } = await db.query<{ clear: boolean }>(
    `SELECT NOT (
      EXISTS (
        SELECT 1 FROM public.ticketing_refunds f
        WHERE f.order_id = $1 AND f.client_id = $2 AND f.brand_id = $3
          AND f.status = 'pending'
      ) OR EXISTS (
        SELECT 1 FROM public.ticketing_payment_disputes d
        WHERE d.order_id = $1 AND d.client_id = $2 AND d.brand_id = $3
          AND d.status NOT IN ('won', 'warning_closed', 'prevented')
      )
    ) AS clear`,
    [orderId, scope.clientId, scope.brandId],
  );
  return rows[0]?.clear === true;
}
