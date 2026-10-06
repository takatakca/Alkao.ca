import { z } from "zod";
import { createPool } from "../src/db/pool.js";
import { ResendEmailSender } from "../src/delivery/email.js";
import { startEmailWorker } from "../src/delivery/worker.js";
import { deliverCampaignSms, TwilioSmsSender } from "../src/delivery/sms.js";
import { loadConfig } from "../src/config.js";

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
// Run 46: campaign texts too, when Twilio is configured.
const twilio = loadConfig().twilio;
let smsBusy = false;
const smsTimer = twilio
  ? setInterval(() => {
      if (smsBusy) return;
      smsBusy = true;
      deliverCampaignSms(db, { sender: new TwilioSmsSender(twilio.accountSid, twilio.authToken, twilio.sender) })
        .then((r) => { if (r.sent + r.skipped + r.retried + r.failed > 0) console.log(`alkao sms: ${JSON.stringify(r)}`); })
        .catch((error) => console.log(`alkao sms: ${(error as Error).message}`))
        .finally(() => { smsBusy = false; });
    }, env.ALKAO_EMAIL_INTERVAL_SECONDS * 1000)
  : null;
if (twilio) console.log("alkao sms: campaign texts on (Twilio)");
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stop();
    if (smsTimer) clearInterval(smsTimer);
    void db.end().then(() => process.exit(0));
  });
}
