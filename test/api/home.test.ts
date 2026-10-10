import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adm, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { seedTwoTenants, type SeedResult } from "../helpers/seed.js";

let db: TestDatabase;
let seed: SeedResult;
let app: TestApp;
let havanaOwner: string;
let baselineEvent: { title: string; description: string | null };

const appearance = (clientId: string, brandId: string) => `${adm(clientId, brandId)}/appearance`;

async function setOptIn(clientId: string, brandId: string, token: string, showOnAlkao: boolean) {
  const response = await app.request(appearance(clientId, brandId), {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ showOnAlkao }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { appearance: { showOnAlkao: boolean } };
}

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  app = testApp(db.pool, { publicUrl: "https://alkao.test" });
  havanaOwner = await tokenFor(seed.users.havanaOwner);
  const { rows } = await db.pool.query<{ title: string; description: string | null }>(
    "SELECT title, description FROM public.ticketing_events WHERE id = $1",
    [seed.havana.eventId],
  );
  baselineEvent = rows[0]!;
});

beforeEach(async () => {
  await db.pool.query("UPDATE public.ticketing_brand_settings SET show_on_alkao = false");
  await db.pool.query("UPDATE public.ticketing_events SET status = 'published', sales_open_at = NULL, sales_close_at = NULL");
  await db.pool.query("UPDATE public.ticketing_events SET title = $2, description = $3 WHERE id = $1", [seed.havana.eventId, baselineEvent.title, baselineEvent.description]);
  await db.pool.query("UPDATE public.ticketing_sessions SET status = 'on_sale', starts_at = now() + interval '30 days'");
});

afterAll(async () => {
  await db?.drop();
});

describe("ALKAO public platform homepage", () => {
  it("is French by default, English on request, and publishes no Brand by default", async () => {
    const fr = await app.request("/");
    const html = await fr.text();
    expect(fr.status).toBe(200);
    expect(html).toContain('<html lang="fr-CA">');
    expect(html).toContain("Événements en vente");
    expect(html).not.toContain("Havana Resort — Événements 2026-2027");
    expect(html).not.toContain("FESTI-ICE 2026-2027");
    expect(html).toContain('hreflang="en-CA"');
    expect(html).not.toContain('<script src=');
    expect(html).not.toContain('type="module"');

    const en = await app.request("/?lang=en");
    const enHtml = await en.text();
    expect(en.status).toBe(200);
    expect(enHtml).toContain('<html lang="en-CA">');
    expect(enHtml).toContain("Events on sale");
  });

  it("shows only an explicitly opted-in Brand and links to its existing hosted shop", async () => {
    const saved = await setOptIn(seed.havana.clientId, seed.havana.brandId, havanaOwner, true);
    expect(saved.appearance.showOnAlkao).toBe(true);

    const response = await app.request("/");
    const html = await response.text();
    expect(html).toContain("Havana Resort — Événements 2026-2027");
    expect(html).not.toContain("FESTI-ICE 2026-2027");
    expect(html).toContain(`/acheter/${seed.havana.clientId}/${seed.havana.brandId}/${seed.havana.eventId}`);
    expect(html).toContain('"@type":"Event"');
    expect(html).toContain('"organizer":{"@type":"Organization","name":"Havana Resort — Événements"}');
  });

  it("hides opted-in events that are not publicly sellable", async () => {
    await setOptIn(seed.havana.clientId, seed.havana.brandId, havanaOwner, true);

    await db.pool.query("UPDATE public.ticketing_events SET status = 'draft' WHERE id = $1", [seed.havana.eventId]);
    expect(await (await app.request("/")).text()).not.toContain("Havana Resort — Événements 2026-2027");

    await db.pool.query("UPDATE public.ticketing_events SET status = 'published', sales_close_at = now() - interval '1 minute' WHERE id = $1", [seed.havana.eventId]);
    expect(await (await app.request("/")).text()).not.toContain("Havana Resort — Événements 2026-2027");

    await db.pool.query("UPDATE public.ticketing_events SET sales_close_at = NULL WHERE id = $1", [seed.havana.eventId]);
    await db.pool.query("UPDATE public.ticketing_sessions SET status = 'paused' WHERE id = $1", [seed.havana.sessionId]);
    expect(await (await app.request("/")).text()).not.toContain("Havana Resort — Événements 2026-2027");
  });

  it("escapes Brand/event content and keeps JSON-LD non-executable", async () => {
    await setOptIn(seed.havana.clientId, seed.havana.brandId, havanaOwner, true);
    await db.pool.query("UPDATE public.ticketing_events SET title = $2, description = $3 WHERE id = $1", [
      seed.havana.eventId,
      '<script>alert("x")</script>',
      '<img src=x onerror=alert(1)>',
    ]);
    const html = await (await app.request("/")).text();
    expect(html).not.toContain('<script>alert("x")</script>');
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("\\u003cscript");
  });

  it("stops publishing immediately when the Brand opts out", async () => {
    await setOptIn(seed.havana.clientId, seed.havana.brandId, havanaOwner, true);
    expect(await (await app.request("/")).text()).toContain(baselineEvent.title);
    await setOptIn(seed.havana.clientId, seed.havana.brandId, havanaOwner, false);
    expect(await (await app.request("/")).text()).not.toContain(baselineEvent.title);
  });

  it("allows a white-label deployment to redirect only / to a validated home URL", async () => {
    const whiteLabel = testApp(db.pool, {
      publicUrl: "https://billets.example.ca",
      homeUrl: "https://www.example.ca/billets",
    });
    const response = await whiteLabel.request("/");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://www.example.ca/billets");
    expect((await whiteLabel.request("/health")).status).toBe(200);
  });
});
