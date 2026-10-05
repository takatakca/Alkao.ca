import { assertCents, mulDivRound, type Cents } from "./money.js";

/** Place-of-supply tax regions supported by ALKAO. Keep in sync with ticketing_venues.tax_region. */
export const TAX_REGIONS = ["CA-QC"] as const;
export type TaxRegion = (typeof TAX_REGIONS)[number];

export type TaxCode = "GST" | "QST";

export interface TaxRate {
  code: TaxCode;
  /** French label shown to Québec buyers. */
  labelFr: string;
  /** Rate in parts per million: 5 % = 50_000. */
  ratePpm: number;
}

export interface TaxLine {
  code: TaxCode;
  labelFr: string;
  ratePpm: number;
  taxableCents: Cents;
  amountCents: Cents;
}

/**
 * Québec: GST (TPS) 5 % and QST (TVQ) 9.975 %, both on the pre-tax price (QST has not
 * applied on top of GST since 2013). Each tax is rounded to the cent independently.
 */
const RATES: Record<TaxRegion, readonly TaxRate[]> = {
  "CA-QC": [
    { code: "GST", labelFr: "TPS", ratePpm: 50_000 },
    { code: "QST", labelFr: "TVQ", ratePpm: 99_750 },
  ],
};

export function isTaxRegion(value: string): value is TaxRegion {
  return (TAX_REGIONS as readonly string[]).includes(value);
}

export function taxRatesFor(region: TaxRegion): readonly TaxRate[] {
  return RATES[region];
}

export function computeTaxes(region: TaxRegion, taxableCents: Cents): TaxLine[] {
  assertCents(taxableCents, "taxableCents");
  return RATES[region].map((rate) => ({
    code: rate.code,
    labelFr: rate.labelFr,
    ratePpm: rate.ratePpm,
    taxableCents,
    amountCents: mulDivRound(taxableCents, rate.ratePpm, 1_000_000),
  }));
}
