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
  /** Supabase project URL and public anon key, for the Operations app's sign-in (public values). */
  SUPABASE_URL: z.url().optional(),
  SUPABASE_ANON_KEY: z.string().min(20).optional(),
  /** Origins allowed to embed /ops in an iframe (e.g. the TAKATAK dashboard), comma-separated. */
  ALKAO_OPS_FRAME_ANCESTORS: z.string().optional(),
  /** Public HTTPS URL of this deployment: hosted shop return URLs and ticket links (Run 06/08). */
  ALKAO_PUBLIC_URL: z.url({ protocol: /^https$/ }).optional(),
  /** Reverse proxies in front of ALKAO (load balancer = 1, CDN + load balancer = 2, none = 0). */
  ALKAO_TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
  ALKAO_HOLD_TTL_SECONDS: z.coerce.number().int().min(60).max(1800).default(600),
  ALKAO_PUBLIC_HOLDS_PER_MINUTE: z.coerce.number().int().min(1).max(1000).default(20),
  /** Bearer token for GET /metrics (Run 24). Without it, /metrics does not exist. */
  ALKAO_METRICS_TOKEN: z.string().min(32).optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  NODE_ENV: z.string().optional(),
});

export interface Config {
  databaseUrl: string;
  operationalApiEnabled: boolean;
  controlKeys: Map<string, string>;
  jwt: { jwksUrl?: string; secret?: string; issuer?: string };
  holdTtlSeconds: number;
  publicHoldsPerMinute: number;
  /** `mode` (Run 32): from the key itself, so staff and buyers can be told when nothing is real. */
  stripe: { secretKey: string; webhookSecret: string; mode: "test" | "live" } | null;
  onboarding: { refreshUrl: string; returnUrl: string } | null;
  credentialMasterSecret: string | null;
  opsUi: { supabaseUrl: string | null; supabaseAnonKey: string | null; frameAncestors: string[] };
  publicUrl: string | null;
  trustedProxyHops: number;
  metricsToken: string | null;
  port: number;
}

/** Run 32: `sk_test_…` and `rk_test_…` keys are Stripe test mode; the schema allows only test or live keys. */
export const stripeKeyMode = (key: string): "test" | "live" => (/^(sk|rk)_test_/.test(key) ? "test" : "live");

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
    stripe: e.STRIPE_SECRET_KEY && e.STRIPE_WEBHOOK_SECRET
      ? { secretKey: e.STRIPE_SECRET_KEY, webhookSecret: e.STRIPE_WEBHOOK_SECRET, mode: stripeKeyMode(e.STRIPE_SECRET_KEY) }
      : null,
    onboarding:
      e.ALKAO_STRIPE_ONBOARDING_REFRESH_URL && e.ALKAO_STRIPE_ONBOARDING_RETURN_URL
        ? { refreshUrl: e.ALKAO_STRIPE_ONBOARDING_REFRESH_URL, returnUrl: e.ALKAO_STRIPE_ONBOARDING_RETURN_URL }
        : null,
    credentialMasterSecret: e.ALKAO_CREDENTIAL_MASTER_SECRET ?? null,
    opsUi: {
      supabaseUrl: e.SUPABASE_URL ?? null,
      supabaseAnonKey: e.SUPABASE_ANON_KEY ?? null,
      // http://localhost is accepted for development only.
      frameAncestors: (e.ALKAO_OPS_FRAME_ANCESTORS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => /^https:\/\/[a-z0-9.-]+(:\d+)?$/.test(s) || (e.NODE_ENV !== "production" && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(s))),
    },
    publicUrl: e.ALKAO_PUBLIC_URL ?? null,
    trustedProxyHops: e.ALKAO_TRUSTED_PROXY_HOPS,
    metricsToken: e.ALKAO_METRICS_TOKEN ?? null,
    port: e.PORT,
  };
}
