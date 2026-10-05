import { validateCart, type CartItem, type CartLimits, type CartViolation, type TicketKind, type TicketTypeRule, DEFAULT_CART_LIMITS } from "./catalog.js";
import { MAX_ORDER_CENTS, type Cents } from "./money.js";
import { computeTaxes, type TaxLine, type TaxRegion } from "./tax.js";

export interface QuoteLine {
  ticketTypeId: string;
  code: string;
  name: string;
  kind: TicketKind;
  quantity: number;
  unitPriceCents: Cents;
  lineTotalCents: Cents;
}

export interface Quote {
  currency: "CAD";
  lines: QuoteLine[];
  admissions: number;
  /** Paid admissions (unit price > 0): the base for per-ticket commission. */
  paidAdmissions: number;
  subtotalCents: Cents;
  taxes: TaxLine[];
  taxCents: Cents;
  totalCents: Cents;
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
}

/**
 * Totals for lines that were already validated (a hold's items, with the prices captured
 * when the hold was created). Never call this on unvalidated client input.
 */
export function quoteFromLines(input: readonly PricedLineInput[], taxRegion: TaxRegion): Quote {
  const lines: QuoteLine[] = input.map((l) => ({ ...l, lineTotalCents: l.unitPriceCents * l.quantity }));
  const subtotalCents = lines.reduce((n, l) => n + l.lineTotalCents, 0);
  const taxes = computeTaxes(taxRegion, subtotalCents);
  const taxCents = taxes.reduce((n, t) => n + t.amountCents, 0);
  const admissionLines = lines.filter((l) => l.kind === "admission");
  return {
    currency: "CAD",
    lines,
    admissions: admissionLines.reduce((n, l) => n + l.quantity, 0),
    paidAdmissions: admissionLines.filter((l) => l.unitPriceCents > 0).reduce((n, l) => n + l.quantity, 0),
    subtotalCents,
    taxes,
    taxCents,
    totalCents: subtotalCents + taxCents,
  };
}

/** Price a cart from the server-side catalog. Client-sent prices are never used. */
export function buildQuote(
  types: readonly TicketTypeRule[],
  items: readonly CartItem[],
  taxRegion: TaxRegion,
  limits: CartLimits = DEFAULT_CART_LIMITS,
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
    })),
    taxRegion,
  );
  if (quote.totalCents > MAX_ORDER_CENTS) {
    return { ok: false, violations: [{ code: "order_too_large", limit: MAX_ORDER_CENTS, actual: quote.totalCents }] };
  }
  return { ok: true, quote };
}
