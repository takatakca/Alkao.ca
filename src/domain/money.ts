import { DomainError } from "./errors.js";

/** Integer amount of cents. All ALKAO money is CAD cents; floats never hold money. */
export type Cents = number;

/** Largest amount a single order may reach (CAD 1,000,000.00), well inside int4. */
export const MAX_ORDER_CENTS = 100_000_000;

export function assertCents(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DomainError("invalid_amount", { label, value });
  }
}

/**
 * round(value * numerator / denominator), half away from zero, in exact integer math.
 * Inputs must be non-negative integers.
 */
export function mulDivRound(value: number, numerator: number, denominator: number): number {
  for (const n of [value, numerator, denominator]) {
    if (!Number.isSafeInteger(n) || n < 0) {
      throw new DomainError("invalid_amount", { value: n });
    }
  }
  if (denominator === 0) throw new DomainError("division_by_zero");
  const product = BigInt(value) * BigInt(numerator);
  const d = BigInt(denominator);
  const quotient = product / d;
  const remainder = product % d;
  const rounded = remainder * 2n >= d ? quotient + 1n : quotient;
  return Number(rounded);
}

/** "29,95 $" — Québec French CAD formatting. */
export function formatCadFr(cents: Cents): string {
  assertCents(cents, "cents");
  const dollars = Math.trunc(cents / 100).toLocaleString("fr-CA");
  const rest = String(cents % 100).padStart(2, "0");
  return `${dollars},${rest} $`;
}
