import type { EmailMessage } from "./email.js";

export interface TicketsEmailData {
  kind: "order_tickets" | "exchange_tickets";
  brandName: string;
  buyerName: string | null;
  reference: string;
  eventTitle: string;
  startsAt: Date;
  venueName: string;
  city: string | null;
  timezone: string;
  validTickets: number;
  link: string;
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The buyer's tickets email, in French (Québec). Every value is escaped in the HTML part. */
export function ticketsEmail(d: TicketsEmailData): Omit<EmailMessage, "to" | "idempotencyKey"> {
  const when = new Intl.DateTimeFormat("fr-CA", { dateStyle: "full", timeStyle: "short", timeZone: d.timezone }).format(d.startsAt);
  const where = d.city ? `${d.venueName}, ${d.city}` : d.venueName;
  const count = `${d.validTickets} billet${d.validTickets > 1 ? "s" : ""}`;
  const changed = d.kind === "exchange_tickets";
  const subject = `${changed ? "Vos nouveaux billets" : "Vos billets"} — ${d.eventTitle} (${d.reference})`;
  const hello = d.buyerName ? `Bonjour ${d.buyerName},` : "Bonjour,";
  const intro = changed
    ? `Votre changement de séance est confirmé. Voici vos nouveaux billets ; les anciens codes QR ne sont plus valides.`
    : `Merci pour votre commande ${d.reference}. Voici vos billets.`;
  const text = [
    hello,
    "",
    intro,
    "",
    `${d.eventTitle}`,
    `${when}`,
    `${where}`,
    `${count}`,
    "",
    `Vos billets et codes QR : ${d.link}`,
    "",
    "Présentez le code QR de chaque billet à l'entrée. Ce lien est personnel : ne le partagez pas.",
    "",
    `${d.brandName} · Billetterie ALKAO`,
  ].join("\n");
  const html = `<!doctype html><html lang="fr"><body style="margin:0;background:#f5f5f4;font-family:Arial,Helvetica,sans-serif;color:#1c1917">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;padding:28px">
<tr><td style="font-size:13px;color:#57534e;padding-bottom:12px">${esc(d.brandName)}</td></tr>
<tr><td style="font-size:22px;font-weight:bold;padding-bottom:16px">${changed ? "Vos nouveaux billets" : "Vos billets"}</td></tr>
<tr><td style="font-size:15px;line-height:1.5;padding-bottom:16px">${esc(hello)}<br>${esc(intro)}</td></tr>
<tr><td style="font-size:15px;line-height:1.6;padding:12px 16px;background:#fafaf9;border-radius:8px">
<strong>${esc(d.eventTitle)}</strong><br>${esc(when)}<br>${esc(where)}<br>${esc(count)} · commande ${esc(d.reference)}</td></tr>
<tr><td align="center" style="padding:24px 0"><a href="${esc(d.link)}" style="display:inline-block;background:#1c1917;color:#ffffff;text-decoration:none;font-weight:bold;padding:14px 24px;border-radius:8px">Afficher mes billets</a></td></tr>
<tr><td style="font-size:13px;line-height:1.5;color:#57534e">Présentez le code QR de chaque billet à l'entrée. Ce lien est personnel : ne le partagez pas.</td></tr>
</table>
<p style="font-size:12px;color:#78716c">Billetterie ALKAO</p>
</td></tr></table></body></html>`;
  return { fromName: d.brandName, subject, text, html };
}
