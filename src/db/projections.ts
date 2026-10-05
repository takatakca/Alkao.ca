import type { ControlEvent } from "../contracts/control-v1.js";
import { DomainError } from "../domain/errors.js";
import { mapDbErrors } from "./errors.js";
import type { Tx } from "./pool.js";

export type ControlOutcome = "applied" | "stale" | "duplicate";

/**
 * Apply one alkao.control.v1 event to the local projections, idempotently.
 *
 * The inbox row is inserted first: a concurrent redelivery of the same event blocks on the
 * primary key and then sees a duplicate. Each projection write only lands if the event's
 * master version is newer than the stored one ("stale" otherwise).
 */
export async function applyControlEvent(tx: Tx, event: ControlEvent, keyId: string): Promise<ControlOutcome> {
  return mapDbErrors(async () => {
    const clientId = event.data.clientId;
    const inbox = await tx.query(
      `INSERT INTO public.ticketing_control_events (event_id, contract_version, type, client_id, issued_at, outcome)
       VALUES ($1, $2, $3, $4, $5, 'applied')
       ON CONFLICT (event_id) DO NOTHING`,
      [event.eventId, event.contract, event.type, clientId, event.issuedAt],
    );
    if ((inbox.rowCount ?? 0) === 0) return "duplicate";

    const applied = await applyProjection(tx, event);
    if (!applied) {
      await tx.query(`UPDATE public.ticketing_control_events SET outcome = 'stale' WHERE event_id = $1`, [event.eventId]);
      return "stale";
    }

    const brandId = "brandId" in event.data ? event.data.brandId : null;
    await tx.query(
      `INSERT INTO public.ticketing_audit_log (client_id, brand_id, actor_type, actor_id, action, entity_type, entity_id, data)
       VALUES ($1, $2, 'control', $3, $4, $5, $6, $7)`,
      [
        clientId,
        event.type === "entitlement.updated" ? brandId : null,
        keyId,
        `control.${event.type.replace(".", "_")}`,
        event.type.split(".")[0],
        "userId" in event.data ? event.data.userId : (brandId ?? clientId),
        { eventId: event.eventId, version: event.data.version },
      ],
    );
    return "applied";
  });
}

async function requireClient(tx: Tx, clientId: string): Promise<void> {
  const { rowCount } = await tx.query(`SELECT 1 FROM public.ticketing_clients WHERE id = $1`, [clientId]);
  if (!rowCount) throw new DomainError("unknown_client");
}

async function applyProjection(tx: Tx, event: ControlEvent): Promise<boolean> {
  switch (event.type) {
    case "client.upserted": {
      const d = event.data;
      const r = await tx.query(
        `INSERT INTO public.ticketing_clients
           (id, name, status, timezone, commission_rate_bps, commission_fixed_cents, master_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, status = EXCLUDED.status, timezone = EXCLUDED.timezone,
           commission_rate_bps = EXCLUDED.commission_rate_bps,
           commission_fixed_cents = EXCLUDED.commission_fixed_cents,
           master_version = EXCLUDED.master_version
         WHERE ticketing_clients.master_version < EXCLUDED.master_version`,
        [d.clientId, d.name, d.status, d.timezone, d.commission.rateBps, d.commission.fixedCentsPerPaidAdmission, d.version],
      );
      return (r.rowCount ?? 0) === 1;
    }
    case "brand.upserted": {
      const d = event.data;
      await requireClient(tx, d.clientId);
      const { rows } = await tx.query<{ client_id: string }>(`SELECT client_id FROM public.ticketing_brands WHERE id = $1`, [d.brandId]);
      if (rows[0] && rows[0].client_id !== d.clientId) throw new DomainError("brand_client_mismatch");
      const r = await tx.query(
        `INSERT INTO public.ticketing_brands (id, client_id, name, status, master_version)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, status = EXCLUDED.status, master_version = EXCLUDED.master_version
         WHERE ticketing_brands.master_version < EXCLUDED.master_version`,
        [d.brandId, d.clientId, d.name, d.status, d.version],
      );
      return (r.rowCount ?? 0) === 1;
    }
    case "membership.upserted":
    case "membership.removed": {
      const d = event.data;
      await requireClient(tx, d.clientId);
      const role = event.type === "membership.upserted" ? event.data.role : null;
      const status = event.type === "membership.upserted" ? event.data.status : "suspended";
      const r = await tx.query(
        `INSERT INTO public.ticketing_memberships (client_id, user_id, role, status, master_version)
         VALUES ($1, $2, coalesce($3, 'viewer'), $4, $5)
         ON CONFLICT (client_id, user_id) DO UPDATE SET
           role = coalesce($3, ticketing_memberships.role), status = EXCLUDED.status,
           master_version = EXCLUDED.master_version
         WHERE ticketing_memberships.master_version < EXCLUDED.master_version`,
        [d.clientId, d.userId, role, status, d.version],
      );
      return (r.rowCount ?? 0) === 1;
    }
    case "entitlement.updated": {
      const d = event.data;
      await requireClient(tx, d.clientId);
      const { rows } = await tx.query<{ client_id: string }>(`SELECT client_id FROM public.ticketing_brands WHERE id = $1`, [d.brandId]);
      if (!rows[0]) throw new DomainError("unknown_brand");
      if (rows[0].client_id !== d.clientId) throw new DomainError("brand_client_mismatch");
      const r = await tx.query(
        `INSERT INTO public.ticketing_entitlements
           (client_id, brand_id, status, contract_version, valid_from, valid_until, master_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (client_id, brand_id) DO UPDATE SET
           status = EXCLUDED.status, contract_version = EXCLUDED.contract_version,
           valid_from = EXCLUDED.valid_from, valid_until = EXCLUDED.valid_until,
           master_version = EXCLUDED.master_version
         WHERE ticketing_entitlements.master_version < EXCLUDED.master_version`,
        [d.clientId, d.brandId, d.status, event.contract, d.validFrom, d.validUntil, d.version],
      );
      return (r.rowCount ?? 0) === 1;
    }
  }
}
