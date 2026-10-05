// ALKAO Operations — standalone web app (Run 04, step 1).
// Plain ES modules, no build step. Every call goes to the gated ALKAO admin API with the
// signed-in user's Supabase access token; the app itself holds no data.
import { html, render, useEffect, useState, useCallback } from "/ops/vendor/htm-preact.js";
import { loadOffline, newOfflineStore, offlineScan, saveOffline, syncOffline } from "/ops/offline.js";

const SESSION_KEY = "alkao.ops.session";
const money = (cents) => (Number(cents ?? 0) / 100).toLocaleString("fr-CA", { style: "currency", currency: "CAD" });
const when = (iso) => (iso ? new Date(iso).toLocaleString("fr-CA", { dateStyle: "medium", timeStyle: "short" }) : "—");
const STATUS_FR = {
  draft: "Brouillon", published: "Publié", cancelled: "Annulé", archived: "Archivé", on_sale: "En vente", paused: "En pause",
  closed: "Fermé", pending_payment: "En attente de paiement", paid: "Payée", partially_refunded: "Remboursée en partie",
  refunded: "Remboursée", expired: "Expirée", valid: "Valide", void: "Annulé", succeeded: "Réussi", pending: "En cours",
  email_pending: "En attente d'envoi", email_sent: "Envoyé", email_skipped: "Non envoyé", email_failed: "Échec de l'envoi",
};
const fr = (s) => STATUS_FR[s] ?? s;
const REASON_FR = {
  operational_api_disabled: "API opérationnelle désactivée sur ce déploiement", no_entitlement: "Ticketing non activé par TAKATAK pour cette marque",
  entitlement_inactive: "Ticketing suspendu par TAKATAK", entitlement_expired: "Activation Ticketing expirée",
  entitlement_not_yet_valid: "Activation Ticketing pas encore en vigueur", client_inactive: "Client suspendu", brand_inactive: "Marque suspendue",
};
// Run 19: Stripe's dispute statuses and reasons.
const DISPUTE_FR = {
  warning_needs_response: "Demande de renseignements : réponse attendue", warning_under_review: "Demande de renseignements : à l'étude",
  warning_closed: "Demande de renseignements close", needs_response: "Réponse attendue", under_review: "À l'étude par la banque",
  won: "Gagné", lost: "Perdu", prevented: "Évité",
};
const DISPUTE_REASON_FR = {
  fraudulent: "fraude", duplicate: "paiement en double", product_not_received: "service non reçu", product_unacceptable: "service non conforme",
  subscription_canceled: "abonnement annulé", credit_not_processed: "remboursement non reçu", unrecognized: "paiement non reconnu", general: "autre",
};
function DisputeNotice({ d }) {
  const reason = DISPUTE_REASON_FR[d.reason] ?? d.reason;
  if (!d.open) return html`<p class="muted">Litige Stripe ${money(d.amountCents)} (${reason}) : ${DISPUTE_FR[d.status] ?? d.status}.</p>`;
  return html`<div class="alert bad" role="alert">
    <strong>Litige Stripe (rétrofacturation) : ${DISPUTE_FR[d.status] ?? d.status}</strong> — ${money(d.amountCents)}, motif : ${reason}${d.evidenceDueBy ? html`, réponse avant le <strong>${when(d.evidenceDueBy)}</strong>` : ""}.
    Répondez depuis votre tableau de bord Stripe. Les heures d'entrée des billets ci-dessous peuvent servir de preuve. ALKAO n'a annulé aucun billet.</div>`;
}

const SCAN_FR = {
  admitted: ["ok", "ENTRÉE ACCEPTÉE"], already_admitted: ["bad", "DÉJÀ ENTRÉ"], revoked: ["bad", "BILLET ANNULÉ"],
  wrong_session: ["warn", "MAUVAISE SÉANCE"], too_early: ["warn", "TROP TÔT"], too_late: ["warn", "TROP TARD"],
  unknown_credential: ["bad", "BILLET INCONNU"], invalid_signature: ["bad", "FAUX BILLET"], unknown_key: ["bad", "BILLET D'UN AUTRE ORGANISATEUR"],
  malformed: ["bad", "CODE ILLISIBLE"],
};

// ── Session (Supabase Auth) ─────────────────────────────────────────────────
// Embedded in the TAKATAK dashboard, the session lives in memory only and comes from the
// parent page (see embedBridge); standalone, it lives in sessionStorage.
let embedded = false;
let memorySession = null;
function loadSession() {
  if (embedded) return memorySession;
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? "null"); } catch { return null; }
}
function saveSession(s) {
  if (embedded) { memorySession = s; return; }
  if (s) sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); else sessionStorage.removeItem(SESSION_KEY);
}

// ── Embedded in the TAKATAK dashboard ───────────────────────────────────────
// The parent hands over the signed-in user's access token by postMessage: ALKAO says
// `alkao.ready` (and `alkao.session_expired` when the token is about to lapse), the parent
// answers `alkao.session`. No refresh token ever crosses: refreshing here would rotate it and
// sign the user out of TAKATAK. Only messages from the parent window, from an origin listed
// in ALKAO_OPS_FRAME_ANCESTORS, are accepted.
function embedBridge(origins, onSession) {
  let parentOrigin = null;
  const waiters = [];
  addEventListener("message", (e) => {
    if (e.source !== window.parent || !origins.includes(e.origin)) return;
    const d = e.data;
    if (d?.type !== "alkao.session" || typeof d.accessToken !== "string" || !Number.isFinite(d.expiresAt)) return;
    parentOrigin = e.origin;
    const s = { accessToken: d.accessToken, refreshToken: null, expiresAt: d.expiresAt, email: typeof d.email === "string" ? d.email : null };
    onSession(s);
    for (const resolve of waiters.splice(0)) resolve(s);
  });
  const hinted = location.ancestorOrigins?.[0] ?? (document.referrer ? new URL(document.referrer).origin : null);
  const post = (type) => {
    for (const o of parentOrigin ? [parentOrigin] : origins.includes(hinted) ? [hinted] : origins) window.parent.postMessage({ type }, o);
  };
  post("alkao.ready");
  return {
    /** Ask the parent for a fresh token; resolves with it, or null after 10 s. */
    renew() {
      post("alkao.session_expired");
      return new Promise((resolve) => { waiters.push(resolve); setTimeout(() => resolve(null), 10_000); });
    },
  };
}
let bridge = null;
let rejectedToken = null;

async function supabaseToken(config, grant, body) {
  const res = await fetch(`${config.supabaseUrl}/auth/v1/token?grant_type=${grant}`, {
    method: "POST",
    headers: { apikey: config.supabaseAnonKey, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.msg || "Connexion refusée");
  return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000, email: data.user?.email };
}

// ── API ─────────────────────────────────────────────────────────────────────
class ApiError extends Error {
  constructor(status, code, details) { super(code); this.status = status; this.code = code; this.details = details; }
}

function makeApi(getToken, onUnauthorized) {
  return async function api(path, { method = "GET", body, raw } = {}) {
    const token = await getToken();
    const res = await fetch(path, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 401) { onUnauthorized(); throw new ApiError(401, "unauthenticated"); }
    if (raw) { if (!res.ok) throw new ApiError(res.status, "download_failed"); return res; }
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? "error", data?.error?.details);
    return data;
  };
}

const ERRORS_FR = {
  ticketing_disabled: "Ticketing est désactivé pour cette marque.", forbidden: "Votre rôle ne permet pas cette action.",
  sold_out: "Plus assez de places.", capacity_below_committed: "Impossible : des places sont déjà vendues ou réservées.",
  refund_exceeds_paid: "Montant supérieur au montant remboursable.", refund_in_progress: "Un remboursement est déjà en cours.",
  order_not_refundable: "Commande non remboursable.", refund_provider_error: "Stripe a échoué : réessayez le remboursement.",
  flex_not_purchased: "Cette commande n'a pas l'option Flex Météo.", already_exchanged: "Le changement Flex a déjà été utilisé.",
  ticket_already_used: "Un billet est déjà entré : changement impossible.", session_not_available: "Séance non disponible.",
  payments_not_configured: "Paiements non configurés sur ce déploiement.", credentials_not_configured: "Codes QR non configurés sur ce déploiement.",
  invalid_request: "Données invalides.", conflict: "Existe déjà.", invalid_reference: "Référence invalide.",
  order_has_no_valid_ticket: "Cette commande n'a plus de billet valide.", email_resend_limit: "Trop de renvois pour cette commande.",
  use_session_cancellation: "Des billets sont vendus : utilisez « Annuler la séance », qui rembourse les acheteurs.",
  invalid_ticket: "Un des billets cochés n'est plus valide.",
  order_not_found: "Aucune commande avec cette référence.", ticket_not_found: "Billet introuvable.",
  buyer_has_upcoming_tickets: "L'acheteur a encore un billet pour une séance à venir : remboursez-le ou attendez la fin de la séance.",
  dispute_open: "Un litige Stripe est ouvert sur une de ses commandes : attendez qu'il soit réglé.",
  buyer_anonymized: "Cet acheteur a été anonymisé : il n'a plus d'adresse courriel.",
};
const errText = (e) => (e instanceof ApiError ? ERRORS_FR[e.code] ?? `Erreur : ${e.code}` : String(e?.message ?? e));

function useLoad(fn, deps) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const reload = useCallback(() => {
    setState((s) => ({ ...s, loading: true }));
    fn().then((data) => setState({ loading: false, data, error: null }), (error) => setState({ loading: false, data: null, error }));
  }, deps);
  useEffect(reload, [reload]);
  return [state, reload];
}

const Loading = () => html`<p class="muted">Chargement…</p>`;
const Failure = ({ error }) => html`<div class="alert bad" role="alert">${errText(error)}</div>`;
const Badge = ({ status }) => {
  const tone = ["paid", "on_sale", "published", "valid", "succeeded", "active", "email_sent"].includes(status) ? "ok"
    : ["void", "refunded", "cancelled", "expired", "email_failed"].includes(status) ? "bad" : "warn";
  return html`<span class="badge ${tone}">${fr(status)}</span>`;
};

async function download(api, path, filename) {
  const res = await api(path, { raw: true });
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

// ── Login ───────────────────────────────────────────────────────────────────
function Login({ config, onSession }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState(null);
  const supabase = Boolean(config.supabaseUrl && config.supabaseAnonKey);
  const submit = async (e) => {
    e.preventDefault(); setError(null);
    try {
      onSession(supabase ? await supabaseToken(config, "password", { email, password })
        : { accessToken: token.trim(), refreshToken: null, expiresAt: Date.now() + 3600_000, email: null });
    } catch (err) { setError(err); }
  };
  return html`<div class="login card">
    <h1>ALKAO — Opérations</h1>
    <p class="muted">Billetterie GROUPE TAKATAK</p>
    ${error && html`<${Failure} error=${error} />`}
    <form onSubmit=${submit}>
      ${supabase
        ? html`<label>Courriel<input type="email" required value=${email} onInput=${(e) => setEmail(e.target.value)} /></label>
               <label>Mot de passe<input type="password" required value=${password} onInput=${(e) => setPassword(e.target.value)} /></label>`
        : html`<p class="alert warn">Connexion Supabase non configurée : collez un jeton d'accès.</p>
               <label>Jeton d'accès<textarea rows="4" required value=${token} onInput=${(e) => setToken(e.target.value)}></textarea></label>`}
      <button type="submit">Se connecter</button>
    </form>
  </div>`;
}

// ── Workspace picker ────────────────────────────────────────────────────────
function Workspaces({ api }) {
  const [state] = useLoad(() => api("/v1/admin/me"), []);
  if (state.loading) return html`<main><${Loading} /></main>`;
  if (state.error) return html`<main><${Failure} error=${state.error} /></main>`;
  const list = state.data.memberships;
  return html`<main>
    <h1>Choisir un espace</h1>
    ${list.length === 0 && html`<p class="muted">Aucun accès Ticketing pour ce compte.</p>`}
    ${list.map((m) => html`<div class="card">
      <div class="row"><strong>${m.clientName}</strong><span class="badge">${m.role}</span></div>
      <table><tbody>${m.brands.map((b) => html`<tr>
        <td><a href=${`#/c/${m.clientId}/b/${b.brandId}/dashboard`}>${b.name}</a></td>
        <td>${b.ticketing.active ? html`<span class="badge ok">Ticketing actif</span>` : html`<span class="badge warn">${REASON_FR[b.ticketing.reason] ?? b.ticketing.reason}</span>`}</td>
      </tr>`)}</tbody></table>
    </div>`)}
  </main>`;
}

// ── Dashboard ───────────────────────────────────────────────────────────────
function Dashboard({ api, base, prefix }) {
  const [state] = useLoad(() => api(`${base}/reports/sales`), [base]);
  const [todo] = useLoad(() => api(`${base}/attention`), [base]);
  if (state.loading) return html`<${Loading} />`;
  if (state.error) return html`<${Failure} error=${state.error} />`;
  const { totals, sessions, ticketTypes } = state.data.report;
  return html`
    <h1>Tableau de bord</h1>
    ${todo.data?.attention.total > 0 && html`<${Attention} a=${todo.data.attention} prefix=${prefix} />`}
    <div class="grid">
      ${[["Commandes", totals.orders, false], ["Ventes brutes", totals.grossCents, true], ["Taxes (TPS + TVQ)", totals.taxCents, true],
         ["Remboursé", totals.refundedCents, true], ["Commission TAKATAK", totals.commissionCents - totals.commissionRefundedCents, true],
         ["Net client (avant frais Stripe)", totals.netToClientCents, true]]
        .map(([label, v, isMoney]) => html`<div class="kpi"><div class="label">${label}</div><div class="value">${isMoney ? money(v) : v}</div></div>`)}
    </div>
    <h2>Séances</h2>
    <table><thead><tr><th>Début</th><th>Statut</th><th class="num">Capacité</th><th class="num">Vendus</th><th class="num">Réservés</th><th class="num">Disponibles</th><th class="num">Entrés</th></tr></thead>
      <tbody>${sessions.map((s) => html`<tr><td>${when(s.startsAt)}</td><td><${Badge} status=${s.status} /></td><td class="num">${s.capacity}</td><td class="num">${s.sold}</td><td class="num">${s.held}</td><td class="num">${s.available}</td><td class="num">${s.admitted}</td></tr>`)}</tbody></table>
    <h2>Par type de billet</h2>
    <table><thead><tr><th>Code</th><th class="num">Quantité</th><th class="num">Revenu</th></tr></thead>
      <tbody>${ticketTypes.map((t) => html`<tr><td>${t.code}</td><td class="num">${t.quantity}</td><td class="num">${money(t.revenueCents)}</td></tr>`)}</tbody></table>
    <p><button class="secondary" onClick=${() => download(api, `${base}/reports/orders.csv`, "alkao-commandes.csv")}>Exporter les commandes (CSV)</button></p>`;
}

// Run 21: everything that waits on staff, with a link to where it is handled.
const EMAIL_KIND_FR = { order_tickets: "billets", exchange_tickets: "billets du changement de séance", session_cancelled: "annulation de séance", refund: "remboursement" };
function Attention({ a, prefix }) {
  const order = (id, reference) => html`<a href=${`#${prefix}/order/${id}`}>${reference}</a>`;
  const group = (title, items, line) => items.length > 0 && html`<h3>${title} (${items.length})</h3><ul>${items.map((x) => html`<li>${line(x)}</li>`)}</ul>`;
  return html`<section class="card attention" aria-labelledby="todo-title">
    <h2 id="todo-title">À traiter (${a.total})</h2>
    ${group("Litiges Stripe ouverts", a.disputes, (d) => html`${order(d.orderId, d.reference)} · ${d.buyerName ?? d.buyerEmail} · ${money(d.amountCents)} · ${DISPUTE_FR[d.status] ?? d.status}${d.evidenceDueBy ? ` · réponse avant le ${when(d.evidenceDueBy)}` : ""}`)}
    ${group("Remboursements bloqués chez Stripe", a.refunds, (r) => html`${order(r.orderId, r.reference)} · ${money(r.amountCents)} · depuis le ${when(r.createdAt)}${r.lastError ? ` · ${r.lastError}` : ""} — ouvrez la commande pour réessayer`)}
    ${group("Courriels non reçus", a.emails, (e) => html`${order(e.orderId, e.reference)} · ${EMAIL_KIND_FR[e.kind] ?? e.kind} · ${e.buyerEmail}${e.lastError ? ` · ${e.lastError}` : ""}`)}
    ${group("Remboursés dans Stripe, billets encore valides", a.outsideRefunds, (r) => html`${order(r.orderId, r.reference)} · ${money(r.outsideCents)} remboursés hors ALKAO`)}
    ${group("Annulations de séance à reprendre", a.cancellations, (c) => html`<a href=${`#${prefix}/event/${c.eventId}`}>Séance du ${when(c.startsAt)}</a> · ${c.failed} remboursement${c.failed > 1 ? "s" : ""} en échec`)}
  </section>`;
}

// ── Venues ──────────────────────────────────────────────────────────────────
function Venues({ api, base }) {
  const [state, reload] = useLoad(() => api(`${base}/venues`), [base]);
  const [form, setForm] = useState({ name: "", city: "" });
  const [error, setError] = useState(null);
  const create = async (e) => {
    e.preventDefault(); setError(null);
    try { await api(`${base}/venues`, { method: "POST", body: { name: form.name, city: form.city || null } }); setForm({ name: "", city: "" }); reload(); }
    catch (err) { setError(err); }
  };
  return html`<h1>Lieux</h1>
    ${error && html`<${Failure} error=${error} />`}
    <form class="inline card" onSubmit=${create}>
      <label>Nom<input required value=${form.name} onInput=${(e) => setForm({ ...form, name: e.target.value })} /></label>
      <label>Ville<input value=${form.city} onInput=${(e) => setForm({ ...form, city: e.target.value })} /></label>
      <button type="submit">Ajouter le lieu</button>
    </form>
    ${state.loading ? html`<${Loading} />` : state.error ? html`<${Failure} error=${state.error} />` : html`
      <table><thead><tr><th>Nom</th><th>Ville</th><th>Région fiscale</th></tr></thead>
        <tbody>${state.data.venues.map((v) => html`<tr><td>${v.name}</td><td>${v.city ?? "—"}</td><td>${v.taxRegion}</td></tr>`)}</tbody></table>`}`;
}

// ── Events ──────────────────────────────────────────────────────────────────
const slugify = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);

function Events({ api, base, prefix }) {
  const [events, reload] = useLoad(() => api(`${base}/events`), [base]);
  const [venues] = useLoad(() => api(`${base}/venues`), [base]);
  const [form, setForm] = useState({ title: "", venueId: "" });
  const [error, setError] = useState(null);
  const create = async (e) => {
    e.preventDefault(); setError(null);
    try {
      const venueId = form.venueId || venues.data?.venues?.[0]?.id;
      await api(`${base}/events`, { method: "POST", body: { title: form.title, slug: slugify(form.title), venueId } });
      setForm({ title: "", venueId: "" }); reload();
    } catch (err) { setError(err); }
  };
  return html`<h1>Événements</h1>
    ${error && html`<${Failure} error=${error} />`}
    <form class="inline card" onSubmit=${create}>
      <label>Titre<input required value=${form.title} onInput=${(e) => setForm({ ...form, title: e.target.value })} /></label>
      <label>Lieu<select value=${form.venueId} onChange=${(e) => setForm({ ...form, venueId: e.target.value })}>
        ${(venues.data?.venues ?? []).map((v) => html`<option value=${v.id}>${v.name}</option>`)}
      </select></label>
      <button type="submit" disabled=${!venues.data?.venues?.length}>Créer l'événement</button>
    </form>
    ${events.loading ? html`<${Loading} />` : events.error ? html`<${Failure} error=${events.error} />` : html`
      <table><thead><tr><th>Titre</th><th>Statut</th><th>Créé</th></tr></thead>
        <tbody>${events.data.events.map((ev) => html`<tr><td><a href=${`#${prefix}/event/${ev.id}`}>${ev.title}</a></td><td><${Badge} status=${ev.status} /></td><td>${when(ev.createdAt)}</td></tr>`)}</tbody></table>`}`;
}

function EventDetail({ api, base, eventId }) {
  const [ev, reloadEvent] = useLoad(() => api(`${base}/events/${eventId}`), [base, eventId]);
  const [sessions, reloadSessions] = useLoad(() => api(`${base}/events/${eventId}/sessions`), [base, eventId]);
  const [types, reloadTypes] = useLoad(() => api(`${base}/events/${eventId}/ticket-types`), [base, eventId]);
  const [error, setError] = useState(null);
  const [sess, setSess] = useState({ startsAt: "", capacity: 100 });
  const [tt, setTt] = useState({ code: "", name: "", price: "", maxQuantity: 10, minQuantity: 0, kind: "admission", countsAsAdult: true, grantsSessionChange: false });
  const [cancelling, setCancelling] = useState(null);
  const [copied, setCopied] = useState(false);
  const act = (fn) => async (e) => { e?.preventDefault?.(); setError(null); try { await fn(); } catch (err) { setError(err); } };

  if (ev.loading) return html`<${Loading} />`;
  if (ev.error) return html`<${Failure} error=${ev.error} />`;
  const event = ev.data.event;
  // Run 12: where this event is sold.
  const [, , clientId, , brandId] = base.split("/").slice(2);
  const shopUrl = `${location.origin}/acheter/${clientId}/${brandId}/${eventId}`;
  const widgetCode = `<script src="${location.origin}/widget.js" data-client="${clientId}" data-brand="${brandId}" data-event="${eventId}" data-label="Acheter des billets" async></script>`;
  const copyWidget = () => navigator.clipboard?.writeText(widgetCode).then(() => setCopied(true), () => setCopied(false));
  const setEventStatus = (status) => act(async () => { await api(`${base}/events/${eventId}`, { method: "PATCH", body: { status } }); reloadEvent(); });
  const setSessionStatus = (id, status) => act(async () => { await api(`${base}/sessions/${id}`, { method: "PATCH", body: { status } }); reloadSessions(); });
  // Run 10: cancel a session and refund every buyer, batch after batch, showing progress.
  const cancelSession = (s) => act(async () => {
    const reason = prompt(`Annuler la séance du ${when(s.startsAt)} ?\n${s.soldCount} billet(s) vendus : chaque acheteur sera remboursé en entier (commission TAKATAK comprise) et prévenu par courriel.\n\nMotif (facultatif) :`, "");
    if (reason === null) return;
    let r = await api(`${base}/sessions/${s.id}/cancel`, { method: "POST", body: { reason: reason.trim() || null } });
    setCancelling(r.cancellation);
    for (let i = 0; i < 200 && r.cancellation.status === "running" && r.cancellation.orders.pending > 0; i++) {
      r = await api(`${base}/sessions/${s.id}/cancellation/continue`, { method: "POST" });
      setCancelling(r.cancellation);
    }
    reloadSessions();
  });
  const setCapacity = (id, current) => act(async () => {
    const value = prompt("Nouvelle capacité", String(current)); if (value === null) return;
    await api(`${base}/sessions/${id}`, { method: "PATCH", body: { capacity: Number(value) } }); reloadSessions();
  });
  const addSession = act(async () => {
    await api(`${base}/events/${eventId}/sessions`, { method: "POST", body: { startsAt: new Date(sess.startsAt).toISOString(), capacity: Number(sess.capacity) } });
    reloadSessions();
  });
  const addType = act(async () => {
    const addOn = tt.kind === "add_on";
    await api(`${base}/events/${eventId}/ticket-types`, { method: "POST", body: {
      code: tt.code.toUpperCase(), name: tt.name, kind: tt.kind, priceCents: Math.round(Number(tt.price.replace(",", ".")) * 100),
      minQuantity: Number(tt.minQuantity), maxQuantity: Number(tt.maxQuantity), countsAsAdult: !addOn && tt.countsAsAdult,
      addOnScope: addOn ? "per_admission" : null, grantsSessionChange: addOn && tt.grantsSessionChange,
    } });
    setTt({ ...tt, code: "", name: "", price: "" }); reloadTypes();
  });

  return html`
    <h1>${event.title} <${Badge} status=${event.status} /></h1>
    ${error && html`<${Failure} error=${error} />`}
    <div class="row card">
      ${event.status !== "published" && html`<button onClick=${setEventStatus("published")}>Publier</button>`}
      ${event.status === "published" && html`<button class="secondary" onClick=${setEventStatus("draft")}>Retirer de la vente publique</button>`}
      <span class="muted">Portes : ${event.admissionOpensBeforeMinutes} min avant · ${event.admissionClosesAfterMinutes} min après</span>
    </div>

    <h2>Vendre en ligne</h2>
    <div class="card">
      <p>Lien de la billetterie : <a href=${shopUrl} target="_blank" rel="noopener">${shopUrl}</a></p>
      <label>Bouton pour votre site (copiez ce code dans la page)<textarea rows="3" readonly onFocus=${(e) => e.target.select()}>${widgetCode}</textarea></label>
      <div class="row"><button class="secondary" onClick=${copyWidget}>Copier le code</button>${copied && html`<span class="badge ok">Copié</span>`}</div>
    </div>

    <h2>Séances</h2>
    <form class="inline card" onSubmit=${addSession}>
      <label>Début<input type="datetime-local" required value=${sess.startsAt} onInput=${(e) => setSess({ ...sess, startsAt: e.target.value })} /></label>
      <label>Capacité<input type="number" min="0" required value=${sess.capacity} onInput=${(e) => setSess({ ...sess, capacity: e.target.value })} /></label>
      <button type="submit">Ajouter la séance</button>
    </form>
    ${sessions.loading ? html`<${Loading} />` : html`<table><thead><tr><th>Début</th><th>Statut</th><th class="num">Capacité</th><th class="num">Vendus</th><th class="num">Réservés</th><th></th></tr></thead>
      <tbody>${(sessions.data?.sessions ?? []).map((s) => html`<tr>
        <td>${when(s.startsAt)}</td><td><${Badge} status=${s.status} /></td>
        <td class="num"><button class="link" onClick=${setCapacity(s.id, s.capacity)}>${s.capacity}</button></td><td class="num">${s.soldCount}</td><td class="num">${s.reservedCount}</td>
        <td class="row">
          ${s.status !== "on_sale" && html`<button onClick=${setSessionStatus(s.id, "on_sale")}>Mettre en vente</button>`}
          ${s.status === "on_sale" && html`<button class="secondary" onClick=${setSessionStatus(s.id, "paused")}>Pause</button>`}
          <button class="link" onClick=${act(() => download(api, `${base}/reports/attendees.csv?sessionId=${s.id}`, `alkao-participants-${s.id}.csv`))}>Participants (CSV)</button>
          ${s.status !== "cancelled" && html`<button class="danger" onClick=${cancelSession(s)}>Annuler la séance</button>`}
        </td></tr>`)}</tbody></table>`}
    ${cancelling && html`<div class="card" role="status" aria-label="Annulation de séance">
      <strong>${cancelling.status === "completed" ? "Séance annulée : tout le monde est remboursé." : "Annulation en cours…"}</strong>
      <p class="muted">${cancelling.orders.refunded} commande(s) remboursée(s) · ${money(cancelling.refundedCents)} · ${cancelling.orders.voided} gratuite(s) annulée(s)${cancelling.orders.pending ? ` · ${cancelling.orders.pending} en attente` : ""}</p>
      ${cancelling.orders.failed > 0 && html`<div class="alert warn">${cancelling.orders.failed} remboursement(s) en échec : ${cancelling.failures.map((f) => f.reference).join(", ")}. Réessayez plus tard depuis la commande.</div>`}
    </div>`}

    <h2>Types de billets</h2>
    <form class="inline card" onSubmit=${addType}>
      <label>Code<input required pattern="[A-Za-z0-9_]{1,40}" value=${tt.code} onInput=${(e) => setTt({ ...tt, code: e.target.value })} /></label>
      <label>Nom<input required value=${tt.name} onInput=${(e) => setTt({ ...tt, name: e.target.value })} /></label>
      <label>Prix ($)<input required inputmode="decimal" value=${tt.price} onInput=${(e) => setTt({ ...tt, price: e.target.value })} /></label>
      <label>Min<input type="number" min="0" value=${tt.minQuantity} onInput=${(e) => setTt({ ...tt, minQuantity: e.target.value })} /></label>
      <label>Max<input type="number" min="1" value=${tt.maxQuantity} onInput=${(e) => setTt({ ...tt, maxQuantity: e.target.value })} /></label>
      <label>Genre<select value=${tt.kind} onChange=${(e) => setTt({ ...tt, kind: e.target.value })}><option value="admission">Admission</option><option value="add_on">Option par billet</option></select></label>
      ${tt.kind === "admission"
        ? html`<label class="check"><input type="checkbox" checked=${tt.countsAsAdult} onChange=${(e) => setTt({ ...tt, countsAsAdult: e.target.checked })} /> Adulte</label>`
        : html`<label class="check"><input type="checkbox" checked=${tt.grantsSessionChange} onChange=${(e) => setTt({ ...tt, grantsSessionChange: e.target.checked })} /> Permet un changement de séance (Flex)</label>`}
      <button type="submit">Ajouter</button>
    </form>
    ${types.loading ? html`<${Loading} />` : html`<table><thead><tr><th>Code</th><th>Nom</th><th class="num">Prix</th><th class="num">Min–Max</th><th>Genre</th></tr></thead>
      <tbody>${(types.data?.ticketTypes ?? []).map((t) => html`<tr><td>${t.code}</td><td>${t.name}</td><td class="num">${money(t.priceCents)}</td><td class="num">${t.minQuantity}–${t.maxQuantity}</td>
        <td>${t.kind === "add_on" ? (t.grantsSessionChange ? "Option (Flex)" : "Option") : t.countsAsAdult ? "Admission adulte" : "Admission"}</td></tr>`)}</tbody></table>`}`;
}

// ── Orders ──────────────────────────────────────────────────────────────────
function Orders({ api, base, prefix }) {
  // Run 14: find an order by reference, email or name (at the gate, on the phone).
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [state] = useLoad(() => api(`${base}/orders?limit=100${search ? `&q=${encodeURIComponent(search)}` : ""}`), [base, search]);
  const form = html`<form class="inline card" role="search" onSubmit=${(e) => { e.preventDefault(); setSearch(query.trim().length >= 2 ? query.trim() : ""); }}>
      <label>Rechercher (référence, courriel ou nom)<input type="search" value=${query} onInput=${(e) => setQuery(e.target.value)} /></label>
      <button type="submit">Rechercher</button>
      ${search && html`<button type="button" class="secondary" onClick=${() => { setQuery(""); setSearch(""); }}>Tout afficher</button>`}
    </form>`;
  if (state.loading) return html`<h1>Commandes</h1>${form}<${Loading} />`;
  if (state.error) return html`<h1>Commandes</h1>${form}<${Failure} error=${state.error} />`;
  return html`<h1>Commandes</h1>
    ${form}
    ${state.data.orders.length === 0 && html`<p class="muted">Aucune commande trouvée.</p>`}
    <table><thead><tr><th>Référence</th><th>Acheteur</th><th>Statut</th><th class="num">Total</th><th class="num">Remboursé</th><th>Payée le</th></tr></thead>
      <tbody>${state.data.orders.map((o) => html`<tr>
        <td><a href=${`#${prefix}/order/${o.id}`}>${o.reference}</a></td><td>${o.buyerName ?? ""} <span class="muted">${o.buyerEmail}</span></td>
        <td><${Badge} status=${o.status} /></td><td class="num">${money(o.totalCents)}</td><td class="num">${money(o.refundedCents)}</td><td>${when(o.paidAt)}</td></tr>`)}</tbody></table>`;
}

function OrderDetail({ api, base, orderId }) {
  const [order, reloadOrder] = useLoad(() => api(`${base}/orders/${orderId}`), [base, orderId]);
  const [refunds, reloadRefunds] = useLoad(() => api(`${base}/orders/${orderId}/refunds`), [base, orderId]);
  const [amount, setAmount] = useState("");
  const [selected, setSelected] = useState([]);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);
  const [sessions, setSessions] = useState(null);
  const act = (fn) => async (e) => { e?.preventDefault?.(); setError(null); setMessage(null); try { await fn(); } catch (err) { setError(err); } };
  if (order.loading) return html`<${Loading} />`;
  if (order.error) return html`<${Failure} error=${order.error} />`;
  const o = order.data.order;
  const refundable = o.totalCents - o.refundedCents;
  const refund = act(async () => {
    const body = amount ? { amountCents: Math.round(Number(amount.replace(",", ".")) * 100), ticketIds: selected } : {};
    if (!confirm(amount ? `Rembourser ${money(body.amountCents)} ?` : `Rembourser tout (${money(refundable)}) ?`)) return;
    try { await api(`${base}/orders/${orderId}/refunds`, { method: "POST", body }); setMessage("Remboursement effectué."); }
    catch (err) {
      if (err.code === "refund_provider_error" && err.details?.refundId) {
        await api(`${base}/refunds/${err.details.refundId}/retry`, { method: "POST" }); setMessage("Remboursement effectué après une nouvelle tentative.");
      } else throw err;
    }
    setAmount(""); setSelected([]); reloadOrder(); reloadRefunds();
  });
  const loadSessions = act(async () => setSessions((await api(`${base}/events/${o.eventId}/sessions`)).sessions.filter((s) => s.id !== o.sessionId && s.status === "on_sale")));
  const exchange = (sessionId) => act(async () => {
    const r = await api(`${base}/orders/${orderId}/exchange`, { method: "POST", body: { sessionId } });
    setMessage(`Billets déplacés : nouvelle commande ${r.exchange.reference}.`); setSessions(null); reloadOrder();
  });
  const reissue = (ticketId) => act(async () => { await api(`${base}/tickets/${ticketId}/credential/reissue`, { method: "POST" }); setMessage("Nouveau code QR émis ; l'ancien ne fonctionne plus."); });
  const resendEmail = act(async () => { await api(`${base}/orders/${orderId}/tickets-email`, { method: "POST" }); setMessage(`Billets renvoyés à ${o.buyerEmail}.`); reloadOrder(); });
  const toggle = (id) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  // Run 21: cancel the checked tickets without refunding them (after a dispute, a refund made in Stripe…).
  const voidSelected = act(async () => {
    if (!confirm(`Annuler ${selected.length} billet(s) sans remboursement ? Leurs codes QR ne fonctionneront plus et les places seront remises en vente.`)) return;
    await api(`${base}/orders/${orderId}/tickets/void`, { method: "POST", body: { ticketIds: selected } });
    setMessage(`${selected.length} billet(s) annulé(s) sans remboursement.`); setSelected([]); reloadOrder();
  });
  // Run 20: the buyer's personal data on request (Québec Law 25).
  const exportBuyer = act(() => download(api, `${base}/orders/${orderId}/buyer/export`, `alkao-donnees-acheteur-${o.reference}.json`));
  const anonymize = act(async () => {
    if (!confirm(`Anonymiser ${o.buyerEmail} ? Son courriel, son nom et son téléphone seront effacés de toutes ses commandes de cette marque. Les montants, les billets et les entrées restent. C'est irréversible.`)) return;
    await api(`${base}/orders/${orderId}/buyer/anonymize`, { method: "POST" });
    setMessage("Acheteur anonymisé."); reloadOrder();
  });

  return html`<h1>Commande ${o.reference} <${Badge} status=${o.status} /></h1>
    ${message && html`<div class="alert ok">${message}</div>`}
    ${error && html`<${Failure} error=${error} />`}
    ${(o.disputes ?? []).map((d) => html`<${DisputeNotice} d=${d} />`)}
    ${o.outsideRefundCents > 0 && html`<div class="alert warn">Remboursé directement dans Stripe, hors ALKAO : <strong>${money(o.outsideRefundCents)}</strong>.
      ALKAO n'a annulé aucun billet et ses rapports ne comptent pas ce montant.</div>`}
    <div class="card"><div class="row"><strong>${o.buyerName ?? ""}</strong><span class="muted">${o.buyerEmail}</span><span class="muted">${o.buyerPhone ?? ""}</span></div>
      <p class="muted">Payée le ${when(o.paidAt)} · Total ${money(o.totalCents)} · Remboursé ${money(o.refundedCents)} · Commission ${money(o.commissionCents - o.commissionRefundedCents)}</p></div>
    <table><thead><tr><th>Ligne</th><th class="num">Qté</th><th class="num">Prix</th><th class="num">Total</th></tr></thead>
      <tbody>${o.lines.map((l) => html`<tr><td>${l.nameSnapshot}</td><td class="num">${l.quantity}</td><td class="num">${money(l.unitPriceCents)}</td><td class="num">${money(l.lineTotalCents)}</td></tr>`)}
        ${o.taxes.map((t) => html`<tr><td class="muted">${t.code === "GST" ? "TPS" : "TVQ"}</td><td></td><td></td><td class="num">${money(t.amountCents)}</td></tr>`)}</tbody></table>
    <h2>Courriel des billets</h2>
    <div class="card"><div class="row">
      ${(o.emails ?? []).length === 0 ? html`<span class="muted">Aucun courriel envoyé.</span>`
        : o.emails.map((e) => html`<span><${Badge} status=${`email_${e.status}`} /> ${e.sentAt ? when(e.sentAt) : ""}${e.lastError && e.status !== "sent" ? html` <span class="muted">(${e.lastError})</span>` : ""}</span>`)}
      ${["paid", "partially_refunded"].includes(o.status) && html`<button class="secondary" onClick=${resendEmail}>Renvoyer les billets par courriel</button>`}
    </div></div>
    <h2>Billets</h2>
    <table><thead><tr><th></th><th>Billet</th><th>Statut</th><th>Entré</th><th></th></tr></thead>
      <tbody>${o.tickets.map((t) => html`<tr>
        <td>${t.status === "valid" && html`<input type="checkbox" aria-label="Annuler ce billet" checked=${selected.includes(t.id)} onChange=${() => toggle(t.id)} />`}</td>
        <td><code>${t.id.slice(0, 8)}</code></td><td><${Badge} status=${t.status} /></td><td>${t.admittedAt ? when(t.admittedAt) : "—"}</td>
        <td>${t.status === "valid" && html`<button class="link" onClick=${reissue(t.id)}>Réémettre le QR</button>`}</td></tr>`)}</tbody></table>
    ${selected.length > 0 && html`<p><button class="secondary" onClick=${voidSelected}>Annuler les billets cochés sans remboursement</button></p>`}
    ${["paid", "partially_refunded"].includes(o.status) && html`
      <h2>Rembourser</h2>
      <form class="inline card" onSubmit=${refund}>
        <label>Montant ($) — vide = tout (${money(refundable)})<input inputmode="decimal" value=${amount} onInput=${(e) => setAmount(e.target.value)} /></label>
        <span class="muted">${selected.length} billet(s) coché(s) seront annulés</span>
        <button type="submit" class="danger">Rembourser</button>
      </form>
      <h2>Changement de séance (Flex Météo)</h2>
      ${sessions === null ? html`<button class="secondary" onClick=${loadSessions}>Choisir une autre séance</button>` : html`
        <table><tbody>${sessions.map((s) => html`<tr><td>${when(s.startsAt)}</td><td class="num">${s.capacity - s.soldCount - s.reservedCount} places</td><td><button onClick=${exchange(s.id)}>Déplacer ici</button></td></tr>`)}</tbody></table>`}`}
    <h2>Données personnelles (Loi 25)</h2>
    <div class="card">
      ${o.buyerAnonymizedAt ? html`<p class="muted">Acheteur anonymisé le ${when(o.buyerAnonymizedAt)}.</p>` : html`<div class="row">
        <button class="secondary" onClick=${exportBuyer}>Exporter les données de l'acheteur</button>
        <button class="danger" onClick=${anonymize}>Anonymiser l'acheteur</button></div>
        <p class="muted">À la demande de l'acheteur. L'anonymisation est possible une fois ses séances passées, sans remboursement en cours ni litige ouvert.</p>`}
    </div>
    <h2>Remboursements</h2>
    ${refunds.loading ? html`<${Loading} />` : html`<table><thead><tr><th>Date</th><th>Statut</th><th class="num">Montant</th><th class="num">Commission rendue</th><th>Motif</th></tr></thead>
      <tbody>${(refunds.data?.refunds ?? []).map((r) => html`<tr><td>${when(r.createdAt)}</td><td><${Badge} status=${r.status} /></td><td class="num">${money(r.amountCents)}</td><td class="num">${money(r.commissionRefundCents)}</td><td>${r.reason ?? ""}</td></tr>`)}</tbody></table>`}`;
}

// ── Scanner ─────────────────────────────────────────────────────────────────
function Scanner({ api, base }) {
  const [events] = useLoad(() => api(`${base}/events`), [base]);
  const [eventId, setEventId] = useState("");
  const [sessions, setSessions] = useState([]);
  const [sessionId, setSessionId] = useState("");
  const [manifest, setManifest] = useState(null);
  const [payload, setPayload] = useState("");
  const [last, setLast] = useState(null);
  const [error, setError] = useState(null);
  const [camera, setCamera] = useState(false);
  const [offline, setOffline] = useState(null);
  const [attendance, setAttendance] = useState(null);
  const [reference, setReference] = useState("");
  const [found, setFound] = useState(null);
  const deviceId = (() => { let id = localStorage.getItem("alkao.ops.device"); if (!id) { id = `ops-${crypto.randomUUID().slice(0, 8)}`; localStorage.setItem("alkao.ops.device", id); } return id; })();

  useEffect(() => { if (eventId) api(`${base}/events/${eventId}/sessions`).then((r) => setSessions(r.sessions), setError); }, [eventId]);
  useEffect(() => {
    if (!sessionId) return;
    setOffline(loadOffline(sessionId));
    api(`${base}/sessions/${sessionId}/scanner-manifest`).then((r) => setManifest(r.manifest), (err) => { if (!loadOffline(sessionId)) setError(err); });
  }, [sessionId]);

  // ── Offline mode (Run 09): the device checks QR codes itself and syncs later ──
  const persist = (store) => { saveOffline(sessionId, store); setOffline(store ? { ...store } : null); };
  const goOffline = async () => {
    setError(null);
    try { const r = await api(`${base}/sessions/${sessionId}/scanner-manifest`); setManifest(r.manifest); persist(newOfflineStore(r.manifest)); }
    catch (err) { setError(err); }
  };
  const sync = async () => {
    const store = loadOffline(sessionId); if (!store) return;
    const send = async (scans) => (await api(`${base}/scanner/scans/batch`, { method: "POST", body: { sessionId, deviceId, scans } })).scans;
    const done = await syncOffline(store, send);
    if (done) { try { store.manifest = (await api(`${base}/sessions/${sessionId}/scanner-manifest`)).manifest; store.downloadedAt = Date.now(); store.localAdmitted = []; } catch {} }
    persist(store);
  };
  const leaveOffline = async () => {
    await sync();
    const store = loadOffline(sessionId);
    if (store?.queue.length && !confirm(`${store.queue.length} scan(s) pas encore synchronisés. Quitter quand même ?`)) return;
    persist(null);
  };
  useEffect(() => {
    if (!offline) return;
    const t = setInterval(() => { if (navigator.onLine && loadOffline(sessionId)?.queue.length) void sync(); }, 15_000);
    return () => clearInterval(t);
  }, [Boolean(offline), sessionId]);

  // Run 14: live gate counter, refreshed every 10 s and after each scan (online only).
  const refreshAttendance = () => { if (sessionId && !loadOffline(sessionId)) api(`${base}/sessions/${sessionId}/attendance`).then((r) => setAttendance(r.attendance), () => {}); };
  useEffect(() => {
    setAttendance(null);
    if (!sessionId) return;
    refreshAttendance();
    const t = setInterval(refreshAttendance, 10_000);
    return () => clearInterval(t);
  }, [sessionId]);

  const submit = async (value) => {
    const code = (value ?? payload).trim(); if (!code || !sessionId) return;
    setError(null); setPayload("");
    const store = loadOffline(sessionId);
    if (store) { const r = await offlineScan(store, code); persist(store); setLast({ ...r, offline: true }); return; }
    try { setLast((await api(`${base}/scanner/scans`, { method: "POST", body: { sessionId, payload: code, deviceId } })).scan); refreshAttendance(); }
    catch (err) { setError(err); }
  };

  // Run 22: no QR code (phone dead, code unreadable): find the order by its reference.
  const lookup = (ref) => api(`${base}/sessions/${sessionId}/lookup?reference=${encodeURIComponent(ref)}`).then((r) => r.order);
  const findOrder = async (e) => {
    e.preventDefault(); setError(null); setFound(null);
    try { setFound(await lookup(reference.trim())); } catch (err) { setError(err); }
  };
  const admitTicket = (ticketId) => async () => {
    setError(null);
    try {
      setLast((await api(`${base}/scanner/admit`, { method: "POST", body: { sessionId, ticketId, deviceId } })).scan);
      refreshAttendance(); setFound(await lookup(found.reference));
    } catch (err) { setError(err); }
  };
  useEffect(() => { setFound(null); setReference(""); }, [sessionId]);

  useEffect(() => {
    if (!camera || !("BarcodeDetector" in window)) return;
    let stream, stop = false, lastCode = "", video = document.querySelector("video.camera");
    const detector = new window.BarcodeDetector({ formats: ["qr_code"] });
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } }).then(async (s) => {
      stream = s; video.srcObject = s; await video.play();
      while (!stop) {
        const codes = await detector.detect(video).catch(() => []);
        const code = codes[0]?.rawValue;
        if (code && code !== lastCode) { lastCode = code; await submit(code); setTimeout(() => (lastCode = ""), 2500); }
        await new Promise((r) => setTimeout(r, 250));
      }
    }, setError);
    return () => { stop = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, [camera, sessionId]);

  const [tone, label] = last ? SCAN_FR[last.result] ?? ["bad", last.result] : [];
  return html`<h1>Scanner</h1>
    ${error && html`<${Failure} error=${error} />`}
    <div class="inline card row">
      <label>Événement<select value=${eventId} onChange=${(e) => { setEventId(e.target.value); setSessionId(""); setManifest(null); }}>
        <option value="">—</option>${(events.data?.events ?? []).map((ev) => html`<option value=${ev.id}>${ev.title}</option>`)}</select></label>
      <label>Séance<select value=${sessionId} onChange=${(e) => setSessionId(e.target.value)}>
        <option value="">—</option>${sessions.map((s) => html`<option value=${s.id}>${when(s.startsAt)}</option>`)}</select></label>
      ${manifest && html`<span class="muted">Portes : ${when(manifest.session.admission.opensAt)} → ${when(manifest.session.admission.closesAt)} · ${manifest.credentials.length} à entrer · ${manifest.admitted.length} entrés</span>`}
    </div>
    ${attendance && html`<div class="card row" role="status" aria-label="Entrées">
      <strong class="big">${attendance.admitted} / ${attendance.valid}</strong><span class="muted">entrés · ${Math.max(attendance.valid - attendance.admitted, 0)} attendus · capacité ${attendance.capacity}</span></div>`}
    ${sessionId && html`<div class="card row" aria-label="Mode hors ligne">
      ${offline ? html`<span class="badge warn">Hors ligne</span>
          <span class="muted">Liste du ${when(new Date(offline.downloadedAt).toISOString())} · ${offline.manifest.credentials.length} billets</span>
          <span>${offline.queue.length} en attente de synchronisation</span>
          ${offline.conflicts > 0 && html`<span class="badge bad">${offline.conflicts} billet(s) aussi entré(s) à une autre porte</span>`}
          <button class="secondary" onClick=${sync}>Synchroniser maintenant</button>
          <button class="secondary" onClick=${leaveOffline}>Quitter le mode hors ligne</button>`
        : html`<span class="muted">Réseau instable à la porte ?</span><button class="secondary" onClick=${goOffline}>Préparer le mode hors ligne</button>`}
    </div>`}
    ${sessionId && html`
      <form class="card" onSubmit=${(e) => { e.preventDefault(); submit(); }}>
        <label>Code du billet (lecteur ou saisie)<input class="scan" autofocus value=${payload} onInput=${(e) => setPayload(e.target.value)} placeholder="ALK1…" /></label>
        <div class="row">
          <button type="submit">Valider</button>
          ${"BarcodeDetector" in window && html`<button type="button" class="secondary" onClick=${() => setCamera(!camera)}>${camera ? "Arrêter la caméra" : "Utiliser la caméra"}</button>`}
        </div>
        ${camera && html`<video class="camera" muted playsinline></video>`}
      </form>
      ${last && html`<div class="scan-result ${tone}" role="status">${label}
        ${last.ticket && html`<small>${last.ticket.ticketTypeName}</small>`}
        ${last.offline && html`<small>Vérifié sur l'appareil (hors ligne)</small>`}
        ${last.result === "already_admitted" && last.admittedAt && html`<small>Entré le ${when(last.admittedAt)}${last.admittedBy ? ` (${last.admittedBy})` : ""}</small>`}
      </div>`}
      ${offline ? html`<p class="muted">Sans code QR : recherche par référence disponible en ligne seulement.</p>` : html`
      <form class="inline card" role="search" aria-label="Sans code QR" onSubmit=${findOrder}>
        <label>Sans code QR : référence de la commande<input value=${reference} onInput=${(e) => setReference(e.target.value)} placeholder="K7PM-2QXA" autocomplete="off" /></label>
        <button type="submit" class="secondary">Chercher</button>
      </form>
      ${found && html`<div class="card" aria-label="Commande trouvée">
        <p><strong>${found.reference}</strong>${found.buyerName ? ` · ${found.buyerName}` : ""}</p>
        ${found.otherSessions.length > 0 && html`<div class="alert warn">Billets aussi pour : ${found.otherSessions.map((x) => when(x.startsAt)).join(", ")}</div>`}
        ${found.tickets.length === 0 ? html`<p class="muted">Aucun billet de cette commande pour cette séance.</p>` : html`
        <table><thead><tr><th>Billet</th><th>Statut</th><th></th></tr></thead>
          <tbody>${found.tickets.map((k) => html`<tr><td>${k.ticketTypeName}</td><td><${Badge} status=${k.status} /></td>
            <td>${k.admittedAt ? `Entré le ${when(k.admittedAt)}` : k.status === "valid" ? html`<button onClick=${admitTicket(k.id)}>Faire entrer</button>` : ""}</td></tr>`)}</tbody></table>`}
      </div>`}`}`}`;
}

// ── Payments ────────────────────────────────────────────────────────────────
function Payments({ api, base }) {
  const [account, reloadAccount] = useLoad(() => api(`${base}/payments/account`), [base]);
  const [settings, reloadSettings] = useLoad(() => api(`${base}/payments/settings`), [base]);
  const [origins, setOrigins] = useState(null);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const [onboardingUrl, setOnboardingUrl] = useState(null);
  // Stripe's onboarding cannot run inside a frame: embedded, it opens in a new tab.
  const onboard = async () => {
    setError(null);
    try {
      const url = (await api(`${base}/payments/onboarding`, { method: "POST" })).onboarding.url;
      if (!embedded) return window.location.assign(url);
      const tab = window.open(url, "_blank");
      if (tab) tab.opener = null; else setOnboardingUrl(url);
    } catch (err) { setError(err); }
  };
  const save = async (e) => {
    e.preventDefault(); setError(null); setSaved(false);
    try {
      const list = (origins ?? "").split(/[\s,]+/).map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
      await api(`${base}/payments/settings`, { method: "PUT", body: { checkoutReturnOrigins: list } }); setSaved(true); reloadSettings();
    } catch (err) { setError(err); }
  };
  const a = account.data?.account;
  const current = settings.data?.settings?.checkoutReturnOrigins ?? [];
  return html`<h1>Paiements (Stripe)</h1>
    ${error && html`<${Failure} error=${error} />`}
    ${onboardingUrl && html`<div class="alert"><a href=${onboardingUrl} target="_blank" rel="noopener noreferrer">Ouvrir la configuration Stripe dans un nouvel onglet</a></div>`}
    ${account.loading ? html`<${Loading} />` : account.error ? html`<${Failure} error=${account.error} />` : html`<div class="card">
      ${a.connected ? html`<div class="row"><strong>Compte Stripe connecté</strong>
          <span class="badge ${a.chargesEnabled ? "ok" : "warn"}">${a.chargesEnabled ? "Paiements acceptés" : "Paiements pas encore activés"}</span>
          <span class="badge ${a.payoutsEnabled ? "ok" : "warn"}">${a.payoutsEnabled ? "Virements activés" : "Virements pas encore activés"}</span>
          <button class="secondary" onClick=${reloadAccount}>Actualiser</button></div>
          ${!a.chargesEnabled && html`<p><button onClick=${onboard}>Terminer la configuration Stripe</button></p>`}`
        : html`<p>Aucun compte Stripe. Les acheteurs paieront directement votre compte ; la commission TAKATAK est prélevée comme frais de plateforme.</p><button onClick=${onboard}>Connecter Stripe</button>`}
    </div>`}
    <h2>Sites autorisés après le paiement</h2>
    <form class="card" onSubmit=${save}>
      <label>Origines HTTPS (une par ligne), ex. https://festi-ice.ca
        <textarea rows="3" value=${origins ?? current.join("\n")} onInput=${(e) => setOrigins(e.target.value)}></textarea></label>
      <div class="row"><button type="submit">Enregistrer</button>${saved && html`<span class="badge ok">Enregistré</span>`}</div>
    </form>`;
}

// ── Shell and routing ───────────────────────────────────────────────────────
const TABS = [["dashboard", "Tableau de bord"], ["events", "Événements"], ["venues", "Lieux"], ["orders", "Commandes"], ["scanner", "Scanner"], ["payments", "Paiements"]];

function parseRoute(hash) {
  const m = /^#\/c\/([0-9a-f-]{36})\/b\/([0-9a-f-]{36})\/([a-z]+)(?:\/([0-9a-f-]{36}))?$/.exec(hash);
  return m ? { clientId: m[1], brandId: m[2], page: m[3], id: m[4] } : null;
}

function Shell({ api, route, email, onLogout }) {
  const prefix = `/c/${route.clientId}/b/${route.brandId}`;
  const base = `/v1/admin/clients/${route.clientId}/brands/${route.brandId}`;
  const [status] = useLoad(() => api(`${base}/status`), [base]);
  const page = route.page;
  const tab = page === "event" ? "events" : page === "order" ? "orders" : page;
  const disabled = status.data && !status.data.ticketing.active;
  const body = disabled ? html`<div class="alert warn">${REASON_FR[status.data.ticketing.reason] ?? status.data.ticketing.reason}</div>`
    : page === "dashboard" ? html`<${Dashboard} api=${api} base=${base} prefix=${prefix} />`
    : page === "events" ? html`<${Events} api=${api} base=${base} prefix=${prefix} />`
    : page === "event" ? html`<${EventDetail} api=${api} base=${base} eventId=${route.id} />`
    : page === "venues" ? html`<${Venues} api=${api} base=${base} />`
    : page === "orders" ? html`<${Orders} api=${api} base=${base} prefix=${prefix} />`
    : page === "order" ? html`<${OrderDetail} api=${api} base=${base} orderId=${route.id} />`
    : page === "scanner" ? html`<${Scanner} api=${api} base=${base} />`
    : page === "payments" ? html`<${Payments} api=${api} base=${base} />`
    : html`<p>Page inconnue.</p>`;
  return html`
    <header class="top"><span class="logo">ALKAO</span><a class="where" href="#/">Changer d'espace</a>
      ${status.data && html`<span class="badge">${status.data.role}</span>`}<span class="spacer"></span>
      <span class="muted">${email ?? ""}</span>${onLogout && html`<button class="secondary" onClick=${onLogout}>Déconnexion</button>`}</header>
    <nav class="tabs">${TABS.map(([key, label]) => html`<a class=${tab === key ? "active" : ""} href=${`#${prefix}/${key}`}>${label}</a>`)}</nav>
    <main>${status.error ? html`<${Failure} error=${status.error} />` : body}</main>`;
}

function App() {
  const [config, setConfig] = useState(null);
  const inFrame = window.parent !== window;
  const [session, setSession] = useState(inFrame ? null : loadSession());
  const [hash, setHash] = useState(location.hash || "#/");
  const [refused, setRefused] = useState(false);
  useEffect(() => {
    fetch("/ops/config.json").then((r) => r.json()).then((c) => {
      embedded = inFrame && (c.embedOrigins ?? []).length > 0;
      // A token the API just rejected is not taken again: no 401 → renew → 401 loop.
      if (embedded) bridge = embedBridge(c.embedOrigins, (s) => {
        if (s.accessToken === rejectedToken) { setRefused(true); return; }
        setRefused(false); memorySession = s; setSession(s);
      });
      else if (inFrame) setSession(loadSession());
      setConfig(c);
    });
  }, []);
  useEffect(() => { const on = () => setHash(location.hash || "#/"); addEventListener("hashchange", on); return () => removeEventListener("hashchange", on); }, []);
  const update = (s) => { saveSession(s); setSession(s); };
  const logout = () => update(null);
  // Embedded: a rejected token means asking TAKATAK for a new one, never showing a login form.
  const expired = () => { rejectedToken = loadSession()?.accessToken ?? null; update(null); bridge.renew(); };

  if (!config) return html`<p class="boot">Chargement…</p>`;
  if (!session && refused) return html`<div class="alert warn" role="alert">ALKAO n'accepte pas la session TAKATAK. Rechargez la page ; si le problème continue, contactez le support TAKATAK.</div>`;
  if (!session) return embedded ? html`<p class="boot">Connexion via TAKATAK…</p>` : html`<${Login} config=${config} onSession=${update} />`;

  const getToken = async () => {
    const s = loadSession();
    if (embedded) {
      if (s && s.expiresAt - Date.now() >= 60_000) return s.accessToken;
      return (await bridge.renew())?.accessToken ?? s?.accessToken;
    }
    if (s?.refreshToken && config.supabaseUrl && s.expiresAt - Date.now() < 60_000) {
      try { const fresh = await supabaseToken(config, "refresh_token", { refresh_token: s.refreshToken }); update({ ...fresh, email: s.email }); return fresh.accessToken; }
      catch { logout(); }
    }
    return s?.accessToken;
  };
  const api = makeApi(getToken, embedded ? expired : logout);
  const onLogout = embedded ? null : logout;
  const route = parseRoute(hash);
  return route ? html`<${Shell} api=${api} route=${route} email=${session.email} onLogout=${onLogout} />`
    : html`<header class="top"><span class="logo">ALKAO</span><span class="spacer"></span>${onLogout && html`<button class="secondary" onClick=${onLogout}>Déconnexion</button>`}</header><${Workspaces} api=${api} />`;
}

render(html`<${App} />`, document.getElementById("app"));
