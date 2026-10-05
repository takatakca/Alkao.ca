import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { adm, call, JWT_SECRET, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { seedTwoTenants, type SeedResult } from "../helpers/seed.js";

let db: TestDatabase;
let seed: SeedResult;
let app: TestApp;
let editor: string;

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  app = testApp(db.pool);
  editor = randomUUID();
  await db.pool.query(`INSERT INTO public.ticketing_memberships (client_id, user_id, role) VALUES ($1, $2, 'editor')`, [seed.havana.clientId, editor]);
});

afterAll(async () => {
  await db?.drop();
});

const havana = () => adm(seed.havana.clientId, seed.havana.brandId);
const festi = () => adm(seed.festi.clientId, seed.festi.brandId);

describe("admin authentication and tenancy", () => {
  it("requires a valid Supabase access token", async () => {
    expect((await call(app, "GET", `${havana()}/events`)).status).toBe(401);
    expect((await call(app, "GET", `${havana()}/events`, { token: "garbage" })).status).toBe(401);
    const forged = await tokenFor(seed.users.havanaOwner, { secret: `${JWT_SECRET}-forged` });
    expect((await call(app, "GET", `${havana()}/events`, { token: forged })).status).toBe(401);
    const expired = await tokenFor(seed.users.havanaOwner, { expiresIn: "-1m" });
    expect((await call(app, "GET", `${havana()}/events`, { token: expired })).status).toBe(401);
    const anonRole = await tokenFor(seed.users.havanaOwner, { role: "anon" });
    expect((await call(app, "GET", `${havana()}/events`, { token: anonRole })).status).toBe(401);
  });

  it("answers 503 when auth is not configured", async () => {
    const { createSupabaseJwtVerifier } = await import("../../src/api/auth.js");
    const noAuth = testApp(db.pool, { auth: createSupabaseJwtVerifier({}) });
    expect((await call(noAuth, "GET", `${havana()}/events`, { token: "x.y.z" })).status).toBe(503);
  });

  it("hides other Clients entirely (404), including from members of another Client", async () => {
    const stranger = await tokenFor(seed.users.stranger);
    const festiOwner = await tokenFor(seed.users.festiOwner);
    const suspended = await tokenFor(seed.users.suspended);
    for (const token of [stranger, festiOwner, suspended]) {
      expect((await call(app, "GET", `${havana()}/orders`, { token })).status).toBe(404);
      expect((await call(app, "GET", `${havana()}/status`, { token })).status).toBe(404);
    }
  });

  it("never returns another tenant's record through its own path", async () => {
    const festiOwner = await tokenFor(seed.users.festiOwner);
    expect((await call(app, "GET", `${festi()}/orders/${seed.havana.orderId}`, { token: festiOwner })).status).toBe(404);
    expect((await call(app, "GET", `${festi()}/events/${seed.havana.eventId}`, { token: festiOwner })).status).toBe(404);
    expect((await call(app, "PATCH", `${festi()}/sessions/${seed.havana.sessionId}`, { token: festiOwner, body: { capacity: 1 } })).status).toBe(404);
    const created = await call(app, "POST", `${festi()}/events/${seed.havana.eventId}/sessions`, {
      token: festiOwner,
      body: { startsAt: new Date(Date.now() + 86_400_000).toISOString(), capacity: 5 },
    });
    expect(created.status).toBe(422);
    expect(created.body.error.code).toBe("invalid_reference");
  });

  it("one person, two memberships: manager at FESTI-ICE, viewer at Havana", async () => {
    const token = await tokenFor(seed.users.both);
    const festiOrders = await call(app, "GET", `${festi()}/orders`, { token });
    expect(festiOrders.status).toBe(200);
    expect(festiOrders.body.orders.length).toBeGreaterThan(0);
    expect(festiOrders.body.orders.every((o: { id: string }) => o.id !== seed.havana.orderId)).toBe(true);
    expect((await call(app, "GET", `${havana()}/orders`, { token })).body.error.code).toBe("forbidden");
    expect((await call(app, "GET", `${havana()}/events`, { token })).status).toBe(200);
  });
});

describe("admin permissions", () => {
  it("staff can read the catalog but not write it, nor read orders or audit", async () => {
    const token = await tokenFor(seed.users.havanaStaff);
    expect((await call(app, "GET", `${havana()}/events`, { token })).status).toBe(200);
    expect((await call(app, "GET", `${havana()}/events/${seed.havana.eventId}/sessions`, { token })).status).toBe(200);
    expect((await call(app, "POST", `${havana()}/venues`, { token, body: { name: "Chalet" } })).status).toBe(403);
    expect((await call(app, "GET", `${havana()}/orders`, { token })).status).toBe(403);
    expect((await call(app, "GET", `${havana()}/audit`, { token })).status).toBe(403);
  });

  it("an editor builds the catalog; every write is audited", async () => {
    const token = await tokenFor(editor);
    const venue = await call(app, "POST", `${havana()}/venues`, { token, body: { name: "Patinoire Nord", city: "Maricourt" } });
    expect(venue.status).toBe(201);
    const event = await call(app, "POST", `${havana()}/events`, {
      token,
      body: { venueId: venue.body.venue.id, slug: "soiree-glace", title: "Soirée glace", status: "published" },
    });
    expect(event.status).toBe(201);
    expect(event.body.event.status).toBe("draft"); // status cannot be set on create
    const eventId = event.body.event.id;
    const type = await call(app, "POST", `${havana()}/events/${eventId}/ticket-types`, {
      token,
      body: { code: "GENERAL", name: "Admission générale", priceCents: 2995, maxQuantity: 10, countsAsAdult: true },
    });
    expect(type.status).toBe(201);
    const flexWithoutScope = await call(app, "POST", `${havana()}/events/${eventId}/ticket-types`, {
      token,
      body: { code: "FLEX", name: "Flex", kind: "add_on", priceCents: 800, maxQuantity: 10 },
    });
    expect(flexWithoutScope.status).toBe(400);
    const session = await call(app, "POST", `${havana()}/events/${eventId}/sessions`, {
      token,
      body: { startsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(), capacity: 100 },
    });
    expect(session.status).toBe(201);
    expect(session.body.session).toMatchObject({ status: "draft", reservedCount: 0, soldCount: 0 });
    const onSale = await call(app, "PATCH", `${havana()}/sessions/${session.body.session.id}`, { token, body: { status: "on_sale" } });
    expect(onSale.body.session.status).toBe("on_sale");
    const published = await call(app, "PATCH", `${havana()}/events/${eventId}`, { token, body: { status: "published" } });
    expect(published.body.event.status).toBe("published");

    const owner = await tokenFor(seed.users.havanaOwner);
    const audit = await call(app, "GET", `${havana()}/audit?limit=10`, { token: owner });
    const mine = audit.body.entries.filter((e: { actorId: string }) => e.actorId === editor).map((e: { action: string }) => e.action);
    expect(mine).toEqual(["event.updated", "session.updated", "session.created", "ticket_type.created", "event.created", "venue.created"]);
  });

  it("refuses to drop capacity below what is held or sold", async () => {
    const token = await tokenFor(seed.users.havanaOwner);
    const res = await call(app, "PATCH", `${havana()}/sessions/${seed.havana.sessionId}`, { token, body: { capacity: 1 } });
    expect(res).toEqual({ status: 409, body: { error: { code: "capacity_below_committed" } } });
  });

  it("managers read orders with buyer details, lines, taxes and tickets", async () => {
    const token = await tokenFor(seed.users.festiOwner);
    const res = await call(app, "GET", `${festi()}/orders/${seed.festi.orderId}`, { token });
    expect(res.status).toBe(200);
    expect(res.body.order).toMatchObject({ status: "paid", buyerName: "Test Buyer" });
    expect(res.body.order.lines).toHaveLength(3);
    expect(res.body.order.taxes.map((t: { code: string }) => t.code)).toEqual(["GST", "QST"]);
    expect(res.body.order.tickets).toHaveLength(4);
  });

  it("rejects empty and unknown-field-only updates", async () => {
    const token = await tokenFor(seed.users.havanaOwner);
    const res = await call(app, "PATCH", `${havana()}/events/${seed.havana.eventId}`, { token, body: { clientId: seed.festi.clientId } });
    expect(res.status).toBe(400);
  });

  it("reports the gate state to members", async () => {
    const token = await tokenFor(seed.users.havanaStaff);
    const res = await call(app, "GET", `${havana()}/status`, { token });
    expect(res.body).toEqual({ role: "staff", ticketing: { active: true } });
  });
});
