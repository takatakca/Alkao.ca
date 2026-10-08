// ALKAO — the buyer's tickets page (Run 06). The link carries the order and its personal
// token after "#", so it never reaches a server log. The page holds no data of its own: it
// reads the order through the public, gated ALKAO API with that token.
import { html, render, useEffect, useRef, useState } from "/billets/vendor/htm-preact.js";
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
      flex_not_purchased: "Cette commande ne comprend pas l'option de changement de séance.",
      offline: "Pas de réseau. Ouvrez cette page une fois avec du réseau : vos billets resteront ensuite sur cet appareil.",
    },
    generic: "Une erreur est survenue. Réessayez dans un instant.",
    void: { refunded: "Remboursé", cancelled: "Annulé", reissued: "Remplacé par un nouveau billet", admin: "Annulé" },
    voidDefault: "Annulé",
    qrAlt: (id) => `Code QR du billet ${id}`,
    qrSoon: "Code QR bientôt disponible.",
    confirmMove: (when) => `Déplacer vos billets au ${when} ? Ce changement ne peut être fait qu'une fois.`,
    changeTitle: "Changer de séance",
    changeTitleOpen: "Changer de date (billet ouvert)",
    changeAny: "Votre billet ouvert peut changer de date autant de fois que nécessaire, tant qu'il n'est pas entré.",
    confirmMoveOpen: (when) => `Déplacer vos billets au ${when} ? Vous pourrez encore changer de date ensuite.`,
    changeOnce: "Votre commande permet un changement de séance, une seule fois.",
    seeSessions: "Voir les autres séances",
    noSessions: "Aucune autre séance n'a assez de places pour le moment.",
    choose: "Choisir",
    incomplete: "Lien incomplet. Ouvrez le lien reçu par courriel.",
    loading: "Chargement de vos billets…",
    myTickets: "Mes billets",
    order: "Commande",
    pending: "Paiement en cours de confirmation. Rechargez cette page dans un instant.",
    replaced: "Ces billets ont été remplacés après votre changement de séance. Vos nouveaux billets sont dans le courriel de confirmation du changement.",
    exchanged: "Changement de séance confirmé. Les billets ci-dessous remplacent les anciens.",
    present: (n) => `Présentez le code QR de chaque billet à l'entrée. ${n} billet${n > 1 ? "s" : ""} valide${n > 1 ? "s" : ""}.`,
    ticket: "Billet",
    footer: "Billetterie ALKAO · Ce lien est personnel : ne le partagez pas.",
    other: "English",
    addToCalendar: "Ajouter à mon calendrier",
    nextSale: "Nouvelle vente à la porte",
    calendarText: (ref, brand) => `${brand} · Commande ${ref}. Vos billets sont dans votre courriel de confirmation.`,
    ticketOf: (i, n) => `Billet ${i} sur ${n}`,
    fullscreen: "Plein écran pour l'entrée",
    gateTip: "Montez la luminosité de l'écran au maximum.",
    previous: "Billet précédent",
    next: "Billet suivant",
    close: "Fermer",
    contact: "Une question ?",
    valid: "Valide",
    offline: (d) => `Hors ligne : voici vos billets tels qu'enregistrés sur cet appareil le ${d}. Présentez-les normalement à l'entrée.`,
    kept: "Billets enregistrés sur cet appareil : ils s'afficheront même sans réseau.",
  },
  en: {
    errors: {
      order_not_found: "This link no longer works. Use the link from your most recent email.",
      ticketing_unavailable: "This organizer's ticketing is temporarily unavailable.",
      already_exchanged: "The session change has already been used.",
      ticket_already_used: "A ticket of this order has already entered: no change is possible.",
      session_not_available: "This session is no longer available.",
      sold_out: "Not enough seats left in this session.",
      flex_not_purchased: "This order does not include the session change option.",
      offline: "No network. Open this page once with a network: your tickets will then stay on this device.",
    },
    generic: "Something went wrong. Please try again in a moment.",
    void: { refunded: "Refunded", cancelled: "Cancelled", reissued: "Replaced by a new ticket", admin: "Cancelled" },
    voidDefault: "Cancelled",
    qrAlt: (id) => `QR code of ticket ${id}`,
    qrSoon: "QR code coming soon.",
    confirmMove: (when) => `Move your tickets to ${when}? This change can be made only once.`,
    changeTitle: "Change session",
    changeTitleOpen: "Change date (open-date ticket)",
    changeAny: "Your open-date ticket can change date as often as needed, until it has been used.",
    confirmMoveOpen: (when) => `Move your tickets to ${when}? You can still change the date afterwards.`,
    changeOnce: "Your order allows one session change.",
    seeSessions: "See other sessions",
    noSessions: "No other session has enough seats right now.",
    choose: "Choose",
    incomplete: "Incomplete link. Open the link from your email.",
    loading: "Loading your tickets…",
    myTickets: "My tickets",
    order: "Order",
    pending: "Payment is being confirmed. Reload this page in a moment.",
    replaced: "These tickets were replaced after your session change. Your new tickets are in the change confirmation email.",
    exchanged: "Session change confirmed. The tickets below replace the old ones.",
    present: (n) => `Show each ticket's QR code at the entrance. ${n} valid ticket${n > 1 ? "s" : ""}.`,
    ticket: "Ticket",
    footer: "ALKAO Ticketing · This link is personal: do not share it.",
    other: "Français",
    addToCalendar: "Add to my calendar",
    nextSale: "Next door sale",
    calendarText: (ref, brand) => `${brand} · Order ${ref}. Your tickets are in your confirmation email.`,
    ticketOf: (i, n) => `Ticket ${i} of ${n}`,
    fullscreen: "Full screen for the entrance",
    gateTip: "Turn your screen brightness all the way up.",
    previous: "Previous ticket",
    next: "Next ticket",
    close: "Close",
    contact: "Questions?",
    valid: "Valid",
    offline: (d) => `Offline: here are your tickets as saved on this device on ${d}. Show them at the entrance as usual.`,
    kept: "Tickets saved on this device: they will show even without a network.",
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

function qrDataUrl(payload) {
  const qr = qrcode(0, "M");
  qr.addData(payload);
  qr.make();
  return qr.createDataURL(8, 2);
}

function whenFr(iso, timeZone) {
  return new Intl.DateTimeFormat(localeOf(LANG), { dateStyle: "full", timeStyle: "short", timeZone: timeZone || "America/Toronto" }).format(new Date(iso));
}

function Ticket({ t, name, index, count, onFullscreen }) {
  const valid = t.status === "valid";
  return html`<article class="ticket ${valid ? "" : "void"}">
    <div class="ticket-band">
      <span class="type">${name}</span>
      <span class="ticket-count">${T.ticketOf(index + 1, count)}</span>
    </div>
    <div class="ticket-body">
      ${valid && t.credential
        ? html`<img class="qr" src=${qrDataUrl(t.credential)} alt=${T.qrAlt(t.id.slice(0, 8))} />`
        : valid ? html`<p class="muted">${T.qrSoon}</p>`
        : html`<p><span class="badge bad">${T.void[t.voidReason] ?? T.voidDefault}</span></p>`}
      <code>${t.id.slice(0, 8).toUpperCase()}</code>
      ${valid && t.credential && html`<button class="ghost noprint" onClick=${onFullscreen}>${T.fullscreen}</button>`}
    </div>
  </article>`;
}

/**
 * Run 50: at the gate, one ticket at a time, as large as the screen allows, the screen kept
 * awake while it is shown. Arrows or swipe for the next ticket, Escape to close.
 */
function GateMode({ tickets, names, start, onClose }) {
  const [i, setI] = useState(start);
  const t = tickets[i];
  const closeButton = useRef(null);
  const x0 = useRef(null);
  useEffect(() => {
    // Each call is optional: older phones have no wake lock, iPhones no page full screen.
    const quietly = (fn) => { try { Promise.resolve(fn()).catch(() => {}); } catch {} };
    let lock = null;
    const keepAwake = () => quietly(() => navigator.wakeLock?.request("screen").then((l) => { lock = l; }));
    // The screen lock ends when the page is hidden; take it again when the buyer comes back.
    const onVisible = () => { if (document.visibilityState === "visible") keepAwake(); };
    keepAwake();
    quietly(() => document.documentElement.requestFullscreen?.());
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const opener = document.activeElement;
    closeButton.current?.focus();
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") setI((x) => Math.min(x + 1, tickets.length - 1));
      if (e.key === "ArrowLeft") setI((x) => Math.max(x - 1, 0));
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("visibilitychange", onVisible);
      document.body.style.overflow = overflow;
      quietly(() => lock?.release());
      if (document.fullscreenElement) quietly(() => document.exitFullscreen?.());
      opener?.focus?.();
    };
  }, []);
  return html`<div class="gate" role="dialog" aria-modal="true" aria-label=${T.ticketOf(i + 1, tickets.length)}
      onTouchStart=${(e) => { x0.current = e.touches[0].clientX; }}
      onTouchEnd=${(e) => {
        if (x0.current === null) return;
        const dx = e.changedTouches[0].clientX - x0.current;
        if (dx < -50) setI(Math.min(i + 1, tickets.length - 1));
        if (dx > 50) setI(Math.max(i - 1, 0));
        x0.current = null;
      }}>
    <p class="gate-count">${T.ticketOf(i + 1, tickets.length)} · ${names.get(t.ticketTypeId) ?? T.ticket}</p>
    <img class="gate-qr" src=${qrDataUrl(t.credential)} alt=${T.qrAlt(t.id.slice(0, 8))} />
    <code>${t.id.slice(0, 8).toUpperCase()}</code>
    <p class="gate-tip">${T.gateTip}</p>
    <div class="gate-actions">
      <button class="ghost" disabled=${i === 0} onClick=${() => setI(i - 1)}>${T.previous}</button>
      <button ref=${closeButton} onClick=${onClose}>${T.close}</button>
      <button class="ghost" disabled=${i === tickets.length - 1} onClick=${() => setI(i + 1)}>${T.next}</button>
    </div>
  </div>`;
}

/** Run 50: the Brand's colour, when it has one (checked again here: #rrggbb only). */
function applyLook(brand) {
  const hex = /^#[0-9a-f]{6}$/i;
  const root = document.documentElement.style;
  if (hex.test(brand?.accentColor ?? "") && hex.test(brand?.onAccentColor ?? "")) {
    root.setProperty("--accent", brand.accentColor);
    root.setProperty("--on-accent", brand.onAccentColor);
  }
}
const https = (u) => (typeof u === "string" && /^https:\/\/[^\s"'<>\\]+$/.test(u) ? u : null);

/** The logo, or the Brand's name when the image cannot be shown. */
function Logo({ src, name }) {
  const [failed, setFailed] = useState(false);
  return failed ? html`<p class="brand">${name}</p>` : html`<img class="logo" src=${src} alt=${name} onError=${() => setFailed(true)} />`;
}

function Contact({ brand }) {
  const site = https(brand.websiteUrl);
  const items = [
    site && html`<a href=${site} rel="noopener">${site.replace(/^https:\/\//, "").replace(/\/$/, "")}</a>`,
    brand.supportEmail && html`<a href=${`mailto:${brand.supportEmail}`}>${brand.supportEmail}</a>`,
    brand.supportPhone && html`<a href=${`tel:${brand.supportPhone.replace(/[^0-9+]/g, "")}`}>${brand.supportPhone}</a>`,
    brand.addressLine && html`<span>${brand.addressLine}</span>`,
  ].filter(Boolean);
  if (!items.length) return null;
  return html`<section class="contact noprint"><h2>${T.contact}</h2><p>${items.map((x, k) => html`${k ? " · " : ""}${x}`)}</p></section>`;
}

function ChangeSession({ order, token }) {
  const [sessions, setSessions] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
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
  return html`<div class="card noprint">
    <h2>${order.openDate ? T.changeTitleOpen : T.changeTitle}</h2>
    <p class="muted">${order.openDate ? T.changeAny : T.changeOnce}</p>
    ${error && html`<div class="alert bad" role="alert">${error}</div>`}
    ${sessions === null ? html`<button onClick=${load}>${T.seeSessions}</button>`
      : sessions.length === 0 ? html`<p>${T.noSessions}</p>`
      : html`<ul class="sessions">${sessions.map((s) => html`<li><span>${whenFr(s.startsAt, order.event.venue.timezone)}</span>
          <button disabled=${busy} onClick=${() => move(s)}>${T.choose}</button></li>`)}</ul>`}
  </div>`;
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

const switcher = html`<p class="lang noprint"><button class="link" onClick=${() => switchLanguage(LANG === "en" ? "fr" : "en")}>${T.other}</button></p>`;

function App() {
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    if (!link) return setState({ error: T.incomplete });
    // Back from Stripe, the payment may still be confirming: check again for up to 2 minutes.
    let tries = 0;
    let timer;
    const load = () => call(`/orders/${link.o}`, { token: link.k }).then(
      (d) => {
        setState({ order: d.order, kept: keepTickets(d.order) && "serviceWorker" in navigator });
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
  const [gate, setGate] = useState(null);
  if (state.loading) return html`<main><p class="boot">${T.loading}</p></main>`;
  if (state.error) return html`<main>${switcher}<h1>${T.myTickets}</h1><div class="alert bad" role="alert">${state.error}</div></main>`;
  const o = state.order;
  applyLook(o.brand);
  const names = new Map(o.lines.map((l) => [l.ticketTypeId, l.nameSnapshot]));
  const valid = o.tickets.filter((t) => t.status === "valid");
  const scannable = valid.filter((t) => t.credential);
  const tz = o.event.venue.timezone;
  const logo = https(o.brand.logoUrl);
  const photo = https(o.event.imageUrl);
  return html`<header class="top">
    <div class="top-row">
      ${logo ? html`<${Logo} src=${logo} name=${o.brand.name} />` : html`<p class="brand">${o.brand.name}</p>`}
      ${switcher}
    </div>
  </header>
  <main>
    ${photo && html`<img class="photo" src=${photo} alt="" onError=${(e) => { e.currentTarget.hidden = true; }} />`}
    <h1>${o.event.title}</h1>
    <div class="card event">
      <p class="when">${whenFr(o.event.startsAt, tz)}</p>
      <p>${o.event.venue.name}${o.event.venue.city ? `, ${o.event.venue.city}` : ""}</p>
      <p class="muted">${T.order} ${o.reference}${o.buyerName ? ` · ${o.buyerName}` : ""}</p>
      ${valid.length > 0 && !o.exchanged && html`<p class="noprint"><button class="ghost" onClick=${() => addToCalendar(o)}>${T.addToCalendar}</button></p>`}
    </div>
    ${state.offlineSince && html`<div class="alert" role="status">${T.offline(savedOn(state.offlineSince))}</div>`}
    ${o.status === "pending_payment" && html`<div class="alert">${T.pending}</div>`}
    ${o.exchanged && html`<div class="alert">${T.replaced}</div>`}
    ${o.exchangeOfOrderId && html`<div class="alert ok">${T.exchanged}</div>`}
    ${valid.length > 0 && html`<p class="present">${T.present(valid.length)}</p>`}
    ${state.kept && valid.length > 0 && html`<p class="kept noprint">${T.kept}</p>`}
    <div class="tickets">
      ${o.tickets.map((t, k) => html`<${Ticket} t=${t} name=${names.get(t.ticketTypeId) ?? T.ticket} index=${k} count=${o.tickets.length}
        onFullscreen=${() => setGate(Math.max(0, scannable.findIndex((x) => x.id === t.id)))} />`)}
    </div>
    ${o.canChangeSession && valid.length > 0 && !state.offlineSince && html`<${ChangeSession} order=${o} token=${link.k} />`}
    ${link.door && html`<p class="noprint"><a class="button" href=${`/acheter/${link.c}/${link.b}/${o.event.id}?porte=1`}>${T.nextSale}</a></p>`}
    <${Contact} brand=${o.brand} />
    <footer>${T.footer}</footer>
  </main>
  ${gate !== null && scannable.length > 0 && html`<${GateMode} tickets=${scannable} names=${names} start=${gate} onClose=${() => setGate(null)} />`}`;
}

const savedOn = (iso) => new Intl.DateTimeFormat(localeOf(LANG), { dateStyle: "long", timeStyle: "short" }).format(new Date(iso));

// Run 51: the page itself opens without a network (its own files only, see sw.js).
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/billets/sw.js", { scope: "/billets" }).catch(() => {});

// The page's static "Chargement…" goes: the app renders a band, the page and the gate side by side.
const root = document.getElementById("app");
root.replaceChildren();
render(html`<${App} />`, root);
