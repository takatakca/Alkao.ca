import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseReservationsReport } from "../../ops-ui/reservations-csv.js";
import { exchangeOrder } from "../../src/ops/exchange.js";
import { syncTicketBuyers } from "../../src/ops/customer-sync.js";
import { anonymizeBuyer } from "../../src/ops/privacy.js";
import { adm, call, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { line, report } from "../helpers/reservations.js";
import { seedPaidOrder, seedTwoTenants, type SeedResult } from "../helpers/seed.js";

/** Run 43: ALKAO ticket buyers join the customer file. Made-up people only. */
let db: TestDatabase;
let seed: SeedResult;
let app: TestApp;

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  app = testApp(db.pool);
});

afterAll(async () => {
  await db?.drop();
});

const base = () => adm(seed.havana.clientId, seed.havana.brandId);
async function customerByEmail(email: string) {
  const token = await tokenFor(seed.users.havanaOwner);
  const list = await call(app, "GET", `${base()}/customers?q=${encodeURIComponent(email)}`, { token });
  expect(list.body.customers, email).toHaveLength(1);
  return (await call(app, "GET", `${base()}/customers/${list.body.customers[0].id}`, { token })).body.customer;
}
const bookingOf = async (orderId: string) =>
  (await db.pool.query(`SELECT * FROM public.ticketing_customer_bookings WHERE source = 'alkao_order' AND source_ref = $1`, [orderId])).rows[0];

describe("ticket buyers in the customer file", () => {
  it("turns each paid order into a ticket booking on the buyer's customer, once", async () => {
    expect(await syncTicketBuyers(db.pool)).toBeGreaterThanOrEqual(2);
    expect(await syncTicketBuyers(db.pool)).toBe(0); // nothing new
    const { rows } = await db.pool.query(`SELECT b.email FROM public.ticketing_orders o JOIN public.ticketing_buyers b ON b.id = o.buyer_id WHERE o.id = $1`, [seed.havana.orderId]);
    const customer = await customerByEmail(rows[0].email);
    expect(customer).toMatchObject({ firstName: "Test", lastName: "Buyer", segment: "upcoming", emailPermission: "implied", upcoming: 1 });
    expect(customer.bookings[0]).toMatchObject({ source: "alkao_order", sourceRef: seed.havana.orderId, category: "ticket", adults: 4, state: "upcoming" });
    expect(customer.bookings[0].item).toBe("Havana Resort — Événements 2026-2027");
    // Another Client's order stays in that Client's file.
    const { rows: festi } = await db.pool.query(`SELECT client_id FROM public.ticketing_customer_bookings WHERE source_ref = $1`, [seed.festi.orderId]);
    expect(festi).toEqual([{ client_id: seed.festi.clientId }]);
  });

  it("joins the customer already known from the reservations, by the same e-mail and name", async () => {
    const email = "famille-test@example.com";
    const rows = parseReservationsReport(report([line("8001", "CHALET 4", "2025-07-01", "2025-07-03", { Nom: "Buyer", Prénom: "Test", Courriel: email })])).rows;
    const token = await tokenFor(seed.users.havanaOwner);
    expect((await call(app, "POST", `${base()}/customers/import`, { token, body: { reportDate: "2025-06-20", rows } })).status).toBe(200);
    await seedPaidOrder(db.pool, seed.havana, email);
    await syncTicketBuyers(db.pool);
    const customer = await customerByEmail(email);
    expect(customer.bookings.map((b: { category: string }) => b.category).sort()).toEqual(["chalet", "ticket"]);
    expect(customer).toMatchObject({ visits: 1, upcoming: 1, favoriteCategory: "chalet" });
  });

  it("follows a session change and a cancelled session", async () => {
    const h = seed.havana;
    const { rows: s } = await db.pool.query<{ id: string }>(
      `INSERT INTO public.ticketing_sessions (client_id, brand_id, event_id, starts_at, capacity, status)
       VALUES ($1, $2, $3, now() + interval '60 days', 100, 'on_sale') RETURNING id`,
      [h.clientId, h.brandId, h.eventId],
    );
    const order = await seedPaidOrder(db.pool, h, "change-test@example.com");
    await syncTicketBuyers(db.pool);
    const before = await bookingOf(order.orderId);
    await exchangeOrder(db.pool, { clientId: h.clientId, brandId: h.brandId }, order.orderId, s[0]!.id, { type: "public", id: null });
    expect(await syncTicketBuyers(db.pool)).toBeGreaterThanOrEqual(1);
    const after = await bookingOf(order.orderId);
    expect(new Date(after.starts_on).getTime() - new Date(before.starts_on).getTime()).toBeGreaterThanOrEqual(29 * 86_400_000);
    expect(after.cancelled_on).toBeNull();

    await db.pool.query(`UPDATE public.ticketing_sessions SET status = 'cancelled' WHERE id = $1`, [s[0]!.id]);
    expect(await syncTicketBuyers(db.pool)).toBeGreaterThanOrEqual(1);
    expect((await bookingOf(order.orderId)).cancelled_on).not.toBeNull();
    expect((await customerByEmail("change-test@example.com")).segment).toBe("cancelled");
  });

  it("clears the customer when the buyer is anonymized, and never brings them back", async () => {
    const h = seed.havana;
    const order = await seedPaidOrder(db.pool, h, "oublie-moi@example.com");
    await syncTicketBuyers(db.pool);
    const { rows: c } = await db.pool.query<{ id: string }>(`SELECT customer_id AS id FROM public.ticketing_customer_bookings WHERE source_ref = $1`, [order.orderId]);
    // Law 25 is refused while the session is ahead: let it pass.
    await db.pool.query(`UPDATE public.ticketing_sessions SET starts_at = now() - interval '2 days' WHERE id = $1`, [h.sessionId]);
    const done = await anonymizeBuyer(db.pool, { clientId: h.clientId, brandId: h.brandId }, order.orderId, { type: "user", id: null });
    expect(done.alreadyAnonymized).toBe(false);
    const { rows } = await db.pool.query(`SELECT email, first_name, anonymized_at FROM public.ticketing_customers WHERE id = $1`, [c[0]!.id]);
    expect(rows[0]).toMatchObject({ email: null, first_name: null });
    expect(rows[0].anonymized_at).not.toBeNull();
    const { rows: audit } = await db.pool.query(`SELECT data FROM public.ticketing_audit_log WHERE action = 'buyer.anonymized' ORDER BY id DESC LIMIT 1`);
    expect(audit[0].data).toMatchObject({ customersAnonymized: 1 });
    // The anonymized buyer's orders are never synced again.
    await db.pool.query(`UPDATE public.ticketing_orders SET updated_at = updated_at WHERE id = $1`, [order.orderId]);
    await syncTicketBuyers(db.pool);
    const { rows: again } = await db.pool.query(`SELECT count(*)::int AS n FROM public.ticketing_customers WHERE email = 'oublie-moi@example.com'`);
    expect(again[0].n).toBe(0);
    await db.pool.query(`UPDATE public.ticketing_sessions SET starts_at = now() + interval '30 days' WHERE id = $1`, [h.sessionId]);
  });
});
