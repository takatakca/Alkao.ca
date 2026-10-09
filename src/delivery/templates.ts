import type { EmailCode } from "./codes.js";
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

/** Run 50: the Brand's look in its e-mails (each part optional: ALKAO's neutral look otherwise). */
export interface EmailLook {
  logoUrl: string | null;
  accentColor: string | null;
  onAccentColor: string | null;
  websiteUrl: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
  addressLine: string | null;
  /** The event's photo, under the title (tickets, reminder). */
  imageUrl?: string | null;
}
// Stored values are already checked by the database; e-mails check again before using them.
const colour = (c: string | null | undefined, fallback: string) => (c && /^#[0-9a-f]{6}$/i.test(c) ? c : fallback);
const httpsOnly = (u: string | null | undefined) => (u && /^https:\/\/[^\s"'<>\\]+$/.test(u) ? u : null);

/** The Brand's website, phone and address, for the bottom of an e-mail. */
function contactLines(look: EmailLook | null | undefined): string[] {
  if (!look) return [];
  return [httpsOnly(look.websiteUrl)?.replace(/^https:\/\//, "").replace(/\/$/, ""), look.supportEmail, look.supportPhone, look.addressLine]
    .filter((x): x is string => Boolean(x));
}
const footerText = (l: Language, brandName: string, look?: EmailLook | null) =>
  [[brandName, ...contactLines(look)].join(" · "), FOOTER[l]].join("\n");

/**
 * The common frame: the Brand's band (its colour, its logo or name, as on the tickets page and
 * the shop), the event's photo, the title, then rows of trusted HTML (callers escape their values).
 */
function layout(l: Language, brandName: string, title: string, rows: string[], look?: EmailLook | null): string {
  const logo = httpsOnly(look?.logoUrl);
  const photo = httpsOnly(look?.imageUrl);
  const band = colour(look?.accentColor, "#1c1917");
  const ink = colour(look?.onAccentColor, "#ffffff");
  const head = logo
    ? `<img src="${esc(logo)}" alt="${esc(brandName)}" height="40" style="display:block;height:40px;width:auto;max-width:240px;border:0;color:${ink}">`
    : `<span style="font-size:16px;font-weight:bold;color:${ink}">${esc(brandName)}</span>`;
  const contact = contactLines(look);
  return `<!doctype html><html lang="${l}"><body style="margin:0;background:#f5f5f4;font-family:Arial,Helvetica,sans-serif;color:#1c1917">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td bgcolor="${band}" style="background:${band};padding:16px 28px">${head}</td></tr>
<tr><td style="padding:24px 28px 28px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
${photo ? `<tr><td style="padding-bottom:16px"><img src="${esc(photo)}" alt="" width="504" style="display:block;width:100%;max-width:504px;height:auto;border-radius:10px"></td></tr>` : ""}
<tr><td style="font-size:22px;font-weight:bold;padding-bottom:16px">${esc(title)}</td></tr>
${rows.join("\n")}
</table>
</td></tr>
</table>
${contact.length ? `<p style="font-size:12px;color:#57534e;margin:12px 0 4px">${contact.map(esc).join(" · ")}</p>` : ""}
<p style="font-size:12px;color:#78716c">${FOOTER[l]}</p>
</td></tr></table></body></html>`;
}
const button = (href: string, label: string, look?: EmailLook | null) =>
  `<tr><td align="center" style="padding:24px 0"><a href="${esc(href)}" style="display:inline-block;background:${colour(look?.accentColor, "#1c1917")};color:${colour(look?.onAccentColor, "#ffffff")};text-decoration:none;font-weight:bold;padding:14px 24px;border-radius:8px">${esc(label)}</a></td></tr>`;
const paragraph = (html: string) => `<tr><td style="font-size:15px;line-height:1.5;padding-bottom:16px">${html}</td></tr>`;
const box = (html: string) => `<tr><td style="font-size:15px;line-height:1.6;padding:12px 16px;background:#fafaf9;border-radius:8px">${html}</td></tr>`;
const note = (html: string, top = false) => `<tr><td style="font-size:13px;line-height:1.5;color:#57534e${top ? ";padding-top:16px" : ""}">${html}</td></tr>`;

// ── Tickets ──────────────────────────────────────────────────────────────────
export interface TicketsEmailData {
  /** Run 50: the Brand's logo, colours, contact (and the event's photo). */
  look?: EmailLook | null;
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
  /** Run 52: the QR codes shown in the e-mail itself (inline images), when there are few enough. */
  codes?: EmailCode[] | null;
  /** Run 54: the options bought with the tickets (meals, activities…), which have no QR code. */
  addOns?: { name: string; quantity: number }[] | null;
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
    codesTitle: "Vos codes QR",
    codesNote: "Montrez-les à l'entrée, même sans réseau. Si votre commande change, la page de vos billets reste la référence.",
    codesText: "Vos codes QR sont aussi dans ce courriel (version avec images).",
    qrAlt: (code: string) => `Code QR du billet ${code}`,
    options: "Options",
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
    codesTitle: "Your QR codes",
    codesNote: "Show them at the entrance, even without a network. If your order changes, your tickets page is always up to date.",
    codesText: "Your QR codes are also in this e-mail (version with images).",
    qrAlt: (code: string) => `QR code of ticket ${code}`,
    options: "Options",
  },
};

/** Run 52: each ticket's QR code as an inline image, dark on white whatever the e-mail app's theme. */
function codeRows(t: { codesTitle: string; codesNote: string; qrAlt: (code: string) => string }, codes: EmailCode[] | null | undefined): string[] {
  if (!codes?.length) return [];
  const cards = codes
    .map((c) => `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 16px"><tr><td align="center" width="248" bgcolor="#ffffff" style="width:248px;background:#ffffff;border:1px solid #e7e5e4;border-radius:10px;padding:12px 16px">
<img src="cid:${esc(c.cid)}" width="200" height="200" alt="${esc(t.qrAlt(c.code))}" style="display:block;width:200px;height:200px;border:0">
<div style="font-size:14px;font-weight:bold;padding-top:8px;color:#1c1917">${esc(c.label)}</div>
<div style="font-family:monospace;font-size:13px;letter-spacing:1px;color:#57534e">${esc(c.code)}</div></td></tr></table>`)
    .join("\n");
  return [
    `<tr><td style="font-size:17px;font-weight:bold;padding-top:8px">${esc(t.codesTitle)}</td></tr>`,
    note(esc(t.codesNote)),
    `<tr><td align="center" style="padding-top:16px">${cards}</td></tr>`,
  ];
}

/** Run 54: "Options : Repas × 2 · Gonflables × 2", or nothing. */
const optionsLine = (label: string, addOns: TicketsEmailData["addOns"]) =>
  addOns?.length ? `${label} : ${addOns.map((a) => `${a.name} × ${a.quantity}`).join(" · ")}` : null;

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
  const codes = d.codes?.length ? ["", t.codesText] : [];
  const options = optionsLine(t.options, d.addOns);
  const text = [hello, "", intro, "", d.eventTitle, when, where, count, ...(options ? [options] : []), "", `${t.linkLine}${d.link}`, ...codes, "", t.advice, "", footerText(l, d.brandName, d.look)].join("\n");
  const html = layout(l, d.brandName, t.title(changed), [
    paragraph(`${esc(hello)}<br>${esc(intro)}`),
    box(`<strong>${esc(d.eventTitle)}</strong><br>${esc(when)}<br>${esc(where)}<br>${esc(count)} · ${t.order} ${esc(d.reference)}${options ? `<br>${esc(options)}` : ""}`),
    button(d.link, t.show, d.look),
    ...codeRows(t, d.codes),
    note(esc(t.advice), Boolean(d.codes?.length)),
  ], d.look);
  return { fromName: d.brandName, subject, text, html };
}

// ── Reminder before the session (Run 23) ────────────────────────────────────
export type ReminderEmailData = Omit<TicketsEmailData, "kind">;

const REMINDER = {
  fr: {
    title: "Votre séance approche",
    intro: (ref: string) => `Petit rappel pour votre commande ${ref} : voici l'heure, le lieu et vos billets.`,
    subject: (event: string, when: string) => `Rappel : ${event} — ${when}`,
  },
  en: {
    title: "Your session is coming up",
    intro: (ref: string) => `A quick reminder for your order ${ref}: here are the time, the place and your tickets.`,
    subject: (event: string, when: string) => `Reminder: ${event} — ${when}`,
  },
};

export function reminderEmail(d: ReminderEmailData): Content {
  const l = d.language ?? "fr";
  const t = TICKETS[l];
  const r = REMINDER[l];
  const when = fullDate(l, d.startsAt, d.timezone);
  const where = d.city ? `${d.venueName}, ${d.city}` : d.venueName;
  const count = t.count(d.validTickets);
  const hello = t.hello(d.buyerName);
  const intro = r.intro(d.reference);
  const codes = d.codes?.length ? ["", t.codesText] : [];
  const options = optionsLine(t.options, d.addOns);
  const text = [hello, "", intro, "", d.eventTitle, when, where, count, ...(options ? [options] : []), "", `${t.linkLine}${d.link}`, ...codes, "", t.advice, "", footerText(l, d.brandName, d.look)].join("\n");
  const html = layout(l, d.brandName, r.title, [
    paragraph(`${esc(hello)}<br>${esc(intro)}`),
    box(`<strong>${esc(d.eventTitle)}</strong><br>${esc(when)}<br>${esc(where)}<br>${esc(count)} · ${t.order} ${esc(d.reference)}${options ? `<br>${esc(options)}` : ""}`),
    button(d.link, t.show, d.look),
    ...codeRows(t, d.codes),
    note(esc(t.advice), Boolean(d.codes?.length)),
  ], d.look);
  return { fromName: d.brandName, subject: r.subject(d.eventTitle, when), text, html };
}

// ── Session cancelled ───────────────────────────────────────────────────────
export interface SessionCancelledEmailData {
  /** Run 50: the Brand's logo, colours, contact (and the event's photo). */
  look?: EmailLook | null;
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
  const text = [hello, "", what, "", money, "", t.sorry, "", footerText(l, d.brandName, d.look)].join("\n");
  const html = layout(l, d.brandName, t.title, [
    paragraph(`${esc(hello)}<br>${esc(what)}`),
    box(`${esc(money)}<br><span style="color:#57534e">${t.order} ${esc(d.reference)}</span>`),
    note(esc(t.sorry), true),
  ], d.look);
  return { fromName: d.brandName, subject, text, html };
}

// ── Refund ───────────────────────────────────────────────────────────────────
export interface RefundEmailData {
  /** Run 50: the Brand's logo, colours, contact (and the event's photo). */
  look?: EmailLook | null;
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
  const text = [hello, "", what, t.delay, ...(tickets ? ["", tickets] : []), ...(still ? ["", still] : []), "", footerText(l, d.brandName, d.look)].join("\n");
  const html = layout(l, d.brandName, t.title(amount), [
    paragraph(`${esc(hello)}<br>${esc(what)}`),
    `<tr><td style="font-size:14px;line-height:1.6;padding:12px 16px;background:#fafaf9;border-radius:8px">${esc(t.delay)}${tickets ? `<br>${esc(tickets)}` : ""}<br><span style="color:#57534e">${t.order} ${esc(d.reference)}</span></td></tr>`,
    ...(still ? [button(d.link!, t.show, d.look)] : []),
  ], d.look);
  return { fromName: d.brandName, subject, text, html };
}

// ── Campaigns (Run 42) ──────────────────────────────────────────────────────
export interface CampaignEmailData {
  /** Run 50: the Brand's logo, colours, contact (and the event's photo). */
  look?: EmailLook | null;
  language: Language;
  brandName: string;
  subject: string;
  preheader: string | null;
  heading: string;
  /** Staff's plain text: paragraphs split by blank lines. */
  body: string;
  imageUrl: string | null;
  cta: { label: string; url: string } | null;
  firstName: string | null;
  /** Canada's anti-spam law: who sends, where they are, how to reach them, how to stop. */
  senderAddress: string;
  contact: string;
  unsubscribeUrl: string;
  /** Run 45: what the visit was (a site, an event), for {visite} in an automatic message. */
  visit?: string | null;
}

const CAMPAIGN = {
  fr: {
    why: (brand: string) => `Vous recevez ce courriel parce que vous êtes client de ${brand} ou que vous vous êtes inscrit à ses nouvelles.`,
    stop: "Se désabonner",
    stopText: "Pour ne plus recevoir ces courriels : ",
    contact: "Nous joindre : ",
  },
  en: {
    why: (brand: string) => `You are receiving this e-mail because you are a customer of ${brand} or signed up for its news.`,
    stop: "Unsubscribe",
    stopText: "To stop receiving these e-mails: ",
    contact: "Contact us: ",
  },
};

/**
 * `{prénom}` (or `{prenom}`, `{first_name}`) becomes the customer's first name, or disappears
 * with its space; `{visite}` (or `{visit}`, Run 45) becomes what the visit was, else "votre visite".
 */
export function personalize(text: string, firstName: string | null, visit: string | null = null, language: Language = "fr"): string {
  return text
    .replace(/(\s?)\{(?:prénom|prenom|first_name)\}/giu, (_, space: string) => (firstName ? `${space}${firstName}` : ""))
    .replace(/\{(?:visite|visit)\}/giu, () => visit ?? (language === "en" ? "your visit" : "votre visite"));
}

export function campaignEmail(d: CampaignEmailData): Content {
  const l = d.language;
  const t = CAMPAIGN[l];
  const fill = (text: string) => personalize(text, d.firstName, d.visit ?? null, l);
  const heading = fill(d.heading);
  const paragraphs = fill(d.body).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const footer = `${d.brandName} · ${d.senderAddress}`;
  const text = [heading, "", ...paragraphs.flatMap((p) => [p, ""]), ...(d.cta ? [`${d.cta.label} : ${d.cta.url}`, ""] : []),
    "—", t.why(d.brandName), footer, `${t.contact}${d.contact}`, `${t.stopText}${d.unsubscribeUrl}`].join("\n");
  const rows = [
    ...(d.preheader ? [`<tr><td style="display:none;max-height:0;overflow:hidden;font-size:1px;color:#ffffff">${esc(d.preheader)}</td></tr>`] : []),
    ...(d.imageUrl ? [`<tr><td style="padding-bottom:16px"><img src="${esc(d.imageUrl)}" alt="" width="504" style="display:block;width:100%;max-width:504px;height:auto;border-radius:8px"></td></tr>`] : []),
    ...paragraphs.map((p) => paragraph(esc(p).replace(/\n/g, "<br>"))),
    ...(d.cta ? [button(d.cta.url, d.cta.label, d.look)] : []),
    note(`${esc(t.why(d.brandName))}<br>${esc(footer)}<br>${t.contact}${esc(d.contact)}<br><a href="${esc(d.unsubscribeUrl)}" style="color:#57534e">${t.stop}</a>`, true),
  ];
  return { fromName: d.brandName, subject: fill(d.subject), text, html: layout(l, d.brandName, heading, rows, d.look) };
}

// ── Newsletter sign-up confirmation (Run 44) ────────────────────────────────
export interface NewsletterConfirmEmailData {
  /** Run 50: the Brand's logo, colours, contact (and the event's photo). */
  look?: EmailLook | null;
  language: Language;
  brandName: string;
  firstName: string | null;
  /** The welcome offer, e.g. "5 % sur vos billets". */
  rewardText: string | null;
  link: string;
  senderAddress: string | null;
  contact: string | null;
}

const SIGNUP = {
  fr: {
    subject: (brand: string) => `Confirmez votre inscription — ${brand}`,
    title: "Confirmez votre inscription",
    hello: (name: string | null) => (name ? `Bonjour ${name},` : "Bonjour,"),
    intro: (brand: string, reward: string | null) => `Un clic pour recevoir les nouvelles et les promotions de ${brand}${reward ? `, et votre cadeau de bienvenue : ${reward}` : ""}.`,
    button: "Confirmer mon inscription",
    ignore: "Vous n'avez rien demandé ? Ignorez ce courriel : sans votre clic, vous ne recevrez rien.",
  },
  en: {
    subject: (brand: string) => `Confirm your sign-up — ${brand}`,
    title: "Confirm your sign-up",
    hello: (name: string | null) => (name ? `Hello ${name},` : "Hello,"),
    intro: (brand: string, reward: string | null) => `One click to get ${brand}'s news and offers${reward ? `, and your welcome gift: ${reward}` : ""}.`,
    button: "Confirm my sign-up",
    ignore: "Did not ask for this? Ignore this e-mail: without your click, you will receive nothing.",
  },
};

export function newsletterConfirmEmail(d: NewsletterConfirmEmailData): Content {
  const t = SIGNUP[d.language];
  const hello = t.hello(d.firstName);
  const intro = t.intro(d.brandName, d.rewardText);
  const footer = [d.brandName, d.senderAddress, d.contact].filter(Boolean).join(" · ");
  const text = [hello, "", intro, "", `${t.button} : ${d.link}`, "", t.ignore, "", footer].join("\n");
  const html = layout(d.language, d.brandName, t.title, [
    paragraph(`${esc(hello)}<br>${esc(intro)}`),
    button(d.link, t.button, d.look),
    note(esc(t.ignore)),
    note(esc(footer), true),
  ], d.look);
  return { fromName: d.brandName, subject: t.subject(d.brandName), text, html };
}
