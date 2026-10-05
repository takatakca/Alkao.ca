import { describe, expect, it } from "vitest";
import { computeTaxes, DomainError, formatCadFr, mulDivRound } from "../../src/domain/index.js";

describe("mulDivRound", () => {
  it("rounds half away from zero with exact integer math", () => {
    expect(mulDivRound(5, 1, 2)).toBe(3); // 2.5 → 3
    expect(mulDivRound(4, 1, 3)).toBe(1); // 1.333 → 1
    expect(mulDivRound(5, 2, 3)).toBe(3); // 3.333 → 3
    expect(mulDivRound(1, 2, 3)).toBe(1); // 0.666 → 1
  });

  it("stays exact beyond float precision", () => {
    expect(mulDivRound(9_007_199_254_740_991, 3, 3)).toBe(9_007_199_254_740_991);
  });

  it("rejects negatives, fractions and zero denominators", () => {
    expect(() => mulDivRound(-1, 1, 1)).toThrow(DomainError);
    expect(() => mulDivRound(1.5, 1, 1)).toThrow(DomainError);
    expect(() => mulDivRound(1, 1, 0)).toThrow(DomainError);
  });
});

describe("Québec taxes", () => {
  it("applies GST 5 % and QST 9.975 % on the pre-tax amount, each rounded", () => {
    const taxes = computeTaxes("CA-QC", 2995);
    expect(taxes).toEqual([
      { code: "GST", labelFr: "TPS", ratePpm: 50_000, taxableCents: 2995, amountCents: 150 },
      { code: "QST", labelFr: "TVQ", ratePpm: 99_750, taxableCents: 2995, amountCents: 299 },
    ]);
  });

  it("matches FESTI-ICE totals for 2 general + 2 children + flex", () => {
    // 2×29.95 + 2×17.95 + 4×8.00 = 127.80 ; TPS 6.39 ; TVQ 12.75 (12.748 → 12.75)
    const [gst, qst] = computeTaxes("CA-QC", 12_780);
    expect(gst?.amountCents).toBe(639);
    expect(qst?.amountCents).toBe(1275);
  });

  it("charges no tax on a free order", () => {
    expect(computeTaxes("CA-QC", 0).map((t) => t.amountCents)).toEqual([0, 0]);
  });
});

describe("formatCadFr", () => {
  it("formats cents for Québec French", () => {
    expect(formatCadFr(2995)).toBe("29,95 $");
    expect(formatCadFr(0)).toBe("0,00 $");
  });
});
