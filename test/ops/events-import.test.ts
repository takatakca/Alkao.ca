import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTransaction } from "../../src/db/pool.js";
import { EventFile, importEvent, type ImportOptions } from "../../src/ops/events-import.js";
import { testApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { seedTwoTenants, type SeedResult } from "../helpers/seed.js";

// Run 91: Havana's owner-approved Halloween catalog, loaded the way an operator would.
let db: TestDatabase;
let seed: SeedResult;
const havana = EventFile.parse(JSON.parse(readFileSync(new URL("../../catalogs/havana-halloween-2026.json", import.meta.url), "utf8")));
const BEFORE = new Date("2026-10-01T12:00:00Z");

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
});
afterAll(async () => { await db?.drop(); });

const scope = () => ({ clientId: seed.havana.clientId, brandId: seed.havana.brandId });
const run = (opts: Partial<ImportOptions>, file = havana) =>
  withTransaction(db.pool, (tx) => importEvent(tx, scope(), file, { capacity: 300, publish: false, listOnAlkao: false, now: BEFORE, ...opts }));
const rows = async () => (await db.pool.query<{ starts_at: Date; status: string; capacity: number }>(
  `SELECT s.starts_at, s.status, s.capacity FROM public.ticketing_sessions s JOIN public.ticketing_events e ON e.id = s.event_id
   WHERE e.slug = 'halloween-havana-2026' ORDER BY s.starts_at`)).rows;

describe("Run 91: events:import", () => {
  it("takes the prices and dates from the file only", () => {
    expect(havana.ticketTypes.map((t) => [t.code, t.priceCents])).toEqual([["ADULT", 2500], ["CHILD", 1200]]);
    expect(havana.sessions).toHaveLength(5);
    expect(havana.event.imageUrl).toBe("https://www.promohavana.ca/photos/halloween-train.jpg");
  });

  it("refuses a Brand that is not provisioned, and dates without a capacity", async () => {
    const stranger = { clientId: "00000000-0000-4000-8000-0000000000aa", brandId: "00000000-0000-4000-8000-0000000000bb" };
    await expect(withTransaction(db.pool, (tx) => importEvent(tx, stranger, havana, { capacity: 10, publish: false, listOnAlkao: false, now: BEFORE })))
      .rejects.toThrow(/control:apply/);
    await expect(run({ capacity: null })).rejects.toThrow(/capacity/);
  });

  it("creates the event as a draft, then publishes it, puts only future dates on sale and lists it on alkao.ca", async () => {
    const first = await run({});
    expect(first).toMatchObject({ event: "created", ticketTypes: { created: ["ADULT", "CHILD"], kept: [] }, sessions: { created: 5, kept: 0, past: 0 } });
    expect((await rows()).map((r) => r.status)).toEqual(["draft", "draft", "draft", "draft", "draft"]);
    expect((await rows()).every((r) => r.capacity === 300)).toBe(true);
    const app = testApp(db.pool, { publicUrl: "https://alkao.test" });
    expect(await (await app.request("/")).text()).not.toContain("Halloween Havana 2026");

    // Run again later in October: nothing doubled, the past dates are not touched.
    const again = await run({ publish: true, listOnAlkao: true, now: new Date("2026-10-17T20:00:00Z") });
    expect(again).toMatchObject({ venue: "kept", event: "kept", ticketTypes: { created: [], kept: ["ADULT", "CHILD"] }, sessions: { created: 0, kept: 5, past: 0 }, published: true, listedOnAlkao: true });
    // The two dates still to come are on sale; the past ones stay as they were.
    expect((await rows()).map((r) => r.status)).toEqual(["draft", "draft", "draft", "on_sale", "on_sale"]);
    const { rows: [event] } = await db.pool.query<{ status: string; category: string }>(`SELECT status, category FROM public.ticketing_events WHERE slug = 'halloween-havana-2026'`);
    expect(event).toEqual({ status: "published", category: "famille" });
    const { rows: [settings] } = await db.pool.query<{ show_on_alkao: boolean }>(
      `SELECT show_on_alkao FROM public.ticketing_brand_settings WHERE client_id = $1 AND brand_id = $2`, [seed.havana.clientId, seed.havana.brandId]);
    expect(settings!.show_on_alkao).toBe(true);
    const audit = await db.pool.query(`SELECT count(*)::int AS n FROM public.ticketing_audit_log WHERE data->>'source' = 'events:import'`);
    expect(audit.rows[0].n).toBeGreaterThan(5);
  });

  it("on a fresh run late in the month, creates and sells only the dates still to come", async () => {
    await db.pool.query(`DELETE FROM public.ticketing_sessions WHERE event_id IN (SELECT id FROM public.ticketing_events WHERE slug = 'halloween-havana-2026')`);
    const late = await run({ publish: true, now: new Date("2026-10-17T20:00:00Z") });
    expect(late.sessions).toEqual({ created: 2, kept: 0, past: 3 });
    expect((await rows()).map((r) => [r.starts_at.toISOString(), r.status])).toEqual([
      ["2026-10-24T18:00:00.000Z", "on_sale"],
      ["2026-10-31T18:00:00.000Z", "on_sale"],
    ]);
  });

  it("puts the event on the alkao.ca home once published and listed", async () => {
    const soon = (days: number, hour: number) => new Date(Date.now() + days * 86_400_000 + hour * 3_600_000).toISOString();
    const upcoming = { ...havana, event: { ...havana.event, slug: "halloween-upcoming" }, sessions: [{ startsAt: soon(30, 0), endsAt: soon(30, 8) }] };
    await run({ publish: true, listOnAlkao: true, now: new Date() }, upcoming);
    const app = testApp(db.pool, { publicUrl: "https://alkao.test" });
    const home = await (await app.request("/")).text();
    expect(home).toContain("Halloween Havana 2026");
    expect(home).toMatch(/À partir de 12\s\$ \+ taxes/);
  });

  it("brings Havana's page from the file, and --update-page refreshes it without touching prices or dates (Run 94)", async () => {
    expect(havana.event.page?.highlights.map((h) => h.title)).toEqual(["Le train hanté", "Le parcours lumineux", "La citrouille géante", "Les allées illuminées", "Le bar et la terrasse"]);
    expect(havana.event.page?.gallery.every((g) => g.url.startsWith("https://www.promohavana.ca/photos/"))).toBe(true);
    const page = async () => (await db.pool.query(`SELECT format, page FROM public.ticketing_events WHERE slug = 'halloween-havana-2026'`)).rows[0];
    // Created earlier in this file from the same catalog: the page came with it.
    expect((await page()).page.faq).toHaveLength(6);
    const { rows: [adult] } = await db.pool.query(`SELECT description, price_cents FROM public.ticketing_ticket_types WHERE code = 'ADULT' AND event_id = (SELECT id FROM public.ticketing_events WHERE slug = 'halloween-havana-2026')`);
    expect(adult).toMatchObject({ price_cents: 2500 });
    expect(adult.description).toMatch(/parcours lumineux et le train hanté/);

    // The owner changes the page; a run without --update-page keeps what is there, with it the file wins.
    const changed = { ...havana, event: { ...havana.event, format: "Soirée extérieure", page: { ...havana.event.page!, summary: "Nouveau résumé" } },
      ticketTypes: havana.ticketTypes.map((t) => ({ ...t, priceCents: t.priceCents + 500, description: `${t.name} : tout compris` })) };
    expect((await run({}, changed)).event).toBe("kept");
    expect((await page()).format).toBe("Événement extérieur");
    const r = await run({ updatePage: true }, changed);
    expect(r.event).toBe("updated");
    expect(await page()).toMatchObject({ format: "Soirée extérieure", page: { summary: "Nouveau résumé" } });
    const { rows: types } = await db.pool.query(`SELECT code, description, price_cents FROM public.ticketing_ticket_types
      WHERE event_id = (SELECT id FROM public.ticketing_events WHERE slug = 'halloween-havana-2026') ORDER BY code`);
    // What each ticket includes follows the file; the price never does.
    expect(types).toEqual([
      { code: "ADULT", description: "Adulte : tout compris", price_cents: 2500 },
      { code: "CHILD", description: "Enfant (5 ans et plus) : tout compris", price_cents: 1200 },
    ]);
  });

  it("checks the API's own rules on each row", async () => {
    const wrong = { ...havana, event: { ...havana.event, slug: "halloween-wrong" }, sessions: [{ startsAt: "2026-11-07T22:00:00-05:00", endsAt: "2026-11-07T14:00:00-05:00" }] };
    await expect(run({}, wrong)).rejects.toThrow(/endsAt must be after startsAt/);
  });
});

describe("Run 99: events:import with presales, passes and coupons", () => {
  // A made-up three-day festival: day tickets, a presale of them listed first, a pass, a coupon.
  const at = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
  const festival = () => EventFile.parse({
    venue: havana.venue,
    event: { slug: "festival-saveurs-test", title: "Festival des saveurs (test)", category: "gastronomie" },
    sessions: [{ startsAt: at(40) }, { startsAt: at(41) }, { startsAt: at(42) }],
    ticketTypes: [
      { code: "JOUR_PRE", name: "Billet d'un jour — Prévente", priceCents: 2400, maxQuantity: 10, countsAsAdult: true, presaleOfCode: "JOUR", quantityLimit: 100, sortOrder: 0 },
      { code: "JOUR", name: "Billet d'un jour", priceCents: 3000, maxQuantity: 10, countsAsAdult: true, sortOrder: 1 },
      { code: "PASSE_3J", name: "Passe festival — 3 jours", priceCents: 7500, maxQuantity: 10, countsAsAdult: true, pass: true, sortOrder: 2 },
    ],
    promoCodes: [{ code: "SAVEURS10", kind: "percent", percent: 10, public: true, label: "Coupon lancement", endsAt: at(30) }],
  });
  const now = () => new Date();

  it("ties each presale to its regular ticket by code, makes the pass and the coupon, then keeps them", async () => {
    const first = await run({ publish: true, now: now() }, festival());
    expect(first).toMatchObject({ event: "created", ticketTypes: { created: ["JOUR_PRE", "JOUR", "PASSE_3J"], kept: [] }, promoCodes: { created: ["SAVEURS10"], kept: [] } });
    const { rows } = await db.pool.query(
      `SELECT t.code, t.pass, t.quantity_limit, r.code AS regular FROM public.ticketing_ticket_types t
       LEFT JOIN public.ticketing_ticket_types r ON r.id = t.presale_of WHERE t.event_id = $1 ORDER BY t.sort_order`, [first.eventId]);
    expect(rows).toEqual([
      { code: "JOUR_PRE", pass: false, quantity_limit: 100, regular: "JOUR" },
      { code: "JOUR", pass: false, quantity_limit: null, regular: null },
      { code: "PASSE_3J", pass: true, quantity_limit: null, regular: null },
    ]);
    const { rows: [coupon] } = await db.pool.query(`SELECT public, label, percent FROM public.ticketing_promo_codes WHERE event_id = $1`, [first.eventId]);
    expect(coupon).toEqual({ public: true, label: "Coupon lancement", percent: 10 });

    // The shop sells all of it: the presale, the pass on every date, the coupon.
    const app = testApp(db.pool);
    const shop = await app.request(`/v1/public/clients/${seed.havana.clientId}/brands/${seed.havana.brandId}/events/${first.eventId}`);
    const body = await shop.json() as { ticketTypes: { code: string; pass: boolean; remaining: number | null }[]; coupons: { code: string }[]; sessions: unknown[] };
    expect(body.ticketTypes.map((t) => [t.code, t.pass, t.remaining])).toEqual([["JOUR_PRE", false, 100], ["JOUR", false, null], ["PASSE_3J", true, null]]);
    expect(body.coupons.map((c) => c.code)).toEqual(["SAVEURS10"]);
    expect(body.sessions).toHaveLength(3);

    const again = await run({ now: now() }, festival());
    expect(again).toMatchObject({ event: "kept", ticketTypes: { created: [], kept: ["JOUR_PRE", "JOUR", "PASSE_3J"] }, promoCodes: { created: [], kept: ["SAVEURS10"] } });
  });

  it("refuses a presale of a ticket the event does not have, and keeps the presale rules", async () => {
    const file = festival();
    const stray = { ...file, event: { ...file.event, slug: "festival-stray" }, ticketTypes: [{ ...file.ticketTypes[0]!, presaleOfCode: "NOPE" }] };
    await expect(run({ now: now() }, stray)).rejects.toThrow(/presaleOfCode NOPE/);
    const endless = { ...file, event: { ...file.event, slug: "festival-endless" }, ticketTypes: [file.ticketTypes[1]!, { ...file.ticketTypes[0]!, quantityLimit: null }] };
    await expect(run({ now: now() }, endless)).rejects.toThrow(/a presale ends on a date or after a quantity/);
  });
});
