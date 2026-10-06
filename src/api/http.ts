import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError } from "zod";
import { DomainError } from "../domain/errors.js";
import { toDomainError } from "../db/errors.js";

export interface ErrorBody {
  error: { code: string; details?: unknown };
}

/** Parse a JSON request body; malformed JSON is a client error, never a 500. */
export async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new DomainError("invalid_json");
  }
}

export function fail(c: Context, status: ContentfulStatusCode, code: string, details?: unknown) {
  return c.json<ErrorBody>({ error: details === undefined ? { code } : { code, details } }, status);
}

const STATUS_BY_CODE: Record<string, ContentfulStatusCode> = {
  empty_update: 400,
  invalid_json: 400,
  sold_out: 409,
  session_not_available: 409,
  session_not_on_sale: 409,
  capacity_below_committed: 409,
  hold_not_active: 409,
  conflict: 409,
  unknown_client: 409,
  unknown_brand: 409,
  brand_client_mismatch: 409,
  invalid_reference: 422,
  payments_not_configured: 503,
  payments_unavailable: 409,
  return_url_not_allowed: 422,
  payment_provider_error: 502,
  refund_provider_error: 502,
  refund_in_progress: 409,
  order_not_refundable: 409,
  refund_state_changed: 409,
  invalid_ticket: 422,
  credentials_not_configured: 503,
  already_exchanged: 409,
  order_not_exchangeable: 409,
  flex_not_purchased: 409,
  // Run 06
  order_has_no_valid_ticket: 409,
  email_resend_limit: 409,
  // Run 10
  use_session_cancellation: 409,
  // Run 13
  payload_too_large: 413,
  cancellation_not_found: 404,
  nothing_to_exchange: 409,
  ticket_already_used: 409,
  // Run 20
  buyer_has_upcoming_tickets: 409,
  buyer_anonymized: 409,
  dispute_open: 409,
  // Run 36
  promo_code_invalid: 422,
  promo_code_exists: 409,
  promo_uses_below_used: 409,
  // Run 29
  too_many_sessions: 422,
  venue_time_zone_invalid: 422,
  // Run 41
  import_empty: 409,
  report_date_in_future: 422,
  // Run 42
  campaign_not_draft: 409,
  campaign_closed: 409,
  campaign_test_limit: 409,
  marketing_settings_missing: 409,
  audience_empty: 409,
  audience_changed: 409,
  // Run 44
  rate_limited: 429,
};

/** Domain error details safe to return to callers (never constraint or column names). */
const DETAILS_ALLOWED = new Set(["refund_provider_error", "refund_exceeds_paid", "too_many_sessions", "promo_code_invalid", "audience_changed"]);

/** Map any thrown error to a stable JSON error. Unknown errors never leak details. */
export function errorResponse(c: Context, error: unknown) {
  if (error instanceof ZodError) {
    return fail(c, 400, "invalid_request", error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  const domain = toDomainError(error);
  if (domain instanceof DomainError) {
    const status = STATUS_BY_CODE[domain.code] ?? (domain.code.endsWith("_not_found") ? 404 : 422);
    return DETAILS_ALLOWED.has(domain.code) ? fail(c, status, domain.code, domain.details) : fail(c, status, domain.code);
  }
  console.error("alkao: unhandled error", error);
  return fail(c, 500, "internal_error");
}
