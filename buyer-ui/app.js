// ALKAO — the buyer's tickets page (Run 06). The link carries the order and its personal
// token after "#", so it never reaches a server log. The page holds no data of its own: it
// reads the order through the public, gated ALKAO API with that token.
import { html, render, useEffect, useState } from "/billets/vendor/htm-preact.js";
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
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "x-alkao-order-token": token, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error?.code ?? "error");
  return data;
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

function Ticket({ t, name }) {
  const valid = t.status === "valid";
  return html`<div class="card ticket">
    <div class="type">${name}</div>
    ${valid && t.credential
      ? html`<img class="qr" src=${qrDataUrl(t.credential)} alt=${T.qrAlt(t.id.slice(0, 8))} />`
      : valid ? html`<p class="muted">${T.qrSoon}</p>`
      : html`<p><span class="badge bad">${T.void[t.voidReason] ?? T.voidDefault}</span></p>`}
    <code>${t.id.slice(0, 8).toUpperCase()}</code>
  </div>`;
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
      (d) => { setState({ order: d.order }); if (d.order.status === "pending_payment" && ++tries < 40) timer = setTimeout(load, 3000); },
      (e) => setState({ error: message(e) }),
    );
    load();
    return () => clearTimeout(timer);
  }, []);
  if (state.loading) return html`<main><p class="boot">${T.loading}</p></main>`;
  if (state.error) return html`<main>${switcher}<h1>${T.myTickets}</h1><div class="alert bad" role="alert">${state.error}</div></main>`;
  const o = state.order;
  const names = new Map(o.lines.map((l) => [l.ticketTypeId, l.nameSnapshot]));
  const valid = o.tickets.filter((t) => t.status === "valid");
  const tz = o.event.venue.timezone;
  return html`<main>
    ${switcher}
    <p class="brand">${o.brand.name}</p>
    <h1>${o.event.title}</h1>
    <div class="card event">
      <p><strong>${whenFr(o.event.startsAt, tz)}</strong></p>
      <p>${o.event.venue.name}${o.event.venue.city ? `, ${o.event.venue.city}` : ""}</p>
      <p class="muted">${T.order} ${o.reference}${o.buyerName ? ` · ${o.buyerName}` : ""}</p>
      ${valid.length > 0 && !o.exchanged && html`<p class="noprint"><button onClick=${() => addToCalendar(o)}>${T.addToCalendar}</button></p>`}
    </div>
    ${o.status === "pending_payment" && html`<div class="alert">${T.pending}</div>`}
    ${o.exchanged && html`<div class="alert">${T.replaced}</div>`}
    ${o.exchangeOfOrderId && html`<div class="alert ok">${T.exchanged}</div>`}
    ${valid.length > 0 && html`<p class="muted">${T.present(valid.length)}</p>`}
    ${o.tickets.map((t) => html`<${Ticket} t=${t} name=${names.get(t.ticketTypeId) ?? T.ticket} />`)}
    ${o.canChangeSession && valid.length > 0 && html`<${ChangeSession} order=${o} token=${link.k} />`}
    ${link.door && html`<p class="noprint"><a class="button" href=${`/acheter/${link.c}/${link.b}/${o.event.id}?porte=1`}>${T.nextSale}</a></p>`}
    <footer>${T.footer}</footer>
  </main>`;
}

render(html`<${App} />`, document.getElementById("app"));
