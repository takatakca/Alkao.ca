import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseReservationsReport } from "../../ops-ui/reservations-csv.js";
import { deliverCampaignEmails } from "../../src/delivery/campaigns.js";
import type { EmailSender } from "../../src/delivery/email.js";
import { deliverCampaignSms, replyIntent, sendingWindow, smsSegments, SmsSendError, type SmsMessage, type SmsSender } from "../../src/delivery/sms.js";
import { adm, call, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { line, report } from "../helpers/reservations.js";
import { seedTwoTenants, TEST_CREDENTIAL_SECRET, type SeedResult } from "../helpers/seed.js";

/** Run 46: campaigns by text message. Made-up people and numbers (555-01xx). */
let db: TestDatabase;
let seed: SeedResult;
let app: TestApp;
const NOON = new Date("2026-06-25T16:00:00Z"); // 12:00 in Québec
const TWILIO_TOKEN = "test-only-twilio-auth-token-0123456789abcdef";
const PUBLIC_URL = "https://billets.alkao.test";

class FakeTwilio implements SmsSender {
  sent: SmsMessage[] = [];
  failWith: SmsSendError | null = null;
  async send(m: SmsMessage) {
    if (this.failWith) throw this.failWith;
    this.sent.push(m);
    return `SM${this.sent.length}`;
  }
}
const twilio = new FakeTwilio();
const deliver = (at = NOON) => deliverCampaignSms(db.pool, { sender: twilio }, at);
const base = () => adm(seed.havana.clientId, seed.havana.brandId);
const owner = () => tokenFor(seed.users.havanaOwner);

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  app = testApp(db.pool, { now: () => NOON, credentialMasterSecret: TEST_CREDENTIAL_SECRET, publicUrl: PUBLIC_URL, twilioAuthToken: TWILIO_TOKEN });
  const rows = parseReservationsReport(report([
    line("1", "CHALET 1", "2026-06-01", "2026-06-03", { Nom: "Exemple", Prénom: "Alice", Cellulaire: "514 555-0101", Courriel: "alice@example.com" }),
    line("2", "104", "2026-06-05", "2026-06-07", { Nom: "Fictif", Prénom: "Bruno", Courriel: "bruno@example.com" }), // no mobile
    line("3", "CHALET 2", "2026-06-10", "2026-06-12", { Nom: "Modèle", Prénom: "Émile", Cellulaire: "514 555-0103" }),
  ])).rows;
  const token = await owner();
  expect((await call(app, "POST", `${base()}/customers/import`, { token, body: { reportDate: "2026-06-01", rows } })).status).toBe(200);
  await db.pool.query(`UPDATE public.ticketing_customers SET sms_opt_out_at = now() WHERE mobile_phone = '5145550103'`);
  // Subscribed to the e-mail newsletter only: that is no consent to texts.
  await db.pool.query(
    `INSERT INTO public.ticketing_customers (client_id, brand_id, first_name, email, mobile_phone, email_consent_at) VALUES ($1, $2, 'Nadia', 'nadia@example.com', '5145550104', now())`,
    [seed.havana.clientId, seed.havana.brandId],
  );
  await call(app, "PUT", `${base()}/settings/marketing`, { token, body: { senderAddress: "1 rue Exemple, Maricourt (Québec) J0E 2L2", contact: "info@example.com" } });
});

afterAll(async () => {
  await db?.drop();
});

const text = {
  name: "Chalets fin de semaine", channel: "sms", body: "Bonjour {prénom}, -20 % sur les chalets ce week-end !",
  ctaUrl: "https://promohavana.ca/promos", audience: { segments: [], statuses: [] },
};

describe("text-message rules", () => {
  it("counts segments, keeps to 9:00–21:00 in Québec, and reads STOP in French and English", () => {
    expect(smsSegments("a".repeat(160))).toBe(1);
    expect(smsSegments("a".repeat(161))).toBe(2);
    expect(smsSegments("Fête d'été")).toBe(1); // é is in the GSM alphabet
    expect(smsSegments("ê".repeat(71))).toBe(2); // ê is not: 70 per text
    expect(sendingWindow(NOON).open).toBe(true);
    const night = sendingWindow(new Date("2026-06-26T03:30:00Z")); // 23:30 in Québec
    expect(night.open).toBe(false);
    expect(night.nextOpen.toISOString()).toBe("2026-06-26T13:00:00.000Z"); // 9:00
    for (const word of ["STOP", "arrêt", " Arret ", "Désabonner", "unsubscribe"]) expect(replyIntent(word), word).toBe("stop");
    expect(replyIntent("START")).toBe("start");
    expect(replyIntent("Merci !")).toBeNull();
  });
});

describe("SMS campaigns", () => {
  let id = "";

  it("go only to mobiles with implied consent and no STOP, once per number", async () => {
    const token = await owner();
    expect((await call(app, "POST", `${base()}/campaigns`, { token, body: { ...text, body: "x".repeat(301) } })).status).toBe(400);
    expect((await call(app, "POST", `${base()}/campaigns`, { token, body: { ...text, kind: "after_visit", delayDays: 2 } })).status).toBe(400);
    const made = await call(app, "POST", `${base()}/campaigns`, { token, body: text });
    expect(made.status).toBe(201);
    id = made.body.campaign.id;
    expect(made.body.campaign).toMatchObject({ channel: "sms", subject: "Chalets fin de semaine" });
    expect((await call(app, "GET", `${base()}/campaigns/${id}`, { token })).body.campaign.audienceNow).toBe(1);
    // Alice only: Bruno has no mobile, Émile said STOP, Nadia only consented to e-mail.
    expect((await call(app, "POST", `${base()}/campaigns/audience`, { token, body: { channel: "sms" } })).body.recipients).toBe(1);
  });

  it("sends with the Brand's name and how to stop, and leaves the e-mail worker alone", async () => {
    const token = await owner();
    expect((await call(app, "POST", `${base()}/campaigns/${id}/test`, { token, body: { email: "equipe@example.com" } })).body.error.code).toBe("campaign_test_address");
    expect((await call(app, "POST", `${base()}/campaigns/${id}/test`, { token, body: { phone: "514 555 0199" } })).status).toBe(202);
    expect((await call(app, "POST", `${base()}/campaigns/${id}/send`, { token, body: { expectedRecipients: 1 } })).status).toBe(202);
    const noEmail: EmailSender = { send: async () => { throw new Error("no e-mail for a text campaign"); } };
    expect(await deliverCampaignEmails(db.pool, { sender: noEmail, publicUrl: PUBLIC_URL, credentialMasterSecret: TEST_CREDENTIAL_SECRET }, NOON)).toMatchObject({ sent: 0, failed: 0 });

    twilio.sent = [];
    expect(await deliver()).toMatchObject({ sent: 2 });
    const alice = twilio.sent.find((m) => m.to === "+15145550101")!;
    expect(alice.body).toBe("Bonjour Alice, -20 % sur les chalets ce week-end ! https://promohavana.ca/promos - Havana Resort — Événements. Répondez STOP pour ne plus en recevoir.");
    expect(twilio.sent.map((m) => m.to).sort()).toEqual(["+15145550101", "+15145550199"]);
    expect((await call(app, "GET", `${base()}/campaigns/${id}`, { token })).body.campaign).toMatchObject({ sent: 1, tests: 1 });
  });

  it("waits for the morning, and records a STOP that Twilio reports", async () => {
    const token = await owner();
    await db.pool.query(`UPDATE public.ticketing_customers SET sms_opt_out_at = NULL WHERE mobile_phone = '5145550103'`);
    const c = await call(app, "POST", `${base()}/campaigns`, { token, body: { ...text, name: "Nuit" } });
    expect((await call(app, "POST", `${base()}/campaigns/${c.body.campaign.id}/send`, { token, body: { expectedRecipients: 2 } })).status).toBe(202);
    twilio.sent = [];
    expect(await deliver(new Date("2026-06-26T03:30:00Z"))).toMatchObject({ sent: 0, deferred: 2 });
    const { rows } = await db.pool.query(`SELECT DISTINCT next_attempt_at FROM public.ticketing_campaign_messages WHERE campaign_id = $1`, [c.body.campaign.id]);
    expect(rows.map((r) => r.next_attempt_at.toISOString())).toEqual(["2026-06-26T13:00:00.000Z"]);
    twilio.failWith = new SmsSendError("twilio 400: 21610 Attempt to send to unsubscribed recipient", false, true);
    await deliver(new Date("2026-06-26T13:05:00Z"));
    twilio.failWith = null;
    const { rows: out } = await db.pool.query(`SELECT count(*)::int AS n FROM public.ticketing_customers WHERE sms_opt_out_at IS NOT NULL`);
    expect(out[0].n).toBe(2);
  });

  it("takes STOP and START from Twilio's webhook, signed, for every Brand that has the number", async () => {
    const send = (params: Record<string, string>, signature?: string) => {
      const url = `${PUBLIC_URL}/v1/webhooks/twilio/sms`;
      const sig = signature ?? createHmac("sha1", TWILIO_TOKEN).update(url + Object.keys(params).sort().map((k) => k + params[k]).join("")).digest("base64");
      return app.request("/v1/webhooks/twilio/sms", {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig }, body: new URLSearchParams(params).toString(),
      });
    };
    await db.pool.query(`UPDATE public.ticketing_customers SET sms_opt_out_at = NULL WHERE mobile_phone = '5145550101'`);
    expect((await send({ From: "+15145550101", Body: "ARRÊT" }, "forged")).status).toBe(403);
    const stop = await send({ From: "+15145550101", To: "+15145550000", Body: "ARRÊT" });
    expect(stop.status).toBe(200);
    expect(await stop.text()).toContain("<Response></Response>");
    const opted = async () => (await db.pool.query(`SELECT sms_opt_out_at FROM public.ticketing_customers WHERE mobile_phone = '5145550101'`)).rows[0].sms_opt_out_at;
    expect(await opted()).not.toBeNull();
    const { rows } = await db.pool.query(`SELECT actor_type FROM public.ticketing_audit_log WHERE action = 'customer.sms_stopped'`);
    expect(rows).toEqual([{ actor_type: "public" }]);
    await send({ From: "+15145550101", Body: "START" });
    expect(await opted()).toBeNull();
    // Without Twilio configured, the route does not exist.
    const plain = testApp(db.pool, { publicUrl: PUBLIC_URL });
    expect((await plain.request("/v1/webhooks/twilio/sms", { method: "POST", body: "" })).status).toBe(404);
  });
});
