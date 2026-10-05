import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { call, pub, testApp, type TestApp } from "../helpers/app.js";
import { seedTwoTenants, type SeedResult, type TenantFixture } from "../helpers/seed.js";

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

const typeId = (t: TenantFixture, code: string) => t.types.find((x) => x.code === code)!.id;
const base = (t: TenantFixture) => pub(t.clientId, t.brandId);

async function newSession(t: TenantFixture, capacity: number, status = "on_sale") {
  const { rows } = await db.pool.query<{ id: string }>(
    `INSERT INTO public.ticketing_sessions (client_id, brand_id, event_id, starts_at, capacity, status)
     VALUES ($1, $2, $3, now() + (random() * interval '200 days') + interval '2 days', $4, $5) RETURNING id`,
    [t.clientId, t.brandId, t.eventId, capacity, status],
  );
  return rows[0]!.id;
}

const holdBody = (t: TenantFixture, sessionId: string, items: Record<string, number>) => ({
  sessionId,
  items: Object.entries(items).map(([code, quantity]) => ({ ticketTypeId: typeId(t, code), quantity })),
});

describe("public catalog", () => {
  it("lists published events and sellable sessions with availability only", async () => {
    const t = seed.havana;
    const draft = await newSession(t, 10, "draft");
    const events = await call(app, "GET", `${base(t)}/events`);
    expect(events.status).toBe(200);
    expect(events.body.events.map((e: { id: string }) => e.id)).toEqual([t.eventId]);

    const detail = await call(app, "GET", `${base(t)}/events/${t.eventId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.event).not.toHaveProperty("status");
    expect(detail.body.ticketTypes.map((x: { code: string }) => x.code)).toContain("FAMILY");
    const sessionIds = detail.body.sessions.map((s: { id: string }) => s.id);
    expect(sessionIds).toContain(t.sessionId);
    expect(sessionIds).not.toContain(draft);
    for (const s of detail.body.sessions) {
      expect(Object.keys(s).sort()).toEqual(["available", "endsAt", "id", "startsAt"]);
    }
  });

  it("does not show another tenant's or an unpublished event", async () => {
    expect((await call(app, "GET", `${base(seed.havana)}/events/${seed.festi.eventId}`)).status).toBe(404);
    await db.pool.query(`UPDATE public.ticketing_events SET status = 'draft' WHERE id = $1`, [seed.festi.eventId]);
    try {
      expect((await call(app, "GET", `${base(seed.festi)}/events/${seed.festi.eventId}`)).status).toBe(404);
      expect((await call(app, "GET", `${base(seed.festi)}/events`)).body.events).toEqual([]);
    } finally {
      await db.pool.query(`UPDATE public.ticketing_events SET status = 'published' WHERE id = $1`, [seed.festi.eventId]);
    }
  });

  it("quotes from server prices; client-sent prices are ignored", async () => {
    const t = seed.havana;
    const res = await call(app, "POST", `${base(t)}/events/${t.eventId}/quote`, {
      body: { items: [{ ticketTypeId: typeId(t, "GENERAL"), quantity: 2, priceCents: 1 }], totalCents: 1 },
    });
    expect(res.status).toBe(200);
    expect(res.body.quote).toMatchObject({ subtotalCents: 5990, totalCents: 5990 + 300 + 598 });
  });

  it("returns every cart violation as 422", async () => {
    const t = seed.havana;
    const res = await call(app, "POST", `${base(t)}/events/${t.eventId}/quote`, {
      body: holdBody(t, t.sessionId, { FAMILY: 2, GENERAL: 3 }),
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("cart_invalid");
    expect(res.body.error.details.map((v: { code: string }) => v.code).sort()).toEqual(["below_minimum", "max_adults_exceeded"]);
  });

  it("rejects malformed requests with 400", async () => {
    const t = seed.havana;
    const broken = await call(app, "POST", `${base(t)}/holds`, { body: "{not json" });
    expect(broken).toEqual({ status: 400, body: { error: { code: "invalid_json" } } });
    const res = await call(app, "POST", `${base(t)}/holds`, { body: { sessionId: "x", items: [] } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_request");
  });
});

describe("public holds", () => {
  it("creates a hold, reads it with its token, releases it, and returns the capacity", async () => {
    const t = seed.festi;
    const sessionId = await newSession(t, 6);
    const created = await call(app, "POST", `${base(t)}/holds`, { body: holdBody(t, sessionId, { FAMILY: 4, GENERAL: 2, FLEX_WEATHER: 6 }) });
    expect(created.status).toBe(201);
    const hold = created.body.hold;
    expect(hold.quote).toMatchObject({ admissions: 6, subtotalCents: 4 * 2195 + 2 * 2995 + 6 * 800 });
    expect(hold.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const sold = await call(app, "POST", `${base(t)}/holds`, { body: holdBody(t, sessionId, { GENERAL: 1 }) });
    expect(sold).toEqual({ status: 409, body: { error: { code: "sold_out" } } });

    const read = await call(app, "GET", `${base(t)}/holds/${hold.id}`, { headers: { "x-alkao-hold-token": hold.token } });
    expect(read.status).toBe(200);
    expect(read.body.hold.status).toBe("active");
    expect(read.body.hold.items).toHaveLength(3);

    expect((await call(app, "GET", `${base(t)}/holds/${hold.id}`)).status).toBe(404);
    expect((await call(app, "GET", `${base(t)}/holds/${hold.id}`, { headers: { "x-alkao-hold-token": "wrong" } })).status).toBe(404);
    expect((await call(app, "DELETE", `${base(t)}/holds/${hold.id}`, { headers: { "x-alkao-hold-token": "wrong" } })).status).toBe(404);

    expect((await call(app, "DELETE", `${base(t)}/holds/${hold.id}`, { headers: { "x-alkao-hold-token": hold.token } })).status).toBe(204);
    expect((await call(app, "DELETE", `${base(t)}/holds/${hold.id}`, { headers: { "x-alkao-hold-token": hold.token } })).status).toBe(409);
    expect((await call(app, "POST", `${base(t)}/holds`, { body: holdBody(t, sessionId, { GENERAL: 1 }) })).status).toBe(201);
  });

  it("never resolves a hold through another tenant's path, even with the right token", async () => {
    const t = seed.havana;
    const created = await call(app, "POST", `${base(t)}/holds`, { body: holdBody(t, t.sessionId, { GENERAL: 1 }) });
    const { id, token } = created.body.hold;
    const res = await call(app, "GET", `${base(seed.festi)}/holds/${id}`, { headers: { "x-alkao-hold-token": token } });
    expect(res.status).toBe(404);
    const del = await call(app, "DELETE", `${base(seed.festi)}/holds/${id}`, { headers: { "x-alkao-hold-token": token } });
    expect(del.status).toBe(404);
  });

  it("refuses sessions that are not sellable", async () => {
    const t = seed.havana;
    const paused = await newSession(t, 10, "paused");
    expect((await call(app, "POST", `${base(t)}/holds`, { body: holdBody(t, paused, { GENERAL: 1 }) })).body.error.code).toBe("session_not_available");
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO public.ticketing_sessions (client_id, brand_id, event_id, starts_at, capacity, status)
       VALUES ($1, $2, $3, now() - interval '1 hour', 10, 'on_sale') RETURNING id`,
      [t.clientId, t.brandId, t.eventId],
    );
    expect((await call(app, "POST", `${base(t)}/holds`, { body: holdBody(t, rows[0]!.id, { GENERAL: 1 }) })).body.error.code).toBe("session_not_available");
    expect((await call(app, "POST", `${base(t)}/holds`, { body: holdBody(t, seed.festi.sessionId, { GENERAL: 1 }) })).status).toBe(404);
  });

  it("reports an expired hold as expired", async () => {
    const t = seed.havana;
    let clock = new Date();
    const timed = testApp(db.pool, { now: () => clock, holdTtlSeconds: 60 });
    const created = await call(timed, "POST", `${base(t)}/holds`, { body: holdBody(t, t.sessionId, { CHILD: 1, GENERAL: 1 }) });
    clock = new Date(clock.getTime() + 61_000);
    const read = await call(timed, "GET", `${base(t)}/holds/${created.body.hold.id}`, { headers: { "x-alkao-hold-token": created.body.hold.token } });
    expect(read.body.hold.status).toBe("expired");
  });

  it("rate-limits hold creation per caller", async () => {
    const t = seed.havana;
    const limited = testApp(db.pool, { publicHoldsPerMinute: 2 });
    const headers = { "x-forwarded-for": "203.0.113.7" };
    const body = holdBody(t, t.sessionId, { GENERAL: 1 });
    expect((await call(limited, "POST", `${base(t)}/holds`, { body, headers })).status).toBe(201);
    expect((await call(limited, "POST", `${base(t)}/holds`, { body, headers })).status).toBe(201);
    expect((await call(limited, "POST", `${base(t)}/holds`, { body, headers })).status).toBe(429);
    expect((await call(limited, "POST", `${base(t)}/holds`, { body, headers: { "x-forwarded-for": "198.51.100.1" } })).status).toBe(201);
  });
});
