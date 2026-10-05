import { createHash, randomBytes } from "node:crypto";
import { loadPublicEvent, loadSession, writeAudit } from "../db/catalog.js";
import { recordOrderPaid, type TenantScope } from "../db/commerce.js";
import { mapDbErrors } from "../db/errors.js";
import { withTransaction, type Db } from "../db/pool.js";
import { DomainError } from "../domain/errors.js";
import { newOrderReference } from "../domain/ids.js";
import { isSessionSellable } from "../domain/lifecycle.js";

export interface ExchangeResult {
  exchangeOrderId: string;
  reference: string;
  orderToken: string;
  ticketIds: string[];
}

/**
 * Flex Météo: move an order's valid tickets, once, to another session of the same event.
 *
 * The move is a zero-amount exchange order linked to the original. Money stays on the
 * original order and its payment; the new tickets (and credentials) live on the exchange
 * order; the original tickets are voided. Ticket types are priced per type, not per
 * session, so the price difference is always zero in V1.
 */
export async function exchangeOrder(
  db: Db,
  scope: TenantScope,
  orderId: string,
  newSessionId: string,
  actor: { type: "user" | "public"; id: string | null },
  now = new Date(),
): Promise<ExchangeResult> {
  return withTransaction(db, (tx) =>
    mapDbErrors(async () => {
      const { rows } = await tx.query<{ status: string; event_id: string; session_id: string; buyer_id: string; exchange_of_order_id: string | null }>(
        `SELECT status, event_id, session_id, buyer_id, exchange_of_order_id FROM public.ticketing_orders
         WHERE id = $1 AND client_id = $2 AND brand_id = $3 FOR UPDATE`,
        [orderId, scope.clientId, scope.brandId],
      );
      const original = rows[0];
      if (!original) throw new DomainError("order_not_found");
      if (original.exchange_of_order_id) throw new DomainError("already_exchanged");
      if (!["paid", "partially_refunded"].includes(original.status)) throw new DomainError("order_not_exchangeable");

      const { rowCount: exchanged } = await tx.query(`SELECT 1 FROM public.ticketing_orders WHERE exchange_of_order_id = $1`, [orderId]);
      if (exchanged) throw new DomainError("already_exchanged");

      const { rowCount: flex } = await tx.query(
        `SELECT 1 FROM public.ticketing_order_lines l
         JOIN public.ticketing_ticket_types t ON t.id = l.ticket_type_id AND t.client_id = l.client_id AND t.brand_id = l.brand_id
         WHERE l.order_id = $1 AND l.kind = 'add_on' AND t.grants_session_change`,
        [orderId],
      );
      if (!flex) throw new DomainError("flex_not_purchased");

      const { rows: tickets } = await tx.query<{ id: string; ticket_type_id: string; code: string; name: string }>(
        `SELECT k.id, k.ticket_type_id, l.code_snapshot AS code, l.name_snapshot AS name
         FROM public.ticketing_tickets k
         JOIN public.ticketing_order_lines l ON l.id = k.order_line_id
         WHERE k.order_id = $1 AND k.status = 'valid' ORDER BY k.created_at, k.id`,
        [orderId],
      );
      if (tickets.length === 0) throw new DomainError("nothing_to_exchange");
      const { rowCount: used } = await tx.query(
        `SELECT 1 FROM public.ticketing_scans WHERE ticket_id = ANY($1::uuid[]) AND result = 'admitted'`,
        [tickets.map((t) => t.id)],
      );
      if (used) throw new DomainError("ticket_already_used");

      const session = await loadSession(tx, scope, newSessionId);
      const event = session ? await loadPublicEvent(tx, scope, session.eventId) : null;
      if (!session || !event || session.eventId !== original.event_id || session.id === original.session_id || !isSessionSellable(event, session, now)) {
        throw new DomainError("session_not_available");
      }

      let order: { id: string; reference: string } | undefined;
      for (let attempt = 0; attempt < 5 && !order; attempt++) {
        await tx.query("SAVEPOINT exchange_reference");
        try {
          const { rows: created } = await tx.query<{ id: string; reference: string }>(
            `INSERT INTO public.ticketing_orders
               (client_id, brand_id, event_id, session_id, buyer_id, reference, subtotal_cents, tax_cents, total_cents, commission_cents, exchange_of_order_id)
             VALUES ($1, $2, $3, $4, $5, $6, 0, 0, 0, 0, $7) RETURNING id, reference`,
            [scope.clientId, scope.brandId, original.event_id, session.id, original.buyer_id, newOrderReference(), orderId],
          );
          order = created[0];
          await tx.query("RELEASE SAVEPOINT exchange_reference");
        } catch (error) {
          await tx.query("ROLLBACK TO SAVEPOINT exchange_reference");
          if ((error as { constraint?: string }).constraint !== "ticketing_orders_reference_key") throw error;
        }
      }
      if (!order) throw new DomainError("order_reference_exhausted");

      const byType = new Map<string, { code: string; name: string; quantity: number }>();
      for (const t of tickets) {
        const entry = byType.get(t.ticket_type_id) ?? { code: t.code, name: t.name, quantity: 0 };
        entry.quantity += 1;
        byType.set(t.ticket_type_id, entry);
      }
      for (const [ticketTypeId, line] of byType) {
        await tx.query(
          `INSERT INTO public.ticketing_order_lines
             (order_id, client_id, brand_id, event_id, ticket_type_id, kind, code_snapshot, name_snapshot, quantity, unit_price_cents, line_total_cents)
           VALUES ($1, $2, $3, $4, $5, 'admission', $6, $7, $8, 0, 0)`,
          [order.id, scope.clientId, scope.brandId, original.event_id, ticketTypeId, line.code, line.name, line.quantity],
        );
      }

      // New tickets must fit the new session (capacity CHECK), then the old ones are released.
      const ticketIds = await recordOrderPaid(tx, scope, order.id, now);
      await tx.query(
        `UPDATE public.ticketing_tickets SET status = 'void', void_reason = 'reissued', voided_at = now() WHERE id = ANY($1::uuid[])`,
        [tickets.map((t) => t.id)],
      );

      const orderToken = randomBytes(32).toString("base64url");
      await tx.query(
        `INSERT INTO public.ticketing_access_tokens (token_hash, client_id, brand_id, subject_type, subject_id) VALUES ($1, $2, $3, 'order', $4)`,
        [createHash("sha256").update(orderToken).digest(), scope.clientId, scope.brandId, order.id],
      );
      await writeAudit(tx, scope, actor, "order.exchanged", { type: "order", id: orderId }, {
        exchangeOrderId: order.id,
        fromSessionId: original.session_id,
        toSessionId: session.id,
        tickets: ticketIds.length,
      });
      return { exchangeOrderId: order.id, reference: order.reference, orderToken, ticketIds };
    }),
  );
}
