import type { Context } from "hono";

/**
 * Run 42–44: the small server-rendered pages a link in an e-mail opens (unsubscribe, confirm a
 * sign-up). No script; the only style is inline; every value is escaped.
 */
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function simplePage(c: Context, status: 200 | 404 | 410, lang: "fr" | "en", title: string, body: string) {
  const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{margin:0;background:#f5f5f4;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1c1917}
main{max-width:520px;margin:12vh auto;background:#fff;border-radius:12px;padding:28px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
h1{font-size:1.4rem;margin:0 0 12px}button{font:inherit;font-weight:600;padding:12px 20px;border:0;border-radius:8px;background:#1c1917;color:#fff;cursor:pointer}
button:focus-visible{outline:3px solid #2563eb;outline-offset:2px}
.code{display:inline-block;font:700 1.5rem/1.2 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.08em;padding:10px 16px;border:2px dashed #1c1917;border-radius:8px;margin:8px 0}</style></head>
<body><main><h1>${esc(title)}</h1>${body}</main></body></html>`;
  return c.body(html, status, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-robots-tag": "noindex, nofollow",
    "cache-control": "no-store",
  });
}
