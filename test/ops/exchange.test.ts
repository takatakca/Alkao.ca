import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adm, call, pub, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { completedSession, FakeGateway, signedStripeEvent } from "../helpers/fake-gateway.js";
import { seedTwoTenants, TEST_CREDENTIAL_SECRET, type SeedResult, type TenantFixture } from "../helpers/seed.js";

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
  app = testApp(db.pool, { paymentGateway: gateway, credentialMasterSecret: TEST_CREDENTIAL_SECRET });
});

afterAll(async () => {
  await db?.drop();
});

const typeId = (t: TenantFixture, code: string) => t.types.find((x) => x.code === code)!.id;

async function session(t: TenantFixture, capacity = 20, daysAhead = 10) {
  const { rows } = await db.pool.query<{ id: string }>(
    `INSERT INTO public.ticketing_sessions (client_id, brand_id, event_id, starts_at, capacity, status)
     VALUES ($1, $2, $3, now() + make_interval(days => $4) + (random() * interval '1 hour'), $5, 'on_sale') RETURNING id`,
    [t.clientId, t.brandId, t.eventId, daysAhead, capacity],
  );
  return rows[0]!.id;
}

/** Buy through checkout + signed webhook; returns order id and its buyer token. */
async function buy(t: TenantFixture, sessionId: string, items: Record<string, number>) {
  const h = await call(app, "POST", `${pub(t.clientId, t.brandId)}/holds`, {
    body: { sessionId, items: Object.entries(items).map(([code, quantity]) => ({ ticketTypeId: typeId(t, code), quantity })) },
  });
  expect(h.status).toBe(201);
  const co = await call(app, "POST", `${pub(t.clientId, t.brandId)}/holds/${h.body.hold.id}/checkout`, {
    headers: { "x-alkao-hold-token": h.body.hold.token },
    body: { buyer: { email: "flex@example.com", fullName: "Sophie Flex" }, successUrl: `${t.returnOrigin}/ok`, cancelUrl: `${t.returnOrigin}/ko` },
  });
  if (co.body.checkoutUrl) {
    const e = signedStripeEvent("checkout.session.completed", completedSession(co.body.checkoutUrl.split("/").pop(), h.body.hold.quote.totalCents, `pi_test${randomUUID().slice(0, 8)}`), t.stripeAccountId);
    expect((await call(app, "POST", "/v1/webhooks/stripe", { body: e.body, headers: { "stripe-signature": e.signature } })).body.outcome).toBe("processed");
  }
  return { orderId: co.body.order.id as string, token: co.body.order.token as string };
}

const counts = async (sessionId: string) =>
  (await db.pool.query(`SELECT sold_count, reserved_count FROM public.ticketing_sessions WHERE id = $1`, [sessionId])).rows[0];

const exchange = (t: TenantFixture, o: { orderId: string; token: string }, sessionId: string) =>
  call(app, "POST", `${pub(t.clientId, t.brandId)}/orders/${o.orderId}/exchange`, { headers: { "x-alkao-order-token": o.token }, body: { sessionId } });

describe("Flex Météo exchange", () => {
  it("moves every valid ticket to the new session once, with new QR codes, and keeps the money where it was", async () => {
    const f = seed.festi;
    const from = await session(f);
    const to = await session(f);
    const o = await buy(f, from, { GENERAL: 2, CHILD: 1, FLEX_WEATHER: 3 });
    const before = await call(app, "GET", `${pub(f.clientId, f.brandId)}/orders/${o.orderId}`, { headers: { "x-alkao-order-token": o.token } });
    const oldQr = before.body.order.tickets.map((t: { credential: string }) => t.credential);
    expect(await counts(from)).toMatchObject({ sold_count: 3 });

    const res = await exchange(f, o, to);
    expect(res.status).toBe(201);
    expect(res.body.exchange.tickets).toBe(3);
    expect(await counts(from)).toMatchObject({ sold_count: 0 });
    expect(await counts(to)).toMatchObject({ sold_count: 3 });

    const moved = await call(app, "GET", `${pub(f.clientId, f.brandId)}/orders/${res.body.exchange.orderId}`, { headers: { "x-alkao-order-token": res.body.exchange.token } });
    expect(moved.body.order).toMatchObject({ status: "paid", totalCents: 0, sessionId: to });
    expect(moved.body.order.tickets.map((t: { status: string }) => t.status)).toEqual(["valid", "valid", "valid"]);
    expect(moved.body.order.tickets.every((t: { credential: string }) => /^ALK1\./.test(t.credential) && !oldQr.includes(t.credential))).toBe(true);

    const original = await call(app, "GET", `${pub(f.clientId, f.brandId)}/orders/${o.orderId}`, { headers: { "x-alkao-order-token": o.token } });
    expect(original.body.order.tickets.map((t: { status: string; credential: string | null }) => [t.status, t.credential])).toEqual([
      ["void", null], ["void", null], ["void", null],
    ]);
    expect(original.body.order.totalCents).toBeGreaterThan(0); // the payment stays on the original order

    // Old QR codes no longer open the gates.
    const staff = await tokenFor(seed.users.festiOwner);
    const gate = await call(app, "POST", `${adm(f.clientId, f.brandId)}/scanner/scans`, { token: staff, body: { sessionId: from, payload: oldQr[0] } });
    expect(gate.body.scan.result).toBe("revoked");

    // Only one change.
    expect((await exchange(f, o, from)).body.error.code).toBe("already_exchanged");
    expect((await call(app, "POST", `${pub(f.clientId, f.brandId)}/orders/${res.body.exchange.orderId}/exchange`, {
      headers: { "x-alkao-order-token": res.body.exchange.token }, body: { sessionId: from },
    })).body.error.code).toBe("already_exchanged");

    // Sales are counted once: the exchange order carries no money and is not a sale.
    const report = await call(app, "GET", `${adm(f.clientId, f.brandId)}/reports/sales`, { token: staff });
    const { rows } = await db.pool.query(
      `SELECT count(*)::int AS n FROM public.ticketing_orders WHERE client_id = $1 AND status IN ('paid','partially_refunded','refunded') AND exchange_of_order_id IS NULL`,
      [f.clientId],
    );
    expect(report.body.report.totals.orders).toBe(rows[0].n);
  });

  it("refunding the original order voids the moved tickets", async () => {
    const f = seed.festi;
    const from = await session(f);
    const to = await session(f);
    const o = await buy(f, from, { GENERAL: 1, FLEX_WEATHER: 1 });
    const res = await exchange(f, o, to);
    const owner = await tokenFor(seed.users.festiOwner);
    const refund = await call(app, "POST", `${adm(f.clientId, f.brandId)}/orders/${o.orderId}/refunds`, { token: owner, body: {} });
    expect(refund.body.refund.status).toBe("succeeded");
    expect(await counts(to)).toMatchObject({ sold_count: 0 });
    const { rows } = await db.pool.query(`SELECT status FROM public.ticketing_tickets WHERE order_id = $1`, [res.body.exchange.orderId]);
    expect(rows.map((r) => r.status)).toEqual(["void"]);
    // The exchange order itself holds no money to refund.
    expect((await call(app, "POST", `${adm(f.clientId, f.brandId)}/orders/${res.body.exchange.orderId}/refunds`, { token: owner, body: {} })).body.error.code).toBe("order_not_refundable");
  });

  it("refuses without Flex, after admission, to a full, foreign, past or same session", async () => {
    const f = seed.festi;
    const from = await session(f);
    const noFlex = await buy(f, from, { GENERAL: 1 });
    expect((await exchange(f, noFlex, await session(f))).body.error.code).toBe("flex_not_purchased");

    const o = await buy(f, from, { GENERAL: 2, FLEX_WEATHER: 2 });
    const tiny = await session(f, 1);
    expect((await exchange(f, o, tiny)).body.error.code).toBe("sold_out");
    expect(await counts(from)).toMatchObject({ sold_count: 3 }); // nothing moved
    expect((await exchange(f, o, from)).body.error.code).toBe("session_not_available");
    expect((await exchange(f, o, seed.havana.sessionId)).body.error.code).toBe("session_not_available");
    const { rows: past } = await db.pool.query<{ id: string }>(
      `INSERT INTO public.ticketing_sessions (client_id, brand_id, event_id, starts_at, capacity, status)
       VALUES ($1, $2, $3, now() - interval '1 day', 10, 'on_sale') RETURNING id`,
      [f.clientId, f.brandId, f.eventId],
    );
    expect((await exchange(f, o, past[0]!.id)).body.error.code).toBe("session_not_available");

    // Once a ticket has been scanned in, the order can no longer move.
    const gateSession = await session(f, 20, 0);
    const scanned = await buy(f, gateSession, { GENERAL: 1, FLEX_WEATHER: 1 });
    const page = await call(app, "GET", `${pub(f.clientId, f.brandId)}/orders/${scanned.orderId}`, { headers: { "x-alkao-order-token": scanned.token } });
    const owner = await tokenFor(seed.users.festiOwner);
    const admitted = await call(app, "POST", `${adm(f.clientId, f.brandId)}/scanner/scans`, {
      token: owner, body: { sessionId: gateSession, payload: page.body.order.tickets[0].credential },
    });
    expect(admitted.body.scan.result).toBe("admitted");
    expect((await exchange(f, scanned, await session(f))).body.error.code).toBe("ticket_already_used");
  });

  it("requires the order token publicly and a manager in the back office", async () => {
    const f = seed.festi;
    const from = await session(f);
    const o = await buy(f, from, { GENERAL: 1, FLEX_WEATHER: 1 });
    const to = await session(f);
    expect((await exchange(f, { ...o, token: "nope" }, to)).status).toBe(404);
    expect((await exchange(seed.havana, o, to)).status).toBe(404);
    const viewer = await tokenFor(randomUUID());
    expect((await call(app, "POST", `${adm(f.clientId, f.brandId)}/orders/${o.orderId}/exchange`, { token: viewer, body: { sessionId: to } })).status).toBe(404);
    const manager = await tokenFor(seed.users.both); // manager at FESTI-ICE
    const ok = await call(app, "POST", `${adm(f.clientId, f.brandId)}/orders/${o.orderId}/exchange`, { token: manager, body: { sessionId: to } });
    expect(ok.status).toBe(201);
  });

  it("is enforced by the database: one exchange per order, never with money", async () => {
    const f = seed.festi;
    await expect(
      db.pool.query(
        `INSERT INTO public.ticketing_orders (client_id, brand_id, event_id, session_id, buyer_id, reference, subtotal_cents, tax_cents, total_cents, exchange_of_order_id)
         VALUES ($1, $2, $3, $4, $5, 'ZZZZ-ZZZ1', 100, 0, 100, $6)`,
        [f.clientId, f.brandId, f.eventId, f.sessionId, f.buyerId, f.orderId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
