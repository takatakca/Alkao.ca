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
    "img-src 'self' data:",
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

/**
 * The hosted ticket shop (Run 08): a Brand sells with a plain link, no website change.
 * Static files only; every price, rule and seat comes from the public, gated API.
 */
export function mountShopUi(app: Hono<any>, cfg: { publicUrl: string | null }): void {
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
  app.get("/acheter/:clientId/:brandId/:eventId", (c) => {
    const body = page([c.req.param("clientId"), c.req.param("brandId"), c.req.param("eventId")]);
    return body === null ? c.notFound() : c.body(body, 200, HEADERS("text/html; charset=utf-8"));
  });
  app.get("/acheter/:clientId/:brandId", (c) => {
    const body = page([c.req.param("clientId"), c.req.param("brandId")]);
    return body === null ? c.notFound() : c.body(body, 200, HEADERS("text/html; charset=utf-8"));
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
  app.get("/shop/config.json", (c) => c.body(JSON.stringify({ publicUrl: cfg.publicUrl ? new URL(cfg.publicUrl).origin : null }), 200, HEADERS("application/json")));
  for (const [name, file] of Object.entries(FILES)) {
    app.get(`/shop/${name}`, (c) => c.body(read(file.path), 200, HEADERS(file.type)));
  }
}
