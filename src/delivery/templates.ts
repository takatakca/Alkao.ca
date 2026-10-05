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

export interface SessionCancelledEmailData {
  brandName: string;
  buyerName: string | null;
  reference: string;
  eventTitle: string;
  startsAt: Date;
  venueName: string;
  city: string | null;
  timezone: string;
  /** What this cancellation refunded on the buyer's card; 0 for free tickets. */
  refundedCents: number;
}

const cad = (cents: number) => (cents / 100).toLocaleString("fr-CA", { style: "currency", currency: "CAD" });

/** "Séance annulée" (Run 10): the organizer cancelled, the buyer is refunded. No link. */
export function sessionCancelledEmail(d: SessionCancelledEmailData): Omit<EmailMessage, "to" | "idempotencyKey"> {
  const when = new Intl.DateTimeFormat("fr-CA", { dateStyle: "full", timeStyle: "short", timeZone: d.timezone }).format(d.startsAt);
  const where = d.city ? `${d.venueName}, ${d.city}` : d.venueName;
  const hello = d.buyerName ? `Bonjour ${d.buyerName},` : "Bonjour,";
  const what = `${d.brandName} a annulé la séance du ${when} (${d.eventTitle}, ${where}).`;
  const money = d.refundedCents > 0
    ? `Vous êtes remboursé de ${cad(d.refundedCents)} sur la carte utilisée pour l'achat. Le remboursement apparaît habituellement d'ici 5 à 10 jours ouvrables.`
    : "Vos billets sont annulés.";
  const subject = `Séance annulée — ${d.eventTitle} (${d.reference})`;
  const text = [hello, "", what, "", money, "", "Vos billets de cette séance ne sont plus valides. Nous sommes désolés pour ce contretemps.", "", `${d.brandName} · Billetterie ALKAO`].join("\n");
  const html = `<!doctype html><html lang="fr"><body style="margin:0;background:#f5f5f4;font-family:Arial,Helvetica,sans-serif;color:#1c1917">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;padding:28px">
<tr><td style="font-size:13px;color:#57534e;padding-bottom:12px">${esc(d.brandName)}</td></tr>
<tr><td style="font-size:22px;font-weight:bold;padding-bottom:16px">Séance annulée</td></tr>
<tr><td style="font-size:15px;line-height:1.5;padding-bottom:16px">${esc(hello)}<br>${esc(what)}</td></tr>
<tr><td style="font-size:15px;line-height:1.6;padding:12px 16px;background:#fafaf9;border-radius:8px">${esc(money)}<br><span style="color:#57534e">Commande ${esc(d.reference)}</span></td></tr>
<tr><td style="font-size:13px;line-height:1.5;color:#57534e;padding-top:16px">Vos billets de cette séance ne sont plus valides. Nous sommes désolés pour ce contretemps.</td></tr>
</table>
<p style="font-size:12px;color:#78716c">Billetterie ALKAO</p>
</td></tr></table></body></html>`;
  return { fromName: d.brandName, subject, text, html };
}
