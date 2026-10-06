import { hkdfSync, timingSafeEqual } from "node:crypto";
import { withTransaction, type Db } from "../db/pool.js";
import { EmailSendError, type EmailSender } from "./email.js";
import { newsletterConfirmEmail } from "./templates.js";

/**
 * Run 44: the confirmation e-mail of a newsletter sign-up. Its link is signed from the server
 * secret and the sign-up id (nothing stored) and opens ALKAO's page, where one click records
 * the consent.
 */
export function signupToken(masterSecret: string, signupId: string): string {
  return Buffer.from(hkdfSync("sha256", masterSecret, "alkao.newsletter.v1", Buffer.from(signupId), 24)).toString("base64url");
}

export function signupTokenValid(masterSecret: string, signupId: string, token: string): boolean {
  const expected = Buffer.from(signupToken(masterSecret, signupId));
  const given = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export const confirmUrl = (publicUrl: string, signupId: string, token: string) =>
  `${publicUrl.replace(/\/+$/, "")}/inscription?${new URLSearchParams({ s: signupId, k: token }).toString()}`;

export interface SignupDeliveryConfig {
  sender: EmailSender;
  publicUrl: string;
  credentialMasterSecret: string;
}

/** A confirmation still unsent after this long is dropped: the person has moved on. */
const MAX_AGE_MS = 72 * 3600_000;
const MAX_ATTEMPTS = 6;
const backoffMs = (attempts: number) => Math.min(60_000 * 2 ** attempts, 6 * 3600_000);

export async function deliverSignupConfirmations(db: Db, cfg: SignupDeliveryConfig, now = new Date(), limit = 50) {
  const result = { sent: 0, skipped: 0, retried: 0, failed: 0 };
  for (let i = 0; i < limit; i++) {
    const outcome = await withTransaction(db, async (tx) => {
      const { rows } = await tx.query<{
        id: string; email: string; first_name: string | null; language: "fr" | "en"; status: string; attempts: number; created_at: Date;
        brand_name: string; reward_text: string | null; sender_address: string | null; contact: string | null;
      }>(
        `SELECT n.id, n.email, n.first_name, n.language, n.status, n.attempts, n.created_at, br.name AS brand_name,
                bs.newsletter_reward_text AS reward_text, bs.marketing_sender_address AS sender_address, bs.marketing_contact AS contact
         FROM public.ticketing_newsletter_signups n
         JOIN public.ticketing_brands br ON br.id = n.brand_id AND br.client_id = n.client_id
         LEFT JOIN public.ticketing_brand_settings bs ON bs.client_id = n.client_id AND bs.brand_id = n.brand_id
         WHERE n.email_status = 'pending' AND n.next_attempt_at <= $1
         ORDER BY n.next_attempt_at, n.id LIMIT 1 FOR UPDATE OF n SKIP LOCKED`,
        [now],
      );
      const row = rows[0];
      if (!row) return null;
      if (row.status === "confirmed" || now.getTime() - row.created_at.getTime() > MAX_AGE_MS) {
        await tx.query(`UPDATE public.ticketing_newsletter_signups SET email_status = 'skipped', last_error = $2 WHERE id = $1`, [row.id, row.status === "confirmed" ? "already_confirmed" : "too_old"]);
        return "skipped" as const;
      }
      const content = newsletterConfirmEmail({
        language: row.language, brandName: row.brand_name, firstName: row.first_name, rewardText: row.reward_text,
        link: confirmUrl(cfg.publicUrl, row.id, signupToken(cfg.credentialMasterSecret, row.id)),
        senderAddress: row.sender_address, contact: row.contact,
      });
      try {
        const messageId = await cfg.sender.send({ ...content, to: row.email, idempotencyKey: `alkao-signup-${row.id}-${row.attempts}` });
        await tx.query(
          `UPDATE public.ticketing_newsletter_signups SET email_status = 'sent', sent_at = $2, attempts = attempts + 1, provider_message_id = $3, last_error = NULL WHERE id = $1`,
          [row.id, now, messageId],
        );
        return "sent" as const;
      } catch (error) {
        const retryable = error instanceof EmailSendError ? error.retryable : true;
        const attempts = row.attempts + 1;
        const giveUp = !retryable || attempts >= MAX_ATTEMPTS;
        await tx.query(
          `UPDATE public.ticketing_newsletter_signups SET email_status = $2, attempts = $3, next_attempt_at = $4, last_error = left($5, 500) WHERE id = $1`,
          [row.id, giveUp ? "failed" : "pending", attempts, new Date(now.getTime() + backoffMs(attempts)), String((error as Error).message ?? error)],
        );
        return giveUp ? ("failed" as const) : ("retried" as const);
      }
    });
    if (!outcome) break;
    result[outcome]++;
  }
  return result;
}
