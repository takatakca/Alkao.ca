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

  it("is enforced by the database: never with money, and always pointing to the original order", async () => {
    const f = seed.festi;
    const insert = (q: { query: typeof db.pool.query }, reference: string, cents: number, of: string) =>
      q.query(
        `INSERT INTO public.ticketing_orders (client_id, brand_id, event_id, session_id, buyer_id, reference, subtotal_cents, tax_cents, total_cents, exchange_of_order_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $7, $8) RETURNING id`,
        [f.clientId, f.brandId, f.eventId, f.sessionId, f.buyerId, reference, cents, of],
      );
    await expect(insert(db.pool, "ZZZZ-ZZZ1", 100, f.orderId)).rejects.toMatchObject({ code: "23514" });
    // Run 37: a move of a move is refused; it must point to the order holding the money.
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await insert(client, "ZZZZ-ZZZ2", 0, f.orderId);
      await expect(insert(client, "ZZZZ-ZZZ3", 0, rows[0].id)).rejects.toMatchObject({ code: "23514", message: "exchange_must_point_to_original" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

describe("open-date tickets: billet ouvert (Run 37)", () => {
  const openDate = (t: TenantFixture) =>
    db.pool.query(`UPDATE public.ticketing_ticket_types SET open_date = true WHERE id = $1`, [typeId(t, "OPEN_DATE")]);
  const publicOrder = async (t: TenantFixture, o: { orderId: string; token: string }) =>
    (await call(app, "GET", `${pub(t.clientId, t.brandId)}/orders/${o.orderId}`, { headers: { "x-alkao-order-token": o.token } })).body.order;

  it("change date as often as needed, the whole group together, each time from the latest order", async () => {
    const f = seed.festi;
    await openDate(f);
    const [a, b, c] = [await session(f), await session(f), await session(f)];
    const o = await buy(f, a, { OPEN_DATE: 1, CHILD: 1 });
    expect(await publicOrder(f, o)).toMatchObject({ canChangeSession: true, openDate: true });

    const first = await exchange(f, o, b);
    expect(first.status).toBe(201);
    const moved = { orderId: first.body.exchange.orderId, token: first.body.exchange.token };
    expect(await publicOrder(f, moved)).toMatchObject({ canChangeSession: true, openDate: true, sessionId: b });
    const second = await exchange(f, moved, c);
    expect(second.status).toBe(201);
    expect(second.body.exchange.tickets).toBe(2);
    expect([await counts(a), await counts(b), await counts(c)].map((x) => x.sold_count)).toEqual([0, 0, 2]);

    // An order already moved cannot move again: only its latest order can.
    expect((await exchange(f, o, a)).body.error.code).toBe("already_exchanged");
    expect((await exchange(f, moved, a)).body.error.code).toBe("already_exchanged");
    expect(await publicOrder(f, moved)).toMatchObject({ canChangeSession: false, exchanged: true });
    const { rows } = await db.pool.query(`SELECT data FROM public.ticketing_audit_log WHERE action = 'order.exchanged' AND entity_id = ANY($1::text[]) ORDER BY id`, [[o.orderId, moved.orderId]]);
    expect(rows.map((r) => r.data.openDate)).toEqual([true, true]);
  });

  it("stop once a ticket has entered, and only to a session that is on sale with room", async () => {
    const f = seed.festi;
    await openDate(f);
    const [a, full] = [await session(f), await session(f, 1)];
    const o = await buy(f, a, { OPEN_DATE: 2 });
    expect((await exchange(f, o, full)).body.error.code).toBe("sold_out");
    const order = await publicOrder(f, o);
    const { rows: cred } = await db.pool.query<{ id: string }>(`SELECT id FROM public.ticketing_credentials WHERE ticket_id = $1 AND status = 'active'`, [order.tickets[0].id]);
    await db.pool.query(
      `INSERT INTO public.ticketing_scans (client_id, brand_id, event_id, session_id, credential_id, ticket_id, result, device_id, scanned_by, scanned_at, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'admitted', 'gate-1', $7, now(), now())`,
      [f.clientId, f.brandId, f.eventId, a, cred[0]!.id, order.tickets[0].id, seed.users.festiOwner],
    );
    expect((await exchange(f, o, await session(f))).body.error.code).toBe("ticket_already_used");
  });

  it("leave Flex Météo as it was: one change, and none without the option", async () => {
    const f = seed.festi;
    const [a, b, c] = [await session(f), await session(f), await session(f)];
    const plain = await buy(f, a, { GENERAL: 1 });
    expect((await exchange(f, plain, b)).body.error.code).toBe("flex_not_purchased");
    const flex = await buy(f, a, { GENERAL: 1, FLEX_WEATHER: 1 });
    const once = await exchange(f, flex, b);
    expect(once.status).toBe(201);
    const moved = { orderId: once.body.exchange.orderId, token: once.body.exchange.token };
    expect(await publicOrder(f, moved)).toMatchObject({ canChangeSession: false, openDate: false });
    expect((await exchange(f, moved, c)).body.error.code).toBe("already_exchanged");
  });

  it("is set on admission types only, by catalog editors", async () => {
    const h = seed.havana;
    const token = await tokenFor(seed.users.havanaOwner);
    const base = `${adm(h.clientId, h.brandId)}/events/${h.eventId}/ticket-types`;
    const made = await call(app, "POST", base, { token, body: { code: "OUVERT", name: "Billet ouvert", priceCents: 3995, maxQuantity: 10, openDate: true } });
    expect(made.status).toBe(201);
    expect(made.body.ticketType).toMatchObject({ kind: "admission", openDate: true });
    expect((await call(app, "POST", base, { token, body: { code: "OPT", name: "Option", kind: "add_on", addOnScope: "per_admission", priceCents: 100, maxQuantity: 10, openDate: true } })).status).toBe(400);
    const off = await call(app, "PATCH", `${adm(h.clientId, h.brandId)}/ticket-types/${made.body.ticketType.id}`, { token, body: { openDate: false } });
    expect(off.body.ticketType.openDate).toBe(false);
    const shop = await call(app, "GET", `${pub(h.clientId, h.brandId)}/events/${h.eventId}`);
    expect(shop.body.ticketTypes.find((t: { code: string }) => t.code === "OUVERT")).toMatchObject({ openDate: false });
  });
});
