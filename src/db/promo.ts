import { DomainError } from "../domain/errors.js";
import type { PromoDiscount } from "../domain/pricing.js";
import { toApi, writeAudit } from "./catalog.js";
import type { TenantScope } from "./commerce.js";
import { mapDbErrors } from "./errors.js";
import type { Db, Tx } from "./pool.js";

/**
 * Run 36: promo codes (owner decision, docs/ALKAO_DECISIONS.md). One event per code; a
 * percentage or a fixed amount off the pre-tax subtotal; optional uses and dates. Uses are
 * counted by the database when an order is created with the code (see the migration).
 */
type Queryable = Db | Tx;

export interface PromoRow extends PromoDiscount {
  id: string;
  eventId: string;
  maxUses: number | null;
  usedCount: number;
  startsAt: Date | null;
  endsAt: Date | null;
  active: boolean;
}

const COLUMNS = "id, event_id, code, kind, percent, amount_cents, max_uses, used_count, starts_at, ends_at, active, created_at, updated_at";
const fromRow = (r: Record<string, unknown>): PromoRow => ({
  id: r.id as string, eventId: r.event_id as string, code: r.code as string, kind: r.kind as "percent" | "amount",
  percent: (r.percent as number | null) ?? null, amountCents: (r.amount_cents as number | null) ?? null,
  maxUses: (r.max_uses as number | null) ?? null, usedCount: r.used_count as number,
  startsAt: (r.starts_at as Date | null) ?? null, endsAt: (r.ends_at as Date | null) ?? null, active: r.active as boolean,
});

/** Codes are typed by buyers: case and spaces around them do not matter. */
export const normalizeCode = (code: string) => code.trim().toUpperCase();

/** Why a code cannot be used now, or null if it can. */
export function promoProblem(p: PromoRow, now: Date): "inactive" | "not_started" | "ended" | "used_up" | null {
  if (!p.active) return "inactive";
  if (p.startsAt && now < p.startsAt) return "not_started";
  if (p.endsAt && now >= p.endsAt) return "ended";
  if (p.maxUses !== null && p.usedCount >= p.maxUses) return "used_up";
  return null;
}

/** The event's code, if a buyer can use it now; otherwise `promo_code_invalid` with the reason. */
export async function usablePromo(q: Queryable, s: TenantScope, eventId: string, code: string, now: Date): Promise<PromoRow> {
  const { rows } = await q.query(
    `SELECT ${COLUMNS} FROM public.ticketing_promo_codes WHERE event_id = $1 AND client_id = $2 AND brand_id = $3 AND code = $4`,
    [eventId, s.clientId, s.brandId, normalizeCode(code)],
  );
  if (!rows[0]) throw new DomainError("promo_code_invalid", { reason: "unknown" });
  const promo = fromRow(rows[0]);
  const problem = promoProblem(promo, now);
  if (problem) throw new DomainError("promo_code_invalid", { reason: problem });
  return promo;
}

/** The code attached to a hold, if any (checkout prices the order with it). */
export async function promoOfHold(tx: Tx, s: TenantScope, holdId: string): Promise<PromoRow | null> {
  const { rows } = await tx.query(
    `SELECT ${COLUMNS.split(", ").map((c) => `p.${c}`).join(", ")}
     FROM public.ticketing_holds h JOIN public.ticketing_promo_codes p ON p.id = h.promo_code_id AND p.client_id = h.client_id AND p.brand_id = h.brand_id
     WHERE h.id = $1 AND h.client_id = $2 AND h.brand_id = $3`,
    [holdId, s.clientId, s.brandId],
  );
  return rows[0] ? fromRow(rows[0]) : null;
}

// ── Staff ───────────────────────────────────────────────────────────────────
export async function listPromoCodes(q: Queryable, s: TenantScope, eventId: string) {
  const { rows } = await q.query(
    `SELECT ${COLUMNS} FROM public.ticketing_promo_codes WHERE event_id = $1 AND client_id = $2 AND brand_id = $3 ORDER BY created_at DESC`,
    [eventId, s.clientId, s.brandId],
  );
  return rows.map(toApi);
}

export async function createPromoCode(
  tx: Tx, s: TenantScope, eventId: string,
  p: { code: string; kind: "percent" | "amount"; percent?: number | null | undefined; amountCents?: number | null | undefined; maxUses?: number | null | undefined; startsAt?: string | null | undefined; endsAt?: string | null | undefined },
  actor: { type: "user"; id: string | null },
) {
  return mapDbErrors(async () => {
    const { rows: ev } = await tx.query(`SELECT 1 FROM public.ticketing_events WHERE id = $1 AND client_id = $2 AND brand_id = $3`, [eventId, s.clientId, s.brandId]);
    if (!ev[0]) throw new DomainError("event_not_found");
    try {
      const { rows } = await tx.query(
        `INSERT INTO public.ticketing_promo_codes (client_id, brand_id, event_id, code, kind, percent, amount_cents, max_uses, starts_at, ends_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING ${COLUMNS}`,
        [s.clientId, s.brandId, eventId, normalizeCode(p.code), p.kind, p.kind === "percent" ? p.percent : null, p.kind === "amount" ? p.amountCents : null,
          p.maxUses ?? null, p.startsAt ?? null, p.endsAt ?? null],
      );
      await writeAudit(tx, s, actor, "promo_code.created", { type: "promo_code", id: rows[0].id }, { eventId, code: rows[0].code, kind: p.kind });
      return toApi(rows[0]);
    } catch (error) {
      if ((error as { constraint?: string }).constraint === "ticketing_promo_codes_code_key") throw new DomainError("promo_code_exists");
      throw error;
    }
  });
}

export async function updatePromoCode(
  tx: Tx, s: TenantScope, id: string,
  p: { active?: boolean | undefined; maxUses?: number | null | undefined; startsAt?: string | null | undefined; endsAt?: string | null | undefined },
  actor: { type: "user"; id: string | null },
) {
  return mapDbErrors(async () => {
    const sets: string[] = [];
    const values: unknown[] = [id, s.clientId, s.brandId];
    for (const [key, column] of [["active", "active"], ["maxUses", "max_uses"], ["startsAt", "starts_at"], ["endsAt", "ends_at"]] as const) {
      if (p[key] !== undefined) { values.push(p[key]); sets.push(`${column} = $${values.length}`); }
    }
    if (sets.length === 0) throw new DomainError("empty_update");
    try {
      const { rows } = await tx.query(
        `UPDATE public.ticketing_promo_codes SET ${sets.join(", ")} WHERE id = $1 AND client_id = $2 AND brand_id = $3 RETURNING ${COLUMNS}`,
        values,
      );
      if (!rows[0]) throw new DomainError("promo_code_not_found");
      await writeAudit(tx, s, actor, "promo_code.updated", { type: "promo_code", id }, { fields: Object.keys(p).filter((k) => p[k as keyof typeof p] !== undefined) });
      return toApi(rows[0]);
    } catch (error) {
      // Fewer uses than already made: refused, never silently lowered below what was sold.
      if ((error as { constraint?: string }).constraint === "ticketing_promo_codes_uses_ck") throw new DomainError("promo_uses_below_used");
      throw error;
    }
  });
}
