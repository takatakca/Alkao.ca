// ALKAO — the buyer's tickets page (Run 06). The link carries the order and its personal
// token after "#", so it never reaches a server log. The page holds no data of its own: it
// reads the order through the public, gated ALKAO API with that token.
// Run 90b: a ticket wallet. The event's photo, then the tickets as real ticket cards in a
// carousel (or a list, for printing), and a full-screen gate view that keeps the screen awake.
import { html, render, useEffect, useLayoutEffect, useRef, useState } from "/billets/vendor/htm-preact.js";
import qrcode from "/billets/vendor/qrcode.mjs";
import { localeOf, pickLanguage, switchLanguage } from "/billets/i18n.js";
import { calendarFile } from "/billets/calendar.js";

const LANG = pickLanguage();
document.documentElement.lang = LANG === "en" ? "en-CA" : "fr-CA";
const T = {
  fr: {
    errors: {
      order_not_found: "Ce lien n'est plus valide. Utilisez le lien du courriel le plus récent.",
      ticketing_unavailable: "La billetterie de cet organisateur est momentanément indisponible.",
      already_exchanged: "Le changement de séance a déjà été utilisé.",
      ticket_already_used: "Un billet de cette commande est déjà entré : changement impossible.",
      session_not_available: "Cette séance n'est plus disponible.",
      sold_out: "Plus assez de places dans cette séance.",
      add_on_sold_out: "Vos options (repas, activités…) sont complètes pour cette séance. Choisissez une autre date.",
      flex_not_purchased: "Cette commande ne comprend pas l'option de changement de séance.",
      offline: "Pas de réseau. Ouvrez cette page une fois avec du réseau : vos billets resteront ensuite sur cet appareil.",
    },
    generic: "Une erreur est survenue. Réessayez dans un instant.",
    void: { refunded: "Remboursé", cancelled: "Annulé", reissued: "Remplacé par un nouveau billet", admin: "Annulé" },
    voidDefault: "Annulé",
    qrAlt: (id) => `Code QR du billet ${id}`,
    qrSoon: "Code QR bientôt disponible.",
    qrGone: "Ce billet n'a plus de code QR.",
    confirmMove: (when) => `Déplacer vos billets au ${when} ? Ce changement ne peut être fait qu'une fois.`,
    changeTitle: "Changer de séance",
    changeTitleOpen: "Changer de date (billet ouvert)",
    changeAny: "Votre billet ouvert peut changer de date autant de fois que nécessaire, tant qu'il n'est pas entré.",
    confirmMoveOpen: (when) => `Déplacer vos billets au ${when} ? Vous pourrez encore changer de date ensuite.`,
    changeOnce: "Votre commande permet un changement de séance, une seule fois.",
    seeSessions: "Voir les autres séances",
    noSessions: "Aucune autre séance n'a assez de places pour le moment.",
    choose: "Choisir",
    optionsFull: "Options complètes",
    incomplete: "Lien incomplet. Ouvrez le lien reçu par courriel.",
    loading: "Chargement de vos billets…",
    myTickets: "Mes billets",
    order: "Commande",
    pending: "Paiement en cours de confirmation. Rechargez cette page dans un instant.",
    pendingTitle: "Paiement en cours de confirmation",
    pendingBody: "Vos billets apparaîtront ici dès que le paiement sera confirmé. La page se met à jour toute seule.",
    thanks: "Merci ! Votre achat est confirmé : vos billets sont prêts.",
    refundedOrder: "Cette commande a été remboursée : ses billets ne sont plus valides.",
    replaced: "Ces billets ont été remplacés après votre changement de séance. Vos nouveaux billets sont dans le courriel de confirmation du changement.",
    exchanged: "Changement de séance confirmé. Les billets ci-dessous remplacent les anciens.",
    present: (n) => `Présentez le code QR de chaque billet à l'entrée. ${n} billet${n > 1 ? "s" : ""} valide${n > 1 ? "s" : ""}.`,
    ticket: "Billet",
    transferred: "Transféré à un destinataire",
    transferTitle: "Transférer un billet",
    transferIntro: "Le transfert est personnel, gratuit et définitif après acceptation. L’invitation sera préparée pour cette adresse.",
    transferEmail: "Courriel du destinataire",
    transferSend: "Préparer le transfert",
    transferPending: "Invitation en attente d’acceptation",
    transferCancel: "Annuler la demande",
    transferNotice: "Demande enregistrée. Le destinataire doit accepter l’invitation avant de recevoir son billet.",
    transferCancelNotice: "Demande annulée; votre code QR reste valide.",
    footer: "Billetterie ALKAO · Ce lien est personnel : ne le partagez pas.",
    other: "English",
    addToCalendar: "Ajouter à mon calendrier",
    directions: "Itinéraire",
    newTab: " (nouvel onglet)",
    share: "Partager l'événement",
    shared: "Lien de l'événement copié. Vos billets n'y sont pas.",
    shareFailed: "Le lien n'a pas pu être copié.",
    nextSale: "Nouvelle vente à la porte",
    calendarText: (ref, brand) => `${brand} · Commande ${ref}. Vos billets sont dans votre courriel de confirmation.`,
    ticketOf: (i, n) => `Billet ${i} sur ${n}`,
    shown: (i, n) => `Billet affiché : ${i} sur ${n}`,
    wallet: "Vos billets",
    carousel: "carrousel",
    slide: "billet",
    showList: "Voir la liste",
    showOne: "Un à la fois",
    print: "Imprimer les billets",
    pick: (i) => `Afficher le billet ${i}`,
    ticketNo: "N° du billet",
    date: "Date",
    time: "Heure",
    fullscreen: "Plein écran pour l'entrée",
    gateTip: "Montez la luminosité de votre écran.",
    gateAwake: "L'écran reste allumé",
    previous: "Billet précédent",
    next: "Billet suivant",
    previousShort: "Précédent",
    nextShort: "Suivant",
    close: "Fermer",
    zoomPhoto: "Agrandir la photo de l'événement",
    photo: "Photo de l'événement",
    photoAlt: (title) => `Photo de l'événement ${title}`,
    zoomIn: "Zoom avant",
    zoomOut: "Zoom arrière",
    zoomTip: "Molette, pincement ou double-clic pour zoomer.",
    contact: "Une question ?",
    policyTitle: "Politique d'échange et de remboursement",
    valid: "Valide",
    offline: (d) => `Hors ligne : voici vos billets tels qu'enregistrés sur cet appareil le ${d}. Présentez-les normalement à l'entrée.`,
    kept: "Billets enregistrés sur cet appareil : ils s'afficheront même sans réseau.",
    options: "Vos options",
    optionsTip: "Montrez cette page pour les recevoir sur place.",
    optionRight: "Droit de changer de séance, rien à recevoir sur place",
  },
  en: {
    errors: {
      order_not_found: "This link no longer works. Use the link from your most recent email.",
      ticketing_unavailable: "This organizer's ticketing is temporarily unavailable.",
      already_exchanged: "The session change has already been used.",
      ticket_already_used: "A ticket of this order has already entered: no change is possible.",
      session_not_available: "This session is no longer available.",
      sold_out: "Not enough seats left in this session.",
      add_on_sold_out: "Your options (meals, activities…) are sold out for this session. Pick another date.",
      flex_not_purchased: "This order does not include the session change option.",
      offline: "No network. Open this page once with a network: your tickets will then stay on this device.",
    },
    generic: "Something went wrong. Please try again in a moment.",
    void: { refunded: "Refunded", cancelled: "Cancelled", reissued: "Replaced by a new ticket", admin: "Cancelled" },
    voidDefault: "Cancelled",
    qrAlt: (id) => `QR code of ticket ${id}`,
    qrSoon: "QR code coming soon.",
    qrGone: "This ticket no longer has a QR code.",
    confirmMove: (when) => `Move your tickets to ${when}? This change can be made only once.`,
    changeTitle: "Change session",
    changeTitleOpen: "Change date (open-date ticket)",
    changeAny: "Your open-date ticket can change date as often as needed, until it has been used.",
    confirmMoveOpen: (when) => `Move your tickets to ${when}? You can still change the date afterwards.`,
    changeOnce: "Your order allows one session change.",
    seeSessions: "See other sessions",
    noSessions: "No other session has enough seats right now.",
    choose: "Choose",
    optionsFull: "Options sold out",
    incomplete: "Incomplete link. Open the link from your email.",
    loading: "Loading your tickets…",
    myTickets: "My tickets",
    order: "Order",
    pending: "Payment is being confirmed. Reload this page in a moment.",
    pendingTitle: "Payment being confirmed",
    pendingBody: "Your tickets will appear here as soon as the payment is confirmed. This page updates by itself.",
    thanks: "Thank you! Your purchase is confirmed: your tickets are ready.",
    refundedOrder: "This order was refunded: its tickets are no longer valid.",
    replaced: "These tickets were replaced after your session change. Your new tickets are in the change confirmation email.",
    exchanged: "Session change confirmed. The tickets below replace the old ones.",
    present: (n) => `Show each ticket's QR code at the entrance. ${n} valid ticket${n > 1 ? "s" : ""}.`,
    ticket: "Ticket",
    transferred: "Transferred to recipient",
    transferTitle: "Transfer a ticket",
    transferIntro: "Transfers are personal, free and final once accepted. An invitation will be prepared for this address.",
    transferEmail: "Recipient email address",
    transferSend: "Prepare transfer",
    transferPending: "Invitation awaiting acceptance",
    transferCancel: "Cancel request",
    transferNotice: "Request saved. The recipient must accept the invitation before receiving the ticket.",
    transferCancelNotice: "Request cancelled; your QR code remains valid.",
    footer: "ALKAO Ticketing · This link is personal: do not share it.",
    other: "Français",
    addToCalendar: "Add to my calendar",
    directions: "Directions",
    newTab: " (new tab)",
    share: "Share the event",
    shared: "Event link copied. Your tickets are not in it.",
    shareFailed: "The link could not be copied.",
    nextSale: "Next door sale",
    calendarText: (ref, brand) => `${brand} · Order ${ref}. Your tickets are in your confirmation email.`,
    ticketOf: (i, n) => `Ticket ${i} of ${n}`,
    shown: (i, n) => `Showing ticket ${i} out of ${n}`,
    wallet: "Your tickets",
    carousel: "carousel",
    slide: "ticket",
    showList: "See the list",
    showOne: "One at a time",
    print: "Print the tickets",
    pick: (i) => `Show ticket ${i}`,
    ticketNo: "Ticket no.",
    date: "Date",
    time: "Time",
    fullscreen: "Full screen for the entrance",
    gateTip: "Turn your screen brightness up.",
    gateAwake: "Screen stays on",
    previous: "Previous ticket",
    next: "Next ticket",
    previousShort: "Previous",
    nextShort: "Next",
    close: "Close",
    zoomPhoto: "Enlarge the event photo",
    photo: "Event photo",
    photoAlt: (title) => `Photo of the event ${title}`,
    zoomIn: "Zoom in",
    zoomOut: "Zoom out",
    zoomTip: "Wheel, pinch or double-click to zoom.",
    contact: "Questions?",
    policyTitle: "Exchange and refund policy",
    valid: "Valid",
    offline: (d) => `Offline: here are your tickets as saved on this device on ${d}. Show them at the entrance as usual.`,
    kept: "Tickets saved on this device: they will show even without a network.",
    options: "Your options",
    optionsTip: "Show this page to receive them on site.",
    optionRight: "Right to change session, nothing to pick up on site",
  },
}[LANG];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const link = (() => {
  const p = new URLSearchParams(location.hash.slice(1));
  const l = { c: p.get("c"), b: p.get("b"), o: p.get("o"), k: p.get("k"), door: p.get("porte") === "1" };
  return UUID.test(l.c ?? "") && UUID.test(l.b ?? "") && UUID.test(l.o ?? "") && /^[A-Za-z0-9_-]{20,100}$/.test(l.k ?? "") ? l : null;
})();
const base = link && `/v1/public/clients/${link.c}/brands/${link.b}`;

async function call(path, { method = "GET", body, token } = {}) {
  let res;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: { "x-alkao-order-token": token, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new Error("offline");
  }
  const data = await res.json().catch(() => null);
  // A page from a proxy instead of ALKAO's JSON: the server cannot be reached either.
  if (!res.ok) throw new Error(data?.error?.code ?? (res.status >= 500 ? "offline" : "error"));
  return data;
}

// Run 51: the tickets stay on this device, so they show without a network at the gate.
// Not on a door-sale device (the staff's own), never while payment is confirming, and
// forgotten two days after the session.
const SAVED = "alkao.billets.";
const KEEP_MS = 2 * 86_400_000;
function forgetPastTickets() {
  try {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(SAVED)) continue;
      const kept = JSON.parse(localStorage.getItem(key) ?? "null");
      const end = Date.parse(kept?.order?.event?.endsAt ?? kept?.order?.event?.startsAt ?? "");
      if (!(end + KEEP_MS > Date.now())) localStorage.removeItem(key);
    }
  } catch {}
}
function keepTickets(order) {
  if (link.door || order.status === "pending_payment") return false;
  try {
    localStorage.setItem(SAVED + link.o, JSON.stringify({ k: link.k, savedAt: new Date().toISOString(), order }));
    return true;
  } catch {
    return false;
  }
}
function keptTickets() {
  try {
    const kept = JSON.parse(localStorage.getItem(SAVED + link.o) ?? "null");
    return kept && kept.k === link.k ? kept : null;
  } catch {
    return null;
  }
}
const message = (e) => T.errors[e.message] ?? T.generic;

// The QR code exactly as before (8 px per module, a 2-module margin); the white field
// around it on the page completes the quiet zone. Made once per credential.
const QR = new Map();
function qrDataUrl(payload) {
  if (!QR.has(payload)) {
    const qr = qrcode(0, "M");
    qr.addData(payload);
    qr.make();
    QR.set(payload, qr.createDataURL(8, 2));
  }
  return QR.get(payload);
}

const zone = (tz) => tz || "America/Toronto";
const fmt = (options, tz) => new Intl.DateTimeFormat(localeOf(LANG), { ...options, timeZone: zone(tz) });
function whenFr(iso, timeZone) {
  return fmt({ dateStyle: "full", timeStyle: "short" }, timeZone).format(new Date(iso));
}
const capital = (s) => s.charAt(0).toLocaleUpperCase(localeOf(LANG)) + s.slice(1);
/** "18 h 00 – 23 h 00" when the session ends the same day, else its start. */
function hours(event, tz) {
  const time = fmt({ timeStyle: "short" }, tz);
  const start = new Date(event.startsAt);
  const end = event.endsAt ? new Date(event.endsAt) : null;
  const day = fmt({ dateStyle: "short" }, tz);
  if (end && end > start && day.format(start) === day.format(end) && time.formatRange) {
    try { return time.formatRange(start, end); } catch {}
  }
  return time.format(start);
}
const isValid = (t) => t.status === "valid" && !t.transferred;
const reducedMotion = () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
const EASE = "cubic-bezier(.2, .7, .2, 1)";
const insetOf = (r) => {
  const w = document.documentElement.clientWidth;
  const h = document.documentElement.clientHeight;
  return `inset(${r.top}px ${w - r.right}px ${h - r.bottom}px ${r.left}px round 18px)`;
};
/** The transform that puts an element laid out at `to` over the rectangle `from`. */
const flip = (from, to) =>
  `translate(${from.left + from.width / 2 - (to.left + to.width / 2)}px, ${from.top + from.height / 2 - (to.top + to.height / 2)}px) scale(${from.width / to.width})`;
const FOCUSABLE = "button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex='-1'])";
/** Tab and Shift+Tab stay inside a dialog. */
function trapFocus(e, box) {
  if (e.key !== "Tab" || !box) return;
  const all = [...box.querySelectorAll(FOCUSABLE)];
  if (!all.length) return;
  const first = all[0];
  const last = all[all.length - 1];
  if (e.shiftKey && (document.activeElement === first || !box.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (document.activeElement === last || !box.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
}

// Line icons, drawn for this page (24 × 24, one stroke). Always decorative: hidden from
// assistive technologies, the text next to them says what they mean.
const ICONS = {
  calendar: "M6 5h12a2.5 2.5 0 0 1 2.5 2.5v10.5a2.5 2.5 0 0 1-2.5 2.5H6a2.5 2.5 0 0 1-2.5-2.5V7.5A2.5 2.5 0 0 1 6 5zM3.5 9.5h17M8 3v4M16 3v4",
  calendarPlus: "M6 5h12a2.5 2.5 0 0 1 2.5 2.5v10.5a2.5 2.5 0 0 1-2.5 2.5H6a2.5 2.5 0 0 1-2.5-2.5V7.5A2.5 2.5 0 0 1 6 5zM3.5 9.5h17M8 3v4M16 3v4M12 12.5v5M9.5 15h5",
  clock: "M3.5 12a8.5 8.5 0 1 0 17 0a8.5 8.5 0 1 0-17 0M12 7.5V12l3 2",
  pin: "M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11zM9.5 10a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0",
  route: "M12 2.8 21.2 12 12 21.2 2.8 12zM9.5 14.5V12a1.5 1.5 0 0 1 1.5-1.5h4.5M13 8l2.5 2.5L13 13",
  share: "M12 3.5v11M7.5 8 12 3.5 16.5 8M5 12.5v6A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5v-6",
  expand: "M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5",
  list: "M5 4h14a1.5 1.5 0 0 1 1.5 1.5v3A1.5 1.5 0 0 1 19 10H5a1.5 1.5 0 0 1-1.5-1.5v-3A1.5 1.5 0 0 1 5 4zM5 14h14a1.5 1.5 0 0 1 1.5 1.5v3A1.5 1.5 0 0 1 19 20H5a1.5 1.5 0 0 1-1.5-1.5v-3A1.5 1.5 0 0 1 5 14z",
  cards: "M8.5 4h7a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM3 7.5v9M21 7.5v9",
  left: "M14.5 6l-6 6 6 6",
  right: "M9.5 6l6 6-6 6",
  close: "M6 6l12 12M18 6L6 18",
  sun: "M8 12a4 4 0 1 0 8 0a4 4 0 1 0-8 0M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4",
  check: "M5 12.5l4.5 4.5L19 7.5",
  saved: "M3.5 12a8.5 8.5 0 1 0 17 0a8.5 8.5 0 1 0-17 0M8.5 12.3l2.4 2.4 4.6-4.9",
  offline: "M3 3l18 18M8.5 16.5a5 5 0 0 1 7 0M5 12.9a10 10 0 0 1 4.6-2.6M14.4 10.3A10 10 0 0 1 19 12.9M2 9.3a15 15 0 0 1 4.3-2.8M10 5.6A15 15 0 0 1 22 9.3M12 20h.01",
  globe: "M3.5 12a8.5 8.5 0 1 0 17 0a8.5 8.5 0 1 0-17 0M3.5 12h17M12 3.5c2.4 2.5 3.6 5.3 3.6 8.5s-1.2 6-3.6 8.5c-2.4-2.5-3.6-5.3-3.6-8.5s1.2-6 3.6-8.5z",
  mail: "M5.5 5.5h13A2.5 2.5 0 0 1 21 8v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16V8a2.5 2.5 0 0 1 2.5-2.5zM4 7.5l8 5.5 8-5.5",
  phone: "M6.6 3.5h2.6l1.4 4-2 1.3a11 11 0 0 0 6.6 6.6l1.3-2 4 1.4v2.6a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.6 5.7a2 2 0 0 1 2-2.2z",
  lock: "M7.5 10.5h9a2.5 2.5 0 0 1 2.5 2.5v5a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 5 18v-5a2.5 2.5 0 0 1 2.5-2.5zM8 10.5V8a4 4 0 0 1 8 0v2.5",
  swap: "M4 8h14l-3.5-3.5M20 16H6l3.5 3.5",
  bag: "M5 8h14l-1 12.5H6L5 8zM9 8V6.5a3 3 0 0 1 6 0V8",
  send: "M21 3L10.5 13.5M21 3l-6.5 18-4-7.5L3 9.5 21 3z",
  print: "M7 9V3.5h10V9M7 17H5.5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H17M7 14h10v6.5H7z",
  zoomIn: "M4.5 11a6.5 6.5 0 1 0 13 0a6.5 6.5 0 1 0-13 0M20 20l-4.3-4.3M11 8.5v5M8.5 11h5",
  zoomOut: "M4.5 11a6.5 6.5 0 1 0 13 0a6.5 6.5 0 1 0-13 0M20 20l-4.3-4.3M8.5 11h5",
  ticket: "M3.5 8a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4V8zM14.5 6v2M14.5 11v2M14.5 16v2",
  info: "M3.5 12a8.5 8.5 0 1 0 17 0a8.5 8.5 0 1 0-17 0M12 11v5M12 7.6v.4",
  store: "M4 9.5 5.5 4h13L20 9.5M4 9.5h16M4 9.5a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0 2.7 2.7 0 0 0 5.3 0M5.5 12v8h13v-8M10 20v-4.5h4V20",
};
const Icon = (name, cls = "") => html`<svg class=${`i ${cls}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d=${ICONS[name]} /></svg>`;

/** Run 69: an event without its own photo shows its category's photo (as on the ALKAO home). */
const CATEGORY_PHOTOS = {
  concerts: "cat-concerts", festivals: "cat-festivals", sports: "cat-sports", famille: "cat-family",
  "plein-air": "cat-camping", spectacles: "cat-shows", soirees: "cat-nightlife", experiences: "cat-live",
};
const categoryPhoto = (category) => `/assets/home/img/${CATEGORY_PHOTOS[category] ?? "event-fallback"}.webp`;

/** One ticket: the stub in the Brand's colour, the perforation, the QR code on white. */
function Ticket({ t, name, index, count, stub, current, onGate }) {
  const valid = isValid(t);
  const field = useRef(null);
  const scannable = valid && t.credential;
  const open = () => onGate(t, field.current);
  // The slide is what the carousel snaps to; the card inside it moves (snapping ignores that).
  return html`<div class=${`slide${current ? " is-current" : ""}`} role="group" aria-roledescription=${T.slide}
      aria-label=${T.ticketOf(index + 1, count)} data-ticket=${t.id} tabindex="-1"><div class=${`ticket${valid ? "" : " void"}`}>
    <div class="ticket-band">
      <span class="ticket-count">${T.ticketOf(index + 1, count)}</span>
      <span class="type">${name}</span>
      <dl class="stub-meta">
        <div><dt>${T.date}</dt><dd>${stub.date}</dd></div>
        <div><dt>${T.time}</dt><dd>${stub.time}</dd></div>
      </dl>
    </div>
    <div class="ticket-body">
      ${scannable
        ? html`<div class="qr-field" ref=${field} onClick=${open}><img class="qr" src=${qrDataUrl(t.credential)} alt=${T.qrAlt(t.id.slice(0, 8))} draggable="false" /></div>`
        : html`<div class="qr-field is-empty">${Icon(valid ? "clock" : "ticket")}<p>${valid ? T.qrSoon : T.qrGone}</p></div>`}
      <div class="ticket-meta">
        <p class="ticket-no"><span>${T.ticketNo}</span><code>${t.id.slice(0, 8).toUpperCase()}</code></p>
        ${valid ? html`<span class="badge ok">${Icon("check")}${T.valid}</span>`
          : html`<span class="badge bad">${t.transferred ? T.transferred : (T.void[t.voidReason] ?? T.voidDefault)}</span>`}
      </div>
      ${scannable && html`<button type="button" class="gate-open noprint" onClick=${open}>${Icon("expand")}${T.fullscreen}</button>`}
    </div>
  </div></div>`;
}

/**
 * Run 90b: the tickets, one at a time in a carousel (swipe, arrows, dots, keyboard) or all
 * stacked in a list, for printing or showing to companions. `api` lets the page bring a
 * ticket back into view when the gate view closes.
 */
function Wallet({ o, names, stub, kept, api, onGate }) {
  const tickets = o.tickets;
  const count = tickets.length;
  const many = count > 1;
  const validCount = tickets.filter(isValid).length;
  const [index, setIndex] = useState(0);
  const [list, setList] = useState(false);
  const track = useRef(null);
  const behavior = (smooth) => (smooth && !reducedMotion() ? "smooth" : "auto");
  const go = (i, smooth = true) => {
    const el = track.current;
    const n = Math.max(0, Math.min(count - 1, i));
    const slide = el?.children[n];
    if (!slide) return null;
    if (list) slide.scrollIntoView({ block: "nearest", behavior: behavior(smooth) });
    else el.scrollTo({ left: slide.offsetLeft - (el.clientWidth - slide.offsetWidth) / 2, behavior: behavior(smooth) });
    setIndex(n);
    return slide;
  };
  api.current = { reveal: (id) => go(tickets.findIndex((t) => t.id === id), false) };

  // The ticket closest to the middle is the current one, whether it got there by swipe, wheel or button.
  useEffect(() => {
    const el = track.current;
    if (!el || list || !many) return;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const middle = el.scrollLeft + el.clientWidth / 2;
        let best = 0;
        let distance = Infinity;
        [...el.children].forEach((slide, k) => {
          const d = Math.abs(slide.offsetLeft + slide.offsetWidth / 2 - middle);
          if (d < distance) { distance = d; best = k; }
        });
        setIndex(best);
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => { el.removeEventListener("scroll", onScroll); cancelAnimationFrame(frame); };
  }, [list, many]);
  // Back from the list: the carousel shows the ticket that was current.
  useLayoutEffect(() => { if (!list && many) go(index, false); }, [list]);

  const step = (d) => {
    const inside = track.current?.contains(document.activeElement);
    const slide = go(index + d);
    // Keyboard users keep their place: the focus follows to the ticket now shown.
    if (inside && slide) slide.focus({ preventScroll: true });
  };
  const onKeyDown = (e) => {
    if (list || !many || e.altKey || e.ctrlKey || e.metaKey || e.target.closest?.("input, textarea, select")) return;
    if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
    if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
  };
  return html`<section class=${`wallet${list ? " is-list" : ""}`} aria-labelledby="wallet-title"
      aria-roledescription=${many ? T.carousel : undefined} onKeyDown=${onKeyDown}>
    <div class="wallet-head">
      <div>
        <h2 id="wallet-title">${T.wallet}</h2>
        ${validCount > 0 && html`<p class="present">${T.present(validCount)}</p>`}
      </div>
      ${many && html`<button type="button" class="pill noprint" onClick=${() => setList(!list)}>${Icon(list ? "cards" : "list")}${list ? T.showOne : T.showList}</button>`}
    </div>
    <div class="wallet-track" ref=${track}>
      ${tickets.map((t, k) => html`<${Ticket} key=${t.id} t=${t} name=${names.get(t.ticketTypeId) ?? T.ticket} index=${k} count=${count}
        stub=${stub} current=${list || k === index} onGate=${onGate} />`)}
    </div>
    ${many && !list && html`<div class="wallet-controls noprint">
      <button type="button" class="nav" aria-label=${T.previous} disabled=${index === 0} onClick=${() => step(-1)}>${Icon("left")}</button>
      <div class="dots">${tickets.map((t, k) => html`<button type="button" class="dot" key=${t.id} aria-label=${T.pick(k + 1)}
        aria-current=${k === index ? "true" : undefined} onClick=${() => go(k)}></button>`)}</div>
      <p class="wallet-count"><span aria-hidden="true">${index + 1} / ${count}</span><span class="sr-only" aria-live="polite">${T.shown(index + 1, count)}</span></p>
      <button type="button" class="nav" aria-label=${T.next} disabled=${index === count - 1} onClick=${() => step(1)}>${Icon("right")}</button>
    </div>`}
    ${list && html`<p class="list-actions noprint"><button type="button" class="pill" onClick=${() => globalThis.print()}>${Icon("print")}${T.print}</button></p>`}
    ${kept && html`<p class="kept noprint">${Icon("saved")}${T.kept}</p>`}
  </section>`;
}

/**
 * Run 50, Run 90b: at the gate, one ticket at a time, as large as the screen allows, on white.
 * The screen is kept awake while it is shown (where the browser can); arrows, swipe or the
 * buttons for the next ticket, Escape or "Fermer" to close. It opens from the ticket card.
 */
function GateMode({ tickets, names, start, from, event, reveal, onClose }) {
  const [i, setI] = useState(start);
  const [dir, setDir] = useState(0);
  const [awake, setAwake] = useState(false);
  const dialog = useRef(null);
  const closeButton = useRef(null);
  const stage = useRef(null);
  const qr = useRef(null);
  const at = useRef(start);
  const closing = useRef(false);
  const touch = useRef(null);
  at.current = i;
  const n = tickets.length;
  const t = tickets[i];
  const move = (d) => {
    const next = Math.max(0, Math.min(n - 1, at.current + d));
    if (next === at.current) return;
    at.current = next;
    setDir(d);
    setI(next);
  };
  const close = () => {
    if (closing.current) return;
    closing.current = true;
    const done = () => onClose(tickets[at.current].id);
    const el = dialog.current;
    const target = reveal(tickets[at.current].id)?.querySelector(".qr-field");
    if (reducedMotion() || !el?.animate) return done();
    const r = target?.getBoundingClientRect();
    const seen = r && r.width > 0 && r.bottom > 0 && r.top < document.documentElement.clientHeight;
    const options = { duration: seen ? 320 : 200, easing: EASE, fill: "forwards" };
    const anim = seen
      ? el.animate([{ clipPath: "inset(0px 0px 0px 0px round 0px)" }, { clipPath: insetOf(r) }], options)
      : el.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(.98)" }], options);
    const code = qr.current;
    if (seen && code) code.animate([{ transform: "none" }, { transform: flip(r, code.getBoundingClientRect()) }], options);
    anim.finished.then(done, done);
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  // It grows out of the ticket card: the white page opens from the card and the code follows.
  useLayoutEffect(() => {
    const el = dialog.current;
    if (!from || reducedMotion() || !el?.animate) return;
    const options = { duration: 420, easing: EASE };
    el.animate([{ clipPath: insetOf(from) }, { clipPath: "inset(0px 0px 0px 0px round 0px)" }], options);
    const to = qr.current?.getBoundingClientRect();
    if (to?.width) qr.current.animate([{ transform: flip(from, to) }, { transform: "none" }], options);
  }, []);

  useEffect(() => {
    // Each call is optional: older phones have no wake lock, iPhones no page full screen.
    const quietly = (fn) => { try { Promise.resolve(fn()).catch(() => {}); } catch {} };
    let lock = null;
    let open = true;
    const keepAwake = async () => {
      if (!open || lock || document.visibilityState !== "visible" || typeof navigator.wakeLock?.request !== "function") return;
      try {
        const l = await navigator.wakeLock.request("screen");
        if (!open) { quietly(() => l.release()); return; }
        lock = l;
        setAwake(true);
        l.addEventListener?.("release", () => { if (lock === l) lock = null; if (open) setAwake(false); });
      } catch {
        if (open) setAwake(false);
      }
    };
    // The screen lock ends when the page is hidden; take it again when the buyer comes back.
    const onVisible = () => { if (document.visibilityState === "visible") void keepAwake(); };
    void keepAwake();
    quietly(() => document.documentElement.requestFullscreen?.());
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButton.current?.focus({ preventScroll: true });
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); closeRef.current(); }
      if (e.key === "ArrowRight") move(1);
      if (e.key === "ArrowLeft") move(-1);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      open = false;
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("visibilitychange", onVisible);
      document.body.style.overflow = overflow;
      const l = lock;
      lock = null;
      if (l) quietly(() => l.release());
      if (document.fullscreenElement) quietly(() => document.exitFullscreen?.());
    };
  }, []);
  // A button that just became disabled (first or last ticket) gives the focus to the other one.
  useEffect(() => {
    const box = dialog.current;
    if (box && !box.contains(document.activeElement)) (box.querySelector(".gate-arrow:not([disabled])") ?? closeButton.current)?.focus({ preventScroll: true });
  }, [i]);

  const onTouchStart = (e) => { const p = e.touches[0]; touch.current = { x: p.clientX, y: p.clientY, dx: 0, axis: null }; };
  const onTouchMove = (e) => {
    const s = touch.current;
    const el = stage.current;
    if (!s || !el) return;
    const p = e.touches[0];
    const dx = p.clientX - s.x;
    const dy = p.clientY - s.y;
    if (!s.axis && Math.abs(dx) + Math.abs(dy) > 8) s.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
    if (s.axis !== "x") return;
    const edge = (dx > 0 && at.current === 0) || (dx < 0 && at.current === n - 1);
    s.dx = dx;
    el.style.transform = `translateX(${edge ? dx * 0.25 : dx}px)`;
  };
  const onTouchEnd = () => {
    const s = touch.current;
    const el = stage.current;
    touch.current = null;
    if (!s || !el) return;
    el.style.transform = "";
    if (s.dx < -50) move(1);
    else if (s.dx > 50) move(-1);
    else if (s.axis === "x" && !reducedMotion() && el.animate) el.animate([{ transform: `translateX(${s.dx}px)` }, { transform: "none" }], { duration: 220, easing: EASE });
  };
  const short = t.id.slice(0, 8).toUpperCase();
  return html`<div class="gate" role="dialog" aria-modal="true" aria-label=${T.ticketOf(i + 1, n)} ref=${dialog}
      onKeyDown=${(e) => trapFocus(e, dialog.current)}>
    <div class="gate-top">
      <div class="gate-event">
        <p class="gate-title">${event.title}</p>
        <p class="gate-when">${event.when}</p>
      </div>
      <button type="button" class="gate-close" ref=${closeButton} onClick=${close}>${Icon("close")}<span>${T.close}</span></button>
    </div>
    <div class="gate-stage" ref=${stage} onTouchStart=${onTouchStart} onTouchMove=${onTouchMove} onTouchEnd=${onTouchEnd} onTouchCancel=${onTouchEnd}>
      <div class=${`gate-ticket${dir > 0 ? " from-next" : dir < 0 ? " from-prev" : ""}`} key=${t.id}>
        <p class="gate-count">${T.ticketOf(i + 1, n)}</p>
        <p class="gate-type">${names.get(t.ticketTypeId) ?? T.ticket}</p>
        <div class="gate-qr-field"><img class="gate-qr" ref=${qr} src=${qrDataUrl(t.credential)} alt=${T.qrAlt(t.id.slice(0, 8))} draggable="false" /></div>
        <p class="gate-code"><code>${short}</code></p>
      </div>
    </div>
    <div class="gate-bottom">
      <p class="gate-tip">${Icon("sun")}<span>${T.gateTip}</span>${awake && html`<span class="gate-awake">${Icon("check")}${T.gateAwake}</span>`}</p>
      ${n > 1 && html`<div class="gate-nav">
        <button type="button" class="gate-arrow" aria-label=${T.previous} disabled=${i === 0} onClick=${() => move(-1)}>${Icon("left")}<span>${T.previousShort}</span></button>
        <div class="pips" aria-hidden="true">${tickets.map((x, k) => html`<span class=${`pip${k === i ? " is-on" : ""}`} key=${x.id}></span>`)}</div>
        <button type="button" class="gate-arrow" aria-label=${T.next} disabled=${i === n - 1} onClick=${() => move(1)}><span>${T.nextShort}</span>${Icon("right")}</button>
      </div>`}
    </div>
  </div>`;
}

/**
 * The event's own photo, full screen: wheel, pinch or double-click to zoom, drag to look
 * around once zoomed, Escape or "Fermer" to close.
 */
function Lightbox({ src, title, onClose }) {
  const box = useRef(null);
  const stage = useRef(null);
  const img = useRef(null);
  const closeButton = useRef(null);
  const view = useRef({ s: 1, x: 0, y: 0 });
  const pointers = useRef(new Map());
  const set = (s, x, y, smooth = true) => {
    const el = img.current;
    if (!el) return;
    s = Math.min(4, Math.max(1, s));
    const mx = (el.offsetWidth * (s - 1)) / 2;
    const my = (el.offsetHeight * (s - 1)) / 2;
    view.current = { s, x: Math.max(-mx, Math.min(mx, x)), y: Math.max(-my, Math.min(my, y)) };
    el.classList.toggle("is-direct", !smooth);
    el.style.transform = `translate(${view.current.x}px, ${view.current.y}px) scale(${s})`;
    stage.current?.classList.toggle("is-zoomed", s > 1.01);
  };
  /** Zoom by `k` around the screen point (cx, cy), which stays under the finger or the pointer. */
  const zoomAt = (k, cx, cy, smooth = true) => {
    const el = img.current;
    const st = stage.current?.getBoundingClientRect();
    if (!el || !st) return;
    const { s, x, y } = view.current;
    const ox = st.left + el.offsetLeft + el.offsetWidth / 2;
    const oy = st.top + el.offsetTop + el.offsetHeight / 2;
    const s2 = Math.min(4, Math.max(1, s * k));
    set(s2, cx - ox - (s2 / s) * (cx - ox - x), cy - oy - (s2 / s) * (cy - oy - y), smooth);
  };
  const middle = () => {
    const st = stage.current.getBoundingClientRect();
    return [st.left + st.width / 2, st.top + st.height / 2];
  };
  useEffect(() => {
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButton.current?.focus({ preventScroll: true });
    const onKey = (e) => {
      const { s, x, y } = view.current;
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
      else if (e.key === "+" || e.key === "=") zoomAt(1.5, ...middle());
      else if (e.key === "-") zoomAt(1 / 1.5, ...middle());
      else if (e.key === "0") set(1, 0, 0);
      else if (s > 1 && e.key.startsWith("Arrow")) {
        e.preventDefault();
        const d = 60;
        set(s, x + (e.key === "ArrowLeft" ? d : e.key === "ArrowRight" ? -d : 0), y + (e.key === "ArrowUp" ? d : e.key === "ArrowDown" ? -d : 0));
      }
    };
    const onWheel = (e) => { e.preventDefault(); zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY, false); };
    const el = stage.current;
    document.addEventListener("keydown", onKey);
    el?.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      document.removeEventListener("keydown", onKey);
      el?.removeEventListener("wheel", onWheel);
      document.body.style.overflow = overflow;
    };
  }, []);
  const onPointerDown = (e) => {
    stage.current?.setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
  };
  const onPointerMove = (e) => {
    const all = pointers.current;
    const before = all.get(e.pointerId);
    if (!before) return;
    if (all.size === 2) {
      const other = [...all.entries()].find(([id]) => id !== e.pointerId)[1];
      const d0 = Math.hypot(before.x - other.x, before.y - other.y);
      const d1 = Math.hypot(e.clientX - other.x, e.clientY - other.y);
      if (d0 > 0) zoomAt(d1 / d0, (e.clientX + other.x) / 2, (e.clientY + other.y) / 2, false);
    } else if (all.size === 1 && view.current.s > 1) {
      const { s, x, y } = view.current;
      set(s, x + e.clientX - before.x, y + e.clientY - before.y, false);
      stage.current?.classList.add("is-panning");
    }
    all.set(e.pointerId, { x: e.clientX, y: e.clientY });
  };
  const onPointerUp = (e) => {
    pointers.current.delete(e.pointerId);
    if (!pointers.current.size) stage.current?.classList.remove("is-panning");
  };
  return html`<div class="lightbox" role="dialog" aria-modal="true" aria-label=${T.photo} ref=${box} onKeyDown=${(e) => trapFocus(e, box.current)}>
    <div class="lb-bar">
      <p class="lb-title">${title}</p>
      <button type="button" class="lb-btn" aria-label=${T.zoomOut} onClick=${() => zoomAt(1 / 1.5, ...middle())}>${Icon("zoomOut")}</button>
      <button type="button" class="lb-btn" aria-label=${T.zoomIn} onClick=${() => zoomAt(1.5, ...middle())}>${Icon("zoomIn")}</button>
      <button type="button" class="lb-close" ref=${closeButton} onClick=${onClose}>${Icon("close")}<span>${T.close}</span></button>
    </div>
    <div class="lb-stage" ref=${stage} onPointerDown=${onPointerDown} onPointerMove=${onPointerMove} onPointerUp=${onPointerUp} onPointerCancel=${onPointerUp}
        onDblClick=${(e) => (view.current.s > 1 ? set(1, 0, 0) : zoomAt(2.5, e.clientX, e.clientY))}>
      <img class="lb-img" ref=${img} src=${src} alt=${T.photoAlt(title)} draggable="false" />
    </div>
    <p class="lb-tip">${T.zoomTip}</p>
  </div>`;
}

/** Run 50: the Brand's colour, when it has one (checked again here: #rrggbb only). */
function applyLook(brand) {
  const hex = /^#[0-9a-f]{6}$/i;
  const root = document.documentElement.style;
  if (hex.test(brand?.accentColor ?? "") && hex.test(brand?.onAccentColor ?? "")) {
    root.setProperty("--accent", brand.accentColor);
    root.setProperty("--on-accent", brand.onAccentColor);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", brand.accentColor);
  }
}
const https = (u) => (typeof u === "string" && /^https:\/\/[^\s"'<>\\]+$/.test(u) ? u : null);

/** The logo, or the Brand's name when the image cannot be shown. */
function Logo({ src, name }) {
  const [failed, setFailed] = useState(false);
  return failed ? html`<p class="brand">${name}</p>` : html`<img class="logo" src=${src} alt=${name} onError=${() => setFailed(true)} />`;
}

function Lang() {
  return html`<p class="lang noprint"><button type="button" class="link" onClick=${() => switchLanguage(LANG === "en" ? "fr" : "en")}>${T.other}</button></p>`;
}

/** The event: its photo (or its category's), title, date, hours and venue, and the order. */
function Hero({ o, image, own, onZoom }) {
  const [loaded, setLoaded] = useState(null);
  const [failed, setFailed] = useState(null);
  const tz = o.event.venue.timezone;
  const chips = [
    ["calendar", capital(fmt({ dateStyle: "full" }, tz).format(new Date(o.event.startsAt)))],
    ["clock", hours(o.event, tz)],
    ["pin", [o.event.venue.name, o.event.venue.city].filter(Boolean).join(", ")],
  ].filter(([, text]) => text);
  const show = image && failed !== image;
  const photo = show && html`<img class=${`photo${loaded === image ? " is-loaded" : ""}`} key=${image} src=${image} alt=""
    onLoad=${() => setLoaded(image)} onError=${() => setFailed(image)} />`;
  return html`<section class="hero" aria-labelledby="event-title">
    <div class="hero-media">
      ${show && own ? html`<button type="button" class="hero-zoom" aria-label=${T.zoomPhoto} onClick=${onZoom}>${photo}<span class="zoom-hint">${Icon("zoomIn")}</span></button>` : photo}
    </div>
    <div class="hero-body">
      <h1 id="event-title">${o.event.title}</h1>
      <ul class="chips">${chips.map(([icon, text]) => html`<li class="chip">${Icon(icon)}<span>${text}</span></li>`)}</ul>
      <p class="hero-ref">${T.order} <strong>${o.reference}</strong>${o.buyerName ? ` · ${o.buyerName}` : ""}</p>
    </div>
  </section>`;
}

/**
 * What the buyer can do with the event: the calendar file (Run 31), the way there, and the
 * event's public page to share. Never the personal link: it holds the tickets.
 */
function Actions({ o, canCalendar, say }) {
  // A door-sale device is the staff's own: it goes on to the next sale instead.
  if (link.door) return null;
  const venue = o.event.venue;
  const place = [venue.name, venue.addressLine1, venue.city].filter(Boolean).join(", ");
  const maps = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place)}`;
  const canShare = typeof navigator.share === "function" || typeof navigator.clipboard?.writeText === "function";
  const share = async () => {
    // The shop's page of the event: public, with no order and no token in it.
    const url = `${location.origin}/acheter/${link.c}/${link.b}/${o.event.id}`;
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title: o.event.title, text: `${o.event.title} · ${whenFr(o.event.startsAt, venue.timezone)}`, url });
        return;
      } catch (e) {
        if (e?.name === "AbortError") return;
      }
    }
    try { await navigator.clipboard.writeText(url); say(T.shared); } catch { say(T.shareFailed); }
  };
  return html`<div class="actions noprint">
    ${canCalendar && html`<button type="button" class="action" onClick=${() => addToCalendar(o)}>${Icon("calendarPlus")}<span>${T.addToCalendar}</span></button>`}
    ${place && html`<a class="action" href=${maps} target="_blank" rel="noopener noreferrer">${Icon("route")}<span>${T.directions}<span class="sr-only">${T.newTab}</span></span></a>`}
    ${canShare && html`<button type="button" class="action" onClick=${share}>${Icon("share")}<span>${T.share}</span></button>`}
  </div>`;
}

function Contact({ brand }) {
  const site = https(brand.websiteUrl);
  const items = [
    site && html`<li>${Icon("globe")}<a href=${site} rel="noopener">${site.replace(/^https:\/\//, "").replace(/\/$/, "")}</a></li>`,
    brand.supportEmail && html`<li>${Icon("mail")}<a href=${`mailto:${brand.supportEmail}`}>${brand.supportEmail}</a></li>`,
    brand.supportPhone && html`<li>${Icon("phone")}<a href=${`tel:${brand.supportPhone.replace(/[^0-9+]/g, "")}`}>${brand.supportPhone}</a></li>`,
    brand.addressLine && html`<li>${Icon("pin")}<span>${brand.addressLine}</span></li>`,
  ].filter(Boolean);
  // Run 65: the exchange and refund policy, as at the time of purchase (OPC).
  const policy = String(brand.refundPolicy ?? "").trim();
  if (!items.length && !policy) return null;
  return html`<section class="card contact noprint" aria-labelledby="contact-title"><h2 id="contact-title">${T.contact}</h2>
    ${items.length ? html`<ul class="contact-list">${items}</ul>` : null}
    ${policy ? html`<h3>${T.policyTitle}</h3><p class="policy">${policy}</p>` : null}</section>`;
}

const CardHead = ({ icon, id, title }) => html`<div class="card-head"><span class="card-icon">${Icon(icon)}</span><h2 id=${id}>${title}</h2></div>`;

function ChangeSession({ order, token }) {
  const [sessions, setSessions] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // Run 56: the order's options with a stock per session must fit in the new session too.
  const optionsFit = (s) => (order.options ?? []).every((o) => s.addOnsAvailable?.[o.ticketTypeId] === undefined || s.addOnsAvailable[o.ticketTypeId] >= o.quantity);
  const load = async () => {
    setError(null);
    try {
      const data = await call(`/events/${order.event.id}`, { token });
      setSessions(data.sessions.filter((s) => s.id !== order.sessionId && s.available >= order.tickets.filter((t) => t.status === "valid").length));
    } catch (e) { setError(message(e)); }
  };
  const move = async (s) => {
    if (!confirm((order.openDate ? T.confirmMoveOpen : T.confirmMove)(whenFr(s.startsAt, order.event.venue.timezone)))) return;
    setBusy(true); setError(null);
    try {
      const { exchange } = await call(`/orders/${order.id}/exchange`, { method: "POST", body: { sessionId: s.id }, token });
      location.replace(`#${new URLSearchParams({ c: link.c, b: link.b, o: exchange.orderId, k: exchange.token })}`);
      location.reload();
    } catch (e) { setError(message(e)); setBusy(false); }
  };
  return html`<section class="card change noprint" aria-labelledby="change-title">
    <${CardHead} icon="swap" id="change-title" title=${order.openDate ? T.changeTitleOpen : T.changeTitle} />
    <p class="muted">${order.openDate ? T.changeAny : T.changeOnce}</p>
    ${error && html`<div class="alert bad" role="alert">${Icon("info")}<span>${error}</span></div>`}
    ${sessions === null ? html`<button type="button" class="secondary" onClick=${load}>${T.seeSessions}</button>`
      : sessions.length === 0 ? html`<p class="empty-note">${T.noSessions}</p>`
      : html`<ul class="sessions">${sessions.map((s) => html`<li key=${s.id}>${Icon("calendar")}<span>${whenFr(s.startsAt, order.event.venue.timezone)}</span>
          ${optionsFit(s) ? html`<button type="button" disabled=${busy} onClick=${() => move(s)}>${T.choose}</button>` : html`<span class="muted">${T.optionsFull}</span>`}</li>`)}</ul>`}
  </section>`;
}


/** Run 80: real transfer API. This panel stays absent until the global switch
 * and the organizer's separate opt-in are active. No claim code reaches sender. */
function TransferTickets({ order, token, names }) {
  const [info, setInfo] = useState(null);
  const [emails, setEmails] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const load = () => call(`/orders/${order.id}/transfers`, { token }).then(
    (data) => setInfo(data),
    (err) => { if (err.message !== "not_found") setError(message(err)); },
  );
  useEffect(() => { void load(); }, []);
  if (!info?.enabled) return null;
  const tickets = order.tickets.filter((t) => t.status === "valid" && !t.transferred && t.credential);
  if (!tickets.length) return null;
  const pendingFor = (id) => info.transfers.find((r) => r.ticketId === id &&
    r.status === "pending" && Date.parse(r.expiresAt) > Date.now());
  const submit = (ticketId) => async (event) => {
    event.preventDefault();
    const recipientEmail = emails[ticketId]?.trim();
    if (!recipientEmail || busy) return;
    setBusy(true); setNotice(null); setError(null);
    try {
      await call(`/orders/${order.id}/transfers`, { method: "POST", token,
        body: { ticketId, recipientEmail } });
      setEmails((prev) => ({ ...prev, [ticketId]: "" }));
      setNotice(T.transferNotice);
      await load();
    } catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  };
  const cancel = async (requestId) => {
    if (busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      await call(`/orders/${order.id}/transfers/${requestId}`, { method: "DELETE", token });
      setNotice(T.transferCancelNotice);
      await load();
    } catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  };
  return html`<section class="card transfer noprint" aria-label=${T.transferTitle}>
    <${CardHead} icon="send" title=${T.transferTitle} />
    <p class="muted">${T.transferIntro}</p>
    ${notice && html`<p role="status" class="alert ok">${Icon("saved")}<span>${notice}</span></p>`}
    ${error && html`<p role="alert" class="alert bad">${Icon("info")}<span>${error}</span></p>`}
    <ul class="transfer-list">${tickets.map((ticket, index) => {
      const pending = pendingFor(ticket.id);
      return html`<li key=${ticket.id}>
        <p class="transfer-ticket"><strong>${T.ticket} ${index + 1}</strong><span class="muted">${names.get(ticket.ticketTypeId) ?? ""}</span></p>
        ${pending ? html`<p class="transfer-state">${Icon("clock")}<span>${T.transferPending}</span></p>
          <button type="button" class="ghost" disabled=${busy} onClick=${() => cancel(pending.id)}>${T.transferCancel}</button>`
          : html`<form onSubmit=${submit(ticket.id)} class="transfer-form">
              <label for=${`transfer-${ticket.id}`}>${T.transferEmail}</label>
              <div class="transfer-row">
                <input id=${`transfer-${ticket.id}`} type="email" autocomplete="email"
                  required maxlength="320" value=${emails[ticket.id] ?? ""}
                  onInput=${(e) => setEmails((prev) => ({ ...prev, [ticket.id]: e.currentTarget.value }))} />
                <button type="submit" disabled=${busy}>${T.transferSend}</button>
              </div>
            </form>`}
      </li>`;
    })}</ul>
  </section>`;
}

// Run 31: an .ics file made here, from what the page shows; the personal link is not in it.
function addToCalendar(o) {
  const file = calendarFile({
    orderId: o.id, title: o.event.title, startsAt: o.event.startsAt, endsAt: o.event.endsAt, venue: o.event.venue,
    description: T.calendarText(o.reference, o.brand.name),
  });
  const url = URL.createObjectURL(new Blob([file], { type: "text/calendar;charset=utf-8" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: `${o.reference}.ics` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function App() {
  const [state, setState] = useState({ loading: true });
  const [modal, setModal] = useState(null);
  const [category, setCategory] = useState(undefined);
  const [toast, setToast] = useState(null);
  const wallet = useRef({});
  const focusNext = useRef(null);
  const wasPending = useRef(false);
  useEffect(() => {
    if (!link) return setState({ error: T.incomplete });
    // Back from Stripe, the payment may still be confirming: check again for up to 2 minutes.
    let tries = 0;
    let timer;
    const load = () => call(`/orders/${link.o}`, { token: link.k }).then(
      (d) => {
        if (d.order.status === "pending_payment") wasPending.current = true;
        setState({ order: d.order, kept: keepTickets(d.order) && "serviceWorker" in navigator, stale: d.order.status === "pending_payment" && tries >= 39 });
        if (d.order.status === "pending_payment" && ++tries < 40) timer = setTimeout(load, 3000);
      },
      (e) => {
        const kept = e.message === "offline" && keptTickets();
        setState(kept ? { order: kept.order, offlineSince: kept.savedAt } : { error: message(e) });
      },
    );
    forgetPastTickets();
    load();
    return () => clearTimeout(timer);
  }, []);
  const o = state.order;
  const photo = https(o?.event?.imageUrl);
  // No photo of its own: the photo of its category, read from the event's public page.
  useEffect(() => {
    if (!o || photo || category !== undefined) return;
    let live = true;
    call(`/events/${o.event.id}`, { token: link.k }).then((d) => live && setCategory(d?.event?.category ?? null), () => live && setCategory(null));
    return () => { live = false; };
  }, [o?.event?.id, photo]);
  // Back from a full-screen view: the focus returns where the buyer was (in the same commit
  // that gives the page back, so it never lands on the body).
  useLayoutEffect(() => {
    if (modal) return;
    const el = focusNext.current;
    focusNext.current = null;
    el?.focus?.({ preventScroll: true });
  }, [modal]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(timer);
  }, [toast]);
  const say = (text) => setToast({ text, at: Date.now() });

  if (state.loading) return html`<div class="boot-shell" role="status"><span class="sr-only">${T.loading}</span>
    <div class="sk sk-bar"></div><div class="sk sk-hero"></div><div class="sk sk-card"></div></div>`;
  if (state.error) return html`<header class="top"><div class="top-row"><p class="brand">ALKAO</p><${Lang} /></div></header>
    <main class="empty"><div class="empty-card">${Icon("ticket", "empty-icon")}<h1>${T.myTickets}</h1>
      <div class="alert bad" role="alert">${Icon("info")}<span>${state.error}</span></div></div></main>`;
  applyLook(o.brand);
  document.title = `${T.myTickets} · ${o.event.title}`;
  const names = new Map(o.lines.map((l) => [l.ticketTypeId, l.nameSnapshot]));
  // Runs 54–55: add-ons have no QR code of their own; the page lists them so the buyer can show
  // them. The server reads them across session changes (order.options).
  const addOns = o.exchanged || o.status === "refunded" ? []
    : (o.options ?? o.lines.filter((l) => l.kind === "add_on" && l.quantity > 0).map((l) => ({ name: l.nameSnapshot, quantity: l.quantity })));
  const valid = o.tickets.filter(isValid);
  const scannable = valid.filter((t) => t.credential);
  const tz = o.event.venue.timezone;
  const logo = https(o.brand.logoUrl);
  const pending = o.status === "pending_payment";
  const start = new Date(o.event.startsAt);
  const stub = { date: fmt({ day: "numeric", month: "short", year: "numeric" }, tz).format(start), time: fmt({ timeStyle: "short" }, tz).format(start) };
  const image = photo ?? (category === undefined ? null : categoryPhoto(category));
  const thanks = o.status === "paid" && !state.offlineSince && !o.exchanged && !o.exchangeOfOrderId
    && (wasPending.current || Date.now() - Date.parse(o.paidAt ?? "") < 30 * 60_000);
  const gateFrom = (t, field) => {
    focusNext.current = null;
    setModal({ kind: "gate", start: Math.max(0, scannable.findIndex((x) => x.id === t.id)), from: field?.getBoundingClientRect() ?? null });
  };
  const gateClosed = (id) => {
    const slide = wallet.current.reveal?.(id);
    focusNext.current = slide?.querySelector(".gate-open") ?? slide ?? null;
    setModal(null);
  };
  const isModal = modal !== null;
  return html`<div class="page" inert=${isModal} aria-hidden=${isModal ? "true" : undefined}>
    <header class="top">
      <div class="top-row">
        ${logo ? html`<${Logo} src=${logo} name=${o.brand.name} />` : html`<p class="brand">${o.brand.name}</p>`}
        <${Lang} />
      </div>
    </header>
    <main class="layout">
      <div class="lead">
        <${Hero} o=${o} image=${image} own=${Boolean(photo)} onZoom=${() => setModal({ kind: "photo" })} />
        ${state.offlineSince && html`<div class="alert" role="status">${Icon("offline")}<span>${T.offline(savedOn(state.offlineSince))}</span></div>`}
        ${thanks && html`<div class="alert ok thanks">${Icon("saved")}<span>${T.thanks}</span></div>`}
        ${o.status === "refunded" && html`<div class="alert">${Icon("info")}<span>${T.refundedOrder}</span></div>`}
        ${o.exchanged && html`<div class="alert">${Icon("info")}<span>${T.replaced}</span></div>`}
        ${o.exchangeOfOrderId && html`<div class="alert ok">${Icon("saved")}<span>${T.exchanged}</span></div>`}
      </div>
      ${pending ? html`<section class="wallet pending" aria-labelledby="pending-title" role="status">
          <span class="spinner" aria-hidden="true"></span>
          <h2 id="pending-title">${T.pendingTitle}</h2>
          <p class="muted">${state.stale ? T.pending : T.pendingBody}</p>
        </section>`
        : o.tickets.length > 0 && html`<${Wallet} o=${o} names=${names} stub=${stub} kept=${state.kept && valid.length > 0} api=${wallet} onGate=${gateFrom} />`}
      <${Actions} o=${o} canCalendar=${valid.length > 0 && !o.exchanged} say=${say} />
      <div class="info">
        ${link.door && html`<p class="door noprint"><a class="button" href=${`/acheter/${link.c}/${link.b}/${o.event.id}?porte=1`}>${Icon("store")}${T.nextSale}</a></p>`}
        ${addOns.length > 0 && html`<section class="card options" aria-labelledby="options-title">
          <${CardHead} icon="bag" id="options-title" title=${T.options} />
          <ul>${addOns.map((l) => html`<li><span>${l.name}${l.sessionChange && html`<small class="muted">${T.optionRight}</small>`}</span><strong>× ${l.quantity}</strong></li>`)}</ul>
          ${addOns.some((l) => !l.sessionChange) && html`<p class="muted">${T.optionsTip}</p>`}
        </section>`}
        ${o.canChangeSession && valid.length > 0 && !state.offlineSince && html`<${ChangeSession} order=${o} token=${link.k} />`}
        ${!state.offlineSince && !o.exchanged && !pending && html`<${TransferTickets} order=${o} token=${link.k} names=${names} />`}
        <${Contact} brand=${o.brand} />
      </div>
    </main>
    <footer class="foot"><p>${Icon("lock")}<span>${T.footer}</span></p></footer>
  </div>
  ${modal?.kind === "gate" && scannable.length > 0 && html`<${GateMode} tickets=${scannable} names=${names} start=${modal.start} from=${modal.from}
    event=${{ title: o.event.title, when: `${capital(fmt({ weekday: "short", day: "numeric", month: "short" }, tz).format(start))} · ${stub.time}` }}
    reveal=${(id) => wallet.current.reveal?.(id)} onClose=${gateClosed} />`}
  ${modal?.kind === "photo" && photo && html`<${Lightbox} src=${photo} title=${o.event.title}
    onClose=${() => { focusNext.current = document.querySelector(".hero-zoom"); setModal(null); }} />`}
  <div class="toast-region" role="status" aria-live="polite">${toast && html`<p class="toast" key=${toast.at}>${toast.text}</p>`}</div>`;
}

const savedOn = (iso) => new Intl.DateTimeFormat(localeOf(LANG), { dateStyle: "long", timeStyle: "short" }).format(new Date(iso));

// Run 51: the page itself opens without a network (its own files only, see sw.js).
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/billets/sw.js", { scope: "/billets" }).catch(() => {});

// The page's static "Chargement…" goes: the app renders a band, the page and the gate side by side.
const root = document.getElementById("app");
root.replaceChildren();
render(html`<${App} />`, root);
