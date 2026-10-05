import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { isUuid } from "../domain/ids.js";

export interface AuthVerifier {
  /** Returns the Supabase auth user id (JWT `sub`) or throws. */
  verify(token: string): Promise<{ userId: string }>;
}

export class AuthError extends Error {
  constructor(readonly code: "auth_not_configured" | "invalid_token") {
    super(code);
  }
}

/**
 * Verifies Supabase Auth access tokens: JWKS (asymmetric signing keys) when configured,
 * otherwise the legacy HS256 project secret. Only `authenticated` tokens with a UUID `sub`
 * are accepted. Authorization never reads user_metadata or app_metadata.
 */
export function createSupabaseJwtVerifier(cfg: { jwksUrl?: string; secret?: string; issuer?: string }): AuthVerifier {
  let key: JWTVerifyGetKey | Uint8Array | null = null;
  let algorithms: string[] = [];
  if (cfg.jwksUrl) {
    key = createRemoteJWKSet(new URL(cfg.jwksUrl));
    algorithms = ["ES256", "RS256", "EdDSA"];
  } else if (cfg.secret) {
    key = new TextEncoder().encode(cfg.secret);
    algorithms = ["HS256"];
  }
  return {
    async verify(token) {
      if (!key) throw new AuthError("auth_not_configured");
      try {
        const options = { audience: "authenticated", algorithms, ...(cfg.issuer ? { issuer: cfg.issuer } : {}) };
        // Two calls only because jose's overloads differ by key type.
        const { payload } = key instanceof Uint8Array
          ? await jwtVerify(token, key, options)
          : await jwtVerify(token, key, options);
        if (payload.role !== "authenticated" || !isUuid(payload.sub)) throw new AuthError("invalid_token");
        return { userId: payload.sub };
      } catch {
        throw new AuthError("invalid_token");
      }
    },
  };
}
