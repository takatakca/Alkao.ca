import { timingSafeEqual } from "node:crypto";
import { withTransaction, type Db } from "../db/pool.js";
import { EmailSendError, type EmailMessage, type EmailSender } from "./email.js";
import { transferClaimHash, transferClaimSecret, transferClaimUrl } from "./transfer-token.js";

/**
 * STAGED ONLY. Not invoked by startEmailWorker or reachable through an API.
 * Enable automatic dispatch ONLY after recipient verification, atomic QR
 * replacement, and the /billets/transfert claim UI pass end-to-end tests.
 */
export interface RecipientInviteDeliveryConfig {
  sender: EmailSender;
  publicUrl: string;
  credentialMasterSecret: string;
}
type Outcome = "sent" | "skipped" | "retried" | "failed";
type DueRow = {
  id: string; attempts: number; request_id: string; client_id: string; brand_id: string;
  ticket_id: string; recipient_email: string; claim_token_hash: Buffer; expires_at: Date;
  request_status: string; ticket_status: string; order_status: string; session_status: string;
  ticket_transfers_enabled: boolean; starts_at: Date; buyer_erased: boolean;
  already_admitted: boolean; brand_name: string; event_title: string;
  language: "fr" | "en";
  refund_pending: boolean; dispute_unresolved: boolean;
};
const escapeHtml = (s: string) => s.replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const backoff = (attempts: number) => Math.min(60_000 * 2 ** attempts, 6 * 3600_000);

/** Transport-independent, accessible FR/EN invitation. No ticket or QR is
 * supplied: recipient must actively accept via a future verified claim route. */
export function recipientInvitationEmail(input: {
  brandName: string; eventTitle: string; link: string; language: "fr" | "en";
}): Omit<EmailMessage, "to" | "idempotencyKey"> {
  const { brandName, eventTitle, link, language } = input;
  const fr = language === "fr";
  const title = fr ? "Invitation à recevoir un billet" : "Invitation to receive a ticket";
  const intro = fr
    ? `Une personne souhaite vous transférer un billet pour ${eventTitle}. Le billet n'est pas encore à vous : vous devez confirmer la demande.`
    : `Someone wants to transfer you a ticket for ${eventTitle}. The ticket is not yours yet; you must confirm the request.`;
  const caution = fr ? "Si vous n'attendiez pas cette invitation, ignorez ce courriel. Le lien expire dans 24 heures."
    : "If you did not expect this invitation, ignore this email. The link expires after 24 hours.";
  const action = fr ? "Examiner le transfert" : "Review transfer";
  const text = [title, "", intro, "", link, "", caution, "", brandName].join("\n");
  const html = `<!doctype html><html lang="${language}"><body style="margin:0;padding:24px;background:#f5f7fa;color:#14233b;font-family:Arial,sans-serif">
    <main style="max-width:560px;margin:auto;background:#fff;border-radius:12px;padding:24px">
    <h1 style="font-size:23px">${escapeHtml(title)}</h1><p>${escapeHtml(intro)}</p>
    <p><a href="${escapeHtml(link)}" style="background:#1565d8;color:#fff;padding:14px 20px;display:inline-block;border-radius:8px">${escapeHtml(action)}</a></p>
    <p style="font-size:14px">${escapeHtml(caution)}</p><p>${escapeHtml(brandName)}</p>
    </main></body></html>`;
  return { fromName: brandName, subject: `${title} — ${eventTitle}`, text, html };
}

export async function deliverRecipientInvitations(db: Db, cfg: RecipientInviteDeliveryConfig,
  now = new Date(), limit = 30): Promise<Record<Outcome, number>> {
  if (!cfg.credentialMasterSecret || cfg.credentialMasterSecret.length < 16)
    throw new Error("transfer_master_secret_missing");
  if (!cfg.publicUrl.startsWith("https://")) throw new Error("transfer_https_origin_required");
  const result: Record<Outcome, number> = { sent: 0, skipped: 0, retried: 0, failed: 0 };
  for (let i = 0; i < Math.min(30, Math.max(0, limit)); i++) {
    const outcome = await withTransaction(db, async (tx): Promise<Outcome | null> => {
      const { rows } = await tx.query<DueRow>(
        `SELECT x.id, x.attempts, x.request_id, x.client_id, x.brand_id,
                r.ticket_id, r.recipient_email, r.claim_token_hash, r.expires_at,
                r.status AS request_status, t.status AS ticket_status, o.status AS order_status,
                s.status AS session_status, s.starts_at, bs.ticket_transfers_enabled,
                br.name AS brand_name, e.title AS event_title, b.language,
                EXISTS (SELECT 1 FROM public.ticketing_refunds f
                  WHERE f.order_id = o.id AND f.client_id = o.client_id
                    AND f.brand_id = o.brand_id AND f.status = 'pending') AS refund_pending,
                EXISTS (SELECT 1 FROM public.ticketing_payment_disputes d
                  WHERE d.order_id = o.id AND d.client_id = o.client_id
                    AND d.brand_id = o.brand_id
                    AND d.status NOT IN ('won', 'warning_closed', 'prevented')) AS dispute_unresolved,
                EXISTS (SELECT 1 FROM public.ticketing_buyer_erasures be WHERE be.buyer_id = o.buyer_id) AS buyer_erased,
                EXISTS (SELECT 1 FROM public.ticketing_scans sc
                  WHERE sc.ticket_id = t.id AND sc.result = 'admitted') AS already_admitted
         FROM public.ticketing_transfer_invitation_outbox x
         JOIN public.ticketing_transfer_requests r ON r.id = x.request_id
           AND r.client_id = x.client_id AND r.brand_id = x.brand_id
         JOIN public.ticketing_tickets t ON t.id = r.ticket_id
           AND t.client_id = r.client_id AND t.brand_id = r.brand_id
         JOIN public.ticketing_orders o ON o.id = t.order_id
           AND o.client_id = t.client_id AND o.brand_id = t.brand_id
         JOIN public.ticketing_buyers b ON b.id = o.buyer_id
           AND b.client_id = o.client_id AND b.brand_id = o.brand_id
         JOIN public.ticketing_sessions s ON s.id = r.session_id
           AND s.client_id = r.client_id AND s.brand_id = r.brand_id
         JOIN public.ticketing_brand_settings bs ON bs.client_id = r.client_id AND bs.brand_id = r.brand_id
         JOIN public.ticketing_brands br ON br.id = r.brand_id AND br.client_id = r.client_id
         JOIN public.ticketing_events e ON e.id = r.event_id AND e.client_id = r.client_id AND e.brand_id = r.brand_id
         WHERE x.status = 'pending' AND x.next_attempt_at <= $1
         ORDER BY x.next_attempt_at, x.id LIMIT 1
         FOR UPDATE OF x, r SKIP LOCKED`,
        [now],
      );
      const row = rows[0];
      if (!row) return null;
      const skip = async (reason: string): Promise<Outcome> => {
        await tx.query(`UPDATE public.ticketing_transfer_invitation_outbox
          SET status = 'skipped', last_error = $2 WHERE id = $1`, [row.id, reason]);
        return "skipped";
      };
      if (row.request_status !== "pending") return skip("request_closed");
      if (row.expires_at <= now) return skip("request_expired");
      if (!row.ticket_transfers_enabled) return skip("brand_disabled");
      if (row.buyer_erased) return skip("buyer_erased");
      // Never invite a recipient to claim an admission with unsettled money.
      if (row.refund_pending || row.dispute_unresolved) return skip("payment_unsettled");
      if (row.ticket_status !== "valid" || !["paid", "partially_refunded"].includes(row.order_status))
        return skip("ticket_unavailable");
      if (row.session_status === "cancelled" || row.starts_at <= now || row.already_admitted)
        return skip("event_unavailable");
      const scope = { clientId: row.client_id, brandId: row.brand_id };
      const secret = transferClaimSecret(cfg.credentialMasterSecret, scope,
        row.request_id, row.ticket_id, row.recipient_email);
      const expected = transferClaimHash(secret);
      if (!timingSafeEqual(expected, row.claim_token_hash)) return skip("key_rotated");
      const link = transferClaimUrl(cfg.publicUrl, scope, row.request_id, secret);
      const letter = recipientInvitationEmail({
        language: row.language === "en" ? "en" : "fr", brandName: row.brand_name, eventTitle: row.event_title, link,
      });
      try {
        const messageId = await cfg.sender.send({
          ...letter, to: row.recipient_email,
          idempotencyKey: `alkao-transfer-${row.id}-${row.attempts}`,
        });
        await tx.query(`UPDATE public.ticketing_transfer_invitation_outbox
          SET status = 'sent', sent_at = $2, attempts = attempts + 1,
              provider_message_id = $3, last_error = NULL WHERE id = $1`,
          [row.id, now, messageId]);
        return "sent";
      } catch (err) {
        const attempts = row.attempts + 1;
        const retryable = err instanceof EmailSendError ? err.retryable : true;
        const giveUp = !retryable || attempts >= 6;
        await tx.query(`UPDATE public.ticketing_transfer_invitation_outbox
          SET status = $2, attempts = $3, next_attempt_at = $4, last_error = $5
          WHERE id = $1`, [row.id, giveUp ? "failed" : "pending",
          attempts, new Date(now.getTime() + backoff(attempts)),
          giveUp ? "email_delivery_failed" : "email_delivery_retry"]);
        return giveUp ? "failed" : "retried";
      }
    });
    if (!outcome) break;
    result[outcome]++;
  }
  return result;
}
