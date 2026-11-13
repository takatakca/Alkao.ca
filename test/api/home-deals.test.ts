import { describe, expect, it } from "vitest";
import { parseQuery, renderHome, type HomeBrand, type HomeEvent } from "../../src/api/home-view.js";

/** Run 97: presales and coupons on alkao.ca, from made-up events only. */
const NOW = new Date("2026-11-02T15:00:00Z");
const event = (id: string, extra: Partial<HomeEvent> = {}): HomeEvent => ({
  id, title: `Événement ${id}`, description: null, imageUrl: null, venueId: "v1", venueName: "Parc", venueCity: "Montréal",
  startsAt: new Date("2026-11-20T23:00:00Z"), fromCents: 2000, shopPath: `/acheter/c/b/${id}`, ...extra,
});
const brands = (events: HomeEvent[]): HomeBrand[] => [{ clientId: "c", brandId: "b", name: "Festival des saveurs", logoUrl: null, events }];
const render = (events: HomeEvent[], lang: "fr" | "en" = "fr", params: Record<string, string> = {}) =>
  renderHome({ origin: "https://alkao.test", lang, brands: brands(events), query: parseQuery((name) => params[name]), now: NOW, asset: (n) => `/assets/home/${n}` });
/** Run 107: the "Préventes et rabais" section near the top of the page (it replaced Run 97's rail). */
const section = (html: string) => /<section class="section deals" id="preventes"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
/** The events section, where search results are listed. */
const listed = (html: string) => /<section class="section events" id="evenements"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";

describe("presales and coupons on alkao.ca", () => {
  const four = [
    event("a", { presale: { priceCents: 1600, regularCents: 2000, endsAt: "2026-11-10T04:59:00Z", remaining: 40 } }),
    event("b", { coupon: { label: "Coupon famille", percent: null, amountCents: 500, endsAt: null } }),
    event("c"),
    event("d", { presale: { priceCents: 1999, regularCents: 2000, endsAt: null, remaining: 0 } }),
  ];

  it("gathers the events with a presale or a coupon in their own section, each card saying which", () => {
    const html = render(four);
    expect(html).toContain(">Préventes et rabais<");
    const deals = section(html);
    expect(deals).toContain("Événement a");
    expect(deals).toContain("Événement b");
    expect(deals).not.toContain("Événement c");
    // A presale with nothing left is not a deal.
    expect(deals).not.toContain("Événement d");
    expect(html).toContain("<span>Prévente −20 %</span>");
    expect(html).toMatch(/<span>Coupon −5\s\$<\/span>/);
    expect(render(four, "en")).toContain("<span>Coupon −$5</span>");
  });

  it("rounds a saving down, never up, and shows no offer without a deal", () => {
    expect(render([event("a", { presale: { priceCents: 1999, regularCents: 3000, endsAt: null, remaining: null } }), event("b"), event("c"), event("e")]))
      .toContain("<span>Prévente −33 %</span>");
    const none = section(render([event("a"), event("b"), event("c"), event("e")]));
    expect(none).not.toContain('class="spotlight');
    expect(none).not.toContain("deal-ribbon");
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
    // The deals section keeps deals only.
    expect(section(html)).not.toContain("Événement p");
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

/** Run 107: presales and discounts up front, the organizers' tools and GROUPE TAKATAK. */
describe("presales and discounts up front (Run 107)", () => {
  const presale = event("a", { presale: { priceCents: 1600, regularCents: 2000, endsAt: "2026-11-10T04:59:00Z", remaining: 40 }, fromCents: 1600 });
  const amount = event("b", { coupon: { label: "Coupon famille", percent: null, amountCents: 500, endsAt: null } });
  const plain = event("c");
  const spot = (html: string) => /<article class="spotlight[\s\S]*?<\/article>/.exec(html)?.[0] ?? "";

  it("puts the largest saving per ticket in full: both prices, the saving, its real end and its limit", () => {
    // An amount comes off the whole order: it never outranks a percentage, whatever its size.
    const html = render([amount, presale, plain]);
    const s = spot(html);
    expect(s).toContain("Événement a");
    expect(s).toContain("Offre à la une");
    expect(s).toMatch(/<span class="sr-only">Prix prévente <\/span>16\s\$<small>\+ taxes<\/small>/);
    expect(s).toMatch(/Prix régulier <s>20\s\$<\/s>/);
    expect(s).toMatch(/4\s\$ de moins par billet/);
    expect(s).toContain("Jusqu’au 9 novembre à 23 h 59");
    expect(s).toContain("Quantité limitée à ce prix");
    expect(s).toContain('href="/acheter/c/b/a"');
    // The other deals follow as cards, and one link lists them all; a plain event is not a deal.
    const others = /<div class="grid" id="deals-list">[\s\S]*?<\/section>/.exec(section(html))?.[0] ?? "";
    expect(others).toContain("Événement b");
    expect(others).not.toContain("Événement a");
    expect(others).not.toContain("Événement c");
    expect(s).toContain('href="/?offres=1#evenements"');
    expect(s).toContain("Voir les 2 offres en cours");
    // No end date and no quantity limit: neither is said.
    const open = spot(render([event("a", { presale: { priceCents: 1600, regularCents: 2000, endsAt: null, remaining: null } })]));
    expect(open).not.toContain("Jusqu’au");
    expect(open).not.toContain("Quantité limitée");
    expect(open).not.toContain("offres en cours");
  });

  it("shows a bigger percentage coupon first, as a coupon, never as a price", () => {
    const s = spot(render([presale, event("e", { coupon: { label: "Lancement", percent: 25, amountCents: null, endsAt: null } })]));
    expect(s).toContain("Événement e");
    expect(s).toContain('<p class="spot-now">Coupon −25 %</p>');
    expect(s).toContain("Lancement");
    expect(s).toContain("Le coupon s’applique en un clic dans la boutique.");
    expect(s).not.toContain("Prix régulier");
    const en = spot(render([presale, plain], "en"));
    expect(en).toContain("Featured offer");
    expect(en).toContain("Until November 9 at 11:59 p.m.");
    expect(en).toMatch(/\$4 less per ticket/);
  });

  it("strikes the regular price on a card only when its lowest price is the presale's", () => {
    expect(render([presale])).toMatch(/<p class="price has-was">À partir de 16\s\$ \+ taxes <s class="was"><span class="sr-only">Prix régulier <\/span>20\s\$<\/s><\/p>/);
    // A cheaper child ticket is the "From" price: striking the adult's regular price would mislead.
    const child = render([event("a", { presale: { priceCents: 1600, regularCents: 2000, endsAt: null, remaining: null }, fromCents: 1000 })]);
    expect(child).not.toContain('class="was"');
    expect(child).toMatch(/<p class="price">À partir de 10\s\$ \+ taxes<\/p>/);
  });

  it("lists only the events with an offer on, as a filter that comes off in one tap", () => {
    const html = render([presale, amount, plain], "fr", { offres: "1" });
    const list = listed(html);
    expect(list).toContain("Événement a");
    expect(list).toContain("Événement b");
    expect(list).not.toContain("Événement c");
    expect(list).toContain("<strong>2 événements</strong>");
    expect(list).toMatch(/<a class="chip deal-chip is-current" href="\/\?#evenements" aria-current="true">[\s\S]*?Préventes et rabais<span class="count">2<\/span><\/a>/);
    expect(list).toContain('aria-label="Retirer le filtre : Préventes et rabais"');
    // The search form keeps it.
    expect(html).toContain('<input type="hidden" name="offres" value="1" />');
    // Unknown values are dropped; with nothing on, the filter says so.
    expect(listed(render([presale, plain], "fr", { offres: "oui" }))).toContain("Événement c");
    expect(listed(render([plain], "fr", { offres: "1" }))).toContain("Aucune prévente ni aucun coupon ne correspond à cette recherche pour le moment.");
    // Past events have no offer: the filter is not offered there.
    expect(listed(render([presale], "fr", { periode: "passes", offres: "1" }))).not.toContain("deal-chip");
  });

  it("leads the carousel with an event on offer, its slide saying so", () => {
    const html = render([
      event("c", { imageUrl: "https://photos.alkao.test/c.webp" }),
      event("a", { imageUrl: "https://photos.alkao.test/a.webp", startsAt: new Date("2026-11-25T23:00:00Z"), presale: { priceCents: 1600, regularCents: 2000, endsAt: null, remaining: null } }),
    ]);
    const tags = [...html.matchAll(/<p class="caption-tag">([^<]*)<\/p>/g)].map((m) => m[1]);
    expect(tags[0]).toBe("Prévente −20 % · Festival des saveurs");
    expect(tags[1]).toBe("En vedette · Festival des saveurs");
  });

  it("explains how offers work when none is on, without inventing one", () => {
    const s = section(render([plain]));
    expect(s).toContain("Achetez tôt, payez moins");
    expect(s.match(/<li class="feature reveal">/g)).toHaveLength(3);
    expect(s).toContain("Les offres en cours s’affichent ici dès qu’un organisateur en lance une");
    expect(s).not.toMatch(/\d\s?\$|−\d/);
    // Even with nothing on sale at all.
    expect(section(render([]))).toContain('class="deal-how"');
  });

  it("shows organizers their discount tools and GROUPE TAKATAK's services and offers, linked to takatak.ca", () => {
    const html = render([plain]);
    expect(html).toMatch(/id="outils-rabais"[\s\S]*Vendez plus tôt avec les outils de rabais/);
    for (const tool of ["Prix de prévente", "Paliers de prix", "Coupons publics", "Codes pour les entreprises", "Offre de retour", "Passe festival"]) {
      expect(html).toContain(`<h3>${tool}</h3>`);
    }
    const tk = /<section class="section tk" id="takatak"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
    for (const slug of ["marketing", "social-media", "websites", "menu-flyer-design", "local-listings"]) {
      expect(tk).toContain(`href="https://takatak.ca/services/${slug}"`);
    }
    expect(tk).toContain('aria-label="Marketing sur takatak.ca"');
    expect(tk).toContain("Code <b>FIRST10</b>");
    expect(tk).toContain("en payant un service mensuel 12 mois d’avance");
    expect(tk).toContain('href="https://takatak.ca/deals"');
    expect(tk).toContain('href="https://takatak.ca/contact"');
    // The header leads to the offers; the footer to GROUPE TAKATAK.
    expect(html).toMatch(/<nav class="main-nav"[^>]*><a href="#evenements">Événements<\/a><a href="#preventes">Préventes<\/a>/);
    expect(html).toMatch(/<p class="foot-title">GROUPE TAKATAK<\/p><a href="https:\/\/takatak.ca">takatak.ca<\/a>/);
    const en = render([plain], "en");
    expect(en).toContain("Get the word out about your event");
    expect(en).toContain("off your first TAKATAK service");
    expect(en).toContain('<a href="#preventes">Presales</a>');
  });

  it("answers presale and coupon questions in the help", () => {
    const html = render([plain]);
    expect(html).toContain('id="faq-preventes"');
    expect(html).toContain("Comment profiter d’une prévente ou d’un coupon?");
    expect(render([plain], "en")).toContain("How do I get a presale price or a coupon?");
  });
});
