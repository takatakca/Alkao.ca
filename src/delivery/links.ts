import { createHash, hkdfSync, randomBytes } from "node:crypto";

/**
 * The buyer's personal ticket link, sent by email: one per order, shared by all its emails.
 * Its token is derived from the server secret, the order id and a random nonce kept with the
 * token's SHA-256 in ticketing_access_tokens (purpose 'email'); the token itself is never
 * stored. A retried or repeated email carries the same link; a new nonce kills the old one.
 */
export function emailLinkToken(masterSecret: string, orderId: string, nonce: Buffer): string {
  return Buffer.from(hkdfSync("sha256", masterSecret, "alkao.email-link.v1", Buffer.concat([Buffer.from(orderId), nonce]), 32)).toString("base64url");
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

type Queryable = { query: (sql: string, params: unknown[]) => Promise<{ rows: { link_nonce: Buffer }[] }> };

/** The order's email link token, creating its nonce on first use. */
export async function orderEmailToken(
  q: Queryable,
  masterSecret: string,
  scope: { clientId: string; brandId: string },
  orderId: string,
  rotate = false,
): Promise<string> {
  if (!rotate) {
    const { rows } = await q.query(
      `SELECT link_nonce FROM public.ticketing_access_tokens
       WHERE subject_type = 'order' AND subject_id = $1 AND purpose = 'email' AND client_id = $2 AND brand_id = $3 AND link_nonce IS NOT NULL`,
      [orderId, scope.clientId, scope.brandId],
    );
    if (rows[0]) return emailLinkToken(masterSecret, orderId, rows[0].link_nonce);
  }
  const nonce = randomBytes(16);
  const token = emailLinkToken(masterSecret, orderId, nonce);
  const { rows } = await q.query(
    `INSERT INTO public.ticketing_access_tokens (token_hash, client_id, brand_id, subject_type, subject_id, purpose, link_nonce)
     VALUES ($1, $2, $3, 'order', $4, 'email', $5)
     ON CONFLICT (subject_type, subject_id, purpose) DO UPDATE
       SET token_hash = EXCLUDED.token_hash, link_nonce = EXCLUDED.link_nonce, created_at = now()
       WHERE $6::boolean OR ticketing_access_tokens.link_nonce IS NULL
     RETURNING link_nonce`,
    [tokenHash(token), scope.clientId, scope.brandId, orderId, nonce, rotate],
  );
  if (rows[0]) return token;
  // Another worker created it first: use theirs.
  return orderEmailToken(q, masterSecret, scope, orderId, false);
}
