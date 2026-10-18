import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adm, call, pub, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { seedTwoTenants, type SeedResult } from "../helpers/seed.js";

/**
 * Run 93: the event page in full, as the organizer writes it: a duration and a format for the
 * hero, and the page's sections (summary, notice, highlights, gallery, "Le jour J", FAQ).
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
afterAll(async () => { await db?.drop(); });

const PAGE = {
  summary: "Un parcours en train · 5 stations · tout le site décoré",
  notice: "Certaines stations sont dans le noir.",
  highlights: [
    { title: "Le train de l'Halloween", text: "Un tour du site à bord du petit train.", imageUrl: "https://photos.alkao.test/train.webp" },
    { title: "Le village hanté", text: null, imageUrl: null },
  ],
  gallery: [{ url: "https://photos.alkao.test/1.webp", alt: "Le train la nuit" }, { url: "https://photos.alkao.test/2.webp", alt: null }],
  steps: [
    { title: "Arrivée", text: "Présentez votre billet à l'accueil.", imageUrl: null },
    { title: "Le tour", text: "Environ 45 minutes.", imageUrl: "https://photos.alkao.test/tour.webp" },
  ],
  faq: [{ question: "Faut-il réserver ?", answer: "Oui, les places sont par soirée." }],
};

describe("Run 93: the event page", () => {
  it("is saved by the organizer, checked, and public with the event", async () => {
    const h = seed.havana;
    const path = `${adm(h.clientId, h.brandId)}/events/${h.eventId}`;
    const before = await call(app, "GET", `${pub(h.clientId, h.brandId)}/events/${h.eventId}`);
    expect(before.body.event).toMatchObject({ durationMinutes: null, format: null, page: {} });

    const saved = await call(app, "PATCH", path, { token: owner, body: { durationMinutes: 90, format: "Parcours extérieur", page: PAGE } });
    expect(saved.status).toBe(200);
    expect(saved.body.event).toMatchObject({ durationMinutes: 90, format: "Parcours extérieur", page: PAGE });
    const shop = await call(app, "GET", `${pub(h.clientId, h.brandId)}/events/${h.eventId}`);
    expect(shop.body.event).toMatchObject({ durationMinutes: 90, format: "Parcours extérieur", page: PAGE });

    const bad = [
      { durationMinutes: 2 }, { durationMinutes: 2000 }, { format: "<i>x</i>" }, { format: "x".repeat(81) },
      { page: { gallery: [{ url: "http://photos.alkao.test/1.webp" }] } },
      { page: { gallery: [{ url: "javascript:alert(1)" }] } },
      { page: { highlights: [{ title: "<script>" }] } },
      { page: { faq: [{ question: "Oui ?", answer: "" }] } },
      { page: { faq: Array.from({ length: 21 }, () => ({ question: "Q", answer: "R" })) } },
      { page: { steps: [{ title: "x".repeat(81) }] } },
    ];
    for (const body of bad) {
      expect((await call(app, "PATCH", path, { token: owner, body })).status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    // The database refuses a page that is not a document, whoever writes.
    await expect(db.pool.query(`UPDATE public.ticketing_events SET page = '[]'::jsonb WHERE id = $1`, [h.eventId])).rejects.toThrow(/check/);

    const cleared = await call(app, "PATCH", path, { token: owner, body: { durationMinutes: null, format: null, page: {} } });
    expect(cleared.body.event).toMatchObject({ durationMinutes: null, format: null, page: { highlights: [], gallery: [], steps: [], faq: [] } });
  });

  it("can be given when the event is created, is kept by a duplicate, and only staff who edit the catalog change it", async () => {
    const h = seed.havana;
    const created = await call(app, "POST", `${adm(h.clientId, h.brandId)}/events`, {
      token: owner, body: { venueId: h.venueId, slug: "page-complete", title: "Page complète", durationMinutes: 45, format: "Spectacle", page: PAGE },
    });
    expect(created.status).toBe(201);
    expect(created.body.event).toMatchObject({ durationMinutes: 45, format: "Spectacle", page: PAGE });
    const copy = await call(app, "POST", `${adm(h.clientId, h.brandId)}/events/${created.body.event.id}/duplicate`, { token: owner, body: { title: "Page complète, 2e" } });
    expect(copy.status).toBe(201);
    const { rows } = await db.pool.query(`SELECT duration_minutes, format, page FROM public.ticketing_events WHERE id = $1`, [copy.body.event.id]);
    expect(rows[0]).toEqual({ duration_minutes: 45, format: "Spectacle", page: PAGE });

    const staff = await tokenFor(seed.users.havanaStaff);
    expect((await call(app, "PATCH", `${adm(h.clientId, h.brandId)}/events/${h.eventId}`, { token: staff, body: { page: PAGE } })).status).toBe(403);
    // Another Client's owner, through their own address.
    const festi = await tokenFor(seed.users.festiOwner);
    expect((await call(app, "PATCH", `${adm(seed.festi.clientId, seed.festi.brandId)}/events/${h.eventId}`, { token: festi, body: { page: PAGE } })).status).toBe(404);
  });
});
