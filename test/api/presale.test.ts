import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adm, call, pub, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { seedTwoTenants, type SeedResult, type TenantFixture } from "../helpers/seed.js";

/**
 * Run 72: presale codes. Before the public sale opens, a code's holders buy from the code's own
 * time; same prices, seats and end of sales as everyone else.
 */
let db: TestDatabase;
let seed: SeedResult;
let app: TestApp;
let owner: string;
const hour = 3600_000;
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
const typeId = (t: TenantFixture, code: string) => t.types.find((x) => x.code === code)!.id;
const hold = (t: TenantFixture, extra: Record<string, unknown> = {}) =>
  call(app, "POST", `${pub(t.clientId, t.brandId)}/holds`, { body: { sessionId: t.sessionId, items: [{ ticketTypeId: typeId(t, "GENERAL"), quantity: 1 }], ...extra } });
const createCode = (t: TenantFixture, body: Record<string, unknown>, token = owner) =>
  call(app, "POST", `${adm(t.clientId, t.brandId)}/events/${t.eventId}/presale-codes`, { token, body });

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  app = testApp(db.pool);
  owner = await tokenFor(seed.users.festiOwner);
});

afterAll(async () => {
  await db?.drop();
});

describe("presale codes", () => {
  it("are created and turned off by the organizer, one code per event", async () => {
    const f = seed.festi;
    const made = await createCode(f, { code: "membres-26", label: "Membres", opensAt: iso(-hour) });
    expect(made.status).toBe(201);
    expect(made.body.presaleCode).toMatchObject({ code: "MEMBRES-26", label: "Membres", active: true });
    expect((await createCode(f, { code: "MEMBRES-26", opensAt: iso(-hour) })).status).toBe(409);
    expect((await createCode(f, { code: "a b", opensAt: iso(-hour) })).status).toBe(400);
    // Another tenant's people cannot manage this event's codes.
    expect((await createCode(f, { code: "AUTRE", opensAt: iso(-hour) }, await tokenFor(seed.users.havanaOwner))).status).toBe(404);
    const list = await call(app, "GET", `${adm(f.clientId, f.brandId)}/events/${f.eventId}/presale-codes`, { token: owner });
    expect(list.body.presaleCodes.map((p: { code: string }) => p.code)).toEqual(["MEMBRES-26"]);
  });

  it("open the sale before the public opening, from their own time only", async () => {
    const f = seed.festi;
    await db.pool.query(`UPDATE public.ticketing_events SET sales_open_at = now() + interval '2 days', sales_close_at = NULL WHERE id = $1`, [f.eventId]);
    await createCode(f, { code: "TOT", opensAt: iso(2 * hour) });

    // Without a code, or with a wrong one: not open yet, said as such.
    expect((await hold(f)).body.error.code).toBe("sales_not_open");
    expect((await hold(f, { presaleCode: "INCONNU" })).body.error.code).toBe("sales_not_open");
    // A code whose presale has not started yet does not open it either.
    expect((await hold(f, { presaleCode: "tot" })).body.error.code).toBe("sales_not_open");
    // A code whose presale has started does (case and spaces do not matter).
    const ok = await hold(f, { presaleCode: " membres-26 " });
    expect(ok.status).toBe(201);
    expect(ok.body.hold.quote.totalCents).toBeGreaterThan(0);

    // The shop checks a code before the choice.
    const check = (code: string) => call(app, "POST", `${pub(f.clientId, f.brandId)}/events/${f.eventId}/presale`, { body: { code } });
    expect((await check("membres-26")).body.presale.opensAt).toBeTruthy();
    expect((await check("INCONNU")).status).toBe(404);
    expect((await check("INCONNU")).body.error.code).toBe("presale_code_invalid");

    // Turned off: it opens nothing any more.
    const { rows } = await db.pool.query<{ id: string }>(`SELECT id FROM public.ticketing_presale_codes WHERE code = 'MEMBRES-26'`);
    await call(app, "PATCH", `${adm(f.clientId, f.brandId)}/presale-codes/${rows[0]!.id}`, { token: owner, body: { active: false } });
    expect((await hold(f, { presaleCode: "MEMBRES-26" })).body.error.code).toBe("sales_not_open");
    expect((await check("MEMBRES-26")).status).toBe(404);
    // Another event's (or tenant's) code opens nothing here.
    const h = seed.havana;
    await db.pool.query(
      `INSERT INTO public.ticketing_presale_codes (client_id, brand_id, event_id, code, opens_at) VALUES ($1, $2, $3, 'HAVANA', now() - interval '1 day')`,
      [h.clientId, h.brandId, h.eventId]);
    expect((await hold(f, { presaleCode: "HAVANA" })).body.error.code).toBe("sales_not_open");
  });

  it("never reopen a sale that has closed", async () => {
    const f = seed.festi;
    await call(app, "PATCH", `${adm(f.clientId, f.brandId)}/presale-codes/${(await db.pool.query<{ id: string }>(`SELECT id FROM public.ticketing_presale_codes WHERE code = 'MEMBRES-26'`)).rows[0]!.id}`, { token: owner, body: { active: true } });
    await db.pool.query(`UPDATE public.ticketing_events SET sales_open_at = now() - interval '2 days', sales_close_at = now() - interval '1 hour' WHERE id = $1`, [f.eventId]);
    expect((await hold(f, { presaleCode: "MEMBRES-26" })).body.error.code).toBe("session_not_available");
    await db.pool.query(`UPDATE public.ticketing_events SET sales_open_at = NULL, sales_close_at = NULL WHERE id = $1`, [f.eventId]);
    // Once the public sale is open, nobody needs a code.
    expect((await hold(f)).status).toBe(201);
  });
});
