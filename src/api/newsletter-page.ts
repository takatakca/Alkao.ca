import type { Context, Hono } from "hono";
import * as newsletterDb from "../db/newsletter.js";
import { withTransaction, type Db } from "../db/pool.js";
import { DomainError } from "../domain/errors.js";
import { isUuid } from "../domain/ids.js";
import { signupTokenValid } from "../delivery/newsletter.js";
import { esc, simplePage } from "./simple-page.js";

/**
 * Run 44: `/inscription?s=…&k=…`, the link in the confirmation e-mail. GET shows one button,
 * so a mail scanner that opens links confirms nothing; POST (the person's click) records
 * the express consent and shows the welcome code. Signed per sign-up; no script.
 */
const TEXT = {
  fr: {
    title: "Votre inscription",
    ask: (brand: string) => `Confirmez-vous vouloir recevoir les nouvelles et les promotions de ${brand} par courriel ? Vous pourrez vous désabonner en un clic dans chaque courriel.`,
    button: "Oui, je confirme",
    done: (brand: string) => `Merci ! Vous recevrez les nouvelles et les promotions de ${brand}.`,
    code: (text: string | null) => `Votre code de bienvenue${text ? ` (${text})` : ""} :`,
    keep: "Gardez-le : il vous sera demandé au paiement.",
    expired: "Ce lien a expiré. Inscrivez-vous de nouveau sur le site pour en recevoir un autre.",
    invalid: "Ce lien de confirmation n'est pas valide.",
  },
  en: {
    title: "Your sign-up",
    ask: (brand: string) => `Do you confirm you want ${brand}'s news and offers by e-mail? You can unsubscribe in one click in every e-mail.`,
    button: "Yes, I confirm",
    done: (brand: string) => `Thank you! You will receive ${brand}'s news and offers.`,
    code: (text: string | null) => `Your welcome code${text ? ` (${text})` : ""}:`,
    keep: "Keep it: you will be asked for it at checkout.",
    expired: "This link has expired. Sign up again on the website to get a new one.",
    invalid: "This confirmation link is not valid.",
  },
};

export function mountNewsletterPage(app: Hono<any>, deps: { db: Db; masterSecret: string | null; now: () => Date }): void {
  const valid = (c: Context) => {
    const s = c.req.query("s") ?? "";
    const k = c.req.query("k") ?? "";
    return deps.masterSecret && isUuid(s) && k.length <= 64 && signupTokenValid(deps.masterSecret, s, k) ? s : null;
  };
  const invalid = (c: Context) => simplePage(c, 404, "fr", TEXT.fr.title, `<p>${esc(TEXT.fr.invalid)}</p><p lang="en">${esc(TEXT.en.invalid)}</p>`);
  const thanks = (c: Context, ctx: newsletterDb.SignupContext) => {
    const t = TEXT[ctx.language];
    const code = ctx.reward_code ? `<p>${esc(t.code(ctx.reward_text))}</p><p class="code">${esc(ctx.reward_code)}</p><p>${esc(t.keep)}</p>` : "";
    return simplePage(c, 200, ctx.language, t.title, `<p>${esc(t.done(ctx.brand_name))}</p>${code}`);
  };

  app.get("/inscription", async (c) => {
    const id = valid(c);
    const ctx = id ? await newsletterDb.signupContext(deps.db, id) : null;
    if (!id || !ctx) return invalid(c);
    if (ctx.status === "confirmed") return thanks(c, ctx);
    const t = TEXT[ctx.language];
    const action = `/inscription?${new URLSearchParams({ s: id, k: c.req.query("k")! }).toString()}`;
    return simplePage(c, 200, ctx.language, t.title,
      `<p>${esc(t.ask(ctx.brand_name))}</p><form method="post" action="${esc(action)}"><button type="submit">${esc(t.button)}</button></form>`);
  });

  app.post("/inscription", async (c) => {
    const id = valid(c);
    if (!id) return invalid(c);
    try {
      return thanks(c, await withTransaction(deps.db, (tx) => newsletterDb.confirmSignup(tx, id, deps.now())));
    } catch (error) {
      if (error instanceof DomainError && error.code === "signup_expired") {
        const ctx = await newsletterDb.signupContext(deps.db, id);
        const t = TEXT[ctx?.language ?? "fr"];
        return simplePage(c, 410, ctx?.language ?? "fr", t.title, `<p>${esc(t.expired)}</p>`);
      }
      if (error instanceof DomainError && error.code === "signup_not_found") return invalid(c);
      throw error;
    }
  });
}
