import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hono } from "hono";

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "buyer-ui");
const require = createRequire(import.meta.url);
const JS = "text/javascript; charset=utf-8";

const FILES: Record<string, { path: string; type: string }> = {
  "app.js": { path: join(UI_DIR, "app.js"), type: JS },
  "styles.css": { path: join(UI_DIR, "styles.css"), type: "text/css; charset=utf-8" },
  "i18n.js": { path: join(UI_DIR, "i18n.js"), type: JS },
  "vendor/htm-preact.js": { path: join(dirname(require.resolve("htm")), "..", "preact", "standalone.mjs"), type: JS },
  "vendor/qrcode.mjs": { path: join(dirname(require.resolve("qrcode-generator")), "qrcode.mjs"), type: JS },
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
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "cache-control": "no-cache",
  "x-robots-tag": "noindex, nofollow",
});

/**
 * The buyer's tickets page (Run 06): `/billets#c=…&b=…&o=…&k=…`, the link in the tickets
 * email. Static files only; the order is read through the public, gated API with the
 * token from the URL fragment, which browsers never send to the server.
 */
export function mountBuyerUi(app: Hono<any>): void {
  const cache = new Map<string, string>();
  const read = (path: string) => {
    if (!cache.has(path)) cache.set(path, readFileSync(path, "utf8"));
    return cache.get(path)!;
  };
  app.get("/billets", (c) => c.body(read(join(UI_DIR, "index.html")), 200, HEADERS("text/html; charset=utf-8")));
  for (const [name, file] of Object.entries(FILES)) {
    app.get(`/billets/${name}`, (c) => c.body(read(file.path), 200, HEADERS(file.type)));
  }
}
