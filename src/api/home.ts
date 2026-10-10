import type { Hono } from "hono";

export interface HomeEvent {
  id: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  venueName: string | null;
  venueCity: string | null;
  startsAt: Date | string;
  shopPath: string;
}

export interface HomeBrand {
  clientId: string;
  brandId: string;
  name: string;
  logoUrl: string | null;
  events: HomeEvent[];
}

export interface HomeConfig {
  publicUrl: string | null;
  /** White-label installs may send / to their own HTTPS homepage. */
  homeUrl: string | null;
  load: () => Promise<HomeBrand[]>;
}

const esc = (value: unknown) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const safeHttps = (value: string | null) =>
  value && /^https:\/\/[^\s"'<>\\]+$/.test(value) && value.length <= 500 ? value : null;

const absolute = (origin: string | null, path: string) => {
  if (!origin) return path;
  try {
    return new URL(path, origin).toString();
  } catch {
    return path;
  }
};

const copy = {
  fr: {
    lang: "fr-CA",
    title: "ALKAO — Billetterie simple pour vos événements",
    description: "Découvrez des événements vendus avec ALKAO, la plateforme de billetterie de GROUPE TAKATAK.",
    eyebrow: "GROUPE TAKATAK · TICKET HUB",
    hero: "Vos événements. Vos clients. Une billetterie qui suit.",
    intro: "ALKAO aide les organisateurs à vendre, livrer et contrôler leurs billets dans une plateforme indépendante, sécurisée et conçue au Québec.",
    discover: "Événements en vente",
    empty: "Aucun organisateur n’affiche d’événement sur ALKAO pour le moment.",
    from: "À partir du",
    buy: "Voir les billets",
    organizer: "Vous organisez des événements?",
    organizerText: "Créez votre espace ALKAO ou connectez-vous pour gérer vos événements, ventes et accès.",
    signup: "Créer mon espace",
    signin: "Connexion organisateur",
    english: "English",
  },
  en: {
    lang: "en-CA",
    title: "ALKAO — Simple ticketing for your events",
    description: "Discover events sold with ALKAO, GROUPE TAKATAK's ticketing platform.",
    eyebrow: "GROUPE TAKATAK · TICKET HUB",
    hero: "Your events. Your customers. Ticketing that keeps up.",
    intro: "ALKAO helps organizers sell, deliver and control tickets with an independent, secure platform built in Quebec.",
    discover: "Events on sale",
    empty: "No organizer is currently displaying events on ALKAO.",
    from: "Starting",
    buy: "View tickets",
    organizer: "Organizing an event?",
    organizerText: "Create your ALKAO space or sign in to manage events, sales and access.",
    signup: "Create my space",
    signin: "Organizer sign in",
    english: "Français",
  },
} as const;

function render(cfg: HomeConfig, brands: HomeBrand[], lang: "fr" | "en") {
  const t = copy[lang];
  const origin = cfg.publicUrl ? new URL(cfg.publicUrl).origin : null;
  const canonical = origin ? `${origin}/` : null;
  const alternate = origin ? `${origin}/?lang=${lang === "fr" ? "en" : "fr"}` : `/?lang=${lang === "fr" ? "en" : "fr"}`;
  const events = brands.flatMap((b) => b.events.map((e) => ({ ...e, brand: b })));
  const jsonLd = events.map((e) => ({
    "@context": "https://schema.org",
    "@type": "Event",
    name: e.title,
    startDate: new Date(e.startsAt).toISOString(),
    eventStatus: "https://schema.org/EventScheduled",
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
    ...(safeHttps(e.imageUrl) ? { image: [e.imageUrl] } : {}),
    location: {
      "@type": "Place",
      name: e.venueName ?? e.brand.name,
      ...(e.venueCity ? { address: { "@type": "PostalAddress", addressLocality: e.venueCity, addressCountry: "CA" } } : {}),
    },
    organizer: { "@type": "Organization", name: e.brand.name },
    url: absolute(origin, e.shopPath),
  }));
  const cards = events
    .map((e) => {
      const image = safeHttps(e.imageUrl) ?? safeHttps(e.brand.logoUrl);
      const date = new Intl.DateTimeFormat(lang === "fr" ? "fr-CA" : "en-CA", {
        dateStyle: "full", timeStyle: "short", timeZone: "America/Toronto",
      }).format(new Date(e.startsAt));
      return `<article class="event-card">
        ${image ? `<img src="${esc(image)}" alt="" loading="lazy" />` : `<div class="event-art" aria-hidden="true">ALKAO</div>`}
        <div class="event-copy">
          <p class="brand">${esc(e.brand.name)}</p>
          <h3>${esc(e.title)}</h3>
          ${e.description ? `<p class="description">${esc(e.description)}</p>` : ""}
          <p class="date"><span>${esc(t.from)}</span> ${esc(date)}</p>
          <p class="place">${esc([e.venueName, e.venueCity].filter(Boolean).join(" · "))}</p>
          <a class="button" href="${esc(e.shopPath)}">${esc(t.buy)}</a>
        </div>
      </article>`;
    })
    .join("");

  return `<!doctype html>
<html lang="${t.lang}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(t.title)}</title>
  <meta name="description" content="${esc(t.description)}" />
  ${canonical ? `<link rel="canonical" href="${esc(canonical)}" />
  <link rel="alternate" hreflang="fr-CA" href="${esc(canonical)}" />
  <link rel="alternate" hreflang="en-CA" href="${esc(`${canonical}?lang=en`)}" />
  <link rel="alternate" hreflang="x-default" href="${esc(canonical)}" />` : ""}
  <meta property="og:type" content="website" />
  <meta property="og:title" content="${esc(t.title)}" />
  <meta property="og:description" content="${esc(t.description)}" />
  ${canonical ? `<meta property="og:url" content="${esc(canonical)}" />` : ""}
  <meta name="theme-color" content="#060D1F" />
  ${jsonLd.length ? `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, "\\u003c")}</script>` : ""}
  <style>
    :root{color-scheme:dark;--navy:#060D1F;--midnight:#0B1B3D;--blue:#1F8BFF;--cyan:#29C3FF;--white:#F5F8FC;--silver:#B8C4D3}
    *{box-sizing:border-box}body{margin:0;background:var(--navy);color:var(--white);font-family:Inter,Montserrat,system-ui,-apple-system,sans-serif;line-height:1.55}
    a{color:inherit}.wrap{width:min(1160px,calc(100% - 32px));margin:auto}.top{display:flex;align-items:center;justify-content:space-between;padding:22px 0}
    .logo{font-weight:900;letter-spacing:.08em}.logo b{color:var(--cyan)}.lang{color:var(--silver);font-weight:700}
    .hero{padding:72px 0 62px;background:radial-gradient(circle at 80% 15%,#1f8bff33,transparent 36%),linear-gradient(180deg,#071633 0,var(--navy) 100%)}
    .eyebrow,.brand{color:var(--cyan);text-transform:uppercase;letter-spacing:.15em;font-weight:800;font-size:.78rem}
    h1{font-size:clamp(2.4rem,7vw,5rem);max-width:900px;line-height:1.02;margin:.15em 0}.lead{color:var(--silver);font-size:1.15rem;max-width:760px}
    section{padding:54px 0}h2{font-size:clamp(1.7rem,4vw,2.6rem);margin:0 0 28px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:20px}
    .event-card{overflow:hidden;border:1px solid #ffffff1d;border-radius:18px;background:var(--midnight);box-shadow:0 18px 60px #0004}
    .event-card img,.event-art{width:100%;aspect-ratio:16/9;object-fit:cover}.event-art{display:grid;place-items:center;background:linear-gradient(135deg,#0b1b3d,#1565d8);font-weight:900;font-size:2rem;letter-spacing:.15em}
    .event-copy{padding:22px}.event-copy h3{font-size:1.35rem;margin:.15rem 0 .65rem}.description,.date,.place{color:var(--silver)}.date span{color:var(--white);font-weight:700}
    .button{display:inline-flex;margin-top:10px;padding:11px 17px;border-radius:10px;background:#1565D8;color:white;text-decoration:none;font-weight:800}
    .button:hover,.button:focus-visible{background:#1F8BFF;outline:3px solid #29C3FF66;outline-offset:2px}
    .organizer{border-block:1px solid #ffffff1a;background:#0B1B3D}.organizer .row{display:flex;gap:22px;align-items:center;justify-content:space-between;flex-wrap:wrap}
    .actions{display:flex;gap:12px;flex-wrap:wrap}.secondary{background:transparent;border:1px solid #5b739b}
    footer{padding:32px 0;color:var(--silver);font-size:.9rem}@media(max-width:640px){.hero{padding:52px 0 40px}.top{padding:16px 0}}
  </style>
</head>
<body>
  <header class="wrap top"><div class="logo">ALKAO <b>●</b></div><a class="lang" href="${esc(alternate)}" lang="${lang === "fr" ? "en-CA" : "fr-CA"}">${esc(t.english)}</a></header>
  <main>
    <section class="hero"><div class="wrap"><p class="eyebrow">${esc(t.eyebrow)}</p><h1>${esc(t.hero)}</h1><p class="lead">${esc(t.intro)}</p></div></section>
    <section class="wrap" aria-labelledby="events-title"><h2 id="events-title">${esc(t.discover)}</h2>
      ${cards ? `<div class="grid">${cards}</div>` : `<p class="lead">${esc(t.empty)}</p>`}
    </section>
    <section class="organizer"><div class="wrap row"><div><h2>${esc(t.organizer)}</h2><p class="lead">${esc(t.organizerText)}</p></div>
      <div class="actions"><a class="button" href="https://takatak.ca">${esc(t.signup)}</a><a class="button secondary" href="/ops">${esc(t.signin)}</a></div>
    </div></section>
  </main>
  <footer class="wrap">ALKAO · GROUPE TAKATAK · Digital Solutions. Real Results.</footer>
</body>
</html>`;
}

export function mountHome(app: Hono<any>, cfg: HomeConfig): void {
  app.get("/", async (c) => {
    if (cfg.homeUrl) return c.redirect(cfg.homeUrl, 302);
    const lang = c.req.query("lang") === "en" ? "en" : "fr";
    const brands = await cfg.load();
    return c.html(render(cfg, brands, lang), 200, {
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
      "permissions-policy": "camera=(), microphone=(), geolocation=()",
      "cache-control": "public, max-age=60, stale-while-revalidate=300",
    });
  });
}
