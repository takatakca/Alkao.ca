import { toApi } from "../db/catalog.js";
import type { TenantScope } from "../db/commerce.js";
import type { Db } from "../db/pool.js";
import { DomainError } from "../domain/errors.js";

/**
 * Run 30: the audit journal, readable by staff. The log itself is unchanged; this only reads
 * it, with filters, paging that never skips entries written in the same instant (the cursor
 * is an entry id; its exact time is read from the database, which keeps microseconds that
 * JSON loses), and the role the person who acted holds today (TAKATAK keeps names and
 * emails, ALKAO does not).
 */
const COLUMNS = `a.id, a.brand_id, a.actor_type, a.actor_id, m.role AS actor_role, a.action, a.entity_type, a.entity_id, a.data, a.created_at`;
const ACTOR_ROLE = `LEFT JOIN public.ticketing_memberships m
  ON a.actor_type = 'user' AND m.client_id = a.client_id AND m.user_id::text = a.actor_id`;

export interface JournalQuery {
  limit: number;
  before?: string | undefined;
  beforeId?: number | undefined;
  action?: string | undefined;
  entityType?: string | undefined;
  entityId?: string | undefined;
}

export async function listJournal(db: Db, s: TenantScope, q: JournalQuery) {
  const { rows } = await db.query(
    `SELECT ${COLUMNS}
     FROM public.ticketing_audit_log a ${ACTOR_ROLE}
     WHERE a.client_id = $1 AND (a.brand_id = $2 OR a.brand_id IS NULL)
       AND ($4::timestamptz IS NULL OR a.created_at < $4)
       AND ($5::bigint IS NULL OR (a.created_at, a.id) <
            (SELECT c.created_at, c.id FROM public.ticketing_audit_log c WHERE c.id = $5 AND c.client_id = $1))
       AND ($6::text IS NULL OR a.action = $6 OR starts_with(a.action, $6 || '.'))
       AND ($7::text IS NULL OR a.entity_type = $7)
       AND ($8::text IS NULL OR a.entity_id = $8)
     ORDER BY a.created_at DESC, a.id DESC LIMIT $3`,
    [s.clientId, s.brandId, q.limit, q.before ?? null, q.beforeId ?? null, q.action ?? null, q.entityType ?? null, q.entityId ?? null],
  );
  return rows.map(toApi);
}

/**
 * Everything logged about one order, oldest first: the order itself, its refunds, its tickets
 * (reissued, let in by hand), the exchange that created it, and its buyer (anonymized).
 */
export async function orderHistory(db: Db, s: TenantScope, orderId: string) {
  const { rows: order } = await db.query<{ id: string; buyer_id: string }>(
    `SELECT id, buyer_id FROM public.ticketing_orders WHERE id = $1 AND client_id = $2 AND brand_id = $3`,
    [orderId, s.clientId, s.brandId],
  );
  if (!order[0]) throw new DomainError("order_not_found");
  const { rows: tickets } = await db.query<{ id: string }>(
    `SELECT id::text AS id FROM public.ticketing_tickets WHERE order_id = $1 AND client_id = $2 AND brand_id = $3`,
    [orderId, s.clientId, s.brandId],
  );
  // Each branch matches one index (see the Run 30 migration).
  const { rows } = await db.query(
    `SELECT ${COLUMNS}
     FROM public.ticketing_audit_log a ${ACTOR_ROLE}
     WHERE a.client_id = $1 AND (a.brand_id = $2 OR a.brand_id IS NULL)
       AND ((a.entity_type = 'order' AND a.entity_id = $3)
         OR (a.data ? 'orderId' AND a.data->>'orderId' = $3)
         OR (a.data ? 'exchangeOrderId' AND a.data->>'exchangeOrderId' = $3)
         OR (a.entity_type = 'ticket' AND a.entity_id = ANY($4::text[]))
         OR (a.entity_type = 'buyer' AND a.entity_id = $5))
     ORDER BY a.created_at, a.id LIMIT 500`,
    [s.clientId, s.brandId, orderId, tickets.map((t) => t.id), order[0].buyer_id],
  );
  return rows.map(toApi);
}
