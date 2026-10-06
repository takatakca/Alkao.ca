import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseReservationsReport } from "../../ops-ui/reservations-csv.js";
import { deliverCampaignEmails, unsubscribeToken } from "../../src/delivery/campaigns.js";
import type { EmailMessage, EmailSender } from "../../src/delivery/email.js";
import { personalize } from "../../src/delivery/templates.js";
import { adm, call, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { line, report } from "../helpers/reservations.js";
import { seedTwoTenants, TEST_CREDENTIAL_SECRET, type SeedResult } from "../helpers/seed.js";

/**
 * Run 42: e-mail campaigns to the customer file, under Canada's anti-spam law. Made-up
 * customers only; "today" is 2026-06-25 in Québec.
 */
let db: TestDatabase;
let seed: SeedResult;
let app: TestApp;
const NOW = new Date("2026-06-25T16:00:00Z");

class Outbox implements EmailSender {
  sent: EmailMessage[] = [];
  async send(m: EmailMessage) { this.sent.push(m); return `msg_${this.sent.length}`; }
}
const outbox = new Outbox();
const deliver = (at = NOW) => deliverCampaignEmails(db.pool, { sender: outbox, publicUrl: "https://billets.alkao.test", credentialMasterSecret: TEST_CREDENTIAL_SECRET }, at);

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  app = testApp(db.pool, { now: () => NOW, credentialMasterSecret: TEST_CREDENTIAL_SECRET });
  // Alice and Bruno share one address: they get one e-mail. Chloé has no e-mail. Denis will unsubscribe.
  const rows = parseReservationsReport(report([
    line("1", "CHALET 1", "2025-07-01", "2025-07-03", { Nom: "Exemple", Prénom: "Alice", Courriel: "famille@example.com" }),
    line("2", "CHALET 1", "2024-07-01", "2024-07-03", { Nom: "Exemple", Prénom: "Alice", Courriel: "famille@example.com" }),
    line("3", "104", "2025-08-01", "2025-08-02", { Nom: "Fictif", Prénom: "Bruno", Courriel: "famille@example.com" }),
    line("4", "CABANA 2", "2025-08-01", "2025-08-02", { Nom: "Témoin", Prénom: "Chloé" }),
    line("5", "CONDO 3 AMARILLO", "2026-06-01", "2026-06-03", { Nom: "Modèle", Prénom: "Denis", Courriel: "denis@example.com" }),
  ])).rows;
  const token = await tokenFor(seed.users.havanaOwner);
  expect((await call(app, "POST", `${base()}/customers/import`, { token, body: { reportDate: "2026-06-01", rows } })).status).toBe(200);
  // A customer whose last booking is over 2 years old: implied consent has run out.
  await db.pool.query(
    `WITH c AS (INSERT INTO public.ticketing_customers (client_id, brand_id, first_name, email) VALUES ($1, $2, 'Émile', 'emile@example.com') RETURNING id)
     INSERT INTO public.ticketing_customer_bookings (client_id, brand_id, customer_id, source, source_ref, category, starts_on, ends_on, first_report_on, last_report_on)
     SELECT $1, $2, id, 'reservation_camping', 'OLD-1', 'chalet', '2023-07-01', '2023-07-02', '2023-06-01', '2023-06-01' FROM c`,
    [seed.havana.clientId, seed.havana.brandId],
  );
});

afterAll(async () => {
  await db?.drop();
});

const base = () => adm(seed.havana.clientId, seed.havana.brandId);
const owner = () => tokenFor(seed.users.havanaOwner);
const draft = (patch: Record<string, unknown> = {}) => ({
  name: "Halloween 2026", subject: "{prénom}, Halloween revient !", preheader: "Billets en vente", heading: "Bonjour {prénom},",
  body: "Les soirées Halloween reviennent au Havana.\n\nRéservez votre chalet avant le 1er octobre.", imageUrl: "https://havanaresort.ca/halloween.jpg",
  ctaLabel: "Acheter mes billets", ctaUrl: "https://promohavana.ca/promos/halloween", audience: { segments: [], statuses: [] }, ...patch,
});
async function create(patch: Record<string, unknown> = {}) {
  const res = await call(app, "POST", `${base()}/campaigns`, { token: await owner(), body: draft(patch) });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.campaign;
}
const messages = async (campaignId: string) =>
  (await db.pool.query(`SELECT id, email, status, last_error, customer_id FROM public.ticketing_campaign_messages WHERE campaign_id = $1 ORDER BY email`, [campaignId])).rows;

describe("personalization", () => {
  it("puts the first name in, or takes the placeholder out with its space", () => {
    expect(personalize("Bonjour {prénom},", "Alice")).toBe("Bonjour Alice,");
    expect(personalize("Bonjour {prénom},", null)).toBe("Bonjour,");
    expect(personalize("{prenom}, Halloween revient !", "Alice")).toBe("Alice, Halloween revient !");
    expect(personalize("Hi {first_name}!", null)).toBe("Hi!");
  });
});

describe("e-mail campaigns", () => {
  it("are for owners and admins; another Client never sees them", async () => {
    const c = await create({ name: "Interne" });
    for (const user of [seed.users.havanaStaff, seed.users.both]) {
      expect((await call(app, "GET", `${base()}/campaigns`, { token: await tokenFor(user) })).status).toBe(403);
    }
    expect((await call(app, "GET", `${base()}/campaigns/${c.id}`, { token: await tokenFor(seed.users.festiOwner) })).status).toBe(404);
    const festi = adm(seed.festi.clientId, seed.festi.brandId);
    expect((await call(app, "GET", `${festi}/campaigns/${c.id}`, { token: await tokenFor(seed.users.festiOwner) })).status).toBe(404);
  });

  it("refuses links that are not https, and a button without its link", async () => {
    const token = await owner();
    expect((await call(app, "POST", `${base()}/campaigns`, { token, body: draft({ ctaUrl: "http://promohavana.ca" }) })).status).toBe(400);
    expect((await call(app, "POST", `${base()}/campaigns`, { token, body: draft({ ctaUrl: null }) })).status).toBe(400);
    expect((await call(app, "POST", `${base()}/campaigns`, { token, body: draft({ imageUrl: "javascript:alert(1)" }) })).status).toBe(400);
  });

  it("counts only customers who may receive it, once per address", async () => {
    const token = await owner();
    // Alice/Bruno (one address) and Denis. Not Chloé (no e-mail), not Émile (consent ran out).
    expect((await call(app, "POST", `${base()}/campaigns/audience`, { token, body: { segments: [], statuses: [] } })).body.recipients).toBe(2);
    expect((await call(app, "POST", `${base()}/campaigns/audience`, { token, body: { segments: ["occasional"] } })).body.recipients).toBe(1);
    expect((await call(app, "POST", `${base()}/campaigns/audience`, { token, body: { statuses: ["inactive"] } })).body.recipients).toBe(0);
  });

  it("needs the sender's mailing address and contact before anything goes out", async () => {
    const c = await create();
    const token = await owner();
    const refused = await call(app, "POST", `${base()}/campaigns/${c.id}/send`, { token, body: { expectedRecipients: 2 } });
    expect(refused.body.error.code).toBe("marketing_settings_missing");
    const set = await call(app, "PUT", `${base()}/settings/marketing`, { token, body: { senderAddress: "1 rue Exemple, Maricourt (Québec) J0E 2L2", contact: "info@example.com" } });
    expect(set.status).toBe(200);
    expect((await call(app, "GET", `${base()}/settings/marketing`, { token })).body.marketing).toEqual({ senderAddress: "1 rue Exemple, Maricourt (Québec) J0E 2L2", contact: "info@example.com" });
  });

  it("sends to the number staff saw, personalized, with the law's footer and a one-click unsubscribe", async () => {
    const c = await create();
    const token = await owner();
    const changed = await call(app, "POST", `${base()}/campaigns/${c.id}/send`, { token, body: { expectedRecipients: 5 } });
    expect(changed.status).toBe(409);
    expect(changed.body.error).toEqual({ code: "audience_changed", details: { recipients: 2 } });
    expect(await messages(c.id)).toEqual([]);

    const sent = await call(app, "POST", `${base()}/campaigns/${c.id}/send`, { token, body: { expectedRecipients: 2 } });
    expect(sent.status).toBe(202);
    expect(sent.body.campaign).toMatchObject({ status: "sending", recipients: 2, pending: 2 });
    expect((await call(app, "PUT", `${base()}/campaigns/${c.id}`, { token, body: draft() })).body.error.code).toBe("campaign_not_draft");

    outbox.sent = [];
    expect(await deliver()).toMatchObject({ sent: 2, skipped: 0, finished: 1 });
    const denis = outbox.sent.find((m) => m.to === "denis@example.com")!;
    expect(denis.subject).toBe("Denis, Halloween revient !");
    expect(denis.fromName).toBe("Havana Resort — Événements"); // the Brand's name
    expect(denis.html).toContain("Bonjour Denis,");
    expect(denis.html).toContain("https://havanaresort.ca/halloween.jpg");
    expect(denis.html).toContain("1 rue Exemple, Maricourt (Québec) J0E 2L2");
    expect(denis.text).toContain("Acheter mes billets : https://promohavana.ca/promos/halloween");
    expect(denis.headers!["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    const link = /<(https:\/\/billets\.alkao\.test\/desabonnement\?[^>]+)>/.exec(denis.headers!["List-Unsubscribe"]!)![1]!;
    expect(denis.text).toContain(link);
    // The shared address got one e-mail, addressed to the most frequent customer on it.
    expect(outbox.sent.filter((m) => m.to === "famille@example.com")).toHaveLength(1);
    expect((await call(app, "GET", `${base()}/campaigns/${c.id}`, { token })).body.campaign).toMatchObject({ status: "sent", sent: 2, pending: 0 });

    // Unsubscribe: a page with one button, then the opt-out.
    const path = link.replace("https://billets.alkao.test", "");
    const page = await app.request(path);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await page.text()).toContain("Me désabonner");
    expect((await app.request(path.replace(/k=[^&]+/, "k=faux"))).status).toBe(404);
    const done = await app.request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
    expect(done.status).toBe(200);
    expect(await done.text()).toContain("vous ne recevrez plus");
    expect(await (await app.request(path)).text()).toContain("déjà désabonnée");
    const { rows } = await db.pool.query(`SELECT email_opt_out_at FROM public.ticketing_customers WHERE email = 'denis@example.com'`);
    expect(rows[0].email_opt_out_at).not.toBeNull();
    expect((await call(app, "GET", `${base()}/campaigns/${c.id}`, { token })).body.campaign.unsubscribed).toBe(1);
    // The next campaign leaves Denis out.
    expect((await call(app, "POST", `${base()}/campaigns/audience`, { token, body: {} })).body.recipients).toBe(1);
    const { rows: audit } = await db.pool.query(`SELECT actor_type FROM public.ticketing_audit_log WHERE action = 'customer.unsubscribed'`);
    expect(audit).toEqual([{ actor_type: "public" }]);
  });

  it("sends tests to staff without counting them, and never past the limit", async () => {
    const c = await create({ name: "Essai" });
    const token = await owner();
    expect((await call(app, "POST", `${base()}/campaigns/${c.id}/test`, { token, body: { email: "Equipe@Example.com" } })).status).toBe(202);
    outbox.sent = [];
    await deliver();
    expect(outbox.sent.map((m) => m.to)).toEqual(["equipe@example.com"]);
    // No customer behind a test: the greeting has no name, and its unsubscribe link changes nothing.
    expect(outbox.sent[0]!.html).toContain("Bonjour,");
    const link = /<(https:[^>]+)>/.exec(outbox.sent[0]!.headers!["List-Unsubscribe"]!)![1]!.replace("https://billets.alkao.test", "");
    expect(await (await app.request(link, { method: "POST" })).text()).toContain("essai");
    expect((await call(app, "GET", `${base()}/campaigns/${c.id}`, { token })).body.campaign).toMatchObject({ status: "draft", tests: 1, sent: 0, audienceNow: 1 });
    for (let i = 1; i < 20; i++) await call(app, "POST", `${base()}/campaigns/${c.id}/test`, { token, body: { email: `t${i}@example.com` } });
    expect((await call(app, "POST", `${base()}/campaigns/${c.id}/test`, { token, body: { email: "trop@example.com" } })).body.error.code).toBe("campaign_test_limit");
    await deliver(); // the 19 other tests go out now
  });

  it("skips who unsubscribed after the send was started, and stops a cancelled campaign", async () => {
    const token = await owner();
    // Denis consents again (newsletter sign-up), then a campaign is sent to both addresses.
    const { rows } = await db.pool.query(`SELECT id FROM public.ticketing_customers WHERE email = 'denis@example.com'`);
    await call(app, "PATCH", `${base()}/customers/${rows[0].id}`, { token, body: { emailConsent: true } });
    const c = await create({ name: "Noël" });
    expect((await call(app, "POST", `${base()}/campaigns/${c.id}/send`, { token, body: { expectedRecipients: 2 } })).status).toBe(202);
    await call(app, "PATCH", `${base()}/customers/${rows[0].id}`, { token, body: { emailOptOut: true } });
    outbox.sent = [];
    await deliver();
    expect(outbox.sent.map((m) => m.to)).toEqual(["famille@example.com"]);
    expect((await messages(c.id)).find((m) => m.email === "denis@example.com")).toMatchObject({ status: "skipped", last_error: "unsubscribed" });

    const stopped = await create({ name: "Annulée", audience: { segments: ["occasional"], statuses: [] } });
    expect((await call(app, "POST", `${base()}/campaigns/${stopped.id}/send`, { token, body: { expectedRecipients: 1 } })).status).toBe(202);
    const cancel = await call(app, "POST", `${base()}/campaigns/${stopped.id}/cancel`, { token });
    expect(cancel.body.campaign).toMatchObject({ status: "cancelled", skipped: 1, pending: 0 });
    outbox.sent = [];
    await deliver();
    expect(outbox.sent).toEqual([]);
    expect((await call(app, "POST", `${base()}/campaigns/${stopped.id}/cancel`, { token })).body.error.code).toBe("campaign_closed");
  });

  it("drops a message that waited more than a week, and never writes to an anonymized customer", async () => {
    const token = await owner();
    await db.pool.query(`UPDATE public.ticketing_customers SET email_opt_out_at = NULL, email_consent_at = now() WHERE email = 'denis@example.com'`);
    const c = await create({ name: "Vieille" });
    expect((await call(app, "POST", `${base()}/campaigns/${c.id}/send`, { token, body: { expectedRecipients: 2 } })).status).toBe(202);
    const { rows } = await db.pool.query(`SELECT id FROM public.ticketing_customers WHERE email = 'denis@example.com'`);
    await call(app, "POST", `${base()}/customers/${rows[0].id}/anonymize`, { token });
    outbox.sent = [];
    await deliver(new Date(NOW.getTime() + 8 * 86_400_000));
    expect(outbox.sent).toEqual([]);
    expect((await messages(c.id)).map((m) => m.last_error).sort()).toEqual(["anonymized", "too_old"]);
  });

  it("unsubscribe links are signed per message", () => {
    const id = "6f1d2c3b-4a59-4e6d-8f70-112233445566";
    expect(unsubscribeToken(TEST_CREDENTIAL_SECRET, id)).toBe(unsubscribeToken(TEST_CREDENTIAL_SECRET, id));
    expect(unsubscribeToken(TEST_CREDENTIAL_SECRET, id)).not.toBe(unsubscribeToken(TEST_CREDENTIAL_SECRET, id.replace(/6$/, "7")));
    expect(unsubscribeToken(TEST_CREDENTIAL_SECRET, id)).not.toBe(unsubscribeToken("another-secret-0123456789abcdef0123456789", id));
  });
});
