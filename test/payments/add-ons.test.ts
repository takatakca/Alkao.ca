import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { expireStaleHolds } from "../../src/db/commerce.js";
import { withTransaction } from "../../src/db/pool.js";
import { validateCart, type TicketTypeRule } from "../../src/domain/catalog.js";
import { adm, call, pub, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { completedSession, FakeGateway, signedStripeEvent } from "../helpers/fake-gateway.js";
import { seedTwoTenants, type SeedResult, type TenantFixture } from "../helpers/seed.js";

/**
 * Run 49: add-ons with a quantity rule and a stock per session, and the ad an order came
 * from. Made-up buyers only.
 */
let db: TestDatabase;
let seed: SeedResult;
let gateway: FakeGateway;
let app: TestApp;
let t: TenantFixture;
let sessionId = "";
const ids: Record<string, string> = {};

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  t = seed.havana;
  const { rows } = await db.pool.query<{ id: string }>(
    `INSERT INTO public.ticketing_sessions (client_id, brand_id, event_id, starts_at, capacity, status)
     VALUES ($1, $2, $3, now() + interval '20 days', 50, 'on_sale') RETURNING id`,
    [t.clientId, t.brandId, t.eventId],
  );
  sessionId = rows[0]!.id;
});

beforeEach(() => {
  gateway = new FakeGateway();
  app = testApp(db.pool, { paymentGateway: gateway });
});

afterAll(async () => {
  await db?.drop();
});

const owner = () => tokenFor(seed.users.havanaOwner);
const typeId = (code: string) => ids[code] ?? t.types.find((x) => x.code === code)!.id;
const items = (cart: Record<string, number>) => Object.entries(cart).map(([code, quantity]) => ({ ticketTypeId: typeId(code), quantity }));
const hold = (cart: Record<string, number>) => call(app, "POST", `${pub(t.clientId, t.brandId)}/holds`, { body: { sessionId, items: items(cart) } });
const left = async (code: string, a: TestApp = app) => {
  const res = await call(a, "GET", `${pub(t.clientId, t.brandId)}/events/${t.eventId}`);
  return res.body.sessions.find((s: { id: string }) => s.id === sessionId).addOnsAvailable[typeId(code)] as number | undefined;
};
const stock = async (code: string) =>
  (await db.pool.query(`SELECT reserved_count, sold_count FROM public.ticketing_add_on_stock WHERE session_id = $1 AND ticket_type_id = $2`, [sessionId, typeId(code)])).rows[0];

async function pay(h: { id: string; token: string; quote: { totalCents: number } }, attribution?: unknown) {
  const co = await call(app, "POST", `${pub(t.clientId, t.brandId)}/holds/${h.id}/checkout`, {
    headers: { "x-alkao-hold-token": h.token },
    body: { buyer: { email: "lea@example.com" }, successUrl: `${t.returnOrigin}/ok`, cancelUrl: `${t.returnOrigin}/ko`, ...(attribution ? { attribution } : {}) },
  });
  expect(co.status, JSON.stringify(co.body)).toBe(201);
  const e = signedStripeEvent("checkout.session.completed", completedSession(co.body.checkoutUrl.split("/").pop(), h.quote.totalCents, `pi_${randomUUID().slice(0, 8)}`), t.stripeAccountId);
  expect((await call(app, "POST", "/v1/webhooks/stripe", { body: e.body, headers: { "stripe-signature": e.signature } })).body.outcome).toBe("processed");
  return co.body.order as { id: string; token: string };
}

describe("add-on quantity rules", () => {
  const rule = (addOnScope: TicketTypeRule["addOnScope"]): TicketTypeRule => ({
    id: addOnScope!, code: addOnScope!.toUpperCase(), name: addOnScope!, kind: "add_on", priceCents: 500, minQuantity: 0, maxQuantity: 10,
    maxAdultsInOrder: null, countsAsAdult: false, addOnScope, active: true,
  });
  const adult: TicketTypeRule = { ...rule("per_admission"), id: "adult", code: "ADULT", kind: "admission", addOnScope: null, countsAsAdult: true };
  const types = [adult, rule("per_admission"), rule("up_to_admissions"), rule("per_order")];
  const check = (cart: Record<string, number>) => validateCart(types, Object.entries(cart).map(([ticketTypeId, quantity]) => ({ ticketTypeId, quantity })));

  it("one each, up to one each, or any quantity, always with an admission", () => {
    expect(check({ adult: 3, per_admission: 3 }).ok).toBe(true);
    expect(check({ adult: 3, per_admission: 2 })).toMatchObject({ ok: false, violations: [{ code: "add_on_quantity_mismatch", limit: 3 }] });
    expect(check({ adult: 3, up_to_admissions: 2 }).ok).toBe(true);
    expect(check({ adult: 3, up_to_admissions: 4 })).toMatchObject({ ok: false, violations: [{ code: "add_on_quantity_mismatch", limit: 3, actual: 4 }] });
    expect(check({ adult: 1, per_order: 7 }).ok).toBe(true);
    expect(check({ per_order: 1 })).toMatchObject({ ok: false, violations: [{ code: "add_on_without_admission" }] });
  });
});

describe("add-ons with a stock per session", () => {
  it("are created by staff, hidden until put on sale, and only add-ons have a stock", async () => {
    const token = await owner();
    const make = async (body: Record<string, unknown>) => {
      const res = await call(app, "POST", `${adm(t.clientId, t.brandId)}/events/${t.eventId}/ticket-types`, { token, body });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      ids[body.code as string] = res.body.ticketType.id;
      return res.body.ticketType;
    };
    expect(await make({ code: "MEAL", name: "Repas cantine", kind: "add_on", addOnScope: "up_to_admissions", priceCents: 1500, maxQuantity: 20, stockPerSession: 3, active: false }))
      .toMatchObject({ addOnScope: "up_to_admissions", stockPerSession: 3, active: false });
    await make({ code: "GLOW", name: "Bâton lumineux", kind: "add_on", addOnScope: "per_order", priceCents: 500, maxQuantity: 10 });
    const bad = await call(app, "POST", `${adm(t.clientId, t.brandId)}/events/${t.eventId}/ticket-types`, {
      token, body: { code: "BAD", name: "Entrée", priceCents: 100, maxQuantity: 5, stockPerSession: 10 },
    });
    expect(bad.status).toBe(400);
    const general = t.types.find((x) => x.code === "GENERAL")!.id;
    expect((await call(app, "PATCH", `${adm(t.clientId, t.brandId)}/ticket-types/${general}`, { token, body: { stockPerSession: 10 } })).body.error.code).toBe("stock_only_for_add_ons");

    // The owner confirms the price, then puts it on sale.
    const pub0 = await call(app, "GET", `${pub(t.clientId, t.brandId)}/events/${t.eventId}`);
    expect(pub0.body.ticketTypes.map((x: { code: string }) => x.code)).not.toContain("MEAL");
    await call(app, "PATCH", `${adm(t.clientId, t.brandId)}/ticket-types/${ids.MEAL}`, { token, body: { active: true } });
    expect(await left("MEAL")).toBe(3);
    expect(await left("GLOW")).toBeUndefined(); // no stock: no limit shown
  });

  it("a cart reserves them, and cannot take more than is left", async () => {
    const first = await hold({ GENERAL: 2, MEAL: 2 });
    expect(first.status).toBe(201);
    expect(await left("MEAL")).toBe(1);
    expect(await stock("MEAL")).toEqual({ reserved_count: 2, sold_count: 0 });
    const second = await hold({ GENERAL: 2, MEAL: 2 });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("add_on_sold_out");
    expect((await hold({ GENERAL: 2, MEAL: 3 })).body.error.details).toEqual([expect.objectContaining({ code: "add_on_quantity_mismatch", limit: 2, actual: 3 })]);
    expect((await hold({ GENERAL: 1, GLOW: 7 })).status).toBe(201);

    // The carts are abandoned: once past their deadline the meals show as free again, and
    // expiring the holds gives them back.
    const later = new Date(Date.now() + 2 * 3600_000);
    expect(await left("MEAL", testApp(db.pool, { now: () => later }))).toBe(3);
    await withTransaction(db.pool, (tx) => expireStaleHolds(tx, later, sessionId));
    expect(await stock("MEAL")).toEqual({ reserved_count: 0, sold_count: 0 });
  });

  it("a paid order keeps them; a full refund puts them back", async () => {
    const h = await hold({ GENERAL: 2, MEAL: 2 });
    const order = await pay(h.body.hold);
    expect(await stock("MEAL")).toEqual({ reserved_count: 0, sold_count: 2 });
    expect(await left("MEAL")).toBe(1);
    const refund = await call(app, "POST", `${adm(t.clientId, t.brandId)}/orders/${order.id}/refunds`, { token: await owner(), body: {} });
    expect(refund.body.refund.status).toBe("succeeded");
    expect(await stock("MEAL")).toEqual({ reserved_count: 0, sold_count: 0 });
    expect(await left("MEAL")).toBe(3);
  });

  it("a stock set on an add-on already on sale starts from what is already sold", async () => {
    // Release the earlier GLOW cart, then sell four.
    await db.pool.query(`UPDATE public.ticketing_holds SET status = 'released' WHERE session_id = $1 AND status = 'active'`, [sessionId]);
    const h = await hold({ GENERAL: 1, GLOW: 4 });
    await pay(h.body.hold);
    const res = await call(app, "PATCH", `${adm(t.clientId, t.brandId)}/ticket-types/${ids.GLOW}`, { token: await owner(), body: { stockPerSession: 5 } });
    expect(res.body.ticketType.stockPerSession).toBe(5);
    expect(await stock("GLOW")).toEqual({ reserved_count: 0, sold_count: 4 });
    expect(await left("GLOW")).toBe(1);
    expect((await hold({ GENERAL: 1, GLOW: 2 })).body.error.code).toBe("add_on_sold_out");
  });
});

describe("add-ons follow a session change (Run 56)", () => {
  const stockAt = async (session: string, code: string) =>
    (await db.pool.query(`SELECT reserved_count, sold_count FROM public.ticketing_add_on_stock WHERE session_id = $1 AND ticket_type_id = $2`, [session, typeId(code)])).rows[0]
    ?? { reserved_count: 0, sold_count: 0 };
  const evening = async () => {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO public.ticketing_sessions (client_id, brand_id, event_id, starts_at, capacity, status)
       VALUES ($1, $2, $3, now() + interval '21 days' + (random() * interval '1 hour'), 50, 'on_sale') RETURNING id`,
      [t.clientId, t.brandId, t.eventId],
    );
    return rows[0]!.id;
  };
  const move = (order: { id: string; token: string }, to: string) =>
    call(app, "POST", `${pub(t.clientId, t.brandId)}/orders/${order.id}/exchange`, { headers: { "x-alkao-order-token": order.token }, body: { sessionId: to } });

  it("move their stock to the new session; a full refund releases them there", async () => {
    await db.pool.query(`UPDATE public.ticketing_holds SET status = 'released' WHERE status = 'active' AND client_id = $1`, [t.clientId]);
    const before = await stockAt(sessionId, "MEAL");
    const order = await pay((await hold({ GENERAL: 2, MEAL: 2, FLEX_WEATHER: 2 })).body.hold);
    expect((await stockAt(sessionId, "MEAL")).sold_count).toBe(before.sold_count + 2);

    const saturday = await evening();
    expect((await move(order, saturday)).status).toBe(201);
    expect(await stockAt(sessionId, "MEAL")).toEqual(before);
    expect(await stockAt(saturday, "MEAL")).toEqual({ reserved_count: 0, sold_count: 2 });
    // An add-on without a stock (Flex Météo) moves nothing.
    expect((await db.pool.query(`SELECT 1 FROM public.ticketing_add_on_stock WHERE ticket_type_id = $1`, [typeId("FLEX_WEATHER")])).rowCount).toBe(0);

    const refund = await call(app, "POST", `${adm(t.clientId, t.brandId)}/orders/${order.id}/refunds`, { token: await owner(), body: {} });
    expect(refund.body.refund.status, JSON.stringify(refund.body)).toBe("succeeded");
    expect(await stockAt(saturday, "MEAL")).toEqual({ reserved_count: 0, sold_count: 0 });
    expect(await stockAt(sessionId, "MEAL")).toEqual(before);
  });

  it("refuse a change to a session where they are sold out, and move nothing", async () => {
    const before = await stockAt(sessionId, "MEAL");
    const order = await pay((await hold({ GENERAL: 2, MEAL: 2, FLEX_WEATHER: 2 })).body.hold);
    const full = await evening();
    const other = await call(app, "POST", `${pub(t.clientId, t.brandId)}/holds`, { body: { sessionId: full, items: items({ GENERAL: 2, MEAL: 2 }) } });
    expect(other.status).toBe(201); // 2 of the 3 meals held by another family

    const refused = await move(order, full);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("add_on_sold_out");
    expect(await stockAt(full, "MEAL")).toEqual({ reserved_count: 2, sold_count: 0 });
    expect((await stockAt(sessionId, "MEAL")).sold_count).toBe(before.sold_count + 2);
    const mine = await call(app, "GET", `${pub(t.clientId, t.brandId)}/orders/${order.id}`, { headers: { "x-alkao-order-token": order.token } });
    expect(mine.body.order).toMatchObject({ exchanged: false, canChangeSession: true });
    expect(mine.body.order.tickets.every((k: { status: string }) => k.status === "valid")).toBe(true);
  });
});

describe("where an order came from", () => {
  it("keeps the ad's UTM tags (and nothing else), shows them to staff and in the campaign report", async () => {
    await db.pool.query(`UPDATE public.ticketing_holds SET status = 'released' WHERE session_id = $1 AND status = 'active'`, [sessionId]);
    const tags = { source: "facebook", medium: "paid_social", campaign: "halloween-2026", content: "video-train", landing: "/c/halloween", fbclid: "xyz" };
    const h1 = await hold({ GENERAL: 2, MEAL: 1 });
    const order = await pay(h1.body.hold, tags);
    const { rows } = await db.pool.query(`SELECT attribution FROM public.ticketing_orders WHERE id = $1`, [order.id]);
    expect(rows[0].attribution).toEqual({ source: "facebook", medium: "paid_social", campaign: "halloween-2026", content: "video-train", landing: "/c/halloween" });

    const token = await owner();
    const detail = await call(app, "GET", `${adm(t.clientId, t.brandId)}/orders/${order.id}`, { token });
    expect(detail.body.order.attribution).toMatchObject({ campaign: "halloween-2026" });
    const mine = await call(app, "GET", `${pub(t.clientId, t.brandId)}/orders/${order.id}`, { headers: { "x-alkao-order-token": order.token } });
    expect(mine.body.order.attribution).toBeUndefined();

    const report = await call(app, "GET", `${adm(t.clientId, t.brandId)}/reports/campaigns`, { token });
    const row = report.body.report.rows.find((r: { campaign: string }) => r.campaign === "halloween-2026");
    expect(row).toMatchObject({ source: "facebook", medium: "paid_social", orders: 1, admissions: 2, addOnCents: 1500 });
    expect(report.body.report.rows.some((r: { source: string }) => r.source === "")).toBe(true); // the orders without tags

    const csv = await app.request(`${adm(t.clientId, t.brandId)}/reports/orders.csv`, { headers: { authorization: `Bearer ${token}` } });
    const text = await csv.text();
    expect(text.split("\n")[0]).toContain("utm_source,utm_medium,utm_campaign,utm_content,landing");
    expect(text).toContain("facebook,paid_social,halloween-2026,video-train,/c/halloween");

    // Tags that could carry markup are refused, not stored.
    const h2 = await hold({ GENERAL: 1 });
    const bad = await call(app, "POST", `${pub(t.clientId, t.brandId)}/holds/${h2.body.hold.id}/checkout`, {
      headers: { "x-alkao-hold-token": h2.body.hold.token },
      body: { buyer: { email: "lea@example.com" }, successUrl: `${t.returnOrigin}/ok`, cancelUrl: `${t.returnOrigin}/ko`, attribution: { source: "<script>" } },
    });
    expect(bad.status).toBe(400);
  });
});

describe("the Brand's website calls the public API from the buyer's browser", () => {
  it("gets CORS only from the origins the Brand lists for checkout returns", async () => {
    const url = `${pub(t.clientId, t.brandId)}/events`;
    const pre = await app.request(url, { method: "OPTIONS", headers: { origin: t.returnOrigin, "access-control-request-method": "POST" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe(t.returnOrigin);
    expect(pre.headers.get("access-control-allow-headers")).toContain("x-alkao-hold-token");
    const other = await app.request(url, { method: "OPTIONS", headers: { origin: seed.festi.returnOrigin } });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
    const get = await app.request(url, { headers: { origin: t.returnOrigin } });
    expect(get.status).toBe(200);
    expect(get.headers.get("access-control-allow-origin")).toBe(t.returnOrigin);
    expect((await app.request(url, { headers: { origin: "https://ailleurs.example" } })).headers.get("access-control-allow-origin")).toBeNull();
  });
});
