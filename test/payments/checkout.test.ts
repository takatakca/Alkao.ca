import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { expireStaleHolds } from "../../src/db/commerce.js";
import { withTransaction } from "../../src/db/pool.js";
import type { CreateCheckoutInput } from "../../src/payments/gateway.js";
import { call, pub, testApp, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { completedSession, FakeGateway, signedStripeEvent } from "../helpers/fake-gateway.js";
import { seedTwoTenants, type SeedResult, type TenantFixture } from "../helpers/seed.js";

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
const base = (t: TenantFixture) => pub(t.clientId, t.brandId);

async function newSession(t: TenantFixture, capacity: number) {
  const { rows } = await db.pool.query<{ id: string }>(
    `INSERT INTO public.ticketing_sessions (client_id, brand_id, event_id, starts_at, capacity, status)
     VALUES ($1, $2, $3, now() + (random() * interval '200 days') + interval '2 days', $4, 'on_sale') RETURNING id`,
    [t.clientId, t.brandId, t.eventId, capacity],
  );
  return rows[0]!.id;
}

async function hold(t: TenantFixture, sessionId: string, items: Record<string, number>, a: TestApp = app) {
  const res = await call(a, "POST", `${base(t)}/holds`, {
    body: { sessionId, items: Object.entries(items).map(([code, quantity]) => ({ ticketTypeId: typeId(t, code), quantity })) },
  });
  expect(res.status).toBe(201);
  return res.body.hold as { id: string; token: string; quote: { totalCents: number; subtotalCents: number } };
}

function checkout(t: TenantFixture, h: { id: string; token: string }, a: TestApp = app, urls?: { successUrl: string; cancelUrl: string }) {
  return call(a, "POST", `${base(t)}/holds/${h.id}/checkout`, {
    headers: { "x-alkao-hold-token": h.token },
    body: {
      buyer: { email: "marie@example.com", fullName: "Marie Tremblay" },
      successUrl: urls?.successUrl ?? `${t.returnOrigin}/merci`,
      cancelUrl: urls?.cancelUrl ?? `${t.returnOrigin}/billets`,
    },
  });
}

const sessionIdOf = (url: string) => url.split("/").pop()!;

async function deliver(a: TestApp, type: string, object: Record<string, unknown>, account: string | null) {
  const e = signedStripeEvent(type, object, account);
  return { event: e, res: await call(a, "POST", "/v1/webhooks/stripe", { body: e.body, headers: { "stripe-signature": e.signature } }) };
}

async function counters(sessionId: string) {
  const { rows } = await db.pool.query(`SELECT reserved_count, sold_count FROM public.ticketing_sessions WHERE id = $1`, [sessionId]);
  return rows[0] as { reserved_count: number; sold_count: number };
}

describe("checkout", () => {
  it("pays the Client directly with TAKATAK's commission as application fee, then issues tickets", async () => {
    const t = seed.havana;
    const sessionId = await newSession(t, 10);
    const h = await hold(t, sessionId, { GENERAL: 2, CHILD: 1, TODDLER: 1, FLEX_WEATHER: 4 });

    const res = await checkout(t, h);
    expect(res.status).toBe(201);
    expect(res.body.order).toMatchObject({ status: "pending_payment", reference: expect.stringMatching(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/) });
    expect(res.body.checkoutUrl).toMatch(/^https:\/\/checkout\.stripe\.com\//);

    const [input] = gateway.callsOf("createCheckoutSession") as CreateCheckoutInput[];
    expect(input!.accountId).toBe(t.stripeAccountId);
    // subtotal 2×29.95 + 17.95 + 0 + 4×8.00 = 109.85 → commission 5 % = 5.49 + 0.50 × 3 paid admissions
    expect(h.quote.subtotalCents).toBe(10_985);
    expect(input!.applicationFeeCents).toBe(549 + 150);
    expect(input!.lineItems.map((l) => l.name)).toEqual([
      "Admission générale — 13 ans et +",
      "Enfant — 2 à 12 ans",
      "Option Flex Météo",
      "TPS (5 %)",
      "TVQ (9,975 %)",
    ]);
    expect(input!.lineItems.reduce((n, l) => n + l.unitAmountCents * l.quantity, 0)).toBe(h.quote.totalCents);
    expect(input!.amountTotalCents).toBe(h.quote.totalCents);
    expect(input!.expiresAt.getTime() - Date.now()).toBeGreaterThan(30 * 60_000);
    expect(input!.successUrl).toBe(`${t.returnOrigin}/merci`);

    const { rows: holdRows } = await db.pool.query(`SELECT expires_at FROM public.ticketing_holds WHERE id = $1`, [h.id]);
    expect(holdRows[0].expires_at.getTime()).toBeGreaterThan(input!.expiresAt.getTime());

    // Retrying checkout returns the same session.
    const again = await checkout(t, h);
    expect(again.body.checkoutUrl).toBe(res.body.checkoutUrl);
    expect(gateway.callsOf("createCheckoutSession")).toHaveLength(1);

    const sessionStripeId = sessionIdOf(res.body.checkoutUrl);
    const { event, res: hook } = await deliver(app, "checkout.session.completed", completedSession(sessionStripeId, h.quote.totalCents), t.stripeAccountId);
    expect(hook.body).toEqual({ outcome: "processed" });
    expect(await counters(sessionId)).toEqual({ reserved_count: 0, sold_count: 4 });

    // Redelivery of the same event changes nothing.
    const dup = await call(app, "POST", "/v1/webhooks/stripe", { body: event.body, headers: { "stripe-signature": event.signature } });
    expect(dup.body).toEqual({ outcome: "duplicate" });
    expect(await counters(sessionId)).toEqual({ reserved_count: 0, sold_count: 4 });

    const order = await call(app, "GET", `${base(t)}/orders/${again.body.order.id}`, { headers: { "x-alkao-order-token": again.body.order.token } });
    expect(order.status).toBe(200);
    expect(order.body.order).toMatchObject({ status: "paid", buyerName: "Marie Tremblay" });
    expect(order.body.order.tickets).toHaveLength(4);
    expect(order.body.order).not.toHaveProperty("commissionCents");
  });

  it("protects the order status page with its token and its tenant", async () => {
    const t = seed.havana;
    const h = await hold(t, t.sessionId, { GENERAL: 1 });
    const res = await checkout(t, h);
    const { id, token } = res.body.order;
    expect((await call(app, "GET", `${base(t)}/orders/${id}`)).status).toBe(404);
    expect((await call(app, "GET", `${base(t)}/orders/${id}`, { headers: { "x-alkao-order-token": "nope" } })).status).toBe(404);
    expect((await call(app, "GET", `${base(seed.festi)}/orders/${id}`, { headers: { "x-alkao-order-token": token } })).status).toBe(404);
  });

  it("requires the hold token, an allowed return origin and an enabled Stripe account", async () => {
    const t = seed.havana;
    const h = await hold(t, t.sessionId, { GENERAL: 1 });
    expect((await checkout(t, { id: h.id, token: "wrong" })).status).toBe(404);
    const evil = await checkout(t, h, app, { successUrl: "https://evil.example/merci", cancelUrl: `${t.returnOrigin}/x` });
    expect(evil.body.error.code).toBe("return_url_not_allowed");
    const http = await checkout(t, h, app, { successUrl: `${t.returnOrigin.replace("https", "http")}/merci`, cancelUrl: `${t.returnOrigin}/x` });
    expect(http.status).toBe(400);

    await db.pool.query(`UPDATE public.ticketing_payment_accounts SET charges_enabled = false WHERE client_id = $1`, [t.clientId]);
    try {
      expect((await checkout(t, h)).body.error.code).toBe("payments_unavailable");
    } finally {
      await db.pool.query(`UPDATE public.ticketing_payment_accounts SET charges_enabled = true WHERE client_id = $1`, [t.clientId]);
    }
    const unconfigured = testApp(db.pool, { paymentGateway: null });
    expect((await checkout(t, h, unconfigured)).body.error.code).toBe("payments_unavailable");
    expect(gateway.callsOf("createCheckoutSession")).toHaveLength(0);
  });

  it("issues free orders immediately, without Stripe", async () => {
    const t = seed.festi;
    const sessionId = await newSession(t, 5);
    const h = await hold(t, sessionId, { TODDLER: 2 });
    const res = await checkout(t, h);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ order: { status: "paid" }, checkoutUrl: null });
    expect(gateway.calls).toHaveLength(0);
    expect(await counters(sessionId)).toEqual({ reserved_count: 0, sold_count: 2 });
  });

  it("retries a checkout whose Stripe session creation failed, with the same idempotency key", async () => {
    const t = seed.havana;
    const h = await hold(t, t.sessionId, { GENERAL: 1 });
    gateway.failNext("createCheckoutSession");
    const failed = await checkout(t, h);
    expect(failed).toMatchObject({ status: 502, body: { error: { code: "payment_provider_error" } } });
    const ok = await checkout(t, h);
    expect(ok.status).toBe(201);
    const keys = (gateway.callsOf("createCheckoutSession") as CreateCheckoutInput[]).map((i) => i.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });
});

describe("webhooks", () => {
  it("rejects bad signatures and answers 503 when payments are not configured", async () => {
    const e = signedStripeEvent("checkout.session.completed", completedSession("cs_test_x", 1), "acct_x", "whsec_attacker");
    expect((await call(app, "POST", "/v1/webhooks/stripe", { body: e.body, headers: { "stripe-signature": e.signature } })).status).toBe(400);
    expect((await call(app, "POST", "/v1/webhooks/stripe", { body: e.body })).status).toBe(400);
    const off = testApp(db.pool, { paymentGateway: null });
    expect((await call(off, "POST", "/v1/webhooks/stripe", { body: e.body, headers: { "stripe-signature": e.signature } })).status).toBe(503);
  });

  it("ignores a completion with the wrong amount, currency or account — no tickets", async () => {
    const t = seed.havana;
    const sessionId = await newSession(t, 5);
    const h = await hold(t, sessionId, { GENERAL: 1 });
    const res = await checkout(t, h);
    const sid = sessionIdOf(res.body.checkoutUrl);
    expect((await deliver(app, "checkout.session.completed", completedSession(sid, h.quote.totalCents - 1), t.stripeAccountId)).res.body.outcome).toBe("ignored");
    expect((await deliver(app, "checkout.session.completed", completedSession(sid, h.quote.totalCents, undefined, { currency: "usd" }), t.stripeAccountId)).res.body.outcome).toBe("ignored");
    expect((await deliver(app, "checkout.session.completed", completedSession(sid, h.quote.totalCents), seed.festi.stripeAccountId)).res.body.outcome).toBe("ignored");
    expect(await counters(sessionId)).toEqual({ reserved_count: 1, sold_count: 0 });
    const { rows } = await db.pool.query(`SELECT action FROM public.ticketing_audit_log WHERE client_id = $1 AND action LIKE 'payment.%' ORDER BY id`, [t.clientId]);
    expect(rows.map((r) => r.action)).toEqual(["payment.amount_mismatch", "payment.amount_mismatch", "payment.account_mismatch"]);
    // The genuine completion still works afterwards.
    expect((await deliver(app, "checkout.session.completed", completedSession(sid, h.quote.totalCents), t.stripeAccountId)).res.body.outcome).toBe("processed");
    expect(await counters(sessionId)).toEqual({ reserved_count: 0, sold_count: 1 });
  });

  it("expires the order and returns the seats when Checkout expires", async () => {
    const t = seed.havana;
    const sessionId = await newSession(t, 5);
    const h = await hold(t, sessionId, { GENERAL: 2 });
    const res = await checkout(t, h);
    expect(await counters(sessionId)).toEqual({ reserved_count: 2, sold_count: 0 });
    const out = await deliver(app, "checkout.session.expired", { id: sessionIdOf(res.body.checkoutUrl), object: "checkout.session" }, t.stripeAccountId);
    expect(out.res.body.outcome).toBe("processed");
    expect(await counters(sessionId)).toEqual({ reserved_count: 0, sold_count: 0 });
    const { rows } = await db.pool.query(`SELECT status FROM public.ticketing_orders WHERE id = $1`, [res.body.order.id]);
    expect(rows[0].status).toBe("expired");
  });

  it("refunds in full, automatically, a payment that arrives after its seats were resold", async () => {
    const t = seed.havana;
    const sessionId = await newSession(t, 2);
    const late = await hold(t, sessionId, { GENERAL: 2 });
    const res = await checkout(t, late);
    // The hold lapses (sweeper), and another buyer takes both seats.
    await withTransaction(db.pool, (tx) => expireStaleHolds(tx, new Date(Date.now() + 3 * 3_600_000), sessionId));
    await hold(t, sessionId, { GENERAL: 2 });

    const out = await deliver(app, "checkout.session.completed", completedSession(sessionIdOf(res.body.checkoutUrl), late.quote.totalCents, "pi_test_late"), t.stripeAccountId);
    expect(out.res.body.outcome).toBe("processed");
    const { rows } = await db.pool.query(
      `SELECT o.status, o.refunded_cents, o.total_cents, o.commission_cents, o.commission_refunded_cents,
              (SELECT count(*)::int FROM public.ticketing_tickets k WHERE k.order_id = o.id) AS tickets
       FROM public.ticketing_orders o WHERE o.id = $1`,
      [res.body.order.id],
    );
    expect(rows[0]).toMatchObject({ status: "refunded", tickets: 0 });
    expect(rows[0].refunded_cents).toBe(rows[0].total_cents);
    expect(rows[0].commission_refunded_cents).toBe(rows[0].commission_cents);
    expect(gateway.callsOf("refundPayment")).toEqual([
      expect.objectContaining({ accountId: t.stripeAccountId, paymentIntentId: "pi_test_late", amountCents: late.quote.totalCents }),
    ]);
    expect(gateway.callsOf("refundApplicationFee")).toEqual([expect.objectContaining({ amountCents: rows[0].commission_cents })]);
    expect(await counters(sessionId)).toEqual({ reserved_count: 2, sold_count: 0 });
  });

  it("keeps the Client's Stripe account status in sync", async () => {
    const t = seed.festi;
    const out = await deliver(
      app,
      "account.updated",
      { id: t.stripeAccountId, object: "account", charges_enabled: false, payouts_enabled: false, details_submitted: true },
      t.stripeAccountId,
    );
    expect(out.res.body.outcome).toBe("processed");
    const { rows } = await db.pool.query(`SELECT charges_enabled FROM public.ticketing_payment_accounts WHERE client_id = $1`, [t.clientId]);
    expect(rows[0].charges_enabled).toBe(false);
    await db.pool.query(`UPDATE public.ticketing_payment_accounts SET charges_enabled = true WHERE client_id = $1`, [t.clientId]);
  });
});
