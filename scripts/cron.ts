import { z } from "zod";
import { loadConfig } from "../src/config.js";
import { createPool } from "../src/db/pool.js";
import { ResendEmailSender } from "../src/delivery/email.js";
import { runBackgroundOnce } from "../src/ops/cron.js";
import { PaymentsService } from "../src/payments/service.js";
import { StripeGateway } from "../src/payments/stripe-gateway.js";

// Run 39: one pass of every background worker, then exit. For cPanel cron, every minute:
//   cd ~/alkao/current && node --env-file=.env --import tsx scripts/cron.ts
// Hosts that keep processes running use worker:sweeper, worker:email and worker:cancellations instead.
const config = loadConfig();
const email = z
  .object({ RESEND_API_KEY: z.string().min(10), ALKAO_EMAIL_FROM: z.email(), ALKAO_EMAIL_MAX_AGE_HOURS: z.coerce.number().int().min(1).max(720).default(72) })
  .safeParse(process.env);

const db = createPool(config.databaseUrl, 3);
try {
  const result = await runBackgroundOnce(db, {
    email: email.success && config.publicUrl && config.credentialMasterSecret
      ? {
          sender: new ResendEmailSender(email.data.RESEND_API_KEY, email.data.ALKAO_EMAIL_FROM),
          publicUrl: config.publicUrl,
          credentialMasterSecret: config.credentialMasterSecret,
          maxAgeHours: email.data.ALKAO_EMAIL_MAX_AGE_HOURS,
        }
      : null,
    payments: config.stripe
      ? new PaymentsService({
          db,
          gateway: StripeGateway.fromSecretKey(config.stripe.secretKey, config.stripe.webhookSecret),
          now: () => new Date(),
          onboarding: config.onboarding,
        })
      : null,
  });
  // One line per run, counts only, so the cron log stays short and holds no buyer data.
  console.log(`alkao cron ${new Date().toISOString()} ${result.ran ? JSON.stringify(result) : "skipped: another run is still working"}`);
} catch (error) {
  console.error(`alkao cron failed: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await db.end();
}
