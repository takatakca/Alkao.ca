import { z } from "zod";

const boolFlag = z
  .enum(["true", "false", "1", "0", ""])
  .optional()
  .transform((v) => v === "true" || v === "1");

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  /** Deployment switch. Off by default: merging or deploying ALKAO activates nothing. */
  ALKAO_OPERATIONAL_API_ENABLED: boolFlag,
  /** TAKATAK control-contract HMAC keys: "kid1:secret1,kid2:secret2" (rotation by key id). */
  ALKAO_CONTROL_KEYS: z.string().optional(),
  /** Supabase Auth: JWKS URL (asymmetric signing keys) or legacy HS256 JWT secret. */
  SUPABASE_JWKS_URL: z.url().optional(),
  SUPABASE_JWT_SECRET: z.string().min(32).optional(),
  SUPABASE_JWT_ISSUER: z.string().optional(),
  ALKAO_HOLD_TTL_SECONDS: z.coerce.number().int().min(60).max(1800).default(600),
  ALKAO_PUBLIC_HOLDS_PER_MINUTE: z.coerce.number().int().min(1).max(1000).default(20),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
});

export interface Config {
  databaseUrl: string;
  operationalApiEnabled: boolean;
  controlKeys: Map<string, string>;
  jwt: { jwksUrl?: string; secret?: string; issuer?: string };
  holdTtlSeconds: number;
  publicHoldsPerMinute: number;
  port: number;
}

export function parseControlKeys(raw: string | undefined): Map<string, string> {
  const keys = new Map<string, string>();
  for (const part of (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const i = part.indexOf(":");
    const kid = part.slice(0, i);
    const secret = part.slice(i + 1);
    if (i < 1 || !/^[A-Za-z0-9_.-]{1,64}$/.test(kid) || secret.length < 32) {
      throw new Error("ALKAO_CONTROL_KEYS must be 'kid:secret' pairs with secrets of at least 32 characters");
    }
    keys.set(kid, secret);
  }
  return keys;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = EnvSchema.parse(env);
  return {
    databaseUrl: e.DATABASE_URL,
    operationalApiEnabled: e.ALKAO_OPERATIONAL_API_ENABLED,
    controlKeys: parseControlKeys(e.ALKAO_CONTROL_KEYS),
    jwt: {
      ...(e.SUPABASE_JWKS_URL ? { jwksUrl: e.SUPABASE_JWKS_URL } : {}),
      ...(e.SUPABASE_JWT_SECRET ? { secret: e.SUPABASE_JWT_SECRET } : {}),
      ...(e.SUPABASE_JWT_ISSUER ? { issuer: e.SUPABASE_JWT_ISSUER } : {}),
    },
    holdTtlSeconds: e.ALKAO_HOLD_TTL_SECONDS,
    publicHoldsPerMinute: e.ALKAO_PUBLIC_HOLDS_PER_MINUTE,
    port: e.PORT,
  };
}
