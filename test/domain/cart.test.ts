import { describe, expect, it } from "vitest";
import { buildQuote, validateCart } from "../../src/domain/index.js";
import { cart, FESTI_ICE_TYPES, typeId } from "../fixtures/festi-ice.js";

const codes = (r: ReturnType<typeof validateCart>) => (r.ok ? [] : r.violations.map((v) => v.code));

describe("validateCart — FESTI-ICE rules", () => {
  it("accepts a regular family visit", () => {
    const r = validateCart(FESTI_ICE_TYPES, cart({ GENERAL: 2, CHILD: 2, TODDLER: 1 }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.admissions).toBe(5);
  });

  it("rejects an empty cart and an all-zero cart", () => {
    expect(codes(validateCart(FESTI_ICE_TYPES, []))).toEqual(["empty_cart"]);
    expect(codes(validateCart(FESTI_ICE_TYPES, cart({ GENERAL: 0 })))).toEqual(["empty_cart"]);
  });

  it("requires 3 to 6 family pass tickets", () => {
    expect(codes(validateCart(FESTI_ICE_TYPES, cart({ FAMILY: 2 })))).toEqual(["below_minimum"]);
    expect(validateCart(FESTI_ICE_TYPES, cart({ FAMILY: 3 })).ok).toBe(true);
    expect(validateCart(FESTI_ICE_TYPES, cart({ FAMILY: 6 })).ok).toBe(true);
    expect(codes(validateCart(FESTI_ICE_TYPES, cart({ FAMILY: 7 })))).toEqual(["above_maximum"]);
  });

  it("allows at most 2 adult admissions alongside a family pass", () => {
    expect(validateCart(FESTI_ICE_TYPES, cart({ FAMILY: 4, GENERAL: 2 })).ok).toBe(true);
    const r = validateCart(FESTI_ICE_TYPES, cart({ FAMILY: 4, GENERAL: 2, SENIOR: 1 }));
    expect(codes(r)).toEqual(["max_adults_exceeded"]);
    if (!r.ok) expect(r.violations[0]).toMatchObject({ ticketTypeCode: "FAMILY", limit: 2, actual: 3 });
  });

  it("does not limit adults when no family pass is selected", () => {
    expect(validateCart(FESTI_ICE_TYPES, cart({ GENERAL: 5, SENIOR: 5 })).ok).toBe(true);
  });

  it("requires at least 15 for the group rate", () => {
    expect(codes(validateCart(FESTI_ICE_TYPES, cart({ GROUP: 14 })))).toEqual(["below_minimum"]);
    expect(validateCart(FESTI_ICE_TYPES, cart({ GROUP: 15 })).ok).toBe(true);
  });

  it("caps toddlers at 4", () => {
    expect(codes(validateCart(FESTI_ICE_TYPES, cart({ GENERAL: 1, TODDLER: 5 })))).toEqual(["above_maximum"]);
  });

  it("requires Flex Météo to cover every admission, and never alone", () => {
    expect(validateCart(FESTI_ICE_TYPES, cart({ GENERAL: 2, CHILD: 1, FLEX_WEATHER: 3 })).ok).toBe(true);
    expect(codes(validateCart(FESTI_ICE_TYPES, cart({ GENERAL: 2, FLEX_WEATHER: 1 })))).toEqual([
      "add_on_quantity_mismatch",
    ]);
    expect(codes(validateCart(FESTI_ICE_TYPES, cart({ FLEX_WEATHER: 1 })))).toEqual(["add_on_without_admission"]);
  });

  it("rejects unknown, inactive, duplicated and malformed items", () => {
    const inactive = FESTI_ICE_TYPES.map((t) => (t.code === "SENIOR" ? { ...t, active: false } : t));
    expect(codes(validateCart(inactive, cart({ SENIOR: 1 })))).toEqual(["inactive_ticket_type"]);
    expect(codes(validateCart(FESTI_ICE_TYPES, [{ ticketTypeId: "nope", quantity: 1 }]))).toEqual([
      "unknown_ticket_type",
    ]);
    expect(
      codes(
        validateCart(FESTI_ICE_TYPES, [
          { ticketTypeId: typeId("GENERAL"), quantity: 1 },
          { ticketTypeId: typeId("GENERAL"), quantity: 2 },
        ]),
      ),
    ).toEqual(["duplicate_item"]);
    expect(codes(validateCart(FESTI_ICE_TYPES, [{ ticketTypeId: typeId("GENERAL"), quantity: 1.5 }]))).toEqual([
      "invalid_quantity",
    ]);
    expect(codes(validateCart(FESTI_ICE_TYPES, [{ ticketTypeId: typeId("GENERAL"), quantity: -1 }]))).toEqual([
      "invalid_quantity",
    ]);
  });

  it("enforces the per-order admission cap", () => {
    const r = validateCart(FESTI_ICE_TYPES, cart({ GROUP: 60, GENERAL: 1 }));
    expect(codes(r)).toEqual(["order_too_large"]);
  });

  it("reports every violation at once", () => {
    const r = validateCart(FESTI_ICE_TYPES, cart({ FAMILY: 2, GENERAL: 3, FLEX_WEATHER: 1 }));
    expect(codes(r).sort()).toEqual(["add_on_quantity_mismatch", "below_minimum", "max_adults_exceeded"]);
  });
});

describe("buildQuote", () => {
  it("prices from the catalog, in catalog order, with Québec taxes", () => {
    const r = buildQuote(FESTI_ICE_TYPES, cart({ FLEX_WEATHER: 4, CHILD: 2, GENERAL: 2 }), "CA-QC");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.quote.lines.map((l) => [l.code, l.quantity, l.lineTotalCents])).toEqual([
      ["GENERAL", 2, 5990],
      ["CHILD", 2, 3590],
      ["FLEX_WEATHER", 4, 3200],
    ]);
    expect(r.quote).toMatchObject({
      admissions: 4,
      paidAdmissions: 4,
      subtotalCents: 12_780,
      taxCents: 639 + 1275,
      totalCents: 12_780 + 639 + 1275,
    });
  });

  it("counts free toddlers for capacity but not as paid admissions", () => {
    const r = buildQuote(FESTI_ICE_TYPES, cart({ GENERAL: 2, TODDLER: 1 }), "CA-QC");
    expect(r.ok && r.quote.admissions).toBe(3);
    expect(r.ok && r.quote.paidAdmissions).toBe(2);
  });

  it("returns violations instead of a price for an invalid cart", () => {
    const r = buildQuote(FESTI_ICE_TYPES, cart({ FAMILY: 2 }), "CA-QC");
    expect(r.ok).toBe(false);
  });
});
