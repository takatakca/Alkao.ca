import { hkdfSync, timingSafeEqual } from "node:crypto";
import { withTransaction, type Db } from "../db/pool.js";
import { EmailSendError, type EmailSender } from "./email.js";
import { campaignEmail } from "./templates.js";

/**
 * Run 42: sending campaigns. Each message carries its own unsubscribe link, derived from the
 * server secret and the message id (nothing stored), which works in one click, as Canada's
 * anti-spam law and the big mailbox providers ask (List-Unsubscribe, RFC 8058).
 */
export function unsubscribeToken(masterSecret: string, messageId: string): string {
  return Buffer.from(hkdfSync("sha256", masterSecret, "alkao.unsubscribe.v1", Buffer.from(messageId), 24)).toString("base64url");
}

export function unsubscribeTokenValid(masterSecret: string, messageId: string, token: string): boolean {
  const expected = Buffer.from(unsubscribeToken(masterSecret, messageId));
  const given = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export const unsubscribeUrl = (publicUrl: string, messageId: string, token: string) =>
  `${publicUrl.replace(/\/+$/, "")}/desabonnement?${new URLSearchParams({ m: messageId, k: token }).toString()}`;

export interface CampaignDeliveryConfig {
  sender: EmailSender;
  publicUrl: string;
  credentialMasterSecret: string;
  maxAttempts?: number;
}

export interface CampaignDeliveryResult {
  sent: number;
  skipped: number;
  retried: number;
  failed: number;
  finished: number;
}

/** A campaign is news: a message still waiting after this long is dropped, never sent late. */
const MAX_AGE_MS = 7 * 86_400_000;
const backoffMs = (attempts: number) => Math.min(60_000 * 2 ** attempts, 6 * 3600_000);

interface DueRow {
  id: string;
  customer_id: string | null;
  email: string;
  attempts: number;
  created_at: Date;
  campaign_status: string;
  language: "fr" | "en";
  subject: string;
  preheader: string | null;
  heading: string;
  body: string;
  image_url: string | null;
  cta_label: string | null;
  cta_url: string | null;
  brand_name: string;
  sender_address: string | null;
  contact: string | null;
  first_name: string | null;
  opted_out: boolean;
  anonymized: boolean;
}

/**
 * Send due campaign messages, one per transaction (FOR UPDATE SKIP LOCKED). A message is
 * skipped if its campaign was cancelled, if the customer unsubscribed or was anonymized
 * since, or if the sender's address was removed (the law's footer cannot be left out).
 * A campaign with nothing left to send is marked sent.
 */
export async function deliverCampaignEmails(db: Db, cfg: CampaignDeliveryConfig, now = new Date(), limit = 100): Promise<CampaignDeliveryResult> {
  const result: CampaignDeliveryResult = { sent: 0, skipped: 0, retried: 0, failed: 0, finished: 0 };
  const maxAttempts = cfg.maxAttempts ?? 6;
  for (let i = 0; i < limit; i++) {
    const outcome = await withTransaction(db, async (tx) => {
      const { rows } = await tx.query<DueRow>(
        `SELECT m.id, m.customer_id, m.email, m.attempts, m.created_at, c.status AS campaign_status, c.language, c.subject, c.preheader,
                c.heading, c.body, c.image_url, c.cta_label, c.cta_url, br.name AS brand_name,
                bs.marketing_sender_address AS sender_address, bs.marketing_contact AS contact, cu.first_name,
                (cu.email_opt_out_at IS NOT NULL AND (cu.email_consent_at IS NULL OR cu.email_opt_out_at >= cu.email_consent_at)) AS opted_out,
                (cu.anonymized_at IS NOT NULL) AS anonymized
         FROM public.ticketing_campaign_messages m
         JOIN public.ticketing_campaigns c ON c.id = m.campaign_id AND c.client_id = m.client_id AND c.brand_id = m.brand_id
         JOIN public.ticketing_brands br ON br.id = m.brand_id AND br.client_id = m.client_id
         LEFT JOIN public.ticketing_brand_settings bs ON bs.client_id = m.client_id AND bs.brand_id = m.brand_id
         LEFT JOIN public.ticketing_customers cu ON cu.id = m.customer_id AND cu.client_id = m.client_id AND cu.brand_id = m.brand_id
         WHERE m.status = 'pending' AND m.next_attempt_at <= $1
         ORDER BY m.next_attempt_at, m.id
         LIMIT 1
         FOR UPDATE OF m SKIP LOCKED`,
        [now],
      );
      const row = rows[0];
      if (!row) return null;
      const skip = async (reason: string) => {
        await tx.query(`UPDATE public.ticketing_campaign_messages SET status = 'skipped', last_error = $2 WHERE id = $1`, [row.id, reason]);
        return "skipped" as const;
      };
      if (row.campaign_status === "cancelled") return skip("cancelled");
      if (row.anonymized) return skip("anonymized");
      if (row.opted_out) return skip("unsubscribed");
      if (now.getTime() - row.created_at.getTime() > MAX_AGE_MS) return skip("too_old");
      if (!row.sender_address || !row.contact) return skip("sender_settings_missing");
      const link = unsubscribeUrl(cfg.publicUrl, row.id, unsubscribeToken(cfg.credentialMasterSecret, row.id));
      const content = campaignEmail({
        language: row.language, brandName: row.brand_name, subject: row.subject, preheader: row.preheader, heading: row.heading, body: row.body,
        imageUrl: row.image_url, cta: row.cta_label && row.cta_url ? { label: row.cta_label, url: row.cta_url } : null,
        firstName: row.first_name, senderAddress: row.sender_address, contact: row.contact, unsubscribeUrl: link,
      });
      try {
        const messageId = await cfg.sender.send({
          ...content, to: row.email, idempotencyKey: `alkao-campaign-${row.id}-${row.attempts}`,
          headers: { "List-Unsubscribe": `<${link}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
        });
        await tx.query(
          `UPDATE public.ticketing_campaign_messages SET status = 'sent', sent_at = $2, attempts = attempts + 1, provider_message_id = $3, last_error = NULL WHERE id = $1`,
          [row.id, now, messageId],
        );
        return "sent" as const;
      } catch (error) {
        const retryable = error instanceof EmailSendError ? error.retryable : true;
        const attempts = row.attempts + 1;
        const giveUp = !retryable || attempts >= maxAttempts;
        await tx.query(
          `UPDATE public.ticketing_campaign_messages SET status = $2, attempts = $3, next_attempt_at = $4, last_error = left($5, 500) WHERE id = $1`,
          [row.id, giveUp ? "failed" : "pending", attempts, new Date(now.getTime() + backoffMs(attempts)), String((error as Error).message ?? error)],
        );
        return giveUp ? ("failed" as const) : ("retried" as const);
      }
    });
    if (!outcome) break;
    result[outcome]++;
  }
  const { rowCount } = await db.query(
    `UPDATE public.ticketing_campaigns c SET status = 'sent', finished_at = $1
     WHERE c.status = 'sending' AND NOT EXISTS (
       SELECT 1 FROM public.ticketing_campaign_messages m WHERE m.campaign_id = c.id AND m.status = 'pending' AND m.customer_id IS NOT NULL)`,
    [now],
  );
  result.finished = rowCount ?? 0;
  return result;
}
