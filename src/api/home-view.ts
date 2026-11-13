import { CATEGORIES, COPY, fold, help, type Lang } from "./home-copy.js";

/**
 * Run 64: the ALKAO platform home, rendered on the server. It works without JavaScript
 * (search is a plain form, the carousel shows its first slide, questions are <details>);
 * home-ui/home.js only adds motion, dialogs, favourites and the assistant on top.
 *
 * Every event, date and price comes from the gated catalog (src/api/app.ts): nothing here is
 * invented, and nothing pushes a buyer with a countdown or a "few seats left".
 */
export interface HomeEvent {
  id: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  /** Stable id within this Brand, never published without an on-sale event. */
  venueId: string;
  venueName: string | null;
  venueCity: string | null;
  /** Run 66: the venue's street address, for directions. */
  venueAddress?: string | null;
  /** Run 69: what the organizer says (each null when not said). */
  category?: string | null;
  minAge?: number | null;
  doorsOpenMinutes?: number | null;
  language?: "fr" | "en" | "fr-en" | "none" | string | null;
  accessibility?: string | null;
  /** The venue's IANA time zone (dates are shown in it). */
  timezone?: string | null;
  /** The first session with seats left. */
  startsAt: Date | string;
  /** Run 64: every upcoming session with seats left, soonest first. */
  sessions?: (Date | string)[];
  /** Run 66: when each of those sessions ends, null when the organizer did not say. */
  ends?: (Date | string | null)[];
  /** Run 64: the lowest price of an active paid admission, before taxes; null when none is paid. */
  fromCents?: number | null;
  /** Run 97: the cheapest presale on now, against the regular price it undercuts. */
  presale?: { priceCents: number; regularCents: number; endsAt: Date | string | null; remaining: number | null } | null;
  /** Run 97: the event's best public coupon on now. */
  coupon?: { label: string | null; percent: number | null; amountCents: number | null; endsAt: Date | string | null } | null;
  /** Run 100: the cheapest festival pass on sale (one ticket for every date). */
  pass?: { priceCents: number } | null;
  /** Run 106: every date has taken place (`sessions` then lists them, the latest first). */
  ended?: boolean;
  /** Run 109: a merchant voucher: valid until its first session's end, not a show at a time. */
  voucher?: boolean;
  /** Run 109: the voucher on sale now with the biggest saving on its face value. */
  value?: { priceCents: number; valueCents: number } | null;
  /** Run 106: how many dates a past event had (`sessions` keeps the last six). */
  dateCount?: number;
  shopPath: string;
}

export interface HomeBrand {
  clientId: string;
  brandId: string;
  name: string;
  logoUrl: string | null;
  events: HomeEvent[];
  /** Run 106: its events of the past year, for the "Passés" filter (never sold, never in search data). */
  past?: HomeEvent[];
}

export type When = "" | "today" | "weekend" | "week" | "month";
export type PriceBand = "" | "free" | "under25" | "25to50" | "over50";
export interface HomeQuery {
  q: string;
  city: string;
  when: When;
  category: string;
  /** Run 66: by the lowest price before taxes (fromCents). */
  price: PriceBand;
  /** Run 66: soonest first (default), or lowest price first. */
  sort: "" | "price";
  /** Run 66: one organizer's events (its Brand id). */
  organizer: string;
  /** Run 67: cards (default), or every date day by day. */
  view: "" | "agenda";
  /** Run 106: what is on sale (default), or what took place this past year. */
  period: "" | "past";
  /** Run 107: only the events with a presale or a public coupon on now. */
  deals: boolean;
}

const WHENS: When[] = ["today", "weekend", "week", "month"];
const PRICES: PriceBand[] = ["free", "under25", "25to50", "over50"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The search form's values, trimmed and bounded; anything unknown is dropped. */
export function parseQuery(get: (name: string) => string | undefined): HomeQuery {
  const text = (name: string) => (get(name) ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  const when = text("quand") as When;
  const category = text("categorie");
  return {
    q: text("q"),
    city: text("ville"),
    when: WHENS.includes(when) ? when : "",
    category: CATEGORIES.some((c) => c.id === category) ? category : "",
    price: PRICES.includes(text("prix") as PriceBand) ? (text("prix") as PriceBand) : "",
    sort: text("tri") === "prix" ? "price" : "",
    organizer: UUID.test(text("organisateur")) ? text("organisateur").toLowerCase() : "",
    view: text("vue") === "agenda" ? "agenda" : "",
    period: text("periode") === "passes" ? "past" : "",
    deals: text("offres") === "1",
  };
}

export const esc = (value: unknown) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

export const safeHttps = (value: string | null | undefined) =>
  value && /^https:\/\/[^\s"'<>\\]+$/.test(value) && value.length <= 500 ? value : null;

/** JSON inside a <script> element that the browser never runs (no "</script>" can close it). */
const inertJson = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c").replace(/[\u2028\u2029]/g, (c) => (c === "\u2028" ? "\\u2028" : "\\u2029"));

const absolute = (origin: string | null, path: string) => {
  if (!origin) return path;
  try {
    return new URL(path, origin).toString();
  } catch {
    return path;
  }
};

// ── Icons (stroke, 24 × 24) ─────────────────────────────────────────────────
const PATHS: Record<string, string> = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  ticket: '<path d="M3 8a2 2 0 0 0 2-2h14a2 2 0 0 0 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 0-2 2H5a2 2 0 0 0-2-2v-2a2 2 0 0 0 0-4z"/><path d="M14 6v12" stroke-dasharray="2 2"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  offline: '<path d="M2 8.8a15 15 0 0 1 20 0"/><path d="M5.5 12.3a10 10 0 0 1 13 0"/><path d="M9 15.8a5 5 0 0 1 6 0"/><circle cx="12" cy="19.5" r="1"/>',
  swap: '<path d="M7 4 3 8l4 4"/><path d="M3 8h13a4 4 0 0 1 4 4"/><path d="m17 20 4-4-4-4"/><path d="M21 16H8a4 4 0 0 1-4-4"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.4 8.4 8 9 4.6-.6 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  check: '<path d="m5 12 4.5 4.5L19 7"/>',
  left: '<path d="m15 18-6-6 6-6"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  pause: '<path d="M9 5v14M15 5v14"/>',
  play: '<path d="M8 5v14l11-7z"/>',
  pin: '<path d="M12 21s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="9" r="2.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  heart: '<path d="M12 20s-7.5-4.6-9.2-9.4C1.6 7.2 3.9 4 7.2 4c2 0 3.6 1.1 4.8 2.8C13.2 5.1 14.8 4 16.8 4c3.3 0 5.6 3.2 4.4 6.6C19.5 15.4 12 20 12 20z"/>',
  share: '<circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="m8.2 10.8 7.6-4.4M8.2 13.2l7.6 4.4"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/><path d="M8 10h8M8 13h5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  up: '<path d="m6 15 6-6 6 6"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  send: '<path d="M4 12 20 4l-6 16-2.5-6.5z"/><path d="m11.5 13.5 3-3"/>',
  door: '<path d="M4 21h16M6 21V4h9l3 2v15"/><circle cx="13" cy="13" r=".8"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  megaphone: '<path d="M3 11v2a2 2 0 0 0 2 2h2l5 4V5L7 9H5a2 2 0 0 0-2 2z"/><path d="M16 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  // Run 90: the photo viewer and the compact filters.
  zoom: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5M11 8v6M8 11h6"/>',
  unzoom: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5M8 11h6"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  // Run 97: a presale or a coupon on an event card.
  tag: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 20a6.5 6.5 0 0 0-3-5.5"/>',
};
export const icon = (name: string, cls = "i") =>
  `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${PATHS[name] ?? ""}</svg>`;

/** ALKAO's mark: an "A" cut in a ticket, in the brand's electric blue (BRAND.md). */
const logoMark = (id: string) =>
  `<svg class="mark" viewBox="0 0 40 40" aria-hidden="true" focusable="false"><defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#29C3FF"/><stop offset="1" stop-color="#1565D8"/></linearGradient></defs><path fill="url(#${id})" d="M9 6h22a4 4 0 0 1 4 4v5.2a4.8 4.8 0 0 0 0 9.6V30a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4v-5.2a4.8 4.8 0 0 0 0-9.6V10a4 4 0 0 1 4-4z"/><path d="M13.5 27 20 13l6.5 14" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M16.6 22.2h6.8" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/></svg>`;

// ── Header and footer, on the home and on its other pages ──────────────────
export type Words = (typeof COPY)[Lang];

/** Run 67: what the header and footer need. */
export interface Frame {
  t: Words;
  lang: Lang;
  /** "" on the home (its sections are on the page); the home's address on another page. */
  base: string;
  home: string;
  /** This page, in this language and in the other one. */
  here: string;
  otherHere: string;
  year: number;
}

export function headAssets(asset: (name: string) => string): string {
  return `  <link rel="icon" href="${esc(asset("favicon.svg"))}" type="image/svg+xml" />
  <link rel="apple-touch-icon" href="${esc(asset("img/icon-192.png"))}" />
  <link rel="manifest" href="${esc(asset("manifest.webmanifest"))}" />
  <link rel="preload" href="${esc(asset("fonts/montserrat-latin.woff2"))}" as="font" type="font/woff2" crossorigin />
  <link rel="preload" href="${esc(asset("fonts/inter-latin.woff2"))}" as="font" type="font/woff2" crossorigin />
  <link rel="stylesheet" href="${esc(asset("home.css"))}" />`;
}

const langPath = (language: string) => `/salles${language === "en-CA" ? "?lang=en" : ""}`;

/**
 * Run 107: "Préventes" takes "Catégories"' place in the wide header, which had no room for a sixth
 * link at 1101–1280 px (the categories sit right under the deals; the phone menu and footer keep them).
 */
export function siteHeader({ t, base, home, here, otherHere }: Frame): string {
  const a = (hash: string, label: string) => `<a href="${esc(`${base}#${hash}`)}">${esc(label)}</a>`;
  return `  <header class="site-head" data-head>
    <div class="wrap head-row">
      <a class="logo" href="${esc(home)}" aria-label="ALKAO">${logoMark("lg-head")}<span class="word">ALKAO</span></a>
      <nav class="main-nav" aria-label="${esc(t.menu)}">${a("evenements", t.nav.events)}${a("preventes", t.nav.deals)}${a("organisateurs", t.nav.organizers)}<a href="${langPath(t.lang)}">${esc(t.nav.venues)}</a>${a("aide", t.nav.help)}</nav>
      <div class="head-actions">
        <a class="icon-btn" href="${esc(`${base}#evenements`)}" data-open-search aria-label="${esc(t.search)}">${icon("search")}</a>
        <a class="btn btn-ghost btn-sm tickets-btn" href="${esc(`${base}#aide`)}" data-open-tickets aria-label="${esc(t.myTickets)}">${icon("ticket")}<span>${esc(t.myTickets)}</span></a>
        <div class="lang-switch" role="group" aria-label="Langue / Language">
          <a href="${esc(here)}" aria-current="page" lang="${t.lang}">${t.short}</a><a href="${esc(otherHere)}" lang="${COPY[t.other].lang}" aria-label="${esc(t.otherLabel)}">${t.otherShort}</a>
        </div>
        <a class="btn btn-primary btn-sm head-cta" href="/ops">${esc(t.signin)}</a>
        <details class="mobile-menu">
          <summary aria-label="${esc(t.menu)}">${icon("menu")}</summary>
          <div class="mobile-panel">${a("evenements", t.nav.events)}${a("preventes", t.nav.deals)}${a("categories", t.nav.categories)}${a("comment", t.nav.how)}${a("organisateurs", t.nav.organizers)}<a href="${langPath(t.lang)}">${esc(t.nav.venues)}</a>${a("aide", t.nav.help)}<a href="/ops">${esc(t.signin)}</a><a href="${esc(otherHere)}" lang="${COPY[t.other].lang}">${icon("globe")} ${esc(t.otherLabel)}</a></div>
        </details>
      </div>
    </div>
  </header>`;
}

/**
 * Run 107: a page of takatak.ca (GROUPE TAKATAK V1, takatak-v1 main). Its routes are read from
 * that repository; takatak.ca picks its language itself, so one address serves both.
 */
export const takatakUrl = (path: string) => `https://takatak.ca${path}`;

export function siteFooter({ t, lang, base, home, here, otherHere, year }: Frame): string {
  const a = (hash: string, label: string) => `<a href="${esc(`${base}#${hash}`)}">${esc(label)}</a>`;
  return `  <footer class="site-foot">
    <div class="wrap foot-grid">
      <div class="foot-brand">
        <a class="logo" href="${esc(home)}" aria-label="ALKAO">${logoMark("lg-foot")}<span class="word">ALKAO</span></a>
        <p>${esc(t.footerTagline)}</p>
        <button class="btn btn-ghost btn-sm" type="button" data-install hidden>${icon("arrow")}${esc(t.install)}</button>
      </div>
      <nav aria-label="${esc(t.footerDiscover)}"><p class="foot-title">${esc(t.footerDiscover)}</p>${a("evenements", t.nav.events)}${a("categories", t.nav.categories)}${a("comment", t.nav.how)}</nav>
      <nav aria-label="${esc(t.footerHelp)}"><p class="foot-title">${esc(t.footerHelp)}</p>${a("aide", t.faqTitle)}${a("faq-billets", t.myTickets)}${a("faq-paiement", t.trust[2]!)}<a href="${esc(`/accessibilite${lang === "en" ? "?lang=en" : ""}`)}">${esc(t.a11y.link)}</a></nav>
      <nav aria-label="${esc(t.footerOrganizers)}"><p class="foot-title">${esc(t.footerOrganizers)}</p><a href="https://takatak.ca/register">${esc(t.signup)}</a><a href="/ops">${esc(t.signin)}</a>${a("organisateurs", t.footerFeatures)}</nav>
      <nav aria-label="${esc(t.footerTakatak)}"><p class="foot-title">${esc(t.footerTakatak)}</p><a href="https://takatak.ca">takatak.ca</a><a href="${esc(takatakUrl("/services"))}">${esc(t.footerServices)}</a><a href="${esc(takatakUrl("/deals"))}">${esc(t.footerDeals)}</a><a href="${esc(takatakUrl("/contact"))}">${esc(t.footerContact)}</a></nav>
      <nav aria-label="${esc(t.footerLanguage)}"><p class="foot-title">${esc(t.footerLanguage)}</p><a href="${esc(lang === "fr" ? here : otherHere)}" lang="fr-CA"${lang === "fr" ? ' aria-current="page"' : ""}>Français</a><a href="${esc(lang === "en" ? here : otherHere)}" lang="en-CA"${lang === "en" ? ' aria-current="page"' : ""}>English</a></nav>
    </div>
    <div class="wrap foot-legal"><p>${esc(t.rights(year))}</p><p>Digital Solutions. Real Results.</p></div>
  </footer>`;
}

// ── Events, as the page shows them ─────────────────────────────────────────
export interface Card {
  id: string;
  title: string;
  /** Run 97: "Prévente −20 %" or "Coupon −15 %", as the organizer set it; null without either. */
  deal: string | null;
  /** Run 100: "Passe festival · 3 dates" when the event sells one and has several dates. */
  pass: string | null;
  brand: string;
  brandId: string;
  /** Lowest paid admission before taxes; null when free; undefined when unknown. */
  fromCents: number | null | undefined;
  description: string;
  image: string;
  /** The organizer set a photo for this event (not ALKAO's stand-in). */
  photo: boolean;
  logo: string | null;
  place: string;
  /** Run 66: name, street and city, for a map search. */
  address: string;
  venue: string;
  venuePath: string;
  street: string;
  city: string;
  shop: string;
  url: string;
  price: string | null;
  next: Date;
  nextLabel: string;
  day: string;
  month: string;
  dates: string[];
  count: number;
  categories: string[];
  text: string;
  sessions: Date[];
  ends: (Date | null)[];
  timezone: string;
  /** Run 69: the organizer's details, as the quick view lists them. */
  facts: string[];
  accessibility: string;
  minAge: number | null;
  doorsOpenMinutes: number | null;
  language: string | null;
  /** Run 106: a past event: no price, no purchase, its last date as "next". */
  ended: boolean;
  /** Run 107: the deal behind `deal`, for the spotlight; null without one. */
  offer: Offer | null;
  /** Run 107: the regular price, struck next to "From" when that price is the presale's. */
  was: string | null;
  /** Run 109: what the struck price is ("Prix régulier" or a voucher's "Valeur"). */
  wasLabel: string;
  /** Run 109: a merchant voucher, valid until `validUntil`. */
  voucher: boolean;
  validUntil: Date | null;
  validLabel: string | null;
}

/** Run 107: a presale or a public coupon on now, exactly as the organizer set it. */
export interface Offer {
  /** Run 109: "value", a voucher's face value against its price. */
  kind: "presale" | "value" | "coupon";
  /** The saving per ticket in percent, rounded down; 0 for an amount off the order. */
  pct: number;
  priceCents: number | null;
  regularCents: number | null;
  endsAt: Date | null;
  /** A presale capped by a quantity. */
  limited: boolean;
  label: string | null;
  /** A coupon's amount off the order. */
  amountCents: number | null;
}

const dayKey = (d: Date, tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const weekday = (d: Date, tz: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(d);

/** Run 107: an amount in dollars, without cents when it is whole. */
function money(lang: Lang, cents: number): string {
  const whole = cents % 100 === 0;
  return new Intl.NumberFormat(COPY[lang].lang, { style: "currency", currency: "CAD", minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 }).format(cents / 100);
}

/**
 * Run 107: the same presale-first rule as `dealLabel`, with what the spotlight shows: the saving,
 * the prices and the end. Nothing is shown that the organizer did not set.
 */
function offerOf(e: HomeEvent): Offer | null {
  const p = e.presale;
  const when = (v: Date | string | null | undefined) => {
    const d = v ? new Date(v) : null;
    return d && !Number.isNaN(d.getTime()) ? d : null;
  };
  if (p && p.regularCents > p.priceCents && p.remaining !== 0) {
    return {
      kind: "presale", pct: Math.floor(((p.regularCents - p.priceCents) / p.regularCents) * 100),
      priceCents: p.priceCents, regularCents: p.regularCents, endsAt: when(p.endsAt), limited: p.remaining !== null, label: null, amountCents: null,
    };
  }
  // Run 109: a voucher's face value, above its price (the database keeps it so).
  const v = e.value;
  if (v && v.valueCents > v.priceCents) {
    return {
      kind: "value", pct: Math.floor(((v.valueCents - v.priceCents) / v.valueCents) * 100),
      priceCents: v.priceCents, regularCents: v.valueCents, endsAt: null, limited: false, label: null, amountCents: null,
    };
  }
  const c = e.coupon;
  if (c?.percent || c?.amountCents) {
    // An amount comes off the whole order once (src/domain/pricing.ts): its saving per ticket is
    // unknown, so it ranks after every percentage.
    return { kind: "coupon", pct: c.percent ?? 0, priceCents: null, regularCents: null, endsAt: when(c.endsAt), limited: false, label: (c.label ?? "").trim() || null, amountCents: c.amountCents ?? null };
  }
  return null;
}

function priceLabel(lang: Lang, fromCents: number | null | undefined): string | null {
  const t = COPY[lang];
  if (fromCents === undefined) return null;
  if (fromCents === null) return t.free;
  const whole = fromCents % 100 === 0;
  const money = new Intl.NumberFormat(t.lang, { style: "currency", currency: "CAD", minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 }).format(fromCents / 100);
  return `${t.from} ${money} ${t.plusTax}`;
}

/**
 * Run 97: the presale first (its saving against the regular price, rounded down), else (Run 109)
 * a voucher's saving on its face value, else the best public coupon; each only while on. Built
 * from the same offer the spotlight shows, so the two always agree.
 */
function dealLabel(lang: Lang, o: Offer | null): string | null {
  const t = COPY[lang];
  if (!o) return null;
  if (o.kind === "presale") return t.presaleRibbon(o.pct);
  if (o.kind === "value") return t.valueRibbon(o.pct);
  if (o.pct) return t.couponRibbon(lang === "en" ? `${o.pct}%` : `${o.pct} %`);
  return o.amountCents ? t.couponRibbon(money(lang, o.amountCents)) : null;
}

export function cardsOf(brands: HomeBrand[], lang: Lang, origin: string | null, asset: (name: string) => string, which: "events" | "past" = "events"): Card[] {
  const t = COPY[lang];
  const locale = t.lang;
  const cards: Card[] = [];
  for (const b of brands) {
    for (const e of (which === "past" ? b.past : b.events) ?? []) {
      const ended = which === "past";
      const timezone = e.timezone || "America/Toronto";
      const given = e.sessions?.length ? e.sessions : [e.startsAt];
      const sessions: Date[] = [];
      const ends: (Date | null)[] = [];
      given.forEach((s, i) => {
        const start = new Date(s);
        if (Number.isNaN(start.getTime())) return;
        const end = e.sessions?.length && e.ends?.[i] ? new Date(e.ends[i]!) : null;
        sessions.push(start);
        ends.push(end && !Number.isNaN(end.getTime()) && end > start ? end : null);
      });
      if (!sessions.length) continue;
      const next = sessions[0]!;
      // Run 106: a past date may be last year's, and its hour no longer matters.
      const full = new Intl.DateTimeFormat(locale, ended
        ? { timeZone: timezone, weekday: "long", day: "numeric", month: "long", year: "numeric" }
        : { timeZone: timezone, weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit" });
      const text = fold([e.title, e.description, e.venueName, e.venueCity, b.name].filter(Boolean).join(" "));
      // A word counts from its start ("tour" is not "autour"); punctuation splits words.
      // From the event's own words only: a venue or Brand name ("Havana Resort") says nothing of the event.
      const spaced = ` ${fold([e.title, e.description].filter(Boolean).join(" ")).replace(/[^a-z0-9]+/g, " ")} `;
      // Run 69: the organizer's own category wins; the words are only a guess.
      const chosen = CATEGORIES.find((c) => c.id === e.category);
      const categories = chosen ? [chosen.id] : CATEGORIES.filter((c) => c.words.some((w) => spaced.includes(` ${w.trim()}`))).map((c) => c.id);
      const minAge = Number.isInteger(e.minAge) && e.minAge! >= 0 ? e.minAge! : null;
      const doors = Number.isInteger(e.doorsOpenMinutes) && e.doorsOpenMinutes! >= 0 ? e.doorsOpenMinutes! : null;
      const language = e.language && e.language in t.languages ? e.language : null;
      const span = (m: number) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${String(m % 60).padStart(2, "0")}` : ""}`);
      const facts = [
        chosen ? chosen.label[lang] : null,
        minAge === null ? null : t.age(minAge),
        doors === null || doors === 0 ? null : t.doors(span(doors)),
        language ? t.languages[language as keyof typeof t.languages] : null,
      ].filter((x): x is string => Boolean(x));
      const fallback = CATEGORIES.find((c) => c.id === categories[0])?.image ?? "event-fallback.webp";
      const offer = ended ? null : offerOf(e);
      // Run 109: a voucher is valid until its first window's end.
      const voucher = Boolean(e.voucher) && !ended;
      const validUntil = voucher ? ends[0] ?? null : null;
      const validLabel = validUntil
        ? t.voucherUntil(new Intl.DateTimeFormat(locale, { timeZone: timezone, day: "numeric", month: "long", year: "numeric" }).format(validUntil))
        : null;
      cards.push({
        id: e.id,
        title: e.title,
        deal: dealLabel(lang, offer),
        pass: !ended && e.pass && (e.sessions?.length ?? 0) > 1 ? t.passRibbon(e.sessions!.length) : null,
        brand: b.name,
        brandId: b.brandId,
        fromCents: ended ? undefined : e.fromCents,
        description: (e.description ?? "").replace(/\s+/g, " ").trim().slice(0, 420),
        image: safeHttps(e.imageUrl) ?? asset(`img/${fallback}`),
        photo: Boolean(safeHttps(e.imageUrl)),
        logo: safeHttps(b.logoUrl),
        place: [e.venueName, e.venueCity].filter(Boolean).join(" · "),
        address: [e.venueName, e.venueAddress, e.venueCity].map((x) => (x ?? "").trim()).filter(Boolean).join(", "),
        venue: (e.venueName ?? "").trim(),
        venuePath: `/salles/${b.clientId}/${b.brandId}/${e.venueId}${lang === "en" ? "?lang=en" : ""}`,
        street: (e.venueAddress ?? "").trim(),
        city: e.venueCity ?? "",
        shop: e.shopPath,
        url: absolute(origin, e.shopPath),
        price: ended ? null : priceLabel(lang, e.fromCents),
        next,
        nextLabel: validLabel ?? full.format(next),
        day: new Intl.DateTimeFormat(locale, { timeZone: timezone, day: "numeric" }).format(next),
        month: new Intl.DateTimeFormat(locale, { timeZone: timezone, month: "short" }).format(next).replace(".", ""),
        dates: validLabel ? [validLabel] : sessions.slice(0, 6).map((s) => full.format(s)),
        count: ended ? Math.max(e.dateCount ?? 0, sessions.length) : sessions.length,
        categories,
        text,
        sessions,
        ends,
        timezone,
        facts,
        accessibility: (e.accessibility ?? "").trim().slice(0, 1000),
        minAge,
        doorsOpenMinutes: doors,
        language,
        ended,
        offer,
        was: (offer?.kind === "presale" || offer?.kind === "value") && e.fromCents === offer.priceCents && offer.regularCents ? money(lang, offer.regularCents) : null,
        wasLabel: offer?.kind === "value" ? t.voucherValue : t.dealsRegular,
        voucher,
        validUntil,
        validLabel,
      });
    }
  }
  // Upcoming: the soonest first. Past: the latest first.
  return cards.sort((a, b) => (which === "past" ? b.next.getTime() - a.next.getTime() : a.next.getTime() - b.next.getTime()) || a.title.localeCompare(b.title));
}

function inBand(card: Card, band: PriceBand): boolean {
  if (!band) return true;
  if (card.fromCents === undefined) return false;
  const cents = card.fromCents ?? 0;
  return band === "free" ? cents === 0 : band === "under25" ? cents > 0 && cents < 2500 : band === "25to50" ? cents >= 2500 && cents <= 5000 : cents > 5000;
}

function matches(card: Card, query: HomeQuery, now: Date): boolean {
  if (query.organizer && card.brandId.toLowerCase() !== query.organizer) return false;
  // Run 107: a presale or a public coupon on now.
  if (query.deals && !card.deal) return false;
  if (!inBand(card, query.price)) return false;
  if (query.q && !fold(query.q).split(" ").every((word) => card.text.includes(word))) return false;
  if (query.city && !fold(card.city).includes(fold(query.city))) return false;
  if (query.category && !card.categories.includes(query.category)) return false;
  if (query.when && !card.sessions.some((s) => inWindow(s, card.timezone, query.when, now))) return false;
  return true;
}

/** A date in the "when" window: today, this weekend (Friday to Sunday), this week or this month. */
function inWindow(s: Date, tz: string, when: When, now: Date): boolean {
  if (!when) return true;
  if (when === "today") return dayKey(s, tz) === dayKey(now, tz);
  if (s.getTime() > now.getTime() + (when === "month" ? 31 : 7) * 86_400_000) return false;
  return when === "weekend" ? ["Fri", "Sat", "Sun"].includes(weekday(s, tz)) : true;
}

/** Run 90: one event card, the same on the home and on a venue's page (where the venue is not a link). */
export function eventCard(t: Words, c: Card, { eager = false, venueLink = true } = {}): string {
  if (c.ended) return pastCard(t, c, { eager });
  return `<article class="card reveal" data-id="${esc(c.id)}">
    <a class="card-media" href="${esc(c.shop)}" tabindex="-1" aria-hidden="true"><img src="${esc(c.image)}" alt="" ${eager ? "" : 'loading="lazy" '}decoding="async" /></a>
    ${c.voucher ? `<p class="date-badge is-voucher" aria-hidden="true">${icon("ticket")}<span>${esc(t.voucherBadge)}</span></p>` : `<p class="date-badge" aria-hidden="true"><span>${esc(c.day)}</span>${esc(c.month)}</p>`}
    <button class="fav" type="button" data-fav="${esc(c.id)}" aria-pressed="false" aria-label="${esc(`${t.favorite} : ${c.title}`)}" hidden>${icon("heart")}</button>
    <div class="card-body">
      ${c.deal ? `<p class="deal-ribbon">${icon("tag")}<span>${esc(c.deal)}</span></p>` : c.pass ? `<p class="deal-ribbon is-pass">${icon("ticket")}<span>${esc(c.pass)}</span></p>` : ""}
      <p class="card-brand">${c.logo ? `<img src="${esc(c.logo)}" alt="" loading="lazy" decoding="async" />` : ""}${esc(c.brand)}</p>
      <h3 class="card-title"><a href="${esc(c.shop)}">${esc(c.title)}</a></h3>
      <p class="card-meta">${icon("clock")}<time datetime="${esc((c.validUntil ?? c.next).toISOString())}">${esc(c.nextLabel)}</time></p>
      ${c.place ? `<p class="card-meta">${icon("pin")}${venueLink ? `<a href="${esc(c.venuePath)}">${esc(c.place)}</a>` : `<span>${esc(c.place)}</span>`}</p>` : ""}
      <div class="card-foot">
        ${c.price ? (c.was ? `<p class="price has-was">${esc(c.price)} <s class="was"><span class="sr-only">${esc(c.wasLabel)} </span>${esc(c.was)}</s></p>` : `<p class="price">${esc(c.price)}</p>`) : "<span></span>"}
        <span class="pills">${c.minAge ? `<span class="pill pill-age" title="${esc(t.age(c.minAge))}">${esc(t.agePill(c.minAge))}</span>` : ""}${c.count > 1 ? `<span class="pill">${esc(t.dates(c.count))}</span>` : ""}</span>
      </div>
      <div class="card-actions">
        <a class="btn btn-primary btn-sm" href="${esc(c.shop)}">${esc(t.buy)}</a>
        <button class="btn btn-ghost btn-sm" type="button" data-preview="${esc(c.id)}" hidden>${esc(t.preview)}</button>
      </div>
    </div>
  </article>`;
}

/**
 * Run 106: a past event. It says "Terminé" with its last date, and leads to its page: no price,
 * no purchase, no favourite and no quick view (those are for what is on sale).
 */
function pastCard(t: Words, c: Card, { eager = false } = {}): string {
  // A venue page lists only what is on sale: a past event's venue is plain text.
  return `<article class="card is-past reveal" data-id="${esc(c.id)}">
    <a class="card-media" href="${esc(c.shop)}" tabindex="-1" aria-hidden="true"><img src="${esc(c.image)}" alt="" ${eager ? "" : 'loading="lazy" '}decoding="async" /></a>
    <p class="date-badge" aria-hidden="true"><span>${esc(c.day)}</span>${esc(c.month)}</p>
    <div class="card-body">
      <p class="ended-ribbon">${icon("check")}<span>${esc(t.ended)}</span></p>
      <p class="card-brand">${c.logo ? `<img src="${esc(c.logo)}" alt="" loading="lazy" decoding="async" />` : ""}${esc(c.brand)}</p>
      <h3 class="card-title"><a href="${esc(c.shop)}">${esc(c.title)}</a></h3>
      <p class="card-meta">${icon("calendar")}<time datetime="${esc(c.next.toISOString())}">${esc(c.nextLabel)}</time></p>
      ${c.place ? `<p class="card-meta">${icon("pin")}<span>${esc(c.place)}</span></p>` : ""}
      <div class="card-foot"><span></span><span class="pills">${c.count > 1 ? `<span class="pill">${esc(t.dates(c.count))}</span>` : ""}</span></div>
      <div class="card-actions">
        <a class="btn btn-ghost btn-sm" href="${esc(c.shop)}" aria-label="${esc(t.seeEventLabel(c.title))}">${esc(t.seeEvent)}</a>
      </div>
    </div>
  </article>`;
}

/** Run 90: the quick view, on the home and on a venue's page (filled by home-ui/home.js). */
export function previewDialog(t: Words): string {
  return `<dialog class="sheet sheet-wide" id="dlg-preview" aria-labelledby="dlg-preview-title">
    <div class="preview-media"><img alt="" data-p-image /><button class="round preview-zoom" type="button" data-p-zoom aria-label="${esc(t.zoom.open)}" hidden>${icon("expand")}</button></div>
    <div class="preview-body">
      <div class="sheet-head"><div><p class="card-brand" data-p-brand></p><h2 id="dlg-preview-title" data-p-title></h2></div><button class="round" type="button" data-close aria-label="${esc(t.close)}">${icon("close")}</button></div>
      <p class="card-meta">${icon("pin")}<span data-p-place></span></p>
      <p class="price" data-p-price></p>
      <ul class="facts" data-p-facts aria-label="${esc(t.facts)}" hidden></ul>
      <p class="preview-text" data-p-text></p>
      <div class="preview-access" data-p-access hidden><p class="preview-label">${esc(t.accessibilityTitle)}</p><p data-p-access-text></p></div>
      <p class="preview-label">${esc(t.nextDate)}</p>
      <ul class="preview-dates" data-p-dates></ul>
      <div class="actions"><a class="btn btn-primary" data-p-shop href="/">${esc(t.buy)}${icon("arrow")}</a><button class="btn btn-ghost" type="button" data-p-share>${icon("share")}${esc(t.share)}</button><button class="btn btn-ghost" type="button" data-p-fav aria-pressed="false">${icon("heart")}<span>${esc(t.favorite)}</span></button></div>
      <div class="actions actions-small"><button class="btn btn-ghost btn-sm" type="button" data-p-ics>${icon("calendar")}${esc(t.addToCalendar)}</button><a class="btn btn-ghost btn-sm" data-p-map href="/" target="_blank" rel="noopener noreferrer">${icon("pin")}<span>${esc(t.directions)}</span></a><button class="btn btn-ghost btn-sm" type="button" data-p-follow hidden>${icon("bell")}<span></span></button></div>
    </div>
  </dialog>`;
}

/** What home-ui/home.js needs to know about an event (quick view, favourites, calendar, search). */
export function eventData(c: Card) {
  return {
    id: c.id, title: c.title, brand: c.brand, brandId: c.brandId.toLowerCase(), description: c.description, image: c.image, place: c.place, city: c.city,
    shop: c.shop, url: c.url, price: c.price, next: c.nextLabel, dates: c.dates, count: c.count, categories: c.categories, text: c.text,
    // Run 66: the shown dates as instants (for the calendar file) and a map search.
    starts: c.sessions.slice(0, 6).map((d) => d.toISOString()),
    ends: c.ends.slice(0, 6).map((d) => d?.toISOString() ?? null),
    facts: c.facts,
    accessibility: c.accessibility || null,
    address: c.address,
    map: c.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(c.address)}` : null,
    photo: c.photo,
  };
}

/** The words home-ui/home.js shows. */
export function clientWords(t: Words) {
  return {
    assistant: t.assistant, search: t.searchDialog, favorite: t.favorite, unfavorite: t.unfavorite, favorites: t.favorites,
    share: t.share, copied: t.copied, buy: t.buy, close: t.close, nextDate: t.nextDate, otherDates: t.otherDates,
    pause: t.pause, play: t.play, dates: t.dates(2).replace("2", "{n}"), slideOf: t.slideOf(9, 8).replace("9", "{i}").replace("8", "{n}"),
    recent: t.recentTitle, addDate: t.addDateToCalendar("{d}"), directionsTo: t.directionsTo("{p}"),
    accessibilityTitle: t.accessibilityTitle,
    follow: t.follow("{b}"), followLead: t.followLead("{b}"), followNote: t.followNote("{b}"), followDone: t.followDone("{b}"),
    followInvalid: t.followInvalid, followBusy: t.followBusy, followError: t.followError,
    zoom: t.zoom,
  };
}

// ── Run 107: presales and discounts, organizers' tools, GROUPE TAKATAK ───────

/**
 * The presales and coupons on now: the best one in full (its saving, both prices and its end),
 * then the others as cards. With none on, how ALKAO's discounts work, and nothing invented.
 */
function dealsSection(t: Words, lang: Lang, deals: Card[], { link, card }: { link: (params: Record<string, string>) => string; card: (c: Card) => string }): string {
  const head = `<div class="section-head reveal"><p class="kicker">${esc(t.dealsTitle)}</p><h2 id="deals-title">${esc(t.dealsHeadline)}</h2><p>${esc(t.dealsLead)}</p></div>`;
  if (!deals.length) {
    return `    <section class="section deals" id="preventes" aria-labelledby="deals-title">
      <div class="wrap">
        ${head}
        <ul class="deal-how">${t.dealsHow.map((h) => `<li class="feature reveal">${icon(h.icon)}<h3>${esc(h.title)}</h3><p>${esc(h.text)}</p></li>`).join("")}</ul>
        <p class="deals-waiting">${icon("bell")}<span>${esc(t.dealsWaiting)}</span></p>
      </div>
    </section>`;
  }
  // The largest saving first; on a tie, the soonest date (deals come soonest first).
  const best = [...deals].sort((a, b) => (b.offer?.pct ?? 0) - (a.offer?.pct ?? 0))[0]!;
  const others = deals.filter((c) => c !== best);
  const o = best.offer!;
  const ends = o.endsAt
    ? new Intl.DateTimeFormat(t.lang, { timeZone: best.timezone, day: "numeric", month: "long", hour: "numeric", minute: "2-digit" }).format(o.endsAt)
    : null;
  const value = o.kind === "value";
  const price = (o.kind === "presale" || value) && o.priceCents !== null && o.regularCents !== null
    ? `<div class="spot-price">
            <p class="spot-now"><span class="sr-only">${esc(value ? t.buy : t.dealsPresalePrice)} </span>${esc(money(lang, o.priceCents))}<small>${esc(t.plusTax)}</small></p>
            <p class="spot-was">${esc(value ? t.voucherValue : t.dealsRegular)} <s>${esc(money(lang, o.regularCents))}</s></p>
            <p class="spot-save">${esc(value ? t.voucherSave(money(lang, o.regularCents - o.priceCents)) : t.dealsSave(money(lang, o.regularCents - o.priceCents)))}</p>
          </div>`
    : `<div class="spot-price">
            <p class="spot-now">${esc(best.deal ?? "")}</p>
            ${o.label ? `<p class="spot-was">${esc(o.label)}</p>` : ""}
            <p class="spot-save">${esc(t.dealsCoupon)}</p>
          </div>`;
  const facts = [
    ends ? `<li>${icon("clock")}<span>${esc(t.dealsUntil(ends))}</span></li>` : "",
    // Run 109: a voucher's own validity.
    best.validLabel ? `<li>${icon("calendar")}<span>${esc(best.validLabel)}</span></li>` : "",
    o.limited ? `<li>${icon("ticket")}<span>${esc(t.dealsLimited)}</span></li>` : "",
  ].join("");
  return `    <section class="section deals" id="preventes" aria-labelledby="deals-title">
      <div class="wrap">
        ${head}
        <article class="spotlight reveal" aria-labelledby="spot-title">
          <a class="spot-media" href="${esc(best.shop)}" tabindex="-1" aria-hidden="true"><img src="${esc(best.image)}" alt="" loading="lazy" decoding="async" />${best.voucher ? `<p class="date-badge is-voucher">${icon("ticket")}<span>${esc(t.voucherBadge)}</span></p>` : `<p class="date-badge"><span>${esc(best.day)}</span>${esc(best.month)}</p>`}</a>
          <div class="spot-body">
            <p class="spot-tag">${icon("bolt")}<span>${esc(t.dealsBest)}</span></p>
            <p class="deal-ribbon">${icon("tag")}<span>${esc(best.deal ?? "")}</span></p>
            <p class="card-brand">${best.logo ? `<img src="${esc(best.logo)}" alt="" loading="lazy" decoding="async" />` : ""}${esc(best.brand)}</p>
            <h3 class="spot-title" id="spot-title"><a href="${esc(best.shop)}">${esc(best.title)}</a></h3>
            ${best.voucher ? "" : `<p class="card-meta">${icon("calendar")}<time datetime="${esc(best.next.toISOString())}">${esc(best.nextLabel)}</time></p>`}
            ${best.place ? `<p class="card-meta">${icon("pin")}<span>${esc(best.place)}</span></p>` : ""}
            ${price}
            ${facts ? `<ul class="spot-facts">${facts}</ul>` : ""}
            <div class="actions"><a class="btn btn-primary" href="${esc(best.shop)}">${esc(t.buy)}${icon("arrow")}</a>${others.length ? `<a class="btn btn-ghost" href="${esc(link({ offres: "1" }))}">${esc(t.dealsSeeAll(deals.length))}</a>` : ""}</div>
          </div>
        </article>
        ${others.length ? `<h3 class="grid-title deals-others">${esc(t.dealsOthers)}</h3>
        <div class="grid" id="deals-list">${others.slice(0, 6).map((c) => card(c)).join("")}</div>` : ""}
      </div>
    </section>`;
}

/** The discount tools an organizer has in /ops (Runs 97 to 105), each one already built. */
function toolsSection(t: Words): string {
  return `    <section class="section tools" id="outils-rabais" aria-labelledby="tools-title">
      <div class="wrap">
        <div class="section-head reveal"><p class="kicker">${esc(t.toolsKicker)}</p><h2 id="tools-title">${esc(t.toolsTitle)}</h2><p>${esc(t.toolsLead)}</p></div>
        <div class="features">
          ${t.tools.map((f) => `<div class="feature reveal">${icon(f.icon)}<h3>${esc(f.title)}</h3><p>${esc(f.text)}</p></div>`).join("")}
        </div>
        <p class="tools-results reveal">${icon("chart")}<span>${esc(t.toolsResults)}</span></p>
        <div class="actions"><a class="btn btn-primary" href="https://takatak.ca/register">${esc(t.signup)}${icon("arrow")}</a><a class="btn btn-ghost" href="/ops">${esc(t.signin)}</a></div>
      </div>
    </section>`;
}

/**
 * GROUPE TAKATAK's services for an event, and its own discounts, as takatak.ca states them
 * (takatak-v1 main: src/lib/website/service-pages.ts and src/lib/promotions/catalog.ts).
 * Text only: the official logo files are not in this repository (BRAND.md).
 */
function takatakSection(t: Words): string {
  const k = t.takatak;
  return `    <section class="section tk" id="takatak" aria-labelledby="tk-title">
      <div class="wrap">
        <div class="section-head reveal"><p class="kicker">${esc(k.kicker)}</p><h2 id="tk-title">${esc(k.title)}</h2><p>${esc(k.lead)}</p><p class="tk-tagline">Digital Solutions. Real Results.</p></div>
        <div class="tk-grid">
          ${k.services.map((s) => `<a class="tk-service reveal" href="${esc(takatakUrl(`/services/${s.slug}`))}" aria-label="${esc(k.serviceLink(s.title))}">${icon(s.icon)}<h3>${esc(s.title)}</h3><p>${esc(s.text)}</p><span class="tk-more" aria-hidden="true">takatak.ca${icon("arrow")}</span></a>`).join("")}
          <div class="tk-offers reveal">
            <h3>${esc(k.offersTitle)}</h3>
            <ul>${k.offers.map((o) => `<li><span class="tk-big">${esc(o.big)}</span><span class="tk-text">${esc(o.text)}${o.code ? ` <span class="tk-code">${esc(k.codeLabel)} <b>${esc(o.code)}</b></span>` : ""}</span></li>`).join("")}</ul>
            <p class="tk-note">${esc(k.offersNote)}</p>
            <div class="actions"><a class="btn btn-primary btn-sm" href="${esc(takatakUrl("/deals"))}">${esc(k.deals)}${icon("arrow")}</a><a class="btn btn-ghost btn-sm" href="${esc(takatakUrl("/contact"))}">${esc(k.contact)}</a></div>
          </div>
        </div>
      </div>
    </section>`;
}

// ── Page ───────────────────────────────────────────────────────────────────
export interface RenderOptions {
  origin: string | null;
  lang: Lang;
  brands: HomeBrand[];
  query: HomeQuery;
  now: Date;
  /** The versioned URL of a file in home-ui/ (src/api/home.ts). */
  asset: (name: string) => string;
}

export function renderHome({ origin, lang, brands, query, now, asset }: RenderOptions): string {
  const t = COPY[lang];
  const canonical = origin ? `${origin}/` : null;
  const langQuery = (l: Lang) => (l === "en" ? "?lang=en" : "");
  const home = `/${langQuery(lang)}`;
  const otherHome = `/${langQuery(t.other)}`;
  // Run 106: the past year's events, behind the "Passés" filter. Dates, prices, sort and the
  // agenda are about what is on sale, so they do not apply there.
  const past = query.period === "past";
  const ask: HomeQuery = past ? { ...query, when: "", price: "", sort: "", view: "", deals: false } : query;
  // A sort alone also lists the results (no rail), in its order; so does the past.
  const filtered = past || Boolean(ask.q || ask.city || ask.when || ask.category || ask.price || ask.organizer || ask.sort || ask.deals);
  // `all` is what is on sale: the hero, the rails, the search data and the search-engine data
  // never show a past event.
  const all = cardsOf(brands, lang, origin, asset);
  const ended = cardsOf(brands, lang, origin, asset, "past");
  const pool = past ? ended : all;
  const cheapest = (c: Card) => (c.fromCents === undefined ? Number.POSITIVE_INFINITY : (c.fromCents ?? 0));
  const shown = filtered ? pool.filter((c) => matches(c, ask, now)) : pool;
  if (ask.sort === "price") shown.sort((a, b) => cheapest(a) - cheapest(b) || a.next.getTime() - b.next.getTime());
  // Run 109: a voucher is not an outing on a date: not in "Cette semaine", the agenda or the Event data.
  const week = all.filter((c) => !c.voucher && c.next.getTime() - now.getTime() <= 7 * 86_400_000);
  // Run 97: presales and coupons on now.
  const deals = all.filter((c) => c.deal);
  const cities = [...new Set(pool.map((c) => c.city).filter(Boolean))].sort((a, b) => a.localeCompare(b, t.lang));
  const link = (params: Record<string, string>) => {
    const p = new URLSearchParams({ ...(lang === "en" ? { lang: "en" } : {}), ...params });
    return `/?${p}#evenements`;
  };
  // Run 66: the current search with one value changed ("" removes it), for the filter chips.
  const current: Record<string, string> = {
    q: ask.q, ville: ask.city, quand: ask.when, categorie: ask.category,
    prix: ask.price, tri: ask.sort === "price" ? "prix" : "", organisateur: ask.organizer, vue: ask.view,
    periode: past ? "passes" : "",
    offres: ask.deals ? "1" : "",
  };
  const refine = (change: Record<string, string>) =>
    link(Object.fromEntries(Object.entries({ ...current, ...change }).filter(([, v]) => v)));
  const organizers = brands
    .filter((b) => pool.some((c) => c.brandId === b.brandId))
    .map((b) => ({
      id: b.brandId.toLowerCase(), name: b.name, logo: safeHttps(b.logoUrl),
      // Run 67: "Suivre", the Brand's newsletter sign-up (Run 44, confirmed by e-mail).
      follow: `/v1/public/clients/${b.clientId.toLowerCase()}/brands/${b.brandId.toLowerCase()}/newsletter`,
    }));
  const organizer = organizers.find((o) => o.id === ask.organizer);
  const priced = !past && all.some((c) => c.fromCents !== undefined);
  const bands = PRICES.filter((band) => band === ask.price || all.some((c) => inBand(c, band)));
  const chip = (href: string, label: string, on: boolean, extra = "") =>
    `<a class="chip${on ? " is-current" : ""}" href="${esc(href)}"${on ? ' aria-current="true"' : ""}>${extra}${esc(label)}</a>`;
  // Run 90: one compact row, a menu per filter (<details>: it works without JavaScript) and the view switch.
  const menu = (id: string, label: string, value: string, set: boolean, items: string, note = "") =>
    `<details class="dd${set ? " is-set" : ""}"><summary><span class="dd-label" id="${id}">${esc(label)}</span><span class="dd-value">${esc(value)}</span>${icon("down", "i dd-chev")}</summary>
          <div class="dd-menu" role="group" aria-labelledby="${id}">${note ? `<p class="dd-note">${esc(note)}</p>` : ""}<div class="chips">${items}</div></div></details>`;
  // Run 106: "À venir" and "Passés", each with its count; going to the past drops what only
  // applies to sales (dates, price, sort, agenda).
  const periodChip = (href: string, label: string, on: boolean, n: number) =>
    `<a class="chip${on ? " is-current" : ""}" href="${esc(href)}"${on ? ' aria-current="true"' : ""}>${esc(label)}<span class="count">${n}</span></a>`;
  const periodSwitch = ended.length || past
    ? `<div class="period-switch" role="group" aria-labelledby="f-period"><span class="sr-only" id="f-period">${esc(t.periodTitle)}</span>${periodChip(refine({ periode: "" }), t.periodOptions.upcoming, !past, all.length)}${periodChip(refine({ periode: "passes", quand: "", prix: "", tri: "", vue: "", offres: "" }), t.periodOptions.past, past, ended.length)}</div>`
    : "";
  // Run 107: only the events with a presale or a coupon on now, with their count.
  const dealsChip = !past && (deals.length || ask.deals)
    ? `<a class="chip deal-chip${ask.deals ? " is-current" : ""}" href="${esc(refine({ offres: ask.deals ? "" : "1" }))}"${ask.deals ? ' aria-current="true"' : ""}>${icon("tag")}${esc(t.dealsTitle)}<span class="count">${deals.length}</span></a>`
    : "";
  // Run 106: the date window and the category, right in the bar (also in the search form above).
  const whens = (["today", "weekend", "week", "month"] as const).filter((w) => w === ask.when || all.some((c) => c.sessions.some((s) => inWindow(s, c.timezone, w, now))));
  const whenMenu = !past && whens.length
    ? menu("f-when", t.when, ask.when ? t.whenOptions[ask.when] : t.whenOptions.all, Boolean(ask.when),
      `${chip(refine({ quand: "" }), t.whenOptions.all, !ask.when)}${whens.map((w) => chip(refine({ quand: w }), t.whenOptions[w], ask.when === w)).join("")}`)
    : "";
  const kinds = CATEGORIES.filter((c) => c.id === ask.category || pool.some((e) => e.categories.includes(c.id)));
  const categoryMenu = kinds.length
    ? menu("f-cat", t.categoryTitle, CATEGORIES.find((c) => c.id === ask.category)?.label[lang] ?? t.allCategories, Boolean(ask.category),
      `${chip(refine({ categorie: "" }), t.allCategories, !ask.category)}${kinds.map((c) => chip(refine({ categorie: c.id }), c.label[lang], ask.category === c.id)).join("")}`)
    : "";
  const filterBar = all.length || ended.length
    ? `<div class="filters reveal" role="group" aria-label="${esc(t.filters)}">
        ${periodSwitch}
        ${dealsChip}
        ${whenMenu}
        ${categoryMenu}
        ${priced ? `${menu("f-price", t.priceTitle, ask.price ? t.priceOptions[ask.price] : t.priceOptions.all, Boolean(ask.price),
          `${chip(refine({ prix: "" }), t.priceOptions.all, !ask.price)}${bands.map((band) => chip(refine({ prix: band }), t.priceOptions[band as Exclude<PriceBand, "">], ask.price === band)).join("")}`, t.priceNote)}
        ${menu("f-sort", t.sortTitle, ask.sort === "price" ? t.sortOptions.price : t.sortOptions.date, ask.sort === "price",
          `${chip(refine({ tri: "" }), t.sortOptions.date, ask.sort !== "price")}${chip(refine({ tri: "prix" }), t.sortOptions.price, ask.sort === "price")}`)}` : ""}
        ${organizers.length > 1 || organizer ? menu("f-org", t.organizersTitle, organizer?.name ?? t.allOrganizers, Boolean(organizer),
          `${chip(refine({ organisateur: "" }), t.allOrganizers, !ask.organizer)}${organizers.map((o) => chip(refine({ organisateur: o.id }), o.name, o.id === ask.organizer, o.logo ? `<img src="${esc(o.logo)}" alt="" loading="lazy" decoding="async" />` : "")).join("")}`) : ""}
        ${past || !all.length ? "" : `<div class="view-switch" role="group" aria-labelledby="f-view"><span class="sr-only" id="f-view">${esc(t.viewTitle)}</span>${chip(refine({ vue: "" }), t.viewOptions.grid, ask.view !== "agenda", icon("grid"))}${chip(refine({ vue: "agenda" }), t.viewOptions.agenda, ask.view === "agenda", icon("list"))}</div>`}
      </div>`
    : "";
  // Run 106: each filter on, as a chip that takes it off, and one link that clears them all.
  const active: { label: string; off: Record<string, string> }[] = [
    ...(ask.q ? [{ label: `« ${ask.q} »`, off: { q: "" } }] : []),
    ...(ask.category ? [{ label: CATEGORIES.find((c) => c.id === ask.category)!.label[lang], off: { categorie: "" } }] : []),
    ...(ask.city ? [{ label: ask.city, off: { ville: "" } }] : []),
    ...(ask.when ? [{ label: t.whenOptions[ask.when], off: { quand: "" } }] : []),
    ...(ask.price ? [{ label: t.priceOptions[ask.price], off: { prix: "" } }] : []),
    ...(organizer ? [{ label: organizer.name, off: { organisateur: "" } }] : []),
    ...(ask.sort === "price" ? [{ label: t.sortOptions.price, off: { tri: "" } }] : []),
    ...(ask.deals ? [{ label: t.dealsTitle, off: { offres: "" } }] : []),
  ];
  const activeChips = active.length
    ? `<ul class="active-filters" aria-label="${esc(t.activeFilters)}">${active.map((a) => `<li><a class="chip is-on" href="${esc(refine(a.off))}" aria-label="${esc(t.removeFilter(a.label))}">${esc(a.label)}${icon("close")}</a></li>`).join("")}</ul>`
    : "";
  const clearAll = link(past ? { periode: "passes" } : {});

  const card = (c: Card, eager = false) => eventCard(t, c, { eager });

  const AGENDA_MAX = 120;
  const agendaRows = shown
    .filter((c) => !c.voucher)
    .flatMap((c) => c.sessions.map((start) => ({ c, start })))
    .filter(({ c, start }) => inWindow(start, c.timezone, ask.when, now))
    .sort((x, y) => x.start.getTime() - y.start.getTime() || x.c.title.localeCompare(y.c.title));
  const agenda = () => {
    const days: { key: string; label: string; rows: typeof agendaRows }[] = [];
    for (const row of agendaRows.slice(0, AGENDA_MAX)) {
      const key = dayKey(row.start, row.c.timezone);
      const last = days.at(-1);
      if (last?.key === key) last.rows.push(row);
      else days.push({ key, label: new Intl.DateTimeFormat(t.lang, { timeZone: row.c.timezone, weekday: "long", day: "numeric", month: "long" }).format(row.start), rows: [row] });
    }
    const timeOf = (row: (typeof agendaRows)[number]) => new Intl.DateTimeFormat(t.lang, { timeZone: row.c.timezone, hour: "numeric", minute: "2-digit" }).format(row.start);
    const fullOf = (row: (typeof agendaRows)[number]) => new Intl.DateTimeFormat(t.lang, { timeZone: row.c.timezone, weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit" }).format(row.start);
    return `<div class="agenda">${days.map((d, i) => `<div class="agenda-day reveal">
        <h3 class="agenda-date" id="jour-${i}">${esc(d.label)}</h3>
        <ol class="agenda-list" aria-labelledby="jour-${i}">${d.rows.map((row) => `<li class="agenda-row">
          <time class="agenda-time" datetime="${esc(row.start.toISOString())}">${esc(timeOf(row))}</time>
          <div class="agenda-main"><a class="agenda-title" href="${esc(row.c.shop)}">${esc(row.c.title)}</a>
            <p class="card-meta">${row.c.place ? `${icon("pin")}<span>${esc(row.c.place)}</span> · ` : ""}<span>${esc(row.c.brand)}</span></p></div>
          ${row.c.price ? `<p class="price">${esc(row.c.price)}</p>` : "<span></span>"}
          <a class="btn btn-primary btn-sm" href="${esc(row.c.shop)}" aria-label="${esc(t.agendaBuy(row.c.title, fullOf(row)))}">${esc(t.buy)}</a>
        </li>`).join("")}</ol>
      </div>`).join("")}</div>${agendaRows.length > AGENDA_MAX ? `<p class="agenda-more">${esc(t.agendaMore(agendaRows.length - AGENDA_MAX))}</p>` : ""}`;
  };

  const rail = (id: string, title: string, lead: string, items: Card[], extra = "") => `<div class="rail-block">
      <div class="rail-head"><div><h3 id="${id}">${esc(title)}</h3>${lead ? `<p>${esc(lead)}</p>` : ""}${extra}</div>
        <div class="rail-nav" hidden><button class="round" type="button" data-rail-prev="${id}-rail" aria-label="${esc(t.scrollPrev)}">${icon("left")}</button><button class="round" type="button" data-rail-next="${id}-rail" aria-label="${esc(t.scrollNext)}">${icon("right")}</button></div>
      </div>
      <div class="rail" id="${id}-rail" role="list" aria-labelledby="${id}">${items.map((c) => `<div role="listitem" class="rail-item">${card(c)}</div>`).join("")}</div>
    </div>`;

  // Hero slides: up to three real events with a photo, then ALKAO's own.
  type Slide = { image: string; mobile: string | null; tag: string; title: string; text: string; href: string; cta: string; preview?: string };
  // Run 107: a deal on now comes first, and its slide says it.
  const featured = all.filter((c) => c.photo).sort((a, b) => Number(Boolean(b.deal)) - Number(Boolean(a.deal))).slice(0, 3);
  const slides: Slide[] = [
    ...featured.map((c) => ({
      image: c.image, mobile: null, tag: `${c.deal ?? t.featuredTag} · ${c.brand}`, title: c.title,
      text: [c.nextLabel, c.city, c.price].filter(Boolean).join(" · "), href: c.shop, cta: t.buy, preview: c.id,
    })),
    // With real events up front, three of ALKAO's own slides are enough.
    ...(featured.length ? (["concert", "outdoor", "organizers"] as const) : (["concert", "festival", "outdoor", "stage", "organizers"] as const)).map((k) => {
      const s = t.slides[k];
      const file = k === "organizers" ? "lights" : k;
      const target = k === "organizers" ? "#organisateurs"
        : link({ categorie: k === "concert" ? "concerts" : k === "festival" ? "festivals" : k === "outdoor" ? "plein-air" : "spectacles" });
      return { image: asset(`img/hero-${file}.webp`), mobile: asset(`img/hero-${file}-m.webp`), tag: s.tag, title: s.title, text: s.text, href: target, cta: k === "organizers" ? t.signup : t.nav.events };
    }),
  ];

  const whenSelect = (Object.entries(t.whenOptions) as [string, string][])
    .map(([v, label]) => `<option value="${v === "all" ? "" : v}"${(v === "all" ? "" : v) === ask.when ? " selected" : ""}>${esc(label)}</option>`).join("");

  const counts = new Map(CATEGORIES.map((c) => [c.id, all.filter((e) => e.categories.includes(c.id)).length]));
  const faq = help(lang);
  const year = Number(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric" }).format(now));

  const data = {
    lang,
    events: all.map(eventData),
    categories: CATEGORIES.map((c) => ({ id: c.id, label: c.label[lang], url: link({ categorie: c.id }), words: c.words })),
    organizers: organizers.map((o) => ({ id: o.id, name: o.name, follow: o.follow })),
    help: faq,
    otherUrl: otherHome,
    searchUrl: link({}),
    t: clientWords(t),
  };

  // Run 66: one Event per date (the next ten of each), with the lowest price as its offer. The
  // listed dates all have seats left (src/api/app.ts), so each offer is in stock.
  const jsonLd = all.filter((c) => !c.voucher).flatMap((c) => {
    const { venue, street } = c;
    const offers = c.fromCents === undefined ? {} : {
      offers: {
        "@type": "Offer",
        url: c.url,
        price: ((c.fromCents ?? 0) / 100).toFixed(2),
        priceCurrency: "CAD",
        availability: "https://schema.org/InStock",
        // "From": the lowest admission, taxes extra.
        priceSpecification: { "@type": "PriceSpecification", minPrice: (c.fromCents ?? 0) / 100, priceCurrency: "CAD", valueAddedTaxIncluded: false },
      },
    };
    return c.sessions.slice(0, 10).map((start, i) => ({
      "@context": "https://schema.org",
      "@type": "Event",
      name: c.title,
      startDate: start.toISOString(),
      ...(c.ends[i] ? { endDate: c.ends[i]!.toISOString() } : {}),
      // Run 69: what the organizer said.
      ...(c.doorsOpenMinutes ? { doorTime: new Date(start.getTime() - c.doorsOpenMinutes * 60_000).toISOString() } : {}),
      ...(c.minAge ? { typicalAgeRange: `${c.minAge}-` } : {}),
      ...(c.language === "fr" ? { inLanguage: "fr-CA" } : c.language === "en" ? { inLanguage: "en-CA" } : c.language === "fr-en" ? { inLanguage: ["fr-CA", "en-CA"] } : {}),
      eventStatus: "https://schema.org/EventScheduled",
      eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
      ...(c.photo ? { image: [c.image] } : {}),
      ...(c.description ? { description: c.description } : {}),
      location: {
        "@type": "Place",
        name: venue || c.brand,
        ...(c.city || street ? { address: { "@type": "PostalAddress", ...(street ? { streetAddress: street } : {}), ...(c.city ? { addressLocality: c.city } : {}), addressCountry: "CA" } } : {}),
      },
      organizer: { "@type": "Organization", name: c.brand },
      ...offers,
      url: c.url,
    }));
  });

  const frame: Frame = { t, lang, base: "", home, here: home, otherHere: otherHome, year };

  return `<!doctype html>
<html lang="${t.lang}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>${esc(t.title)}</title>
  <meta name="description" content="${esc(t.description)}" />
  ${canonical ? `<link rel="canonical" href="${esc(lang === "en" ? `${canonical}?lang=en` : canonical)}" />
  <link rel="alternate" hreflang="fr-CA" href="${esc(canonical)}" />
  <link rel="alternate" hreflang="en-CA" href="${esc(`${canonical}?lang=en`)}" />
  <link rel="alternate" hreflang="x-default" href="${esc(canonical)}" />` : `<link rel="alternate" hreflang="${lang === "fr" ? "en-CA" : "fr-CA"}" href="${esc(otherHome)}" />`}
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="ALKAO" />
  <meta property="og:locale" content="${lang === "fr" ? "fr_CA" : "en_CA"}" />
  <meta property="og:title" content="${esc(t.title)}" />
  <meta property="og:description" content="${esc(t.description)}" />
  ${canonical ? `<meta property="og:url" content="${esc(canonical)}" />
  <meta property="og:image" content="${esc(absolute(origin, asset("img/hero-festival.webp")))}" />` : ""}
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="theme-color" content="#060D1F" />
${headAssets(asset)}
  ${jsonLd.length ? `<script type="application/ld+json">${inertJson(jsonLd)}</script>` : ""}
</head>
<body>
  <a class="skip" href="#contenu">${esc(t.skip)}</a>
  <div class="aurora" aria-hidden="true"><span></span><span></span><span></span></div>

${siteHeader(frame)}

  <main id="contenu">
    <section class="hero" aria-labelledby="hero-title">
      <div class="hero-slides" data-carousel aria-roledescription="carousel" aria-label="${esc(t.carousel)}">
        ${slides.map((s, i) => `<figure class="slide${i === 0 ? " is-active" : ""}" data-slide aria-roledescription="slide" aria-label="${esc(t.slideOf(i + 1, slides.length))}"${i === 0 ? "" : ' aria-hidden="true"'}>
          <picture>${s.mobile ? `<source media="(max-width: 720px)" srcset="${esc(s.mobile)}" />` : ""}<img src="${esc(s.image)}" alt="" ${i === 0 ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async" /></picture>
        </figure>`).join("")}
      </div>
      <div class="hero-shade" aria-hidden="true"></div>
      <div class="wrap hero-inner">
        <div class="hero-copy">
          <p class="eyebrow">${esc(t.eyebrow)}</p>
          <h1 id="hero-title">${esc(t.h1)}</h1>
          <p class="lead">${esc(t.lead)}</p>
          <form class="search-bar" action="/#evenements" method="get" role="search" aria-label="${esc(t.search)}">
            ${lang === "en" ? '<input type="hidden" name="lang" value="en" />' : ""}
            <label class="field"><span>${esc(t.what)}</span><input name="q" type="search" value="${esc(query.q)}" placeholder="${esc(t.whatHint)}" autocomplete="off" maxlength="80" /></label>
            <label class="field"><span>${esc(t.where)}</span><input name="ville" type="text" value="${esc(query.city)}" placeholder="${esc(t.whereHint)}" list="alkao-cities" autocomplete="address-level2" maxlength="80" /></label>
            <label class="field"><span>${esc(t.when)}</span><select name="quand">${whenSelect}</select></label>
            ${(["categorie", "prix", "tri", "organisateur", "vue", "periode", "offres"] as const).filter((k) => current[k]).map((k) => `<input type="hidden" name="${k}" value="${esc(current[k])}" />`).join("")}
            <button class="btn btn-primary btn-search" type="submit">${icon("search")}<span>${esc(t.search)}</span></button>
          </form>
          <datalist id="alkao-cities">${cities.map((c) => `<option value="${esc(c)}"></option>`).join("")}</datalist>
        </div>
        <div class="slide-card">
          ${slides.map((s, i) => `<div class="caption${i === 0 ? " is-active" : ""}" data-caption${i === 0 ? "" : " hidden"}>
            <p class="caption-tag">${esc(s.tag)}</p>
            <p class="caption-title">${esc(s.title)}</p>
            <p class="caption-text">${esc(s.text)}</p>
            <a class="caption-link" href="${esc(s.href)}">${esc(s.cta)}${icon("arrow")}</a>
          </div>`).join("")}
          <div class="slide-controls" hidden>
            <button class="round" type="button" data-slide-prev aria-label="${esc(t.prev)}">${icon("left")}</button>
            <button class="round" type="button" data-slide-toggle aria-label="${esc(t.pause)}">${icon("pause", "i i-pause")}${icon("play", "i i-play")}</button>
            <button class="round" type="button" data-slide-next aria-label="${esc(t.next)}">${icon("right")}</button>
            <div class="dots">${slides.map((_, i) => `<button type="button" data-dot="${i}" aria-label="${esc(t.slideOf(i + 1, slides.length))}"${i === 0 ? ' aria-current="true"' : ""}><span></span></button>`).join("")}</div>
          </div>
        </div>
      </div>
    </section>

    <ul class="trust wrap" aria-label="ALKAO">
      ${t.trust.map((item, i) => `<li>${icon(["bolt", "offline", "lock", "check", "pin"][i]!)}<span>${esc(item)}</span></li>`).join("")}
    </ul>

${dealsSection(t, lang, deals, { link, card })}

    <section class="section" id="categories" aria-labelledby="categories-title">
      <div class="wrap">
        <div class="section-head reveal"><p class="kicker">${esc(t.nav.categories)}</p><h2 id="categories-title">${esc(t.categoriesTitle)}</h2><p>${esc(t.categoriesLead)}</p></div>
        <div class="cats">
          ${CATEGORIES.map((c) => `<a class="cat reveal${query.category === c.id ? " is-current" : ""}" href="${esc(link({ categorie: c.id }))}"${query.category === c.id ? ' aria-current="true"' : ""}>
            <img src="${esc(asset(`img/${c.image}`))}" alt="" loading="lazy" decoding="async" />
            <span class="cat-name">${esc(c.label[lang])}</span>
            ${counts.get(c.id) ? `<span class="cat-count">${esc(t.results(counts.get(c.id)!))}</span>` : ""}
          </a>`).join("")}
        </div>
      </div>
    </section>

    <section class="section events" id="evenements" aria-labelledby="events-title">
      <div class="wrap">
        <div class="section-head reveal"><p class="kicker">${esc(past ? t.periodOptions.past : t.featuredTag)}</p><h2 id="events-title">${esc(past ? t.pastTitle : t.eventsTitle)}</h2><p>${esc(past ? t.pastLead : t.featuredLead)}</p></div>
        ${filterBar}
        ${filtered && (all.length || past) ? `<div class="results" role="status">
            <p><strong>${esc(t.results(shown.length))}</strong>${ask.q ? ` ${esc(t.resultsFor)} « ${esc(ask.q)} »` : ""}</p>
            ${activeChips}
            <div class="actions">${organizer ? `<button class="btn btn-primary btn-sm" type="button" data-follow="${esc(organizer.id)}" hidden>${icon("bell")}${esc(t.follow(organizer.name))}</button>` : ""}${active.length ? `<a class="btn btn-ghost btn-sm" href="${esc(clearAll)}">${esc(t.clearAll)}</a>` : past ? "" : `<a class="btn btn-ghost btn-sm" href="${esc(`${home}#evenements`)}">${esc(t.showAll)}</a>`}</div>
          </div>` : ""}
        ${cities.length > 1 && !filtered ? `<nav class="chips" aria-label="${esc(t.citiesTitle)}">${cities.map((c) => `<a class="chip" href="${esc(link({ ville: c }))}">${icon("pin")}${esc(c)}</a>`).join("")}</nav>` : ""}
        ${!all.length && !past
          ? ended.length
            // Run 106: nothing on sale, but past events to show: say so, and lead to them.
            ? `<div class="empty reveal">
              <div class="empty-art" aria-hidden="true">${logoMark("lg-empty")}</div>
              <p class="empty-title">${esc(t.emptyUpcoming)}</p>
              <p>${esc(t.emptyUpcomingLead)}</p>
              <div class="actions"><a class="btn btn-primary" href="${esc(refine({ periode: "passes", quand: "", prix: "", tri: "", vue: "" }))}">${esc(t.seePast(ended.length))}</a><a class="btn btn-ghost" href="https://takatak.ca/register">${esc(t.signup)}</a></div>
            </div>`
            : `<div class="empty reveal">
              <div class="empty-art" aria-hidden="true">${logoMark("lg-empty")}</div>
              <p class="empty-title">${esc(t.empty)}</p>
              <p>${esc(t.emptyLead)}</p>
              <div class="actions"><a class="btn btn-primary" href="https://takatak.ca/register">${esc(t.signup)}</a><a class="btn btn-ghost" href="/ops">${esc(t.signin)}</a></div>
            </div>`
          : ask.view === "agenda"
            ? agendaRows.length ? agenda() : `<p class="empty-inline">${esc(t.noResults)}</p>`
          : filtered
            ? shown.length ? `<div class="grid">${shown.map((c, i) => card(c, past && i < 3)).join("")}</div>` : `<p class="empty-inline">${esc(past ? t.noPast : ask.deals ? t.noDeals : t.noResults)}</p>`
            : `${rail("recent", t.recentTitle, "", [], `<button class="link-btn" type="button" data-recent-clear aria-label="${esc(t.clearRecentLabel)}">${esc(t.clearRecent)}</button>`).replace('<div class="rail-block">', '<div class="rail-block" data-recent hidden>')}
               ${week.length && all.length > 3 ? `${rail("week", t.weekTitle, "", week)}<h3 class="grid-title">${esc(t.allEvents)}</h3>` : ""}
               <div class="grid">${all.map((c, i) => card(c, i < 3)).join("")}</div>`}
      </div>
    </section>

    <section class="section how" id="comment" aria-labelledby="how-title">
      <div class="wrap">
        <div class="section-head reveal"><p class="kicker">${esc(t.nav.how)}</p><h2 id="how-title">${esc(t.howTitle)}</h2><p>${esc(t.howLead)}</p></div>
        <ol class="steps">
          ${t.steps.map((s, i) => `<li class="step reveal"><span class="step-n" aria-hidden="true">${i + 1}</span>${icon(["ticket", "lock", "offline"][i]!)}<h3>${esc(s.title)}</h3><p>${esc(s.text)}</p></li>`).join("")}
        </ol>
      </div>
    </section>

    <section class="section why" aria-labelledby="why-title">
      <div class="wrap">
        <div class="section-head reveal"><h2 id="why-title">${esc(t.whyTitle)}</h2></div>
        <div class="features">
          ${t.why.map((f) => `<div class="feature reveal">${icon(f.icon)}<h3>${esc(f.title)}</h3><p>${esc(f.text)}</p></div>`).join("")}
        </div>
      </div>
    </section>

    <section class="org" id="organisateurs" aria-labelledby="org-title">
      <img class="org-bg" src="${esc(asset("img/band-organizers.webp"))}" alt="" loading="lazy" decoding="async" />
      <div class="wrap org-row">
        <div class="org-copy reveal">
          <p class="kicker">${esc(t.orgEyebrow)}</p>
          <h2 id="org-title">${esc(t.orgTitle)}</h2>
          <p class="lead">${esc(t.orgLead)}</p>
          <ul class="checks">${t.orgFeatures.map((f) => `<li>${icon("check")}<span>${esc(f)}</span></li>`).join("")}</ul>
          <div class="actions"><a class="btn btn-primary" href="https://takatak.ca/register">${esc(t.signup)}${icon("arrow")}</a><a class="btn btn-ghost" href="/ops">${esc(t.signin)}</a></div>
        </div>
        <div class="device reveal" role="img" aria-label="${esc(t.orgShot)}">
          <div class="device-bar"><span></span><span></span><span></span></div>
          <div class="device-body">
            <div class="device-side">${["chart", "ticket", "calendar", "users", "megaphone", "door"].map((n) => icon(n)).join("")}</div>
            <div class="device-main">
              <div class="tiles"><i></i><i></i><i></i></div>
              <div class="bars">${[38, 62, 48, 80, 66, 92, 74].map((h) => `<i class="h${h}"></i>`).join("")}</div>
              <div class="rows"><i></i><i></i><i></i></div>
            </div>
            <div class="device-ticket">${logoMark("lg-device")}<div class="qr">${Array.from({ length: 25 }, (_, i) => `<i${[0, 1, 2, 4, 5, 6, 8, 10, 12, 14, 16, 18, 19, 20, 22, 24].includes(i) ? ' class="on"' : ""}></i>`).join("")}</div></div>
          </div>
        </div>
      </div>
    </section>

${toolsSection(t)}

${takatakSection(t)}

    <section class="section faq" id="aide" aria-labelledby="faq-title">
      <div class="wrap faq-row">
        <div class="section-head reveal"><p class="kicker">${esc(t.nav.help)}</p><h2 id="faq-title">${esc(t.faqTitle)}</h2><p>${esc(t.faqLead)}</p>
          <button class="btn btn-primary" type="button" data-open-assistant hidden>${icon("chat")}${esc(t.askAssistant)}</button></div>
        <div class="qa">
          ${faq.map((f, i) => `<details class="reveal" id="faq-${esc(f.id)}"${i === 0 ? " open" : ""}><summary>${esc(f.q)}${icon("right", "i chev")}</summary><p>${esc(f.a)}</p></details>`).join("")}
        </div>
      </div>
    </section>
  </main>

${siteFooter(frame)}

  <a class="to-top" href="#contenu" aria-label="${esc(t.backToTop)}" data-to-top hidden>${icon("up")}</a>

  <dialog class="sheet" id="dlg-tickets" aria-labelledby="dlg-tickets-title">
    <div class="sheet-head"><h2 id="dlg-tickets-title">${icon("ticket")}${esc(t.ticketsModal.title)}</h2><button class="round" type="button" data-close aria-label="${esc(t.close)}">${icon("close")}</button></div>
    <ol class="sheet-steps">${t.ticketsModal.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
  </dialog>

${previewDialog(t)}

  <dialog class="sheet" id="dlg-follow" aria-labelledby="dlg-follow-title">
    <div class="sheet-head"><h2 id="dlg-follow-title">${icon("bell")}<span data-f-title></span></h2><button class="round" type="button" data-close aria-label="${esc(t.close)}">${icon("close")}</button></div>
    <form class="follow-form" data-follow-form>
      <p data-f-lead></p>
      <label class="input"><span>${esc(t.followEmail)}</span><input name="email" type="email" required maxlength="320" autocomplete="email" inputmode="email" /></label>
      <label class="input"><span>${esc(t.followName)}</span><input name="firstName" type="text" maxlength="120" autocomplete="given-name" /></label>
      <p class="follow-note" data-f-note></p>
      <p class="follow-error" role="alert" data-f-error hidden></p>
      <button class="btn btn-primary" type="submit">${icon("bell")}${esc(t.followSubmit)}</button>
    </form>
    <p class="follow-done" role="status" tabindex="-1" data-f-done hidden></p>
  </dialog>

  <dialog class="palette" id="dlg-search" aria-labelledby="dlg-search-title">
    <h2 class="sr-only" id="dlg-search-title">${esc(t.searchDialog.title)}</h2>
    <form class="palette-bar" action="/#evenements" method="get" role="search">
      ${lang === "en" ? '<input type="hidden" name="lang" value="en" />' : ""}
      ${icon("search")}<input name="q" type="search" placeholder="${esc(t.searchDialog.hint)}" aria-label="${esc(t.searchDialog.hint)}" autocomplete="off" maxlength="80" data-palette-input />
      <button class="round" type="button" data-close aria-label="${esc(t.close)}">${icon("close")}</button>
    </form>
    <div class="palette-results" data-palette-results aria-live="polite"></div>
  </dialog>

  <div class="toast" data-lang-toast hidden role="status">
    ${icon("globe")}<span lang="${COPY[t.other].lang}">${esc(t.langToast.text)}</span>
    <a class="btn btn-primary btn-sm" href="${esc(otherHome)}" lang="${COPY[t.other].lang}">${esc(t.langToast.action)}</a>
    <button class="btn btn-ghost btn-sm" type="button" data-toast-close lang="${COPY[t.other].lang}">${esc(t.langToast.dismiss)}</button>
  </div>

  <button class="assistant-fab" type="button" data-open-assistant aria-label="${esc(t.assistant.open)}" aria-expanded="false" aria-controls="assistant" hidden>${icon("chat")}<span>${esc(t.assistant.title)}</span></button>
  <section class="assistant" id="assistant" aria-labelledby="assistant-title" hidden>
    <div class="assistant-head">
      <span class="assistant-avatar" aria-hidden="true">${icon("chat")}</span>
      <div><h2 id="assistant-title">${esc(t.assistant.title)}</h2><p>${esc(t.assistant.subtitle)}</p></div>
      <button class="round" type="button" data-close-assistant aria-label="${esc(t.close)}">${icon("close")}</button>
    </div>
    <div class="assistant-log" data-log role="log" aria-live="polite"></div>
    <div class="assistant-chips" data-chips></div>
    <form class="assistant-form" data-ask>
      <label class="sr-only" for="assistant-input">${esc(t.assistant.placeholder)}</label>
      <input id="assistant-input" type="text" maxlength="200" autocomplete="off" placeholder="${esc(t.assistant.placeholder)}" />
      <button class="round round-primary" type="submit" aria-label="${esc(t.assistant.send)}">${icon("send")}</button>
    </form>
    <p class="assistant-note">${esc(t.assistant.note)}</p>
  </section>

  <script type="application/json" id="alkao-data">${inertJson(data)}</script>
  <script src="${esc(asset("home.js"))}" defer></script>
</body>
</html>`;
}

/** Run 67: `/accessibilite`, what ALKAO does for accessibility, in the home's look. */
export function renderAccessibility({ origin, lang, now, asset }: Pick<RenderOptions, "origin" | "lang" | "now" | "asset">): string {
  const t = COPY[lang];
  const a = t.a11y;
  const path = (l: Lang) => `/accessibilite${l === "en" ? "?lang=en" : ""}`;
  const home = `/${lang === "en" ? "?lang=en" : ""}`;
  const year = Number(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric" }).format(now));
  const frame: Frame = { t, lang, base: home, home, here: path(lang), otherHere: path(t.other), year };
  const url = (l: Lang) => absolute(origin, path(l));
  return `<!doctype html>
<html lang="${t.lang}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>${esc(a.title)}</title>
  <meta name="description" content="${esc(a.description)}" />
  ${origin ? `<link rel="canonical" href="${esc(url(lang))}" />
  <link rel="alternate" hreflang="fr-CA" href="${esc(url("fr"))}" />
  <link rel="alternate" hreflang="en-CA" href="${esc(url("en"))}" />` : ""}
  <meta name="theme-color" content="#060D1F" />
${headAssets(asset)}
</head>
<body class="page">
  <a class="skip" href="#contenu">${esc(t.skip)}</a>
  <div class="aurora" aria-hidden="true"><span></span><span></span><span></span></div>
${siteHeader(frame)}
  <main id="contenu" class="page-main">
    <div class="wrap narrow">
      <p class="kicker">ALKAO</p>
      <h1>${esc(a.h1)}</h1>
      <p class="lead">${esc(a.lead)}</p>
      <section aria-labelledby="a11y-do"><h2 id="a11y-do">${esc(a.doTitle)}</h2>
        <ul class="checks">${a.does.map((d) => `<li>${icon("check")}<span>${esc(d)}</span></li>`).join("")}</ul>
      </section>
      <section aria-labelledby="a11y-venue"><h2 id="a11y-venue">${esc(a.venueTitle)}</h2><p>${esc(a.venue)}</p></section>
      <section aria-labelledby="a11y-issue"><h2 id="a11y-issue">${esc(a.issueTitle)}</h2><p>${esc(a.issue)}</p>
        <p><a class="btn btn-primary" href="https://takatak.ca">${esc(a.issueLink)}${icon("arrow")}</a></p>
      </section>
      <p class="muted">${esc(a.reviewed)}</p>
    </div>
  </main>
${siteFooter(frame)}
  <script src="${esc(asset("home.js"))}" defer></script>
</body>
</html>`;
}
