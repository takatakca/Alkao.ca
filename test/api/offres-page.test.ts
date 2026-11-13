import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseQuery, renderHome, sharedUrl, type HomeBrand, type HomeEvent } from "../../src/api/home-view.js";
import { testApp, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { seedTwoTenants } from "../helpers/seed.js";

/**
 * Run 111: `/offres`, every offer on now as its own page to share, and share links on the
 * featured offer, each tagged with its network for the sales report (Run 49).
 */
const NOW = new Date("2026-11-13T15:00:00Z");
const event = (id: string, extra: Partial<HomeEvent> = {}): HomeEvent => ({
  id: `${id}0000000-0000-4000-8000-000000000000`.slice(0, 36), title: `Événement ${id}`, description: null, imageUrl: null, venueId: "v1", venueName: "Parc", venueCity: "Montréal",
  startsAt: new Date("2026-11-20T23:00:00Z"), fromCents: 2000, shopPath: `/acheter/c/b/${id}`, ...extra,
});
const brands = (events: HomeEvent[]): HomeBrand[] => [{ clientId: "c", brandId: "b", name: "Festival des saveurs", logoUrl: null, events }];
const EVENTS = [
  event("a", { presale: { priceCents: 1600, regularCents: 2000, endsAt: null, remaining: null }, fromCents: 1600 }),
  event("b"),
];
const render = (mode: "home" | "offres", lang: "fr" | "en" = "fr", params: Record<string, string> = {}) =>
  renderHome({ origin: "https://alkao.test", lang, brands: brands(EVENTS), query: parseQuery((n) => params[n]), now: NOW, asset: (n) => `/assets/home/${n}`, mode });
const listed = (html: string) => /<section class="section events" id="evenements"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";

describe("Run 111: the offers page and sharing", () => {
  it("tags a shared link with its network, keeping the page's own parameters", () => {
    const u = new URL(sharedUrl("https://alkao.test/acheter/c/b/a?coupon=X", "facebook", "a1"));
    expect(u.searchParams.get("coupon")).toBe("X");
    expect(Object.fromEntries([...u.searchParams].filter(([k]) => k.startsWith("utm_")))).toEqual({
      utm_source: "facebook", utm_medium: "social", utm_campaign: "alkao-offres", utm_content: "a1",
    });
    expect(new URL(sharedUrl("https://alkao.test/x", "courriel", "a1")).searchParams.get("utm_medium")).toBe("email");
  });

  it("is a page of its own: title, address, offers only, and its filters stay on it", () => {
    const html = render("offres");
    expect(html).toContain("<title>Préventes, rabais et bons d’achat — ALKAO</title>");
    expect(html).toContain('<link rel="canonical" href="https://alkao.test/offres" />');
    expect(html).toContain('<link rel="alternate" hreflang="en-CA" href="https://alkao.test/offres?lang=en" />');
    expect(html).toContain('<h1 id="hero-title">Toutes les offres en cours</h1>');
    const list = listed(html);
    expect(list).toContain("Événement a");
    expect(list).not.toContain("Événement b");
    // Always on the offers: no switch to turn them off, no « Passés ».
    expect(list).not.toContain("deal-chip");
    expect(list).not.toContain("period-switch");
    expect(html).toContain('action="/offres#evenements"');
    // The language switch stays on this page.
    expect(html).toMatch(/<div class="lang-switch"[^>]*>\s*<a href="\/offres"[^>]*>FR<\/a><a href="\/offres\?lang=en"/);
    expect(render("offres", "en")).toContain("<title>Presales, discounts and vouchers — ALKAO</title>");
    // The home keeps its own title and its link to the page, in the footer.
    const home = render("home");
    expect(home).toContain('<link rel="canonical" href="https://alkao.test/" />');
    expect(home).toContain('<a href="/offres">Toutes les offres</a>');
  });

  it("offers each network a plain link to share the featured offer, tagged for the sales report", () => {
    const html = render("home");
    const spot = /<article class="spotlight[\s\S]*?<\/article>/.exec(html)?.[0] ?? "";
    const links = [...spot.matchAll(/<a class="share-btn" data-net="([a-z]+)" href="([^"]+)"/g)].map((m) => [m[1], m[2]!.replace(/&amp;/g, "&")]);
    expect(links.map(([n]) => n)).toEqual(["facebook", "x", "whatsapp", "courriel"]);
    const fb = new URL(links[0]![1]!);
    expect(fb.origin).toBe("https://www.facebook.com");
    const shared = new URL(fb.searchParams.get("u")!);
    expect(shared.pathname).toBe("/acheter/c/b/a");
    expect(shared.searchParams.get("utm_source")).toBe("facebook");
    expect(new URL(links[1]![1]!).searchParams.get("url")).toContain("utm_source=x");
    expect(decodeURIComponent(links[2]![1]!)).toContain("utm_source=whatsapp");
    expect(links[3]![1]).toMatch(/^mailto:\?subject=/);
    // Opens in a new tab, says so, and leaks no referrer to the network.
    expect(spot).toContain('target="_blank" rel="noopener noreferrer" aria-label="Partager sur Facebook (nouvel onglet)"');
    // The copy button waits for the script (it needs the clipboard).
    expect(spot).toMatch(/<button class="share-btn" type="button" data-copy-link="[^"]*utm_source=lien[^"]*" data-copied="Lien copié" hidden>/);
    // The offers page shares itself.
    expect(render("offres")).toMatch(/<div class="share-row" role="group" aria-label="Partager les offres">[\s\S]*?offres%3Futm_source%3Dfacebook/);
  });
});

describe("Run 111: the /offres route", () => {
  let db: TestDatabase;
  let app: TestApp;
  beforeAll(async () => {
    db = await createTestDatabase();
    await seedTwoTenants(db.pool);
    app = testApp(db.pool, { publicUrl: "https://alkao.test" });
  });
  afterAll(async () => { await db?.drop(); });

  it("serves the page under the home's policy and lists it in the sitemap", async () => {
    const res = await app.request("/offres");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(await res.text()).toContain("Toutes les offres en cours");
    const sitemap = await (await app.request("/sitemap.xml")).text();
    expect(sitemap).toContain("<loc>https://alkao.test/offres</loc>");
    expect(sitemap).toContain("<loc>https://alkao.test/offres?lang=en</loc>");
  });
});
