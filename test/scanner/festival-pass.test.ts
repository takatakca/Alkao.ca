import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adm, call, pub, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { seedTwoTenants, TEST_CREDENTIAL_SECRET, type SeedResult, type TenantFixture } from "../helpers/seed.js";

/**
 * Run 98: a festival pass is one ticket, one QR code, valid at every session on sale when it
 * was bought. It takes a seat on each, and enters each once. Made-up buyers only; the pass is
 * free here so no payment is needed.
 */
let db: TestDatabase;
let seed: SeedResult;
let app: TestApp;
let staff: string;
let owner: string;
let t: TenantFixture;
let passId = "";
const days: string[] = [];

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  app = testApp(db.pool, { credentialMasterSecret: TEST_CREDENTIAL_SECRET });
  staff = await tokenFor(seed.users.havanaStaff);
  owner = await tokenFor(seed.users.havanaOwner);
  t = seed.havana;
  // The festival's three "days", all inside their gate window (gates open 60 min before).
  await db.pool.query(`UPDATE public.ticketing_sessions SET status = 'closed' WHERE event_id = $1`, [t.eventId]);
  for (const minutes of [10, 20, 30]) {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO public.ticketing_sessions (client_id, brand_id, event_id, starts_at, capacity, status)
       VALUES ($1, $2, $3, now() + make_interval(mins => $4), 5, 'on_sale') RETURNING id`,
      [t.clientId, t.brandId, t.eventId, minutes],
    );
    days.push(rows[0]!.id);
  }
});

afterAll(async () => {
  await db?.drop();
});

const typeId = (code: string) => t.types.find((x) => x.code === code)!.id;
const base = () => adm(t.clientId, t.brandId);
const counts = async () =>
  (await db.pool.query<{ id: string; reserved_count: number; sold_count: number }>(
    `SELECT id, reserved_count, sold_count FROM public.ticketing_sessions WHERE id = ANY($1::uuid[])`, [days],
  )).rows.sort((a, b) => days.indexOf(a.id) - days.indexOf(b.id)).map((r) => [r.reserved_count, r.sold_count]);
const hold = (sessionId: string, items: { ticketTypeId: string; quantity: number }[]) =>
  call(app, "POST", `${pub(t.clientId, t.brandId)}/holds`, { body: { sessionId, items } });
const release = (h: { id: string; token: string }) =>
  call(app, "DELETE", `${pub(t.clientId, t.brandId)}/holds/${h.id}`, { headers: { "x-alkao-hold-token": h.token } });
async function buy(sessionId: string, items: { ticketTypeId: string; quantity: number }[]) {
  const h = await hold(sessionId, items);
  expect(h.status, JSON.stringify(h.body)).toBe(201);
  const co = await call(app, "POST", `${pub(t.clientId, t.brandId)}/holds/${h.body.hold.id}/checkout`, {
    headers: { "x-alkao-hold-token": h.body.hold.token },
    body: { buyer: { email: "festivalier@example.com" }, successUrl: `${t.returnOrigin}/ok`, cancelUrl: `${t.returnOrigin}/ko` },
  });
  expect(co.body.order.status, JSON.stringify(co.body)).toBe("paid");
  const order = await call(app, "GET", `${pub(t.clientId, t.brandId)}/orders/${co.body.order.id}`, { headers: { "x-alkao-order-token": co.body.order.token } });
  return { orderId: co.body.order.id as string, tickets: order.body.order.tickets as { id: string; credential: string; passDates?: { startsAt: string }[] }[] };
}
const scan = async (sessionId: string, payload: string) =>
  (await call(app, "POST", `${base()}/scanner/scans`, { token: staff, body: { sessionId, payload, deviceId: "gate-1" } })).body.scan;

describe("festival passes", () => {
  it("are admissions with fixed dates", async () => {
    const body = { code: "FEST_PASS", name: "Passe festival — 3 jours", priceCents: 0, maxQuantity: 10, countsAsAdult: true, pass: true };
    expect((await call(app, "POST", `${base()}/events/${t.eventId}/ticket-types`, { token: owner, body: { ...body, openDate: true } })).status).toBe(400);
    expect((await call(app, "POST", `${base()}/events/${t.eventId}/ticket-types`, { token: owner, body: { ...body, kind: "add_on", addOnScope: "per_order" } })).status).toBe(400);
    const made = await call(app, "POST", `${base()}/events/${t.eventId}/ticket-types`, { token: owner, body });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    passId = made.body.ticketType.id;
    expect(made.body.ticketType.pass).toBe(true);
    const shop = await call(app, "GET", `${pub(t.clientId, t.brandId)}/events/${t.eventId}`);
    expect(shop.body.ticketTypes.find((x: { id: string }) => x.id === passId)).toMatchObject({ pass: true });
  });

  it("a cart holds a seat on every day, on its own, whatever day was picked", async () => {
    const h = await hold(days[1]!, [{ ticketTypeId: passId, quantity: 2 }]);
    expect(h.status, JSON.stringify(h.body)).toBe(201);
    expect(h.body.hold).toMatchObject({ sessionId: days[0], passSessionIds: [days[1], days[2]] });
    expect(await counts()).toEqual([[2, 0], [2, 0], [2, 0]]);
    expect((await hold(days[0]!, [{ ticketTypeId: passId, quantity: 1 }, { ticketTypeId: typeId("GENERAL"), quantity: 1 }])).body.error.code).toBe("pass_cart_mixed");
    await release(h.body.hold);
    expect(await counts()).toEqual([[0, 0], [0, 0], [0, 0]]);
  });

  it("a full day stops the pass, never selling that day past its capacity", async () => {
    const dayTickets = await hold(days[2]!, [{ ticketTypeId: typeId("GENERAL"), quantity: 5 }]);
    expect(dayTickets.status).toBe(201);
    const pass = await hold(days[0]!, [{ ticketTypeId: passId, quantity: 1 }]);
    expect(pass.status).toBe(409);
    expect(pass.body.error.code).toBe("sold_out");
    // Nothing was left held on the other days.
    expect(await counts()).toEqual([[0, 0], [0, 0], [5, 0]]);
    await release(dayTickets.body.hold);
  });

  it("once bought, one QR code enters each day once, and nowhere else", async () => {
    const { tickets } = await buy(days[0]!, [{ ticketTypeId: passId, quantity: 2 }]);
    expect(tickets).toHaveLength(2);
    expect(await counts()).toEqual([[0, 2], [0, 2], [0, 2]]);
    expect(tickets[0]!.passDates?.map((d) => d.startsAt), JSON.stringify(tickets[0])).toHaveLength(2);

    const qr = tickets[0]!.credential;
    expect((await scan(days[0]!, qr)).result).toBe("admitted");
    expect((await scan(days[0]!, qr)).result).toBe("already_admitted");
    expect((await scan(days[1]!, qr)).result).toBe("admitted");
    expect((await scan(days[1]!, qr)).result).toBe("already_admitted");
    expect((await scan(days[2]!, qr)).result).toBe("admitted");

    // A day ticket still enters its own day only.
    const day = await buy(days[0]!, [{ ticketTypeId: typeId("TODDLER"), quantity: 1 }]);
    expect((await scan(days[1]!, day.tickets[0]!.credential)).result).toBe("wrong_session");

    // An offline gate for day 2 knows the passes: the one that entered, and the one still to come.
    const manifest = (await call(app, "GET", `${base()}/sessions/${days[1]}/scanner-manifest`, { token: staff })).body.manifest;
    const second = tickets[1]!.credential.split(".")[2];
    expect(manifest.credentials.map((c: { qrId: string }) => c.qrId)).toContain(second);
    expect(manifest.admitted.map((c: { qrId: string }) => c.qrId)).toContain(qr.split(".")[2]);

    // Found by reference at day 3's gate, with day 3's entry.
    const ref = (await db.pool.query(`SELECT o.reference FROM public.ticketing_orders o JOIN public.ticketing_tickets k ON k.order_id = o.id WHERE k.id = $1`, [tickets[0]!.id])).rows[0].reference;
    const found = await call(app, "GET", `${base()}/sessions/${days[2]}/lookup?reference=${ref}`, { token: staff });
    expect(found.status, JSON.stringify(found.body)).toBe(200);
    expect(found.body.order.tickets).toHaveLength(2);
    expect(found.body.order.tickets.filter((x: { admittedAt: string | null }) => x.admittedAt)).toHaveLength(1);
    expect(found.body.order.otherSessions).toEqual([]);
  });

  it("cancelling a day refunds that day's tickets, never a pass still valid on the others", async () => {
    const pass = await buy(days[0]!, [{ ticketTypeId: passId, quantity: 1 }]);
    const cancelled = await call(app, "POST", `${base()}/sessions/${days[1]}/cancel`, { token: owner, body: { reason: "Orage" } });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(202);
    const { rows } = await db.pool.query(
      `SELECT order_id FROM public.ticketing_session_cancellation_orders co JOIN public.ticketing_session_cancellations c ON c.id = co.cancellation_id WHERE c.session_id = $1`,
      [days[1]],
    );
    expect(rows.map((r) => r.order_id)).not.toContain(pass.orderId);
    expect((await db.pool.query(`SELECT status FROM public.ticketing_tickets WHERE order_id = $1`, [pass.orderId])).rows).toEqual([{ status: "valid" }]);
  });

  it("a voided pass gives back its seat on every day it took", async () => {
    const before = await counts();
    const pass = await buy(days[0]!, [{ ticketTypeId: passId, quantity: 1 }]);
    // Day 2 was cancelled: a pass bought now covers days 1 and 3 only.
    expect((await counts()).map(([, sold], i) => sold! - before[i]![1]!)).toEqual([1, 0, 1]);
    await db.pool.query(`UPDATE public.ticketing_tickets SET status = 'void', void_reason = 'admin', voided_at = now() WHERE order_id = $1`, [pass.orderId]);
    expect(await counts()).toEqual(before);
  });

  it("an abandoned pass cart never shows its seats as taken, on any day, before it is swept", async () => {
    const brief = testApp(db.pool, { credentialMasterSecret: TEST_CREDENTIAL_SECRET, holdTtlSeconds: 1 });
    const available = async () => {
      const shop = await call(app, "GET", `${pub(t.clientId, t.brandId)}/events/${t.eventId}`);
      return (shop.body.sessions as { id: string; available: number }[]).map((x) => [x.id, x.available]);
    };
    const before = await available();
    const h = await call(brief, "POST", `${pub(t.clientId, t.brandId)}/holds`, { body: { sessionId: days[0], items: [{ ticketTypeId: passId, quantity: 1 }] } });
    expect(h.status, JSON.stringify(h.body)).toBe(201);
    expect((await available()).map(([, n]) => n)).toEqual(before.map(([, n]) => Number(n) - 1));
    await new Promise((r) => setTimeout(r, 1200));
    expect(await available()).toEqual(before);
  });
});
