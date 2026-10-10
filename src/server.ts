import { serve } from "@hono/node-server";
import { createSupabaseJwtVerifier } from "./api/auth.js";
import { createApp } from "./api/app.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { StripeGateway } from "./payments/stripe-gateway.js";

const config = loadConfig();
const db = createPool(config.databaseUrl);
const app = createApp({
  db,
  auth: createSupabaseJwtVerifier(config.jwt),
  operationalApiEnabled: config.operationalApiEnabled,
  controlKeys: config.controlKeys,
  holdTtlSeconds: config.holdTtlSeconds,
  publicHoldsPerMinute: config.publicHoldsPerMinute,
  paymentGateway: config.stripe ? StripeGateway.fromSecretKey(config.stripe.secretKey, config.stripe.webhookSecret) : null,
  paymentsMode: config.stripe?.mode ?? null,
  onboarding: config.onboarding,
  credentialMasterSecret: config.credentialMasterSecret,
  opsUi: config.opsUi,
  publicUrl: config.publicUrl,
  homeUrl: config.homeUrl,
  trustedProxyHops: config.trustedProxyHops,
  metricsToken: config.metricsToken,
  twilioAuthToken: config.twilio?.authToken ?? null,
  resendWebhookSecret: config.resendWebhookSecret,
  logRequests: process.env.ALKAO_LOG_REQUESTS !== "false",
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(
    `alkao listening on :${info.port} — operational API ${config.operationalApiEnabled ? "ENABLED" : "disabled (default)"}, payments ${config.stripe ? `configured (Stripe ${config.stripe.mode.toUpperCase()} mode)` : "not configured"}`,
  );
});
