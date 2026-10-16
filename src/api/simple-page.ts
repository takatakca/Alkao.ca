import type { Context } from "hono";

/**
 * Run 42–44: the small server-rendered pages a link in an e-mail opens (unsubscribe, confirm a
 * sign-up). No script; the only style is inline (and the fonts are this site's own); every value is escaped.
 */
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// Run 90: the same neutral, premium look as the shop and the tickets page (light and dark), with
// ALKAO's self-hosted fonts. The page belongs to the Brand, so nothing here says "ALKAO".
const STYLE = `@font-face{font-family:Inter;src:url(/assets/home/fonts/inter-latin.woff2) format("woff2");font-weight:100 900;font-display:swap}
@font-face{font-family:Montserrat;src:url(/assets/home/fonts/montserrat-latin.woff2) format("woff2");font-weight:100 900;font-display:swap}
:root{color-scheme:light dark;--bg:#F5F6F9;--panel:#fff;--ink:#0E1525;--muted:#5A6375;--line:#E4E7EE;--btn:#0E1525;--btn-ink:#fff;--ring:#1565D8;--dash:#9AA3B5}
@media (prefers-color-scheme:dark){:root{--bg:#0A0F1C;--panel:#121A2B;--ink:#EEF2F8;--muted:#A3AEC2;--line:#24304A;--btn:#EEF2F8;--btn-ink:#0A0F1C;--ring:#7FD8FF;--dash:#4A5A7A}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:radial-gradient(900px 500px at 50% -10%,rgba(21,101,216,.12),transparent 70%),var(--bg);color:var(--ink);font:16px/1.6 Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
main{width:min(520px,100%);background:var(--panel);border:1px solid var(--line);border-radius:28px;padding:36px 32px 32px;box-shadow:0 1px 2px rgba(14,21,37,.04),0 24px 60px rgba(14,21,37,.10);animation:rise .42s cubic-bezier(.2,.7,.2,1) both}
.mark{display:grid;place-items:center;width:56px;height:56px;margin-bottom:18px;border-radius:18px;background:rgba(21,101,216,.1);color:var(--ring)}
.mark svg{width:28px;height:28px}
main.is-error .mark{background:rgba(180,35,24,.1);color:#B42318}
@media (prefers-color-scheme:dark){main.is-error .mark{color:#FDA29B}}
h1{margin:0 0 10px;font:800 1.6rem/1.2 Montserrat,Inter,system-ui,sans-serif;letter-spacing:-.01em}
p{margin:0 0 12px;color:var(--muted)}
p:first-of-type{color:var(--ink)}
form{margin-top:22px}
button{width:100%;min-height:52px;font:inherit;font-weight:700;padding:0 24px;border:0;border-radius:999px;background:var(--btn);color:var(--btn-ink);cursor:pointer;transition:transform .18s cubic-bezier(.2,.7,.2,1),box-shadow .18s}
button:hover{transform:translateY(-1px);box-shadow:0 10px 24px rgba(14,21,37,.18)}
button:focus-visible{outline:3px solid var(--ring);outline-offset:3px}
.code{display:block;margin:10px 0 14px;padding:18px 16px;text-align:center;font:800 1.7rem/1.2 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.12em;color:var(--ink);border:2px dashed var(--dash);border-radius:18px;background:var(--bg);user-select:all}
@keyframes rise{from{opacity:0;transform:translateY(12px)}}
@media (prefers-reduced-motion:reduce){main{animation:none}button{transition:none}}`;
const MARK = {
  ok: '<path d="M4 6h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z"/><path d="m3.5 7 8.5 6 8.5-6"/>',
  error: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5h.01"/>',
};

export function simplePage(c: Context, status: 200 | 404 | 410, lang: "fr" | "en", title: string, body: string) {
  const error = status !== 200;
  const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>${STYLE}</style></head>
<body><main${error ? ' class="is-error"' : ""}><div class="mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${error ? MARK.error : MARK.ok}</svg></div><h1>${esc(title)}</h1>${body}</main></body></html>`;
  return c.body(html, status, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-robots-tag": "noindex, nofollow",
    "cache-control": "no-store",
  });
}
