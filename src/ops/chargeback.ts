import { writeAudit } from "../db/catalog.js";
import type { TenantScope } from "../db/commerce.js";
import type { Tx } from "../db/pool.js";

/**
 * Run 34 (owner decision, docs/ALKAO_DECISIONS.md): when the buyer wins a Stripe dispute,
 * the money is gone, so the tickets nobody has used yet stop working and their seats go back
 * on sale. While a dispute is open nothing changes: gate entry times are the Client's
 * evidence. Tickets already used stay as they are. The buyer is not emailed.
 *
 * A dispute for less than what is still paid (part of the order) cancels nothing by itself:
 * the order shows in "À traiter" until staff cancel the tickets it covered.
 */
export async function voidAfterLostDispute(
  tx: Tx,
  s: TenantScope,
  orderId: string,
  dispute: { disputeId: string; amountCents: number },
  actor: { type: "user" | "system" | "public"; id: string | null },
): Promise<{ voided: number; partial: boolean }> {
  const { rows: order } = await tx.query<{ remaining: number }>(
    `SELECT total_cents - refunded_cents AS remaining FROM public.ticketing_orders
     WHERE id = $1 AND client_id = $2 AND brand_id = $3 FOR UPDATE`,
    [orderId, s.clientId, s.brandId],
  );
  if (!order[0]) return { voided: 0, partial: false };
  if (dispute.amountCents < order[0].remaining) {
    await writeAudit(tx, s, actor, "payment.dispute_lost_partial", { type: "order", id: orderId }, {
      disputeId: dispute.disputeId, amountCents: dispute.amountCents, remainingCents: order[0].remaining,
    });
    return { voided: 0, partial: true };
  }
  // The order's tickets and those of its Flex exchange, unless already used at the gate.
  const { rows } = await tx.query<{ id: string }>(
    `UPDATE public.ticketing_tickets k SET status = 'void', void_reason = 'chargeback', voided_at = now()
     WHERE k.client_id = $2 AND k.brand_id = $3 AND k.status = 'valid'
       AND (k.order_id = $1 OR k.order_id IN (
             SELECT x.id FROM public.ticketing_orders x WHERE x.exchange_of_order_id = $1 AND x.client_id = $2 AND x.brand_id = $3))
       AND NOT EXISTS (SELECT 1 FROM public.ticketing_scans sc WHERE sc.ticket_id = k.id AND sc.result = 'admitted')
     RETURNING k.id`,
    [orderId, s.clientId, s.brandId],
  );
  if (rows.length > 0) {
    await writeAudit(tx, s, actor, "tickets.voided", { type: "order", id: orderId }, {
      ticketIds: rows.map((r) => r.id), reason: "chargeback", disputeId: dispute.disputeId,
    });
  }
  return { voided: rows.length, partial: false };
}
