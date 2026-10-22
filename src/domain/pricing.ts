import { validateCart, type CartItem, type CartLimits, type CartViolation, type TicketKind, type TicketTypeRule, DEFAULT_CART_LIMITS } from "./catalog.js";
import { MAX_ORDER_CENTS, mulDivRound, type Cents } from "./money.js";
import { computeTaxes, type TaxLine, type TaxRegion } from "./tax.js";

export interface QuoteLine {
  ticketTypeId: string;
  code: string;
  name: string;
  kind: TicketKind;
  quantity: number;
  unitPriceCents: Cents;
  lineTotalCents: Cents;
  /** Run 99: a presale ticket (a code that excludes presales leaves it at its price). */
  presale?: boolean;
}

export interface Quote {
  currency: "CAD";
  lines: QuoteLine[];
  admissions: number;
  /** Paid admissions (unit price > 0): the base for per-ticket commission. */
  paidAdmissions: number;
  /** Sum of the lines, at list price. */
  subtotalCents: Cents;
  /** Run 36: taken off the subtotal by a promo code, before taxes. 0 without a code. */
  discountCents: Cents;
  promoCode: string | null;
  taxes: TaxLine[];
  taxCents: Cents;
  totalCents: Cents;
}

/** Run 36: a promo code's value, as stored (one of percent or amountCents). */
export interface PromoDiscount {
  code: string;
  kind: "percent" | "amount";
  percent: number | null;
  amountCents: number | null;
  /** Run 99: not on top of a presale; the code applies to the regular-price lines only. */
  excludesPresales?: boolean;
}

/** What a code takes off a subtotal: a rounded percentage, or a fixed amount, never more than the subtotal. */
export function discountFor(subtotalCents: Cents, promo: PromoDiscount): Cents {
  const off = promo.kind === "percent" ? mulDivRound(subtotalCents, promo.percent ?? 0, 100) : (promo.amountCents ?? 0);
  return Math.min(off, subtotalCents);
}

export type QuoteResult =
  | { ok: true; quote: Quote }
  | { ok: false; violations: CartViolation[] };

export interface PricedLineInput {
  ticketTypeId: string;
  code: string;
  name: string;
  kind: TicketKind;
  quantity: number;
  unitPriceCents: Cents;
  presale?: boolean;
}

/** Run 99: what a code applies to, the whole subtotal or, for one that excludes presales, the regular-price lines. */
export function discountBase(lines: readonly { lineTotalCents: Cents; presale?: boolean }[], promo: PromoDiscount): Cents {
  return lines.reduce((n, l) => n + (promo.excludesPresales && l.presale ? 0 : l.lineTotalCents), 0);
}

/**
 * Run 99: false when a code that excludes presales meets a cart of presale tickets only: it
 * would take nothing off, so the buyer is told why instead.
 */
export function promoApplies(lines: readonly { lineTotalCents: Cents; presale?: boolean }[], promo: PromoDiscount | null): boolean {
  return !promo?.excludesPresales || !lines.some((l) => l.presale) || discountBase(lines, promo) > 0;
}

/**
 * Totals for lines that were already validated (a hold's items, with the prices captured
 * when the hold was created). Never call this on unvalidated client input.
 */
export function quoteFromLines(input: readonly PricedLineInput[], taxRegion: TaxRegion, promo: PromoDiscount | null = null): Quote {
  const lines: QuoteLine[] = input.map((l) => ({ ...l, lineTotalCents: l.unitPriceCents * l.quantity }));
  const subtotalCents = lines.reduce((n, l) => n + l.lineTotalCents, 0);
  const discountCents = promo ? discountFor(discountBase(lines, promo), promo) : 0;
  const taxes = computeTaxes(taxRegion, subtotalCents - discountCents);
  const taxCents = taxes.reduce((n, t) => n + t.amountCents, 0);
  const admissionLines = lines.filter((l) => l.kind === "admission");
  return {
    currency: "CAD",
    lines,
    admissions: admissionLines.reduce((n, l) => n + l.quantity, 0),
    paidAdmissions: admissionLines.filter((l) => l.unitPriceCents > 0).reduce((n, l) => n + l.quantity, 0),
    subtotalCents,
    discountCents,
    promoCode: promo ? promo.code : null,
    taxes,
    taxCents,
    totalCents: subtotalCents - discountCents + taxCents,
  };
}

/** Price a cart from the server-side catalog. Client-sent prices are never used. */
export function buildQuote(
  types: readonly TicketTypeRule[],
  items: readonly CartItem[],
  taxRegion: TaxRegion,
  limits: CartLimits = DEFAULT_CART_LIMITS,
  promo: PromoDiscount | null = null,
): QuoteResult {
  const validation = validateCart(types, items, limits);
  if (!validation.ok) return validation;

  const quote = quoteFromLines(
    validation.lines.map(({ type, quantity }) => ({
      ticketTypeId: type.id,
      code: type.code,
      name: type.name,
      kind: type.kind,
      quantity,
      unitPriceCents: type.priceCents,
      presale: Boolean(type.presaleOf),
    })),
    taxRegion,
    promo,
  );
  if (quote.totalCents > MAX_ORDER_CENTS) {
    return { ok: false, violations: [{ code: "order_too_large", limit: MAX_ORDER_CENTS, actual: quote.totalCents }] };
  }
  return { ok: true, quote };
}
