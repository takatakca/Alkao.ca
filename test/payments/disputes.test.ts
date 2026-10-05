import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adm, call, pub, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { completedSession, dispute, FakeGateway, refundedCharge, signedStripeEvent, WEBHOOK_SECRET } from "../helpers/fake-gateway.js";
import { seedTwoTenants, type SeedResult, type TenantFixture } from "../helpers/seed.js";

/**
 * Run 19: what Stripe reports after the sale. A chargeback, or a refund made directly in the
 * Client's Stripe dashboard, is recorded and shown to staff, and never moves money.
 * Run 34 (owner decision): a dispute the buyer wins cancels the tickets nobody has used.
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
const pi = () => `pi_test${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const dp = () => `dp_test${randomUUID().replaceAll("-", "").slice(0, 12)}`;

/** A paid order through the real checkout + webhook path. */
async function paidOrder(t: TenantFixture) {
  const h = await call(app, "POST", `${pub(t.clientId, t.brandId)}/holds`, {
    body: { sessionId: t.sessionId, items: [{ ticketTypeId: typeId(t, "GENERAL"), quantity: 2 }] },
  });
  const co = await call(app, "POST", `${pub(t.clientId, t.brandId)}/holds/${h.body.hold.id}/checkout`, {
    headers: { "x-alkao-hold-token": h.body.hold.token },
    body: { buyer: { email: "litige@example.com", fullName: "Jeanne Litige" }, successUrl: `${t.returnOrigin}/ok`, cancelUrl: `${t.returnOrigin}/ko` },
  });
  const paymentIntentId = pi();
  const total = h.body.hold.quote.totalCents as number;
  expect((await stripe("checkout.session.completed", completedSession(co.body.checkoutUrl.split("/").pop(), total, paymentIntentId), t)).outcome).toBe("processed");
  return { id: co.body.order.id as string, reference: co.body.order.reference as string, total, paymentIntentId };
}

async function stripe(type: string, object: Record<string, unknown>, t: TenantFixture, at = new Date(), account = t.stripeAccountId) {
  const e = signedStripeEvent(type, object, account, WEBHOOK_SECRET, at);
  const res = await call(app, "POST", "/v1/webhooks/stripe", { body: e.body, headers: { "stripe-signature": e.signature } });
  expect(res.status).toBe(200);
  return { outcome: res.body.outcome as string, event: e };
}

const getOrder = async (t: TenantFixture, orderId: string, user = seed.users.havanaOwner) =>
  call(app, "GET", `${adm(t.clientId, t.brandId)}/orders/${orderId}`, { token: await tokenFor(user) });
const disputes = async (t: TenantFixture, user: string, query = "") =>
  call(app, "GET", `${adm(t.clientId, t.brandId)}/disputes${query}`, { token: await tokenFor(user) });
const audit = async (orderId: string) =>
  (await db.pool.query<{ action: string }>(`SELECT action FROM public.ticketing_audit_log WHERE entity_id = $1 ORDER BY created_at, id`, [orderId])).rows.map((r) => r.action);
const validTickets = async (orderId: string) =>
  (await db.pool.query(`SELECT count(*)::int AS n FROM public.ticketing_tickets WHERE order_id = $1 AND status = 'valid'`, [orderId])).rows[0].n;

describe("disputes (chargebacks)", () => {
  it("records a dispute, follows it to its outcome, and changes nothing else", async () => {
    const t = seed.havana;
    const order = await paidOrder(t);
    const id = dp();
    const t0 = new Date(Date.now() - 60_000);

    expect((await stripe("charge.dispute.created", dispute(id, order.paymentIntentId, order.total), t, t0)).outcome).toBe("processed");
    let o = (await getOrder(t, order.id)).body.order;
    expect(o.disputes).toHaveLength(1);
    expect(o.disputes[0]).toMatchObject({ stripeDisputeId: id, status: "needs_response", reason: "fraudulent", amountCents: order.total, open: true });
    expect(new Date(o.disputes[0].evidenceDueBy).getTime()).toBeGreaterThan(Date.now());
    // Nothing moves on its own: the order stays paid, its tickets valid, no refund is made.
    expect(o.status).toBe("paid");
    expect(await validTickets(order.id)).toBe(2);
    expect(gateway.callsOf("refundPayment")).toEqual([]);

    const open = await disputes(t, seed.users.havanaOwner);
    expect(open.status).toBe(200);
    expect(open.body.disputes.map((d: { reference: string }) => d.reference)).toContain(order.reference);
    expect(open.body.disputes.find((d: { reference: string }) => d.reference === order.reference)).toMatchObject({ buyerEmail: "litige@example.com", open: true });

    await stripe("charge.dispute.updated", dispute(id, order.paymentIntentId, order.total, "under_review"), t, new Date(t0.getTime() + 10_000));
    await stripe("charge.dispute.closed", dispute(id, order.paymentIntentId, order.total, "lost"), t, new Date(t0.getTime() + 20_000));
    // An older event delivered late changes nothing.
    expect((await stripe("charge.dispute.updated", dispute(id, order.paymentIntentId, order.total, "under_review"), t, new Date(t0.getTime() + 15_000))).outcome).toBe("ignored");

    o = (await getOrder(t, order.id)).body.order;
    expect(o.disputes).toHaveLength(1);
    expect(o.disputes[0]).toMatchObject({ status: "lost", open: false });
    expect((await disputes(t, seed.users.havanaOwner)).body.disputes.map((d: { reference: string }) => d.reference)).not.toContain(order.reference);
    expect((await disputes(t, seed.users.havanaOwner, "?status=all")).body.disputes.map((d: { reference: string }) => d.reference)).toContain(order.reference);
    expect(await audit(order.id)).toEqual(expect.arrayContaining(["payment.dispute_opened", "payment.dispute_updated", "payment.dispute_closed"]));
    // Run 34: lost for the whole order, so its unused tickets are cancelled (see below).
    expect(await validTickets(order.id)).toBe(0);
  });

  it("a redelivered event is a duplicate; a foreign account or an unknown payment is ignored", async () => {
    const t = seed.festi;
    const order = await paidOrder(t);
    const { event } = await stripe("charge.dispute.created", dispute(dp(), order.paymentIntentId, 500), t);
    const again = await call(app, "POST", "/v1/webhooks/stripe", { body: event.body, headers: { "stripe-signature": event.signature } });
    expect(again.body.outcome).toBe("duplicate");

    // The same payment intent reported from another connected account: not this Client's.
    expect((await stripe("charge.dispute.created", dispute(dp(), order.paymentIntentId, 500), t, new Date(), "acct_testintruder")).outcome).toBe("ignored");
    expect(await audit(order.id)).toContain("payment.dispute_opened");
    const { rows } = await db.pool.query(`SELECT count(*)::int AS n FROM public.ticketing_payment_disputes WHERE order_id = $1`, [order.id]);
    expect(rows[0].n).toBe(1);
    expect((await stripe("charge.dispute.created", dispute(dp(), pi(), 500), t)).outcome).toBe("ignored");
  });

  it("each Client sees only its own disputes; staff without order access see none", async () => {
    const f = seed.festi;
    const order = await paidOrder(f);
    await stripe("charge.dispute.created", dispute(dp(), order.paymentIntentId, order.total), f);
    const festi = await disputes(f, seed.users.festiOwner);
    expect(festi.body.disputes.map((d: { reference: string }) => d.reference)).toContain(order.reference);
    const havana = await disputes(seed.havana, seed.users.havanaOwner, "?status=all");
    expect(havana.body.disputes.map((d: { reference: string }) => d.reference)).not.toContain(order.reference);
    expect((await disputes(seed.havana, seed.users.havanaStaff)).status).toBe(403);
    expect((await disputes(f, seed.users.havanaOwner)).status).toBe(404); // not a member: no such Brand
    expect((await getOrder(seed.havana, order.id)).status).toBe(404);
  });
});

describe("a dispute the buyer wins (Run 34)", () => {
  const attentionOf = async (t: TenantFixture) =>
    (await call(app, "GET", `${adm(t.clientId, t.brandId)}/attention`, { token: await tokenFor(seed.users.havanaOwner) })).body.attention;
  const ticketsOf = async (orderId: string) =>
    (await db.pool.query<{ id: string; status: string; void_reason: string | null }>(
      `SELECT id, status, void_reason FROM public.ticketing_tickets WHERE order_id = $1 ORDER BY id`, [orderId])).rows;
  const sold = async (sessionId: string) =>
    (await db.pool.query(`SELECT sold_count FROM public.ticketing_sessions WHERE id = $1`, [sessionId])).rows[0].sold_count as number;

  it("cancels the tickets nobody has used and gives their seats back; a used ticket stays", async () => {
    const t = seed.havana;
    const order = await paidOrder(t);
    const [used, unused] = await ticketsOf(order.id);
    // One of the two already went through the gate.
    const { rows: cred } = await db.pool.query<{ id: string }>(
      `SELECT id FROM public.ticketing_credentials WHERE ticket_id = $1 AND status = 'active'`,
      [used!.id],
    );
    await db.pool.query(
      `INSERT INTO public.ticketing_scans (client_id, brand_id, event_id, session_id, credential_id, ticket_id, result, device_id, scanned_by, scanned_at, received_at)
       SELECT k.client_id, k.brand_id, k.event_id, k.session_id, $2, k.id, 'admitted', 'gate-1', $3, now(), now() FROM public.ticketing_tickets k WHERE k.id = $1`,
      [used!.id, cred[0]!.id, seed.users.havanaStaff],
    );
    const seatsBefore = await sold(t.sessionId);
    const outboxBefore = (await db.pool.query(`SELECT count(*)::int AS n FROM public.ticketing_email_outbox WHERE order_id = $1`, [order.id])).rows[0].n;

    const id = dp();
    await stripe("charge.dispute.created", dispute(id, order.paymentIntentId, order.total), t, new Date(Date.now() - 30_000));
    expect(await validTickets(order.id)).toBe(2); // open: nothing moves
    await stripe("charge.dispute.closed", dispute(id, order.paymentIntentId, order.total, "lost"), t);

    expect(await ticketsOf(order.id)).toEqual([
      { id: used!.id, status: "valid", void_reason: null },
      { id: unused!.id, status: "void", void_reason: "chargeback" },
    ]);
    expect(await sold(t.sessionId)).toBe(seatsBefore - 1);
    const { rows: log } = await db.pool.query(`SELECT actor_type, data FROM public.ticketing_audit_log WHERE action = 'tickets.voided' AND entity_id = $1`, [order.id]);
    expect(log).toEqual([{ actor_type: "system", data: { ticketIds: [unused!.id], reason: "chargeback", disputeId: id } }]);
    // The buyer is not written to, and no money moves.
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM public.ticketing_email_outbox WHERE order_id = $1`, [order.id])).rows[0].n).toBe(outboxBefore);
    expect(gateway.callsOf("refundPayment")).toEqual([]);
    expect((await attentionOf(t)).lostDisputes.map((d: { reference: string }) => d.reference)).not.toContain(order.reference);
  });

  it("a dispute the Client wins cancels nothing", async () => {
    const t = seed.festi;
    const order = await paidOrder(t);
    const id = dp();
    await stripe("charge.dispute.created", dispute(id, order.paymentIntentId, order.total), t, new Date(Date.now() - 30_000));
    await stripe("charge.dispute.closed", dispute(id, order.paymentIntentId, order.total, "won"), t);
    expect(await validTickets(order.id)).toBe(2);
  });

  it("lost for part of the order, it cancels nothing by itself and waits in À traiter", async () => {
    const t = seed.havana;
    const owner = await tokenFor(seed.users.havanaOwner);
    const order = await paidOrder(t);
    const id = dp();
    await stripe("charge.dispute.created", dispute(id, order.paymentIntentId, 500), t, new Date(Date.now() - 30_000));
    await stripe("charge.dispute.closed", dispute(id, order.paymentIntentId, 500, "lost"), t);
    expect(await validTickets(order.id)).toBe(2);
    expect(await audit(order.id)).toContain("payment.dispute_lost_partial");
    expect((await attentionOf(t)).lostDisputes).toEqual(expect.arrayContaining([expect.objectContaining({ orderId: order.id, reference: order.reference, amountCents: 500 })]));

    // Staff cancel the ticket the bank took back: the order leaves the list once nothing usable remains.
    const [first, second] = await ticketsOf(order.id);
    await call(app, "POST", `${adm(t.clientId, t.brandId)}/orders/${order.id}/tickets/void`, { token: owner, body: { ticketIds: [first!.id], reason: "Litige perdu" } });
    expect((await attentionOf(t)).lostDisputes.map((d: { reference: string }) => d.reference)).toContain(order.reference);
    await call(app, "POST", `${adm(t.clientId, t.brandId)}/orders/${order.id}/tickets/void`, { token: owner, body: { ticketIds: [second!.id], reason: "Litige perdu" } });
    expect((await attentionOf(t)).lostDisputes.map((d: { reference: string }) => d.reference)).not.toContain(order.reference);
  });
});

describe("refunds made outside ALKAO", () => {
  it("shows the part of Stripe's refunded total that ALKAO did not issue", async () => {
    const t = seed.havana;
    const owner = await tokenFor(seed.users.havanaOwner);
    const order = await paidOrder(t);

    // The Client refunds 10 $ in its Stripe dashboard.
    await stripe("charge.refunded", refundedCharge(order.paymentIntentId, order.total, 1000), t);
    let o = (await getOrder(t, order.id)).body.order;
    expect(o.outsideRefundCents).toBe(1000);
    expect(o.status).toBe("paid");
    expect(o.refundedCents).toBe(0); // ALKAO's own ledger is untouched
    expect(await validTickets(order.id)).toBe(2);
    expect(await audit(order.id)).toContain("payment.outside_refund");

    // Then a 5 $ refund through ALKAO: Stripe's total becomes 15 $, and 10 $ is still from outside.
    const r = await call(app, "POST", `${adm(t.clientId, t.brandId)}/orders/${order.id}/refunds`, { token: owner, body: { amountCents: 500 } });
    expect(r.status).toBe(201);
    await stripe("charge.refunded", refundedCharge(order.paymentIntentId, order.total, 1500), t);
    // A stale event with a lower total changes nothing.
    await stripe("charge.refunded", refundedCharge(order.paymentIntentId, order.total, 1000), t, new Date(Date.now() - 60_000));
    o = (await getOrder(t, order.id)).body.order;
    expect(o.outsideRefundCents).toBe(1000);
    expect(o.refundedCents).toBe(500);
  });

  it("ALKAO's own refunds never look like outside refunds", async () => {
    const t = seed.festi;
    const owner = await tokenFor(seed.users.festiOwner);
    const order = await paidOrder(t);
    const r = await call(app, "POST", `${adm(t.clientId, t.brandId)}/orders/${order.id}/refunds`, { token: owner, body: {} });
    expect(r.status).toBe(201);
    await stripe("charge.refunded", refundedCharge(order.paymentIntentId, order.total, order.total), t);
    const o = (await getOrder(t, order.id, seed.users.festiOwner)).body.order;
    expect(o.outsideRefundCents).toBe(0);
    expect(await audit(order.id)).not.toContain("payment.outside_refund");
  });
});

describe("gate evidence", () => {
  it("the order shows when each ticket entered", async () => {
    const t = seed.havana;
    const order = await paidOrder(t);
    const { rows } = await db.pool.query<{ id: string; ticket_id: string }>(
      `SELECT c.id, c.ticket_id FROM public.ticketing_credentials c JOIN public.ticketing_tickets k ON k.id = c.ticket_id
       WHERE k.order_id = $1 ORDER BY k.created_at, k.id LIMIT 1`,
      [order.id],
    );
    const enteredAt = new Date("2026-10-04T19:42:00Z");
    await db.pool.query(
      `INSERT INTO public.ticketing_scans (client_id, brand_id, event_id, session_id, credential_id, ticket_id, result, device_id, scanned_by, scanned_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'admitted', 'gate-1', $7, $8)`,
      [t.clientId, t.brandId, t.eventId, t.sessionId, rows[0]!.id, rows[0]!.ticket_id, seed.users.havanaStaff, enteredAt],
    );
    const o = (await getOrder(t, order.id)).body.order;
    const byId = new Map(o.tickets.map((k: { id: string; admittedAt: string | null }) => [k.id, k.admittedAt]));
    expect(byId.get(rows[0]!.ticket_id)).toBe(enteredAt.toISOString());
    expect([...byId.values()].filter((v) => v === null)).toHaveLength(1);
  });
});
