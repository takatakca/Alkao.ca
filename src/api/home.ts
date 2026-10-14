import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hono } from "hono";
import { parseQuery, renderAccessibility, renderHome, type HomeBrand } from "./home-view.js";

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
