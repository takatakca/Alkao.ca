import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adm, call, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { seedAfterSale, seedPaidOrder, seedTwoTenants, TEST_CREDENTIAL_SECRET, type SeedResult, type TenantFixture } from "../helpers/seed.js";

/**
 * Run 21: the staff to-do list, and tickets cancelled without a refund. Each item stays on
 * the list while someone can act on it, and leaves it once handled.
 */
let db: TestDatabase;
let seed: SeedResult;
let app: TestApp;

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  app = testApp(db.pool, { credentialMasterSecret: TEST_CREDENTIAL_SECRET });
});

afterAll(async () => {
  await db?.drop();
});

const attention = async (t: TenantFixture, user: string) =>
  call(app, "GET", `${adm(t.clientId, t.brandId)}/attention`, { token: await tokenFor(user) });
const voidUrl = (t: TenantFixture, orderId: string) => `${adm(t.clientId, t.brandId)}/orders/${orderId}/tickets/void`;
const refs = (items: { reference?: string }[]) => items.map((i) => i.reference);

async function orderFor(t: TenantFixture, email: string, startsIn: string) {
  const { rows } = await db.pool.query<{ id: string }>(
    `INSERT INTO public.ticketing_sessions (client_id, brand_id, event_id, starts_at, capacity, status)
     VALUES ($1, $2, $3, now() + $4::interval, 50, 'on_sale') RETURNING id`,
    [t.clientId, t.brandId, t.eventId, startsIn],
  );
  const order = await seedPaidOrder(db.pool, { ...t, sessionId: rows[0]!.id }, email);
  const { rows: o } = await db.pool.query<{ reference: string }>(`SELECT reference FROM public.ticketing_orders WHERE id = $1`, [order.orderId]);
  return { ...order, sessionId: rows[0]!.id, reference: o[0]!.reference };
}

describe("the to-do list", () => {
  it("starts empty, and lists what waits on staff with what is needed to act", async () => {
    const t = seed.festi;
    const owner = seed.users.festiOwner;
    expect((await attention(t, owner)).body.attention.total).toBe(0);

    // A refund Stripe failed on, an older one that never settled, and a fresh one (not stuck).
    const failed = await orderFor(t, "rembourse@example.com", "10 days");
    const slow = await orderFor(t, "lent@example.com", "10 days");
    const fresh = await orderFor(t, "frais@example.com", "10 days");
    const refund = (orderId: string, extra: string) =>
      db.pool.query(
        `INSERT INTO public.ticketing_refunds (client_id, brand_id, event_id, order_id, amount_cents, commission_refund_cents, requested_by, last_error, created_at)
         VALUES ($1, $2, $3, $4, 500, 0, 'user', ${extra})`,
        [t.clientId, t.brandId, t.eventId, orderId],
      );
    await refund(failed.orderId, "'refund_payment', now()");
    await refund(slow.orderId, "NULL, now() - interval '1 hour'");
    await refund(fresh.orderId, "NULL, now()");

    // Tickets that never reached the buyer, for a session still to come; and for one already over.
    const unsent = await orderFor(t, "pasrecu@example.com", "5 days");
    const over = await orderFor(t, "passe@example.com", "-5 days");
    await db.pool.query(
      `UPDATE public.ticketing_email_outbox SET status = 'failed', last_error = 'mailbox_full' WHERE order_id = ANY($1::uuid[])`,
      [[unsent.orderId, over.orderId]],
    );

    // A dispute and a refund made in Stripe on the same order.
    const disputed = await orderFor(t, "conteste@example.com", "3 days");
    await seedAfterSale(db.pool, t, disputed.orderId, 1000);

    // A cancelled session where one buyer could not be refunded.
    const cancelled = await orderFor(t, "annule@example.com", "20 days");
    const { rows: job } = await db.pool.query<{ id: string }>(
      `INSERT INTO public.ticketing_session_cancellations (client_id, brand_id, event_id, session_id, reason)
       VALUES ($1, $2, $3, $4, 'pluie') RETURNING id`,
      [t.clientId, t.brandId, t.eventId, cancelled.sessionId],
    );
    await db.pool.query(
      `INSERT INTO public.ticketing_session_cancellation_orders (cancellation_id, client_id, brand_id, event_id, order_id, status, last_error, attempts)
       VALUES ($1, $2, $3, $4, $5, 'failed', 'refund_provider_error', 5)`,
      [job[0]!.id, t.clientId, t.brandId, t.eventId, cancelled.orderId],
    );

    const a = (await attention(t, owner)).body.attention;
    expect(refs(a.refunds).sort()).toEqual([failed.reference, slow.reference].sort());
    expect(a.refunds.find((r: { reference: string }) => r.reference === failed.reference)).toMatchObject({ lastError: "refund_payment", amountCents: 500 });
    expect(refs(a.emails)).toEqual([unsent.reference]);
    expect(a.emails[0]).toMatchObject({ kind: "order_tickets", buyerEmail: "pasrecu@example.com", lastError: "mailbox_full" });
    expect(refs(a.disputes)).toEqual([disputed.reference]);
    expect(a.outsideRefunds).toEqual([expect.objectContaining({ reference: disputed.reference, outsideCents: 1000 })]);
    expect(a.cancellations).toEqual([expect.objectContaining({ sessionId: cancelled.sessionId, eventId: t.eventId, failed: 1, pending: 0 })]);
    expect(a.total).toBe(6);

    // The other Client's list is untouched; gate staff cannot read it.
    expect((await attention(seed.havana, seed.users.havanaOwner)).body.attention.total).toBe(0);
    expect((await attention(seed.havana, seed.users.havanaStaff)).status).toBe(403);
    expect((await attention(t, seed.users.havanaOwner)).status).toBe(404);
  });
});

describe("cancelling tickets without a refund", () => {
  it("voids the chosen tickets, frees their seats, revokes their QR codes and clears the list", async () => {
    const t = seed.havana;
    const order = await orderFor(t, "stripe-rembourse@example.com", "4 days");
    await seedAfterSale(db.pool, t, order.orderId, 2995);
    expect(refs((await attention(t, seed.users.havanaOwner)).body.attention.outsideRefunds)).toEqual([order.reference]);
    const sold = async () => (await db.pool.query(`SELECT sold_count FROM public.ticketing_sessions WHERE id = $1`, [order.sessionId])).rows[0].sold_count;
    const before = await sold();

    const manager = await tokenFor(seed.users.havanaOwner);
    const res = await call(app, "POST", voidUrl(t, order.orderId), { token: manager, body: { ticketIds: order.ticketIds, reason: "Remboursé dans Stripe" } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ voided: order.ticketIds.length });
    expect(await sold()).toBe(before - order.ticketIds.length);
    const { rows } = await db.pool.query(
      `SELECT k.status, k.void_reason, c.status AS credential FROM public.ticketing_tickets k
       JOIN public.ticketing_credentials c ON c.ticket_id = k.id WHERE k.order_id = $1`,
      [order.orderId],
    );
    expect(rows.every((r) => r.status === "void" && r.void_reason === "admin" && r.credential === "revoked")).toBe(true);
    const { rows: log } = await db.pool.query(`SELECT data FROM public.ticketing_audit_log WHERE action = 'tickets.voided' AND entity_id = $1`, [order.orderId]);
    expect(log[0].data).toMatchObject({ reason: "Remboursé dans Stripe" });
    // Nothing left to act on: the order leaves the list. The money and order status are untouched.
    expect((await attention(t, seed.users.havanaOwner)).body.attention.outsideRefunds).toEqual([]);
    const { rows: o } = await db.pool.query(`SELECT status, refunded_cents FROM public.ticketing_orders WHERE id = $1`, [order.orderId]);
    expect(o[0]).toEqual({ status: "paid", refunded_cents: 0 });
  });

  it("refuses tickets of another order, tickets already void and tickets already used", async () => {
    const t = seed.havana;
    const owner = await tokenFor(seed.users.havanaOwner);
    const a = await orderFor(t, "a@example.com", "6 days");
    const b = await orderFor(t, "b@example.com", "6 days");
    const post = (orderId: string, ticketIds: string[]) => call(app, "POST", voidUrl(t, orderId), { token: owner, body: { ticketIds } });

    expect((await post(a.orderId, [b.ticketIds[0]!])).body.error.code).toBe("invalid_ticket");
    expect((await post(a.orderId, [a.ticketIds[0]!])).status).toBe(200);
    expect((await post(a.orderId, [a.ticketIds[0]!])).body.error.code).toBe("invalid_ticket");

    const { rows } = await db.pool.query<{ id: string }>(`SELECT id FROM public.ticketing_credentials WHERE ticket_id = $1`, [a.ticketIds[1]]);
    await db.pool.query(
      `INSERT INTO public.ticketing_scans (client_id, brand_id, event_id, session_id, credential_id, ticket_id, result, scanned_by, scanned_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'admitted', $7, now())`,
      [t.clientId, t.brandId, t.eventId, a.sessionId, rows[0]!.id, a.ticketIds[1], seed.users.havanaStaff],
    );
    const used = await post(a.orderId, [a.ticketIds[1]!]);
    expect(used.status).toBe(409);
    expect(used.body.error.code).toBe("ticket_already_used");

    // Gate staff cannot cancel tickets; nor can another Client.
    expect((await call(app, "POST", voidUrl(t, a.orderId), { token: await tokenFor(seed.users.havanaStaff), body: { ticketIds: [a.ticketIds[2]] } })).status).toBe(403);
    expect((await call(app, "POST", voidUrl(seed.festi, a.orderId), { token: await tokenFor(seed.users.festiOwner), body: { ticketIds: [a.ticketIds[2]] } })).status).toBe(404);
    expect((await post(a.orderId, [])).status).toBe(400);
  });
});
