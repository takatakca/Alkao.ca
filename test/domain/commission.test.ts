import { describe, expect, it } from "vitest";
import { applyRefund, computeCommission, DomainError, type RefundState } from "../../src/domain/index.js";

describe("computeCommission", () => {
  it("applies the rate on the pre-tax subtotal plus a fixed amount per paid admission", () => {
    // 5 % of 127.80 = 6.39 ; + 0.50 × 4 = 2.00
    expect(
      computeCommission(
        { rateBps: 500, fixedCentsPerPaidAdmission: 50 },
        { subtotalCents: 12_780, totalCents: 14_694, paidAdmissions: 4 },
      ),
    ).toBe(839);
  });

  it("is zero for a free order and never exceeds what the buyer pays", () => {
    expect(
      computeCommission({ rateBps: 500, fixedCentsPerPaidAdmission: 50 }, { subtotalCents: 0, totalCents: 0, paidAdmissions: 0 }),
    ).toBe(0);
    expect(
      computeCommission({ rateBps: 10_000, fixedCentsPerPaidAdmission: 1000 }, { subtotalCents: 100, totalCents: 115, paidAdmissions: 1 }),
    ).toBe(115);
  });

  it("rejects invalid terms", () => {
    expect(() =>
      computeCommission({ rateBps: 10_001, fixedCentsPerPaidAdmission: 0 }, { subtotalCents: 1, totalCents: 1, paidAdmissions: 1 }),
    ).toThrow(DomainError);
  });
});

describe("applyRefund — V1 commission policy", () => {
  const paid: RefundState = { totalPaidCents: 14_694, commissionCents: 839, refundedCents: 0, commissionRefundedCents: 0 };

  it("full refund to the buyer returns the full commission", () => {
    const r = applyRefund(paid, 14_694);
    expect(r).toEqual({
      refundCents: 14_694,
      commissionRefundCents: 839,
      refundedAfterCents: 14_694,
      commissionRefundedAfterCents: 839,
      fullyRefunded: true,
    });
  });

  it("partial refund returns a proportional commission", () => {
    // half of the order → round(839 / 2) = 420 (419.5 rounds half up)
    const r = applyRefund(paid, 7347);
    expect(r.commissionRefundCents).toBe(420);
    expect(r.fullyRefunded).toBe(false);
  });

  it("successive partial refunds never drift and end at exactly the full commission", () => {
    let state = { ...paid };
    let commissionReturned = 0;
    for (const amount of [1, 999, 3333, 2, 7000]) {
      const r = applyRefund(state, amount);
      commissionReturned += r.commissionRefundCents;
      expect(r.commissionRefundedAfterCents).toBe(Math.round((839 * r.refundedAfterCents) / 14_694));
      state = { ...state, refundedCents: r.refundedAfterCents, commissionRefundedCents: r.commissionRefundedAfterCents };
    }
    const last = applyRefund(state, paid.totalPaidCents - state.refundedCents);
    commissionReturned += last.commissionRefundCents;
    expect(last.fullyRefunded).toBe(true);
    expect(commissionReturned).toBe(839);
  });

  it("never refunds more than was paid", () => {
    expect(() => applyRefund(paid, 14_695)).toThrow(/refund_exceeds_paid/);
    expect(() => applyRefund({ ...paid, refundedCents: 14_000 }, 695)).toThrow(/refund_exceeds_paid/);
  });

  it("rejects a zero refund and a free order refund", () => {
    expect(() => applyRefund(paid, 0)).toThrow(/refund_must_be_positive/);
    expect(() =>
      applyRefund({ totalPaidCents: 0, commissionCents: 0, refundedCents: 0, commissionRefundedCents: 0 }, 1),
    ).toThrow(/refund_exceeds_paid/);
  });

  it("works when there is no commission", () => {
    const r = applyRefund({ totalPaidCents: 1000, commissionCents: 0, refundedCents: 0, commissionRefundedCents: 0 }, 400);
    expect(r.commissionRefundCents).toBe(0);
  });
});
