import type { Context, Hono } from "hono";
import * as campaignsDb from "../db/campaigns.js";
import { withTransaction, type Db } from "../db/pool.js";
import { isUuid } from "../domain/ids.js";
import { unsubscribeTokenValid } from "../delivery/campaigns.js";

/**
 * Run 42: `/desabonnement?m=…&k=…`, the link at the bottom of every campaign e-mail. GET shows
 * a page with one button; POST (that button, or a mailbox's one-click unsubscribe, RFC 8058)
 * stops the Brand's marketing e-mail to the customer. It works even when Ticketing is off:
 * an unsubscribe must keep working after the campaign. No script, nothing stored but the opt-out.
 */
const TEXT = {
  fr: {
    title: "Se désabonner",
    ask: (brand: string) => `Ne plus recevoir les courriels promotionnels de ${brand} ?`,
    button: "Me désabonner",
    done: (brand: string) => `C'est fait : vous ne recevrez plus les courriels promotionnels de ${brand}. Vos billets et confirmations de réservation vous seront toujours envoyés.`,
    already: (brand: string) => `Votre adresse est déjà désabonnée des courriels promotionnels de ${brand}.`,
    test: "Ce courriel était un essai envoyé par l'équipe : il n'y a rien à désabonner.",
    invalid: "Ce lien de désabonnement n'est pas valide. Répondez au courriel reçu pour demander à ne plus en recevoir.",
  },
  en: {
    title: "Unsubscribe",
    ask: (brand: string) => `Stop receiving promotional e-mails from ${brand}?`,
    button: "Unsubscribe me",
    done: (brand: string) => `Done: you will no longer receive promotional e-mails from ${brand}. Your tickets and booking confirmations will still be sent to you.`,
    already: (brand: string) => `You are already unsubscribed from ${brand}'s promotional e-mails.`,
    test: "This e-mail was a test sent by the team: there is nothing to unsubscribe from.",
    invalid: "This unsubscribe link is not valid. Reply to the e-mail you received to ask for no more.",
  },
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(c: Context, status: 200 | 404, lang: "fr" | "en", title: string, body: string) {
  const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{margin:0;background:#f5f5f4;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1c1917}
main{max-width:520px;margin:12vh auto;background:#fff;border-radius:12px;padding:28px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
h1{font-size:1.4rem;margin:0 0 12px}button{font:inherit;font-weight:600;padding:12px 20px;border:0;border-radius:8px;background:#1c1917;color:#fff;cursor:pointer}
button:focus-visible{outline:3px solid #2563eb;outline-offset:2px}</style></head>
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

export function mountUnsubscribe(app: Hono<any>, deps: { db: Db; masterSecret: string | null; now: () => Date }): void {
  const valid = (c: Context) => {
    const m = c.req.query("m") ?? "";
    const k = c.req.query("k") ?? "";
    return deps.masterSecret && isUuid(m) && k.length <= 64 && unsubscribeTokenValid(deps.masterSecret, m, k) ? m : null;
  };
  const invalid = (c: Context) => page(c, 404, "fr", TEXT.fr.title, `<p>${esc(TEXT.fr.invalid)}</p><p lang="en">${esc(TEXT.en.invalid)}</p>`);

  app.get("/desabonnement", async (c) => {
    const m = valid(c);
    const ctx = m ? await campaignsDb.unsubscribeContext(deps.db, m) : null;
    if (!m || !ctx) return invalid(c);
    const t = TEXT[ctx.language];
    if (!ctx.customer_id) return page(c, 200, ctx.language, t.title, `<p>${esc(t.test)}</p>`);
    if (ctx.unsubscribed_at) return page(c, 200, ctx.language, t.title, `<p>${esc(t.already(ctx.brand_name))}</p>`);
    const action = `/desabonnement?${new URLSearchParams({ m, k: c.req.query("k")! }).toString()}`;
    return page(c, 200, ctx.language, t.title,
      `<p>${esc(t.ask(ctx.brand_name))}</p><form method="post" action="${esc(action)}"><button type="submit">${esc(t.button)}</button></form>`);
  });

  app.post("/desabonnement", async (c) => {
    const m = valid(c);
    if (!m || !(await campaignsDb.unsubscribeContext(deps.db, m))) return invalid(c);
    const done = await withTransaction(deps.db, (tx) => campaignsDb.unsubscribe(tx, m, deps.now()));
    const t = TEXT[done.language];
    return page(c, 200, done.language, t.title, `<p>${esc(done.test ? t.test : t.done(done.brand_name))}</p>`);
  });
}
