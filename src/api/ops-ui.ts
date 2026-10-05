import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hono } from "hono";

export interface OpsUiConfig {
  supabaseUrl: string | null;
  supabaseAnonKey: string | null;
  /**
   * Origins allowed to embed the app (the TAKATAK dashboard). They are also the only origins
   * whose postMessage session handover the app accepts. Empty: no framing.
   */
  frameAncestors: string[];
}

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "ops-ui");
const require = createRequire(import.meta.url);

const FILES: Record<string, { path: string; type: string }> = {
  "app.js": { path: join(UI_DIR, "app.js"), type: "text/javascript; charset=utf-8" },
  "offline.js": { path: join(UI_DIR, "offline.js"), type: "text/javascript; charset=utf-8" },
  "styles.css": { path: join(UI_DIR, "styles.css"), type: "text/css; charset=utf-8" },
  // htm's export map only resolves CommonJS here; serve its ES module build from the package dir.
  "vendor/htm-preact.js": { path: join(dirname(require.resolve("htm")), "..", "preact", "standalone.mjs"), type: "text/javascript; charset=utf-8" },
};

/**
 * The standalone ALKAO Operations web app: static files plus a public config (the Supabase
 * URL and anon key are public by design). It holds no data; every call goes to the
 * gated admin API with the user's own token. Strict CSP: same-origin scripts only.
 */
export function mountOpsUi(app: Hono<any>, cfg: OpsUiConfig): void {
  const cache = new Map<string, string>();
  const read = (path: string) => {
    if (!cache.has(path)) cache.set(path, readFileSync(path, "utf8"));
    return cache.get(path)!;
  };
  const connect = ["'self'", ...(cfg.supabaseUrl ? [new URL(cfg.supabaseUrl).origin] : [])].join(" ");
  const headers = (type: string) => ({
    "content-type": type,
    "content-security-policy": [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      `connect-src ${connect}`,
      "media-src 'self' blob:",
      `frame-ancestors ${cfg.frameAncestors.length ? cfg.frameAncestors.join(" ") : "'none'"}`,
      "base-uri 'none'",
      "form-action 'none'",
    ].join("; "),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(self), microphone=(), geolocation=()",
    "cache-control": "no-cache",
  });

  app.get("/ops", (c) => c.body(read(join(UI_DIR, "index.html")), 200, headers("text/html; charset=utf-8")));
  app.get("/ops/config.json", (c) =>
    c.body(JSON.stringify({ supabaseUrl: cfg.supabaseUrl, supabaseAnonKey: cfg.supabaseAnonKey, embedOrigins: cfg.frameAncestors }), 200, headers("application/json")),
  );
  for (const [name, file] of Object.entries(FILES)) {
    app.get(`/ops/${name}`, (c) => c.body(read(file.path), 200, headers(file.type)));
  }
}
