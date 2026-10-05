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
  /** Stripe Connect platform key and the Connect webhook endpoint secret (Run 02). */
  STRIPE_SECRET_KEY: z.string().regex(/^(sk|rk)_(test|live)_/).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().regex(/^whsec_/).optional(),
  ALKAO_STRIPE_ONBOARDING_REFRESH_URL: z.url({ protocol: /^https$/ }).optional(),
  ALKAO_STRIPE_ONBOARDING_RETURN_URL: z.url({ protocol: /^https$/ }).optional(),
  /** Secret from which each Client's Ed25519 credential keys are derived (Run 03). Never stored. */
  ALKAO_CREDENTIAL_MASTER_SECRET: z.string().min(32).optional(),
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
  stripe: { secretKey: string; webhookSecret: string } | null;
  onboarding: { refreshUrl: string; returnUrl: string } | null;
  credentialMasterSecret: string | null;
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
    stripe: e.STRIPE_SECRET_KEY && e.STRIPE_WEBHOOK_SECRET ? { secretKey: e.STRIPE_SECRET_KEY, webhookSecret: e.STRIPE_WEBHOOK_SECRET } : null,
    onboarding:
      e.ALKAO_STRIPE_ONBOARDING_REFRESH_URL && e.ALKAO_STRIPE_ONBOARDING_RETURN_URL
        ? { refreshUrl: e.ALKAO_STRIPE_ONBOARDING_REFRESH_URL, returnUrl: e.ALKAO_STRIPE_ONBOARDING_RETURN_URL }
        : null,
    credentialMasterSecret: e.ALKAO_CREDENTIAL_MASTER_SECRET ?? null,
    port: e.PORT,
  };
}
