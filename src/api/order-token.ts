import { createHash } from "node:crypto";
import type { Db } from "../db/pool.js";
import type { TenantScope } from "../db/commerce.js";

/**
 * Authorizes a buyer's order-scoped bearer token. SQL enforces the tenant and
 * optional expiry before any order, QR or exchange data is accessed.
 * Existing never-expiring order links stay valid; future time-limited tokens
 * can be issued without creating a second authorization path.
 */
export async function validOrderAccessToken(
  db: Db, scope: TenantScope, orderId: string, token: string | undefined, now: Date,
): Promise<boolean> {
  if (!token || token.length > 100) return false;
  const hash = createHash("sha256").update(token).digest();
  const { rowCount } = await db.query(
    `SELECT 1 FROM public.ticketing_access_tokens
     WHERE token_hash = $1 AND subject_type = 'order' AND subject_id = $2
       AND client_id = $3 AND brand_id = $4
       AND (expires_at IS NULL OR expires_at > $5)`,
    [hash, orderId, scope.clientId, scope.brandId, now],
  );
  return Boolean(rowCount);
}
