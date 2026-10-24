import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rulesOnSale, type TicketTypeRule } from "../../src/domain/catalog.js";
import { adm, call, pub, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { seedTwoTenants, type SeedResult, type TenantFixture } from "../helpers/seed.js";

/**
 * Run 104: price phases. "Lève-tôt" until a date, then "Prévente" from that date, then the
 * regular price. A phase is never sold before its start; the shop announces it with its date.
 */
const DAY = 86_400_000;
let db: TestDatabase;
let seed: SeedResult;
let app: TestApp;
let t: TenantFixture;
const ids: Record<string, string> = {};
const earlyEnd = new Date(Date.now() + 2 * DAY).toISOString();

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  t = seed.havana;
  app = testApp(db.pool);
});
afterAll(async () => {
  await db?.drop();
});

const owner = () => tokenFor(seed.users.havanaOwner);
const general = () => t.types.find((x) => x.code === "GENERAL")!;
const later = (days: number) => testApp(db.pool, { now: () => new Date(Date.now() + days * DAY) });
const shop = async (a: TestApp = app) => (await call(a, "GET", `${pub(t.clientId, t.brandId)}/events/${t.eventId}`)).body;
const phase = async (body: Record<string, unknown>) =>
  call(app, "POST", `${adm(t.clientId, t.brandId)}/events/${t.eventId}/ticket-types`, {
    token: await owner(),
    body: { maxQuantity: 10, countsAsAdult: true, presaleOf: general().id, ...body },
  });

describe("price phases", () => {
  it("a type before its start is not on sale, like one after its end", () => {
    const base: TicketTypeRule = { ...general(), salesStartAt: new Date("2026-11-01T04:00:00Z") };
    expect(rulesOnSale([base], new Date("2026-10-31T12:00:00Z"))[0]!.active).toBe(false);
    expect(rulesOnSale([base], new Date("2026-11-01T04:00:00Z"))[0]!.active).toBe(true);
  });

  it("an early bird, then a presale from its end: only the first is sold, the second is announced", async () => {
    const early = await phase({ code: "GENERAL_EARLY", name: "Admission générale — Lève-tôt", priceCents: 1995, salesEndAt: earlyEnd });
    expect(early.status, JSON.stringify(early.body)).toBe(201);
    ids.early = early.body.ticketType.id;
    const pre = await phase({ code: "GENERAL_PRE", name: "Admission générale — Prévente", priceCents: 2495, salesStartAt: earlyEnd, salesEndAt: new Date(Date.now() + 10 * DAY).toISOString() });
    expect(pre.status, JSON.stringify(pre.body)).toBe(201);
    ids.pre = pre.body.ticketType.id;
    expect(pre.body.ticketType.salesStartAt).toBe(earlyEnd);

    const now = await shop();
    expect(now.ticketTypes.map((x: { id: string }) => x.id)).toContain(ids.early);
    expect(now.ticketTypes.map((x: { id: string }) => x.id)).not.toContain(ids.pre);
    expect(now.upcoming).toEqual([expect.objectContaining({ id: ids.pre, presaleOf: general().id, priceCents: 2495, salesStartAt: earlyEnd })]);

    // Never sold before its start.
    const hold = await call(app, "POST", `${pub(t.clientId, t.brandId)}/holds`, { body: { sessionId: t.sessionId, items: [{ ticketTypeId: ids.pre, quantity: 1 }] } });
    expect(hold.status).toBe(422);
    expect(hold.body.error.details).toEqual([expect.objectContaining({ code: "inactive_ticket_type", ticketTypeId: ids.pre })]);
  });

  it("at the early bird's end, the presale takes over, on the shop and on alkao.ca", async () => {
    const then = later(3);
    const s = await shop(then);
    const on = s.ticketTypes.map((x: { id: string }) => x.id);
    expect(on).toContain(ids.pre);
    expect(on).not.toContain(ids.early);
    expect(s.upcoming).toEqual([]);
    const token = await owner();
    expect((await call(app, "PUT", `${adm(t.clientId, t.brandId)}/appearance`, { token, body: { showOnAlkao: true } })).status).toBe(200);
    // alkao.ca shows the phase on sale now, never one still to come.
    const homeNow = await (await app.request("/")).text();
    const homeThen = await (await then.request("/")).text();
    expect(homeNow).toContain(`Prévente −${Math.floor(((2995 - 1995) / 2995) * 100)} %`);
    expect(homeThen).toContain(`Prévente −${Math.floor(((2995 - 2495) / 2995) * 100)} %`);
  });

  it("refuses a phase that ends before it starts, at creation and on change", async () => {
    const bad = await phase({ code: "GENERAL_BAD", name: "Mauvais", priceCents: 2000, salesStartAt: new Date(Date.now() + 5 * DAY).toISOString(), salesEndAt: new Date(Date.now() + DAY).toISOString() });
    expect(bad.status).toBe(400);
    const moved = await call(app, "PATCH", `${adm(t.clientId, t.brandId)}/ticket-types/${ids.pre}`, {
      token: await owner(), body: { salesStartAt: new Date(Date.now() + 30 * DAY).toISOString() },
    });
    expect(moved.status).toBe(422);
    expect(moved.body.error.code).toBe("sales_window_invalid");
  });
});
