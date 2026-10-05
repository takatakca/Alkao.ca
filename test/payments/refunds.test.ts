import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyRefund } from "../../src/domain/index.js";
import { adm, call, pub, testApp, tokenFor, type TestApp } from "../helpers/app.js";
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
  app = testApp(db.pool, { paymentGateway: gateway, onboarding: { refreshUrl: "https://app.takatak.ca/alkao/stripe/refresh", returnUrl: "https://app.takatak.ca/alkao/stripe/done" } });
});

afterAll(async () => {
  await db?.drop();
});

const typeId = (t: TenantFixture, code: string) => t.types.find((x) => x.code === code)!.id;

/** A paid order through the real checkout + webhook path. */
async function paidOrder(t: TenantFixture, items: Record<string, number>) {
  const h = await call(app, "POST", `${pub(t.clientId, t.brandId)}/holds`, {
    body: { sessionId: t.sessionId, items: Object.entries(items).map(([code, quantity]) => ({ ticketTypeId: typeId(t, code), quantity })) },
  });
  const co = await call(app, "POST", `${pub(t.clientId, t.brandId)}/holds/${h.body.hold.id}/checkout`, {
    headers: { "x-alkao-hold-token": h.body.hold.token },
    body: { buyer: { email: "jean@example.com" }, successUrl: `${t.returnOrigin}/ok`, cancelUrl: `${t.returnOrigin}/ko` },
  });
  const sessionId = co.body.checkoutUrl.split("/").pop();
  const e = signedStripeEvent("checkout.session.completed", completedSession(sessionId, h.body.hold.quote.totalCents, `pi_test${randomUUID().slice(0, 8)}`), t.stripeAccountId);
  const hook = await call(app, "POST", "/v1/webhooks/stripe", { body: e.body, headers: { "stripe-signature": e.signature } });
  expect(hook.body.outcome).toBe("processed");
  const { rows } = await db.pool.query(`SELECT id, total_cents, commission_cents FROM public.ticketing_orders WHERE id = $1`, [co.body.order.id]);
  const { rows: tickets } = await db.pool.query(`SELECT id FROM public.ticketing_tickets WHERE order_id = $1 ORDER BY created_at, id`, [co.body.order.id]);
  return { id: rows[0].id as string, total: rows[0].total_cents as number, commission: rows[0].commission_cents as number, tickets: tickets.map((x) => x.id as string) };
}

async function orderState(id: string) {
  const { rows } = await db.pool.query(
    `SELECT status, refunded_cents, commission_refunded_cents,
            (SELECT count(*)::int FROM public.ticketing_tickets t WHERE t.order_id = o.id AND t.status = 'valid') AS valid
     FROM public.ticketing_orders o WHERE id = $1`,
    [id],
  );
  return rows[0];
}

const refundsUrl = (t: TenantFixture, orderId: string) => `${adm(t.clientId, t.brandId)}/orders/${orderId}/refunds`;

describe("refunds — V1 commission policy through Stripe", () => {
  it("partial refunds return a proportional commission; the last one returns exactly the rest", async () => {
    const t = seed.havana;
    const owner = await tokenFor(seed.users.havanaOwner);
    const order = await paidOrder(t, { GENERAL: 2, CHILD: 2 });
    const before = (await db.pool.query(`SELECT sold_count FROM public.ticketing_sessions WHERE id = $1`, [t.sessionId])).rows[0].sold_count;

    const first = await call(app, "POST", refundsUrl(t, order.id), { token: owner, body: { amountCents: 2000, ticketIds: [order.tickets[0]], reason: "Un enfant malade" } });
    expect(first.status).toBe(201);
    const expected = applyRefund({ totalPaidCents: order.total, commissionCents: order.commission, refundedCents: 0, commissionRefundedCents: 0 }, 2000);
    expect(first.body.refund).toMatchObject({ status: "succeeded", amountCents: 2000, commissionRefundCents: expected.commissionRefundCents });
    expect(await orderState(order.id)).toMatchObject({ status: "partially_refunded", refunded_cents: 2000, valid: 3 });
    const after = (await db.pool.query(`SELECT sold_count FROM public.ticketing_sessions WHERE id = $1`, [t.sessionId])).rows[0].sold_count;
    expect(after).toBe(before - 1); // the voided seat is back on sale

    const rest = await call(app, "POST", refundsUrl(t, order.id), { token: owner, body: {} });
    expect(rest.body.refund.amountCents).toBe(order.total - 2000);
    expect(expected.commissionRefundCents + rest.body.refund.commissionRefundCents).toBe(order.commission);
    expect(await orderState(order.id)).toMatchObject({ status: "refunded", refunded_cents: order.total, commission_refunded_cents: order.commission, valid: 0 });

    expect(gateway.callsOf("refundPayment").map((r: any) => r.amountCents)).toEqual([2000, order.total - 2000]);
    expect(gateway.callsOf("refundApplicationFee").map((r: any) => r.amountCents)).toEqual([expected.commissionRefundCents, order.commission - expected.commissionRefundCents]);

    const list = await call(app, "GET", refundsUrl(t, order.id), { token: owner });
    expect(list.body.refunds.map((r: { status: string }) => r.status)).toEqual(["succeeded", "succeeded"]);
    expect((await call(app, "POST", refundsUrl(t, order.id), { token: owner, body: {} })).body.error.code).toBe("order_not_refundable");
  });

  it("survives a provider failure: retry completes without refunding twice", async () => {
    const t = seed.havana;
    const owner = await tokenFor(seed.users.havanaOwner);
    const order = await paidOrder(t, { GENERAL: 1 });
    gateway.failNext("refundApplicationFee");
    const failed = await call(app, "POST", refundsUrl(t, order.id), { token: owner, body: {} });
    expect(failed.status).toBe(502);
    expect(failed.body.error.code).toBe("refund_provider_error");
    const refundId = failed.body.error.details.refundId;
    expect(await orderState(order.id)).toMatchObject({ status: "paid", refunded_cents: 0 });

    // Another refund cannot start while this one is in flight.
    expect((await call(app, "POST", refundsUrl(t, order.id), { token: owner, body: { amountCents: 1 } })).body.error.code).toBe("refund_in_progress");

    const retried = await call(app, "POST", `${adm(t.clientId, t.brandId)}/refunds/${refundId}/retry`, { token: owner });
    expect(retried.body.refund.status).toBe("succeeded");
    expect(gateway.callsOf("refundPayment")).toHaveLength(1); // buyer refund recorded before the failure: not repeated
    const feeKeys = gateway.callsOf("refundApplicationFee").map((r: any) => r.idempotencyKey);
    expect(feeKeys).toHaveLength(2);
    expect(feeKeys[0]).toBe(feeKeys[1]);
    expect(await orderState(order.id)).toMatchObject({ status: "refunded", refunded_cents: order.total, commission_refunded_cents: order.commission });
  });

  it("refuses refunds above what remains, of unknown tickets, or of unpaid orders", async () => {
    const t = seed.festi;
    const owner = await tokenFor(seed.users.festiOwner);
    const order = await paidOrder(t, { GENERAL: 1 });
    const over = await call(app, "POST", refundsUrl(t, order.id), { token: owner, body: { amountCents: order.total + 1 } });
    expect(over.body.error).toEqual({ code: "refund_exceeds_paid", details: { refundable: order.total, requested: order.total + 1 } });
    const foreign = await call(app, "POST", refundsUrl(t, order.id), { token: owner, body: { amountCents: 100, ticketIds: [seed.havana.ticketIds[1]] } });
    expect(foreign.body.error.code).toBe("invalid_ticket");
    // seed.festi.orderId was paid without a Stripe payment (not refundable through Stripe).
    expect((await call(app, "POST", refundsUrl(t, t.orderId), { token: owner, body: {} })).body.error.code).toBe("order_not_refundable");
    expect(gateway.callsOf("refundPayment")).toHaveLength(0);
  });

  it("limits refunds to owner, admin and manager of the order's own Client", async () => {
    const t = seed.havana;
    const order = await paidOrder(t, { GENERAL: 1 });
    const staff = await tokenFor(seed.users.havanaStaff);
    const viewer = await tokenFor(seed.users.both); // viewer at Havana
    const festiOwner = await tokenFor(seed.users.festiOwner);
    expect((await call(app, "POST", refundsUrl(t, order.id), { token: staff, body: {} })).status).toBe(403);
    expect((await call(app, "POST", refundsUrl(t, order.id), { token: viewer, body: {} })).status).toBe(403);
    expect((await call(app, "POST", refundsUrl(t, order.id), { token: festiOwner, body: {} })).status).toBe(404);
    const viaFesti = await call(app, "POST", refundsUrl(seed.festi, order.id), { token: festiOwner, body: {} });
    expect(viaFesti.body.error.code).toBe("order_not_found");
    expect(gateway.callsOf("refundPayment")).toHaveLength(0);
  });

  it("keeps the order's refund totals equal to its refund ledger", async () => {
    const t = seed.havana;
    const order = await paidOrder(t, { GENERAL: 1 });
    const tx = await db.pool.connect();
    try {
      await tx.query("BEGIN");
      await tx.query(`UPDATE public.ticketing_orders SET status = 'partially_refunded', refunded_cents = 100 WHERE id = $1`, [order.id]);
      const commit = await tx.query("COMMIT").then(() => null, (e: { code?: string; message?: string }) => e);
      expect(commit).toMatchObject({ code: "23514", message: "order_refund_ledger_mismatch" });
    } finally {
      await tx.query("ROLLBACK").catch(() => undefined);
      tx.release();
    }
  });
});

describe("Stripe account onboarding", () => {
  it("lets owners and admins connect the Client's own Stripe account, once", async () => {
    const clientId = randomUUID();
    const brandId = randomUUID();
    const owner = randomUUID();
    const manager = randomUUID();
    await db.pool.query(`INSERT INTO public.ticketing_clients (id, name) VALUES ($1, 'Nouveau Client')`, [clientId]);
    await db.pool.query(`INSERT INTO public.ticketing_brands (id, client_id, name) VALUES ($1, $2, 'Marque')`, [brandId, clientId]);
    await db.pool.query(`INSERT INTO public.ticketing_entitlements (client_id, brand_id, status, contract_version) VALUES ($1, $2, 'active', 'alkao.control.v1')`, [clientId, brandId]);
    await db.pool.query(`INSERT INTO public.ticketing_memberships (client_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'manager')`, [clientId, owner, manager]);
    const base = adm(clientId, brandId);

    expect((await call(app, "POST", `${base}/payments/onboarding`, { token: await tokenFor(manager) })).status).toBe(403);
    const ownerToken = await tokenFor(owner);
    expect((await call(app, "GET", `${base}/payments/account`, { token: ownerToken })).body.account).toEqual({ connected: false });

    const first = await call(app, "POST", `${base}/payments/onboarding`, { token: ownerToken });
    expect(first.status).toBe(201);
    expect(first.body.onboarding.url).toMatch(/^https:\/\/connect\.stripe\.com\//);
    await call(app, "POST", `${base}/payments/onboarding`, { token: ownerToken });
    expect(gateway.callsOf("createConnectedAccount")).toHaveLength(1);
    expect(gateway.callsOf("createOnboardingLink")).toEqual([
      expect.objectContaining({ returnUrl: "https://app.takatak.ca/alkao/stripe/done" }),
      expect.objectContaining({ returnUrl: "https://app.takatak.ca/alkao/stripe/done" }),
    ]);

    const status = await call(app, "GET", `${base}/payments/account`, { token: ownerToken });
    expect(status.body.account).toMatchObject({ connected: true, chargesEnabled: false });

    const bad = await call(app, "PUT", `${base}/payments/settings`, { token: ownerToken, body: { checkoutReturnOrigins: ["http://insecure.example"] } });
    expect(bad.status).toBe(400);
    const saved = await call(app, "PUT", `${base}/payments/settings`, { token: ownerToken, body: { checkoutReturnOrigins: ["https://billets.example", "https://billets.example"] } });
    expect(saved.body.settings).toEqual({ checkoutReturnOrigins: ["https://billets.example"] });

    const { rows } = await db.pool.query(`SELECT action FROM public.ticketing_audit_log WHERE client_id = $1 ORDER BY id`, [clientId]);
    expect(rows.map((r) => r.action)).toEqual(["payments.account_created", "payments.settings_updated"]);
  });

  it("answers 503 when onboarding URLs are not configured", async () => {
    const noOnboarding = testApp(db.pool, { paymentGateway: gateway, onboarding: null });
    const res = await call(noOnboarding, "POST", `${adm(seed.havana.clientId, seed.havana.brandId)}/payments/onboarding`, {
      token: await tokenFor(seed.users.havanaOwner),
    });
    expect(res).toEqual({ status: 503, body: { error: { code: "payments_not_configured" } } });
  });
});
