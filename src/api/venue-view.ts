import { COPY, fold, type Lang } from "./home-copy.js";
import {
  esc, headAssets, siteHeader, siteFooter, icon, cardsOf, eventCard, eventData, clientWords, previewDialog,
  type Card, type Frame, type HomeBrand, type HomeEvent,
} from "./home-view.js";

/** Run 73: no independent publication path. A venue exists here only when an opted-in,
 * operational Brand has an event already listed on ALKAO with seats currently on sale. */
export interface PublicVenue {
  clientId: string;
  brandId: string;
  venueId: string;
  name: string;
  city: string;
  address: string;
  brand: string;
  /** Run 90: the Brand's logo, on the venue's cards. */
  logoUrl?: string | null;
  events: HomeEvent[];
}

export function publicVenues(brands: HomeBrand[]): PublicVenue[] {
  const venues = new Map<string, PublicVenue>();
  for (const brand of brands) {
    for (const event of brand.events) {
      if (!event.venueId || !event.venueName?.trim()) continue;
      const clientId = brand.clientId.toLowerCase();
      const brandId = brand.brandId.toLowerCase();
      const venueId = event.venueId.toLowerCase();
      const key = `${clientId}:${brandId}:${venueId}`;
      let venue = venues.get(key);
      if (!venue) {
        venue = {
          clientId, brandId, venueId,
          name: event.venueName.trim(), city: event.venueCity?.trim() ?? "",
          address: event.venueAddress?.trim() ?? "",
          brand: brand.name, logoUrl: brand.logoUrl, events: [],
        };
        venues.set(key, venue);
      }
      venue.events.push(event);
    }
  }
  return [...venues.values()]
    .map((v) => ({ ...v, events: v.events.sort((a, b) =>
      new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime() || a.title.localeCompare(b.title)) }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.city.localeCompare(b.city) || a.venueId.localeCompare(b.venueId));
}

/** Query parsing is bounded, and results are selected only from the gated public catalog. */
export interface VenueSearch { q: string; city: string }
export function parseVenueSearch(get: (name: string) => string | undefined): VenueSearch {
  const clean = (name: string) => (get(name) ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  return { q: clean("q"), city: clean("ville") };
}
export function filterVenues(venues: PublicVenue[], search: VenueSearch): PublicVenue[] {
  const words = fold(search.q).split(/\s+/).filter(Boolean);
  const city = fold(search.city);
  return venues.filter((v) =>
    (!city || fold(v.city) === city) &&
    words.every((word) => fold(`${v.name} ${v.city} ${v.brand}`).includes(word)));
}

export const venuePath = (v: Pick<PublicVenue, "clientId" | "brandId" | "venueId">) =>
  `/salles/${v.clientId}/${v.brandId}/${v.venueId}`;

const WORDS = {
  fr: {
    indexTitle: "Salles et lieux de spectacles",
    indexDesc: "Explorez les salles et lieux d’événements actuellement en vente sur ALKAO.",
    indexLead: "Découvrez les lieux qui accueillent des événements en vente. Les dates et les disponibilités viennent des organisateurs.",
    noVenues: "Aucune salle avec des événements en vente pour le moment.",
    search: "Rechercher une salle", searchHint: "Salle ou organisateur", city: "Ville", allCities: "Toutes les villes",
    searchAction: "Rechercher", reset: "Effacer les filtres", found: (n: number) => `${n} salle${n > 1 ? "s" : ""} trouvée${n > 1 ? "s" : ""}`,
    noMatch: "Aucune salle ne correspond à votre recherche.",
    next: "Prochains événements", back: "Toutes les salles", buy: "Voir les billets",
    directions: "Itinéraire", calendar: "Ajouter les événements au calendrier", organizer: "Organisateur",
    events: (n: number) => (n === 1 ? "1 événement en vente" : `${n} événements en vente`),
    onSale: (n: number) => (n === 1 ? "événement en vente" : "événements en vente"),
    nextDate: "Prochaine date", nextOn: (d: string) => `Prochaine date : ${d}`, see: "Voir la salle", dates: "Voir les dates",
    crumbs: "Fil d’Ariane", venues: "Salles", lowest: "Billets à partir de", taxesNote: "avant taxes", entry: "Entrée",
  },
  en: {
    indexTitle: "Venues and event spaces",
    indexDesc: "Explore venues with events currently on sale on ALKAO.",
    indexLead: "Discover places hosting events on sale. Dates and availability come directly from the organizers.",
    noVenues: "No venues have events on sale right now.",
    search: "Search venues", searchHint: "Venue or organizer", city: "City", allCities: "All cities",
    searchAction: "Search", reset: "Clear filters", found: (n: number) => `${n} venue${n === 1 ? "" : "s"} found`,
    noMatch: "No venues match your search.",
    next: "Upcoming events", back: "All venues", buy: "View tickets",
    directions: "Directions", calendar: "Add events to calendar", organizer: "Organizer",
    events: (n: number) => (n === 1 ? "1 event on sale" : `${n} events on sale`),
    onSale: (n: number) => (n === 1 ? "event on sale" : "events on sale"),
    nextDate: "Next date", nextOn: (d: string) => `Next date: ${d}`, see: "View venue", dates: "See the dates",
    crumbs: "Breadcrumb", venues: "Venues", lowest: "Tickets from", taxesNote: "before taxes", entry: "Admission",
  },
} as const;

interface ViewConfig {
  origin: string | null;
  lang: Lang;
  now: Date;
  asset: (name: string) => string;
}

const pathLang = (path: string, lang: Lang) => `${path}${lang === "en" ? "?lang=en" : ""}`;
const absoluteUrl = (origin: string | null, path: string) => (origin ? `${origin}${path}` : path);
const jsonSafe = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");
/** Run 90: the venue's events as the home shows them (same card, photo or category stand-in). */
const venueCards = (cfg: ViewConfig, v: PublicVenue): Card[] =>
  cardsOf([{ clientId: v.clientId, brandId: v.brandId, name: v.brand, logoUrl: v.logoUrl ?? null, events: v.events }], cfg.lang, cfg.origin, cfg.asset);
/** The lowest known price among the cards, as the cards say it ("À partir de 18 $ + taxes"). */
const lowest = (cards: Card[]) =>
  cards.filter((c) => c.price).sort((a, b) => (a.fromCents ?? 0) - (b.fromCents ?? 0))[0] ?? null;
const money = (lang: Lang, cents: number) => new Intl.NumberFormat(COPY[lang].lang, {
  style: "currency", currency: "CAD", minimumFractionDigits: cents % 100 === 0 ? 0 : 2, maximumFractionDigits: 2,
}).format(cents / 100);
const cover = (cards: Card[]) => cards.find((c) => c.photo) ?? cards[0] ?? null;

interface Extra {
  /** Run 90: a full-width photo above the page's column. */
  hero?: string;
  /** Dialogs and data for home-ui/home.js, before the script. */
  tail?: string;
}

function shell(cfg: ViewConfig, path: string, title: string, description: string, main: string, structured: unknown, extra: Extra = {}): string {
  const { origin, lang, now, asset } = cfg;
  const t = COPY[lang];
  const home = lang === "en" ? "/?lang=en" : "/";
  const here = pathLang(path, lang);
  const otherHere = pathLang(path, t.other);
  const frame: Frame = { t, lang, base: home, home, here, otherHere, year: now.getUTCFullYear() };
  return `<!doctype html>
<html lang="${t.lang}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>${esc(title)} | ALKAO</title>
  <meta name="description" content="${esc(description)}" />
  ${origin ? `<link rel="canonical" href="${esc(absoluteUrl(origin, here))}" />
  <link rel="alternate" hreflang="fr-CA" href="${esc(absoluteUrl(origin, path))}" />
  <link rel="alternate" hreflang="en-CA" href="${esc(absoluteUrl(origin, pathLang(path, "en")))}" />` : ""}
  <meta name="theme-color" content="#060D1F" />
${headAssets(asset)}
  <script type="application/ld+json">${jsonSafe(structured)}</script>
</head>
<body class="page">
  <a class="skip" href="#contenu">${esc(t.skip)}</a>
  <div class="aurora" aria-hidden="true"><span></span><span></span><span></span></div>
${siteHeader(frame)}
  <main id="contenu" class="page-main${extra.hero ? " has-hero" : ""}">
${extra.hero ?? ""}
    <div class="wrap">
${main}
    </div>
  </main>
${siteFooter(frame)}
${extra.tail ?? ""}
  <script src="${esc(asset("home.js"))}" defer></script>
</body>
</html>`;
}

export function renderVenueDirectory(cfg: ViewConfig & { venues: PublicVenue[]; search: VenueSearch }): string {
  const t = WORDS[cfg.lang];
  const venues = filterVenues(cfg.venues, cfg.search);
  const cities = [...new Set(cfg.venues.map((v) => v.city).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, COPY[cfg.lang].lang));
  const searching = Boolean(cfg.search.q || cfg.search.city);
  const venueCard = (v: PublicVenue, i: number) => {
    const cards = venueCards(cfg, v);
    const photo = cover(cards);
    const price = lowest(cards);
    const href = esc(pathLang(venuePath(v), cfg.lang));
    const logo = cards[0]?.logo;
    return `<article class="card venue-card reveal">
          ${photo ? `<a class="card-media" href="${href}" tabindex="-1" aria-hidden="true"><img src="${esc(photo.image)}" alt="" ${i < 3 ? "" : 'loading="lazy" '}decoding="async" /></a>
          <p class="media-chip" aria-hidden="true">${icon("ticket")}${esc(t.events(cards.length))}</p>` : ""}
          <div class="card-body">
            <p class="card-brand">${logo ? `<img src="${esc(logo)}" alt="" loading="lazy" decoding="async" />` : ""}${esc(v.brand)}</p>
            <h2 class="card-title"><a href="${href}">${esc(v.name)}</a></h2>
            ${v.city ? `<p class="card-meta">${icon("pin")}<span>${esc(v.city)}</span></p>` : ""}
            ${cards[0] ? `<p class="card-meta">${icon("clock")}<time datetime="${esc(cards[0].next.toISOString())}">${esc(t.nextOn(cards[0].nextLabel))}</time></p>` : ""}
            <p class="sr-only">${esc(t.events(cards.length))}</p>
            <div class="card-foot">${price ? `<p class="price">${esc(price.price)}</p>` : "<span></span>"}</div>
            <div class="card-actions"><a class="btn btn-primary btn-sm" href="${href}">${esc(t.see)}${icon("arrow")}</a></div>
          </div>
        </article>`;
  };
  const content = `<header class="page-intro">
        <p class="kicker">ALKAO</p>
        <h1>${esc(t.indexTitle)}</h1>
        <p class="lead">${esc(t.indexLead)}</p>
      </header>
      <form class="venues-search" action="/salles" method="get" role="search" aria-label="${esc(t.search)}">
        ${cfg.lang === "en" ? '<input type="hidden" name="lang" value="en" />' : ""}
        <label class="field" for="venue-query"><span>${esc(t.search)}</span><input id="venue-query" name="q" type="search" value="${esc(cfg.search.q)}" placeholder="${esc(t.searchHint)}" maxlength="80" /></label>
        <label class="field" for="venue-city"><span>${esc(t.city)}</span><select id="venue-city" name="ville">
          <option value="">${esc(t.allCities)}</option>
          ${cities.map((city) => `<option value="${esc(city)}"${fold(city) === fold(cfg.search.city) ? " selected" : ""}>${esc(city)}</option>`).join("")}
        </select></label>
        <button class="btn btn-primary btn-search" type="submit">${icon("search")}<span>${esc(t.searchAction)}</span></button>
      </form>
      ${searching ? `<div class="results" role="status"><p><strong>${esc(t.found(venues.length))}</strong></p><div class="actions"><a class="btn btn-ghost btn-sm" href="${esc(pathLang("/salles", cfg.lang))}">${esc(t.reset)}</a></div></div>` : ""}
      ${venues.length ? `<section aria-label="${esc(t.indexTitle)}" class="grid venues-grid">
        ${venues.map(venueCard).join("")}
      </section>` : `<p class="empty-inline">${esc(searching ? t.noMatch : t.noVenues)}</p>`}
      <p class="venues-back"><a class="btn btn-ghost" href="${esc(cfg.lang === "en" ? "/?lang=en#evenements" : "/#evenements")}">${icon("ticket")}${esc(COPY[cfg.lang].nav.events)}</a></p>`;
  return shell(cfg, "/salles", t.indexTitle, t.indexDesc, content, {
    "@context": "https://schema.org", "@type": "CollectionPage", name: t.indexTitle,
    url: absoluteUrl(cfg.origin, "/salles"),
    mainEntity: {
      "@type": "ItemList",
      itemListElement: venues.map((v, i) => ({
        "@type": "ListItem", position: i + 1, name: v.name,
        url: absoluteUrl(cfg.origin, venuePath(v)),
      })),
    },
  });
}

export function renderVenuePage(cfg: ViewConfig & { venue: PublicVenue }): string {
  const v = cfg.venue;
  const t = WORDS[cfg.lang];
  const words = COPY[cfg.lang];
  const title = `${v.name}${v.city ? ` — ${v.city}` : ""}`;
  const location = [v.address, v.city].filter(Boolean).join(", ");
  const directions = [v.name, v.address, v.city].filter(Boolean).join(", ");
  const map = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(directions)}`;
  const cards = venueCards(cfg, v);
  const photo = cover(cards);
  const price = lowest(cards);
  const photos = cards.filter((c) => c.photo);
  const next = cards[0];
  const zoomOf = (c: Card, group: string) =>
    `data-zoom="${esc(c.image)}" data-zoom-alt="${esc(c.title)}" data-zoom-group="${group}" aria-label="${esc(`${words.zoom.open} : ${c.title}`)}"`;
  const hero = `    <section class="venue-hero" aria-labelledby="venue-title">
      ${photo ? `<div class="venue-hero-media"><img src="${esc(photo.image)}" alt="" fetchpriority="high" decoding="async" /></div>` : ""}
      <div class="venue-hero-shade" aria-hidden="true"></div>
      ${photo?.photo ? `<button class="round hero-zoom" type="button" ${zoomOf(photo, "hero")} hidden>${icon("expand")}</button>` : ""}
      <div class="wrap venue-hero-inner">
        <nav class="crumbs" aria-label="${esc(t.crumbs)}"><a href="${esc(cfg.lang === "en" ? "/?lang=en" : "/")}">ALKAO</a>${icon("right")}<a href="${esc(pathLang("/salles", cfg.lang))}">${esc(t.venues)}</a>${icon("right")}<span aria-current="page">${esc(v.name)}</span></nav>
        <p class="kicker">${esc(v.brand)}</p>
        <h1 id="venue-title">${esc(v.name)}</h1>
        ${location ? `<p class="lead venue-where">${icon("pin")}<span>${esc(location)}</span></p>` : ""}
        <ul class="venue-stats">
          <li><strong>${cards.length}</strong><span>${esc(t.onSale(cards.length))}</span></li>
          ${next ? `<li><strong>${esc(next.day)} ${esc(next.month)}</strong><span>${esc(t.nextDate)}</span></li>` : ""}
          ${price ? `<li><strong>${esc(price.fromCents ? money(cfg.lang, price.fromCents) : words.free)}</strong><span>${esc(price.fromCents ? `${t.lowest} · ${t.taxesNote}` : t.entry)}</span></li>` : ""}
        </ul>
        <div class="actions">
          <a class="btn btn-primary" href="#venue-events">${icon("ticket")}${esc(t.dates)}</a>
          <a class="btn btn-ghost" href="${esc(map)}" target="_blank" rel="noopener noreferrer">${icon("pin")}${esc(t.directions)}</a>
          <a class="btn btn-ghost" href="${esc(pathLang(`${venuePath(v)}/agenda.ics`, cfg.lang))}">${icon("calendar")}${esc(t.calendar)}</a>
        </div>
      </div>
    </section>`;
  const gallery = photos.length > 1 ? `<section class="section gallery rail-block" aria-labelledby="venue-gallery">
        <div class="rail-head"><div><h2 id="venue-gallery">${esc(words.gallery)}</h2><p>${esc(words.galleryLead)}</p></div>
          <div class="rail-nav" hidden><button class="round" type="button" data-rail-prev="venue-gallery-rail" aria-label="${esc(words.scrollPrev)}">${icon("left")}</button><button class="round" type="button" data-rail-next="venue-gallery-rail" aria-label="${esc(words.scrollNext)}">${icon("right")}</button></div>
        </div>
        <ul class="rail shots" id="venue-gallery-rail">${photos.map((c) => `<li class="rail-item"><figure class="shot">
          <a class="shot-media" href="${esc(c.image)}" ${zoomOf(c, "gallery")}><img src="${esc(c.image)}" alt="" loading="lazy" decoding="async" />${icon("zoom", "i shot-icon")}</a>
          <figcaption><a href="${esc(c.shop)}">${esc(c.title)}</a><span>${esc(c.nextLabel)}</span></figcaption>
        </figure></li>`).join("")}</ul>
      </section>` : "";
  const content = `${gallery}
    <section class="section events" id="venue-events" aria-labelledby="venue-events-title">
      <div class="section-head"><h2 id="venue-events-title">${esc(t.next)}</h2><p>${esc(t.events(cards.length))} · ${esc(t.organizer)} : ${esc(v.brand)}</p></div>
      <div class="grid">
        ${cards.map((c, i) => eventCard(words, c, { eager: i < 3, venueLink: false })).join("")}
      </div>
      <p class="venues-back"><a class="btn btn-ghost" href="${esc(pathLang("/salles", cfg.lang))}">${icon("left")}${esc(t.back)}</a></p>
    </section>`;
  const data = { lang: cfg.lang, events: cards.map(eventData), organizers: [], t: clientWords(words) };
  const tail = `${previewDialog(words)}
  <script type="application/json" id="alkao-data">${jsonSafe(data)}</script>`;
  return shell(cfg, venuePath(v), title, `${t.next} : ${title}. ${v.brand}.`, content, {
    "@context": "https://schema.org", "@type": "Place", name: v.name,
    url: absoluteUrl(cfg.origin, venuePath(v)),
    ...(photo?.photo ? { image: [photo.image] } : {}),
    address: { "@type": "PostalAddress", ...(v.address ? { streetAddress: v.address } : {}),
      ...(v.city ? { addressLocality: v.city } : {}), addressCountry: "CA" },
    event: v.events.map((e) => ({ "@type": "Event", name: e.title,
      startDate: new Date(e.startsAt).toISOString(), url: absoluteUrl(cfg.origin, e.shopPath) })),
  }, { hero, tail });
}
