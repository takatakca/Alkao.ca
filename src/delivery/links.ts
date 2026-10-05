import { createHash, hkdfSync } from "node:crypto";

/**
 * The buyer's personal ticket link, sent by email. Its token is derived from the server
 * secret and the outbox row id, never stored: a retried send carries the same link, and
 * only its SHA-256 lands in ticketing_access_tokens (purpose 'email').
 */
export function emailLinkToken(masterSecret: string, outboxId: string): string {
  return Buffer.from(hkdfSync("sha256", masterSecret, "alkao.email-link.v1", outboxId, 32)).toString("base64url");
}

export const tokenHash = (token: string) => createHash("sha256").update(token).digest();

export interface TicketsLink {
  clientId: string;
  brandId: string;
  orderId: string;
  token: string;
}

/**
 * `${publicUrl}/billets#c=…&b=…&o=…&k=…`. Everything after `#` stays in the browser:
 * the token is never sent to a server, logged, or leaked through Referer.
 */
export function ticketsUrl(publicUrl: string, l: TicketsLink): string {
  const params = new URLSearchParams({ c: l.clientId, b: l.brandId, o: l.orderId, k: l.token });
  return `${publicUrl.replace(/\/+$/, "")}/billets#${params.toString()}`;
}
