import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EmailMessage, EmailSender } from "../../src/delivery/email.js";
import { deliverTicketEmails } from "../../src/delivery/worker.js";
import { salesReport } from "../../src/ops/reports.js";
import { adm, call, pub, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { seedAfterSale, seedPaidOrder, seedTwoTenants, TEST_CREDENTIAL_SECRET, type SeedResult, type TenantFixture } from "../helpers/seed.js";

/**
 * Run 20: a buyer's personal data on request (Québec Law 25). Export everything ALKAO holds
 * about them, or anonymize them, without touching the money or the gate history.
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

/** A paid order for a session that is already over, by a buyer with a name and a phone. */
async function pastOrder(t: TenantFixture, email: string) {
  const { rows } = await db.pool.query<{ id: string }>(
    `INSERT INTO public.ticketing_sessions (client_id, brand_id, event_id, starts_at, ends_at, capacity, status)
     VALUES ($1, $2, $3, now() - interval '3 days', now() - interval '3 days' + interval '3 hours', 50, 'on_sale') RETURNING id`,
    [t.clientId, t.brandId, t.eventId],
  );
  const order = await seedPaidOrder(db.pool, { ...t, sessionId: rows[0]!.id }, email);
  await db.pool.query(`UPDATE public.ticketing_buyers SET full_name = 'Marie Tremblay', phone = '514-555-0199' WHERE id = $1`, [order.buyerId]);
  return { ...order, sessionId: rows[0]!.id };
}

const exportUrl = (t: TenantFixture, orderId: string) => `${adm(t.clientId, t.brandId)}/orders/${orderId}/buyer/export`;
const anonymizeUrl = (t: TenantFixture, orderId: string) => `${adm(t.clientId, t.brandId)}/orders/${orderId}/buyer/anonymize`;
const buyer = async (id: string) =>
  (await db.pool.query(`SELECT email, full_name, phone, language FROM public.ticketing_buyers WHERE id = $1`, [id])).rows[0];

describe("buyer data export", () => {
  it("gives the Client everything ALKAO holds about the buyer, as a JSON download, and logs it", async () => {
    const t = seed.havana;
    // Two orders by the same buyer, for two sessions: the export covers both.
    const second = await seedPaidOrder(db.pool, t, "export@example.com");
    const order = await pastOrder(t, "export@example.com");
    const res = await app.request(exportUrl(t, order.orderId), { headers: { authorization: `Bearer ${await tokenFor(seed.users.havanaOwner)}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="alkao-donnees-acheteur-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const data = (await res.json()) as any;
    expect(data.format).toBe("alkao.buyer-export.v1");
    expect(data.buyer).toMatchObject({ email: "export@example.com", fullName: "Marie Tremblay", phone: "514-555-0199", language: "fr", anonymizedAt: null });
    expect(data.orders).toHaveLength(2);
    expect(data.orders[0].tickets.length).toBeGreaterThan(0);
    expect(data.orders[0]).toMatchObject({ status: "paid", currency: "CAD" });
    expect(data.orders.map((o: { totalCents: number }) => o.totalCents).every((n: number) => n > 0)).toBe(true);
    expect(second.orderId).not.toBe(order.orderId);
    const { rows } = await db.pool.query(`SELECT data FROM public.ticketing_audit_log WHERE action = 'buyer.exported' AND entity_id = $1`, [order.orderId]);
    expect(rows).toEqual([{ data: { orders: 2 } }]);
  });

  it("is for owners, admins and managers of this Client only", async () => {
    const t = seed.havana;
    const order = await pastOrder(t, "acces@example.com");
    expect((await call(app, "GET", exportUrl(t, order.orderId), { token: await tokenFor(seed.users.havanaStaff) })).status).toBe(403);
    // A viewer at Havana (manager at FESTI-ICE): no buyer data at Havana.
    expect((await call(app, "GET", exportUrl(t, order.orderId), { token: await tokenFor(seed.users.both) })).status).toBe(403);
    const f = seed.festi;
    expect((await call(app, "GET", exportUrl(f, order.orderId), { token: await tokenFor(seed.users.festiOwner) })).status).toBe(404);
  });
});

describe("buyer anonymization", () => {
  it("replaces the buyer's identity, keeps the money and the gate history, and cuts the links and emails", async () => {
    const t = seed.havana;
    const owner = await tokenFor(seed.users.havanaOwner);
    const order = await pastOrder(t, "oubli@example.com");
    const before = await salesReport(db.pool, t, {});
    // A staff note on a refund, a queued email and the buyer's personal link.
    await db.pool.query(
      `INSERT INTO public.ticketing_refunds (client_id, brand_id, event_id, order_id, amount_cents, commission_refund_cents, reason, requested_by, status)
       VALUES ($1, $2, $3, $4, 100, 0, 'Enfant malade', 'user', 'pending')`,
      [t.clientId, t.brandId, t.eventId, order.orderId],
    );
    await db.pool.query(`UPDATE public.ticketing_refunds SET status = 'canceled' WHERE order_id = $1`, [order.orderId]);
    const token = `secret-${order.orderId}`;
    const link = await call(app, "GET", `${pub(t.clientId, t.brandId)}/orders/${order.orderId}`, { headers: { "x-alkao-order-token": token } });
    expect(link.status).toBe(200);
    const { rows: queued } = await db.pool.query(`SELECT status FROM public.ticketing_email_outbox WHERE order_id = $1`, [order.orderId]);
    expect(queued.map((r) => r.status)).toContain("pending");

    const res = await call(app, "POST", anonymizeUrl(t, order.orderId), { token: owner });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ alreadyAnonymized: false });

    expect(await buyer(order.buyerId)).toEqual({ email: `anonyme-${order.buyerId}@anonyme.invalid`, full_name: null, phone: null, language: "fr" });
    const { rows: notes } = await db.pool.query(`SELECT reason FROM public.ticketing_refunds WHERE order_id = $1`, [order.orderId]);
    expect(notes).toEqual([{ reason: null }]);
    const { rows: emails } = await db.pool.query(`SELECT status, last_error FROM public.ticketing_email_outbox WHERE order_id = $1`, [order.orderId]);
    expect(emails).toEqual([{ status: "skipped", last_error: "buyer_anonymized" }]);
    expect((await call(app, "GET", `${pub(t.clientId, t.brandId)}/orders/${order.orderId}`, { headers: { "x-alkao-order-token": token } })).status).toBe(404);

    // Orders, amounts, tickets and scans are untouched: the sales report is the same.
    const after = await salesReport(db.pool, t, {});
    expect(after.totals).toEqual(before.totals);
    const o = (await call(app, "GET", `${adm(t.clientId, t.brandId)}/orders/${order.orderId}`, { token: owner })).body.order;
    expect(o.status).toBe("paid");
    expect(o.buyerName).toBeNull();
    expect(o.buyerEmail).toBe(`anonyme-${order.buyerId}@anonyme.invalid`);
    expect(o.buyerAnonymizedAt).not.toBeNull();

    // Logged without anything personal; asking again changes nothing.
    const { rows: log } = await db.pool.query(`SELECT data FROM public.ticketing_audit_log WHERE action = 'buyer.anonymized' AND entity_id = $1`, [order.buyerId]);
    expect(log).toHaveLength(1);
    expect(JSON.stringify(log[0].data)).not.toMatch(/oubli|Tremblay|514/);
    const again = await call(app, "POST", anonymizeUrl(t, order.orderId), { token: owner });
    expect(again.body).toMatchObject({ alreadyAnonymized: true });
    const exported = await call(app, "GET", exportUrl(t, order.orderId), { token: owner });
    expect(exported.body.buyer).toMatchObject({ fullName: null, phone: null, anonymizedAt: expect.any(String) });
    expect(JSON.stringify(exported.body)).not.toMatch(/oubli@example|Tremblay|514-555/);
  });

  it("never sends another email to an anonymized buyer", async () => {
    const t = seed.havana;
    const owner = await tokenFor(seed.users.havanaOwner);
    const order = await pastOrder(t, "plusdemail@example.com");
    expect((await call(app, "POST", anonymizeUrl(t, order.orderId), { token: owner })).status).toBe(200);
    const resend = await call(app, "POST", `${adm(t.clientId, t.brandId)}/orders/${order.orderId}/tickets-email`, { token: owner });
    expect(resend.status).toBe(409);
    expect(resend.body.error.code).toBe("buyer_anonymized");

    // Even an email queued some other way is dropped by the worker.
    await db.pool.query(`UPDATE public.ticketing_email_outbox SET status = 'skipped' WHERE status = 'pending'`);
    await db.pool.query(
      `INSERT INTO public.ticketing_email_outbox (client_id, brand_id, event_id, order_id, kind)
       VALUES ($1, $2, $3, $4, 'session_cancelled')`,
      [t.clientId, t.brandId, t.eventId, order.orderId],
    );
    const sent: EmailMessage[] = [];
    const sender: EmailSender = { send: async (m) => (sent.push(m), "msg_1") };
    const result = await deliverTicketEmails(db.pool, { sender, publicUrl: "https://billets.alkao.test", credentialMasterSecret: TEST_CREDENTIAL_SECRET });
    expect(sent).toEqual([]);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    const { rows } = await db.pool.query(`SELECT last_error FROM public.ticketing_email_outbox WHERE order_id = $1 AND kind = 'session_cancelled'`, [order.orderId]);
    expect(rows).toEqual([{ last_error: "buyer_anonymized" }]);
  });

  it("waits while the buyer still has a ticket to use, a refund in progress or an open dispute", async () => {
    const t = seed.festi;
    const owner = await tokenFor(seed.users.festiOwner);
    const upcoming = await seedPaidOrder(db.pool, t, "bientot@example.com");
    const res = await call(app, "POST", anonymizeUrl(t, upcoming.orderId), { token: owner });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("buyer_has_upcoming_tickets");

    const refunding = await pastOrder(t, "rembourse@example.com");
    await db.pool.query(
      `INSERT INTO public.ticketing_refunds (client_id, brand_id, event_id, order_id, amount_cents, commission_refund_cents, requested_by)
       VALUES ($1, $2, $3, $4, 100, 0, 'user')`,
      [t.clientId, t.brandId, t.eventId, refunding.orderId],
    );
    expect((await call(app, "POST", anonymizeUrl(t, refunding.orderId), { token: owner })).body.error.code).toBe("refund_in_progress");

    const disputed = await pastOrder(t, "litige@example.com");
    await seedAfterSale(db.pool, t, disputed.orderId);
    expect((await call(app, "POST", anonymizeUrl(t, disputed.orderId), { token: owner })).body.error.code).toBe("dispute_open");
    expect((await buyer(disputed.buyerId)).email).toBe("litige@example.com");
  });

  it("is for owners and admins only: managers can export but not anonymize", async () => {
    const f = seed.festi;
    const order = await pastOrder(f, "gerant@example.com");
    const manager = await tokenFor(seed.users.both); // manager at FESTI-ICE
    expect((await call(app, "GET", exportUrl(f, order.orderId), { token: manager })).status).toBe(200);
    expect((await call(app, "POST", anonymizeUrl(f, order.orderId), { token: manager })).status).toBe(403);
    expect((await call(app, "POST", anonymizeUrl(seed.havana, order.orderId), { token: await tokenFor(seed.users.havanaOwner) })).status).toBe(404);
    expect((await buyer(order.buyerId)).email).toBe("gerant@example.com");
  });
});
