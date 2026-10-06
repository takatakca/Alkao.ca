import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EmailMessage, EmailSender } from "../../src/delivery/email.js";
import { deliverSignupConfirmations } from "../../src/delivery/newsletter.js";
import { adm, call, pub, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { seedTwoTenants, TEST_CREDENTIAL_SECRET, type SeedResult } from "../helpers/seed.js";

/** Run 44: newsletter sign-up with a confirmation e-mail. Made-up addresses only. */
let db: TestDatabase;
let seed: SeedResult;
let app: TestApp;

class Outbox implements EmailSender {
  sent: EmailMessage[] = [];
  async send(m: EmailMessage) { this.sent.push(m); return `msg_${this.sent.length}`; }
}
const outbox = new Outbox();
const deliver = (at = new Date()) => deliverSignupConfirmations(db.pool, { sender: outbox, publicUrl: "https://billets.alkao.test", credentialMasterSecret: TEST_CREDENTIAL_SECRET }, at);

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  app = testApp(db.pool, { credentialMasterSecret: TEST_CREDENTIAL_SECRET });
});

afterAll(async () => {
  await db?.drop();
});

const signup = (body: Record<string, unknown>) => call(app, "POST", `${pub(seed.havana.clientId, seed.havana.brandId)}/newsletter`, { body });
const admin = () => adm(seed.havana.clientId, seed.havana.brandId);
const linkIn = (m: EmailMessage) => /https:\/\/billets\.alkao\.test(\/inscription\?[^\s"<]+)/.exec(m.text)![1]!.replace(/&amp;/g, "&");
const customer = async (email: string) => (await db.pool.query(`SELECT * FROM public.ticketing_customers WHERE email = $1`, [email])).rows;

describe("newsletter sign-up", () => {
  it("sets the welcome code, for owners and admins only", async () => {
    const body = { rewardCode: "havana5", rewardText: "5 % sur vos billets" };
    expect((await call(app, "PUT", `${admin()}/settings/newsletter`, { token: await tokenFor(seed.users.havanaStaff), body })).status).toBe(403);
    const res = await call(app, "PUT", `${admin()}/settings/newsletter`, { token: await tokenFor(seed.users.havanaOwner), body });
    expect(res.body.newsletter).toMatchObject({ rewardCode: "HAVANA5", rewardText: "5 % sur vos billets", signups: { pending: 0, confirmed: 0 } });
  });

  it("answers the same for any address, and writes nothing to the customer file before the click", async () => {
    expect((await signup({ email: "Nouvelle@Example.com", firstName: "Nadia", source: "promohavana" })).status).toBe(202);
    expect((await signup({ email: "nouvelle@example.com" })).status).toBe(202); // within 10 minutes: no second e-mail
    expect((await signup({ email: "pas-une-adresse" })).status).toBe(400);
    const { rows } = await db.pool.query(`SELECT email, first_name, source, status FROM public.ticketing_newsletter_signups`);
    expect(rows).toEqual([{ email: "nouvelle@example.com", first_name: "Nadia", source: "promohavana", status: "pending" }]);
    expect(await customer("nouvelle@example.com")).toEqual([]);
  });

  it("e-mails a signed link; the page asks first, then records express consent and shows the code", async () => {
    outbox.sent = [];
    expect(await deliver()).toMatchObject({ sent: 1 });
    const m = outbox.sent[0]!;
    expect(m.to).toBe("nouvelle@example.com");
    expect(m.subject).toBe("Confirmez votre inscription — Havana Resort — Événements");
    expect(m.text).toContain("Bonjour Nadia,");
    expect(m.text).toContain("5 % sur vos billets");
    expect(m.text).not.toContain("HAVANA5"); // the code comes with the click
    const path = linkIn(m);

    const page = await app.request(path);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Oui, je confirme");
    expect(await customer("nouvelle@example.com")).toEqual([]); // opening the link changes nothing
    expect((await app.request(path.replace(/k=[^&]+/, "k=faux"), { method: "POST" })).status).toBe(404);

    const done = await app.request(path, { method: "POST" });
    expect(done.status).toBe(200);
    const html = await done.text();
    expect(html).toContain("HAVANA5");
    expect(html).toContain("Merci");
    const [c] = await customer("nouvelle@example.com");
    expect(c).toMatchObject({ first_name: "Nadia" });
    expect(c.email_consent_at).not.toBeNull();
    const detail = await call(app, "GET", `${admin()}/customers/${c.id}`, { token: await tokenFor(seed.users.havanaOwner) });
    expect(detail.body.customer).toMatchObject({ segment: "prospect", emailPermission: "express" });
    // Confirming again shows the code again and changes nothing.
    expect(await (await app.request(path, { method: "POST" })).text()).toContain("HAVANA5");
    expect(await customer("nouvelle@example.com")).toHaveLength(1);
    const { rows: audit } = await db.pool.query(`SELECT actor_type FROM public.ticketing_audit_log WHERE action = 'customer.subscribed'`);
    expect(audit).toEqual([{ actor_type: "public" }]);
    const settings = await call(app, "GET", `${admin()}/settings/newsletter`, { token: await tokenFor(seed.users.havanaOwner) });
    expect(settings.body.newsletter.signups).toMatchObject({ pending: 0, confirmed: 1, confirmedLast30Days: 1 });
  });

  it("re-subscribes a customer who had unsubscribed, on their own confirmation", async () => {
    await db.pool.query(
      `INSERT INTO public.ticketing_customers (client_id, brand_id, first_name, email, email_opt_out_at) VALUES ($1, $2, 'Retour', 'retour@example.com', now() - interval '1 day')`,
      [seed.havana.clientId, seed.havana.brandId],
    );
    await signup({ email: "retour@example.com" });
    outbox.sent = [];
    await deliver();
    await app.request(linkIn(outbox.sent[0]!), { method: "POST" });
    const [c] = await customer("retour@example.com");
    const detail = await call(app, "GET", `${admin()}/customers/${c.id}`, { token: await tokenFor(seed.users.havanaOwner) });
    expect(detail.body.customer.emailPermission).toBe("express");
  });

  it("lets a link expire after 7 days, and never sends a confirmation late", async () => {
    await signup({ email: "tard@example.com" });
    outbox.sent = [];
    await deliver();
    const path = linkIn(outbox.sent[0]!);
    await db.pool.query(`UPDATE public.ticketing_newsletter_signups SET created_at = now() - interval '8 days' WHERE email = 'tard@example.com'`);
    expect((await app.request(path, { method: "POST" })).status).toBe(410);
    expect(await customer("tard@example.com")).toEqual([]);

    await signup({ email: "jamais@example.com" });
    outbox.sent = [];
    expect(await deliver(new Date(Date.now() + 4 * 86_400_000))).toMatchObject({ sent: 0, skipped: 1 });
  });
});
