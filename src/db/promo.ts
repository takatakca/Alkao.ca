import { randomBytes } from "node:crypto";
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
  /** Run 103: the partner company the code was made for, if any. */
  partner: string | null;
  eventId: string;
  maxUses: number | null;
  usedCount: number;
  startsAt: Date | null;
  endsAt: Date | null;
  active: boolean;
}

const COLUMNS = "id, event_id, code, kind, percent, amount_cents, max_uses, used_count, starts_at, ends_at, active, created_at, updated_at, public, label, excludes_presales, partner";
const fromRow = (r: Record<string, unknown>): PromoRow => ({
  id: r.id as string, eventId: r.event_id as string, code: r.code as string, kind: r.kind as "percent" | "amount",
  percent: (r.percent as number | null) ?? null, amountCents: (r.amount_cents as number | null) ?? null,
  maxUses: (r.max_uses as number | null) ?? null, usedCount: r.used_count as number,
  startsAt: (r.starts_at as Date | null) ?? null, endsAt: (r.ends_at as Date | null) ?? null, active: r.active as boolean,
  excludesPresales: r.excludes_presales === true,
  partner: (r.partner as string | null) ?? null,
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

/**
 * Run 97: the event's coupons, as every buyer sees them: public codes usable now, with what
 * they take off, when they end and, for a limited code, how many uses are left.
 */
export async function publicCoupons(q: Queryable, s: TenantScope, eventId: string, now: Date) {
  const { rows } = await q.query(
    `SELECT ${COLUMNS} FROM public.ticketing_promo_codes
     WHERE event_id = $1 AND client_id = $2 AND brand_id = $3 AND public AND active
       AND (starts_at IS NULL OR starts_at <= $4) AND (ends_at IS NULL OR ends_at > $4)
       AND (max_uses IS NULL OR used_count < max_uses)
     ORDER BY coalesce(ends_at, 'infinity'::timestamptz), code`,
    [eventId, s.clientId, s.brandId, now],
  );
  return rows.map((r) => ({
    code: r.code as string, label: (r.label as string | null) ?? null, kind: r.kind as "percent" | "amount",
    percent: (r.percent as number | null) ?? null, amountCents: (r.amount_cents as number | null) ?? null,
    endsAt: (r.ends_at as Date | null) ?? null,
    remaining: r.max_uses === null ? null : Number(r.max_uses) - Number(r.used_count),
    excludesPresales: r.excludes_presales === true,
  }));
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
/** The event's own codes; a partner company's batch is summed up by `partnerBatches` instead. */
export async function listPromoCodes(q: Queryable, s: TenantScope, eventId: string) {
  const { rows } = await q.query(
    `SELECT ${COLUMNS} FROM public.ticketing_promo_codes WHERE event_id = $1 AND client_id = $2 AND brand_id = $3 AND partner IS NULL ORDER BY created_at DESC`,
    [eventId, s.clientId, s.brandId],
  );
  return rows.map(toApi);
}

// ── Run 105: the return offer ──────────────────────────────────────────────
export interface ReturnOffer {
  eventId: string;
  eventTitle: string;
  code: string;
  kind: "percent" | "amount";
  percent: number | null;
  amountCents: number | null;
  label: string | null;
  endsAt: Date | null;
}

/**
 * What an event's buyers are offered for next time: the code the organizer chose, only while
 * a buyer can use it (active, started, not ended, uses left) and its event has a date on sale.
 */
export async function returnOfferFor(q: Queryable, s: TenantScope, eventId: string, now: Date): Promise<ReturnOffer | null> {
  const { rows } = await q.query(
    `SELECT next.id AS event_id, next.title AS event_title, p.code, p.kind, p.percent, p.amount_cents, p.label, p.ends_at
     FROM public.ticketing_events e
     JOIN public.ticketing_promo_codes p ON p.id = e.return_offer_promo_id AND p.client_id = e.client_id AND p.brand_id = e.brand_id
     JOIN public.ticketing_events next ON next.id = p.event_id AND next.client_id = p.client_id AND next.brand_id = p.brand_id AND next.status = 'published'
     WHERE e.id = $1 AND e.client_id = $2 AND e.brand_id = $3 AND p.active AND p.partner IS NULL
       AND (p.starts_at IS NULL OR p.starts_at <= $4) AND (p.ends_at IS NULL OR p.ends_at > $4)
       AND (p.max_uses IS NULL OR p.used_count < p.max_uses)
       AND EXISTS (SELECT 1 FROM public.ticketing_sessions se WHERE se.event_id = next.id AND se.status = 'on_sale' AND se.starts_at > $4)`,
    [eventId, s.clientId, s.brandId, now],
  );
  const r = rows[0];
  return r
    ? { eventId: r.event_id, eventTitle: r.event_title, code: r.code, kind: r.kind, percent: r.percent ?? null, amountCents: r.amount_cents ?? null, label: r.label ?? null, endsAt: r.ends_at ?? null }
    : null;
}

/** The Brand's codes an event can offer its buyers (not partner codes, not over), with their event. */
export async function returnOfferChoices(q: Queryable, s: TenantScope, eventId: string, now: Date) {
  const [{ rows: current }, { rows: choices }] = await Promise.all([
    q.query(`SELECT return_offer_promo_id FROM public.ticketing_events WHERE id = $1 AND client_id = $2 AND brand_id = $3`, [eventId, s.clientId, s.brandId]),
    q.query(
      `SELECT p.id, p.code, p.kind, p.percent, p.amount_cents, p.ends_at, p.active, e.id AS event_id, e.title AS event_title
       FROM public.ticketing_promo_codes p JOIN public.ticketing_events e ON e.id = p.event_id AND e.client_id = p.client_id AND e.brand_id = p.brand_id
       WHERE p.client_id = $1 AND p.brand_id = $2 AND p.partner IS NULL AND (p.ends_at IS NULL OR p.ends_at > $3) AND e.status IN ('draft', 'published')
       ORDER BY (e.id = $4), e.title, p.code`,
      [s.clientId, s.brandId, now, eventId],
    ),
  ]);
  if (!current[0]) throw new DomainError("event_not_found");
  return { promoCodeId: (current[0].return_offer_promo_id as string | null) ?? null, choices: choices.map(toApi) };
}

export async function setReturnOffer(tx: Tx, s: TenantScope, eventId: string, promoCodeId: string | null, actor: { type: "user"; id: string | null }) {
  return mapDbErrors(async () => {
    if (promoCodeId) {
      const { rows } = await tx.query(`SELECT partner FROM public.ticketing_promo_codes WHERE id = $1 AND client_id = $2 AND brand_id = $3`, [promoCodeId, s.clientId, s.brandId]);
      if (!rows[0]) throw new DomainError("promo_code_not_found");
      // A partner company's codes are given out by the company, never offered to every buyer.
      if (rows[0].partner) throw new DomainError("partner_code_private");
    }
    const r = await tx.query(`UPDATE public.ticketing_events SET return_offer_promo_id = $4 WHERE id = $1 AND client_id = $2 AND brand_id = $3`, [eventId, s.clientId, s.brandId, promoCodeId]);
    if (!r.rowCount) throw new DomainError("event_not_found");
    await writeAudit(tx, s, actor, "event.return_offer_set", { type: "event", id: eventId }, { promoCodeId });
    return promoCodeId;
  });
}

// ── Run 103: codes for partner companies ───────────────────────────────────
/** Easy to read out and type: no 0/O, 1/I/L. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const randomPart = (n: number) => Array.from(randomBytes(n), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");

/** "Caisse Desjardins de Valleyfield" → "CAISSEDE": the company's name, as a code can hold it. */
export const partnerPrefix = (partner: string) =>
  partner.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) || "PART";

export interface PartnerBatch {
  partner: string;
  count: number;
  usesEach: number;
  kind: "percent" | "amount";
  percent?: number | null | undefined;
  amountCents?: number | null | undefined;
  prefix?: string | undefined;
  startsAt?: string | null | undefined;
  endsAt?: string | null | undefined;
  excludesPresales?: boolean | undefined;
}

/** Make `count` unique codes for one company, private, with `usesEach` uses each. */
export async function createPartnerCodes(tx: Tx, s: TenantScope, eventId: string, p: PartnerBatch, actor: { type: "user" | "system"; id: string | null }) {
  return mapDbErrors(async () => {
    const { rows: ev } = await tx.query(`SELECT 1 FROM public.ticketing_events WHERE id = $1 AND client_id = $2 AND brand_id = $3`, [eventId, s.clientId, s.brandId]);
    if (!ev[0]) throw new DomainError("event_not_found");
    const prefix = p.prefix ?? partnerPrefix(p.partner);
    const made: string[] = [];
    // Random codes rarely collide; one already taken in this event is simply drawn again.
    for (let round = 0; made.length < p.count && round < 6; round++) {
      const wanted = Array.from({ length: p.count - made.length }, () => `${prefix}-${randomPart(6)}`);
      const { rows } = await tx.query<{ code: string }>(
        `INSERT INTO public.ticketing_promo_codes (client_id, brand_id, event_id, code, kind, percent, amount_cents, max_uses, starts_at, ends_at, public, excludes_presales, partner)
         SELECT $1, $2, $3, c, $5, $6, $7, $8, $9, $10, false, $11, $12 FROM unnest($4::text[]) AS c
         ON CONFLICT (event_id, code) DO NOTHING RETURNING code`,
        [s.clientId, s.brandId, eventId, [...new Set(wanted)], p.kind, p.kind === "percent" ? p.percent : null, p.kind === "amount" ? p.amountCents : null,
          p.usesEach, p.startsAt ?? null, p.endsAt ?? null, p.excludesPresales ?? false, p.partner],
      );
      made.push(...rows.map((r) => r.code));
    }
    if (made.length < p.count) throw new DomainError("conflict", { reason: "codes_exhausted" });
    await writeAudit(tx, s, actor, "promo_code.partner_batch_created", { type: "event", id: eventId }, { partner: p.partner, count: made.length, kind: p.kind });
    return made.sort();
  });
}

/** One line per partner company: how many codes, how many used, what they take off. */
export async function partnerBatches(q: Queryable, s: TenantScope, eventId: string) {
  const { rows } = await q.query(
    `SELECT partner, count(*)::int AS codes, sum(used_count)::int AS used, sum(coalesce(max_uses, 0))::int AS uses,
            min(kind) AS kind, min(percent) AS percent, min(amount_cents) AS amount_cents, max(ends_at) AS ends_at,
            bool_or(active) AS active, bool_and(excludes_presales) AS excludes_presales, min(created_at) AS created_at
     FROM public.ticketing_promo_codes WHERE event_id = $1 AND client_id = $2 AND brand_id = $3 AND partner IS NOT NULL
     GROUP BY partner ORDER BY min(created_at) DESC`,
    [eventId, s.clientId, s.brandId],
  );
  return rows.map(toApi);
}

/** A partner company's codes, for the file the organizer sends it. */
export async function partnerCodes(q: Queryable, s: TenantScope, eventId: string, partner: string) {
  const { rows } = await q.query<{ code: string; kind: "percent" | "amount"; percent: number | null; amount_cents: number | null; max_uses: number | null; used_count: number; ends_at: Date | null; active: boolean }>(
    `SELECT code, kind, percent, amount_cents, max_uses, used_count, ends_at, active FROM public.ticketing_promo_codes
     WHERE event_id = $1 AND client_id = $2 AND brand_id = $3 AND partner = $4 ORDER BY code`,
    [eventId, s.clientId, s.brandId, partner],
  );
  return rows;
}

/** Turn all of a partner company's codes off (or on again) at once. */
export async function setPartnerActive(tx: Tx, s: TenantScope, eventId: string, partner: string, active: boolean, actor: { type: "user"; id: string | null }) {
  const r = await tx.query(
    `UPDATE public.ticketing_promo_codes SET active = $5, updated_at = now() WHERE event_id = $1 AND client_id = $2 AND brand_id = $3 AND partner = $4`,
    [eventId, s.clientId, s.brandId, partner, active],
  );
  if (!r.rowCount) throw new DomainError("promo_code_not_found");
  await writeAudit(tx, s, actor, "promo_code.partner_batch_updated", { type: "event", id: eventId }, { partner, active, count: r.rowCount });
  return r.rowCount;
}

export async function createPromoCode(
  tx: Queryable, s: TenantScope, eventId: string,
  p: {
    code: string; kind: "percent" | "amount"; percent?: number | null | undefined; amountCents?: number | null | undefined; maxUses?: number | null | undefined;
    startsAt?: string | null | undefined; endsAt?: string | null | undefined; public?: boolean | undefined; label?: string | null | undefined;
    excludesPresales?: boolean | undefined;
  },
  actor: { type: "user" | "system"; id: string | null },
) {
  return mapDbErrors(async () => {
    const { rows: ev } = await tx.query(`SELECT 1 FROM public.ticketing_events WHERE id = $1 AND client_id = $2 AND brand_id = $3`, [eventId, s.clientId, s.brandId]);
    if (!ev[0]) throw new DomainError("event_not_found");
    try {
      const { rows } = await tx.query(
        `INSERT INTO public.ticketing_promo_codes (client_id, brand_id, event_id, code, kind, percent, amount_cents, max_uses, starts_at, ends_at, public, label, excludes_presales)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING ${COLUMNS}`,
        [s.clientId, s.brandId, eventId, normalizeCode(p.code), p.kind, p.kind === "percent" ? p.percent : null, p.kind === "amount" ? p.amountCents : null,
          p.maxUses ?? null, p.startsAt ?? null, p.endsAt ?? null, p.public ?? false, p.label ?? null, p.excludesPresales ?? false],
      );
      await writeAudit(tx, s, actor, "promo_code.created", { type: "promo_code", id: rows[0].id }, { eventId, code: rows[0].code, kind: p.kind, public: p.public ?? false });
      return toApi(rows[0]);
    } catch (error) {
      if ((error as { constraint?: string }).constraint === "ticketing_promo_codes_code_key") throw new DomainError("promo_code_exists");
      throw error;
    }
  });
}

export async function updatePromoCode(
  tx: Tx, s: TenantScope, id: string,
  p: {
    active?: boolean | undefined; maxUses?: number | null | undefined; startsAt?: string | null | undefined; endsAt?: string | null | undefined;
    public?: boolean | undefined; label?: string | null | undefined; excludesPresales?: boolean | undefined;
  },
  actor: { type: "user"; id: string | null },
) {
  return mapDbErrors(async () => {
    const sets: string[] = [];
    const values: unknown[] = [id, s.clientId, s.brandId];
    for (const [key, column] of [["active", "active"], ["maxUses", "max_uses"], ["startsAt", "starts_at"], ["endsAt", "ends_at"], ["public", "public"], ["label", "label"], ["excludesPresales", "excludes_presales"]] as const) {
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
