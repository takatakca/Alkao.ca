import type { EntitlementStatus, GateInput, MasterStatus } from "../domain/entitlement.js";
import type { WorkspaceRole } from "../domain/permissions.js";
import type { Db } from "./pool.js";

/** Load everything the Ticketing gate needs for one (Client, Brand) pair in one query. */
export async function loadGateRecords(db: Db, clientId: string, brandId: string): Promise<Pick<GateInput, "client" | "brand" | "entitlement">> {
  const { rows } = await db.query<{
    c_id: string | null;
    c_status: MasterStatus | null;
    b_id: string | null;
    b_client: string | null;
    b_status: MasterStatus | null;
    e_status: EntitlementStatus | null;
    e_from: Date | null;
    e_until: Date | null;
  }>(
    `SELECT c.id AS c_id, c.status AS c_status,
            b.id AS b_id, b.client_id AS b_client, b.status AS b_status,
            e.status AS e_status, e.valid_from AS e_from, e.valid_until AS e_until
     FROM (SELECT $1::uuid AS cid, $2::uuid AS bid) p
     LEFT JOIN public.ticketing_clients c ON c.id = p.cid
     LEFT JOIN public.ticketing_brands b ON b.id = p.bid
     LEFT JOIN public.ticketing_entitlements e ON e.client_id = p.cid AND e.brand_id = p.bid`,
    [clientId, brandId],
  );
  const r = rows[0]!;
  return {
    client: r.c_id && r.c_status ? { id: r.c_id, status: r.c_status } : null,
    brand: r.b_id && r.b_client && r.b_status ? { id: r.b_id, clientId: r.b_client, status: r.b_status } : null,
    entitlement: r.e_status ? { status: r.e_status, validFrom: r.e_from, validUntil: r.e_until } : null,
  };
}

/** The caller's active role in a Client, or null. */
export async function loadMembershipRole(db: Db, clientId: string, userId: string): Promise<WorkspaceRole | null> {
  const { rows } = await db.query<{ role: WorkspaceRole }>(
    `SELECT role FROM public.ticketing_memberships WHERE client_id = $1 AND user_id = $2 AND status = 'active'`,
    [clientId, userId],
  );
  return rows[0]?.role ?? null;
}
