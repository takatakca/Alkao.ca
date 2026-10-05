import { randomBytes } from "node:crypto";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Validates a TAKATAK master id (or any ALKAO id) before it is stored or queried. */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

// Crockford base32 without I, L, O, U: unambiguous when read aloud at a gate.
const REFERENCE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Human order reference, e.g. "7KQ2-M9XD" (~40 bits). Uniqueness is enforced by the DB. */
export function newOrderReference(random: (size: number) => Buffer = randomBytes): string {
  const bytes = random(8);
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += REFERENCE_ALPHABET[bytes[i]! % 32];
    if (i === 3) out += "-";
  }
  return out;
}

export const ORDER_REFERENCE_RE = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
