import { createHmac, timingSafeEqual } from "node:crypto";

/** Maximum clock skew / replay window for control deliveries. */
export const CONTROL_TOLERANCE_SECONDS = 300;

/** `v1=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>` — what TAKATAK sends. */
export function signControlPayload(secret: string, timestamp: number, rawBody: string): string {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}

export type SignatureCheck = { ok: true } | { ok: false; reason: "missing_headers" | "unknown_key" | "stale_timestamp" | "bad_signature" };

export function verifyControlSignature(input: {
  keys: ReadonlyMap<string, string>;
  keyId: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
  rawBody: string;
  now: Date;
}): SignatureCheck {
  const { keyId, timestamp, signature } = input;
  if (!keyId || !timestamp || !signature) return { ok: false, reason: "missing_headers" };
  const secret = input.keys.get(keyId);
  if (!secret) return { ok: false, reason: "unknown_key" };
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: "stale_timestamp" };
  const ts = Number(timestamp);
  if (Math.abs(input.now.getTime() / 1000 - ts) > CONTROL_TOLERANCE_SECONDS) return { ok: false, reason: "stale_timestamp" };
  const expected = Buffer.from(signControlPayload(secret, ts, input.rawBody));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: "bad_signature" };
  return { ok: true };
}
