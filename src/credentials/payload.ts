import { isUuid } from "../domain/ids.js";

/**
 * QR payload, format ALK1 (frozen rule: stable identifiers and key information only):
 *
 *   ALK1.<kid>.<credential id, 16 bytes base64url>.<Ed25519 signature, base64url>
 *
 * The signature covers "ALK1.<kid>.<credential id>". No event, session, date, price or
 * buyer data: validity and revocation come from the scanner manifest.
 */

export const PAYLOAD_VERSION = "ALK1";
const PAYLOAD_RE = /^ALK1\.(k[0-9a-z]{10})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{86})$/;

export interface ParsedPayload {
  kid: string;
  credentialId: string;
  signedMessage: string;
  signature: Buffer;
}

export function uuidToB64(uuid: string): string {
  return Buffer.from(uuid.replaceAll("-", ""), "hex").toString("base64url");
}

export function b64ToUuid(b64: string): string {
  const hex = Buffer.from(b64, "base64url").toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function signedPart(kid: string, credentialId: string): string {
  return `${PAYLOAD_VERSION}.${kid}.${uuidToB64(credentialId)}`;
}

export function buildPayload(kid: string, credentialId: string, signature: Buffer): string {
  return `${signedPart(kid, credentialId)}.${signature.toString("base64url")}`;
}

export function parsePayload(raw: string): ParsedPayload | null {
  const m = PAYLOAD_RE.exec(raw.trim());
  if (!m) return null;
  const credentialId = b64ToUuid(m[2]!);
  if (!isUuid(credentialId)) return null;
  const signature = Buffer.from(m[3]!, "base64url");
  if (signature.length !== 64) return null;
  return { kid: m[1]!, credentialId, signedMessage: `${PAYLOAD_VERSION}.${m[1]}.${m[2]}`, signature };
}
