import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseReservationsReport } from "../../ops-ui/reservations-csv.js";
import { deliverCampaignEmails } from "../../src/delivery/campaigns.js";
import type { EmailMessage, EmailSender } from "../../src/delivery/email.js";
import { adm, call, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { line, report } from "../helpers/reservations.js";
import { seedTwoTenants, TEST_CREDENTIAL_SECRET, type SeedResult } from "../helpers/seed.js";

/**
 * Run 45: the automatic "after the visit" e-mail. Made-up customers; "today" moves with
 * the clock below (Québec time).
 */
let db: TestDatabase;
let seed: SeedResult;
let app: TestApp;
let clock = new Date("2026-07-10T16:00:00Z");

class Outbox implements EmailSender {
  sent: EmailMessage[] = [];
  async send(m: EmailMessage) { this.sent.push(m); return `msg_${this.sent.length}`; }
}
const outbox = new Outbox();
const deliver = () => deliverCampaignEmails(db.pool, { sender: outbox, publicUrl: "https://billets.alkao.test", credentialMasterSecret: TEST_CREDENTIAL_SECRET }, clock);
const base = () => adm(seed.havana.clientId, seed.havana.brandId);
const owner = () => tokenFor(seed.users.havanaOwner);
const days = (n: number) => { clock = new Date(clock.getTime() + n * 86_400_000); };

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  app = testApp(db.pool, { now: () => clock, credentialMasterSecret: TEST_CREDENTIAL_SECRET });
  const rows = parseReservationsReport(report([
    line("1", "CHALET 12", "2026-07-04", "2026-07-07", { Nom: "Exemple", Prénom: "Alice", Courriel: "alice@example.com" }),
    line("2", "104", "2026-07-06", "2026-07-07", { Nom: "Fictif", Prénom: "Bruno", Courriel: "bruno@example.com" }),
    line("3", "CHALET 3", "2026-06-01", "2026-06-03", { Nom: "Témoin", Prénom: "Chloé", Courriel: "chloe@example.com" }),
    line("4", "CHALET 4", "2026-07-05", "2026-07-07", { Nom: "Modèle", Prénom: "Émile", Courriel: "emile@example.com" }),
  ])).rows;
  expect((await call(app, "POST", `${base()}/customers/import`, { token: await owner(), body: { reportDate: "2026-07-01", rows } })).status).toBe(200);
  await db.pool.query(`UPDATE public.ticketing_customers SET email_opt_out_at = now() WHERE email = 'emile@example.com'`);
});

afterAll(async () => {
  await db?.drop();
});

const automation = {
  name: "Merci après un chalet", kind: "after_visit", delayDays: 3, subject: "Merci {prénom} !", heading: "Merci {prénom} !",
  body: "Comment était {visite} ?\n\nDites-le en 30 secondes.", ctaLabel: "Laisser un avis", ctaUrl: "https://g.page/r/exemple/review",
  audience: { segments: [], statuses: [], categories: ["chalet"] },
};

describe("after-visit automation", () => {
  let id = "";

  it("is not sent by hand, and needs the sender's footer to start", async () => {
    const token = await owner();
    expect((await call(app, "POST", `${base()}/campaigns`, { token, body: { ...automation, delayDays: null } })).status).toBe(400);
    const made = await call(app, "POST", `${base()}/campaigns`, { token, body: automation });
    expect(made.status).toBe(201);
    id = made.body.campaign.id;
    expect(made.body.campaign).toMatchObject({ kind: "after_visit", delayDays: 3, audienceCategories: ["chalet"], active: false });
    expect((await call(app, "POST", `${base()}/campaigns/${id}/send`, { token, body: { expectedRecipients: 1 } })).body.error.code).toBe("campaign_is_automation");
    expect((await call(app, "POST", `${base()}/campaigns/${id}/automation`, { token, body: { active: true } })).body.error.code).toBe("marketing_settings_missing");
    await call(app, "PUT", `${base()}/settings/marketing`, { token, body: { senderAddress: "1 rue Exemple, Maricourt (Québec) J0E 2L2", contact: "info@example.com" } });
    const on = await call(app, "POST", `${base()}/campaigns/${id}/automation`, { token, body: { active: true } });
    expect(on.body.campaign).toMatchObject({ active: true, status: "draft" });
  });

  it("writes once per visit, delay days after it ends, only about visits from now on", async () => {
    outbox.sent = [];
    // Today 2026-07-10, 3 days after Alice's chalet. Bruno (camping) is not a chalet, Chloé's
    // stay was before the automation started, Émile unsubscribed.
    expect(await deliver()).toMatchObject({ queued: 1, sent: 1 });
    expect(outbox.sent.map((m) => m.to)).toEqual(["alice@example.com"]);
    const m = outbox.sent[0]!;
    expect(m.subject).toBe("Merci Alice !");
    expect(m.text).toContain("Comment était Chalet 12 ?");
    expect(m.text).toContain("Laisser un avis : https://g.page/r/exemple/review");
    expect(m.headers!["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(await deliver()).toMatchObject({ queued: 0, sent: 0 });
    days(1);
    expect(await deliver()).toMatchObject({ queued: 0 });
    const c = await call(app, "GET", `${base()}/campaigns/${id}`, { token: await owner() });
    expect(c.body.campaign).toMatchObject({ sent: 1, status: "draft", active: true });
  });

  it("writes again after a new visit, but never twice in a week to one address", async () => {
    const token = await owner();
    const rows = parseReservationsReport(report([
      line("5", "CHALET 12", "2026-07-11", "2026-07-13", { Nom: "Exemple", Prénom: "Alice", Courriel: "alice@example.com" }),
      line("6", "CHALET 9", "2026-07-20", "2026-07-22", { Nom: "Exemple", Prénom: "Alice", Courriel: "alice@example.com" }),
    ])).rows;
    await call(app, "POST", `${base()}/customers/import`, { token, body: { reportDate: "2026-07-11", rows } });
    clock = new Date("2026-07-16T16:00:00Z"); // 3 days after the 07-13 departure, 6 days after the last e-mail
    outbox.sent = [];
    expect(await deliver()).toMatchObject({ queued: 0 }); // within a week of the first one
    clock = new Date("2026-07-25T16:00:00Z");
    expect(await deliver()).toMatchObject({ queued: 1, sent: 1 });
    expect(outbox.sent[0]!.text).toContain("Comment était Chalet 9 ?");
  });

  it("pauses, keeps its kind while on, and stops for good when cancelled", async () => {
    const token = await owner();
    expect((await call(app, "PUT", `${base()}/campaigns/${id}`, { token, body: { ...automation, kind: "one_time" } })).body.error.code).toBe("automation_active");
    await call(app, "POST", `${base()}/campaigns/${id}/automation`, { token, body: { active: false } });
    const rows = parseReservationsReport(report([line("7", "CHALET 2", "2026-07-26", "2026-07-28", { Nom: "Fictif", Prénom: "Bruno", Courriel: "bruno@example.com" })])).rows;
    await call(app, "POST", `${base()}/customers/import`, { token, body: { reportDate: "2026-07-25", rows } });
    clock = new Date("2026-07-31T16:00:00Z");
    expect(await deliver()).toMatchObject({ queued: 0 });
    const cancelled = await call(app, "POST", `${base()}/campaigns/${id}/cancel`, { token });
    expect(cancelled.body.campaign).toMatchObject({ status: "cancelled", active: false });
    expect((await call(app, "POST", `${base()}/campaigns/${id}/automation`, { token, body: { active: true } })).body.error.code).toBe("campaign_closed");
  });
});
