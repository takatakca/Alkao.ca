import { createHash, randomUUID } from "node:crypto";
import { transferClaimSecret, transferClaimHash } from "../delivery/transfer-token.js";
import { writeAudit } from "../db/catalog.js";
import type { TenantScope } from "../db/commerce.js";
import { mapDbErrors } from "../db/errors.js";
import { withTransaction, type Db, type Tx } from "../db/pool.js";
import { DomainError } from "../domain/errors.js";

/** Internal service only. Never return the claim secret through the buyer API:
 * the eventual notification worker must deliver it to the recipient mailbox.
 * A pending request does not transfer a ticket or revoke a credential. */
export interface TransferInvitation {
  id: string;
  ticketId: string;
  recipientEmail: string;
  expiresAt: Date;
  /** Raw secret to be delivered privately once; never stored or logged. */
  recipientClaimSecret: string;
}
const tokenHash = (token: string) => createHash("sha256").update(token).digest();
const normalizeEmail = (email: string) => email.toLowerCase().trim();
const validEmail = (email: string) => email.length <= 320 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);

/** Use the same tenant-scoped order authorization as the public buyer routes,
 * but within the write transaction so token rotation is serialized. */
async function requireBuyerToken(tx: Tx, scope: TenantScope, orderId: string, token: string, at: Date) {
  if (!token || token.length > 100) throw new DomainError("order_not_found");
  const { rowCount } = await tx.query(
    `SELECT 1 FROM public.ticketing_access_tokens
     WHERE token_hash = $1 AND subject_type = 'order' AND subject_id = $2
       AND client_id = $3 AND brand_id = $4
       AND (expires_at IS NULL OR expires_at > $5) FOR SHARE`,
    [tokenHash(token), orderId, scope.clientId, scope.brandId, at],
  );
  if (!rowCount) throw new DomainError("order_not_found");
}

export async function prepareTransferInvitation(
  db: Db, scope: TenantScope, orderId: string, ticketId: string,
  orderToken: string, recipient: string, masterSecret: string, at = new Date(),
): Promise<TransferInvitation> {
  const recipientEmail = normalizeEmail(recipient);
  if (!validEmail(recipientEmail)) throw new DomainError("invalid_recipient_email");
  if (!masterSecret || masterSecret.length < 16) throw new DomainError("credentials_not_configured");
  return withTransaction(db, (tx) => mapDbErrors(async () => {
    await requireBuyerToken(tx, scope, orderId, orderToken, at);
    const { rows: tickets } = await tx.query<{ event_id: string; session_id: string }>(
      `SELECT event_id, session_id FROM public.ticketing_tickets
       WHERE id = $1 AND order_id = $2 AND client_id = $3 AND brand_id = $4
       FOR UPDATE`,
      [ticketId, orderId, scope.clientId, scope.brandId],
    );
    const ticket = tickets[0];
    if (!ticket) throw new DomainError("ticket_not_found");
    const id = randomUUID();
    // Expired intents must stop occupying the unique pending slot before a
    // fresh request is created for the same ticket.
    await tx.query(
      `UPDATE public.ticketing_transfer_requests SET status = 'expired'
       WHERE ticket_id = $1 AND client_id = $2 AND brand_id = $3
         AND status = 'pending' AND expires_at <= $4`,
      [ticketId, scope.clientId, scope.brandId, at],
    );
    const recipientClaimSecret = transferClaimSecret(masterSecret, scope, id, ticketId, recipientEmail);
    const expiresAt = new Date(at.getTime() + 24 * 3600_000);
    await tx.query(
      `INSERT INTO public.ticketing_transfer_requests
         (id, client_id, brand_id, event_id, session_id, ticket_id,
          recipient_email, claim_token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, scope.clientId, scope.brandId, ticket.event_id, ticket.session_id, ticketId,
        recipientEmail, transferClaimHash(recipientClaimSecret), expiresAt],
    );
    await tx.query(
      `INSERT INTO public.ticketing_transfer_invitation_outbox (request_id, client_id, brand_id)
       VALUES ($1, $2, $3)`, [id, scope.clientId, scope.brandId],
    );
    await writeAudit(tx, scope, { type: "public", id: null }, "ticket.transfer_requested",
      { type: "ticket", id: ticketId }, { requestId: id });
    return { id, ticketId, recipientEmail, expiresAt, recipientClaimSecret };
  }));
}

export async function cancelTransferInvitation(
  db: Db, scope: TenantScope, orderId: string, requestId: string,
  orderToken: string, at = new Date(),
): Promise<boolean> {
  return withTransaction(db, (tx) => mapDbErrors(async () => {
    await requireBuyerToken(tx, scope, orderId, orderToken, at);
    const { rows } = await tx.query<{ ticket_id: string }>(
      `UPDATE public.ticketing_transfer_requests r
       SET status = 'cancelled'
       WHERE r.id = $1 AND r.client_id = $2 AND r.brand_id = $3 AND r.status = 'pending'
         AND EXISTS (SELECT 1 FROM public.ticketing_tickets t
           WHERE t.id = r.ticket_id AND t.order_id = $4
             AND t.client_id = r.client_id AND t.brand_id = r.brand_id)
       RETURNING r.ticket_id`,
      [requestId, scope.clientId, scope.brandId, orderId],
    );
    if (!rows[0]) return false;
    await writeAudit(tx, scope, { type: "public", id: null }, "ticket.transfer_cancelled",
      { type: "ticket", id: rows[0].ticket_id }, { requestId });
    return true;
  }));
}
