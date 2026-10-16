import { timingSafeEqual } from "node:crypto";
import { writeAudit } from "../db/catalog.js";
import type { TenantScope } from "../db/commerce.js";
import { mapDbErrors } from "../db/errors.js";
import { withTransaction, type Db } from "../db/pool.js";
import { DomainError } from "../domain/errors.js";
import { transferPaymentIsClear } from "./transfer-payment.js";
import { transferAccessSecret, transferClaimHash } from "../delivery/transfer-token.js";

/**
 * Internal-only recipient acceptance. No public route invokes it yet.
 * The purchase order and its money stay immutable: the same ticket receives
 * a new signed credential, and the sender's order queries suppress its QR.
 * The scanner's ticket row lock serializes admissions with this replacement.
 */
export interface AcceptedTransfer {
  requestId: string;
  ticketId: string;
  credentialId: string;
  recipientAccessToken: string;
}
const unavailable = () => new DomainError("transfer_unavailable");

export async function acceptTransferInvitation(
  db: Db, scope: TenantScope, requestId: string, claimSecret: string,
  masterSecret: string, at = new Date(),
): Promise<AcceptedTransfer> {
  if (!masterSecret || masterSecret.length < 16) throw new DomainError("credentials_not_configured");
  if (!claimSecret || !/^[A-Za-z0-9_-]{43}$/.test(claimSecret)) throw unavailable();
  return withTransaction(db, tx => mapDbErrors(async () => {
    // Lock order before ticket, matching refund operations, then re-read and
    // lock the invitation. No assumptions are made from this first lookup.
    const { rows: refs } = await tx.query<{ order_id: string }>(
      `SELECT t.order_id FROM public.ticketing_transfer_requests r
       JOIN public.ticketing_tickets t ON t.id = r.ticket_id
         AND t.client_id = r.client_id AND t.brand_id = r.brand_id
       WHERE r.id = $1 AND r.client_id = $2 AND r.brand_id = $3`,
      [requestId, scope.clientId, scope.brandId],
    );
    if (!refs[0]) throw unavailable();
    const { rows: orders } = await tx.query<{ status: string }>(
      `SELECT status FROM public.ticketing_orders
       WHERE id = $1 AND client_id = $2 AND brand_id = $3 FOR UPDATE`,
      [refs[0].order_id, scope.clientId, scope.brandId],
    );
    if (!orders[0] || !["paid", "partially_refunded"].includes(orders[0].status))
      throw unavailable();

    if (!(await transferPaymentIsClear(tx, scope, refs[0].order_id))) throw unavailable();

    const { rows } = await tx.query<{
      ticket_id: string; event_id: string; session_id: string;
      recipient_email: string; claim_token_hash: Buffer;
      expires_at: Date; request_status: string; ticket_status: string;
      starts_at: Date; session_status: string; admission_opens_before_minutes: number;
      ticket_transfers_enabled: boolean;
    }>(
      `SELECT r.ticket_id, r.event_id, r.session_id, r.recipient_email, r.claim_token_hash,
              r.expires_at, r.status AS request_status, t.status AS ticket_status,
              s.starts_at, s.status AS session_status, e.admission_opens_before_minutes, bs.ticket_transfers_enabled
       FROM public.ticketing_transfer_requests r
       JOIN public.ticketing_tickets t ON t.id = r.ticket_id AND t.client_id = r.client_id AND t.brand_id = r.brand_id
       JOIN public.ticketing_sessions s ON s.id = r.session_id AND s.client_id = r.client_id AND s.brand_id = r.brand_id
       JOIN public.ticketing_events e ON e.id = r.event_id AND e.client_id = r.client_id AND e.brand_id = r.brand_id
       JOIN public.ticketing_brand_settings bs ON bs.client_id = r.client_id AND bs.brand_id = r.brand_id
       WHERE r.id = $1 AND r.client_id = $2 AND r.brand_id = $3
         AND t.order_id = $4
       FOR UPDATE OF r, t FOR SHARE OF s`,
      [requestId, scope.clientId, scope.brandId, refs[0].order_id],
    );
    const r = rows[0];
    if (!r || r.request_status !== "pending" || !r.ticket_transfers_enabled
      || r.session_status === "cancelled"
      || r.ticket_status !== "valid" || r.expires_at <= at
      || r.starts_at.getTime() <= at.getTime()
          + (r.admission_opens_before_minutes + 15) * 60_000) throw unavailable();
    const hashed = transferClaimHash(claimSecret);
    if (!timingSafeEqual(hashed, r.claim_token_hash)) throw unavailable();
    const { rowCount: admitted } = await tx.query(
      `SELECT 1 FROM public.ticketing_scans
       WHERE ticket_id = $1 AND result = 'admitted'`, [r.ticket_id],
    );
    if (admitted) throw unavailable();
    const { rows: old } = await tx.query<{ id: string }>(
      `SELECT id FROM public.ticketing_credentials WHERE ticket_id = $1
       AND client_id = $2 AND brand_id = $3 AND status = 'active' FOR UPDATE`,
      [r.ticket_id, scope.clientId, scope.brandId],
    );
    if (!old[0]) throw unavailable();

    await tx.query(`UPDATE public.ticketing_credentials
      SET status = 'revoked', revoke_reason = 'reissued', revoked_at = now()
      WHERE id = $1 AND status = 'active'`, [old[0].id]);
    const { rows: current } = await tx.query<{ id: string }>(
      `INSERT INTO public.ticketing_credentials
        (client_id, brand_id, event_id, session_id, ticket_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [scope.clientId, scope.brandId, r.event_id, r.session_id, r.ticket_id],
    );
    const credentialId = current[0]!.id;
    const recipientAccessToken = transferAccessSecret(masterSecret, scope, requestId,
      r.ticket_id, r.recipient_email);
    await tx.query(
      `INSERT INTO public.ticketing_transfer_acceptances
        (request_id, client_id, brand_id, ticket_id, credential_id, recipient_access_hash)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [requestId, scope.clientId, scope.brandId, r.ticket_id,
        credentialId, transferClaimHash(recipientAccessToken)],
    );
    await tx.query(
      `UPDATE public.ticketing_transfer_requests SET status = 'claimed'
       WHERE id = $1 AND client_id = $2 AND brand_id = $3 AND status = 'pending'`,
      [requestId, scope.clientId, scope.brandId],
    );
    await writeAudit(tx, scope, { type: "public", id: null }, "ticket.transfer_accepted",
      { type: "ticket", id: r.ticket_id },
      { requestId, revokedCredentialId: old[0].id, newCredentialId: credentialId });
    return { requestId, ticketId: r.ticket_id, credentialId, recipientAccessToken };
  }));
}

/** Recipient-only QR lookup by a distinct capability issued on successful claim.
 * No buyer PII, order token, or old QR is exposed. A refund/void returns 404. */
export async function transferredCredentialForRecipient(
  db: Db, scope: TenantScope, requestId: string, accessToken: string,
): Promise<{ ticketId: string; credentialId: string }> {
  if (!accessToken || !/^[A-Za-z0-9_-]{43}$/.test(accessToken)) throw unavailable();
  const { rows } = await db.query<{ ticket_id: string; credential_id: string }>(
    `SELECT t.id AS ticket_id, c.id AS credential_id
     FROM public.ticketing_transfer_acceptances a
     JOIN public.ticketing_transfer_requests r ON r.id = a.request_id
       AND r.client_id = a.client_id AND r.brand_id = a.brand_id
     JOIN public.ticketing_tickets t ON t.id = a.ticket_id AND t.client_id = a.client_id AND t.brand_id = a.brand_id
     JOIN public.ticketing_credentials c ON c.ticket_id = t.id
       AND c.client_id = t.client_id AND c.brand_id = t.brand_id AND c.status = 'active'
     WHERE a.request_id = $1 AND a.client_id = $2 AND a.brand_id = $3
       AND a.recipient_access_hash = $4 AND r.status = 'claimed' AND t.status = 'valid'`,
    [requestId, scope.clientId, scope.brandId, transferClaimHash(accessToken)],
  );
  if (!rows[0]) throw unavailable();
  return { ticketId: rows[0].ticket_id, credentialId: rows[0].credential_id };
}
