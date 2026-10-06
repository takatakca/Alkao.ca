import type { Context, Hono } from "hono";
import * as campaignsDb from "../db/campaigns.js";
import { withTransaction, type Db } from "../db/pool.js";
import { isUuid } from "../domain/ids.js";
import { unsubscribeTokenValid } from "../delivery/campaigns.js";
import { esc, simplePage } from "./simple-page.js";

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

const page = simplePage;

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
