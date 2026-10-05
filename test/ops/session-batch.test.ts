import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localStarts } from "../../src/ops/session-batch.js";
import { adm, call, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { seedTwoTenants, type SeedResult, type TenantFixture } from "../helpers/seed.js";

/**
 * Run 29: a season of sessions in one request (every 15 minutes, 17:00 to 20:30, chosen
 * weekdays), in the venue's local time, and a whole event put on sale or paused at once.
 */
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

const batch = async (t: TenantFixture, body: Record<string, unknown>, user = seed.users.havanaOwner, eventId = t.eventId) =>
  call(app, "POST", `${adm(t.clientId, t.brandId)}/events/${eventId}/sessions/batch`, { token: await tokenFor(user), body });
const sessionsBetween = async (eventId: string, from: string, to: string) =>
  (await db.pool.query<{ starts_at: Date; ends_at: Date | null; capacity: number; status: string }>(
    `SELECT starts_at, ends_at, capacity, status FROM public.ticketing_sessions WHERE event_id = $1 AND starts_at >= $2 AND starts_at < $3 ORDER BY starts_at`,
    [eventId, from, to],
  )).rows;
const iso = (rows: { starts_at: Date }[]) => rows.map((r) => r.starts_at.toISOString());

describe("the start times a batch asks for", () => {
  it("lists every chosen weekday, from the first start to the last, every N minutes", () => {
    // 2027-03-12 is a Friday.
    expect(localStarts({ fromDate: "2027-03-12", toDate: "2027-03-15", weekdays: [5, 1], firstStart: "17:00", lastStart: "17:40", everyMinutes: 20 })).toEqual([
      "2027-03-12 17:00", "2027-03-12 17:20", "2027-03-12 17:40",
      "2027-03-15 17:00", "2027-03-15 17:20", "2027-03-15 17:40",
    ]);
    expect(localStarts({ fromDate: "2027-12-31", toDate: "2028-01-01", firstStart: "20:00" })).toEqual(["2027-12-31 20:00", "2028-01-01 20:00"]);
    // FESTI-ICE: 17:00 → 20:30 every 15 minutes is 15 arrivals an evening.
    expect(localStarts({ fromDate: "2027-01-08", toDate: "2027-01-08", firstStart: "17:00", lastStart: "20:30", everyMinutes: 15 })).toHaveLength(15);
  });
});

describe("creating sessions in bulk", () => {
  it("shows what it would create without creating anything, in the venue's time across a clock change", async () => {
    const h = seed.havana;
    // Clocks go forward in Montréal on Sunday 2027-03-14: 17:00 is 22:00 UTC the day before, 21:00 UTC that day.
    const res = await batch(h, { fromDate: "2027-03-13", toDate: "2027-03-14", firstStart: "17:00", lastStart: "17:30", everyMinutes: 15, capacity: 40, durationMinutes: 15, dryRun: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ timeZone: "America/Toronto", requested: 6, skipped: 0, created: 0 });
    expect(res.body.sessions.map((s: { startsAt: string }) => s.startsAt)).toEqual([
      "2027-03-13T22:00:00.000Z", "2027-03-13T22:15:00.000Z", "2027-03-13T22:30:00.000Z",
      "2027-03-14T21:00:00.000Z", "2027-03-14T21:15:00.000Z", "2027-03-14T21:30:00.000Z",
    ]);
    expect(res.body.sessions[0].endsAt).toBe("2027-03-13T22:15:00.000Z");
    expect(await sessionsBetween(h.eventId, "2027-03-13", "2027-03-15")).toEqual([]);
  });

  it("creates them, skips start times the event already has, and can be sent again safely", async () => {
    const h = seed.havana;
    await db.pool.query(
      `INSERT INTO public.ticketing_sessions (client_id, brand_id, event_id, starts_at, capacity, status) VALUES ($1, $2, $3, '2027-03-13T22:15:00Z', 7, 'paused')`,
      [h.clientId, h.brandId, h.eventId],
    );
    const body = { fromDate: "2027-03-13", toDate: "2027-03-14", firstStart: "17:00", lastStart: "17:30", everyMinutes: 15, capacity: 40, durationMinutes: 15, status: "on_sale" };
    const first = await batch(h, body);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ requested: 6, created: 5, skipped: 1 });
    const rows = await sessionsBetween(h.eventId, "2027-03-13", "2027-03-15");
    expect(rows).toHaveLength(6);
    // The session that was already there is left exactly as it was.
    expect(rows[1]).toMatchObject({ capacity: 7, status: "paused", ends_at: null });
    expect(rows.filter((_, i) => i !== 1).every((r) => r.capacity === 40 && r.status === "on_sale" && r.ends_at!.getTime() - r.starts_at.getTime() === 15 * 60_000)).toBe(true);

    const again = await batch(h, body);
    expect(again.body).toMatchObject({ requested: 6, created: 0, skipped: 6, sessions: [] });
    const { rows: log } = await db.pool.query(
      `SELECT data FROM public.ticketing_audit_log WHERE action = 'sessions.batch_created' AND entity_id = $1 ORDER BY created_at`,
      [h.eventId],
    );
    expect(log.map((l) => [l.data.created, l.data.skipped])).toEqual([[5, 1], [0, 6]]);
  });

  it("makes one session of two local times that are the same instant", async () => {
    const h = seed.havana;
    // 02:00 and 02:30 do not exist on 2027-03-14 in Montréal; PostgreSQL reads them as 03:00 and 03:30.
    const res = await batch(h, { fromDate: "2027-03-14", toDate: "2027-03-14", firstStart: "02:00", lastStart: "03:30", everyMinutes: 30, capacity: 5 });
    expect(res.body).toMatchObject({ requested: 2, created: 2 });
    expect(iso(await sessionsBetween(h.eventId, "2027-03-14T06:00:00Z", "2027-03-14T09:00:00Z"))).toEqual(["2027-03-14T07:00:00.000Z", "2027-03-14T07:30:00.000Z"]);
  });

  it("refuses more than 1000 sessions, and incoherent requests", async () => {
    const h = seed.havana;
    const big = await batch(h, { fromDate: "2027-05-01", toDate: "2027-05-31", firstStart: "08:00", lastStart: "20:00", everyMinutes: 15, capacity: 5 });
    expect(big.status).toBe(422);
    expect(big.body.error).toEqual({ code: "too_many_sessions", details: { max: 1000 } });
    expect(await sessionsBetween(h.eventId, "2027-05-01", "2027-06-01")).toEqual([]);
    for (const wrong of [
      { fromDate: "2027-05-02", toDate: "2027-05-01", firstStart: "17:00", capacity: 5 },
      { fromDate: "2027-05-01", toDate: "2028-05-10", firstStart: "17:00", capacity: 5 },
      { fromDate: "2027-05-01", toDate: "2027-05-01", firstStart: "17:00", lastStart: "16:00", everyMinutes: 15, capacity: 5 },
      { fromDate: "2027-05-01", toDate: "2027-05-01", firstStart: "17:00", lastStart: "18:00", capacity: 5 },
      { fromDate: "2027-05-01", toDate: "2027-05-01", firstStart: "25:00", capacity: 5 },
      { fromDate: "2027-05-01", toDate: "2027-05-01", firstStart: "17:00", weekdays: [0], capacity: 5 },
      { fromDate: "2027-05-01", toDate: "2027-05-01", firstStart: "17:00", capacity: 5, status: "cancelled" },
    ]) expect((await batch(h, wrong)).status).toBe(400);
  });

  it("is for roles that edit the catalog, within their own Client", async () => {
    const h = seed.havana;
    const body = { fromDate: "2027-06-01", toDate: "2027-06-01", firstStart: "17:00", capacity: 5 };
    expect((await batch(h, body, seed.users.havanaStaff)).status).toBe(403);
    expect((await batch(h, body, seed.users.havanaOwner, seed.festi.eventId)).status).toBe(404);
    expect(await sessionsBetween(seed.festi.eventId, "2027-06-01", "2027-06-02")).toEqual([]);
  });
});

describe("putting a whole event on sale or on pause", () => {
  it("moves only the upcoming sessions in the given status", async () => {
    const f = seed.festi;
    const owner = seed.users.festiOwner;
    const created = await batch(f, { fromDate: "2027-01-08", toDate: "2027-01-09", firstStart: "17:00", lastStart: "17:15", everyMinutes: 15, capacity: 30 }, owner);
    expect(created.body.created).toBe(4);
    const { rows: past } = await db.pool.query<{ id: string }>(
      `INSERT INTO public.ticketing_sessions (client_id, brand_id, event_id, starts_at, capacity, status) VALUES ($1, $2, $3, now() - interval '3 days', 5, 'draft') RETURNING id`,
      [f.clientId, f.brandId, f.eventId],
    );
    const statusOf = async (id: string) => (await db.pool.query(`SELECT status FROM public.ticketing_sessions WHERE id = $1`, [id])).rows[0].status;
    const onSaleBefore = (await db.pool.query(`SELECT id FROM public.ticketing_sessions WHERE event_id = $1 AND status = 'on_sale'`, [f.eventId])).rows.map((r) => r.id);

    const open = await call(app, "POST", `${adm(f.clientId, f.brandId)}/events/${f.eventId}/sessions/status`, { token: await tokenFor(owner), body: { from: "draft", to: "on_sale" } });
    expect(open).toEqual({ status: 200, body: { updated: 4 } });
    expect(await statusOf(past[0]!.id)).toBe("draft"); // already over: untouched
    expect((await sessionsBetween(f.eventId, "2027-01-08", "2027-01-10")).map((s) => s.status)).toEqual(["on_sale", "on_sale", "on_sale", "on_sale"]);

    const pause = await call(app, "POST", `${adm(f.clientId, f.brandId)}/events/${f.eventId}/sessions/status`, { token: await tokenFor(owner), body: { from: "on_sale", to: "paused" } });
    expect(pause.body.updated).toBe(4 + onSaleBefore.length);
    const { rows: log } = await db.pool.query(`SELECT data FROM public.ticketing_audit_log WHERE action = 'sessions.status_batch_changed' AND entity_id = $1 ORDER BY created_at`, [f.eventId]);
    expect(log.map((l) => l.data)).toEqual([{ from: "draft", to: "on_sale", sessions: 4 }, { from: "on_sale", to: "paused", sessions: 4 + onSaleBefore.length }]);

    const h = seed.havana;
    expect((await call(app, "POST", `${adm(h.clientId, h.brandId)}/events/${h.eventId}/sessions/status`, { token: await tokenFor(seed.users.havanaStaff), body: { from: "draft", to: "on_sale" } })).status).toBe(403);
    expect((await call(app, "POST", `${adm(h.clientId, h.brandId)}/events/${f.eventId}/sessions/status`, { token: await tokenFor(seed.users.havanaOwner), body: { from: "draft", to: "on_sale" } })).status).toBe(404);
    expect((await call(app, "POST", `${adm(f.clientId, f.brandId)}/events/${f.eventId}/sessions/status`, { token: await tokenFor(owner), body: { from: "paused", to: "paused" } })).status).toBe(400);
    expect((await call(app, "POST", `${adm(f.clientId, f.brandId)}/events/${f.eventId}/sessions/status`, { token: await tokenFor(owner), body: { from: "paused", to: "cancelled" } })).status).toBe(400);
  });
});
