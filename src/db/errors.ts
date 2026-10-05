import { DomainError } from "../domain/errors.js";

interface PgError {
  code?: string;
  constraint?: string;
  message?: string;
}

/** Codes raised by ALKAO triggers (RAISE EXCEPTION '<code>'). Safe to expose. */
const TRIGGER_CODES = new Set([
  "session_not_on_sale",
  "hold_must_start_active",
  "hold_fields_immutable",
  "hold_already_closed",
  "hold_not_active",
  "hold_quantity_mismatch",
  "order_must_start_pending",
  "order_fields_immutable",
  "order_refunds_monotonic",
  "order_invalid_transition",
  "order_not_pending",
  "order_line_kind_mismatch",
  "order_subtotal_mismatch",
  "order_tax_mismatch",
  "order_without_admission",
  "order_hold_quantity_mismatch",
  "ticket_must_start_valid",
  "ticket_requires_paid_order",
  "ticket_requires_admission_line",
  "ticket_quantity_exceeded",
  "ticket_fields_immutable",
  "ticket_void_is_final",
  "brand_client_immutable",
  "payment_account_immutable",
  "payment_must_start_open",
  "payment_amount_mismatch",
  "payment_fields_immutable",
  "payment_invalid_transition",
  "refund_must_start_pending",
  "refund_fields_immutable",
  "refund_invalid_transition",
  "order_refund_ledger_mismatch",
  "credential_key_immutable",
  "credential_key_invalid_transition",
  "credential_fields_immutable",
  "credential_revocation_is_final",
  // Run 37
  "exchange_must_point_to_original",
]);

/** Translate a PostgreSQL error into a DomainError, or return null if it is not one of ours. */
export function toDomainError(error: unknown): DomainError | null {
  if (error instanceof DomainError) return error;
  const e = error as PgError;
  if (!e || typeof e !== "object" || typeof e.code !== "string") return null;
  if (e.code === "23514") {
    if (e.constraint === "ticketing_sessions_capacity_ck") return new DomainError("sold_out");
    // Run 36: the code's last use went to another buyer first.
    if (e.constraint === "ticketing_promo_codes_uses_ck") return new DomainError("promo_code_invalid", { reason: "used_up" });
    if (e.message && TRIGGER_CODES.has(e.message)) return new DomainError(e.message);
    return new DomainError("constraint_violation", { constraint: e.constraint });
  }
  if (e.code === "23505") return new DomainError("conflict", { constraint: e.constraint });
  if (e.code === "23503") return new DomainError("invalid_reference", { constraint: e.constraint });
  return null;
}

export async function mapDbErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw toDomainError(error) ?? error;
  }
}
