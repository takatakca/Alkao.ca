import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EmailMessage, EmailSender } from "../../src/delivery/email.js";
import { deliverTicketEmails } from "../../src/delivery/worker.js";
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
  await db.pool.query(`UPDATE public.ticketing_email_outbox SET status = 'skipped'`);
});

beforeEach(() => {
  gateway = new FakeGateway();
  app = testApp(db.pool, { paymentGateway: gateway, credentialMasterSecret: TEST_CREDENTIAL_SECRET });
});

afterAll(async () => {
  await db?.drop();
});

const typeId = (t: TenantFixture, code: string) => t.types.find((x) => x.code === code)!.id;

async function session(t: TenantFixture, daysAhead: number) {
  const { rows } = await db.pool.query<{ id: string }>(
    `INSERT INTO public.ticketing_sessions (client_id, brand_id, event_id, starts_at, capacity, status)
     VALUES ($1, $2, $3, now() + make_interval(days => $4) + (random() * interval '1 hour'), 50, 'on_sale') RETURNING id`,
    [t.clientId, t.brandId, t.eventId, daysAhead],
  );
  return rows[0]!.id;
}

async function hold(t: TenantFixture, sessionId: string, items: Record<string, number>) {
  const h = await call(app, "POST", `${pub(t.clientId, t.brandId)}/holds`, {
    body: { sessionId, items: Object.entries(items).map(([code, quantity]) => ({ ticketTypeId: typeId(t, code), quantity })) },
  });
  expect(h.status).toBe(201);
  const co = await call(app, "POST", `${pub(t.clientId, t.brandId)}/holds/${h.body.hold.id}/checkout`, {
    headers: { "x-alkao-hold-token": h.body.hold.token },
    body: { buyer: { email: `b${randomUUID().slice(0, 6)}@example.com`, fullName: "Acheteur Test" }, successUrl: `${t.returnOrigin}/ok`, cancelUrl: `${t.returnOrigin}/ko` },
  });
  expect(co.status).toBe(201);
  return { orderId: co.body.order.id as string, token: co.body.order.token as string, checkoutUrl: co.body.checkoutUrl as string | null, total: h.body.hold.quote.totalCents as number };
}

async function pay(t: TenantFixture, o: { checkoutUrl: string | null; total: number }) {
  const e = signedStripeEvent("checkout.session.completed", completedSession(o.checkoutUrl!.split("/").pop()!, o.total, `pi_${randomUUID().replaceAll("-", "").slice(0, 16)}`), t.stripeAccountId);
  return call(app, "POST", "/v1/webhooks/stripe", { body: e.body, headers: { "stripe-signature": e.signature } });
}

async function buy(t: TenantFixture, sessionId: string, items: Record<string, number>) {
  const o = await hold(t, sessionId, items);
  if (o.checkoutUrl) {
    const r = await pay(t, o);
    expect(r.body, JSON.stringify(r.body)).toMatchObject({ outcome: "processed" });
  }
  return o;
}

const order = async (id: string) =>
  (await db.pool.query(`SELECT status, total_cents, refunded_cents, commission_cents, commission_refunded_cents FROM public.ticketing_orders WHERE id = $1`, [id])).rows[0];
const tickets = async (orderId: string) =>
  (await db.pool.query(`SELECT status, void_reason FROM public.ticketing_tickets WHERE order_id = $1 ORDER BY created_at`, [orderId])).rows;
const counts = async (sessionId: string) =>
  (await db.pool.query(`SELECT status, sold_count, reserved_count FROM public.ticketing_sessions WHERE id = $1`, [sessionId])).rows[0];

async function runToEnd(t: TenantFixture, sessionId: string, token: string) {
  let r = await call(app, "POST", `${adm(t.clientId, t.brandId)}/sessions/${sessionId}/cancel`, { token, body: { reason: "Pluie verglaçante" } });
  expect(r.status).toBe(202);
  for (let i = 0; i < 10 && r.body.cancellation.status !== "completed"; i++) {
    r = await call(app, "POST", `${adm(t.clientId, t.brandId)}/sessions/${sessionId}/cancellation/continue`, { token });
  }
  return r.body.cancellation;
}

class Outbox implements EmailSender {
  sent: EmailMessage[] = [];
  async send(m: EmailMessage) { this.sent.push(m); return null; }
}

describe("session cancellation", () => {
  it("refunds every paying order in full, commission included, voids their tickets and tells each buyer", async () => {
    const f = seed.festi;
    const owner = await tokenFor(seed.users.festiOwner);
    const s = await session(f, 30);
    const other = await session(f, 31);

    const plain = await buy(f, s, { GENERAL: 2 });
    const partial = await buy(f, s, { GENERAL: 1, CHILD: 1 });
    const partialRefund = await call(app, "POST", `${adm(f.clientId, f.brandId)}/orders/${partial.orderId}/refunds`, { token: owner, body: { amountCents: 500 } });
    expect(partialRefund.status).toBe(201);
    // Bought for another session with Flex Météo, then moved into the cancelled one.
    const moved = await buy(f, other, { GENERAL: 1, FLEX_WEATHER: 1 });
    const ex = await call(app, "POST", `${pub(f.clientId, f.brandId)}/orders/${moved.orderId}/exchange`, { headers: { "x-alkao-order-token": moved.token }, body: { sessionId: s } });
    expect(ex.status).toBe(201);
    const untouched = await buy(f, other, { GENERAL: 1 });
    const unpaid = await hold(f, s, { GENERAL: 1 });
    expect(await counts(s)).toMatchObject({ sold_count: 5, reserved_count: 1 });

    const refundsBefore = gateway.callsOf("refundPayment").length; // the earlier partial refund
    const progress = await runToEnd(f, s, owner);
    expect(progress).toMatchObject({ status: "completed", reason: "Pluie verglaçante", orders: { total: 3, refunded: 3, pending: 0, failed: 0 } });

    for (const o of [plain, partial, moved]) {
      const row = await order(o.orderId);
      expect(row.status).toBe("refunded");
      expect(row.refunded_cents).toBe(row.total_cents);
      expect(row.commission_refunded_cents).toBe(row.commission_cents);
    }
    expect((await tickets(plain.orderId)).every((t: { status: string }) => t.status === "void")).toBe(true);
    expect((await tickets(ex.body.exchange.orderId)).every((t: { status: string }) => t.status === "void")).toBe(true);
    expect(await order(untouched.orderId)).toMatchObject({ status: "paid", refunded_cents: 0 });
    expect((await tickets(untouched.orderId)).map((t: { status: string }) => t.status)).toEqual(["valid"]);
    expect(await counts(s)).toEqual({ status: "cancelled", sold_count: 0, reserved_count: 0 });
    expect(gateway.callsOf("refundPayment")).toHaveLength(refundsBefore + 3);
    expect(gateway.callsOf("refundApplicationFee")).toHaveLength(refundsBefore + 3);

    // No more sales, and running again refunds nobody twice.
    const late = await call(app, "POST", `${pub(f.clientId, f.brandId)}/holds`, { body: { sessionId: s, items: [{ ticketTypeId: typeId(f, "GENERAL"), quantity: 1 }] } });
    expect(late.status).toBe(409);
    const again = await call(app, "POST", `${adm(f.clientId, f.brandId)}/sessions/${s}/cancellation/continue`, { token: owner });
    expect(again.body.cancellation.orders.refunded).toBe(3);
    expect(gateway.callsOf("refundPayment")).toHaveLength(refundsBefore + 3);

    // A checkout still open at Stripe that completes later is refunded in full, with no ticket.
    const settled = await pay(f, unpaid);
    expect(settled.body.outcome).toBe("processed");
    const { rows: lateRefunds } = await db.pool.query(`SELECT reason, amount_cents, status FROM public.ticketing_refunds WHERE order_id = $1`, [unpaid.orderId]);
    expect(lateRefunds).toEqual([{ reason: "session_cancelled", amount_cents: unpaid.total, status: "succeeded" }]);
    expect(await tickets(unpaid.orderId)).toEqual([]);

    // Buyers are told: one email per order that held tickets for the session, with the amount.
    const sender = new Outbox();
    // A moment later: emails stamped in the same millisecond would not be due yet.
    await deliverTicketEmails(db.pool, { sender, publicUrl: "https://billets.alkao.test", credentialMasterSecret: TEST_CREDENTIAL_SECRET }, new Date(Date.now() + 1000));
    const cancelled = sender.sent.filter((m) => m.subject.startsWith("Séance annulée"));
    expect(cancelled).toHaveLength(3);
    expect(cancelled.every((m) => /Vous êtes remboursé de \d/.test(m.text) && !m.text.includes("/billets#"))).toBe(true);

    const audit = await db.pool.query(`SELECT action FROM public.ticketing_audit_log WHERE entity_id = $1 ORDER BY created_at`, [s]);
    expect(audit.rows.map((r: { action: string }) => r.action)).toEqual(["session.cancelled", "session.cancellation_completed"]);
  });

  it("tells an open-date buyer once, on their latest order, when their ticket came back to the session (Run 37)", async () => {
    const f = seed.festi;
    const owner = await tokenFor(seed.users.festiOwner);
    await db.pool.query(`UPDATE public.ticketing_ticket_types SET open_date = true WHERE id = $1`, [typeId(f, "OPEN_DATE")]);
    const [s, other] = [await session(f, 35), await session(f, 36)];
    const o = await buy(f, s, { OPEN_DATE: 1 });
    const move = (from: { orderId: string; token: string }, sessionId: string) =>
      call(app, "POST", `${pub(f.clientId, f.brandId)}/orders/${from.orderId}/exchange`, { headers: { "x-alkao-order-token": from.token }, body: { sessionId } });
    const away = await move(o, other);
    const back = await move({ orderId: away.body.exchange.orderId, token: away.body.exchange.token }, s);
    expect(back.status).toBe(201);

    const progress = await runToEnd(f, s, owner);
    expect(progress.orders).toMatchObject({ total: 1, refunded: 1 });
    expect(await order(o.orderId)).toMatchObject({ status: "refunded" });
    expect(await tickets(back.body.exchange.orderId)).toEqual([{ status: "void", void_reason: "refunded" }]);
    const { rows } = await db.pool.query(`SELECT order_id FROM public.ticketing_email_outbox WHERE kind = 'session_cancelled' AND order_id = ANY($1::uuid[])`,
      [[o.orderId, away.body.exchange.orderId, back.body.exchange.orderId]]);
    expect(rows).toEqual([{ order_id: back.body.exchange.orderId }]);
  });

  it("retries a refund that Stripe failed, without paying out twice", async () => {
    const f = seed.festi;
    const owner = await tokenFor(seed.users.festiOwner);
    const s = await session(f, 32);
    const o = await buy(f, s, { GENERAL: 1 });
    gateway.failNext("refundPayment");
    const first = await call(app, "POST", `${adm(f.clientId, f.brandId)}/sessions/${s}/cancel`, { token: owner, body: {} });
    expect(first.body.cancellation).toMatchObject({ status: "running", orders: { pending: 1, refunded: 0 } });
    expect(await order(o.orderId)).toMatchObject({ status: "paid" });

    const second = await call(app, "POST", `${adm(f.clientId, f.brandId)}/sessions/${s}/cancellation/continue`, { token: owner });
    expect(second.body.cancellation).toMatchObject({ status: "completed", orders: { refunded: 1 } });
    expect(await order(o.orderId)).toMatchObject({ status: "refunded" });
    const keys = (gateway.callsOf("refundPayment") as { idempotencyKey: string }[]).map((c) => c.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
    const { rows } = await db.pool.query(`SELECT count(*)::int AS n FROM public.ticketing_refunds WHERE order_id = $1`, [o.orderId]);
    expect(rows[0].n).toBe(1);
  });

  it("voids free tickets and tells their holders", async () => {
    const h = seed.havana;
    const owner = await tokenFor(seed.users.havanaOwner);
    const s = await session(h, 33);
    await db.pool.query(`UPDATE public.ticketing_email_outbox SET status = 'skipped' WHERE status = 'pending'`);
    const free = await buy(h, s, { TODDLER: 1 });
    const progress = await runToEnd(h, s, owner);
    expect(progress.orders).toMatchObject({ total: 1, voided: 1 });
    expect(await tickets(free.orderId)).toEqual([{ status: "void", void_reason: "cancelled" }]);
    const sender = new Outbox();
    // A moment later: emails stamped in the same millisecond would not be due yet.
    await deliverTicketEmails(db.pool, { sender, publicUrl: "https://billets.alkao.test", credentialMasterSecret: TEST_CREDENTIAL_SECRET }, new Date(Date.now() + 1000));
    expect(sender.sent.filter((m) => m.subject.startsWith("Séance annulée")).map((m) => m.text.includes("Vos billets sont annulés."))).toEqual([true]);
  });

  it("is reserved to the Client's owners and admins, and a session with buyers is never just switched off", async () => {
    const f = seed.festi;
    const s = await session(f, 34);
    await buy(f, s, { GENERAL: 1 });
    const manager = await tokenFor(seed.users.both);
    expect((await call(app, "POST", `${adm(f.clientId, f.brandId)}/sessions/${s}/cancel`, { token: manager, body: {} })).status).toBe(403);
    const havanaOwner = await tokenFor(seed.users.havanaOwner);
    expect((await call(app, "POST", `${adm(f.clientId, f.brandId)}/sessions/${s}/cancel`, { token: havanaOwner, body: {} })).status).toBe(404);
    const h = seed.havana;
    expect((await call(app, "POST", `${adm(h.clientId, h.brandId)}/sessions/${s}/cancel`, { token: havanaOwner, body: {} })).status).toBe(404);

    const owner = await tokenFor(seed.users.festiOwner);
    const patch = await call(app, "PATCH", `${adm(f.clientId, f.brandId)}/sessions/${s}`, { token: owner, body: { status: "cancelled" } });
    expect(patch).toMatchObject({ status: 409, body: { error: { code: "use_session_cancellation" } } });
    const empty = await session(f, 35);
    expect((await call(app, "PATCH", `${adm(f.clientId, f.brandId)}/sessions/${empty}`, { token: owner, body: { status: "cancelled" } })).status).toBe(200);
    expect((await call(app, "GET", `${adm(f.clientId, f.brandId)}/sessions/${s}/cancellation`, { token: owner })).status).toBe(404);
  });
});
