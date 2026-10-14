import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adm, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { seedTwoTenants, type SeedResult } from "../helpers/seed.js";

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
beforeEach(async () => {
  await db.pool.query("UPDATE public.ticketing_brand_settings SET show_on_alkao = false");
  await db.pool.query("UPDATE public.ticketing_events SET status = 'published', sales_open_at = NULL, sales_close_at = NULL");
  await db.pool.query("UPDATE public.ticketing_sessions SET status = 'on_sale', starts_at = now() + interval '30 days'");
});
afterAll(async () => { await db?.drop(); });

const optIn = async () => {
  const { clientId, brandId } = seed.havana;
  const response = await app.request(`${adm(clientId, brandId)}/appearance`, {
    method: "PUT",
    headers: { authorization: `Bearer ${owner}`, "content-type": "application/json" },
    body: JSON.stringify({ showOnAlkao: true }),
  });
  expect(response.status).toBe(200);
};

describe("Run 73: public venue discovery", () => {
  it("shows no private venue and has no listing before organizer opt-in", async () => {
    const { clientId, brandId, venueId } = seed.havana;
    const details = `/salles/${clientId}/${brandId}/${venueId}`;
    expect((await app.request("/salles")).status).toBe(200);
    expect((await (await app.request("/salles")).text())).toContain("Aucune salle");
    expect((await app.request(details)).status).toBe(404);
    expect((await (await app.request("/sitemap.xml")).text())).not.toContain(details);
  });

  it("publishes only venues with on-sale events from opted-in operational Brands", async () => {
    await optIn();
    const { clientId, brandId, venueId } = seed.havana;
    const path = `/salles/${clientId}/${brandId}/${venueId}`;
    const directory = await (await app.request("/salles")).text();
    expect(directory).toContain(`href="${path}"`);
    expect(directory).toContain("Havana Resort");
    expect(directory).not.toContain("FESTI-ICE");
    const res = await app.request(path);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    const html = await res.text();
    expect(html).toContain("Havana Resort — Événements 2026-2027");
    expect(html).toContain('type="application/ld+json"');
    expect(html).toContain(`https://alkao.test${path}`);
    expect(html).toContain(`/acheter/${clientId}/${brandId}/`);
    expect((await (await app.request("/")).text())).toContain(`href="${path}"`);
    expect((await (await app.request("/sitemap.xml")).text())).toContain(`<loc>https://alkao.test${path}</loc>`);
    expect((await app.request(`/salles/${seed.festiIce.clientId}/${seed.festiIce.brandId}/${seed.festiIce.venueId}`)).status).toBe(404);
  });

  it("supports English, hides unsold venues promptly and does not expose white-label listings", async () => {
    await optIn();
    const { clientId, brandId, venueId, eventId } = seed.havana;
    const path = `/salles/${clientId}/${brandId}/${venueId}`;
    const english = await (await app.request(`${path}?lang=en`)).text();
    expect(english).toContain('<html lang="en-CA">');
    expect(english).toContain("Upcoming events");
    expect(english).toContain(`href="https://alkao.test${path}?lang=en"`);
    expect((await app.request("/salles/not-a-uuid/a/b")).status).toBe(404);
    const whiteLabel = testApp(db.pool, {
      publicUrl: "https://billets.example.ca", homeUrl: "https://www.example.ca/billets",
    });
    expect((await whiteLabel.request("/salles")).status).toBe(404);
    expect((await whiteLabel.request(path)).status).toBe(404);
    await db.pool.query("UPDATE public.ticketing_events SET sales_close_at = now() - interval '1 hour' WHERE id = $1", [eventId]);
    expect((await app.request(path)).status).toBe(404);
    expect((await (await app.request("/sitemap.xml")).text())).not.toContain(path);
  });
});
