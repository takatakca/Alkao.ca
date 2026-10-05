import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adm, call, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { seedTwoTenants, type SeedResult, type TenantFixture } from "../helpers/seed.js";

/**
 * Run 28: a new draft event from an existing one, with its ticket types, and its sessions
 * moved by N days when asked. Nothing of the original changes, nothing sold is copied.
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

const duplicate = async (t: TenantFixture, body: Record<string, unknown>, user = seed.users.havanaOwner, eventId = t.eventId) =>
  call(app, "POST", `${adm(t.clientId, t.brandId)}/events/${eventId}/duplicate`, { token: await tokenFor(user), body });
const typesOf = async (eventId: string) =>
  (await db.pool.query(
    `SELECT code, name, kind, price_cents, min_quantity, max_quantity, max_adults_in_order, counts_as_adult, add_on_scope, active, sort_order, grants_session_change
     FROM public.ticketing_ticket_types WHERE event_id = $1 ORDER BY code`,
    [eventId],
  )).rows;
const sessionsOf = async (eventId: string) =>
  (await db.pool.query(`SELECT starts_at, ends_at, capacity, status, sold_count, reserved_count FROM public.ticketing_sessions WHERE event_id = $1 ORDER BY starts_at`, [eventId])).rows;
const snapshot = async (eventId: string) =>
  JSON.stringify({
    event: (await db.pool.query(`SELECT * FROM public.ticketing_events WHERE id = $1`, [eventId])).rows,
    types: await typesOf(eventId),
    sessions: await sessionsOf(eventId),
  });

describe("duplicating an event", () => {
  it("makes a draft copy with the same ticket types, and no sessions unless asked", async () => {
    const h = seed.havana;
    const before = await snapshot(h.eventId);
    const res = await duplicate(h, {});
    expect(res.status).toBe(201);
    const { event } = res.body;
    expect(event).toMatchObject({ status: "draft", title: "Havana Resort — Événements 2026-2027 (copie)", slug: "saison-2026-2027-copie" });
    expect(res.body).toMatchObject({ ticketTypes: h.types.length, sessions: 0 });
    expect(await typesOf(event.id)).toEqual(await typesOf(h.eventId));
    expect(await sessionsOf(event.id)).toEqual([]);
    const { rows } = await db.pool.query(
      `SELECT venue_id, status, sales_open_at, sales_close_at, admission_opens_before_minutes, admission_closes_after_minutes FROM public.ticketing_events WHERE id = $1`,
      [event.id],
    );
    expect(rows[0]).toMatchObject({ venue_id: h.venueId, status: "draft", sales_open_at: null, sales_close_at: null });
    // The original is untouched; the copy is logged.
    expect(await snapshot(h.eventId)).toBe(before);
    const { rows: log } = await db.pool.query(`SELECT data FROM public.ticketing_audit_log WHERE action = 'event.duplicated' AND entity_id = $1`, [event.id]);
    expect(log[0].data).toMatchObject({ from: h.eventId, shiftDays: null, sessions: 0 });
  });

  it("moves the sessions by N days when asked, as drafts with nothing sold, and skips cancelled ones", async () => {
    const h = seed.havana;
    await db.pool.query(
      `INSERT INTO public.ticketing_sessions (client_id, brand_id, event_id, starts_at, capacity, status)
       VALUES ($1, $2, $3, now() + interval '40 days', 10, 'cancelled')`,
      [h.clientId, h.brandId, h.eventId],
    );
    const { rows: source } = await db.pool.query(
      `SELECT starts_at, ends_at, capacity FROM public.ticketing_sessions WHERE event_id = $1 AND status <> 'cancelled' ORDER BY starts_at`,
      [h.eventId],
    );
    const res = await duplicate(h, { title: "Soirée de la semaine prochaine", shiftDays: 7 });
    expect(res.status).toBe(201);
    expect(res.body.event.title).toBe("Soirée de la semaine prochaine");
    expect(res.body.sessions).toBe(source.length);
    const copied = await sessionsOf(res.body.event.id);
    expect(copied).toEqual(
      source.map((s) => ({
        starts_at: new Date(s.starts_at.getTime() + 7 * 86_400_000),
        ends_at: s.ends_at ? new Date(s.ends_at.getTime() + 7 * 86_400_000) : null,
        capacity: s.capacity, status: "draft", sold_count: 0, reserved_count: 0,
      })),
    );
  });

  it("finds a free slug each time, and the copy can go on sale", async () => {
    const f = seed.festi;
    const owner = seed.users.festiOwner;
    const first = await duplicate(f, {}, owner);
    const second = await duplicate(f, {}, owner);
    const ofCopy = await duplicate(f, {}, owner, first.body.event.id);
    expect([first.body.event.slug, second.body.event.slug, ofCopy.body.event.slug]).toEqual([
      "saison-2026-2027-copie", "saison-2026-2027-copie-2", "saison-2026-2027-copie-copie",
    ]);
    const publish = await call(app, "PATCH", `${adm(f.clientId, f.brandId)}/events/${second.body.event.id}`, { token: await tokenFor(owner), body: { status: "published" } });
    expect(publish.status).toBe(200);
  });

  it("is for roles that edit the catalog, within their own Client", async () => {
    const h = seed.havana;
    const f = seed.festi;
    expect((await duplicate(h, {}, seed.users.havanaStaff)).status).toBe(403);
    expect((await duplicate(h, {}, seed.users.havanaOwner, f.eventId)).status).toBe(404);
    expect((await duplicate(h, { shiftDays: 1.5 })).status).toBe(400);
  });
});
