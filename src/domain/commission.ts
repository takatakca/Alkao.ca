import { DomainError } from "./errors.js";
import { assertCents, mulDivRound, type Cents } from "./money.js";

/**
 * TAKATAK transactional commission terms for one Client, received through the control
 * contract. V1 base: the order's pre-tax subtotal, plus a fixed amount per paid admission.
 */
export interface CommissionTerms {
  rateBps: number;
  fixedCentsPerPaidAdmission: Cents;
}

export const NO_COMMISSION: CommissionTerms = { rateBps: 0, fixedCentsPerPaidAdmission: 0 };

export function assertCommissionTerms(terms: CommissionTerms): void {
  if (!Number.isSafeInteger(terms.rateBps) || terms.rateBps < 0 || terms.rateBps > 10_000) {
    throw new DomainError("invalid_commission_terms", { rateBps: terms.rateBps });
  }
  assertCents(terms.fixedCentsPerPaidAdmission, "fixedCentsPerPaidAdmission");
}

/** Commission for an order. Never exceeds what the buyer pays. A free order costs nothing. */
export function computeCommission(
  terms: CommissionTerms,
  order: { subtotalCents: Cents; totalCents: Cents; paidAdmissions: number },
): Cents {
  assertCommissionTerms(terms);
  assertCents(order.subtotalCents, "subtotalCents");
  assertCents(order.totalCents, "totalCents");
  const variable = mulDivRound(order.subtotalCents, terms.rateBps, 10_000);
  const fixed = terms.fixedCentsPerPaidAdmission * order.paidAdmissions;
  return Math.min(variable + fixed, order.totalCents);
}

export interface RefundState {
  /** What the buyer paid (order total). */
  totalPaidCents: Cents;
  /** TAKATAK commission charged on the order. */
  commissionCents: Cents;
  refundedCents: Cents;
  commissionRefundedCents: Cents;
}

export interface RefundOutcome {
  refundCents: Cents;
  commissionRefundCents: Cents;
  refundedAfterCents: Cents;
  commissionRefundedAfterCents: Cents;
  fullyRefunded: boolean;
}

/**
 * V1 commission refund policy (frozen):
 *   full refund to the buyer    → full refund of the transactional commission;
 *   partial refund to the buyer → proportional commission refund.
 *
 * Computed cumulatively so rounding never drifts across several partial refunds: after
 * each refund, the commission refunded so far is round(commission × refunded / paid); the
 * refund that reaches the total returns exactly the remaining commission.
 */
export function applyRefund(state: RefundState, refundCents: Cents): RefundOutcome {
  for (const [label, v] of Object.entries(state)) assertCents(v, label);
  assertCents(refundCents, "refundCents");
  if (state.commissionCents > state.totalPaidCents) {
    throw new DomainError("commission_exceeds_total");
  }
  if (refundCents === 0) throw new DomainError("refund_must_be_positive");
  const refundedAfterCents = state.refundedCents + refundCents;
  if (refundedAfterCents > state.totalPaidCents) {
    throw new DomainError("refund_exceeds_paid", {
      refundable: state.totalPaidCents - state.refundedCents,
      requested: refundCents,
    });
  }

  const fullyRefunded = refundedAfterCents === state.totalPaidCents;
  const commissionRefundedAfterCents = fullyRefunded
    ? state.commissionCents
    : mulDivRound(state.commissionCents, refundedAfterCents, state.totalPaidCents);
  const commissionRefundCents = commissionRefundedAfterCents - state.commissionRefundedCents;
  if (commissionRefundCents < 0) {
    throw new DomainError("commission_refund_state_inconsistent");
  }

  return {
    refundCents,
    commissionRefundCents,
    refundedAfterCents,
    commissionRefundedAfterCents,
    fullyRefunded,
  };
}
