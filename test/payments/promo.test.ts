import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { computeCommission, discountFor } from "../../src/domain/index.js";
import type { CreateCheckoutInput } from "../../src/payments/gateway.js";
import { adm, call, pub, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { completedSession, FakeGateway, signedStripeEvent, WEBHOOK_SECRET } from "../helpers/fake-gateway.js";
import { seedTwoTenants, type SeedResult, type TenantFixture } from "../helpers/seed.js";

/**
 * Run 36 (owner decision, docs/ALKAO_DECISIONS.md): promo codes. A percentage or an amount
 * off the pre-tax subtotal; taxes and the TAKATAK commission rate apply to what is left.
 */
let db: TestDatabase;
let seed: SeedResult;
let gateway: FakeGateway;
let app: TestApp;

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
});

beforeEach(() => {
  gateway = new FakeGateway();
  app = testApp(db.pool, { paymentGateway: gateway });
});

afterAll(async () => {
  await db?.drop();
});

const typeId = (t: TenantFixture, code: string) => t.types.find((x) => x.code === code)!.id;
const owner = () => tokenFor(seed.users.havanaOwner);
const createCode = async (t: TenantFixture, body: Record<string, unknown>, user = seed.users.havanaOwner) =>
  call(app, "POST", `${adm(t.clientId, t.brandId)}/events/${t.eventId}/promo-codes`, { token: await tokenFor(user), body });
const quote = (t: TenantFixture, items: { ticketTypeId: string; quantity: number }[], promoCode?: string) =>
  call(app, "POST", `${pub(t.clientId, t.brandId)}/events/${t.eventId}/quote`, { body: { items, ...(promoCode ? { promoCode } : {}) } });
const hold = (t: TenantFixture, items: { ticketTypeId: string; quantity: number }[], promoCode?: string) =>
  call(app, "POST", `${pub(t.clientId, t.brandId)}/holds`, { body: { sessionId: t.sessionId, items, ...(promoCode ? { promoCode } : {}) } });
const checkout = (t: TenantFixture, h: { id: string; token: string }) =>
  call(app, "POST", `${pub(t.clientId, t.brandId)}/holds/${h.id}/checkout`, {
    headers: { "x-alkao-hold-token": h.token },
    body: { buyer: { email: `promo-${randomUUID().slice(0, 6)}@example.com` }, successUrl: `${t.returnOrigin}/ok`, cancelUrl: `${t.returnOrigin}/ko` },
  });
const usedCount = async (code: string) =>
  (await db.pool.query(`SELECT used_count FROM public.ticketing_promo_codes WHERE code = $1`, [code])).rows[0].used_count as number;
async function stripe(type: string, object: Record<string, unknown>, t: TenantFixture) {
  const e = signedStripeEvent(type, object, t.stripeAccountId, WEBHOOK_SECRET);
  return call(app, "POST", "/v1/webhooks/stripe", { body: e.body, headers: { "stripe-signature": e.signature } });
}

describe("the discount itself", () => {
  it("rounds a percentage, never goes past the subtotal, and the commission rate applies after it", () => {
    expect(discountFor(5990, { code: "X", kind: "percent", percent: 15, amountCents: null })).toBe(899); // 898.5 → 899
    expect(discountFor(1000, { code: "X", kind: "amount", percent: null, amountCents: 2500 })).toBe(1000);
    expect(computeCommission({ rateBps: 500, fixedCentsPerPaidAdmission: 50 }, { subtotalCents: 5990, discountCents: 899, totalCents: 5853, paidAdmissions: 2 }))
      .toBe(Math.round((5990 - 899) * 0.05) + 100);
  });
});

describe("promo codes", () => {
  it("are managed per event by catalog editors, in upper case, one value each", async () => {
    const h = seed.havana;
    const made = await createCode(h, { code: " rentree-20 ", kind: "percent", percent: 20 });
    expect(made.status).toBe(201);
    expect(made.body.promoCode).toMatchObject({ code: "RENTREE-20", kind: "percent", percent: 20, amountCents: null, usedCount: 0, active: true });
    expect((await createCode(h, { code: "RENTREE-20", kind: "amount", amountCents: 500 })).status).toBe(409);
    expect((await createCode(h, { code: "BOTH", kind: "percent", percent: 10, amountCents: 100 })).status).toBe(400);
    expect((await createCode(h, { code: "NOPE", kind: "percent", percent: 0 })).status).toBe(400);
    expect((await createCode(h, { code: "STAFF", kind: "percent", percent: 10 }, seed.users.havanaStaff)).status).toBe(403);
    const f = seed.festi;
    expect((await call(app, "POST", `${adm(h.clientId, h.brandId)}/events/${f.eventId}/promo-codes`, { token: await owner(), body: { code: "CROSS", kind: "percent", percent: 10 } })).status).toBe(404);

    const list = await call(app, "GET", `${adm(h.clientId, h.brandId)}/events/${h.eventId}/promo-codes`, { token: await owner() });
    expect(list.body.promoCodes.map((p: { code: string }) => p.code)).toContain("RENTREE-20");
    const { rows } = await db.pool.query(`SELECT action FROM public.ticketing_audit_log WHERE action = 'promo_code.created' AND entity_id = $1`, [made.body.promoCode.id]);
    expect(rows).toHaveLength(1);
  });

  it("take the discount off before taxes, and explain a code that cannot be used", async () => {
    const h = seed.havana;
    await createCode(h, { code: "MOINS5", kind: "amount", amountCents: 500 });
    const items = [{ ticketTypeId: typeId(h, "GENERAL"), quantity: 2 }];
    const plain = (await quote(h, items)).body.quote;
    const off = await quote(h, items, "moins5");
    expect(off.status).toBe(200);
    const q = off.body.quote;
    expect(q).toMatchObject({ subtotalCents: plain.subtotalCents, discountCents: 500, promoCode: "MOINS5" });
    const taxable = plain.subtotalCents - 500;
    expect(q.taxes.map((t: { taxableCents: number }) => t.taxableCents)).toEqual([taxable, taxable]);
    expect(q.totalCents).toBe(taxable + q.taxCents);

    const reason = async (code: string) => (await quote(h, items, code)).body.error;
    expect(await reason("INCONNU")).toEqual({ code: "promo_code_invalid", details: { reason: "unknown" } });
    await createCode(h, { code: "PLUSTARD", kind: "percent", percent: 10, startsAt: new Date(Date.now() + 86_400_000).toISOString() });
    expect((await reason("PLUSTARD")).details.reason).toBe("not_started");
    const old = await createCode(h, { code: "FINI", kind: "percent", percent: 10, endsAt: new Date(Date.now() + 60_000).toISOString() });
    await db.pool.query(`UPDATE public.ticketing_promo_codes SET starts_at = now() - interval '2 days', ends_at = now() - interval '1 day' WHERE id = $1`, [old.body.promoCode.id]);
    expect((await reason("FINI")).details.reason).toBe("ended");
    const off2 = await createCode(h, { code: "ARRET", kind: "percent", percent: 10 });
    await call(app, "PATCH", `${adm(h.clientId, h.brandId)}/promo-codes/${off2.body.promoCode.id}`, { token: await owner(), body: { active: false } });
    expect((await reason("ARRET")).details.reason).toBe("inactive");
    // Another event's code is no code here.
    const f = seed.festi;
    await createCode(f, { code: "FESTI10", kind: "percent", percent: 10 }, seed.users.festiOwner);
    expect((await reason("FESTI10")).details.reason).toBe("unknown");
  });

  it("go through Stripe: one discounted line, commission on the discounted subtotal, one use per order", async () => {
    const h = seed.havana;
    await createCode(h, { code: "VIP15", kind: "percent", percent: 15 });
    const items = [{ ticketTypeId: typeId(h, "GENERAL"), quantity: 2 }];
    const held = await hold(h, items, "VIP15");
    expect(held.status).toBe(201);
    const q = held.body.hold.quote;
    expect(q.discountCents).toBe(discountFor(q.subtotalCents, { code: "VIP15", kind: "percent", percent: 15, amountCents: null }));
    const co = await checkout(h, held.body.hold);
    expect(co.status).toBe(201);

    const input = gateway.callsOf("createCheckoutSession").at(-1) as CreateCheckoutInput;
    expect(input.amountTotalCents).toBe(q.totalCents);
    expect(input.lineItems.reduce((n, l) => n + l.unitAmountCents * l.quantity, 0)).toBe(q.totalCents);
    expect(input.lineItems[0]!.name).toContain("code VIP15");
    expect(input.lineItems.every((l) => l.unitAmountCents > 0)).toBe(true);
    expect(input.applicationFeeCents).toBe(computeCommission({ rateBps: 500, fixedCentsPerPaidAdmission: 50 }, q));

    const { rows } = await db.pool.query(`SELECT discount_cents, total_cents, commission_cents FROM public.ticketing_orders WHERE id = $1`, [co.body.order.id]);
    expect(rows[0]).toEqual({ discount_cents: q.discountCents, total_cents: q.totalCents, commission_cents: input.applicationFeeCents });
    expect(await usedCount("VIP15")).toBe(1);

    // The order's money, discount included, is fixed.
    await expect(db.pool.query(`UPDATE public.ticketing_orders SET discount_cents = 0 WHERE id = $1`, [co.body.order.id])).rejects.toThrow();

    // Paid: the order shows the code; the reports and the CSV carry the discount.
    const sessionId = co.body.checkoutUrl.split("/").pop();
    expect((await stripe("checkout.session.completed", completedSession(sessionId, q.totalCents, `pi_${randomUUID().slice(0, 8)}`), h)).body.outcome).toBe("processed");
    const order = await call(app, "GET", `${adm(h.clientId, h.brandId)}/orders/${co.body.order.id}`, { token: await owner() });
    expect(order.body.order).toMatchObject({ discountCents: q.discountCents, promoCode: "VIP15" });
    const daily = await call(app, "GET", `${adm(h.clientId, h.brandId)}/reports/daily`, { token: await owner() });
    expect(daily.body.report.totals.discountCents).toBeGreaterThanOrEqual(q.discountCents);
    const res = await app.request(`${adm(h.clientId, h.brandId)}/reports/orders.csv`, { headers: { authorization: `Bearer ${await owner()}` } });
    const csv = (await res.text()).trim().split("\r\n");
    expect(csv[0]!.endsWith(",discount_cents,promo_code")).toBe(true);
    expect(csv.some((l) => l.includes(co.body.order.reference) && l.endsWith(`,${q.discountCents},VIP15`))).toBe(true);
  });

  it("give the use back when the order expires unpaid, and never sell past the last use", async () => {
    const h = seed.havana;
    await createCode(h, { code: "UNSEUL", kind: "amount", amountCents: 300, maxUses: 1 });
    const items = [{ ticketTypeId: typeId(h, "GENERAL"), quantity: 1 }];
    // Two buyers hold with the code before either pays.
    const a = (await hold(h, items, "UNSEUL")).body.hold;
    const b = (await hold(h, items, "UNSEUL")).body.hold;
    const first = await checkout(h, a);
    expect(first.status).toBe(201);
    expect(await usedCount("UNSEUL")).toBe(1);
    const second = await checkout(h, b);
    expect(second.status).toBe(422);
    expect(second.body.error).toEqual({ code: "promo_code_invalid", details: { reason: "used_up" } });
    expect((await quote(h, items, "UNSEUL")).body.error.details.reason).toBe("used_up");

    // The first buyer leaves Stripe; the session expires and the use comes back.
    expect((await stripe("checkout.session.expired", { id: first.body.checkoutUrl.split("/").pop(), object: "checkout.session" }, h)).body.outcome).toBe("processed");
    expect(await usedCount("UNSEUL")).toBe(0);
    expect((await quote(h, items, "UNSEUL")).status).toBe(200);

    // Fewer uses than already made is refused.
    const p = (await db.pool.query(`SELECT id FROM public.ticketing_promo_codes WHERE code = 'UNSEUL'`)).rows[0].id;
    const again = (await hold(h, items, "UNSEUL")).body.hold;
    await checkout(h, again);
    await db.pool.query(`UPDATE public.ticketing_promo_codes SET max_uses = NULL WHERE id = $1`, [p]);
    await checkout(h, (await hold(h, items, "UNSEUL")).body.hold);
    expect((await call(app, "PATCH", `${adm(h.clientId, h.brandId)}/promo-codes/${p}`, { token: await owner(), body: { maxUses: 1 } })).status).toBe(409);
  });

  it("can make an order free: no Stripe, no commission", async () => {
    const h = seed.havana;
    await createCode(h, { code: "INVITE", kind: "percent", percent: 100 });
    const held = (await hold(h, [{ ticketTypeId: typeId(h, "GENERAL"), quantity: 1 }], "INVITE")).body.hold;
    expect(held.quote.totalCents).toBe(0);
    const co = await checkout(h, held);
    expect(co.status).toBe(201);
    expect(co.body.checkoutUrl).toBeNull();
    expect(gateway.callsOf("createCheckoutSession")).toEqual([]);
    const { rows } = await db.pool.query(`SELECT status, commission_cents, total_cents FROM public.ticketing_orders WHERE id = $1`, [co.body.order.id]);
    expect(rows[0]).toEqual({ status: "paid", commission_cents: 0, total_cents: 0 });
  });
});
