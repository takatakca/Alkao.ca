import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adm, call, pub, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { completedSession, FakeGateway, signedStripeEvent } from "../helpers/fake-gateway.js";
import { seedTwoTenants, type SeedResult, type TenantFixture } from "../helpers/seed.js";

/**
 * Run 103: codes for partner companies. A sponsor, an employer or a shop gets its own batch of
 * unique codes to hand out; each code has its own use limit and its own shop link, and the
 * dashboard counts the company's sales on one line. Made-up companies and buyers only.
 */
const PUBLIC_URL = "https://billets.alkao.test";
const PARTNER = "Caisse Desjardins de Valleyfield";
let db: TestDatabase;
let seed: SeedResult;
let gateway: FakeGateway;
let app: TestApp;
let t: TenantFixture;

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  t = seed.havana;
});
beforeEach(() => {
  gateway = new FakeGateway();
  app = testApp(db.pool, { paymentGateway: gateway, publicUrl: PUBLIC_URL });
});
afterAll(async () => {
  await db?.drop();
});

const owner = () => tokenFor(seed.users.havanaOwner);
const general = () => t.types.find((x) => x.code === "GENERAL")!;
const base = () => adm(t.clientId, t.brandId);
const make = async (body: Record<string, unknown>, token?: string) =>
  call(app, "POST", `${base()}/events/${t.eventId}/partner-codes`, { token: token ?? (await owner()), body });
const codesOf = async (partner: string) =>
  (await db.pool.query<{ code: string; public: boolean; max_uses: number; used_count: number; active: boolean }>(
    `SELECT code, public, max_uses, used_count, active FROM public.ticketing_promo_codes WHERE partner = $1 ORDER BY code`, [partner],
  )).rows;
const hold = (promoCode: string) =>
  call(app, "POST", `${pub(t.clientId, t.brandId)}/holds`, { body: { sessionId: t.sessionId, items: [{ ticketTypeId: general().id, quantity: 2 }], promoCode } });
async function pay(h: { id: string; token: string; quote: { totalCents: number } }) {
  const co = await call(app, "POST", `${pub(t.clientId, t.brandId)}/holds/${h.id}/checkout`, {
    headers: { "x-alkao-hold-token": h.token },
    body: { buyer: { email: `employe-${randomUUID().slice(0, 6)}@example.com` }, successUrl: `${t.returnOrigin}/ok`, cancelUrl: `${t.returnOrigin}/ko` },
  });
  expect(co.status, JSON.stringify(co.body)).toBe(201);
  const e = signedStripeEvent("checkout.session.completed", completedSession(co.body.checkoutUrl.split("/").pop(), h.quote.totalCents, `pi_${randomUUID().slice(0, 8)}`), t.stripeAccountId);
  expect((await call(app, "POST", "/v1/webhooks/stripe", { body: e.body, headers: { "stripe-signature": e.signature } })).body.outcome).toBe("processed");
}

describe("codes for partner companies", () => {
  it("makes a batch of unique, private codes, easy to read out, in one go", async () => {
    const r = await make({ partner: PARTNER, count: 50, usesEach: 1, kind: "percent", percent: 15, excludesPresales: true });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toEqual({ partner: PARTNER, count: 50 });
    const codes = await codesOf(PARTNER);
    expect(codes).toHaveLength(50);
    expect(new Set(codes.map((c) => c.code)).size).toBe(50);
    // The company's name as a prefix, then six characters with no 0/O or 1/I/L to misread.
    for (const c of codes) expect(c.code).toMatch(/^CAISSEDE-[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{6}$/);
    expect(codes.every((c) => !c.public && c.max_uses === 1 && c.active)).toBe(true);
    // One audit row for the batch, not fifty.
    const audit = await db.pool.query(`SELECT data FROM public.ticketing_audit_log WHERE action = 'promo_code.partner_batch_created'`);
    expect(audit.rows).toEqual([{ data: expect.objectContaining({ partner: PARTNER, count: 50 }) }]);
  });

  it("are listed as one line per company, never mixed with the event's own codes or shown as coupons", async () => {
    const own = (await call(app, "GET", `${base()}/events/${t.eventId}/promo-codes`, { token: await owner() })).body.promoCodes;
    expect(own.some((p: { partner: string | null }) => p.partner)).toBe(false);
    const partners = (await call(app, "GET", `${base()}/events/${t.eventId}/partner-codes`, { token: await owner() })).body.partners;
    expect(partners).toEqual([expect.objectContaining({ partner: PARTNER, codes: 50, used: 0, uses: 50, kind: "percent", percent: 15, active: true, excludesPresales: true })]);
    expect((await call(app, "GET", `${pub(t.clientId, t.brandId)}/events/${t.eventId}`)).body.coupons).toEqual([]);
    // A partner code cannot be turned into a public coupon.
    const { rows } = await db.pool.query(`SELECT id FROM public.ticketing_promo_codes WHERE partner = $1 LIMIT 1`, [PARTNER]);
    const turned = await call(app, "PATCH", `${base()}/promo-codes/${rows[0].id}`, { token: await owner(), body: { public: true } });
    expect(turned.status).toBe(409);
    expect(turned.body.error.code).toBe("partner_code_private");
  });

  it("sends the company a file: each code, its value, its use and its own link to the shop", async () => {
    const r = await app.request(`${base()}/events/${t.eventId}/partner-codes.csv?partner=${encodeURIComponent(PARTNER)}`, { headers: { authorization: `Bearer ${await owner()}` } });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-disposition")).toContain("alkao-codes-caissede.csv");
    const lines = (await r.text()).trim().split("\r\n");
    expect(lines[0]).toBe("code,rabais,utilisations,utilise,fin,actif,lien");
    expect(lines).toHaveLength(51);
    const [code, value, uses, used, , active, link] = lines[1]!.split(",");
    expect([value, uses, used, active]).toEqual(["15 %", "1", "0", "oui"]);
    expect(link).toBe(`${PUBLIC_URL}/acheter/${t.clientId}/${t.brandId}/${t.eventId}?coupon=${code}`);
    expect((await app.request(`${base()}/events/${t.eventId}/partner-codes.csv?partner=Inconnue`, { headers: { authorization: `Bearer ${await owner()}` } })).status).toBe(404);
  });

  it("a code works once, says whose offer it is, and the dashboard counts the company's sales", async () => {
    const [first, second] = (await codesOf(PARTNER)).map((c) => c.code);
    const quote = await call(app, "POST", `${pub(t.clientId, t.brandId)}/events/${t.eventId}/quote`, { body: { items: [{ ticketTypeId: general().id, quantity: 2 }], promoCode: first!.toLowerCase() } });
    expect(quote.body).toMatchObject({ offer: PARTNER, quote: { promoCode: first, discountCents: Math.round(2 * 2995 * 0.15) } });

    const h = await hold(first!);
    expect(h.status, JSON.stringify(h.body)).toBe(201);
    await pay(h.body.hold);
    const again = await hold(first!);
    expect(again.status).toBe(422);
    expect(again.body.error).toMatchObject({ code: "promo_code_invalid", details: { reason: "used_up" } });
    await pay((await hold(second!)).body.hold);

    const report = (await call(app, "GET", `${base()}/reports/sales?eventId=${t.eventId}`, { token: await owner() })).body.report;
    expect(report.promoCodes).toEqual([expect.objectContaining({ code: null, partner: PARTNER, codesUsed: 2, orders: 2, discountCents: 2 * Math.round(2 * 2995 * 0.15) })]);
    expect((await call(app, "GET", `${base()}/events/${t.eventId}/partner-codes`, { token: await owner() })).body.partners[0]).toMatchObject({ used: 2 });
  });

  it("all of a company's codes go off, and on again, at once", async () => {
    const off = await call(app, "PATCH", `${base()}/events/${t.eventId}/partner-codes`, { token: await owner(), body: { partner: PARTNER, active: false } });
    expect(off.body).toEqual({ partner: PARTNER, active: false, count: 50 });
    const unused = (await codesOf(PARTNER)).find((c) => c.used_count === 0)!.code;
    expect((await hold(unused)).body.error).toMatchObject({ code: "promo_code_invalid", details: { reason: "inactive" } });
    await call(app, "PATCH", `${base()}/events/${t.eventId}/partner-codes`, { token: await owner(), body: { partner: PARTNER, active: true } });
    expect((await hold(unused)).status).toBe(201);
  });

  it("refuses an oversized batch, a name that is not text, and staff who cannot change the catalog", async () => {
    expect((await make({ partner: "Trop", count: 2001, kind: "percent", percent: 10 })).status).toBe(400);
    expect((await make({ partner: "<b>Gras</b>", count: 5, kind: "percent", percent: 10 })).status).toBe(400);
    expect((await make({ partner: "Sans valeur", count: 5, kind: "amount" })).status).toBe(400);
    const staff = await tokenFor(seed.users.havanaStaff);
    expect((await make({ partner: "Personnel", count: 5, kind: "percent", percent: 10 }, staff)).status).toBe(403);
    // A fixed amount, several uses per code, and a prefix of the organizer's choice.
    const shop = await make({ partner: "Boutique du Vieux-Port", prefix: "vieuxport", count: 3, usesEach: 4, kind: "amount", amountCents: 500 });
    expect(shop.status, JSON.stringify(shop.body)).toBe(201);
    const codes = await codesOf("Boutique du Vieux-Port");
    expect(codes.map((c) => [c.code.split("-")[0], c.max_uses])).toEqual([["VIEUXPORT", 4], ["VIEUXPORT", 4], ["VIEUXPORT", 4]]);
  });
});
