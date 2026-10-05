// ALKAO — the buyer's tickets page (Run 06). The link carries the order and its personal
// token after "#", so it never reaches a server log. The page holds no data of its own: it
// reads the order through the public, gated ALKAO API with that token.
import { html, render, useEffect, useState } from "/billets/vendor/htm-preact.js";
import qrcode from "/billets/vendor/qrcode.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const link = (() => {
  const p = new URLSearchParams(location.hash.slice(1));
  const l = { c: p.get("c"), b: p.get("b"), o: p.get("o"), k: p.get("k") };
  return UUID.test(l.c ?? "") && UUID.test(l.b ?? "") && UUID.test(l.o ?? "") && /^[A-Za-z0-9_-]{20,100}$/.test(l.k ?? "") ? l : null;
})();
const base = link && `/v1/public/clients/${link.c}/brands/${link.b}`;

const ERRORS = {
  order_not_found: "Ce lien n'est plus valide. Utilisez le lien du courriel le plus récent.",
  ticketing_unavailable: "La billetterie de cet organisateur est momentanément indisponible.",
  already_exchanged: "Le changement de séance a déjà été utilisé.",
  ticket_already_used: "Un billet de cette commande est déjà entré : changement impossible.",
  session_not_available: "Cette séance n'est plus disponible.",
  sold_out: "Plus assez de places dans cette séance.",
  flex_not_purchased: "Cette commande ne comprend pas l'option de changement de séance.",
};
const VOID = { refunded: "Remboursé", cancelled: "Annulé", reissued: "Remplacé par un nouveau billet", admin: "Annulé" };

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
const message = (e) => ERRORS[e.message] ?? "Une erreur est survenue. Réessayez dans un instant.";

function qrDataUrl(payload) {
  const qr = qrcode(0, "M");
  qr.addData(payload);
  qr.make();
  return qr.createDataURL(8, 2);
}

function whenFr(iso, timeZone) {
  return new Intl.DateTimeFormat("fr-CA", { dateStyle: "full", timeStyle: "short", timeZone: timeZone || "America/Toronto" }).format(new Date(iso));
}

function Ticket({ t, name }) {
  const valid = t.status === "valid";
  return html`<div class="card ticket">
    <div class="type">${name}</div>
    ${valid && t.credential
      ? html`<img class="qr" src=${qrDataUrl(t.credential)} alt=${`Code QR du billet ${t.id.slice(0, 8)}`} />`
      : valid ? html`<p class="muted">Code QR bientôt disponible.</p>`
      : html`<p><span class="badge bad">${VOID[t.voidReason] ?? "Annulé"}</span></p>`}
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
    if (!confirm(`Déplacer vos billets au ${whenFr(s.startsAt, order.event.venue.timezone)} ? Ce changement ne peut être fait qu'une fois.`)) return;
    setBusy(true); setError(null);
    try {
      const { exchange } = await call(`/orders/${order.id}/exchange`, { method: "POST", body: { sessionId: s.id }, token });
      location.replace(`#${new URLSearchParams({ c: link.c, b: link.b, o: exchange.orderId, k: exchange.token })}`);
      location.reload();
    } catch (e) { setError(message(e)); setBusy(false); }
  };
  return html`<div class="card noprint">
    <h2>Changer de séance (Flex Météo)</h2>
    <p class="muted">Votre commande permet un changement de séance, une seule fois.</p>
    ${error && html`<div class="alert bad" role="alert">${error}</div>`}
    ${sessions === null ? html`<button onClick=${load}>Voir les autres séances</button>`
      : sessions.length === 0 ? html`<p>Aucune autre séance n'a assez de places pour le moment.</p>`
      : html`<ul class="sessions">${sessions.map((s) => html`<li><span>${whenFr(s.startsAt, order.event.venue.timezone)}</span>
          <button disabled=${busy} onClick=${() => move(s)}>Choisir</button></li>`)}</ul>`}
  </div>`;
}

function App() {
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    if (!link) return setState({ error: "Lien incomplet. Ouvrez le lien reçu par courriel." });
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
  if (state.loading) return html`<main><p class="boot">Chargement de vos billets…</p></main>`;
  if (state.error) return html`<main><h1>Mes billets</h1><div class="alert bad" role="alert">${state.error}</div></main>`;
  const o = state.order;
  const names = new Map(o.lines.map((l) => [l.ticketTypeId, l.nameSnapshot]));
  const valid = o.tickets.filter((t) => t.status === "valid");
  const tz = o.event.venue.timezone;
  return html`<main>
    <p class="brand">${o.brand.name}</p>
    <h1>${o.event.title}</h1>
    <div class="card event">
      <p><strong>${whenFr(o.event.startsAt, tz)}</strong></p>
      <p>${o.event.venue.name}${o.event.venue.city ? `, ${o.event.venue.city}` : ""}</p>
      <p class="muted">Commande ${o.reference}${o.buyerName ? ` · ${o.buyerName}` : ""}</p>
    </div>
    ${o.status === "pending_payment" && html`<div class="alert">Paiement en cours de confirmation. Rechargez cette page dans un instant.</div>`}
    ${o.exchanged && html`<div class="alert">Ces billets ont été remplacés après votre changement de séance. Vos nouveaux billets sont dans le courriel de confirmation du changement.</div>`}
    ${o.exchangeOfOrderId && html`<div class="alert ok">Changement de séance confirmé. Les billets ci-dessous remplacent les anciens.</div>`}
    ${valid.length > 0 && html`<p class="muted">Présentez le code QR de chaque billet à l'entrée. ${valid.length} billet${valid.length > 1 ? "s" : ""} valide${valid.length > 1 ? "s" : ""}.</p>`}
    ${o.tickets.map((t) => html`<${Ticket} t=${t} name=${names.get(t.ticketTypeId) ?? "Billet"} />`)}
    ${o.canChangeSession && valid.length > 0 && html`<${ChangeSession} order=${o} token=${link.k} />`}
    <footer>Billetterie ALKAO · Ce lien est personnel : ne le partagez pas.</footer>
  </main>`;
}

render(html`<${App} />`, document.getElementById("app"));
