import { describe, expect, it } from "vitest";
import { parseQuery, renderHome, type HomeBrand, type HomeEvent } from "../../src/api/home-view.js";

/** Run 97: presales and coupons on alkao.ca, from made-up events only. */
const NOW = new Date("2026-11-02T15:00:00Z");
const event = (id: string, extra: Partial<HomeEvent> = {}): HomeEvent => ({
  id, title: `Événement ${id}`, description: null, imageUrl: null, venueId: "v1", venueName: "Parc", venueCity: "Montréal",
  startsAt: new Date("2026-11-20T23:00:00Z"), fromCents: 2000, shopPath: `/acheter/c/b/${id}`, ...extra,
});
const brands = (events: HomeEvent[]): HomeBrand[] => [{ clientId: "c", brandId: "b", name: "Festival des saveurs", logoUrl: null, events }];
const render = (events: HomeEvent[], lang: "fr" | "en" = "fr") =>
  renderHome({ origin: "https://alkao.test", lang, brands: brands(events), query: parseQuery(() => undefined), now: NOW, asset: (n) => `/assets/home/${n}` });
const rail = (html: string) => /<div class="rail" id="deals-rail"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/.exec(html)?.[0] ?? "";

describe("presales and coupons on alkao.ca", () => {
  const four = [
    event("a", { presale: { priceCents: 1600, regularCents: 2000, endsAt: "2026-11-10T04:59:00Z", remaining: 40 } }),
    event("b", { coupon: { label: "Coupon famille", percent: null, amountCents: 500, endsAt: null } }),
    event("c"),
    event("d", { presale: { priceCents: 1999, regularCents: 2000, endsAt: null, remaining: 0 } }),
  ];

  it("gathers the events with a presale or a coupon in their own rail, each card saying which", () => {
    const html = render(four);
    expect(html).toContain(">Préventes et rabais<");
    const deals = rail(html);
    expect(deals).toContain("Événement a");
    expect(deals).toContain("Événement b");
    expect(deals).not.toContain("Événement c");
    // A presale with nothing left is not a deal.
    expect(deals).not.toContain("Événement d");
    expect(html).toContain("<span>Prévente −20 %</span>");
    expect(html).toMatch(/<span>Coupon −5\s\$<\/span>/);
    expect(render(four, "en")).toContain("<span>Coupon −$5</span>");
  });

  it("rounds a saving down, never up, and shows no rail without a deal", () => {
    expect(render([event("a", { presale: { priceCents: 1999, regularCents: 3000, endsAt: null, remaining: null } }), event("b"), event("c"), event("e")]))
      .toContain("<span>Prévente −33 %</span>");
    expect(render([event("a"), event("b"), event("c"), event("e")])).not.toContain('id="deals"');
  });

  it("says when an event sells a festival pass, never as a deal (Run 100)", () => {
    const days = ["2026-11-20T23:00:00Z", "2026-11-21T23:00:00Z", "2026-11-22T23:00:00Z"];
    const html = render([
      event("p", { pass: { priceCents: 7500 }, sessions: days }),
      event("q", { pass: { priceCents: 7500 }, sessions: days, presale: { priceCents: 1600, regularCents: 2000, endsAt: null, remaining: null } }),
      event("r", { pass: { priceCents: 7500 }, sessions: [days[0]!] }),
      event("s"),
    ]);
    expect(html).toContain('<p class="deal-ribbon is-pass">');
    expect(html.match(/Passe festival · 3 dates/g)).toHaveLength(1);
    // A presale still comes first; a single date has no pass to speak of.
    expect(html).toContain("<span>Prévente −20 %</span>");
    expect(html).not.toContain("Passe festival · 1 dates");
    // The deals rail keeps deals only.
    expect(rail(html)).not.toContain("Événement p");
    expect(render([event("p", { pass: { priceCents: 7500 }, sessions: days })], "en")).toContain("<span>Festival pass · 3 dates</span>");
  });

  it("files food, fashion and markets under their own categories, never on a stray word", () => {
    const html = render([
      event("f", { title: "Festival de la poutine", category: null }),
      event("g", { title: "Vente trottoir de l'automne", category: null }),
      event("h", { title: "Marché de Noël", category: null }),
      event("i", { title: "Le Havana en mode Halloween", category: null, description: "Une marche dans le village hanté." }),
    ]);
    const categories = (id: string) => (new RegExp(`"id":"${id}"[^}]*?"categories":\\[([^\\]]*)\\]`).exec(html.replace(/&quot;/g, '"'))?.[1] ?? "");
    expect(categories("f")).toContain("gastronomie");
    expect(categories("g")).toContain("mode");
    expect(categories("h")).toContain("marches");
    expect(categories("i")).not.toMatch(/mode|marches/);
  });
});
