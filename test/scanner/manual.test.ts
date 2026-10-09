import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exchangeOrder } from "../../src/ops/exchange.js";
import { adm, call, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { seedPaidOrder, seedTwoTenants, TEST_CREDENTIAL_SECRET, type SeedResult, type TenantFixture } from "../helpers/seed.js";

/**
 * Run 22: at the gate without a QR code. Staff find the order by its reference and let a
 * ticket in, under exactly the same rules as a scan, without seeing who the buyer is.
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

/** A session whose doors are open now, and a paid order for it. */
async function tonight(t: TenantFixture, email: string, startsIn = "10 minutes") {
  const { rows } = await db.pool.query<{ id: string }>(
    `INSERT INTO public.ticketing_sessions (client_id, brand_id, event_id, starts_at, capacity, status)
     VALUES ($1, $2, $3, now() + $4::interval, 50, 'on_sale') RETURNING id`,
    [t.clientId, t.brandId, t.eventId, startsIn],
  );
  const order = await seedPaidOrder(db.pool, { ...t, sessionId: rows[0]!.id }, email);
  await db.pool.query(`UPDATE public.ticketing_buyers SET full_name = 'Luc Gagnon' WHERE id = $1`, [order.buyerId]);
  const { rows: o } = await db.pool.query<{ reference: string }>(`SELECT reference FROM public.ticketing_orders WHERE id = $1`, [order.orderId]);
  return { ...order, sessionId: rows[0]!.id, reference: o[0]!.reference };
}

const lookup = async (t: TenantFixture, sessionId: string, reference: string, user = seed.users.havanaStaff) =>
  call(app, "GET", `${adm(t.clientId, t.brandId)}/sessions/${sessionId}/lookup?reference=${encodeURIComponent(reference)}`, { token: await tokenFor(user) });
const admit = async (t: TenantFixture, sessionId: string, ticketId: string, user = seed.users.havanaStaff) =>
  call(app, "POST", `${adm(t.clientId, t.brandId)}/scanner/admit`, { token: await tokenFor(user), body: { sessionId, ticketId, deviceId: "porte-2" } });

describe("finding an order at the gate", () => {
  it("gives gate staff the tickets for this session, without the buyer's name", async () => {
    const t = seed.havana;
    const order = await tonight(t, "porte@example.com");
    const res = await lookup(t, order.sessionId, order.reference.toLowerCase());
    expect(res.status).toBe(200);
    expect(res.body.order.reference).toBe(order.reference);
    expect(res.body.order).not.toHaveProperty("buyerName");
    expect(res.body.order.tickets).toHaveLength(order.ticketIds.length);
    expect(res.body.order.tickets.every((k: { status: string; admittedAt: unknown }) => k.status === "valid" && k.admittedAt === null)).toBe(true);
    expect(JSON.stringify(res.body)).not.toMatch(/porte@example|Gagnon/);
    // Roles that read buyers see the name, to check it against an ID.
    expect((await lookup(t, order.sessionId, order.reference, seed.users.havanaOwner)).body.order.buyerName).toBe("Luc Gagnon");
  });

  it("says when the tickets are for another session, and finds tickets moved by a Flex change", async () => {
    const t = seed.havana;
    const order = await tonight(t, "autre-soir@example.com", "2 days");
    const tonightOnly = await tonight(t, "ce-soir@example.com");
    const elsewhere = (await lookup(t, tonightOnly.sessionId, order.reference)).body.order;
    expect(elsewhere.tickets).toEqual([]);
    expect(elsewhere.otherSessions).toHaveLength(1);

    // The buyer moved to tonight's session: the original reference still finds the new tickets.
    await exchangeOrder(db.pool, t, order.orderId, tonightOnly.sessionId, { type: "user", id: seed.users.havanaOwner });
    const moved = (await lookup(t, tonightOnly.sessionId, order.reference)).body.order;
    expect(moved.tickets.filter((k: { status: string }) => k.status === "valid")).toHaveLength(order.ticketIds.length);
    expect(moved.otherSessions).toEqual([]);
  });

  it("finds nothing for an unknown reference or another Client's, and is for gate roles only", async () => {
    const h = seed.havana;
    const order = await tonight(h, "inconnu@example.com");
    expect((await lookup(h, order.sessionId, "ZZZZ-ZZZZ")).status).toBe(404);
    const f = seed.festi;
    const festiOrder = await tonight(f, "festi@example.com");
    expect((await lookup(h, order.sessionId, festiOrder.reference)).status).toBe(404);
    expect((await lookup(f, order.sessionId, order.reference, seed.users.festiOwner)).status).toBe(404); // Havana's session
    // A viewer (no scanning) cannot look up.
    expect((await lookup(h, order.sessionId, order.reference, seed.users.both)).status).toBe(403);
  });
});

describe("letting a ticket in without its QR code", () => {
  it("admits once, logs the scan from the device and the manual admission, and shows it entered", async () => {
    const t = seed.havana;
    const order = await tonight(t, "telephone-mort@example.com");
    const first = await admit(t, order.sessionId, order.ticketIds[0]!);
    expect(first.status).toBe(200);
    expect(first.body.scan).toMatchObject({ result: "admitted", ticket: { id: order.ticketIds[0] } });
    const again = await admit(t, order.sessionId, order.ticketIds[0]!);
    expect(again.body.scan).toMatchObject({ result: "already_admitted", admittedBy: "porte-2" });

    const { rows } = await db.pool.query(
      `SELECT result, device_id, offline FROM public.ticketing_scans WHERE ticket_id = $1 ORDER BY id`,
      [order.ticketIds[0]],
    );
    expect(rows).toEqual([
      { result: "admitted", device_id: "porte-2", offline: false },
      { result: "already_admitted", device_id: "porte-2", offline: false },
    ]);
    const { rows: log } = await db.pool.query(`SELECT actor_id, data FROM public.ticketing_audit_log WHERE action = 'scan.manual_admission' AND entity_id = $1`, [order.ticketIds[0]]);
    expect(log).toEqual([{ actor_id: seed.users.havanaStaff, data: { sessionId: order.sessionId, deviceId: "porte-2" } }]);
    const shown = (await lookup(t, order.sessionId, order.reference)).body.order.tickets.find((k: { id: string }) => k.id === order.ticketIds[0]);
    expect(shown.admittedAt).not.toBeNull();
    // The gate counter includes it.
    const counter = await call(app, "GET", `${adm(t.clientId, t.brandId)}/sessions/${order.sessionId}/attendance`, { token: await tokenFor(seed.users.havanaStaff) });
    expect(counter.body.attendance.admitted).toBe(1);
  });

  it("applies the same rules as a scan: cancelled, wrong session, doors not open", async () => {
    const t = seed.havana;
    const order = await tonight(t, "regles@example.com");
    await db.pool.query(`UPDATE public.ticketing_tickets SET status = 'void', void_reason = 'admin', voided_at = now() WHERE id = $1`, [order.ticketIds[1]]);
    expect((await admit(t, order.sessionId, order.ticketIds[1]!)).body.scan.result).toBe("revoked");
    const other = await tonight(t, "autre@example.com");
    expect((await admit(t, other.sessionId, order.ticketIds[2]!)).body.scan).toMatchObject({ result: "wrong_session", ticketSession: { id: order.sessionId } });
    const later = await tonight(t, "plus-tard@example.com", "3 days");
    expect((await admit(t, later.sessionId, later.ticketIds[0]!)).body.scan.result).toBe("too_early");
    const { rows } = await db.pool.query(`SELECT count(*)::int AS n FROM public.ticketing_audit_log WHERE action = 'scan.manual_admission' AND entity_id = ANY($1::text[])`, [[order.ticketIds[1], order.ticketIds[2], later.ticketIds[0]]]);
    expect(rows[0].n).toBe(0);
  });

  it("refuses unknown tickets, other Clients' tickets and roles that do not scan", async () => {
    const h = seed.havana;
    const order = await tonight(h, "refus@example.com");
    expect((await admit(h, order.sessionId, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
    const f = seed.festi;
    const festiOrder = await tonight(f, "festi-refus@example.com");
    expect((await admit(h, order.sessionId, festiOrder.ticketIds[0]!)).status).toBe(404);
    expect((await admit(h, order.sessionId, order.ticketIds[0]!, seed.users.both)).status).toBe(403);
  });
});

describe("options at the gate (Run 55)", () => {
  const flex = () => seed.havana.types.find((x) => x.code === "FLEX_WEATHER")!.name;

  it("lists the order's options with the first admission, then says they were handed over", async () => {
    const t = seed.havana;
    const order = await tonight(t, "repas@example.com");
    const first = (await admit(t, order.sessionId, order.ticketIds[0]!)).body.scan;
    expect(first.options).toEqual({ items: [{ name: flex(), quantity: 4 }], already: false });
    const second = (await admit(t, order.sessionId, order.ticketIds[1]!)).body.scan;
    expect(second.options).toEqual({ items: [{ name: flex(), quantity: 4 }], already: true });
    // A refused scan hands nothing over.
    expect((await admit(t, order.sessionId, order.ticketIds[0]!)).body.scan).not.toHaveProperty("options");
    // Gate staff see them when they find the order by its reference.
    expect((await lookup(t, order.sessionId, order.reference)).body.order.options).toEqual([{ name: flex(), quantity: 4 }]);
  });

  it("keeps them with the tickets after a session change", async () => {
    const t = seed.havana;
    const order = await tonight(t, "deplace@example.com", "2 days");
    const target = await tonight(t, "autre@example.com");
    const moved = await exchangeOrder(db.pool, t, order.orderId, target.sessionId, { type: "user", id: seed.users.havanaOwner });
    const scan = (await admit(t, target.sessionId, moved.ticketIds[0]!)).body.scan;
    expect(scan).toMatchObject({ result: "admitted", options: { items: [{ name: flex(), quantity: 4 }], already: false } });
    expect((await admit(t, target.sessionId, moved.ticketIds[1]!)).body.scan.options.already).toBe(true);
    // The original reference and the new one both show them.
    expect((await lookup(t, target.sessionId, order.reference)).body.order.options).toEqual([{ name: flex(), quantity: 4 }]);
    expect((await lookup(t, target.sessionId, moved.reference)).body.order.options).toEqual([{ name: flex(), quantity: 4 }]);
  });
});
