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
};

/** Map any thrown error to a stable JSON error. Unknown errors never leak details. */
export function errorResponse(c: Context, error: unknown) {
  if (error instanceof ZodError) {
    return fail(c, 400, "invalid_request", error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  const domain = toDomainError(error);
  if (domain instanceof DomainError) {
    const status = STATUS_BY_CODE[domain.code] ?? (domain.code.endsWith("_not_found") ? 404 : 422);
    return fail(c, status, domain.code);
  }
  console.error("alkao: unhandled error", error);
  return fail(c, 500, "internal_error");
}
