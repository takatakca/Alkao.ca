import { loadConfig } from "../src/config.js";
import { createPool } from "../src/db/pool.js";
import { advanceCancellations } from "../src/ops/cancellation.js";
import { PaymentsService } from "../src/payments/service.js";
import { StripeGateway } from "../src/payments/stripe-gateway.js";

// Finishes session cancellations without anyone keeping the Operations page open, and
// retries refunds Stripe failed. Needs the same configuration as the server.
const config = loadConfig();
if (!config.stripe) throw new Error("STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are required");
const db = createPool(config.databaseUrl, 2);
const payments = new PaymentsService({
  db,
  gateway: StripeGateway.fromSecretKey(config.stripe.secretKey, config.stripe.webhookSecret),
  now: () => new Date(),
  onboarding: config.onboarding,
});
const intervalMs = Number(process.env.ALKAO_CANCELLATION_INTERVAL_SECONDS ?? 30) * 1000;
let running = false;
const tick = async () => {
  if (running) return;
  running = true;
  try {
    const n = await advanceCancellations(db, payments);
    if (n > 0) console.log(`alkao cancellations: advanced ${n} job(s)`);
  } catch (error) {
    console.error(`alkao cancellations: ${(error as Error).message}`);
  } finally {
    running = false;
  }
};
const timer = setInterval(tick, intervalMs);
void tick();
console.log(`alkao cancellation worker running every ${intervalMs / 1000}s`);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    clearInterval(timer);
    void db.end().then(() => process.exit(0));
  });
}
