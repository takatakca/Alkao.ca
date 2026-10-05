import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adm, call, pub, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { completedSession, FakeGateway, signedStripeEvent } from "../helpers/fake-gateway.js";
import { seedTwoTenants, TEST_CREDENTIAL_SECRET, type SeedResult, type TenantFixture } from "../helpers/seed.js";

/**
 * Sales-rush safety (Run 15): the real API under heavy concurrency, against real PostgreSQL.
 * No seat is ever oversold, no payment is fulfilled twice, no refund is paid out twice.
 */
let db: TestDatabase;
let seed: SeedResult;
let gateway: FakeGateway;
let app: TestApp;

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  gateway = new FakeGateway();
  app = testApp(db.pool, { paymentGateway: gateway, credentialMasterSecret: TEST_CREDENTIAL_SECRET, publicHoldsPerMinute: 100_000 });
}, 60_000);

afterAll(async () => {
  await db?.drop();
});

const typeId = (t: TenantFixture, code: string) => t.types.find((x) => x.code === code)!.id;
const pi = () => `pi_${randomUUID().replaceAll("-", "").slice(0, 16)}`;

async function session(t: TenantFixture, capacity: number) {
  const { rows } = await db.pool.query<{ id: string }>(
    `INSERT INTO public.ticketing_sessions (client_id, brand_id, event_id, starts_at, capacity, status)
     VALUES ($1, $2, $3, now() + interval '20 days' + (random() * interval '1 day'), $4, 'on_sale') RETURNING id`,
    [t.clientId, t.brandId, t.eventId, capacity],
  );
  return rows[0]!.id;
}
const counts = async (sessionId: string) =>
  (await db.pool.query(`SELECT capacity, reserved_count, sold_count FROM public.ticketing_sessions WHERE id = $1`, [sessionId])).rows[0];

async function checkout(t: TenantFixture, hold: { id: string; token: string }) {
  return call(app, "POST", `${pub(t.clientId, t.brandId)}/holds/${hold.id}/checkout`, {
    headers: { "x-alkao-hold-token": hold.token },
    body: { buyer: { email: `rush${randomUUID().slice(0, 8)}@example.com` }, successUrl: `${t.returnOrigin}/ok`, cancelUrl: `${t.returnOrigin}/ko` },
  });
}
function webhook(t: TenantFixture, checkoutUrl: string, amount: number, id = pi()) {
  const e = signedStripeEvent("checkout.session.completed", completedSession(checkoutUrl.split("/").pop()!, amount, id), t.stripeAccountId);
  return () => call(app, "POST", "/v1/webhooks/stripe", { body: e.body, headers: { "stripe-signature": e.signature } });
}

describe("sales rush", () => {
  it("200 buyers race for 50 seats: never oversold, every refusal is a clean sold_out", async () => {
    const f = seed.festi;
    const sessionId = await session(f, 50);
    const general = typeId(f, "GENERAL");
    const wanted = Array.from({ length: 200 }, (_, i) => 1 + (i % 3));
    const results = await Promise.all(
      wanted.map((quantity) => call(app, "POST", `${pub(f.clientId, f.brandId)}/holds`, { body: { sessionId, items: [{ ticketTypeId: general, quantity }] } })),
    );
    const won = results.filter((r) => r.status === 201);
    const statuses = new Set(results.map((r) => r.status));
    expect([...statuses].every((s) => s === 201 || s === 409), JSON.stringify([...statuses])).toBe(true);
    for (const r of results.filter((x) => x.status === 409)) expect(r.body.error.code).toBe("sold_out");
    const held = won.reduce((n, r) => n + r.body.hold.quote.admissions, 0);
    expect(held).toBeLessThanOrEqual(50);
    expect(held).toBeGreaterThanOrEqual(48); // only a few seats can be left when the remaining asks are bigger
    expect(await counts(sessionId)).toEqual({ capacity: 50, reserved_count: held, sold_count: 0 });

    // Everyone who won pays at the same time.
    const checkouts = await Promise.all(won.map((r) => checkout(f, r.body.hold)));
    expect(checkouts.every((c) => c.status === 201)).toBe(true);
    const paid = await Promise.all(checkouts.map((c, i) => webhook(f, c.body.checkoutUrl, won[i]!.body.hold.quote.totalCents)()));
    expect(paid.every((p) => p.body.outcome === "processed")).toBe(true);
    expect(await counts(sessionId)).toEqual({ capacity: 50, reserved_count: 0, sold_count: held });
    const { rows } = await db.pool.query(`SELECT count(*)::int AS n FROM public.ticketing_tickets WHERE session_id = $1 AND status = 'valid'`, [sessionId]);
    expect(rows[0].n).toBe(held);
  }, 60_000);

  it("a double-clicked checkout opens one order and one Stripe session", async () => {
    const f = seed.festi;
    const sessionId = await session(f, 10);
    const h = await call(app, "POST", `${pub(f.clientId, f.brandId)}/holds`, { body: { sessionId, items: [{ ticketTypeId: typeId(f, "GENERAL"), quantity: 2 }] } });
    const before = gateway.callsOf("createCheckoutSession").length;
    const clicks = await Promise.all(Array.from({ length: 6 }, () => checkout(f, h.body.hold)));
    const ok = clicks.filter((c) => c.status === 201);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const c of clicks.filter((x) => x.status !== 201)) expect([409]).toContain(c.status);
    expect(new Set(ok.map((c) => c.body.order.id)).size).toBe(1);
    expect(new Set(ok.map((c) => c.body.checkoutUrl)).size).toBe(1);
    const { rows } = await db.pool.query(`SELECT count(*)::int AS n FROM public.ticketing_orders WHERE hold_id = $1`, [h.body.hold.id]);
    expect(rows[0].n).toBe(1);
    const keys = (gateway.callsOf("createCheckoutSession").slice(before) as { idempotencyKey: string }[]).map((x) => x.idempotencyKey);
    expect(new Set(keys).size).toBe(1);
  });

  it("a webhook delivered ten times at once fulfils the order once", async () => {
    const f = seed.festi;
    const sessionId = await session(f, 10);
    const h = await call(app, "POST", `${pub(f.clientId, f.brandId)}/holds`, { body: { sessionId, items: [{ ticketTypeId: typeId(f, "GENERAL"), quantity: 3 }] } });
    const co = await checkout(f, h.body.hold);
    const deliver = webhook(f, co.body.checkoutUrl, h.body.hold.quote.totalCents);
    const results = await Promise.all(Array.from({ length: 10 }, deliver));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.body.outcome === "processed")).toHaveLength(1);
    const { rows } = await db.pool.query(`SELECT count(*)::int AS n FROM public.ticketing_tickets WHERE order_id = $1`, [co.body.order.id]);
    expect(rows[0].n).toBe(3);
    expect(await counts(sessionId)).toMatchObject({ sold_count: 3, reserved_count: 0 });
  });

  it("a double-clicked refund pays out once", async () => {
    const f = seed.festi;
    const sessionId = await session(f, 10);
    const h = await call(app, "POST", `${pub(f.clientId, f.brandId)}/holds`, { body: { sessionId, items: [{ ticketTypeId: typeId(f, "GENERAL"), quantity: 2 }] } });
    const co = await checkout(f, h.body.hold);
    await webhook(f, co.body.checkoutUrl, h.body.hold.quote.totalCents)();
    const owner = await tokenFor(seed.users.festiOwner);
    const before = gateway.callsOf("refundPayment").length;
    const clicks = await Promise.all(
      Array.from({ length: 6 }, () => call(app, "POST", `${adm(f.clientId, f.brandId)}/orders/${co.body.order.id}/refunds`, { token: owner, body: {} })),
    );
    expect(clicks.filter((c) => c.status === 201)).toHaveLength(1);
    for (const c of clicks.filter((x) => x.status !== 201)) expect(["refund_in_progress", "order_not_refundable"]).toContain(c.body.error.code);
    expect(gateway.callsOf("refundPayment").length - before).toBe(1);
    const { rows } = await db.pool.query(`SELECT status, refunded_cents, total_cents FROM public.ticketing_orders WHERE id = $1`, [co.body.order.id]);
    expect(rows[0]).toMatchObject({ status: "refunded", refunded_cents: rows[0].total_cents });
    expect(await counts(sessionId)).toMatchObject({ sold_count: 0 });
  });

  it("a Flex Météo change clicked five times moves the tickets once", async () => {
    const f = seed.festi;
    const from = await session(f, 10);
    const to = await session(f, 10);
    const h = await call(app, "POST", `${pub(f.clientId, f.brandId)}/holds`, {
      body: { sessionId: from, items: [{ ticketTypeId: typeId(f, "GENERAL"), quantity: 2 }, { ticketTypeId: typeId(f, "FLEX_WEATHER"), quantity: 2 }] },
    });
    const co = await checkout(f, h.body.hold);
    await webhook(f, co.body.checkoutUrl, h.body.hold.quote.totalCents)();
    const clicks = await Promise.all(
      Array.from({ length: 5 }, () =>
        call(app, "POST", `${pub(f.clientId, f.brandId)}/orders/${co.body.order.id}/exchange`, { headers: { "x-alkao-order-token": co.body.order.token }, body: { sessionId: to } }),
      ),
    );
    expect(clicks.filter((c) => c.status === 201)).toHaveLength(1);
    for (const c of clicks.filter((x) => x.status !== 201)) expect(c.body.error.code).toBe("already_exchanged");
    expect(await counts(from)).toMatchObject({ sold_count: 0 });
    expect(await counts(to)).toMatchObject({ sold_count: 2 });
  });

  it("three staff pushing a session cancellation at once refund each buyer once", async () => {
    const f = seed.festi;
    const sessionId = await session(f, 30);
    const orders = [];
    for (let i = 0; i < 6; i++) {
      const h = await call(app, "POST", `${pub(f.clientId, f.brandId)}/holds`, { body: { sessionId, items: [{ ticketTypeId: typeId(f, "GENERAL"), quantity: 1 }] } });
      const co = await checkout(f, h.body.hold);
      await webhook(f, co.body.checkoutUrl, h.body.hold.quote.totalCents)();
      orders.push(co.body.order.id as string);
    }
    const owner = await tokenFor(seed.users.festiOwner);
    const before = gateway.callsOf("refundPayment").length;
    const base = `${adm(f.clientId, f.brandId)}/sessions/${sessionId}`;
    await Promise.all([
      call(app, "POST", `${base}/cancel`, { token: owner, body: {} }),
      call(app, "POST", `${base}/cancel`, { token: owner, body: {} }),
      call(app, "POST", `${base}/cancel`, { token: owner, body: {} }),
    ]);
    for (let i = 0; i < 5; i++) {
      await Promise.all([1, 2, 3].map(() => call(app, "POST", `${base}/cancellation/continue`, { token: owner })));
    }
    const progress = await call(app, "GET", `${base}/cancellation`, { token: owner });
    expect(progress.body.cancellation).toMatchObject({ status: "completed", orders: { total: 6, refunded: 6, failed: 0 } });
    expect(gateway.callsOf("refundPayment").length - before).toBe(6);
    const { rows } = await db.pool.query(`SELECT count(*)::int AS n FROM public.ticketing_refunds WHERE order_id = ANY($1::uuid[])`, [orders]);
    expect(rows[0].n).toBe(6);
  }, 60_000);
});
