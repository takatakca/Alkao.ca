import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hono } from "hono";
import { parseQuery, renderAccessibility, renderHome, type HomeBrand } from "./home-view.js";
import { publicVenues, renderVenueDirectory, renderVenuePage, venuePath } from "./venue-view.js";

export type { HomeBrand, HomeEvent } from "./home-view.js";

export interface HomeConfig {
  publicUrl: string | null;
  /** White-label installs may send / to their own HTTPS homepage. */
  homeUrl: string | null;
  load: () => Promise<HomeBrand[]>;
  now?: () => Date;
}

// Run 64: the home's own files (home-ui/): style, script, photos and fonts, read once. Each URL
// carries a hash of its content, so a browser keeps a file until it changes.
const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "home-ui");
const TYPES: Record<string, string> = {
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  svg: "image/svg+xml",
  webp: "image/webp",
  woff2: "font/woff2",
  // Run 66: the app icons and the manifest that makes the home installable.
  png: "image/png",
  webmanifest: "application/manifest+json",
};

interface Asset { body: Buffer; type: string; version: string }
const ASSETS = new Map<string, Asset>();
for (const dir of ["", "img", "fonts"]) {
  for (const file of readdirSync(join(UI_DIR, dir))) {
    const type = TYPES[file.split(".").pop() ?? ""];
    if (!type) continue;
    const body = readFileSync(join(UI_DIR, dir, file));
    ASSETS.set(dir ? `${dir}/${file}` : file, { body, type, version: createHash("sha256").update(body).digest("hex").slice(0, 10) });
  }
}

export const homeAsset = (name: string) => {
  const a = ASSETS.get(name);
  if (!a) throw new Error(`missing home asset ${name}`);
  return `/assets/home/${name}?v=${a.version}`;
};

const PAGE_HEADERS = {
  "content-security-policy": [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    // Organizers' event photos and logos are https addresses they set in /ops.
    "img-src 'self' https: data:",
    "font-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; "),
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "cache-control": "public, max-age=60, stale-while-revalidate=300",
};

export function mountHome(app: Hono<any>, cfg: HomeConfig): void {
  app.get("/", async (c) => {
    if (cfg.homeUrl) return c.redirect(cfg.homeUrl, 302);
    const lang = c.req.query("lang") === "en" ? "en" : "fr";
    const brands = await cfg.load();
    const html = renderHome({
      origin: cfg.publicUrl ? new URL(cfg.publicUrl).origin : null,
      lang,
      brands,
      query: parseQuery((name) => c.req.query(name)),
      now: cfg.now?.() ?? new Date(),
      asset: homeAsset,
    });
    return c.html(html, 200, PAGE_HEADERS);
  });

  // Run 73: venue discovery uses only already-gated, opted-in events. White-label domains
  // do not expose the ALKAO directory. Unknown venues never reveal a private catalog.
  app.get("/salles", async (c) => {
    if (cfg.homeUrl) return c.json({ error: { code: "not_found" } }, 404);
    const lang = c.req.query("lang") === "en" ? "en" : "fr";
    const html = renderVenueDirectory({
      origin: cfg.publicUrl ? new URL(cfg.publicUrl).origin : null,
      lang, venues: publicVenues(await cfg.load()), now: cfg.now?.() ?? new Date(), asset: homeAsset,
    });
    return c.html(html, 200, PAGE_HEADERS);
  });
  app.get("/salles/:clientId/:brandId/:venueId", async (c) => {
    if (cfg.homeUrl) return c.json({ error: { code: "not_found" } }, 404);
    const id = [c.req.param("clientId"), c.req.param("brandId"), c.req.param("venueId")];
    if (!id.every((value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value ?? "")))
      return c.json({ error: { code: "not_found" } }, 404);
    const venue = publicVenues(await cfg.load()).find((v) =>
      v.clientId === id[0]!.toLowerCase() && v.brandId === id[1]!.toLowerCase() && v.venueId === id[2]!.toLowerCase());
    if (!venue) return c.json({ error: { code: "not_found" } }, 404);
    const html = renderVenuePage({
      origin: cfg.publicUrl ? new URL(cfg.publicUrl).origin : null,
      lang: c.req.query("lang") === "en" ? "en" : "fr",
      venue, now: cfg.now?.() ?? new Date(), asset: homeAsset,
    });
    return c.html(html, 200, PAGE_HEADERS);
  });

  // Run 67: what ALKAO does for accessibility (no data, same look and policy as the home).
  app.get("/accessibilite", (c) => {
    const lang = c.req.query("lang") === "en" ? "en" : "fr";
    const html = renderAccessibility({
      origin: cfg.publicUrl ? new URL(cfg.publicUrl).origin : null,
      lang,
      now: cfg.now?.() ?? new Date(),
      asset: homeAsset,
    });
    return c.html(html, 200, PAGE_HEADERS);
  });

  // Run 68: what search engines may read, and the list of pages they should know.
  app.get("/robots.txt", (c) => {
    const origin = cfg.publicUrl ? new URL(cfg.publicUrl).origin : null;
    const lines = [
      "User-agent: *",
      "Allow: /",
      // Organizers' space, buyers' tickets, the API and e-mail links: nothing to index.
      "Disallow: /ops",
      "Disallow: /billets",
      "Disallow: /v1/",
      "Disallow: /inscription",
      "Disallow: /desabonnement",
      "Disallow: /acheter/merci/",
      ...(origin ? [`Sitemap: ${origin}/sitemap.xml`] : []),
    ];
    return c.body(`${lines.join("\n")}\n`, 200, { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" });
  });

  app.get("/sitemap.xml", async (c) => {
    if (!cfg.publicUrl) return c.json({ error: { code: "not_found" } }, 404);
    const origin = new URL(cfg.publicUrl).origin;
    const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    // A page in both languages, each pointing at the other.
    const pair = (path: string) => {
      const fr = `${origin}${path}`;
      const en = `${origin}${path}?lang=en`;
      const alt = `<xhtml:link rel="alternate" hreflang="fr-CA" href="${xml(fr)}"/><xhtml:link rel="alternate" hreflang="en-CA" href="${xml(en)}"/>`;
      return [`<url><loc>${xml(fr)}</loc>${alt}</url>`, `<url><loc>${xml(en)}</loc>${alt}</url>`];
    };
    // Only what the home lists: opted-in Brands with Ticketing active and dates on sale.
    const listed = await cfg.load();
    const shops = listed.flatMap((b) => b.events.map((e) => `<url><loc>${xml(`${origin}${e.shopPath}`)}</loc></url>`));
    const venuePages = cfg.homeUrl ? [] : publicVenues(listed).flatMap((venue) => pair(venuePath(venue)));
    const body = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
      ...(cfg.homeUrl ? [] : pair("/")),
      ...pair("/accessibilite"),
      ...(venuePages.length ? pair("/salles") : []),
      ...venuePages,
      ...shops,
      "</urlset>",
    ].join("\n");
    return c.body(`${body}\n`, 200, { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=600", "x-content-type-options": "nosniff" });
  });

  app.get("/assets/home/*", (c) => {
    const name = c.req.path.slice("/assets/home/".length);
    const a = ASSETS.get(name);
    if (!a) return c.json({ error: { code: "not_found" } }, 404);
    return c.body(new Uint8Array(a.body), 200, {
      "content-type": a.type,
      "x-content-type-options": "nosniff",
      "cache-control": c.req.query("v") === a.version ? "public, max-age=31536000, immutable" : "public, max-age=300",
    });
  });
}
