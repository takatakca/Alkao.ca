import { DomainError } from "../domain/errors.js";
import { newOrderReference } from "../domain/ids.js";
import type { Quote } from "../domain/pricing.js";
import { mapDbErrors } from "./errors.js";
import type { Tx } from "./pool.js";

/**
 * Inventory and order primitives. Every function runs inside the caller's transaction and
 * scopes every statement by client_id AND brand_id. The database triggers and CHECKs are the
 * final authority (capacity, state machines, totals); these functions only sequence writes.
 */

export interface TenantScope {
  clientId: string;
  brandId: string;
}

export interface HoldItemInput {
  ticketTypeId: string;
  quantity: number;
  unitPriceCents: number;
}

export interface CreateHoldInput extends TenantScope {
  eventId: string;
  sessionId: string;
  /** Admission count: the capacity units to reserve. */
  admissions: number;
  items: HoldItemInput[];
  expiresAt: Date;
}

/** Expire active holds past their deadline; triggers return their capacity. */
export async function expireStaleHolds(tx: Tx, now: Date, sessionId?: string): Promise<number> {
  const result = await tx.query(
    `UPDATE public.ticketing_holds SET status = 'expired'
     WHERE status = 'active' AND expires_at <= $1 AND ($2::uuid IS NULL OR session_id = $2)`,
    [now, sessionId ?? null],
  );
  return result.rowCount ?? 0;
}

export async function createHold(tx: Tx, input: CreateHoldInput, now = new Date()): Promise<{ id: string; expiresAt: Date }> {
  if (input.expiresAt <= now) throw new DomainError("invalid_hold_expiry");
  return mapDbErrors(async () => {
    await expireStaleHolds(tx, now, input.sessionId);
    const { rows } = await tx.query<{ id: string; expires_at: Date }>(
      `INSERT INTO public.ticketing_holds (client_id, brand_id, event_id, session_id, quantity, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, expires_at`,
      [input.clientId, input.brandId, input.eventId, input.sessionId, input.admissions, input.expiresAt],
    );
    const hold = rows[0]!;
    for (const item of input.items) {
      await tx.query(
        `INSERT INTO public.ticketing_hold_items
           (hold_id, client_id, brand_id, event_id, ticket_type_id, quantity, unit_price_cents)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [hold.id, input.clientId, input.brandId, input.eventId, item.ticketTypeId, item.quantity, item.unitPriceCents],
      );
    }
    return { id: hold.id, expiresAt: hold.expires_at };
  });
}

/** Release an active hold. Returns false if it was not active (already closed or unknown). */
export async function releaseHold(tx: Tx, scope: TenantScope, holdId: string): Promise<boolean> {
  const result = await tx.query(
    `UPDATE public.ticketing_holds SET status = 'released'
     WHERE id = $1 AND client_id = $2 AND brand_id = $3 AND status = 'active'`,
    [holdId, scope.clientId, scope.brandId],
  );
  return (result.rowCount ?? 0) === 1;
}

export interface BuyerInput {
  email: string;
  fullName?: string | null;
  phone?: string | null;
}

export interface CreateOrderInput extends TenantScope {
  holdId: string;
  buyer: BuyerInput;
  quote: Quote;
  commissionCents: number;
}

export interface CreatedOrder {
  id: string;
  reference: string;
  buyerId: string;
}

/** Create a pending order from an active, unexpired hold. Money comes from the server quote. */
export async function createOrderFromHold(tx: Tx, input: CreateOrderInput, now = new Date()): Promise<CreatedOrder> {
  return mapDbErrors(async () => {
    const { rows: holds } = await tx.query<{ event_id: string; session_id: string; status: string; expires_at: Date }>(
      `SELECT event_id, session_id, status, expires_at FROM public.ticketing_holds
       WHERE id = $1 AND client_id = $2 AND brand_id = $3
       FOR UPDATE`,
      [input.holdId, input.clientId, input.brandId],
    );
    const hold = holds[0];
    if (!hold) throw new DomainError("hold_not_found");
    if (hold.status !== "active" || hold.expires_at <= now) throw new DomainError("hold_not_active");

    const { rows: buyers } = await tx.query<{ id: string }>(
      `INSERT INTO public.ticketing_buyers (client_id, brand_id, email, full_name, phone)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (client_id, brand_id, email_normalized)
       DO UPDATE SET full_name = coalesce(EXCLUDED.full_name, ticketing_buyers.full_name),
                     phone = coalesce(EXCLUDED.phone, ticketing_buyers.phone)
       RETURNING id`,
      [input.clientId, input.brandId, input.buyer.email, input.buyer.fullName ?? null, input.buyer.phone ?? null],
    );
    const buyerId = buyers[0]!.id;

    const q = input.quote;
    let order: { id: string; reference: string } | undefined;
    for (let attempt = 0; attempt < 5 && !order; attempt++) {
      await tx.query("SAVEPOINT order_reference");
      try {
        const { rows } = await tx.query<{ id: string; reference: string }>(
          `INSERT INTO public.ticketing_orders
             (client_id, brand_id, event_id, session_id, hold_id, buyer_id, reference,
              subtotal_cents, tax_cents, total_cents, commission_cents)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING id, reference`,
          [
            input.clientId, input.brandId, hold.event_id, hold.session_id, input.holdId, buyerId,
            newOrderReference(), q.subtotalCents, q.taxCents, q.totalCents, input.commissionCents,
          ],
        );
        order = rows[0];
        await tx.query("RELEASE SAVEPOINT order_reference");
      } catch (error) {
        await tx.query("ROLLBACK TO SAVEPOINT order_reference");
        if ((error as { constraint?: string }).constraint !== "ticketing_orders_reference_key") throw error;
      }
    }
    if (!order) throw new DomainError("order_reference_exhausted");

    for (const line of q.lines) {
      await tx.query(
        `INSERT INTO public.ticketing_order_lines
           (order_id, client_id, brand_id, event_id, ticket_type_id, kind, code_snapshot, name_snapshot,
            quantity, unit_price_cents, line_total_cents)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          order.id, input.clientId, input.brandId, hold.event_id, line.ticketTypeId, line.kind,
          line.code, line.name, line.quantity, line.unitPriceCents, line.lineTotalCents,
        ],
      );
    }
    for (const tax of q.taxes) {
      await tx.query(
        `INSERT INTO public.ticketing_order_taxes
           (order_id, client_id, brand_id, event_id, code, rate_ppm, taxable_cents, amount_cents)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [order.id, input.clientId, input.brandId, hold.event_id, tax.code, tax.ratePpm, tax.taxableCents, tax.amountCents],
      );
    }
    return { id: order.id, reference: order.reference, buyerId };
  });
}

/**
 * Mark a pending order paid: convert its hold (returning the reservation) and issue one
 * ticket per admission. If the hold already lapsed, issuance still has to fit in capacity
 * (sold_out otherwise). Payment verification itself belongs to Run 02.
 */
export async function recordOrderPaid(tx: Tx, scope: TenantScope, orderId: string, paidAt: Date): Promise<string[]> {
  return mapDbErrors(async () => {
    const { rows } = await tx.query<{ status: string; hold_id: string | null; session_id: string; event_id: string }>(
      `SELECT status, hold_id, session_id, event_id FROM public.ticketing_orders
       WHERE id = $1 AND client_id = $2 AND brand_id = $3
       FOR UPDATE`,
      [orderId, scope.clientId, scope.brandId],
    );
    const order = rows[0];
    if (!order) throw new DomainError("order_not_found");
    if (order.status !== "pending_payment") throw new DomainError("order_not_pending");

    if (order.hold_id) {
      await tx.query(
        `UPDATE public.ticketing_holds SET status = 'converted' WHERE id = $1 AND status = 'active'`,
        [order.hold_id],
      );
    }
    await tx.query(`UPDATE public.ticketing_orders SET status = 'paid', paid_at = $2 WHERE id = $1`, [orderId, paidAt]);

    const { rows: tickets } = await tx.query<{ id: string }>(
      `INSERT INTO public.ticketing_tickets
         (client_id, brand_id, event_id, session_id, order_id, order_line_id, ticket_type_id)
       SELECT l.client_id, l.brand_id, l.event_id, $2, l.order_id, l.id, l.ticket_type_id
       FROM public.ticketing_order_lines l
       CROSS JOIN LATERAL generate_series(1, l.quantity)
       WHERE l.order_id = $1 AND l.kind = 'admission'
       ORDER BY l.created_at, l.id
       RETURNING id`,
      [orderId, order.session_id],
    );
    return tickets.map((t) => t.id);
  });
}
