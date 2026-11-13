import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateCart, type TicketTypeRule } from "../../src/domain/catalog.js";
import { adm, call, pub, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { completedSession, FakeGateway, signedStripeEvent } from "../helpers/fake-gateway.js";
import { seedTwoTenants, type SeedResult, type TenantFixture } from "../helpers/seed.js";

/**
 * Run 110: a limit per buyer ("2 bons par personne"), as Groupon, Tuango and PromoRabais set on
 * their offers. It counts all the buyer's orders for the ticket (same e-mail): paid, and still
 * being paid. Made-up buyers only.
 */
let db: TestDatabase;
let seed: SeedResult;
let app: TestApp;
let t: TenantFixture;
let typeId = "";

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  t = seed.havana;
  app = testApp(db.pool, { paymentGateway: new FakeGateway() });
  const created = await call(app, "POST", `${adm(t.clientId, t.brandId)}/events/${t.eventId}/ticket-types`, {
    token: await tokenFor(seed.users.havanaOwner),
    body: { code: "OFFRE_DUO", name: "Offre duo", priceCents: 2000, maxQuantity: 6, countsAsAdult: true, limitPerBuyer: 2 },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect(created.body.ticketType.limitPerBuyer).toBe(2);
  typeId = created.body.ticketType.id;
});
afterAll(async () => { await db?.drop(); });

const hold = (quantity: number) =>
  call(app, "POST", `${pub(t.clientId, t.brandId)}/holds`, { body: { sessionId: t.sessionId, items: [{ ticketTypeId: typeId, quantity }] } });
const checkout = (h: { id: string; token: string }, email: string) =>
  call(app, "POST", `${pub(t.clientId, t.brandId)}/holds/${h.id}/checkout`, {
    headers: { "x-alkao-hold-token": h.token },
    body: { buyer: { email }, successUrl: `${t.returnOrigin}/ok`, cancelUrl: `${t.returnOrigin}/ko` },
  });
async function paid(email: string, quantity: number) {
  const h = (await hold(quantity)).body.hold;
  const co = await checkout(h, email);
  expect(co.status, JSON.stringify(co.body)).toBe(201);
  const e = signedStripeEvent("checkout.session.completed", completedSession(co.body.checkoutUrl.split("/").pop(), h.quote.totalCents, `pi_${randomUUID().slice(0, 8)}`), t.stripeAccountId);
  expect((await call(app, "POST", "/v1/webhooks/stripe", { body: e.body, headers: { "stripe-signature": e.signature } })).body.outcome).toBe("processed");
}

describe("Run 110: a limit per buyer", () => {
  it("refuses a cart past the limit before anyone types an e-mail", () => {
    const type: TicketTypeRule = {
      id: "a", code: "DUO", name: "Duo", kind: "admission", priceCents: 2000, minQuantity: 0, maxQuantity: 6,
      maxAdultsInOrder: null, countsAsAdult: true, addOnScope: null, active: true, limitPerBuyer: 2,
    };
    const r = validateCart([type], [{ ticketTypeId: "a", quantity: 3 }]);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.violations).toEqual([expect.objectContaining({ code: "above_limit_per_buyer", limit: 2, actual: 3 })]);
    expect(validateCart([type], [{ ticketTypeId: "a", quantity: 2 }]).ok).toBe(true);
  });

  it("counts the buyer's other orders, by e-mail in any case, and never says how many", async () => {
    const email = `duo-${randomUUID().slice(0, 6)}@example.com`;
    await paid(email, 1);
    // One more is fine; a second after that is not, whatever the letter case.
    await paid(email.toUpperCase(), 1);
    const h = (await hold(1)).body.hold;
    const refused = await checkout(h, email);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("limit_per_buyer");
    // Anyone can type an e-mail here: the answer never says what that address bought.
    expect(JSON.stringify(refused.body)).not.toMatch(/already|bought|"limit"/);
    // Another buyer is not affected.
    expect((await checkout(h, `autre-${randomUUID().slice(0, 6)}@example.com`)).status).toBe(201);
  });

  it("counts an order still being paid, and frees it once its hold lapses", async () => {
    const email = `attente-${randomUUID().slice(0, 6)}@example.com`;
    const first = (await hold(2)).body.hold;
    expect((await checkout(first, email)).status).toBe(201);
    const second = (await hold(1)).body.hold;
    expect((await checkout(second, email)).body.error?.code).toBe("limit_per_buyer");
    // The first checkout was abandoned: its hold lapsed, so it no longer counts.
    await db.pool.query(`UPDATE public.ticketing_holds SET status = 'expired' WHERE id = $1`, [first.id]);
    const third = (await hold(1)).body.hold;
    expect((await checkout(third, email)).status).toBe(201);
  });

  it("is set and changed by staff, within 1 to 1000", async () => {
    const owner = await tokenFor(seed.users.havanaOwner);
    const path = `${adm(t.clientId, t.brandId)}/ticket-types/${typeId}`;
    expect((await call(app, "PATCH", path, { token: owner, body: { limitPerBuyer: 0 } })).status).toBe(400);
    const changed = await call(app, "PATCH", path, { token: owner, body: { limitPerBuyer: 4 } });
    expect(changed.status).toBe(200);
    expect(changed.body.ticketType.limitPerBuyer).toBe(4);
    const shop = await call(app, "GET", `${pub(t.clientId, t.brandId)}/events/${t.eventId}`);
    expect(shop.body.ticketTypes.find((x: { id: string }) => x.id === typeId).limitPerBuyer).toBe(4);
  });
});
