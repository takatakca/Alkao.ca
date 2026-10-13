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
    // Run 64: one script, its own, under script-src 'self' (no inline script, no module).
    expect([...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1])).toEqual([expect.stringMatching(/^\/assets\/home\/home\.js\?v=[0-9a-f]{10}$/)]);
    expect(html).not.toContain('type="module"');

    const en = await app.request("/?lang=en");
    const enHtml = await en.text();
    expect(en.status).toBe(200);
    expect(enHtml).toContain('<html lang="en-CA">');
    expect(enHtml).toContain("Events on sale");
  });

  it("stays empty when the deployment-wide Ticketing switch is disabled", async () => {
    await setOptIn(seed.havana.clientId, seed.havana.brandId, havanaOwner, true);
    const disabled = testApp(db.pool, { publicUrl: "https://alkao.test", operationalApiEnabled: false });
    const html = await (await disabled.request("/")).text();
    expect(html).not.toContain(baselineEvent.title);
    expect(html).toContain("Aucun organisateur");
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

describe("Run 64: the premium platform home", () => {
  const page = async (qs = "") => (await app.request(`/${qs ? `?${qs}` : ""}`)).text();
  const found = (n: number) => `<strong>${n === 1 ? "1 événement" : `${n} événements`}</strong>`;
  const none = "Aucun événement en vente ne correspond";

  it("loads only its own versioned files, under a strict policy", async () => {
    const res = await app.request("/");
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).not.toContain("unsafe");
    const html = await res.text();
    const named = [...html.matchAll(/\/assets\/home\/[^"?]+\?v=[0-9a-f]{10}/g)].map((m) => m[0]);
    expect(named.length).toBeGreaterThan(10);
    for (const url of new Set(named)) {
      const file = await app.request(url);
      expect(file.status, url).toBe(200);
      expect(file.headers.get("cache-control"), url).toBe("public, max-age=31536000, immutable");
      expect(file.headers.get("x-content-type-options")).toBe("nosniff");
    }
    expect((await app.request("/assets/home/home.css")).headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect((await app.request("/assets/home/home.css?v=old")).headers.get("cache-control")).toBe("public, max-age=300");
    expect((await app.request("/assets/home/img/nope.webp")).status).toBe(404);
    expect((await app.request("/assets/home/../../src/server.ts")).status).toBe(404);
  });

  it("shows the lowest paid admission before taxes, Free when all are free, and every date with seats", async () => {
    const h = seed.havana;
    await setOptIn(h.clientId, h.brandId, havanaOwner, true);
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO public.ticketing_sessions (client_id, brand_id, event_id, starts_at, capacity, status)
       VALUES ($1, $2, $3, now() + interval '40 days', 50, 'on_sale') RETURNING id`, [h.clientId, h.brandId, h.eventId]);
    try {
      const fr = await page();
      // The child ticket (17,95 $) is the lowest paid admission; the free toddler ticket and the add-on do not count.
      expect(fr).toMatch(/À partir de 17,95\s\$ \+ taxes/);
      expect(fr).toContain(">2 dates<");
      expect(await page("lang=en")).toMatch(/From \$17\.95 \+ taxes/);
      await db.pool.query(`UPDATE public.ticketing_ticket_types SET active = false WHERE event_id = $1 AND kind = 'admission' AND price_cents > 0`, [h.eventId]);
      expect(await page()).toContain('<p class="price">Gratuit</p>');
    } finally {
      await db.pool.query(`UPDATE public.ticketing_ticket_types SET active = true WHERE event_id = $1`, [h.eventId]);
      await db.pool.query(`DELETE FROM public.ticketing_sessions WHERE id = $1`, [rows[0]!.id]);
    }
  });

  it("searches on the server by words, city, date and category, and drops unknown values", async () => {
    const h = seed.havana;
    await setOptIn(h.clientId, h.brandId, havanaOwner, true);
    expect(await page("q=evenements%202026#evenements")).toContain(found(1));
    expect(await page("q=jazz")).toContain(none);
    expect(await page("ville=maricourt")).toContain(found(1));
    expect(await page("ville=Laval")).toContain(none);
    // The session is 30 days away.
    expect(await page("quand=month")).toContain(found(1));
    expect(await page("quand=week")).toContain(none);
    expect(await page("quand=today")).toContain(none);
    expect(await page("categorie=festivals")).toContain(none);
    await db.pool.query(`UPDATE public.ticketing_events SET description = 'Un festival sur glace pour toute la famille' WHERE id = $1`, [h.eventId]);
    expect(await page("categorie=festivals")).toContain(found(1));
    expect(await page("categorie=famille")).toContain(found(1));
    expect(await page("categorie=sports")).toContain(none);
    const bogus = await page("categorie=%3Cscript%3E&quand=hier");
    expect(bogus).not.toContain('class="results"');
    expect(bogus).not.toContain("<script>");
  });

  it("gives the page's script inert data about events only, never about buyers", async () => {
    const h = seed.havana;
    await setOptIn(h.clientId, h.brandId, havanaOwner, true);
    await db.pool.query(`UPDATE public.ticketing_events SET title = $2 WHERE id = $1`, [h.eventId, "</script><script>alert(1)</script>"]);
    const html = await page();
    const json = html.match(/<script type="application\/json" id="alkao-data">([\s\S]*?)<\/script>/)![1]!;
    expect(json).not.toContain("<");
    const data = JSON.parse(json);
    expect(data.events).toHaveLength(1);
    expect(data.events[0].title).toBe("</script><script>alert(1)</script>");
    expect(Object.keys(data.events[0]).sort()).toEqual(["brand", "categories", "city", "count", "dates", "description", "id", "image", "next", "place", "price", "shop", "text", "title", "url"]);
    expect(json).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(data.help.map((x: { id: string }) => x.id)).toContain("perdus");
  });
});
