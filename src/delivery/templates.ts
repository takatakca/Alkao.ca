import type { EmailMessage } from "./email.js";

/**
 * Buyer emails, in French (Québec, the default) or English (Run 16), whichever the buyer
 * chose at checkout. Every value is escaped in the HTML part.
 */
export type Language = "fr" | "en";
type Content = Omit<EmailMessage, "to" | "idempotencyKey">;

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const locale = (l: Language) => (l === "en" ? "en-CA" : "fr-CA");
const fullDate = (l: Language, at: Date, timeZone: string) =>
  new Intl.DateTimeFormat(locale(l), { dateStyle: "full", timeStyle: "short", timeZone }).format(at);
const cad = (cents: number, l: Language = "fr") => (cents / 100).toLocaleString(locale(l), { style: "currency", currency: "CAD" });
const plural = (n: number, one: string, many: string) => (n > 1 ? many : one);

const FOOTER = { fr: "Billetterie ALKAO", en: "ALKAO Ticketing" };

/** The common frame: Brand, title, then rows of trusted HTML (callers escape their values). */
function layout(l: Language, brandName: string, title: string, rows: string[]): string {
  return `<!doctype html><html lang="${l}"><body style="margin:0;background:#f5f5f4;font-family:Arial,Helvetica,sans-serif;color:#1c1917">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;padding:28px">
<tr><td style="font-size:13px;color:#57534e;padding-bottom:12px">${esc(brandName)}</td></tr>
<tr><td style="font-size:22px;font-weight:bold;padding-bottom:16px">${esc(title)}</td></tr>
${rows.join("\n")}
</table>
<p style="font-size:12px;color:#78716c">${FOOTER[l]}</p>
</td></tr></table></body></html>`;
}
const button = (href: string, label: string) =>
  `<tr><td align="center" style="padding:24px 0"><a href="${esc(href)}" style="display:inline-block;background:#1c1917;color:#ffffff;text-decoration:none;font-weight:bold;padding:14px 24px;border-radius:8px">${esc(label)}</a></td></tr>`;
const paragraph = (html: string) => `<tr><td style="font-size:15px;line-height:1.5;padding-bottom:16px">${html}</td></tr>`;
const box = (html: string) => `<tr><td style="font-size:15px;line-height:1.6;padding:12px 16px;background:#fafaf9;border-radius:8px">${html}</td></tr>`;
const note = (html: string, top = false) => `<tr><td style="font-size:13px;line-height:1.5;color:#57534e${top ? ";padding-top:16px" : ""}">${html}</td></tr>`;

// ── Tickets ──────────────────────────────────────────────────────────────────
export interface TicketsEmailData {
  kind: "order_tickets" | "exchange_tickets";
  language?: Language;
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

const TICKETS = {
  fr: {
    title: (changed: boolean) => (changed ? "Vos nouveaux billets" : "Vos billets"),
    hello: (name: string | null) => (name ? `Bonjour ${name},` : "Bonjour,"),
    intro: (changed: boolean, ref: string) =>
      changed
        ? "Votre changement de séance est confirmé. Voici vos nouveaux billets ; les anciens codes QR ne sont plus valides."
        : `Merci pour votre commande ${ref}. Voici vos billets.`,
    count: (n: number) => `${n} ${plural(n, "billet", "billets")}`,
    order: "commande",
    linkLine: "Vos billets et codes QR : ",
    show: "Afficher mes billets",
    advice: "Présentez le code QR de chaque billet à l'entrée. Ce lien est personnel : ne le partagez pas.",
  },
  en: {
    title: (changed: boolean) => (changed ? "Your new tickets" : "Your tickets"),
    hello: (name: string | null) => (name ? `Hello ${name},` : "Hello,"),
    intro: (changed: boolean, ref: string) =>
      changed
        ? "Your session change is confirmed. Here are your new tickets; the old QR codes no longer work."
        : `Thank you for your order ${ref}. Here are your tickets.`,
    count: (n: number) => `${n} ${plural(n, "ticket", "tickets")}`,
    order: "order",
    linkLine: "Your tickets and QR codes: ",
    show: "Show my tickets",
    advice: "Show each ticket's QR code at the entrance. This link is personal: do not share it.",
  },
};

export function ticketsEmail(d: TicketsEmailData): Content {
  const l = d.language ?? "fr";
  const t = TICKETS[l];
  const changed = d.kind === "exchange_tickets";
  const when = fullDate(l, d.startsAt, d.timezone);
  const where = d.city ? `${d.venueName}, ${d.city}` : d.venueName;
  const count = t.count(d.validTickets);
  const hello = t.hello(d.buyerName);
  const intro = t.intro(changed, d.reference);
  const subject = `${t.title(changed)} — ${d.eventTitle} (${d.reference})`;
  const text = [hello, "", intro, "", d.eventTitle, when, where, count, "", `${t.linkLine}${d.link}`, "", t.advice, "", `${d.brandName} · ${FOOTER[l]}`].join("\n");
  const html = layout(l, d.brandName, t.title(changed), [
    paragraph(`${esc(hello)}<br>${esc(intro)}`),
    box(`<strong>${esc(d.eventTitle)}</strong><br>${esc(when)}<br>${esc(where)}<br>${esc(count)} · ${t.order} ${esc(d.reference)}`),
    button(d.link, t.show),
    note(esc(t.advice)),
  ]);
  return { fromName: d.brandName, subject, text, html };
}

// ── Session cancelled ───────────────────────────────────────────────────────
export interface SessionCancelledEmailData {
  language?: Language;
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

const CANCELLED = {
  fr: {
    title: "Séance annulée",
    hello: (name: string | null) => (name ? `Bonjour ${name},` : "Bonjour,"),
    what: (brand: string, when: string, event: string, where: string) => `${brand} a annulé la séance du ${when} (${event}, ${where}).`,
    refunded: (amount: string) =>
      `Vous êtes remboursé de ${amount} sur la carte utilisée pour l'achat. Le remboursement apparaît habituellement d'ici 5 à 10 jours ouvrables.`,
    free: "Vos billets sont annulés.",
    sorry: "Vos billets de cette séance ne sont plus valides. Nous sommes désolés pour ce contretemps.",
    order: "Commande",
  },
  en: {
    title: "Session cancelled",
    hello: (name: string | null) => (name ? `Hello ${name},` : "Hello,"),
    what: (brand: string, when: string, event: string, where: string) => `${brand} cancelled the session of ${when} (${event}, ${where}).`,
    refunded: (amount: string) =>
      `You are refunded ${amount} on the card used for the purchase. Refunds usually appear within 5 to 10 business days.`,
    free: "Your tickets are cancelled.",
    sorry: "Your tickets for this session are no longer valid. We are sorry for the inconvenience.",
    order: "Order",
  },
};

export function sessionCancelledEmail(d: SessionCancelledEmailData): Content {
  const l = d.language ?? "fr";
  const t = CANCELLED[l];
  const where = d.city ? `${d.venueName}, ${d.city}` : d.venueName;
  const hello = t.hello(d.buyerName);
  const what = t.what(d.brandName, fullDate(l, d.startsAt, d.timezone), d.eventTitle, where);
  const money = d.refundedCents > 0 ? t.refunded(cad(d.refundedCents, l)) : t.free;
  const subject = `${t.title} — ${d.eventTitle} (${d.reference})`;
  const text = [hello, "", what, "", money, "", t.sorry, "", `${d.brandName} · ${FOOTER[l]}`].join("\n");
  const html = layout(l, d.brandName, t.title, [
    paragraph(`${esc(hello)}<br>${esc(what)}`),
    box(`${esc(money)}<br><span style="color:#57534e">${t.order} ${esc(d.reference)}</span>`),
    note(esc(t.sorry), true),
  ]);
  return { fromName: d.brandName, subject, text, html };
}

// ── Refund ───────────────────────────────────────────────────────────────────
export interface RefundEmailData {
  language?: Language;
  brandName: string;
  buyerName: string | null;
  reference: string;
  eventTitle: string;
  amountCents: number;
  /** capacity_unavailable: paid after the seats were gone. */
  reason: string | null;
  voidedTickets: number;
  validTickets: number;
  /** The buyer's tickets page, when some tickets are still valid. */
  link: string | null;
}

const REFUND = {
  fr: {
    title: (amount: string) => `Remboursement de ${amount}`,
    hello: (name: string | null) => (name ? `Bonjour ${name},` : "Bonjour,"),
    late: (event: string, amount: string) =>
      `Les places n'étaient plus disponibles au moment où votre paiement a été confirmé pour ${event}. Vous êtes remboursé en entier : ${amount}.`,
    staff: (brand: string, amount: string, ref: string, event: string) => `${brand} vous a remboursé ${amount} pour votre commande ${ref} (${event}).`,
    delay: "Le remboursement apparaît habituellement sur la carte utilisée d'ici 5 à 10 jours ouvrables.",
    voided: (n: number) => `${n} ${plural(n, "billet annulé.", "billets annulés.")}`,
    still: (n: number, link: string) => `Vos ${n} ${plural(n, "autre billet reste valide", "autres billets restent valides")} : ${link}`,
    show: "Afficher mes billets",
    order: "Commande",
  },
  en: {
    title: (amount: string) => `Refund of ${amount}`,
    hello: (name: string | null) => (name ? `Hello ${name},` : "Hello,"),
    late: (event: string, amount: string) =>
      `The seats were no longer available when your payment was confirmed for ${event}. You are refunded in full: ${amount}.`,
    staff: (brand: string, amount: string, ref: string, event: string) => `${brand} refunded you ${amount} for your order ${ref} (${event}).`,
    delay: "Refunds usually appear on the card used within 5 to 10 business days.",
    voided: (n: number) => `${n} ${plural(n, "ticket cancelled.", "tickets cancelled.")}`,
    still: (n: number, link: string) => `Your ${n} other ${plural(n, "ticket is still valid", "tickets are still valid")}: ${link}`,
    show: "Show my tickets",
    order: "Order",
  },
};

export function refundEmail(d: RefundEmailData): Content {
  const l = d.language ?? "fr";
  const t = REFUND[l];
  const amount = cad(d.amountCents, l);
  const hello = t.hello(d.buyerName);
  const what = d.reason === "capacity_unavailable" ? t.late(d.eventTitle, amount) : t.staff(d.brandName, amount, d.reference, d.eventTitle);
  const tickets = d.voidedTickets > 0 ? t.voided(d.voidedTickets) : "";
  const still = d.validTickets > 0 && d.link ? t.still(d.validTickets, d.link) : "";
  const subject = `${t.title(amount)} — ${d.eventTitle} (${d.reference})`;
  const text = [hello, "", what, t.delay, ...(tickets ? ["", tickets] : []), ...(still ? ["", still] : []), "", `${d.brandName} · ${FOOTER[l]}`].join("\n");
  const html = layout(l, d.brandName, t.title(amount), [
    paragraph(`${esc(hello)}<br>${esc(what)}`),
    `<tr><td style="font-size:14px;line-height:1.6;padding:12px 16px;background:#fafaf9;border-radius:8px">${esc(t.delay)}${tickets ? `<br>${esc(tickets)}` : ""}<br><span style="color:#57534e">${t.order} ${esc(d.reference)}</span></td></tr>`,
    ...(still ? [button(d.link!, t.show)] : []),
  ]);
  return { fromName: d.brandName, subject, text, html };
}
