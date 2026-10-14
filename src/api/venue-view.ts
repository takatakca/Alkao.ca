import { COPY, type Lang } from "./home-copy.js";
import {
  esc, safeHttps, headAssets, siteHeader, siteFooter, icon,
  type Frame, type HomeBrand, type HomeEvent,
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
          brand: brand.name, events: [],
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

export const venuePath = (v: Pick<PublicVenue, "clientId" | "brandId" | "venueId">) =>
  `/salles/${v.clientId}/${v.brandId}/${v.venueId}`;

const WORDS = {
  fr: {
    indexTitle: "Salles et lieux de spectacles",
    indexDesc: "Explorez les salles et lieux d’événements actuellement en vente sur ALKAO.",
    indexLead: "Découvrez les lieux qui accueillent des événements en vente. Les dates et les disponibilités viennent des organisateurs.",
    noVenues: "Aucune salle avec des événements en vente pour le moment.",
    next: "Prochains événements", back: "Toutes les salles", buy: "Voir les billets",
    directions: "Itinéraire", organizer: "Organisateur", events: "événement(s) en vente",
    from: "À partir de", free: "Gratuit", taxes: "+ taxes",
  },
  en: {
    indexTitle: "Venues and event spaces",
    indexDesc: "Explore venues with events currently on sale on ALKAO.",
    indexLead: "Discover places hosting events on sale. Dates and availability come directly from the organizers.",
    noVenues: "No venues have events on sale right now.",
    next: "Upcoming events", back: "All venues", buy: "View tickets",
    directions: "Directions", organizer: "Organizer", events: "event(s) on sale",
    from: "From", free: "Free", taxes: "+ taxes",
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
const dateLabel = (event: HomeEvent, lang: Lang) => {
  const date = new Date(event.startsAt);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(lang === "fr" ? "fr-CA" : "en-CA", {
      timeZone: event.timezone || "America/Toronto", weekday: "long", day: "numeric", month: "long",
      hour: "numeric", minute: "2-digit",
    }).format(date);
  } catch {
    return "";
  }
};
const moneyLabel = (event: HomeEvent, lang: Lang) => {
  const t = WORDS[lang];
  if (event.fromCents === undefined) return "";
  if (event.fromCents === null) return t.free;
  return `${t.from} ${new Intl.NumberFormat(lang === "fr" ? "fr-CA" : "en-CA", {
    style: "currency", currency: "CAD",
  }).format(event.fromCents / 100)} ${t.taxes}`;
};

function shell(cfg: ViewConfig, path: string, title: string, description: string, main: string, structured: unknown): string {
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
  <main id="contenu" class="page-main">
    <div class="wrap">
${main}
    </div>
  </main>
${siteFooter(frame)}
</body>
</html>`;
}

export function renderVenueDirectory(cfg: ViewConfig & { venues: PublicVenue[] }): string {
  const t = WORDS[cfg.lang];
  const content = `<p class="kicker">ALKAO</p>
      <h1>${esc(t.indexTitle)}</h1>
      <p class="lead">${esc(t.indexLead)}</p>
      ${cfg.venues.length ? `<section aria-label="${esc(t.indexTitle)}" class="grid" style="margin-top:36px">
        ${cfg.venues.map((v) => `<article class="card">
          <div class="card-body">
            <p class="card-brand">${esc(v.brand)}</p>
            <h2 class="card-title"><a href="${esc(pathLang(venuePath(v), cfg.lang))}">${esc(v.name)}</a></h2>
            ${v.city ? `<p class="card-meta">${icon("pin")}${esc(v.city)}</p>` : ""}
            <p>${v.events.length} ${esc(t.events)}</p>
            <div class="card-actions"><a class="btn btn-primary btn-sm" href="${esc(pathLang(venuePath(v), cfg.lang))}">${esc(t.next)}</a></div>
          </div>
        </article>`).join("")}
      </section>` : `<p class="empty-inline">${esc(t.noVenues)}</p>`}
      <p style="margin-top:32px"><a class="btn btn-ghost" href="${esc(cfg.lang === "en" ? "/?lang=en#evenements" : "/#evenements")}">${esc(COPY[cfg.lang].nav.events)}</a></p>`;
  return shell(cfg, "/salles", t.indexTitle, t.indexDesc, content, {
    "@context": "https://schema.org", "@type": "CollectionPage", name: t.indexTitle,
    url: absoluteUrl(cfg.origin, "/salles"),
    mainEntity: {
      "@type": "ItemList",
      itemListElement: cfg.venues.map((v, i) => ({
        "@type": "ListItem", position: i + 1, name: v.name,
        url: absoluteUrl(cfg.origin, venuePath(v)),
      })),
    },
  });
}

export function renderVenuePage(cfg: ViewConfig & { venue: PublicVenue }): string {
  const v = cfg.venue;
  const t = WORDS[cfg.lang];
  const title = `${v.name}${v.city ? ` — ${v.city}` : ""}`;
  const location = [v.address, v.city].filter(Boolean).join(", ");
  const directions = [v.name, v.address, v.city].filter(Boolean).join(", ");
  const map = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(directions)}`;
  const content = `<nav aria-label="Breadcrumb"><a class="link-btn" href="${esc(pathLang("/salles", cfg.lang))}">← ${esc(t.back)}</a></nav>
    <p class="kicker">${esc(v.brand)}</p>
    <h1>${esc(v.name)}</h1>
    ${location ? `<p class="lead">${icon("pin")}${esc(location)}</p>` : ""}
    <div class="actions"><a class="btn btn-ghost" href="${esc(map)}" target="_blank" rel="noopener noreferrer">${icon("pin")}${esc(t.directions)}</a></div>
    <section class="section events" aria-labelledby="venue-events">
      <div class="section-head"><h2 id="venue-events">${esc(t.next)}</h2><p>${v.events.length} ${esc(t.events)} · ${esc(t.organizer)} : ${esc(v.brand)}</p></div>
      <div class="grid">
        ${v.events.map((event) => {
          const image = safeHttps(event.imageUrl);
          return `<article class="card">
            ${image ? `<a class="card-media" href="${esc(event.shopPath)}"><img src="${esc(image)}" alt="" loading="lazy" decoding="async" /></a>` : ""}
            <div class="card-body">
              <h3 class="card-title"><a href="${esc(event.shopPath)}">${esc(event.title)}</a></h3>
              ${dateLabel(event, cfg.lang) ? `<p class="card-meta">${icon("clock")}${esc(dateLabel(event, cfg.lang))}</p>` : ""}
              ${event.description ? `<p>${esc(event.description.slice(0, 220))}</p>` : ""}
              <div class="card-foot"><p class="price">${esc(moneyLabel(event, cfg.lang))}</p></div>
              <div class="card-actions"><a class="btn btn-primary btn-sm" href="${esc(event.shopPath)}">${esc(t.buy)}</a></div>
            </div>
          </article>`;
        }).join("")}
      </div>
    </section>`;
  return shell(cfg, venuePath(v), title, `${t.next} : ${title}. ${v.brand}.`, content, {
    "@context": "https://schema.org", "@type": "Place", name: v.name,
    url: absoluteUrl(cfg.origin, venuePath(v)),
    address: { "@type": "PostalAddress", ...(v.address ? { streetAddress: v.address } : {}),
      ...(v.city ? { addressLocality: v.city } : {}), addressCountry: "CA" },
    event: v.events.map((e) => ({ "@type": "Event", name: e.title,
      startDate: new Date(e.startsAt).toISOString(), url: absoluteUrl(cfg.origin, e.shopPath) })),
  });
}
