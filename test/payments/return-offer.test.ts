import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EmailMessage, EmailSender } from "../../src/delivery/email.js";
import { deliverTicketEmails } from "../../src/delivery/worker.js";
import { adm, call, pub, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { seedTwoTenants, TEST_CREDENTIAL_SECRET, type SeedResult, type TenantFixture } from "../helpers/seed.js";

/**
 * Run 105: the return offer. An event's buyers see a coupon for the organizer's next event on
 * their tickets page and in their tickets e-mail, while that coupon can be used. Made-up
 * events and buyers only.
 */
const PUBLIC_URL = "https://billets.alkao.test";
let db: TestDatabase;
let seed: SeedResult;
let app: TestApp;
let t: TenantFixture;
let nextEventId = "";
let nextSessionId = "";
let promoId = "";

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  t = seed.havana;
  app = testApp(db.pool, { credentialMasterSecret: TEST_CREDENTIAL_SECRET, publicUrl: PUBLIC_URL });
  // The organizer's next event, published with a date on sale.
  const { rows } = await db.pool.query<{ id: string }>(
    `INSERT INTO public.ticketing_events (client_id, brand_id, venue_id, slug, title, status)
     SELECT client_id, brand_id, venue_id, 'festival-hiver-test', 'Festival d''hiver', 'published' FROM public.ticketing_events WHERE id = $1 RETURNING id`,
    [t.eventId],
  );
  nextEventId = rows[0]!.id;
  const s = await db.pool.query<{ id: string }>(
    `INSERT INTO public.ticketing_sessions (client_id, brand_id, event_id, starts_at, capacity, status)
     VALUES ($1, $2, $3, now() + interval '60 days', 500, 'on_sale') RETURNING id`,
    [t.clientId, t.brandId, nextEventId],
  );
  nextSessionId = s.rows[0]!.id;
});
afterAll(async () => {
  await db?.drop();
});

const owner = () => tokenFor(seed.users.havanaOwner);
const base = () => adm(t.clientId, t.brandId);
const offerOf = async () => (await call(app, "GET", `${base()}/events/${t.eventId}/return-offer`, { token: await owner() })).body.returnOffer;
const setOffer = async (promoCodeId: string | null) =>
  call(app, "PUT", `${base()}/events/${t.eventId}/return-offer`, { token: await owner(), body: { promoCodeId } });
async function buyFree() {
  const toddler = t.types.find((x) => x.code === "TODDLER")!;
  const h = await call(app, "POST", `${pub(t.clientId, t.brandId)}/holds`, { body: { sessionId: t.sessionId, items: [{ ticketTypeId: toddler.id, quantity: 1 }] } });
  expect(h.status, JSON.stringify(h.body)).toBe(201);
  const co = await call(app, "POST", `${pub(t.clientId, t.brandId)}/holds/${h.body.hold.id}/checkout`, {
    headers: { "x-alkao-hold-token": h.body.hold.token },
    body: { buyer: { email: "retour@example.com" }, successUrl: `${t.returnOrigin}/ok`, cancelUrl: `${t.returnOrigin}/ko` },
  });
  expect(co.body.order.status).toBe("paid");
  return { id: co.body.order.id as string, token: co.body.order.token as string };
}
const publicOrder = async (o: { id: string; token: string }) =>
  (await call(app, "GET", `${pub(t.clientId, t.brandId)}/orders/${o.id}`, { headers: { "x-alkao-order-token": o.token } })).body.order;

describe("the return offer", () => {
  it("is chosen among the Brand's codes, never a partner company's", async () => {
    const made = await call(app, "POST", `${base()}/events/${nextEventId}/promo-codes`, {
      token: await owner(), body: { code: "RETOUR15", kind: "percent", percent: 15, endsAt: new Date(Date.now() + 45 * 86_400_000).toISOString() },
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    promoId = made.body.promoCode.id;
    const before = await offerOf();
    expect(before).toMatchObject({ promoCodeId: null, live: null });
    expect(before.choices).toEqual([expect.objectContaining({ id: promoId, code: "RETOUR15", eventTitle: "Festival d'hiver" })]);

    await call(app, "POST", `${base()}/events/${nextEventId}/partner-codes`, { token: await owner(), body: { partner: "Club partenaire", count: 2, kind: "percent", percent: 20 } });
    const { rows } = await db.pool.query(`SELECT id FROM public.ticketing_promo_codes WHERE partner = 'Club partenaire' LIMIT 1`);
    expect((await setOffer(rows[0].id)).body.error.code).toBe("partner_code_private");
    expect((await offerOf()).choices.some((p: { code: string }) => p.code.startsWith("CLUBPART"))).toBe(false);
    // Another organizer's code does not exist here.
    const { rows: other } = await db.pool.query(`INSERT INTO public.ticketing_promo_codes (client_id, brand_id, event_id, code, kind, percent)
      VALUES ($1, $2, $3, 'AILLEURS', 'percent', 10) RETURNING id`, [seed.festi.clientId, seed.festi.brandId, seed.festi.eventId]);
    expect((await setOffer(other[0].id)).status).toBe(404);

    const set = await setOffer(promoId);
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.returnOffer.live).toMatchObject({ code: "RETOUR15", eventId: nextEventId, eventTitle: "Festival d'hiver", percent: 15 });
  });

  it("shows on the buyer's tickets page and in the tickets e-mail, with a link that applies the code", async () => {
    const order = await buyFree();
    expect((await publicOrder(order)).returnOffer).toMatchObject({ code: "RETOUR15", eventId: nextEventId, eventTitle: "Festival d'hiver", kind: "percent", percent: 15 });

    const sent: EmailMessage[] = [];
    const sender: EmailSender = { send: async (m: EmailMessage) => { sent.push(m); return `msg_${sent.length}`; } };
    await deliverTicketEmails(db.pool, { sender, publicUrl: PUBLIC_URL, credentialMasterSecret: TEST_CREDENTIAL_SECRET }, new Date(Date.now() + 1000));
    const mail = sent.find((m) => m.to === "retour@example.com")!;
    expect(mail.text).toContain("Votre prochaine sortie");
    expect(mail.text).toContain("Merci ! −15 % sur Festival d'hiver avec le code RETOUR15.");
    expect(mail.text).toContain(`${PUBLIC_URL}/acheter/${t.clientId}/${t.brandId}/${nextEventId}?coupon=RETOUR15`);
    expect(mail.html).toContain("Voir l&#39;événement");
  });

  it("goes away while the code cannot be used, or its event has no date on sale", async () => {
    const order = await buyFree();
    await call(app, "PATCH", `${base()}/promo-codes/${promoId}`, { token: await owner(), body: { active: false } });
    expect((await publicOrder(order)).returnOffer).toBeUndefined();
    expect((await offerOf())).toMatchObject({ promoCodeId: promoId, live: null });

    await call(app, "PATCH", `${base()}/promo-codes/${promoId}`, { token: await owner(), body: { active: true } });
    await db.pool.query(`UPDATE public.ticketing_sessions SET status = 'closed' WHERE id = $1`, [nextSessionId]);
    expect((await publicOrder(order)).returnOffer).toBeUndefined();
    await db.pool.query(`UPDATE public.ticketing_sessions SET status = 'on_sale' WHERE id = $1`, [nextSessionId]);
    expect((await publicOrder(order)).returnOffer).toMatchObject({ code: "RETOUR15" });

    expect((await setOffer(null)).body.returnOffer).toEqual({ promoCodeId: null, live: null });
    expect((await publicOrder(order)).returnOffer).toBeUndefined();
  });
});
