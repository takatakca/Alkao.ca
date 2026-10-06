import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Run 48: what Resend reports after a message left. Its webhooks are signed the Svix way:
 * base64 HMAC-SHA256 of "id.timestamp.body", keyed with the secret's base64 part (after
 * "whsec_"); the header can carry several "v1,<signature>" separated by spaces. A delivery
 * older or newer than 5 minutes is refused, so a captured request cannot be replayed.
 */
export function resendSignatureValid(
  secret: string,
  h: { id: string | undefined; timestamp: string | undefined; signature: string | undefined },
  body: string,
  now: Date,
  toleranceSeconds = 300,
): boolean {
  if (!h.id || !h.timestamp || !h.signature || !/^\d{1,12}$/.test(h.timestamp)) return false;
  if (Math.abs(now.getTime() / 1000 - Number(h.timestamp)) > toleranceSeconds) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = Buffer.from(createHmac("sha256", key).update(`${h.id}.${h.timestamp}.${body}`).digest("base64"));
  return h.signature.split(" ").some((part) => {
    const comma = part.indexOf(",");
    if (comma < 0 || part.slice(0, comma) !== "v1") return false;
    const given = Buffer.from(part.slice(comma + 1));
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

export interface EmailEvent {
  /** bounce: the address refused it for good (or Resend no longer sends to it). complaint: marked as spam. */
  kind: "bounce" | "complaint";
  /** Resend's id for the message, as ALKAO stored it when sending. */
  emailId: string | null;
  to: string[];
  /** Short reason, e.g. "General" or "Suppressed" (never the server's full answer). */
  detail: string | null;
}

const address = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const inner = /<([^<>]+)>\s*$/.exec(value)?.[1] ?? value;
  const e = inner.trim().toLowerCase();
  return e.length <= 320 && /^[^@\s]+@[^@\s]+$/.test(e) ? e : null;
};

const short = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim().slice(0, 60) : null);

/**
 * What ALKAO acts on: a permanent bounce, a message Resend refused to send (the address is
 * on its suppression list), and a spam complaint. A temporary bounce is left alone: the
 * mailbox may be full today and fine tomorrow. Anything else: null.
 */
export function emailEventOf(payload: unknown): EmailEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const { type, data } = payload as { type?: unknown; data?: Record<string, unknown> };
  if (!data || typeof data !== "object") return null;
  const bounce = (data.bounce ?? {}) as { type?: unknown; subType?: unknown };
  let kind: EmailEvent["kind"];
  if (type === "email.bounced" && bounce.type === "Permanent") kind = "bounce";
  else if (type === "email.suppressed") kind = "bounce";
  else if (type === "email.complained") kind = "complaint";
  else return null;
  const to = (Array.isArray(data.to) ? data.to : [data.to]).map(address).filter((e): e is string => e !== null);
  const emailId = typeof data.email_id === "string" && data.email_id.length <= 200 ? data.email_id : null;
  return { kind, emailId, to: [...new Set(to)], detail: type === "email.suppressed" ? "Suppressed" : short(bounce.subType) };
}
