import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adm, call, pub, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { seedTwoTenants, type SeedResult } from "../helpers/seed.js";

/**
 * Run 69: what a buyer wants to know before choosing (category, minimum age, doors, language,
 * accessibility), set by the organizer, read by the shop, the ALKAO home and search engines.
 */
let db: TestDatabase;
let seed: SeedResult;
let app: TestApp;
let owner: string;

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  app = testApp(db.pool, { publicUrl: "https://alkao.test" });
  owner = await tokenFor(seed.users.havanaOwner);
});

afterAll(async () => {
  await db?.drop();
});

const DETAILS = { category: "spectacles", minAge: 18, doorsOpenMinutes: 45, language: "fr-en", accessibility: "Accès en fauteuil roulant.\nCarte CAL acceptée." };

describe("event details", () => {
  it("are optional, saved by the organizer, checked, and public with the event", async () => {
    const h = seed.havana;
    const path = `${adm(h.clientId, h.brandId)}/events/${h.eventId}`;
    const before = await call(app, "GET", `${pub(h.clientId, h.brandId)}/events/${h.eventId}`);
    expect(before.body.event).toMatchObject({ category: null, minAge: null, doorsOpenMinutes: null, language: null, accessibility: null });

    const saved = await call(app, "PATCH", path, { token: owner, body: { ...DETAILS, accessibility: `  ${DETAILS.accessibility}  ` } });
    expect(saved.status).toBe(200);
    expect(saved.body.event).toMatchObject(DETAILS);
    const shop = await call(app, "GET", `${pub(h.clientId, h.brandId)}/events/${h.eventId}`);
    expect(shop.body.event).toMatchObject(DETAILS);

    for (const bad of [{ category: "opera" }, { minAge: 30 }, { minAge: 1.5 }, { doorsOpenMinutes: -5 }, { doorsOpenMinutes: 900 }, { language: "es" }, { accessibility: "<b>oui</b>" }, { accessibility: "x".repeat(1001) }]) {
      expect((await call(app, "PATCH", path, { token: owner, body: bad })).status, JSON.stringify(bad).slice(0, 40)).toBe(400);
    }
    // The database refuses them too, whoever writes.
    await expect(db.pool.query(`UPDATE public.ticketing_events SET min_age = 40 WHERE id = $1`, [h.eventId])).rejects.toThrow(/check/);

    const cleared = await call(app, "PATCH", path, { token: owner, body: { category: null, minAge: null, doorsOpenMinutes: null, language: null, accessibility: null } });
    expect(cleared.body.event).toMatchObject({ category: null, minAge: null, doorsOpenMinutes: null, language: null, accessibility: null });
  });

  it("can be given when the event is created, and are kept by a duplicate", async () => {
    const h = seed.havana;
    const created = await call(app, "POST", `${adm(h.clientId, h.brandId)}/events`, {
      token: owner, body: { venueId: h.venueId, slug: "soiree-details", title: "Soirée avec détails", ...DETAILS, imageUrl: "https://photos.alkao.test/a.webp" },
    });
    expect(created.status).toBe(201);
    expect(created.body.event).toMatchObject(DETAILS);
    const copy = await call(app, "POST", `${adm(h.clientId, h.brandId)}/events/${created.body.event.id}/duplicate`, { token: owner, body: { title: "Soirée avec détails, 2e" } });
    expect(copy.status).toBe(201);
    const { rows } = await db.pool.query(`SELECT category, min_age, doors_open_minutes, language, accessibility, image_url FROM public.ticketing_events WHERE id = $1`, [copy.body.event.id]);
    expect(rows[0]).toEqual({ category: "spectacles", min_age: 18, doors_open_minutes: 45, language: "fr-en", accessibility: DETAILS.accessibility, image_url: "https://photos.alkao.test/a.webp" });
  });

  it("set the home's category, its age badge, the quick view and the search-engine data", async () => {
    const h = seed.havana;
    await db.pool.query(
      `INSERT INTO public.ticketing_brand_settings (client_id, brand_id, show_on_alkao) VALUES ($1, $2, true)
       ON CONFLICT (client_id, brand_id) DO UPDATE SET show_on_alkao = true`, [h.clientId, h.brandId]);
    await db.pool.query(`UPDATE public.ticketing_events SET description = 'Un festival pour toute la famille' WHERE id = $1`, [h.eventId]);
    const page = async (qs = "") => (await app.request(`/${qs ? `?${qs}` : ""}`)).text();
    // Guessed from the words while the organizer says nothing…
    expect(await page("categorie=famille")).toContain("<strong>1 événement</strong>");
    await call(app, "PATCH", `${adm(h.clientId, h.brandId)}/events/${h.eventId}`, { token: owner, body: DETAILS });
    // …and the organizer's choice wins once it is set.
    expect(await page("categorie=famille")).toContain("Aucun événement en vente ne correspond");
    expect(await page("categorie=spectacles")).toContain("<strong>1 événement</strong>");

    const html = await page();
    expect(html).toContain('<span class="pill pill-age" title="18 ans et plus">18+</span>');
    const data = JSON.parse(html.match(/<script type="application\/json" id="alkao-data">([\s\S]*?)<\/script>/)![1]!);
    const ev = data.events.find((e: { id: string }) => e.id === h.eventId);
    expect(ev.facts).toEqual(["Théâtre et humour", "18 ans et plus", "Ouverture des portes 45 min avant le début", "En français et en anglais"]);
    expect(ev.accessibility).toBe(DETAILS.accessibility);
    const en = JSON.parse((await page("lang=en")).match(/<script type="application\/json" id="alkao-data">([\s\S]*?)<\/script>/)![1]!);
    expect(en.events.find((e: { id: string }) => e.id === h.eventId).facts).toEqual(["Theatre and comedy", "Ages 18 and over", "Doors open 45 min before the start", "In French and English"]);

    const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)![1]!) as Record<string, string | string[]>[];
    const mine = ld.filter((e) => String(e.url).endsWith(h.eventId));
    expect(mine.length).toBeGreaterThan(0);
    for (const e of mine) {
      expect(e.typicalAgeRange).toBe("18-");
      expect(e.inLanguage).toEqual(["fr-CA", "en-CA"]);
      expect(new Date(String(e.startDate)).getTime() - new Date(String(e.doorTime)).getTime()).toBe(45 * 60_000);
    }
  });
});
