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

/** Price a cart from the server-side catalog. Client-sent prices are never used. */
export function buildQuote(
  types: readonly TicketTypeRule[],
  items: readonly CartItem[],
  taxRegion: TaxRegion,
  limits: CartLimits = DEFAULT_CART_LIMITS,
): QuoteResult {
  const validation = validateCart(types, items, limits);
  if (!validation.ok) return validation;

  const lines: QuoteLine[] = validation.lines.map(({ type, quantity }) => ({
    ticketTypeId: type.id,
    code: type.code,
    name: type.name,
    kind: type.kind,
    quantity,
    unitPriceCents: type.priceCents,
    lineTotalCents: type.priceCents * quantity,
  }));

  const subtotalCents = lines.reduce((n, l) => n + l.lineTotalCents, 0);
  const taxes = computeTaxes(taxRegion, subtotalCents);
  const taxCents = taxes.reduce((n, t) => n + t.amountCents, 0);
  const totalCents = subtotalCents + taxCents;
  if (totalCents > MAX_ORDER_CENTS) {
    return { ok: false, violations: [{ code: "order_too_large", limit: MAX_ORDER_CENTS, actual: totalCents }] };
  }

  const paidAdmissions = lines
    .filter((l) => l.kind === "admission" && l.unitPriceCents > 0)
    .reduce((n, l) => n + l.quantity, 0);

  return {
    ok: true,
    quote: {
      currency: "CAD",
      lines,
      admissions: validation.admissions,
      paidAdmissions,
      subtotalCents,
      taxes,
      taxCents,
      totalCents,
    },
  };
}
