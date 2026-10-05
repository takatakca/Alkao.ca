import type { TicketTypeRule } from "../../src/domain/index.js";

/** FESTI-ICE 2026-2027 catalog, from festiiceca@a81ffa4 (seed in migration 20260907133044). */
export const FESTI_ICE_TYPES: TicketTypeRule[] = [
  type("GENERAL", "Admission générale — 13 ans et +", 2995, { max: 10, adult: true }),
  type("SENIOR", "Aîné — 65 ans et +", 2795, { max: 10, adult: true }),
  type("CHILD", "Enfant — 2 à 12 ans", 1795, { max: 10 }),
  type("TODDLER", "Bambin — moins de 2 ans", 0, { max: 4 }),
  type("FAMILY", "Passe familiale", 2195, { min: 3, max: 6, maxAdults: 2 }),
  type("OPEN_DATE", "Billet ouvert", 3995, { max: 10, adult: true }),
  type("GROUP", "Groupe — 15 personnes et +", 2696, { min: 15, max: 60, adult: true }),
  {
    ...type("FLEX_WEATHER", "Option Flex Météo", 800, { max: 60 }),
    kind: "add_on",
    addOnScope: "per_admission",
  },
];

export function typeId(code: string): string {
  const t = FESTI_ICE_TYPES.find((x) => x.code === code);
  if (!t) throw new Error(`unknown code ${code}`);
  return t.id;
}

export function cart(entries: Record<string, number>) {
  return Object.entries(entries).map(([code, quantity]) => ({ ticketTypeId: typeId(code), quantity }));
}

function type(
  code: string,
  name: string,
  priceCents: number,
  o: { min?: number; max: number; adult?: boolean; maxAdults?: number },
): TicketTypeRule {
  return {
    id: `tt-${code.toLowerCase()}`,
    code,
    name,
    kind: "admission",
    priceCents,
    minQuantity: o.min ?? 0,
    maxQuantity: o.max,
    maxAdultsInOrder: o.maxAdults ?? null,
    countsAsAdult: o.adult ?? false,
    addOnScope: null,
    active: true,
  };
}
