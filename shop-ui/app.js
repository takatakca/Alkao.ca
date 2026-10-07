// ALKAO — hosted ticket shop (Run 08). A Brand can sell with a plain link:
//   /acheter/<clientId>/<brandId>              published events
//   /acheter/<clientId>/<brandId>/<eventId>    choose a session and tickets, pay
//   /acheter/merci/<clientId>/<brandId>/<holdId>  back from Stripe → the buyer's tickets
// Every price comes from the server; the page only sends what the buyer picked.
import { html, render, useEffect, useRef, useState } from "/shop/vendor/htm-preact.js";
import { localeOf, pickLanguage, switchLanguage } from "/shop/i18n.js";

// Run 16: French by default, English on request (?lang=en, the switch, or the browser).
const LANG = pickLanguage();
document.documentElement.lang = LANG === "en" ? "en-CA" : "fr-CA";
const T = {
  fr: {
    errors: {
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
      promo_code_invalid: "Le code promo n'est plus valide. Changez votre sélection et retirez-le.",
      add_on_sold_out: "Une option choisie vient de s'épuiser pour cette séance. Retirez-la ou changez de séance.",
    },
    generic: "Une erreur est survenue. Réessayez dans un instant.",
    promo: {
      label: "Code promo", apply: "Appliquer", remove: "Retirer le code", discount: (c) => `Rabais (${c})`,
      unknown: "Ce code n'existe pas pour cet événement.", inactive: "Ce code n'est plus actif.",
      not_started: "Ce code n'est pas encore valide.", ended: "Ce code a expiré.", used_up: "Ce code a atteint sa limite d'utilisations.",
    },
    v: {
      above_maximum: (n, l) => `${n} : ${l} au maximum par commande.`,
      below_minimum: (n, l) => `${n} : ${l} au minimum.`,
      max_adults_exceeded: (n, l) => `${n} : ${l} adulte${l > 1 ? "s" : ""} au maximum dans la commande.`,
      add_on_without_admission: (n) => `${n} s'ajoute à une entrée : choisissez d'abord vos billets.`,
      add_on_quantity_mismatch: (n, l, scope) => scope === "up_to_admissions" ? `${n} : ${l} au maximum, un par entrée.` : `${n} : choisissez-en ${l}, un par entrée.`,
      order_too_large: () => "Commande trop grande.",
      other: () => "Sélection invalide.",
    },
    loading: "Chargement…",
    testMode: "Mode test : aucun paiement réel. Utilisez une carte de test Stripe.",
    notFinished: "Paiement non terminé. Vos places sont encore réservées quelques minutes.",
    resume: "Reprendre le paiement",
    release: "Libérer mes places",
    step1: "1. Choisissez votre séance",
    noSessions: "Aucune séance en vente pour le moment.",
    doorSale: "Vente à la porte",
    noSessionsToday: "Aucune séance à vendre aujourd'hui.",
    full: "Complet",
    fewLeft: (n) => `Plus que ${n} places`,
    available: "Places disponibles",
    step2: "2. Vos billets",
    free: "Gratuit",
    perAdmission: " · option, une par entrée",
    upToAdmissions: " · option, une par personne au plus",
    perOrder: " · option",
    addOnLeft: (n) => (n === 0 ? " · épuisé" : n <= 10 ? ` · plus que ${n}` : ""),
    openDate: " · date modifiable",
    minimum: (n) => ` · minimum ${n}`,
    remove: (n) => `Retirer ${n}`,
    quantity: (n) => `Quantité ${n}`,
    add: (n) => `Ajouter ${n}`,
    gst: "TPS", qst: "TVQ",
    total: "Total",
    next: "Continuer",
    step3: "3. Vos coordonnées",
    heldFor: "Places réservées pendant ",
    email: "Courriel (vos billets y seront envoyés)",
    name: "Nom complet",
    phone: "Téléphone (facultatif)",
    getFree: "Obtenir mes billets",
    pay: (m) => `Payer ${m}`,
    change: "Modifier ma sélection",
    stripe: "Paiement sécurisé par Stripe, directement à l'organisateur.",
    footer: "Billetterie ALKAO",
    shop: "Billetterie",
    noEvents: "Aucun événement en vente pour le moment.",
    opening: "Merci ! Ouverture de vos billets…",
    thanks: "Merci !",
    confirming: "Votre paiement est en cours de confirmation. Vos billets vous seront envoyés par courriel dans quelques minutes.",
    badAddress: "Adresse de billetterie incomplète.",
    findTitle: "Vous avez déjà acheté ? Retrouvez vos billets",
    findEmail: "Le courriel utilisé pour l'achat",
    findSend: "Renvoyer mes billets",
    findSent: "Si une commande à venir correspond à cette adresse, vos billets viennent de vous être renvoyés. Vérifiez aussi vos courriels indésirables.",
    other: "English",
  },
  en: {
    errors: {
      ticketing_unavailable: "This organizer's ticketing is closed for now.",
      event_not_found: "This event is not on sale.",
      sold_out: "Not enough seats are left for this session.",
      session_not_available: "This session is no longer on sale.",
      hold_not_active: "Your reservation expired. Please choose again.",
      hold_not_found: "Your reservation expired. Please choose again.",
      rate_limited: "Too many attempts. Please wait a minute.",
      payments_unavailable: "Online payment is not open yet for this organizer.",
      payment_provider_error: "The payment service is not responding. Please try again.",
      return_url_not_allowed: "The organizer's payment setup is incomplete.",
      invalid_request: "Please check your details.",
      promo_code_invalid: "The promo code is no longer valid. Change your selection and remove it.",
      add_on_sold_out: "An option you chose just sold out for this session. Remove it or pick another session.",
    },
    generic: "Something went wrong. Please try again in a moment.",
    promo: {
      label: "Promo code", apply: "Apply", remove: "Remove the code", discount: (c) => `Discount (${c})`,
      unknown: "This code does not exist for this event.", inactive: "This code is no longer active.",
      not_started: "This code is not valid yet.", ended: "This code has expired.", used_up: "This code has reached its limit.",
    },
    v: {
      above_maximum: (n, l) => `${n}: at most ${l} per order.`,
      below_minimum: (n, l) => `${n}: at least ${l}.`,
      max_adults_exceeded: (n, l) => `${n}: at most ${l} adult${l > 1 ? "s" : ""} in the order.`,
      add_on_without_admission: (n) => `${n} goes with an admission: choose your tickets first.`,
      add_on_quantity_mismatch: (n, l, scope) => scope === "up_to_admissions" ? `${n}: ${l} at most, one per admission.` : `${n}: choose ${l}, one per admission.`,
      order_too_large: () => "Order too large.",
      other: () => "Invalid selection.",
    },
    loading: "Loading…",
    testMode: "Test mode: no real payment. Use a Stripe test card.",
    notFinished: "Payment not completed. Your seats are still held for a few minutes.",
    resume: "Resume payment",
    release: "Release my seats",
    step1: "1. Choose your session",
    noSessions: "No session on sale right now.",
    doorSale: "Door sale",
    noSessionsToday: "No session to sell today.",
    full: "Sold out",
    fewLeft: (n) => `Only ${n} seats left`,
    available: "Seats available",
    step2: "2. Your tickets",
    free: "Free",
    perAdmission: " · option, one per admission",
    upToAdmissions: " · option, at most one per person",
    perOrder: " · option",
    addOnLeft: (n) => (n === 0 ? " · sold out" : n <= 10 ? ` · only ${n} left` : ""),
    openDate: " · date can be changed",
    minimum: (n) => ` · minimum ${n}`,
    remove: (n) => `Remove ${n}`,
    quantity: (n) => `Quantity ${n}`,
    add: (n) => `Add ${n}`,
    gst: "GST", qst: "QST",
    total: "Total",
    next: "Continue",
    step3: "3. Your details",
    heldFor: "Seats held for ",
    email: "Email (your tickets will be sent there)",
    name: "Full name",
    phone: "Phone (optional)",
    getFree: "Get my tickets",
    pay: (m) => `Pay ${m}`,
    change: "Change my selection",
    stripe: "Secure payment by Stripe, directly to the organizer.",
    footer: "ALKAO Ticketing",
    shop: "Tickets",
    noEvents: "No event on sale right now.",
    opening: "Thank you! Opening your tickets…",
    thanks: "Thank you!",
    confirming: "Your payment is being confirmed. Your tickets will be emailed to you within a few minutes.",
    badAddress: "Incomplete ticketing address.",
    findTitle: "Already bought? Find your tickets",
    findEmail: "The email used for the purchase",
    findSend: "Send my tickets again",
    findSent: "If an upcoming order matches this address, your tickets have just been sent again. Also check your spam folder.",
    other: "Français",
  },
}[LANG];
const switcher = html`<p class="lang"><button class="link" onClick=${() => switchLanguage(LANG === "en" ? "fr" : "en")}>${T.other}</button></p>`;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// Run 35: door sales. The same shop and the same Stripe payment (so the same commission),
// on the staff member's phone or tablet, showing only today's sessions. Card only.
const DOOR = new URLSearchParams(location.search).get("porte") === "1";
const dayIn = (date, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz || "America/Toronto", dateStyle: "short" }).format(date);

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
const SCOPE_TEXT = (t) => (t.addOnScope === "per_order" ? T.perOrder : t.addOnScope === "up_to_admissions" ? T.upToAdmissions : T.perAdmission);

// Run 49: the ad's UTM tags on the shop's link go with the order, for the campaign report.
const ATTRIBUTION = (() => {
  const q = new URLSearchParams(location.search);
  const a = {};
  for (const key of ["source", "medium", "campaign", "content", "term"]) {
    const v = q.get(`utm_${key}`)?.trim();
    if (v && v.length <= 100 && !/[<>\u0000-\u001f]/.test(v)) a[key] = v;
  }
  if (Object.keys(a).length === 0) return null;
  a.landing = location.pathname.slice(0, 200);
  return a;
})();
const saved = (holdId) => { try { return JSON.parse(sessionStorage.getItem(STORE(holdId)) ?? "null"); } catch { return null; } };
const save = (holdId, value) => { try { sessionStorage.setItem(STORE(holdId), JSON.stringify(value)); } catch {} };

const money = (cents) => (Number(cents ?? 0) / 100).toLocaleString(localeOf(LANG), { style: "currency", currency: "CAD" });
const whenFr = (iso, tz) => new Intl.DateTimeFormat(localeOf(LANG), { dateStyle: "full", timeStyle: "short", timeZone: tz || "America/Toronto" }).format(new Date(iso));

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

const errText = (e) => T.errors[e?.code] ?? T.generic;

function violationText(v, types) {
  const type = types.find((t) => t.id === v.ticketTypeId);
  const name = type?.name ?? "";
  if (v.code === "add_on_quantity_mismatch") return T.v.add_on_quantity_mismatch(name, v.limit, type?.addOnScope);
  switch (v.code) {
    case "above_maximum":
    case "below_minimum":
    case "max_adults_exceeded":
    case "add_on_without_admission":
    case "add_on_quantity_mismatch":
    case "order_too_large":
      return T.v[v.code](name, v.limit);
    default: return T.v.other();
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
  // Run 36: the code as typed, the code applied (checked by the server), and why it was refused.
  const [promoInput, setPromoInput] = useState("");
  const [promo, setPromo] = useState(null);
  const [promoError, setPromoError] = useState(null);
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
    const t = setTimeout(() => call(`/events/${route.eventId}/quote`, { method: "POST", body: { items, ...(promo ? { promoCode: promo } : {}) } }).then(
      (r) => { if (n === seq.current) { setQuote(r.quote); setViolations([]); } },
      (e) => {
        if (n !== seq.current) return;
        if (e.code === "promo_code_invalid") { setPromoError(e.details?.reason ?? "unknown"); setPromo(null); return; }
        setQuote(null); setViolations(e.code === "cart_invalid" ? e.details ?? [] : []); if (e.code !== "cart_invalid") setError(e);
      },
    ), 200);
    return () => clearTimeout(t);
  }, [JSON.stringify(items), promo]);

  if (error && !data) return html`<main><div class="alert bad" role="alert">${errText(error)}</div></main>`;
  if (!data) return html`<main><p class="boot">${T.loading}</p></main>`;
  const ev = data.event;
  const tz = ev.venue?.timezone;
  const admissions = data.ticketTypes.filter((t) => t.kind === "admission");
  const addOns = data.ticketTypes.filter((t) => t.kind === "add_on");
  const wanted = items.reduce((n, i) => n + (data.ticketTypes.find((t) => t.id === i.ticketTypeId)?.kind === "admission" ? i.quantity : 0), 0);
  const today = dayIn(new Date(), tz);
  const sessions = DOOR ? data.sessions.filter((s) => dayIn(new Date(s.startsAt), tz) === today) : data.sessions;
  const session = sessions.find((s) => s.id === sessionId);
  const set = (id, n) => setQty((q) => ({ ...q, [id]: Math.max(0, n) }));
  // Run 49: what is left of an add-on with a stock, for the chosen session (null: no limit).
  const left = (t) => (t.kind === "add_on" && session?.addOnsAvailable && t.id in session.addOnsAvailable ? session.addOnsAvailable[t.id] : null);

  const reserve = async () => {
    setBusy(true); setError(null);
    try {
      const r = await call(`/holds`, { method: "POST", body: { sessionId, items, ...(promo ? { promoCode: promo } : {}) } });
      setHold({ ...r.hold, expiresAtMs: Date.parse(r.hold.expiresAt) });
    } catch (e) {
      if (e.code === "promo_code_invalid") { setPromoError(e.details?.reason ?? "unknown"); setPromo(null); }
      else setError(e);
      if (e.code === "sold_out" || e.code === "add_on_sold_out" || e.code === "session_not_available") load();
    }
    finally { setBusy(false); }
  };
  const applyPromo = (e) => { e.preventDefault(); setPromoError(null); setPromo(promoInput.trim() ? promoInput.trim().toUpperCase() : null); };
  const release = async (h) => {
    try { await call(`/holds/${h.id}`, { method: "DELETE", headers: { "x-alkao-hold-token": h.token } }); } catch {}
  };
  const checkout = async (h, who) => {
    const shop = config.publicUrl ?? location.origin;
    const r = await call(`/holds/${h.id}/checkout`, {
      method: "POST",
      headers: { "x-alkao-hold-token": h.token },
      body: {
        buyer: { email: who.email.trim(), fullName: who.fullName.trim() || null, phone: who.phone.trim() || null, language: LANG },
        successUrl: `${shop}/acheter/merci/${route.c}/${route.b}/${h.id}`,
        cancelUrl: `${shop}/acheter/${route.c}/${route.b}/${route.eventId}${DOOR ? "?porte=1" : ""}#annule=${h.id}`,
        ...(ATTRIBUTION ? { attribution: ATTRIBUTION } : {}),
      },
    });
    save(h.id, { orderId: r.order.id, token: r.order.token, holdToken: h.token, buyer: who, door: DOOR });
    if (r.checkoutUrl) location.assign(r.checkoutUrl);
    else location.assign(`/billets#${new URLSearchParams({ c: route.c, b: route.b, o: r.order.id, k: r.order.token, ...(DOOR ? { porte: "1" } : {}) })}`);
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
      <div class="alert" role="status">${T.notFinished}</div>
      ${error && html`<div class="alert bad" role="alert">${errText(error)}</div>`}
      <div class="actions"><button disabled=${busy} onClick=${resume}>${T.resume}</button>
        <button class="secondary" disabled=${busy} onClick=${drop}>${T.release}</button></div>
    </main>`;
  }

  return html`<main>
    ${switcher}
    <p class="brand">${ev.brand?.name ?? ""}${DOOR ? html` · <span class="badge">${T.doorSale}</span>` : ""}</p>
    <h1>${ev.title}</h1>
    ${ev.venue && html`<p class="muted">${ev.venue.name}${ev.venue.city ? `, ${ev.venue.city}` : ""}</p>`}
    ${ev.description && html`<p>${ev.description}</p>`}
    ${error && html`<div class="alert bad" role="alert">${errText(error)}</div>`}

    ${!hold && html`
      <h2>${T.step1}</h2>
      ${sessions.length === 0 ? html`<p class="muted">${DOOR ? T.noSessionsToday : T.noSessions}</p>` : html`<div class="sessions">
        ${sessions.map((s) => html`<button class="session" aria-pressed=${s.id === sessionId ? "true" : "false"} disabled=${s.available === 0} onClick=${() => setSessionId(s.id)}>
          <span>${whenFr(s.startsAt, tz)}</span>
          <span class="muted">${s.available === 0 ? T.full : s.available <= 20 ? T.fewLeft(s.available) : T.available}</span></button>`)}
      </div>`}

      ${sessionId && html`
        <h2>${T.step2}</h2>
        <div class="card">
          ${[...admissions, ...addOns].map((t) => html`<div class="type">
            <div><div class="name">${t.name}</div><div class="muted">${t.priceCents === 0 ? T.free : money(t.priceCents)}${t.kind === "add_on" ? SCOPE_TEXT(t) : ""}${t.openDate ? T.openDate : ""}${t.minQuantity > 1 ? T.minimum(t.minQuantity) : ""}${left(t) !== null ? T.addOnLeft(left(t)) : ""}</div></div>
            <div class="stepper">
              <button class="secondary" aria-label=${T.remove(t.name)} disabled=${!(qty[t.id] > 0)} onClick=${() => set(t.id, (qty[t.id] ?? 0) - 1)}>−</button>
              <output aria-label=${T.quantity(t.name)}>${qty[t.id] ?? 0}</output>
              <button class="secondary" aria-label=${T.add(t.name)} disabled=${(qty[t.id] ?? 0) >= Math.min(t.maxQuantity, left(t) ?? Infinity)} onClick=${() => set(t.id, (qty[t.id] ?? 0) + 1)}>+</button>
            </div></div>`)}
        </div>
        ${violations.length > 0 && html`<div class="alert" role="alert"><ul class="violations">${violations.map((v) => html`<li>${violationText(v, data.ticketTypes)}</li>`)}</ul></div>`}
        <form class="card promo" onSubmit=${applyPromo}>
          <label>${T.promo.label}<input value=${promoInput} autocomplete="off" autocapitalize="characters" onInput=${(e) => setPromoInput(e.target.value)} /></label>
          <div class="actions">
            <button type="submit" class="secondary">${T.promo.apply}</button>
            ${promo && html`<button type="button" class="secondary" onClick=${() => { setPromo(null); setPromoInput(""); setPromoError(null); }}>${T.promo.remove}</button>`}
          </div>
          ${promoError && html`<div class="alert" role="alert">${T.promo[promoError] ?? T.promo.unknown}</div>`}
        </form>
        ${quote && html`<div class="card"><table class="quote"><tbody>
          ${quote.lines.map((l) => html`<tr><td>${l.quantity} × ${l.name}</td><td class="num">${money(l.lineTotalCents)}</td></tr>`)}
          ${quote.discountCents > 0 && html`<tr><td>${T.promo.discount(quote.promoCode)}</td><td class="num">−${money(quote.discountCents)}</td></tr>`}
          ${quote.taxes.map((t) => html`<tr><td class="muted">${t.code === "GST" ? T.gst : t.code === "QST" ? T.qst : t.labelFr}</td><td class="num muted">${money(t.amountCents)}</td></tr>`)}
          <tr class="total"><td>${T.total}</td><td class="num">${money(quote.totalCents)}</td></tr>
        </tbody></table></div>`}
        <div class="actions"><button disabled=${busy || !quote || violations.length > 0 || (session && wanted > session.available)} onClick=${reserve}>${T.next}</button></div>`}`}

    ${hold && html`
      <h2>${T.step3}</h2>
      <div class="alert" role="status">${T.heldFor}<${Countdown} until=${hold.expiresAtMs} onExpire=${() => { setHold(null); setError(new ApiError(409, "hold_not_active")); load(); }} />.</div>
      <div class="card"><table class="quote"><tbody>
        <tr><td colspan="2"><strong>${whenFr(session?.startsAt ?? hold.quote?.startsAt ?? Date.now(), tz)}</strong></td></tr>
        ${hold.quote.lines.map((l) => html`<tr><td>${l.quantity} × ${l.name}</td><td class="num">${money(l.lineTotalCents)}</td></tr>`)}
        ${hold.quote.discountCents > 0 && html`<tr><td>${T.promo.discount(hold.quote.promoCode)}</td><td class="num">−${money(hold.quote.discountCents)}</td></tr>`}
        <tr class="total"><td>${T.total}</td><td class="num">${money(hold.quote.totalCents)}</td></tr></tbody></table></div>
      <form class="card" onSubmit=${pay}>
        <label>${T.email}<input type="email" required autocomplete="email" value=${buyer.email} onInput=${(e) => setBuyer({ ...buyer, email: e.target.value })} /></label>
        <label>${T.name}<input required autocomplete="name" value=${buyer.fullName} onInput=${(e) => setBuyer({ ...buyer, fullName: e.target.value })} /></label>
        <label>${T.phone}<input type="tel" autocomplete="tel" value=${buyer.phone} onInput=${(e) => setBuyer({ ...buyer, phone: e.target.value })} /></label>
        <div class="actions">
          <button type="submit" disabled=${busy}>${hold.quote.totalCents === 0 ? T.getFree : T.pay(money(hold.quote.totalCents))}</button>
          <button type="button" class="secondary" disabled=${busy} onClick=${async () => { await release(hold); setHold(null); load(); }}>${T.change}</button>
        </div>
        ${hold.quote.totalCents > 0 && html`<p class="muted">${T.stripe}</p>`}
      </form>`}
    ${!hold && !DOOR && html`<${FindTickets} />`}
    <footer>${T.footer}</footer>
  </main>`;
}

// ── Run 27: lost the email? The tickets are sent again to the same address ──
function FindTickets() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    setState("busy");
    try { await call(`/tickets/resend`, { method: "POST", body: { email: email.trim() } }); setState("sent"); }
    catch (err) { setState({ error: err }); }
  };
  return html`<section class="card find" aria-labelledby="find-title">
    <h2 id="find-title">${T.findTitle}</h2>
    ${state === "sent" ? html`<div class="alert ok" role="status">${T.findSent}</div>` : html`
      <form onSubmit=${submit}>
        <label>${T.findEmail}<input type="email" required autocomplete="email" value=${email} onInput=${(e) => setEmail(e.target.value)} /></label>
        <div class="actions"><button type="submit" class="secondary" disabled=${state === "busy"}>${T.findSend}</button></div>
      </form>`}
    ${state?.error && html`<div class="alert bad" role="alert">${errText(state.error)}</div>`}
  </section>`;
}

// ── Brand: published events ─────────────────────────────────────────────────
function EventList() {
  const [state, setState] = useState(null);
  useEffect(() => { call(`/events`).then((d) => setState({ events: d.events }), (e) => setState({ error: e })); }, []);
  if (!state) return html`<main><p class="boot">${T.loading}</p></main>`;
  if (state.error) return html`<main><div class="alert bad" role="alert">${errText(state.error)}</div></main>`;
  return html`<main>${switcher}<h1>${T.shop}</h1>
    ${state.events.length === 0 ? html`<p class="muted">${T.noEvents}</p>`
      : html`<ul class="events card">${state.events.map((e) => html`<li><a href=${`/acheter/${route.c}/${route.b}/${e.id}`}>${e.title}</a></li>`)}</ul>`}
    <${FindTickets} />
    <footer>${T.footer}</footer></main>`;
}

// ── Back from Stripe ────────────────────────────────────────────────────────
function Thanks() {
  const s = saved(route.holdId);
  useEffect(() => {
    if (s) location.replace(`/billets#${new URLSearchParams({ c: route.c, b: route.b, o: s.orderId, k: s.token, ...(s.door ? { porte: "1" } : {}) })}`);
  }, []);
  if (s) return html`<main><p class="boot">${T.opening}</p></main>`;
  return html`<main><h1>${T.thanks}</h1><div class="alert ok" role="status">${T.confirming}</div></main>`;
}

function App() {
  const [config, setConfig] = useState(null);
  useEffect(() => { fetch("/shop/config.json").then((r) => r.json()).then(setConfig, () => setConfig({})); }, []);
  if (!route) return html`<main><div class="alert bad" role="alert">${T.badAddress}</div></main>`;
  if (!config) return html`<main><p class="boot">${T.loading}</p></main>`;
  // Run 32: with Stripe test keys, buyers are told that nothing will be charged.
  const testMode = config.paymentsMode === "test" && html`<header class="testmode"><p role="status">${T.testMode}</p></header>`;
  const page = route.page === "merci" ? html`<${Thanks} />` : route.page === "events" ? html`<${EventList} />` : html`<${EventShop} config=${config} />`;
  return html`${testMode}${page}`;
}

render(html`<${App} />`, document.getElementById("app"));
