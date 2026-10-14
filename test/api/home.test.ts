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
    expect(Object.keys(data.events[0]).sort()).toEqual(["address", "brand", "brandId", "categories", "city", "count", "dates", "description", "ends", "id", "image", "map", "next", "place", "price", "shop", "starts", "text", "title", "url"]);
    expect(json).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(data.help.map((x: { id: string }) => x.id)).toContain("perdus");
  });
});

describe("Run 66: filters, search-engine data, calendar and installable home", () => {
  const page = async (qs = "") => (await app.request(`/${qs ? `?${qs}` : ""}`)).text();
  const found = (n: number) => `<strong>${n === 1 ? "1 événement" : `${n} événements`}</strong>`;
  const none = "Aucun événement en vente ne correspond";
  const ld = (html: string) => JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)![1]!) as Record<string, any>[];

  it("filters by price before taxes and by organizer, sorts by price, and keeps them on a new search", async () => {
    const h = seed.havana;
    await setOptIn(h.clientId, h.brandId, havanaOwner, true);
    // The lowest paid admission is 17,95 $.
    expect(await page("prix=under25")).toContain(found(1));
    expect(await page("prix=25to50")).toContain(none);
    expect(await page("prix=free")).toContain(none);
    const all = await page();
    expect(all).toContain("Prix avant taxes");
    expect(all).toMatch(/<a class="chip is-current" href="[^"]*" aria-current="true">Tous les prix<\/a>/);
    expect(all).toContain(">Moins de 25 $<");
    // A band with nothing in it is not offered.
    expect(all).not.toContain(">25 $ à 50 $<");
    // One organizer only: nothing to choose.
    expect(all).not.toContain('id="f-org"');

    const sorted = await page("tri=prix&prix=under25");
    expect(sorted).toContain(found(1));
    expect(sorted).toContain("· Moins de 25 $ · Prix le plus bas</p>");
    expect(sorted).toContain('<input type="hidden" name="prix" value="under25" />');
    expect(sorted).toContain('<input type="hidden" name="tri" value="prix" />');

    const mine = await page(`organisateur=${h.brandId.toUpperCase()}`);
    expect(mine).toContain(found(1));
    expect(mine).toContain('id="f-org"');
    expect(mine).toContain(`<input type="hidden" name="organisateur" value="${h.brandId}" />`);
    expect(await page(`organisateur=${seed.festi.brandId}`)).toContain(none);
    // Unknown values are dropped, never echoed.
    const bogus = await page("prix=%3Cb%3E&tri=hasard&organisateur=havana");
    expect(bogus).not.toContain('class="results"');
    expect(bogus).not.toContain("hasard");

    await db.pool.query(`UPDATE public.ticketing_ticket_types SET active = false WHERE event_id = $1 AND kind = 'admission' AND price_cents > 0`, [h.eventId]);
    try {
      expect(await page("prix=free")).toContain(found(1));
      expect(await page("prix=under25")).toContain(none);
    } finally {
      await db.pool.query(`UPDATE public.ticketing_ticket_types SET active = true WHERE event_id = $1`, [h.eventId]);
    }
  });

  it("describes every date to search engines, with its lowest price and its venue", async () => {
    const h = seed.havana;
    await setOptIn(h.clientId, h.brandId, havanaOwner, true);
    await db.pool.query(`UPDATE public.ticketing_venues SET address_line1 = '100 chemin du Lac' WHERE id = $1`, [h.venueId]);
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO public.ticketing_sessions (client_id, brand_id, event_id, starts_at, ends_at, capacity, status)
       VALUES ($1, $2, $3, now() + interval '40 days', now() + interval '40 days 3 hours', 50, 'on_sale') RETURNING id`, [h.clientId, h.brandId, h.eventId]);
    try {
      const events = ld(await page());
      expect(events).toHaveLength(2);
      expect(events[0]!.endDate).toBeUndefined();
      expect(new Date(events[1]!.endDate).getTime() - new Date(events[1]!.startDate).getTime()).toBe(3 * 3600_000);
      for (const e of events) {
        expect(e.offers).toEqual({
          "@type": "Offer",
          url: `https://alkao.test/acheter/${h.clientId}/${h.brandId}/${h.eventId}`,
          price: "17.95",
          priceCurrency: "CAD",
          availability: "https://schema.org/InStock",
          priceSpecification: { "@type": "PriceSpecification", minPrice: 17.95, priceCurrency: "CAD", valueAddedTaxIncluded: false },
        });
        expect(e.location).toEqual({
          "@type": "Place",
          name: "Havana Resort",
          address: { "@type": "PostalAddress", streetAddress: "100 chemin du Lac", addressLocality: "Maricourt", addressCountry: "CA" },
        });
      }
      const data = JSON.parse((await page()).match(/<script type="application\/json" id="alkao-data">([\s\S]*?)<\/script>/)![1]!);
      expect(data.events[0].address).toBe("Havana Resort, 100 chemin du Lac, Maricourt");
      expect(data.events[0].map).toBe("https://www.google.com/maps/search/?api=1&query=Havana%20Resort%2C%20100%20chemin%20du%20Lac%2C%20Maricourt");
      expect(data.events[0].starts).toHaveLength(2);
      expect(data.events[0].ends[0]).toBeNull();
      expect(data.events[0].ends[1]).toBe(events[1]!.endDate);
    } finally {
      await db.pool.query(`DELETE FROM public.ticketing_sessions WHERE id = $1`, [rows[0]!.id]);
      await db.pool.query(`UPDATE public.ticketing_venues SET address_line1 = NULL WHERE id = $1`, [h.venueId]);
    }
  });

  it("is installable: a manifest and app icons under its own policy", async () => {
    const res = await app.request("/");
    expect(res.headers.get("content-security-policy")).toContain("manifest-src 'self'");
    const html = await res.text();
    const href = html.match(/<link rel="manifest" href="([^"]+)" \/>/)![1]!;
    expect(html).toMatch(/<link rel="apple-touch-icon" href="\/assets\/home\/img\/icon-192\.png\?v=[0-9a-f]{10}" \/>/);
    const manifest = await app.request(href);
    expect(manifest.headers.get("content-type")).toBe("application/manifest+json");
    const body = (await manifest.json()) as { icons: { src: string; sizes: string }[] };
    expect(body).toMatchObject({ short_name: "ALKAO", start_url: "/", scope: "/", display: "standalone", background_color: "#060D1F", theme_color: "#060D1F" });
    for (const icon of body.icons) {
      const file = await app.request(new URL(icon.src, `https://alkao.test${href}`).pathname);
      expect(file.status, icon.src).toBe(200);
      expect(file.headers.get("content-type")).toBe("image/png");
      const bytes = new Uint8Array(await file.arrayBuffer());
      const size = (o: number) => (bytes[o]! << 24) | (bytes[o + 1]! << 16) | (bytes[o + 2]! << 8) | bytes[o + 3]!;
      expect(`${size(16)}x${size(20)}`).toBe(icon.sizes);
    }
  });
});

describe("Run 67: agenda, follow an organizer, accessibility", () => {
  const page = async (qs = "") => (await app.request(`/${qs ? `?${qs}` : ""}`)).text();
  const rows = (html: string) => html.split('class="agenda-row"').length - 1;

  it("lists every date day by day, within the chosen window, and keeps the view on a new search", async () => {
    const h = seed.havana;
    await setOptIn(h.clientId, h.brandId, havanaOwner, true);
    const { rows: added } = await db.pool.query<{ id: string }>(
      `INSERT INTO public.ticketing_sessions (client_id, brand_id, event_id, starts_at, capacity, status)
       VALUES ($1, $2, $3, now() + interval '3 days', 50, 'on_sale') RETURNING id`, [h.clientId, h.brandId, h.eventId]);
    try {
      const grid = await page();
      expect(grid).toContain('class="grid"');
      expect(grid).not.toContain('class="agenda"');
      expect(grid).toMatch(/<a class="chip is-current" href="[^"]*" aria-current="true"><svg[^>]*>.*?<\/svg>Grille<\/a>/);
      const agenda = await page("vue=agenda");
      expect(agenda).not.toContain('class="grid"');
      expect(rows(agenda)).toBe(2);
      expect(agenda.match(/class="agenda-date"/g)).toHaveLength(2);
      expect(agenda).toContain('aria-label="Voir les billets : Havana Resort — Événements 2026-2027, ');
      expect(agenda).toContain('<input type="hidden" name="vue" value="agenda" />');
      // Only the dates in the window: the one in three days.
      expect(rows(await page("vue=agenda&quand=week"))).toBe(1);
      expect(await page("vue=agenda&quand=today")).toContain("Aucun événement en vente ne correspond");
      expect(rows(await page("vue=agenda&lang=en"))).toBe(2);
      expect(await page("vue=calendrier")).toContain('class="grid"');
    } finally {
      await db.pool.query(`DELETE FROM public.ticketing_sessions WHERE id = $1`, [added[0]!.id]);
    }
  });

  it("offers to follow an organizer through its own newsletter route, confirmed by e-mail", async () => {
    const h = seed.havana;
    await setOptIn(h.clientId, h.brandId, havanaOwner, true);
    const html = await page(`organisateur=${h.brandId}`);
    expect(html).toContain(`data-follow="${h.brandId}" hidden>`);
    expect(html).toContain('<dialog class="sheet" id="dlg-follow"');
    const data = JSON.parse(html.match(/<script type="application\/json" id="alkao-data">([\s\S]*?)<\/script>/)![1]!);
    expect(data.events[0].brandId).toBe(h.brandId);
    expect(data.organizers).toEqual([{ id: h.brandId, name: expect.any(String), follow: `/v1/public/clients/${h.clientId}/brands/${h.brandId}/newsletter` }]);
    // The route the page calls is the Brand's real sign-up: pending until the e-mail is confirmed.
    const res = await app.request(data.organizers[0].follow, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "suivre@example.test", firstName: null, language: "fr", source: "alkao" }),
    });
    expect(res.status).toBe(202);
    const { rows } = await db.pool.query<{ status: string; source: string }>(
      `SELECT status, source FROM public.ticketing_newsletter_signups WHERE client_id = $1 AND brand_id = $2 AND email = 'suivre@example.test'`, [h.clientId, h.brandId]);
    expect(rows).toEqual([{ status: "pending", source: "alkao" }]);
  });

  it("has an accessibility page in both languages, in the home's look and under its policy", async () => {
    const res = await app.request("/accessibilite");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    const fr = await res.text();
    expect(fr).toContain('<html lang="fr-CA">');
    expect(fr).toContain("<title>Accessibilité — ALKAO</title>");
    expect(fr).toContain("WCAG 2.1");
    expect(fr).toContain("carte accompagnement loisir (CAL)");
    expect(fr).toContain('<link rel="canonical" href="https://alkao.test/accessibilite" />');
    // The header's links go back to the home's sections; the language switch stays on this page.
    expect(fr).toContain('<a href="/#evenements">Événements</a>');
    expect(fr).toContain('<a href="/accessibilite?lang=en" lang="en-CA" aria-label="English">EN</a>');
    expect(fr).not.toContain("alkao-data");
    const en = await (await app.request("/accessibilite?lang=en")).text();
    expect(en).toContain('<html lang="en-CA">');
    expect(en).toContain("<h1>Accessibility</h1>");
    expect(en).toContain('<a href="/?lang=en#evenements">Events</a>');
    // Linked from every home footer.
    expect(await page()).toContain('<a href="/accessibilite">Accessibilité</a>');
    expect(await page("lang=en")).toContain('<a href="/accessibilite?lang=en">Accessibility</a>');
  });
});

describe("Run 68: robots.txt and sitemap.xml", () => {
  it("lets search engines read the home and the shops, not the private pages", async () => {
    const res = await app.request("/robots.txt");
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const text = await res.text();
    expect(text).toContain("User-agent: *\nAllow: /\n");
    for (const path of ["/ops", "/billets", "/v1/", "/inscription", "/desabonnement", "/acheter/merci/"]) expect(text).toContain(`Disallow: ${path}\n`);
    expect(text).toContain("Sitemap: https://alkao.test/sitemap.xml\n");
  });

  it("lists the home, the accessibility page and the shop of every event the home lists", async () => {
    const h = seed.havana;
    const shop = `https://alkao.test/acheter/${h.clientId}/${h.brandId}/${h.eventId}`;
    const before = await (await app.request("/sitemap.xml")).text();
    expect(before).not.toContain(shop);
    await setOptIn(h.clientId, h.brandId, havanaOwner, true);
    const res = await app.request("/sitemap.xml");
    expect(res.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    const xml = await res.text();
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"')).toBe(true);
    expect(xml).toContain("<url><loc>https://alkao.test/</loc><xhtml:link rel=\"alternate\" hreflang=\"fr-CA\" href=\"https://alkao.test/\"/>");
    expect(xml).toContain("<loc>https://alkao.test/?lang=en</loc>");
    expect(xml).toContain("<loc>https://alkao.test/accessibilite?lang=en</loc>");
    expect(xml).toContain(`<url><loc>${shop}</loc></url>`);
    // Sales closed: off the home, so off the sitemap.
    await db.pool.query(`UPDATE public.ticketing_events SET sales_close_at = now() - interval '1 hour' WHERE id = $1`, [h.eventId]);
    expect(await (await app.request("/sitemap.xml")).text()).not.toContain(shop);
    // Without a public address there are no absolute URLs to list.
    const local = testApp(db.pool, {});
    expect((await local.request("/sitemap.xml")).status).toBe(404);
    expect(await (await local.request("/robots.txt")).text()).not.toContain("Sitemap:");
  });
});
