import { DomainError } from "../domain/errors.js";
import { toApi, writeAudit } from "./catalog.js";
import type { TenantScope } from "./commerce.js";
import { mapDbErrors } from "./errors.js";
import type { Db, Tx } from "./pool.js";

type Queryable = Db | Tx;

/**
 * Run 72: presale codes. A code opens an event's sale to its holders from `opens_at`, before
 * the public sale (sales_open_at). Same prices, seats and end of sales as everyone else.
 */
const COLUMNS = "id, event_id, code, label, opens_at, active, created_at, updated_at";
export const normalizePresale = (code: string) => code.trim().toUpperCase();

export async function listPresaleCodes(q: Queryable, s: TenantScope, eventId: string) {
  const { rows } = await q.query(
    `SELECT ${COLUMNS} FROM public.ticketing_presale_codes WHERE event_id = $1 AND client_id = $2 AND brand_id = $3 ORDER BY opens_at, code`,
    [eventId, s.clientId, s.brandId],
  );
  return rows.map(toApi);
}

export async function createPresaleCode(
  tx: Tx, s: TenantScope, eventId: string, p: { code: string; label?: string | null | undefined; opensAt: string },
  actor: { type: "user"; id: string | null },
) {
  return mapDbErrors(async () => {
    const { rows: ev } = await tx.query(`SELECT 1 FROM public.ticketing_events WHERE id = $1 AND client_id = $2 AND brand_id = $3`, [eventId, s.clientId, s.brandId]);
    if (!ev[0]) throw new DomainError("event_not_found");
    try {
      const { rows } = await tx.query(
        `INSERT INTO public.ticketing_presale_codes (client_id, brand_id, event_id, code, label, opens_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLUMNS}`,
        [s.clientId, s.brandId, eventId, normalizePresale(p.code), p.label?.trim() || null, p.opensAt],
      );
      await writeAudit(tx, s, actor, "presale_code.created", { type: "presale_code", id: rows[0].id }, { eventId, code: rows[0].code });
      return toApi(rows[0]);
    } catch (error) {
      if ((error as { constraint?: string }).constraint === "ticketing_presale_codes_code_key") throw new DomainError("presale_code_exists");
      throw error;
    }
  });
}

export async function updatePresaleCode(tx: Tx, s: TenantScope, id: string, p: { active: boolean }, actor: { type: "user"; id: string | null }) {
  return mapDbErrors(async () => {
    const { rows } = await tx.query(
      `UPDATE public.ticketing_presale_codes SET active = $4, updated_at = now() WHERE id = $1 AND client_id = $2 AND brand_id = $3 RETURNING ${COLUMNS}`,
      [id, s.clientId, s.brandId, p.active],
    );
    if (!rows[0]) throw new DomainError("presale_code_not_found");
    await writeAudit(tx, s, actor, "presale_code.updated", { type: "presale_code", id }, { active: p.active });
    return toApi(rows[0]);
  });
}

/** An active code of this event, with the time it opens the sale; null when there is none. */
export async function presaleOpening(q: Queryable, s: TenantScope, eventId: string, code: string): Promise<Date | null> {
  const { rows } = await q.query<{ opens_at: Date }>(
    `SELECT opens_at FROM public.ticketing_presale_codes
     WHERE event_id = $1 AND client_id = $2 AND brand_id = $3 AND code = $4 AND active`,
    [eventId, s.clientId, s.brandId, normalizePresale(code)],
  );
  return rows[0]?.opens_at ?? null;
}
