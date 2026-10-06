import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseReservationsReport } from "../../ops-ui/reservations-csv.js";
import { emailEventOf, resendSignatureValid } from "../../src/delivery/bounces.js";
import { deliverCampaignEmails } from "../../src/delivery/campaigns.js";
import type { EmailMessage, EmailSender } from "../../src/delivery/email.js";
import { HOLD_RULES } from "../../src/db/campaigns.js";
import { adm, call, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { line, report } from "../helpers/reservations.js";
import { seedPaidOrder, seedTwoTenants, TEST_CREDENTIAL_SECRET, type SeedResult } from "../helpers/seed.js";

/**
 * Run 48: e-mails that bounce or are marked as spam, as Resend reports them. 120 made-up
 * customers (client000@example.com …); "today" is 2026-06-25 in Québec.
 */
let db: TestDatabase;
let seed: SeedResult;
let app: TestApp;
const NOON = new Date("2026-06-25T16:00:00Z");
let clock = NOON;
const hours = (n: number) => new Date(NOON.getTime() + n * 3600_000);
const SECRET = `whsec_${Buffer.from("test-only-resend-signing-key-0123456789").toString("base64")}`;

class Outbox implements EmailSender {
  sent: EmailMessage[] = [];
  async send(m: EmailMessage) { this.sent.push(m); return `re_${this.sent.length}`; }
}
const outbox = new Outbox();
const deliver = (at: Date, campaignEmailsPerHour?: number) => deliverCampaignEmails(db.pool, {
  sender: outbox, publicUrl: "https://billets.alkao.test", credentialMasterSecret: TEST_CREDENTIAL_SECRET, ...(campaignEmailsPerHour ? { campaignEmailsPerHour } : {}),
}, at);
const base = () => adm(seed.havana.clientId, seed.havana.brandId);
const owner = () => tokenFor(seed.users.havanaOwner);

function sign(body: string, at: Date, secret = SECRET) {
  const id = `msg_${Math.random().toString(36).slice(2)}`;
  const timestamp = String(Math.floor(at.getTime() / 1000));
  const signature = `v1,${createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
  return { id, timestamp, signature };
}
function hook(payload: unknown, opts: { at?: Date; secret?: string; raw?: string; target?: TestApp } = {}) {
  const body = opts.raw ?? JSON.stringify(payload);
  const h = sign(body, opts.at ?? clock, opts.secret);
  return (opts.target ?? app).request("/v1/webhooks/resend", {
    method: "POST", body,
    headers: { "content-type": "application/json", "svix-id": h.id, "svix-timestamp": h.timestamp, "svix-signature": h.signature },
  });
}
const bounce = (emailId: string, to: string, type = "Permanent") => ({
  type: "email.bounced", created_at: "2026-06-25T16:05:00.000Z",
  data: { email_id: emailId, to: [to], subject: "Test", bounce: { type, subType: "General", message: "The mailbox does not exist." } },
});
const complaint = (emailId: string, to: string) => ({ type: "email.complained", created_at: "2026-06-25T16:05:00.000Z", data: { email_id: emailId, to: [to] } });

const sentMessages = async (campaignId: string) =>
  (await db.pool.query<{ provider_message_id: string; email: string }>(
    `SELECT provider_message_id, email FROM public.ticketing_campaign_messages
     WHERE campaign_id = $1 AND status = 'sent' AND customer_id IS NOT NULL ORDER BY email`, [campaignId],
  )).rows;
const campaign = async (id: string) => (await call(app, "GET", `${base()}/campaigns/${id}`, { token: await owner() })).body.campaign;
const audienceNow = async () => (await call(app, "POST", `${base()}/campaigns/audience`, { token: await owner(), body: {} })).body.recipients as number;
async function startCampaign(name: string) {
  const token = await owner();
  const made = await call(app, "POST", `${base()}/campaigns`, {
    token, body: { name, subject: "{prénom}, l'été continue", heading: "Bonjour {prénom},", body: "Il reste des chalets.", audience: { segments: [], statuses: [] } },
  });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const id = made.body.campaign.id as string;
  const recipients = await audienceNow();
  expect((await call(app, "POST", `${base()}/campaigns/${id}/send`, { token, body: { expectedRecipients: recipients } })).status).toBe(202);
  return { id, recipients };
}

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  app = testApp(db.pool, { now: () => clock, credentialMasterSecret: TEST_CREDENTIAL_SECRET, resendWebhookSecret: SECRET });
  const n = (i: number) => String(i).padStart(3, "0");
  const rows = parseReservationsReport(report(Array.from({ length: 120 }, (_, i) =>
    line(String(1000 + i), "CHALET 1", "2026-05-01", "2026-05-03", { Nom: `Fictif${n(i)}`, Prénom: "Client", Courriel: `client${n(i)}@example.com` })))).rows;
  const token = await owner();
  expect((await call(app, "POST", `${base()}/customers/import`, { token, body: { reportDate: "2026-06-01", rows } })).status).toBe(200);
  await call(app, "PUT", `${base()}/settings/marketing`, { token, body: { senderAddress: "1 rue Exemple, Maricourt (Québec) J0E 2L2", contact: "info@example.com" } });
});

afterAll(async () => {
  await db?.drop();
});

describe("Resend's signature (Svix)", () => {
  const body = JSON.stringify(bounce("re_x", "a@example.com"));
  it("takes a fresh, signed delivery and nothing else", () => {
    const h = sign(body, NOON);
    expect(resendSignatureValid(SECRET, h, body, NOON)).toBe(true);
    // Svix may send several signatures (key rotation): one valid is enough.
    expect(resendSignatureValid(SECRET, { ...h, signature: `v1,AAAA ${h.signature}` }, body, NOON)).toBe(true);
    expect(resendSignatureValid(SECRET, h, body.replace("a@", "b@"), NOON)).toBe(false);
    expect(resendSignatureValid(SECRET, { ...h, signature: h.signature.replace("v1,", "v2,") }, body, NOON)).toBe(false);
    expect(resendSignatureValid(SECRET, sign(body, NOON, `whsec_${Buffer.from("another-test-only-key-9876543210").toString("base64")}`), body, NOON)).toBe(false);
    expect(resendSignatureValid(SECRET, h, body, new Date(NOON.getTime() + 6 * 60_000))).toBe(false); // replayed later
    expect(resendSignatureValid(SECRET, { ...h, id: undefined }, body, NOON)).toBe(false);
  });

  it("acts on permanent bounces, suppressions and complaints only", () => {
    expect(emailEventOf(bounce("re_1", "Marie <Marie@Example.com>"))).toEqual({ kind: "bounce", emailId: "re_1", to: ["marie@example.com"], detail: "General" });
    expect(emailEventOf(bounce("re_1", "marie@example.com", "Transient"))).toBeNull(); // a full mailbox may work tomorrow
    expect(emailEventOf({ type: "email.suppressed", data: { email_id: "re_2", to: ["x@example.com"] } })).toMatchObject({ kind: "bounce", detail: "Suppressed" });
    expect(emailEventOf(complaint("re_3", "y@example.com"))).toMatchObject({ kind: "complaint", to: ["y@example.com"] });
    expect(emailEventOf({ type: "email.delivered", data: { email_id: "re_4", to: ["z@example.com"] } })).toBeNull();
    expect(emailEventOf("nonsense")).toBeNull();
  });
});

describe("bounces and complaints", () => {
  let first = "";
  let second = "";
  let dead: string[] = [];

  it("the webhook exists once configured, and refuses forged or replayed deliveries", async () => {
    expect((await hook(bounce("re_1", "a@example.com"), { target: testApp(db.pool, { now: () => clock }) })).status).toBe(404);
    expect((await hook(bounce("re_1", "a@example.com"), { secret: `whsec_${Buffer.from("forged-test-only-key-000000000000").toString("base64")}` })).status).toBe(403);
    expect((await hook(bounce("re_1", "a@example.com"), { at: hours(-1) })).status).toBe(403);
    expect((await hook(null, { raw: "{not json" })).status).toBe(400);
    const ok = await hook({ type: "email.delivered", data: { email_id: "re_1", to: ["client000@example.com"] } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ received: true });
  });

  it("a hard bounce stops marketing to that address, in every Brand's file", async () => {
    ({ id: first } = await startCampaign("Été 1"));
    expect(await deliver(NOON)).toMatchObject({ sent: 100 }); // 100 per pass; 20 wait
    const sent = await sentMessages(first);
    dead = sent.slice(0, 6).map((m) => m.email);
    // The same address in the other Client's file (the sending address is shared).
    await db.pool.query(`INSERT INTO public.ticketing_customers (client_id, brand_id, first_name, email) VALUES ($1, $2, 'Autre', $3)`,
      [seed.festi.clientId, seed.festi.brandId, dead[0]]);
    const before = await audienceNow();
    expect((await hook(bounce(sent[0]!.provider_message_id, dead[0]!))).status).toBe(200);
    expect((await hook(bounce(sent[0]!.provider_message_id, dead[0]!))).status).toBe(200); // Resend retries: same result
    const { rows } = await db.pool.query(`SELECT brand_id FROM public.ticketing_customers WHERE email = $1 AND email_bounced_at IS NOT NULL ORDER BY brand_id`, [dead[0]]);
    expect(rows.map((r) => r.brand_id).sort()).toEqual([seed.festi.brandId, seed.havana.brandId].sort());
    const { rows: audit } = await db.pool.query(`SELECT actor_type FROM public.ticketing_audit_log WHERE action = 'customer.email_bounced'`);
    expect(audit).toEqual([{ actor_type: "system" }, { actor_type: "system" }]);
    expect(await audienceNow()).toBe(before - 1);
    expect(await campaign(first)).toMatchObject({ bounced: 1, heldAt: null });
    const { rows: c } = await db.pool.query(`SELECT id FROM public.ticketing_customers WHERE email = $1 AND brand_id = $2`, [dead[0], seed.havana.brandId]);
    const detail = (await call(app, "GET", `${base()}/customers/${c[0].id}`, { token: await owner() })).body.customer;
    expect(detail).toMatchObject({ emailPermission: "bounced" });
    expect(detail.emailBouncedAt).toBeTruthy();
    // A temporary bounce changes nothing.
    await hook(bounce(sent[1]!.provider_message_id, dead[1]!, "Transient"));
    expect(await campaign(first)).toMatchObject({ bounced: 1 });
  });

  it(`holds a campaign past ${HOLD_RULES.bounceRate * 100} % bounces, until staff resume it`, async () => {
    const sent = await sentMessages(first);
    for (const m of sent.slice(1, 4)) await hook(bounce(m.provider_message_id, m.email));
    expect(await campaign(first)).toMatchObject({ bounced: 4, heldAt: null }); // 4 of 100: not more than 4 %
    await hook(bounce(sent[4]!.provider_message_id, sent[4]!.email));
    const held = await campaign(first);
    expect(held).toMatchObject({ bounced: 5, heldReason: "bounces", status: "sending" });
    expect(held.heldAt).toBeTruthy();
    expect(await deliver(NOON)).toMatchObject({ sent: 0 }); // the 20 others wait
    const token = await owner();
    clock = hours(1);
    expect((await call(app, "POST", `${base()}/campaigns/${first}/resume`, { token })).body.campaign).toMatchObject({ heldAt: null, heldReason: null });
    expect((await call(app, "POST", `${base()}/campaigns/${first}/resume`, { token })).body.error.code).toBe("campaign_not_held");
    // A bounce on a message sent before the resume does not hold it again (6 of 100 would).
    await hook(bounce(sent[5]!.provider_message_id, sent[5]!.email));
    expect(await campaign(first)).toMatchObject({ bounced: 6, heldAt: null });
    expect(await deliver(hours(1))).toMatchObject({ sent: 20, finished: 1 });
    const { rows } = await db.pool.query(`SELECT action, data FROM public.ticketing_audit_log WHERE action IN ('campaign.held', 'campaign.resumed') ORDER BY created_at`);
    expect(rows.map((r) => r.action)).toEqual(["campaign.held", "campaign.resumed"]);
    expect(rows[0].data).toMatchObject({ reason: "bounces", sent: 100, bounced: 5 });
  });

  it("skips a waiting message to an address that bounced since, and keeps to the hourly pace", async () => {
    clock = hours(2);
    let recipients = 0;
    ({ id: second, recipients } = await startCampaign("Été 2"));
    expect(recipients).toBe(114); // 120 less the 6 that bounced
    // An address that bounces now (reported on a message of the first campaign).
    const late = (await sentMessages(first)).find((m) => !dead.includes(m.email))!;
    await hook(bounce(late.provider_message_id, late.email));
    expect(await deliver(hours(2), 50)).toMatchObject({ paced: true });
    const { rows: n } = await db.pool.query(`SELECT count(*)::int AS n FROM public.ticketing_campaign_messages WHERE campaign_id = $1 AND status = 'sent'`, [second]);
    expect(n[0].n).toBe(50);
    // A test still goes out when the hour's campaign budget is spent.
    await call(app, "POST", `${base()}/campaigns/${second}/test`, { token: await owner(), body: { email: "equipe@example.com" } });
    expect(await deliver(hours(2), 50)).toMatchObject({ sent: 1, paced: true });
    expect(outbox.sent.at(-1)!.to).toBe("equipe@example.com");
    // Three spam complaints hold it too, and unsubscribe those who complained.
    const sent = await sentMessages(second);
    for (const m of sent.slice(0, 3)) await hook(complaint(m.provider_message_id, m.email));
    expect(await campaign(second)).toMatchObject({ complained: 3, heldReason: "complaints" });
    const { rows: out } = await db.pool.query(`SELECT count(*)::int AS n FROM public.ticketing_customers WHERE email = ANY($1) AND email_opt_out_at IS NOT NULL`, [sent.slice(0, 3).map((m) => m.email)]);
    expect(out[0].n).toBe(3);
    clock = hours(3);
    await call(app, "POST", `${base()}/campaigns/${second}/resume`, { token: await owner() });
    await deliver(hours(3));
    const { rows } = await db.pool.query(`SELECT status, last_error FROM public.ticketing_campaign_messages WHERE campaign_id = $1 AND email = $2`, [second, late.email]);
    expect(rows).toEqual([{ status: "skipped", last_error: "bounced" }]);
    expect(await campaign(second)).toMatchObject({ status: "sent", sent: 113, skipped: 1 });
  });

  it("a ticket e-mail the address refused shows in « À traiter »", async () => {
    const t = seed.havana;
    const { rows: s } = await db.pool.query<{ id: string }>(
      `INSERT INTO public.ticketing_sessions (client_id, brand_id, event_id, starts_at, capacity, status) VALUES ($1, $2, $3, now() + interval '5 days', 50, 'on_sale') RETURNING id`,
      [t.clientId, t.brandId, t.eventId],
    );
    const order = await seedPaidOrder(db.pool, { ...t, sessionId: s[0]!.id }, "billets-perdus@example.com");
    await db.pool.query(`UPDATE public.ticketing_email_outbox SET status = 'sent', sent_at = now(), provider_message_id = 're_ticket_1' WHERE order_id = $1`, [order.orderId]);
    await hook({ type: "email.suppressed", data: { email_id: "re_ticket_1", to: ["billets-perdus@example.com"] } });
    const todo = (await call(app, "GET", `${base()}/attention`, { token: await owner() })).body.attention;
    const item = todo.emails.find((e: { orderId: string }) => e.orderId === order.orderId);
    expect(item).toMatchObject({ status: "sent", lastError: "bounced: Suppressed", buyerEmail: "billets-perdus@example.com" });
    expect(item.bouncedAt).toBeTruthy();
  });

  it("a new address is a new chance", async () => {
    await db.pool.query(`UPDATE public.ticketing_customers SET email = 'nouvelle-adresse@example.com' WHERE email = $1 AND brand_id = $2`, [dead[0], seed.havana.brandId]);
    const { rows } = await db.pool.query(`SELECT email_bounced_at FROM public.ticketing_customers WHERE email = 'nouvelle-adresse@example.com'`);
    expect(rows).toEqual([{ email_bounced_at: null }]);
  });
});
