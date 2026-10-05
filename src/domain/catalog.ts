import type { Cents } from "./money.js";

export type TicketKind = "admission" | "add_on";
export type AddOnScope = "per_admission";

/** The purchase rules of one ticket type (mirrors ticketing_ticket_types). */
export interface TicketTypeRule {
  id: string;
  code: string;
  name: string;
  kind: TicketKind;
  priceCents: Cents;
  /** Applies only when the type is selected: FAMILY 3, GROUP 15. */
  minQuantity: number;
  maxQuantity: number;
  /** When this type is selected, at most N counts_as_adult admissions in the order. */
  maxAdultsInOrder: number | null;
  countsAsAdult: boolean;
  addOnScope: AddOnScope | null;
  active: boolean;
  /** Run 37: an open-date admission ("billet ouvert"): its order can change session freely. */
  openDate?: boolean;
}

export interface CartItem {
  ticketTypeId: string;
  quantity: number;
}

export type CartViolationCode =
  | "empty_cart"
  | "invalid_quantity"
  | "duplicate_item"
  | "unknown_ticket_type"
  | "inactive_ticket_type"
  | "below_minimum"
  | "above_maximum"
  | "max_adults_exceeded"
  | "add_on_without_admission"
  | "add_on_quantity_mismatch"
  | "order_too_large";

export interface CartViolation {
  code: CartViolationCode;
  ticketTypeId?: string;
  ticketTypeCode?: string;
  limit?: number;
  actual?: number;
}

export interface ValidatedLine {
  type: TicketTypeRule;
  quantity: number;
}

export type CartValidation =
  | { ok: true; lines: ValidatedLine[]; admissions: number }
  | { ok: false; violations: CartViolation[] };

export interface CartLimits {
  /** Hard cap on admissions per order, whatever the ticket types allow. */
  maxAdmissionsPerOrder: number;
}

export const DEFAULT_CART_LIMITS: CartLimits = { maxAdmissionsPerOrder: 60 };

/**
 * Server-authoritative cart validation. Returns every violation, not just the first, so
 * a client can show all problems at once. Lines come back in the catalog's order.
 */
export function validateCart(
  types: readonly TicketTypeRule[],
  items: readonly CartItem[],
  limits: CartLimits = DEFAULT_CART_LIMITS,
): CartValidation {
  const violations: CartViolation[] = [];
  const byId = new Map(types.map((t) => [t.id, t]));
  const quantities = new Map<string, number>();

  for (const item of items) {
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 0) {
      violations.push({ code: "invalid_quantity", ticketTypeId: item.ticketTypeId });
      continue;
    }
    if (quantities.has(item.ticketTypeId)) {
      violations.push({ code: "duplicate_item", ticketTypeId: item.ticketTypeId });
      continue;
    }
    quantities.set(item.ticketTypeId, item.quantity);
  }

  const lines: ValidatedLine[] = [];
  for (const [id, quantity] of quantities) {
    if (quantity === 0) continue;
    const type = byId.get(id);
    if (!type) {
      violations.push({ code: "unknown_ticket_type", ticketTypeId: id });
      continue;
    }
    if (!type.active) {
      violations.push({ code: "inactive_ticket_type", ticketTypeId: id, ticketTypeCode: type.code });
      continue;
    }
    lines.push({ type, quantity });
  }

  const admissionLines = lines.filter((l) => l.type.kind === "admission");
  const admissions = admissionLines.reduce((n, l) => n + l.quantity, 0);
  const adults = admissionLines
    .filter((l) => l.type.countsAsAdult)
    .reduce((n, l) => n + l.quantity, 0);

  if (lines.length === 0 && violations.length === 0) {
    violations.push({ code: "empty_cart" });
  }

  for (const { type, quantity } of lines) {
    const ref = { ticketTypeId: type.id, ticketTypeCode: type.code };
    if (quantity < type.minQuantity) {
      violations.push({ code: "below_minimum", ...ref, limit: type.minQuantity, actual: quantity });
    }
    if (quantity > type.maxQuantity) {
      violations.push({ code: "above_maximum", ...ref, limit: type.maxQuantity, actual: quantity });
    }
    if (type.maxAdultsInOrder !== null && adults > type.maxAdultsInOrder) {
      violations.push({ code: "max_adults_exceeded", ...ref, limit: type.maxAdultsInOrder, actual: adults });
    }
    if (type.kind === "add_on") {
      if (admissions === 0) {
        violations.push({ code: "add_on_without_admission", ...ref });
      } else if (type.addOnScope === "per_admission" && quantity !== admissions) {
        violations.push({ code: "add_on_quantity_mismatch", ...ref, limit: admissions, actual: quantity });
      }
    }
  }

  if (admissions > limits.maxAdmissionsPerOrder) {
    violations.push({ code: "order_too_large", limit: limits.maxAdmissionsPerOrder, actual: admissions });
  }

  if (violations.length > 0) return { ok: false, violations };

  const order = new Map(types.map((t, i) => [t.id, i]));
  lines.sort((a, b) => (order.get(a.type.id) ?? 0) - (order.get(b.type.id) ?? 0));
  return { ok: true, lines, admissions };
}
