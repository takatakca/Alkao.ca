import { z } from "zod";
import { createPool } from "../src/db/pool.js";
import { ResendEmailSender } from "../src/delivery/email.js";
import { startEmailWorker } from "../src/delivery/worker.js";

// Sends the buyers' ticket emails. Refuses to start unless every setting is present.
const env = z
  .object({
    DATABASE_URL: z.string().min(1),
    RESEND_API_KEY: z.string().min(10),
    ALKAO_EMAIL_FROM: z.email(),
    ALKAO_PUBLIC_URL: z.url({ protocol: /^https$/ }),
    ALKAO_CREDENTIAL_MASTER_SECRET: z.string().min(32),
    ALKAO_EMAIL_MAX_AGE_HOURS: z.coerce.number().int().min(1).max(720).default(72),
    ALKAO_EMAIL_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(3600).default(30),
  })
  .parse(process.env);

const db = createPool(env.DATABASE_URL, 2);
const stop = startEmailWorker(
  db,
  {
    sender: new ResendEmailSender(env.RESEND_API_KEY, env.ALKAO_EMAIL_FROM),
    publicUrl: env.ALKAO_PUBLIC_URL,
    credentialMasterSecret: env.ALKAO_CREDENTIAL_MASTER_SECRET,
    maxAgeHours: env.ALKAO_EMAIL_MAX_AGE_HOURS,
  },
  env.ALKAO_EMAIL_INTERVAL_SECONDS * 1000,
);
console.log(`alkao email worker running every ${env.ALKAO_EMAIL_INTERVAL_SECONDS}s`);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stop();
    void db.end().then(() => process.exit(0));
  });
}
