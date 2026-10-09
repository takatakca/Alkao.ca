import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hono } from "hono";
import { isUuid } from "../domain/ids.js";

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "shop-ui");
const require = createRequire(import.meta.url);
const JS = "text/javascript; charset=utf-8";

const FILES: Record<string, { path: string; type: string }> = {
  "app.js": { path: join(UI_DIR, "app.js"), type: JS },
  "styles.css": { path: join(UI_DIR, "styles.css"), type: "text/css; charset=utf-8" },
  "i18n.js": { path: join(UI_DIR, "i18n.js"), type: JS },
  "vendor/htm-preact.js": { path: join(dirname(require.resolve("htm")), "..", "preact", "standalone.mjs"), type: JS },
};

const HEADERS = (type: string) => ({
  "content-type": type,
  "content-security-policy": [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    // Run 50: the Brand's logo and the event's photo are https addresses it sets in /ops.
    "img-src 'self' data: https:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; "),
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "cache-control": "no-cache",
});

/** Run 53: what a shared link shows (Facebook, Instagram, Messenger, texts). */
export interface ShopPreview {
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  brandName: string | null;
  place: string | null;
}

const attr = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const httpsOnly = (u: string | null) => (u && /^https:\/\/[^\s"'<>\\]+$/.test(u) && u.length <= 500 ? u : null);

/** The page's title and Open Graph tags for a published event (or the Brand's list of events). */
export function previewHead(p: ShopPreview, pageUrl: string | null): string {
  const title = [p.title, p.brandName].filter(Boolean).join(" — ") || "Billetterie";
  const description = (p.description?.trim() || [p.place, "Billets en ligne"].filter(Boolean).join(" · ")).replace(/\s+/g, " ").slice(0, 200);
  const image = httpsOnly(p.imageUrl);
  const tags = [
    `<title>${attr(title)}</title>`,
    `<meta name="description" content="${attr(description)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:title" content="${attr(title)}" />`,
    `<meta property="og:description" content="${attr(description)}" />`,
    `<meta property="og:locale" content="fr_CA" />`,
    ...(p.brandName ? [`<meta property="og:site_name" content="${attr(p.brandName)}" />`] : []),
    ...(pageUrl ? [`<meta property="og:url" content="${attr(pageUrl)}" />`] : []),
    ...(image ? [`<meta property="og:image" content="${attr(image)}" />`] : []),
    `<meta name="twitter:card" content="${image ? "summary_large_image" : "summary"}" />`,
  ];
  return tags.join("\n    ");
}

/**
 * The hosted ticket shop (Run 08): a Brand sells with a plain link, no website change.
 * Static files only; every price, rule and seat comes from the public, gated API. Run 53:
 * the page's head names the event, so a shared link shows its title and photo.
 */
export function mountShopUi(
  app: Hono<any>,
  cfg: {
    publicUrl: string | null;
    paymentsMode?: "test" | "live" | null;
    preview?: (clientId: string, brandId: string, eventId: string | null) => Promise<ShopPreview | null>;
  },
): void {
  const cache = new Map<string, string>();
  const read = (path: string) => {
    if (!cache.has(path)) cache.set(path, readFileSync(path, "utf8"));
    return cache.get(path)!;
  };
  const page = (ids: (string | undefined)[]) => (ids.every((id) => id && isUuid(id)) ? read(join(UI_DIR, "index.html")) : null);
  app.get("/acheter/merci/:clientId/:brandId/:holdId", (c) => {
    const body = page([c.req.param("clientId"), c.req.param("brandId"), c.req.param("holdId")]);
    return body === null ? c.notFound() : c.body(body, 200, HEADERS("text/html; charset=utf-8"));
  });
  // Run 53: the shared page names the event; anything unknown, unpublished or closed keeps
  // the plain page, which reveals nothing.
  const withPreview = async (body: string, path: string, clientId: string, brandId: string, eventId: string | null) => {
    if (!cfg.preview) return body;
    let p: ShopPreview | null = null;
    try {
      p = await cfg.preview(clientId, brandId, eventId);
    } catch {
      p = null;
    }
    if (!p) return body;
    const pageUrl = cfg.publicUrl ? `${new URL(cfg.publicUrl).origin}${path}` : null;
    const head = previewHead(p, pageUrl);
    // A function, so "$&" or "$1" in a title stays text.
    return body.replace(/<title>[^<]*<\/title>/, () => head);
  };
  app.get("/acheter/:clientId/:brandId/:eventId", async (c) => {
    const [clientId, brandId, eventId] = [c.req.param("clientId"), c.req.param("brandId"), c.req.param("eventId")];
    const body = page([clientId, brandId, eventId]);
    if (body === null) return c.notFound();
    return c.body(await withPreview(body, c.req.path, clientId, brandId, eventId), 200, HEADERS("text/html; charset=utf-8"));
  });
  app.get("/acheter/:clientId/:brandId", async (c) => {
    const [clientId, brandId] = [c.req.param("clientId"), c.req.param("brandId")];
    const body = page([clientId, brandId]);
    if (body === null) return c.notFound();
    return c.body(await withPreview(body, c.req.path, clientId, brandId, null), 200, HEADERS("text/html; charset=utf-8"));
  });
  // Run 12: the button for Brand websites. Loaded cross-origin by a <script> tag.
  app.get("/widget.js", (c) =>
    c.body(read(join(UI_DIR, "..", "widget", "widget.js")), 200, {
      "content-type": "text/javascript; charset=utf-8",
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "cross-origin",
      "cache-control": "public, max-age=300",
    }),
  );
  // Run 32: paymentsMode only when payments are configured; "test" shows a banner to buyers.
  app.get("/shop/config.json", (c) => c.body(JSON.stringify({
    publicUrl: cfg.publicUrl ? new URL(cfg.publicUrl).origin : null,
    ...(cfg.paymentsMode ? { paymentsMode: cfg.paymentsMode } : {}),
  }), 200, HEADERS("application/json")));
  for (const [name, file] of Object.entries(FILES)) {
    app.get(`/shop/${name}`, (c) => c.body(read(file.path), 200, HEADERS(file.type)));
  }
}
