// ALKAO — hosted ticket shop (Run 08). A Brand can sell with a plain link:
//   /acheter/<clientId>/<brandId>              published events
//   /acheter/<clientId>/<brandId>/<eventId>    choose a session and tickets, pay
//   /acheter/merci/<clientId>/<brandId>/<holdId>  back from Stripe → the buyer's tickets
// Every price comes from the server; the page only sends what the buyer picked.
import { html, render, useEffect, useRef, useState } from "/shop/vendor/htm-preact.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const route = (() => {
  const p = location.pathname;
  let m = new RegExp(`^/acheter/merci/(${UUID})/(${UUID})/(${UUID})$`).exec(p);
  if (m) return { page: "merci", c: m[1], b: m[2], holdId: m[3] };
  m = new RegExp(`^/acheter/(${UUID})/(${UUID})/(${UUID})$`).exec(p);
  if (m) return { page: "event", c: m[1], b: m[2], eventId: m[3] };
  m = new RegExp(`^/acheter/(${UUID})/(${UUID})$`).exec(p);
  if (m) return { page: "events", c: m[1], b: m[2] };
  return null;
})();
const base = route && `/v1/public/clients/${route.c}/brands/${route.b}`;
const STORE = (holdId) => `alkao.checkout.${holdId}`;
const saved = (holdId) => { try { return JSON.parse(sessionStorage.getItem(STORE(holdId)) ?? "null"); } catch { return null; } };
const save = (holdId, value) => { try { sessionStorage.setItem(STORE(holdId), JSON.stringify(value)); } catch {} };

const money = (cents) => (Number(cents ?? 0) / 100).toLocaleString("fr-CA", { style: "currency", currency: "CAD" });
const whenFr = (iso, tz) => new Intl.DateTimeFormat("fr-CA", { dateStyle: "full", timeStyle: "short", timeZone: tz || "America/Toronto" }).format(new Date(iso));

class ApiError extends Error {
  constructor(status, code, details) { super(code); this.status = status; this.code = code; this.details = details; }
}
async function call(path, { method = "GET", body, headers = {} } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? "error", data?.error?.details);
  return data;
}

const ERRORS = {
  ticketing_unavailable: "La billetterie de cet organisateur est fermée pour le moment.",
  event_not_found: "Cet événement n'est pas en vente.",
  sold_out: "Il ne reste plus assez de places pour cette séance.",
  session_not_available: "Cette séance n'est plus en vente.",
  hold_not_active: "Votre réservation a expiré. Recommencez votre sélection.",
  hold_not_found: "Votre réservation a expiré. Recommencez votre sélection.",
  rate_limited: "Trop de tentatives. Patientez une minute.",
  payments_unavailable: "Le paiement en ligne n'est pas encore ouvert pour cet organisateur.",
  payment_provider_error: "Le service de paiement ne répond pas. Réessayez.",
  return_url_not_allowed: "Configuration de paiement incomplète chez l'organisateur.",
  invalid_request: "Vérifiez vos informations.",
};
const errText = (e) => ERRORS[e?.code] ?? "Une erreur est survenue. Réessayez dans un instant.";

function violationText(v, types) {
  const name = types.find((t) => t.id === v.ticketTypeId)?.name ?? "";
  switch (v.code) {
    case "above_maximum": return `${name} : ${v.limit} au maximum par commande.`;
    case "below_minimum": return `${name} : ${v.limit} au minimum.`;
    case "max_adults_exceeded": return `${name} : ${v.limit} adulte${v.limit > 1 ? "s" : ""} au maximum dans la commande.`;
    case "add_on_without_admission": return `${name} s'ajoute à une entrée : choisissez d'abord vos billets.`;
    case "add_on_quantity_mismatch": return `${name} : choisissez-en ${v.limit}, un par entrée.`;
    case "order_too_large": return "Commande trop grande.";
    default: return "Sélection invalide.";
  }
}

function Countdown({ until, onExpire }) {
  const [left, setLeft] = useState(Math.max(0, until - Date.now()));
  useEffect(() => {
    const t = setInterval(() => { const l = Math.max(0, until - Date.now()); setLeft(l); if (l === 0) { clearInterval(t); onExpire(); } }, 1000);
    return () => clearInterval(t);
  }, [until]);
  const s = Math.ceil(left / 1000);
  return html`<span class="timer">${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}</span>`;
}

// ── Event: choose, quote, hold, buyer, pay ──────────────────────────────────
function EventShop({ config }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [sessionId, setSessionId] = useState(null);
  const [qty, setQty] = useState({});
  const [quote, setQuote] = useState(null);
  const [violations, setViolations] = useState([]);
  const [hold, setHold] = useState(null);
  const [buyer, setBuyer] = useState({ email: "", fullName: "", phone: "" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const seq = useRef(0);

  const load = () => call(`/events/${route.eventId}`).then(setData, setError);
  useEffect(() => {
    load();
    // Back from Stripe without paying: offer to resume, or free the seats.
    const cancelled = /^#annule=([0-9a-f-]{36})$/.exec(location.hash)?.[1];
    const s = cancelled && saved(cancelled);
    if (s) setNotice({ holdId: cancelled, ...s });
    if (cancelled) history.replaceState(null, "", location.pathname);
  }, []);

  const items = (data?.ticketTypes ?? []).filter((t) => (qty[t.id] ?? 0) > 0).map((t) => ({ ticketTypeId: t.id, quantity: qty[t.id] }));
  useEffect(() => {
    if (!data || items.length === 0) { setQuote(null); setViolations([]); return; }
    const n = ++seq.current;
    const t = setTimeout(() => call(`/events/${route.eventId}/quote`, { method: "POST", body: { items } }).then(
      (r) => { if (n === seq.current) { setQuote(r.quote); setViolations([]); } },
      (e) => { if (n === seq.current) { setQuote(null); setViolations(e.code === "cart_invalid" ? e.details ?? [] : []); if (e.code !== "cart_invalid") setError(e); } },
    ), 200);
    return () => clearTimeout(t);
  }, [JSON.stringify(items)]);

  if (error && !data) return html`<main><div class="alert bad" role="alert">${errText(error)}</div></main>`;
  if (!data) return html`<main><p class="boot">Chargement…</p></main>`;
  const ev = data.event;
  const tz = ev.venue?.timezone;
  const admissions = data.ticketTypes.filter((t) => t.kind === "admission");
  const addOns = data.ticketTypes.filter((t) => t.kind === "add_on");
  const wanted = items.reduce((n, i) => n + (data.ticketTypes.find((t) => t.id === i.ticketTypeId)?.kind === "admission" ? i.quantity : 0), 0);
  const session = data.sessions.find((s) => s.id === sessionId);
  const set = (id, n) => setQty((q) => ({ ...q, [id]: Math.max(0, n) }));

  const reserve = async () => {
    setBusy(true); setError(null);
    try {
      const r = await call(`/holds`, { method: "POST", body: { sessionId, items } });
      setHold({ ...r.hold, expiresAtMs: Date.parse(r.hold.expiresAt) });
    } catch (e) { setError(e); if (e.code === "sold_out" || e.code === "session_not_available") load(); }
    finally { setBusy(false); }
  };
  const release = async (h) => {
    try { await call(`/holds/${h.id}`, { method: "DELETE", headers: { "x-alkao-hold-token": h.token } }); } catch {}
  };
  const checkout = async (h, who) => {
    const shop = config.publicUrl ?? location.origin;
    const r = await call(`/holds/${h.id}/checkout`, {
      method: "POST",
      headers: { "x-alkao-hold-token": h.token },
      body: {
        buyer: { email: who.email.trim(), fullName: who.fullName.trim() || null, phone: who.phone.trim() || null },
        successUrl: `${shop}/acheter/merci/${route.c}/${route.b}/${h.id}`,
        cancelUrl: `${shop}/acheter/${route.c}/${route.b}/${route.eventId}#annule=${h.id}`,
      },
    });
    save(h.id, { orderId: r.order.id, token: r.order.token, holdToken: h.token, buyer: who });
    if (r.checkoutUrl) location.assign(r.checkoutUrl);
    else location.assign(`/billets#${new URLSearchParams({ c: route.c, b: route.b, o: r.order.id, k: r.order.token })}`);
  };
  const pay = async (e) => {
    e.preventDefault(); setBusy(true); setError(null);
    try { await checkout(hold, buyer); } catch (err) { setError(err); setBusy(false); }
  };

  if (notice) {
    const resume = async () => { setBusy(true); try { await checkout({ id: notice.holdId, token: notice.holdToken }, notice.buyer); } catch (e) { setError(e); setNotice(null); setBusy(false); } };
    const drop = async () => { setBusy(true); await release({ id: notice.holdId, token: notice.holdToken }); sessionStorage.removeItem(STORE(notice.holdId)); setNotice(null); setBusy(false); load(); };
    return html`<main>
      <p class="brand">${ev.brand?.name ?? ""}</p><h1>${ev.title}</h1>
      <div class="alert" role="status">Paiement non terminé. Vos places sont encore réservées quelques minutes.</div>
      ${error && html`<div class="alert bad" role="alert">${errText(error)}</div>`}
      <div class="actions"><button disabled=${busy} onClick=${resume}>Reprendre le paiement</button>
        <button class="secondary" disabled=${busy} onClick=${drop}>Libérer mes places</button></div>
    </main>`;
  }

  return html`<main>
    <p class="brand">${ev.brand?.name ?? ""}</p>
    <h1>${ev.title}</h1>
    ${ev.venue && html`<p class="muted">${ev.venue.name}${ev.venue.city ? `, ${ev.venue.city}` : ""}</p>`}
    ${ev.description && html`<p>${ev.description}</p>`}
    ${error && html`<div class="alert bad" role="alert">${errText(error)}</div>`}

    ${!hold && html`
      <h2>1. Choisissez votre séance</h2>
      ${data.sessions.length === 0 ? html`<p class="muted">Aucune séance en vente pour le moment.</p>` : html`<div class="sessions">
        ${data.sessions.map((s) => html`<button class="session" aria-pressed=${s.id === sessionId ? "true" : "false"} disabled=${s.available === 0} onClick=${() => setSessionId(s.id)}>
          <span>${whenFr(s.startsAt, tz)}</span>
          <span class="muted">${s.available === 0 ? "Complet" : s.available <= 20 ? `Plus que ${s.available} places` : "Places disponibles"}</span></button>`)}
      </div>`}

      ${sessionId && html`
        <h2>2. Vos billets</h2>
        <div class="card">
          ${[...admissions, ...addOns].map((t) => html`<div class="type">
            <div><div class="name">${t.name}</div><div class="muted">${t.priceCents === 0 ? "Gratuit" : money(t.priceCents)}${t.kind === "add_on" ? " · option, une par entrée" : ""}${t.minQuantity > 1 ? ` · minimum ${t.minQuantity}` : ""}</div></div>
            <div class="stepper">
              <button class="secondary" aria-label=${`Retirer ${t.name}`} disabled=${!(qty[t.id] > 0)} onClick=${() => set(t.id, (qty[t.id] ?? 0) - 1)}>−</button>
              <output aria-label=${`Quantité ${t.name}`}>${qty[t.id] ?? 0}</output>
              <button class="secondary" aria-label=${`Ajouter ${t.name}`} disabled=${(qty[t.id] ?? 0) >= t.maxQuantity} onClick=${() => set(t.id, (qty[t.id] ?? 0) + 1)}>+</button>
            </div></div>`)}
        </div>
        ${violations.length > 0 && html`<div class="alert" role="alert"><ul class="violations">${violations.map((v) => html`<li>${violationText(v, data.ticketTypes)}</li>`)}</ul></div>`}
        ${quote && html`<div class="card"><table class="quote"><tbody>
          ${quote.lines.map((l) => html`<tr><td>${l.quantity} × ${l.name}</td><td class="num">${money(l.lineTotalCents)}</td></tr>`)}
          ${quote.taxes.map((t) => html`<tr><td class="muted">${t.code === "GST" ? "TPS" : t.code === "QST" ? "TVQ" : t.labelFr}</td><td class="num muted">${money(t.amountCents)}</td></tr>`)}
          <tr class="total"><td>Total</td><td class="num">${money(quote.totalCents)}</td></tr>
        </tbody></table></div>`}
        <div class="actions"><button disabled=${busy || !quote || violations.length > 0 || (session && wanted > session.available)} onClick=${reserve}>Continuer</button></div>`}`}

    ${hold && html`
      <h2>3. Vos coordonnées</h2>
      <div class="alert" role="status">Places réservées pendant <${Countdown} until=${hold.expiresAtMs} onExpire=${() => { setHold(null); setError(new ApiError(409, "hold_not_active")); load(); }} />.</div>
      <div class="card"><table class="quote"><tbody>
        <tr><td colspan="2"><strong>${whenFr(session?.startsAt ?? hold.quote?.startsAt ?? Date.now(), tz)}</strong></td></tr>
        ${hold.quote.lines.map((l) => html`<tr><td>${l.quantity} × ${l.name}</td><td class="num">${money(l.lineTotalCents)}</td></tr>`)}
        <tr class="total"><td>Total</td><td class="num">${money(hold.quote.totalCents)}</td></tr></tbody></table></div>
      <form class="card" onSubmit=${pay}>
        <label>Courriel (vos billets y seront envoyés)<input type="email" required autocomplete="email" value=${buyer.email} onInput=${(e) => setBuyer({ ...buyer, email: e.target.value })} /></label>
        <label>Nom complet<input required autocomplete="name" value=${buyer.fullName} onInput=${(e) => setBuyer({ ...buyer, fullName: e.target.value })} /></label>
        <label>Téléphone (facultatif)<input type="tel" autocomplete="tel" value=${buyer.phone} onInput=${(e) => setBuyer({ ...buyer, phone: e.target.value })} /></label>
        <div class="actions">
          <button type="submit" disabled=${busy}>${hold.quote.totalCents === 0 ? "Obtenir mes billets" : `Payer ${money(hold.quote.totalCents)}`}</button>
          <button type="button" class="secondary" disabled=${busy} onClick=${async () => { await release(hold); setHold(null); load(); }}>Modifier ma sélection</button>
        </div>
        ${hold.quote.totalCents > 0 && html`<p class="muted">Paiement sécurisé par Stripe, directement à l'organisateur.</p>`}
      </form>`}
    <footer>Billetterie ALKAO</footer>
  </main>`;
}

// ── Brand: published events ─────────────────────────────────────────────────
function EventList() {
  const [state, setState] = useState(null);
  useEffect(() => { call(`/events`).then((d) => setState({ events: d.events }), (e) => setState({ error: e })); }, []);
  if (!state) return html`<main><p class="boot">Chargement…</p></main>`;
  if (state.error) return html`<main><div class="alert bad" role="alert">${errText(state.error)}</div></main>`;
  return html`<main><h1>Billetterie</h1>
    ${state.events.length === 0 ? html`<p class="muted">Aucun événement en vente pour le moment.</p>`
      : html`<ul class="events card">${state.events.map((e) => html`<li><a href=${`/acheter/${route.c}/${route.b}/${e.id}`}>${e.title}</a></li>`)}</ul>`}
    <footer>Billetterie ALKAO</footer></main>`;
}

// ── Back from Stripe ────────────────────────────────────────────────────────
function Thanks() {
  const s = saved(route.holdId);
  useEffect(() => {
    if (s) location.replace(`/billets#${new URLSearchParams({ c: route.c, b: route.b, o: s.orderId, k: s.token })}`);
  }, []);
  if (s) return html`<main><p class="boot">Merci ! Ouverture de vos billets…</p></main>`;
  return html`<main><h1>Merci !</h1><div class="alert ok" role="status">Votre paiement est en cours de confirmation. Vos billets vous seront envoyés par courriel dans quelques minutes.</div></main>`;
}

function App() {
  const [config, setConfig] = useState(null);
  useEffect(() => { fetch("/shop/config.json").then((r) => r.json()).then(setConfig, () => setConfig({})); }, []);
  if (!route) return html`<main><div class="alert bad" role="alert">Adresse de billetterie incomplète.</div></main>`;
  if (!config) return html`<main><p class="boot">Chargement…</p></main>`;
  return route.page === "merci" ? html`<${Thanks} />` : route.page === "events" ? html`<${EventList} />` : html`<${EventShop} config=${config} />`;
}

render(html`<${App} />`, document.getElementById("app"));
