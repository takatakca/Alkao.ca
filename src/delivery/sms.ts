import { createHmac, timingSafeEqual } from "node:crypto";
import { withTransaction, type Db } from "../db/pool.js";
import { personalize, type Language } from "./templates.js";

/**
 * Run 46: campaigns by text message, through Twilio (a Messaging Service, so Twilio handles
 * the sender pool and the STOP replies). Canada's anti-spam law: every text names the Brand
 * and says how to stop; a STOP reaches ALKAO through Twilio's webhook and is recorded on the
 * customer. Texts go out between 9:00 and 21:00 (Québec), never at night.
 */
export interface SmsMessage {
  /** E.164, e.g. +15145550101. */
  to: string;
  body: string;
}

export class SmsSendError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly optedOut = false) {
    super(message);
  }
}

export interface SmsSender {
  /** Resolves with the provider's message id. Throws SmsSendError. */
  send(message: SmsMessage): Promise<string | null>;
}

/** Twilio's REST API (no SDK): one Messaging Service, or one sending number. */
export class TwilioSmsSender implements SmsSender {
  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    private readonly sender: { messagingServiceSid: string } | { from: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(m: SmsMessage): Promise<string | null> {
    const form = new URLSearchParams({ To: m.to, Body: m.body });
    if ("messagingServiceSid" in this.sender) form.set("MessagingServiceSid", this.sender.messagingServiceSid);
    else form.set("From", this.sender.from);
    let res: Response;
    try {
      res = await this.fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.accountSid)}/Messages.json`, {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new SmsSendError(`network: ${(error as Error).message}`, true);
    }
    const body = (await res.json().catch(() => ({}))) as { sid?: string; code?: number; message?: string };
    if (!res.ok) {
      // 21610: the number replied STOP to this sender; 21211/21614: not a mobile number.
      const optedOut = body.code === 21610;
      const retryable = !optedOut && (res.status === 429 || res.status >= 500);
      throw new SmsSendError(`twilio ${res.status}: ${body.code ?? ""} ${body.message ?? ""}`.trim(), retryable, optedOut);
    }
    return body.sid ?? null;
  }
}

/** North American numbers (10 digits) get +1; longer ones are taken as already international. */
export const e164 = (digits: string) => (digits.length === 10 ? `+1${digits}` : `+${digits}`);

const STOP_LINE = { fr: "Répondez STOP pour ne plus en recevoir.", en: "Reply STOP to opt out." };

/**
 * The text as sent: the staff's words (with {prénom}), the link, then the Brand and how to
 * stop. A plain hyphen, not a dash: "—" is outside the SMS alphabet and would double the cost.
 */
export function smsText(d: { language: Language; body: string; firstName: string | null; brandName: string; link: string | null }): string {
  const words = personalize(d.body, d.firstName, null, d.language).replace(/\s+/g, " ").trim();
  return [words, d.link, `- ${d.brandName}. ${STOP_LINE[d.language]}`].filter(Boolean).join(" ");
}

/** Characters left in GSM-7 make 160 per text (153 when split); any other character, 70 (67). */
export function smsSegments(text: string): number {
  const gsm = /^[A-Za-z0-9 @£$¥èéùìòÇØøÅå\n\rΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà^{}\\[~\]|€]*$/.test(text);
  const [single, part] = gsm ? [160, 153] : [70, 67];
  return text.length <= single ? 1 : Math.ceil(text.length / part);
}

/** Québec hour now, and the next 9:00 if it is not between 9:00 and 21:00. */
export function sendingWindow(now: Date, timeZone = "America/Toronto"): { open: boolean; nextOpen: Date } {
  const hour = Number(new Intl.DateTimeFormat("en-CA", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(now));
  if (hour >= 9 && hour < 21) return { open: true, nextOpen: now };
  const hoursToNine = hour >= 21 ? 24 - hour + 9 : 9 - hour;
  const next = new Date(now.getTime() + hoursToNine * 3600_000);
  next.setUTCMinutes(0, 0, 0);
  return { open: false, nextOpen: next };
}

export interface SmsDeliveryConfig {
  sender: SmsSender;
}

const MAX_AGE_MS = 7 * 86_400_000;
const MAX_ATTEMPTS = 5;
const backoffMs = (attempts: number) => Math.min(60_000 * 2 ** attempts, 6 * 3600_000);

/**
 * Send due campaign texts, one per transaction. Outside 9:00–21:00 the due texts wait for
 * the morning. A text is skipped if its campaign was cancelled, the customer stopped texts
 * or was anonymized since; a STOP reported by Twilio (21610) is recorded on the customer.
 */
export async function deliverCampaignSms(db: Db, cfg: SmsDeliveryConfig, now = new Date(), limit = 100) {
  const result = { sent: 0, skipped: 0, retried: 0, failed: 0, deferred: 0 };
  const window = sendingWindow(now);
  if (!window.open) {
    const { rowCount } = await db.query(
      `UPDATE public.ticketing_campaign_messages SET next_attempt_at = $2 WHERE status = 'pending' AND phone IS NOT NULL AND next_attempt_at <= $1`,
      [now, window.nextOpen],
    );
    result.deferred = rowCount ?? 0;
    return result;
  }
  for (let i = 0; i < limit; i++) {
    const outcome = await withTransaction(db, async (tx) => {
      const { rows } = await tx.query<{
        id: string; customer_id: string | null; phone: string; attempts: number; created_at: Date; campaign_status: string; language: Language;
        body: string; cta_url: string | null; brand_name: string; first_name: string | null; stopped: boolean; anonymized: boolean;
      }>(
        `SELECT m.id, m.customer_id, m.phone, m.attempts, m.created_at, c.status AS campaign_status, c.language, c.body, c.cta_url,
                br.name AS brand_name, cu.first_name, (cu.sms_opt_out_at IS NOT NULL) AS stopped, (cu.anonymized_at IS NOT NULL) AS anonymized
         FROM public.ticketing_campaign_messages m
         JOIN public.ticketing_campaigns c ON c.id = m.campaign_id AND c.client_id = m.client_id AND c.brand_id = m.brand_id
         JOIN public.ticketing_brands br ON br.id = m.brand_id AND br.client_id = m.client_id
         LEFT JOIN public.ticketing_customers cu ON cu.id = m.customer_id AND cu.client_id = m.client_id AND cu.brand_id = m.brand_id
         WHERE m.status = 'pending' AND m.phone IS NOT NULL AND m.next_attempt_at <= $1
         ORDER BY m.next_attempt_at, m.id LIMIT 1 FOR UPDATE OF m SKIP LOCKED`,
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
      if (row.stopped) return skip("unsubscribed");
      if (now.getTime() - row.created_at.getTime() > MAX_AGE_MS) return skip("too_old");
      try {
        const sid = await cfg.sender.send({ to: e164(row.phone), body: smsText({ language: row.language, body: row.body, firstName: row.first_name, brandName: row.brand_name, link: row.cta_url }) });
        await tx.query(
          `UPDATE public.ticketing_campaign_messages SET status = 'sent', sent_at = $2, attempts = attempts + 1, provider_message_id = $3, last_error = NULL WHERE id = $1`,
          [row.id, now, sid],
        );
        return "sent" as const;
      } catch (error) {
        const e = error instanceof SmsSendError ? error : new SmsSendError(String((error as Error).message ?? error), true);
        if (e.optedOut && row.customer_id) {
          await tx.query(`UPDATE public.ticketing_customers SET sms_opt_out_at = coalesce(sms_opt_out_at, $2) WHERE id = $1`, [row.customer_id, now]);
        }
        const attempts = row.attempts + 1;
        const giveUp = !e.retryable || attempts >= MAX_ATTEMPTS;
        await tx.query(
          `UPDATE public.ticketing_campaign_messages SET status = $2, attempts = $3, next_attempt_at = $4, last_error = left($5, 500) WHERE id = $1`,
          [row.id, giveUp ? "failed" : "pending", attempts, new Date(now.getTime() + backoffMs(attempts)), e.message],
        );
        return giveUp ? ("failed" as const) : ("retried" as const);
      }
    });
    if (!outcome) break;
    result[outcome]++;
  }
  return result;
}

// ── Twilio's webhook: replies (STOP / START) ────────────────────────────────
/** X-Twilio-Signature: base64 HMAC-SHA1 of the URL followed by the sorted form fields. */
export function twilioSignatureValid(authToken: string, url: string, params: Record<string, string>, signature: string): boolean {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const expected = Buffer.from(createHmac("sha1", authToken).update(data).digest("base64"));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const STOP_WORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit", "arret", "arreter", "desabonner", "desabonnement"]);
const START_WORDS = new Set(["start", "unstop", "yes", "oui", "reprendre"]);

/** What a reply asks for: stop texts, start them again, or nothing ALKAO acts on. */
export function replyIntent(body: string): "stop" | "start" | null {
  const word = body.normalize("NFKD").replace(/\p{M}/gu, "").trim().toLowerCase().replace(/[^a-z]/g, "");
  return STOP_WORDS.has(word) ? "stop" : START_WORDS.has(word) ? "start" : null;
}
