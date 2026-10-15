import { createHash, hkdfSync } from "node:crypto";
import type { TenantScope } from "../db/commerce.js";

/** Never persist or log this secret. A trusted mail worker reconstructs it from
 * the server-only master key and the immutable, randomly generated request ID.
 * Domain separation means a ticket-link secret cannot become a transfer token.
 */
export function transferClaimSecret(masterSecret: string, scope: TenantScope,
  requestId: string, ticketId: string, recipientEmail: string): string {
  if (!masterSecret || masterSecret.length < 16) throw new Error("transfer_master_secret_missing");
  const info = Buffer.from(JSON.stringify([
    requestId, scope.clientId, scope.brandId, ticketId, recipientEmail.toLowerCase().trim(),
  ]));
  return Buffer.from(hkdfSync("sha256", masterSecret, "alkao.transfer.claim.v1", info, 32)).toString("base64url");
}

/** Independent ticket-view capability. Possession of the original claim code
 * cannot be used as the access token and a second claim changes no state.
 * Only a verified acceptance response may return this token to the recipient.
 */
export function transferAccessSecret(masterSecret: string, scope: TenantScope,
  requestId: string, ticketId: string, recipientEmail: string): string {
  if (!masterSecret || masterSecret.length < 16) throw new Error("transfer_master_secret_missing");
  const info = Buffer.from(JSON.stringify([
    requestId, scope.clientId, scope.brandId, ticketId, recipientEmail.toLowerCase().trim(),
  ]));
  return Buffer.from(hkdfSync("sha256", masterSecret, "alkao.transfer.access.v1", info, 32)).toString("base64url");
}

export const transferClaimHash = (secret: string): Buffer =>
  createHash("sha256").update(secret).digest();

/** A URL fragment keeps the proof out of reverse-proxy logs and Referer headers.
 * This link must NOT be dispatched until the verified claim page is deployed.
 */
export function transferClaimUrl(publicUrl: string, scope: TenantScope,
  requestId: string, secret: string): string {
  const p = new URLSearchParams({ c: scope.clientId, b: scope.brandId, r: requestId, k: secret });
  return `${publicUrl.replace(/\/+$/, "")}/billets/transfert#${p.toString()}`;
}
