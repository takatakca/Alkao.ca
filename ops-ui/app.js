// ALKAO Operations — standalone web app (Run 04, step 1).
// Plain ES modules, no build step. Every call goes to the gated ALKAO admin API with the
// signed-in user's Supabase access token; the app itself holds no data.
import { html, render, useEffect, useState, useCallback, useRef } from "/ops/vendor/htm-preact.js";
import { loadOffline, newOfflineStore, offlineScan, saveOffline, syncOffline } from "/ops/offline.js";
import { parseReservationsReport } from "/ops/reservations-csv.js";

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

// Run 33: the gate hears and feels the answer, with eyes on the line rather than the screen.
// One short high beep when the ticket is let in; two low beeps for anything else.
let audio = null;
function gateSignal(tone) {
  const ok = tone === "ok";
  try { navigator.vibrate?.(ok ? 80 : [120, 80, 120]); } catch {}
  try {
    audio ??= new AudioContext();
    void audio.resume?.();
    for (const at of ok ? [0] : [0, 0.25]) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = "sine"; osc.frequency.value = ok ? 880 : 220; gain.gain.value = 0.25;
      osc.connect(gain).connect(audio.destination);
      const t = audio.currentTime + at;
      osc.start(t); osc.stop(t + (ok ? 0.12 : 0.18));
    }
  } catch {}
}
const SOUND_KEY = "alkao.ops.gate-sound";
const soundWanted = () => { try { return localStorage.getItem(SOUND_KEY) !== "off"; } catch { return true; } };

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
  too_many_sessions: "Plus de 1000 séances d'un coup : raccourcissez la période ou espacez les séances.",
  venue_time_zone_invalid: "Le fuseau horaire du lieu est invalide : corrigez le lieu.",
  import_empty: "Rien n'a été importé pour cette date : importez le rapport d'abord.",
  report_date_in_future: "La date du rapport ne peut pas être dans le futur.",
  customer_not_found: "Client introuvable.",
  campaign_not_found: "Campagne introuvable.", campaign_not_draft: "Cette campagne est déjà envoyée : elle ne change plus.",
  campaign_closed: "Cette campagne est terminée.", campaign_test_limit: "Limite de 20 essais atteinte pour cette campagne.",
  marketing_settings_missing: "Indiquez d'abord l'adresse postale et le moyen de vous joindre (exigés par la loi anti-pourriel).",
  audience_empty: "Aucun client ne peut recevoir cette campagne.",
  audience_changed: "Le nombre de destinataires a changé : vérifiez-le, puis envoyez de nouveau.",
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
    <${Brand} />
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
      <div class="row"><strong>${m.clientName}</strong><span class="badge">${ROLE_FR[m.role] ?? m.role}</span></div>
      <table><tbody>${m.brands.map((b) => html`<tr>
        <td><a href=${`#/c/${m.clientId}/b/${b.brandId}/dashboard`}>${b.name}</a></td>
        <td>${b.ticketing.active ? html`<span class="badge ok">Ticketing actif</span>` : html`<span class="badge warn">${REASON_FR[b.ticketing.reason] ?? b.ticketing.reason}</span>`}</td>
      </tr>`)}</tbody></table>
    </div>`)}
  </main>`;
}

// ── Dashboard ───────────────────────────────────────────────────────────────
// Run 26: the period the dashboard reports on, in the staff member's local time.
const PERIODS = [["all", "Depuis le début"], ["today", "Aujourd'hui"], ["7d", "7 derniers jours"], ["month", "Ce mois-ci"], ["lastMonth", "Le mois dernier"]];
function reportQuery(period, eventId) {
  const now = new Date();
  const day = (y, m, d) => new Date(y, m, d).toISOString();
  const [y, m, d] = [now.getFullYear(), now.getMonth(), now.getDate()];
  const range = {
    today: [day(y, m, d), day(y, m, d + 1)],
    "7d": [day(y, m, d - 6), day(y, m, d + 1)],
    month: [day(y, m, 1), day(y, m + 1, 1)],
    lastMonth: [day(y, m - 1, 1), day(y, m, 1)],
  }[period];
  const q = new URLSearchParams();
  if (range) { q.set("from", range[0]); q.set("to", range[1]); }
  if (eventId) q.set("eventId", eventId);
  const text = q.toString();
  return text ? `?${text}` : "";
}

function Dashboard({ api, base, prefix }) {
  const [period, setPeriod] = useState("all");
  const [eventId, setEventId] = useState("");
  const query = reportQuery(period, eventId);
  const [events] = useLoad(() => api(`${base}/events`), [base]);
  const [state] = useLoad(() => api(`${base}/reports/sales${query}`), [base, query]);
  const [daily] = useLoad(() => api(`${base}/reports/daily${query}`), [base, query]);
  const [todo] = useLoad(() => api(`${base}/attention`), [base]);
  const filters = html`<div class="inline card row" role="group" aria-label="Filtres du rapport">
      <label>Période<select value=${period} onChange=${(e) => setPeriod(e.target.value)}>
        ${PERIODS.map(([key, label]) => html`<option value=${key}>${label}</option>`)}</select></label>
      <label>Événement<select value=${eventId} onChange=${(e) => setEventId(e.target.value)}>
        <option value="">Tous</option>${(events.data?.events ?? []).map((ev) => html`<option value=${ev.id}>${ev.title}</option>`)}</select></label>
    </div>`;
  const head = html`<h1>Tableau de bord</h1>
    ${todo.data?.attention.total > 0 && html`<${Attention} a=${todo.data.attention} prefix=${prefix} />`}
    ${filters}`;
  if (state.error) return html`${head}<${Failure} error=${state.error} />`;
  if (!state.data) return html`${head}<${Loading} />`;
  const { totals, sessions, ticketTypes } = state.data.report;
  const days = daily.data?.report;
  return html`
    ${head}
    <div class="grid">
      ${[["Commandes", totals.orders, false], ["Ventes brutes", totals.grossCents, true], ["Taxes (TPS + TVQ)", totals.taxCents, true],
         ["Remboursé", totals.refundedCents, true], ["Commission TAKATAK", totals.commissionCents - totals.commissionRefundedCents, true],
         ["Net client (avant frais Stripe)", totals.netToClientCents, true],
         // Run 36: shown once a promo code has been used in the period.
         ...(Number(totals.discountCents) > 0 ? [["Rabais (codes promo)", totals.discountCents, true]] : [])]
        .map(([label, v, isMoney]) => html`<div class="kpi"><div class="label">${label}</div><div class="value">${isMoney ? money(v) : v}</div></div>`)}
    </div>
    <h2>Séances</h2>
    <table><thead><tr><th>Début</th><th>Statut</th><th class="num">Capacité</th><th class="num">Vendus</th><th class="num">Réservés</th><th class="num">Disponibles</th><th class="num">Entrés</th></tr></thead>
      <tbody>${sessions.map((s) => html`<tr><td>${when(s.startsAt)}</td><td><${Badge} status=${s.status} /></td><td class="num">${s.capacity}</td><td class="num">${s.sold}</td><td class="num">${s.held}</td><td class="num">${s.available}</td><td class="num">${s.admitted}</td></tr>`)}</tbody></table>
    <h2>Par type de billet</h2>
    <table><thead><tr><th>Code</th><th class="num">Quantité</th><th class="num">Revenu</th></tr></thead>
      <tbody>${ticketTypes.map((t) => html`<tr><td>${t.code}</td><td class="num">${t.quantity}</td><td class="num">${money(t.revenueCents)}</td></tr>`)}</tbody></table>
    ${days && html`<h2>Par jour</h2>
      <p class="muted">Ventes au jour du paiement, remboursements au jour où Stripe les a faits (heure de ${days.timeZone}).</p>
      ${days.days.length === 0 ? html`<p class="muted">Aucune vente ni aucun remboursement sur cette période.</p>` : html`
      <table><thead><tr><th>Jour</th><th class="num">Commandes</th><th class="num">Avant taxes</th><th class="num">TPS</th><th class="num">TVQ</th><th class="num">Brut</th><th class="num">Remboursé</th><th class="num">Commission nette</th><th class="num">Net client</th></tr></thead>
        <tbody>${days.days.map((r) => html`<tr><td>${r.day}</td><td class="num">${r.orders}</td><td class="num">${money(r.subtotalCents)}</td><td class="num">${money(r.gstCents)}</td><td class="num">${money(r.qstCents)}</td><td class="num">${money(r.grossCents)}</td><td class="num">${money(r.refundedCents)}</td><td class="num">${money(r.commissionCents - r.commissionRefundedCents)}</td><td class="num">${money(r.netToClientCents)}</td></tr>`)}
          <tr><th>Total</th><th class="num">${days.totals.orders}</th><th class="num">${money(days.totals.subtotalCents)}</th><th class="num">${money(days.totals.gstCents)}</th><th class="num">${money(days.totals.qstCents)}</th><th class="num">${money(days.totals.grossCents)}</th><th class="num">${money(days.totals.refundedCents)}</th><th class="num">${money(days.totals.commissionCents - days.totals.commissionRefundedCents)}</th><th class="num">${money(days.totals.netToClientCents)}</th></tr></tbody></table>`}`}
    <p class="row">
      <button class="secondary" onClick=${() => download(api, `${base}/reports/orders.csv${query}`, "alkao-commandes.csv")}>Exporter les commandes (CSV)</button>
      <button class="secondary" onClick=${() => download(api, `${base}/reports/daily.csv${query}`, "alkao-ventes-par-jour.csv")}>Exporter par jour (CSV)</button>
    </p>
    <${Reminders} api=${api} base=${base} />`;
}

// Run 23: the reminder email the buyers get the day before their session.
function Reminders({ api, base }) {
  const [state, reload] = useLoad(() => api(`${base}/settings/reminders`), [base]);
  const [error, setError] = useState(null);
  if (!state.data) return null; // loading, or a role that cannot change it
  const on = state.data.reminders.enabled;
  const toggle = async () => {
    setError(null);
    try { await api(`${base}/settings/reminders`, { method: "PUT", body: { enabled: !on } }); reload(); } catch (err) { setError(err); }
  };
  return html`<h2>Courriels aux acheteurs</h2>
    <div class="card row">
      ${error && html`<${Failure} error=${error} />`}
      <span>Rappel la veille de la séance, avec le lien vers les billets : <strong>${on ? "activé" : "désactivé"}</strong></span>
      <button class="secondary" onClick=${toggle}>${on ? "Désactiver" : "Activer"}</button>
    </div>`;
}

// Run 21: everything that waits on staff, with a link to where it is handled.
const EMAIL_KIND_FR = { order_tickets: "billets", exchange_tickets: "billets du changement de séance", session_cancelled: "annulation de séance", refund: "remboursement", reminder: "rappel" };
function Attention({ a, prefix }) {
  const order = (id, reference) => html`<a href=${`#${prefix}/order/${id}`}>${reference}</a>`;
  const group = (title, items, line) => items.length > 0 && html`<h3>${title} (${items.length})</h3><ul>${items.map((x) => html`<li>${line(x)}</li>`)}</ul>`;
  return html`<section class="card attention" aria-labelledby="todo-title">
    <h2 id="todo-title">À traiter (${a.total})</h2>
    ${group("Litiges Stripe ouverts", a.disputes, (d) => html`${order(d.orderId, d.reference)} · ${d.buyerName ?? d.buyerEmail} · ${money(d.amountCents)} · ${DISPUTE_FR[d.status] ?? d.status}${d.evidenceDueBy ? ` · réponse avant le ${when(d.evidenceDueBy)}` : ""}`)}
    ${group("Remboursements bloqués chez Stripe", a.refunds, (r) => html`${order(r.orderId, r.reference)} · ${money(r.amountCents)} · depuis le ${when(r.createdAt)}${r.lastError ? ` · ${r.lastError}` : ""} — « Réessayer » sur la commande`)}
    ${group("Courriels non reçus", a.emails, (e) => html`${order(e.orderId, e.reference)} · ${EMAIL_KIND_FR[e.kind] ?? e.kind} · ${e.buyerEmail}${e.lastError ? ` · ${e.lastError}` : ""}`)}
    ${group("Remboursés dans Stripe, billets encore valides", a.outsideRefunds, (r) => html`${order(r.orderId, r.reference)} · ${money(r.outsideCents)} remboursés hors ALKAO`)}
    ${group("Litiges perdus en partie : billets à annuler", a.lostDisputes ?? [], (d) => html`${order(d.orderId, d.reference)} · ${money(d.amountCents)} repris par la banque — annulez les billets concernés sur la commande`)}
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

// Run 29: a season of sessions at once, in the venue's local time; preview first.
const WEEKDAYS = [[1, "Lun"], [2, "Mar"], [3, "Mer"], [4, "Jeu"], [5, "Ven"], [6, "Sam"], [7, "Dim"]];
function SessionBatch({ api, base, eventId, onDone }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ fromDate: "", toDate: "", weekdays: [1, 2, 3, 4, 5, 6, 7], firstStart: "17:00", lastStart: "", everyMinutes: 15, durationMinutes: "", capacity: 100, onSale: false });
  const [preview, setPreview] = useState(null);
  const [done, setDone] = useState(null);
  const [error, setError] = useState(null);
  const change = (patch) => { setF({ ...f, ...patch }); setPreview(null); setDone(null); };
  const toggleDay = (d) => change({ weekdays: f.weekdays.includes(d) ? f.weekdays.filter((x) => x !== d) : [...f.weekdays, d].sort() });
  const several = f.lastStart !== "" && f.lastStart !== f.firstStart;
  const body = (dryRun) => ({
    fromDate: f.fromDate, toDate: f.toDate || f.fromDate, weekdays: f.weekdays.length === 7 ? undefined : f.weekdays,
    firstStart: f.firstStart, lastStart: several ? f.lastStart : undefined, everyMinutes: several ? Number(f.everyMinutes) : undefined,
    durationMinutes: f.durationMinutes === "" ? null : Number(f.durationMinutes), capacity: Number(f.capacity),
    status: f.onSale ? "on_sale" : "draft", dryRun,
  });
  const run = (dryRun) => async (e) => {
    e?.preventDefault?.(); setError(null); setDone(null);
    try {
      const r = await api(`${base}/events/${eventId}/sessions/batch`, { method: "POST", body: body(dryRun) });
      if (dryRun) setPreview(r); else { setPreview(null); setDone(r); onDone(); }
    } catch (err) { setError(err); }
  };
  if (!open) return html`<p><button class="secondary" onClick=${() => setOpen(true)}>Créer plusieurs séances…</button></p>`;
  const list = preview?.sessions ?? [];
  return html`<form class="card" aria-label="Créer plusieurs séances" onSubmit=${run(true)}>
    <h3>Créer plusieurs séances</h3>
    <div class="row">
      <label>Du<input type="date" required value=${f.fromDate} onInput=${(e) => change({ fromDate: e.target.value })} /></label>
      <label>Au<input type="date" value=${f.toDate} min=${f.fromDate} onInput=${(e) => change({ toDate: e.target.value })} /></label>
      <fieldset class="days"><legend>Jours</legend>${WEEKDAYS.map(([d, label]) => html`<label class="check"><input type="checkbox" checked=${f.weekdays.includes(d)} onChange=${() => toggleDay(d)} /> ${label}</label>`)}</fieldset>
    </div>
    <div class="row">
      <label>Première séance<input type="time" required value=${f.firstStart} onInput=${(e) => change({ firstStart: e.target.value })} /></label>
      <label>Dernière séance (facultatif)<input type="time" value=${f.lastStart} onInput=${(e) => change({ lastStart: e.target.value })} /></label>
      ${several && html`<label>Toutes les (minutes)<input type="number" min="5" max="720" required value=${f.everyMinutes} onInput=${(e) => change({ everyMinutes: e.target.value })} /></label>`}
      <label>Durée (minutes, facultatif)<input type="number" min="1" max="1440" value=${f.durationMinutes} onInput=${(e) => change({ durationMinutes: e.target.value })} /></label>
      <label>Capacité par séance<input type="number" min="0" required value=${f.capacity} onInput=${(e) => change({ capacity: e.target.value })} /></label>
      <label class="check"><input type="checkbox" checked=${f.onSale} onChange=${(e) => change({ onSale: e.target.checked })} /> Mettre en vente tout de suite</label>
    </div>
    <p class="muted">Heures du lieu (changement d'heure compris). Les heures que l'événement a déjà sont sautées.</p>
    ${error && html`<${Failure} error=${error} />`}
    ${preview && html`<div class="alert ${list.length ? "ok" : "warn"}" role="status">
      ${list.length ? `${list.length} séance(s) à créer, du ${when(list[0].startsAt)} au ${when(list[list.length - 1].startsAt)}` : "Aucune nouvelle séance à créer"}${preview.skipped ? ` · ${preview.skipped} déjà existante(s), sautée(s)` : ""}.
    </div>`}
    ${done && html`<div class="alert ok" role="status">${done.created} séance(s) créée(s)${done.skipped ? ` · ${done.skipped} déjà existante(s), sautée(s)` : ""}.</div>`}
    <div class="row">
      <button type="submit" class="secondary">Aperçu</button>
      ${list.length > 0 && html`<button type="button" onClick=${run(false)}>Créer ${list.length} séance(s)</button>`}
      <button type="button" class="link" onClick=${() => setOpen(false)}>Fermer</button>
    </div>
  </form>`;
}

// Run 36: promo codes for one event (a percentage or an amount off, before taxes).
function PromoCodes({ api, base, eventId }) {
  const [state, reload] = useLoad(() => api(`${base}/events/${eventId}/promo-codes`), [base, eventId]);
  const [f, setF] = useState({ code: "", kind: "percent", value: "", maxUses: "", endsAt: "" });
  const [error, setError] = useState(null);
  const act = (fn) => async (e) => { e?.preventDefault?.(); setError(null); try { await fn(); reload(); } catch (err) { setError(err); } };
  const create = act(async () => {
    const value = Number(f.value.replace(",", "."));
    await api(`${base}/events/${eventId}/promo-codes`, { method: "POST", body: {
      code: f.code.trim().toUpperCase(), kind: f.kind,
      ...(f.kind === "percent" ? { percent: Math.round(value) } : { amountCents: Math.round(value * 100) }),
      maxUses: f.maxUses === "" ? null : Number(f.maxUses),
      endsAt: f.endsAt ? new Date(f.endsAt).toISOString() : null,
    } });
    setF({ code: "", kind: f.kind, value: "", maxUses: "", endsAt: "" });
  });
  const toggle = (p) => act(() => api(`${base}/promo-codes/${p.id}`, { method: "PATCH", body: { active: !p.active } }));
  const list = state.data?.promoCodes ?? [];
  return html`<h2>Codes promo</h2>
    ${error && html`<${Failure} error=${error} />`}
    <form class="inline card" aria-label="Nouveau code promo" onSubmit=${create}>
      <label>Code promo<input required pattern="[A-Za-z0-9-]{3,32}" value=${f.code} onInput=${(e) => setF({ ...f, code: e.target.value })} /></label>
      <label>Type de rabais<select value=${f.kind} onChange=${(e) => setF({ ...f, kind: e.target.value })}><option value="percent">Pourcentage</option><option value="amount">Montant</option></select></label>
      <label>${f.kind === "percent" ? "Rabais (%)" : "Rabais ($)"}<input required inputmode="decimal" value=${f.value} onInput=${(e) => setF({ ...f, value: e.target.value })} /></label>
      <label>Utilisations max. (facultatif)<input type="number" min="1" value=${f.maxUses} onInput=${(e) => setF({ ...f, maxUses: e.target.value })} /></label>
      <label>Fin (facultatif)<input type="datetime-local" value=${f.endsAt} onInput=${(e) => setF({ ...f, endsAt: e.target.value })} /></label>
      <button type="submit">Créer le code</button>
    </form>
    <p class="muted">Le rabais s'applique avant les taxes ; la commission TAKATAK est calculée sur le montant réduit.</p>
    ${state.loading ? html`<${Loading} />` : list.length === 0 ? html`<p class="muted">Aucun code.</p>` : html`<table><thead><tr><th>Code</th><th>Rabais</th><th class="num">Utilisé</th><th>Fin</th><th>Statut</th><th></th></tr></thead>
      <tbody>${list.map((p) => html`<tr><td><code>${p.code}</code></td><td>${p.kind === "percent" ? `${p.percent} %` : money(p.amountCents)}</td>
        <td class="num">${p.usedCount}${p.maxUses ? ` / ${p.maxUses}` : ""}</td><td>${p.endsAt ? when(p.endsAt) : "—"}</td>
        <td><span class="badge ${p.active ? "ok" : "bad"}">${p.active ? "Actif" : "Désactivé"}</span></td>
        <td><button class="secondary" onClick=${toggle(p)}>${p.active ? "Désactiver" : "Réactiver"}</button></td></tr>`)}</tbody></table>`}`;
}

function EventDetail({ api, base, eventId }) {
  const [ev, reloadEvent] = useLoad(() => api(`${base}/events/${eventId}`), [base, eventId]);
  const [sessions, reloadSessions] = useLoad(() => api(`${base}/events/${eventId}/sessions`), [base, eventId]);
  const [types, reloadTypes] = useLoad(() => api(`${base}/events/${eventId}/ticket-types`), [base, eventId]);
  const [error, setError] = useState(null);
  const [sess, setSess] = useState({ startsAt: "", capacity: 100 });
  const [tt, setTt] = useState({ code: "", name: "", price: "", maxQuantity: 10, minQuantity: 0, kind: "admission", countsAsAdult: true, grantsSessionChange: false, openDate: false });
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
  // Run 29: the whole event's upcoming sessions on sale, or on pause, at once.
  const setAllSessions = (from, to, question) => act(async () => {
    if (!confirm(question)) return;
    const r = await api(`${base}/events/${eventId}/sessions/status`, { method: "POST", body: { from, to } });
    alert(`${r.updated} séance(s) modifiée(s).`); reloadSessions();
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
      addOnScope: addOn ? "per_admission" : null, grantsSessionChange: addOn && tt.grantsSessionChange, openDate: !addOn && tt.openDate,
    } });
    setTt({ ...tt, code: "", name: "", price: "" }); reloadTypes();
  });
  // Run 28: next week's evening, next year's edition: a draft copy with the same ticket types.
  const duplicate = act(async () => {
    const title = prompt("Titre du nouvel événement", `${event.title} (copie)`);
    if (title === null) return;
    const days = prompt("Copier aussi les séances, décalées de combien de jours ? (7 = une semaine plus tard, 364 = même jour de la semaine l'an prochain ; vide = ne pas copier les séances)", "");
    if (days === null) return;
    const shiftDays = days.trim() === "" ? null : Number(days.trim());
    if (shiftDays !== null && !Number.isInteger(shiftDays)) throw new Error("Nombre de jours invalide.");
    const r = await api(`${base}/events/${eventId}/duplicate`, { method: "POST", body: { title: title.trim() || undefined, shiftDays } });
    location.hash = `#/c/${clientId}/b/${brandId}/event/${r.event.id}`;
  });

  return html`
    <h1>${event.title} <${Badge} status=${event.status} /></h1>
    ${error && html`<${Failure} error=${error} />`}
    <div class="row card">
      ${event.status !== "published" && html`<button onClick=${setEventStatus("published")}>Publier</button>`}
      ${event.status === "published" && html`<button class="secondary" onClick=${setEventStatus("draft")}>Retirer de la vente publique</button>`}
      <button class="secondary" onClick=${duplicate}>Dupliquer l'événement</button>
      <span class="muted">Portes : ${event.admissionOpensBeforeMinutes} min avant · ${event.admissionClosesAfterMinutes} min après</span>
    </div>

    <h2>Vendre en ligne</h2>
    <div class="card">
      <p>Lien de la billetterie : <a href=${shopUrl} target="_blank" rel="noopener">${shopUrl}</a></p>
      <p><a class="button" href=${`${shopUrl}?porte=1`} target="_blank" rel="noopener">Vente à la porte</a> <span class="muted">Séances du jour seulement, paiement par carte (Stripe) sur cet appareil ; les billets s'affichent tout de suite.</span></p>
      <label>Bouton pour votre site (copiez ce code dans la page)<textarea rows="3" readonly onFocus=${(e) => e.target.select()}>${widgetCode}</textarea></label>
      <div class="row"><button class="secondary" onClick=${copyWidget}>Copier le code</button>${copied && html`<span class="badge ok">Copié</span>`}</div>
    </div>

    <h2>Séances</h2>
    <form class="inline card" onSubmit=${addSession}>
      <label>Début<input type="datetime-local" required value=${sess.startsAt} onInput=${(e) => setSess({ ...sess, startsAt: e.target.value })} /></label>
      <label>Capacité<input type="number" min="0" required value=${sess.capacity} onInput=${(e) => setSess({ ...sess, capacity: e.target.value })} /></label>
      <button type="submit">Ajouter la séance</button>
    </form>
    <${SessionBatch} api=${api} base=${base} eventId=${eventId} onDone=${reloadSessions} />
    ${(sessions.data?.sessions ?? []).length > 0 && html`<div class="row">
      <button class="secondary" onClick=${setAllSessions("draft", "on_sale", "Mettre en vente toutes les séances à venir encore en brouillon ?")}>Ouvrir les ventes des brouillons à venir</button>
      <button class="secondary" onClick=${setAllSessions("on_sale", "paused", "Suspendre les ventes de toutes les séances à venir ? Plus personne ne pourra acheter.")}>Suspendre toutes les ventes à venir</button>
      <button class="secondary" onClick=${setAllSessions("paused", "on_sale", "Reprendre les ventes de toutes les séances à venir suspendues ?")}>Reprendre les ventes suspendues</button>
    </div>`}
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

    <${PromoCodes} api=${api} base=${base} eventId=${eventId} />

    <h2>Types de billets</h2>
    <form class="inline card" onSubmit=${addType}>
      <label>Code<input required pattern="[A-Za-z0-9_]{1,40}" value=${tt.code} onInput=${(e) => setTt({ ...tt, code: e.target.value })} /></label>
      <label>Nom<input required value=${tt.name} onInput=${(e) => setTt({ ...tt, name: e.target.value })} /></label>
      <label>Prix ($)<input required inputmode="decimal" value=${tt.price} onInput=${(e) => setTt({ ...tt, price: e.target.value })} /></label>
      <label>Min<input type="number" min="0" value=${tt.minQuantity} onInput=${(e) => setTt({ ...tt, minQuantity: e.target.value })} /></label>
      <label>Max<input type="number" min="1" value=${tt.maxQuantity} onInput=${(e) => setTt({ ...tt, maxQuantity: e.target.value })} /></label>
      <label>Genre<select value=${tt.kind} onChange=${(e) => setTt({ ...tt, kind: e.target.value })}><option value="admission">Admission</option><option value="add_on">Option par billet</option></select></label>
      ${tt.kind === "admission"
        ? html`<label class="check"><input type="checkbox" checked=${tt.countsAsAdult} onChange=${(e) => setTt({ ...tt, countsAsAdult: e.target.checked })} /> Adulte</label>
            <label class="check"><input type="checkbox" checked=${tt.openDate} onChange=${(e) => setTt({ ...tt, openDate: e.target.checked })} /> Billet ouvert (date modifiable)</label>`
        : html`<label class="check"><input type="checkbox" checked=${tt.grantsSessionChange} onChange=${(e) => setTt({ ...tt, grantsSessionChange: e.target.checked })} /> Permet un changement de séance (Flex)</label>`}
      <button type="submit">Ajouter</button>
    </form>
    ${types.loading ? html`<${Loading} />` : html`<table><thead><tr><th>Code</th><th>Nom</th><th class="num">Prix</th><th class="num">Min–Max</th><th>Genre</th></tr></thead>
      <tbody>${(types.data?.ticketTypes ?? []).map((t) => html`<tr><td>${t.code}</td><td>${t.name}</td><td class="num">${money(t.priceCents)}</td><td class="num">${t.minQuantity}–${t.maxQuantity}</td>
        <td>${t.kind === "add_on" ? (t.grantsSessionChange ? "Option (Flex)" : "Option") : t.countsAsAdult ? "Admission adulte" : "Admission"}${t.openDate ? " · billet ouvert" : ""}</td></tr>`)}</tbody></table>`}`;
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

function OrderDetail({ api, base, orderId, role, me }) {
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
  // Run 24: a refund Stripe failed on or never settled, tried again (the same refund, never a second one).
  const retryRefund = (refundId) => act(async () => {
    await api(`${base}/refunds/${refundId}/retry`, { method: "POST" });
    setMessage("Remboursement effectué."); reloadOrder(); reloadRefunds();
  });
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
      <p class="muted">Payée le ${when(o.paidAt)} · Total ${money(o.totalCents)}${o.discountCents > 0 ? ` (rabais ${money(o.discountCents)}, code ${o.promoCode})` : ""} · Remboursé ${money(o.refundedCents)} · Commission ${money(o.commissionCents - o.commissionRefundedCents)}</p></div>
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
      <h2>Changement de séance (Flex Météo ou billet ouvert)</h2>
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
    ${refunds.loading ? html`<${Loading} />` : html`<table><thead><tr><th>Date</th><th>Statut</th><th class="num">Montant</th><th class="num">Commission rendue</th><th>Motif</th><th></th></tr></thead>
      <tbody>${(refunds.data?.refunds ?? []).map((r) => html`<tr><td>${when(r.createdAt)}</td><td><${Badge} status=${r.status} /></td><td class="num">${money(r.amountCents)}</td><td class="num">${money(r.commissionRefundCents)}</td><td>${r.reason ?? ""}${r.lastError ? html` <span class="muted">(${r.lastError})</span>` : ""}</td>
        <td>${r.status === "pending" && html`<button class="secondary" onClick=${retryRefund(r.id)}>Réessayer</button>`}</td></tr>`)}</tbody></table>`}
    ${(role === "owner" || role === "admin") && html`<h2>Historique</h2><${OrderHistory} api=${api} base=${base} orderId=${orderId} me=${me} />`}`;
}

// ── Journal (Run 30) ────────────────────────────────────────────────────────
const ACTION_FR = {
  "venue.created": "Lieu créé", "venue.updated": "Lieu modifié",
  "event.created": "Événement créé", "event.updated": "Événement modifié", "event.duplicated": "Événement dupliqué",
  "session.created": "Séance créée", "session.updated": "Séance modifiée", "session.cancelled": "Séance annulée",
  "session.cancellation_completed": "Annulation de séance terminée",
  "sessions.batch_created": "Séances créées en lot", "sessions.status_batch_changed": "Séances mises en vente ou en pause en lot",
  "ticket_type.created": "Type de billet créé", "ticket_type.updated": "Type de billet modifié",
  "order.paid": "Commande payée", "order.expired": "Commande expirée", "order.paid_unfulfillable": "Payée sans place disponible : remboursée",
  "order.exchanged": "Changement de séance (Flex)", "order.tickets_email_requested": "Billets envoyés par courriel",
  "order.tickets_link_rotated": "Lien des billets remplacé",
  "refund.requested": "Remboursement demandé", "refund.succeeded": "Remboursement effectué",
  "tickets.voided": "Billets annulés sans remboursement",
  "payment.account_mismatch": "Paiement sur un compte Stripe inattendu", "payment.amount_mismatch": "Montant payé inattendu",
  "payment.unexpected_completion": "Paiement terminé après expiration", "payment.dispute_opened": "Litige Stripe ouvert",
  "payment.dispute_updated": "Litige Stripe mis à jour", "payment.dispute_closed": "Litige Stripe clos", "payment.outside_refund": "Remboursement fait dans Stripe",
  "payments.account_created": "Compte Stripe créé", "payments.settings_updated": "Réglages de paiement modifiés",
  "buyer.exported": "Données de l'acheteur exportées", "buyer.anonymized": "Acheteur anonymisé",
  "credentials.key_rotated": "Clé des codes QR remplacée", "credentials.reissued": "Code QR réémis", "scan.manual_admission": "Entrée sans code QR",
  "reports.daily_exported": "Rapport par jour exporté", "reports.attendees_exported": "Liste des participants exportée", "reports.orders_exported": "Commandes exportées",
  "settings.reminders_updated": "Courriels de rappel modifiés",
};
const ROLE_FR = { owner: "propriétaire", admin: "administrateur", manager: "gestionnaire", editor: "éditeur", staff: "personnel", viewer: "lecteur" };
const FAMILIES = [["", "Tout"], ["order", "Commandes"], ["refund", "Remboursements"], ["payment", "Paiements Stripe"], ["tickets", "Billets annulés"],
  ["buyer", "Données personnelles"], ["session", "Séances"], ["event", "Événements"], ["reports", "Exports"], ["control", "Synchronisation TAKATAK"]];
const actionText = (a) => ACTION_FR[a] ?? (a.startsWith("control.") ? `Synchronisation TAKATAK (${a.slice(8)})` : a);
const actorText = (e, me) => e.actorType === "user" ? `${e.actorId === me ? "Vous" : "Personnel"}${e.actorRole ? ` (${ROLE_FR[e.actorRole] ?? e.actorRole})` : ""}`
  : e.actorType === "public" ? "Acheteur" : e.actorType === "control" ? "TAKATAK" : "ALKAO";
function AuditRows({ entries, me, prefix }) {
  const orderOf = (e) => e.entityType === "order" ? e.entityId : e.data?.orderId ?? null;
  return html`<table><thead><tr><th>Quand</th><th>Qui</th><th>Quoi</th><th></th></tr></thead>
    <tbody>${entries.map((e) => html`<tr><td>${when(e.createdAt)}</td><td>${actorText(e, me)}</td><td>${actionText(e.action)}${e.data?.reason ? html` <span class="muted">— ${e.data.reason}</span>` : ""}</td>
      <td>${prefix && orderOf(e) ? html`<a href=${`#${prefix}/order/${orderOf(e)}`}>Commande</a>` : prefix && e.entityType === "event" && e.entityId ? html`<a href=${`#${prefix}/event/${e.entityId}`}>Événement</a>` : ""}</td></tr>`)}</tbody></table>`;
}

function Journal({ api, base, prefix, me }) {
  const [family, setFamily] = useState("");
  const [entries, setEntries] = useState([]);
  const [more, setMore] = useState(false);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const PAGE = 50;
  const latest = useRef(0); // a slower, older answer never mixes into a newer filter
  const load = async (after) => {
    const n = ++latest.current;
    setError(null); setLoading(true);
    try {
      const r = await api(`${base}/audit?limit=${PAGE}${family ? `&action=${family}` : ""}${after ? `&beforeId=${after}` : ""}`);
      if (n !== latest.current) return;
      setEntries((list) => (after ? [...list, ...r.entries] : r.entries)); setMore(r.entries.length === PAGE);
    } catch (err) { if (n === latest.current) setError(err); }
    if (n === latest.current) setLoading(false);
  };
  useEffect(() => { setEntries([]); load(null); }, [base, family]);
  return html`<h1>Journal</h1>
    <p class="muted">Qui a fait quoi, et quand. Les noms restent dans TAKATAK : ALKAO garde le rôle de la personne.</p>
    <div class="row card"><label>Afficher<select value=${family} onChange=${(e) => { setEntries([]); setMore(false); setLoading(true); setFamily(e.target.value); }}>${FAMILIES.map(([v, label]) => html`<option value=${v}>${label}</option>`)}</select></label></div>
    ${error && html`<${Failure} error=${error} />`}
    ${entries.length > 0 ? html`<${AuditRows} entries=${entries} me=${me} prefix=${prefix} />` : !loading && !error && html`<p class="muted">Rien pour l'instant.</p>`}
    ${loading ? html`<${Loading} />` : more && html`<p><button class="secondary" onClick=${() => load(entries[entries.length - 1].id)}>Plus ancien</button></p>`}`;
}

function OrderHistory({ api, base, orderId, me }) {
  const [state] = useLoad(() => api(`${base}/orders/${orderId}/history`), [base, orderId]);
  if (state.loading) return html`<${Loading} />`;
  if (state.error) return html`<${Failure} error=${state.error} />`;
  return state.data.entries.length ? html`<${AuditRows} entries=${state.data.entries} me=${me} />` : html`<p class="muted">Rien d'enregistré.</p>`;
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
  const [sound, setSound] = useState(soundWanted);
  const toggleSound = (on) => { setSound(on); try { localStorage.setItem(SOUND_KEY, on ? "on" : "off"); } catch {} };
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
  useEffect(() => { if (last && sound) gateSignal(tone); }, [last]);
  return html`<h1>Scanner</h1>
    ${error && html`<${Failure} error=${error} />`}
    <div class="inline card row">
      <label>Événement<select value=${eventId} onChange=${(e) => { setEventId(e.target.value); setSessionId(""); setManifest(null); setFound(null); setReference(""); }}>
        <option value="">—</option>${(events.data?.events ?? []).map((ev) => html`<option value=${ev.id}>${ev.title}</option>`)}</select></label>
      <label>Séance<select value=${sessionId} onChange=${(e) => { setSessionId(e.target.value); setFound(null); setReference(""); }}>
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
          <label class="check"><input type="checkbox" checked=${sound} onChange=${(e) => toggleSound(e.target.checked)} /> Son et vibration</label>
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
// Run 40: the TAKATAK dashboard's brand block (orange tile, name, small caps line).
// ── Run 41: the customer file (CRM) ─────────────────────────────────────────
// Who comes, how often, how to reach them. Colours by frequency, from the bookings.
const SEGMENTS = [
  ["loyal", "Fidèle", "5 visites et plus"], ["regular", "Régulier", "3 ou 4 visites"], ["occasional", "Occasionnel", "2 visites"],
  ["one_time", "Une visite", "1 visite"], ["upcoming", "À venir", "Pas encore venu, réservation à venir"],
  ["cancelled", "Annulé", "Seulement des réservations annulées"], ["prospect", "Contact", "Aucune réservation"],
];
const SEGMENT_FR = Object.fromEntries(SEGMENTS.map(([key, label]) => [key, label]));
const CUSTOMER_STATUS = { active: ["ok", "Actif cette saison"], lapsed: ["warn", "À relancer"], inactive: ["", "Inactif"] };
const CATEGORY_FR = { camping: "Camping", cabana: "Cabana", chalet: "Chalet", condo: "Condo", villa: "Villa", tent: "Tente en bois", coolbox: "Coolbox", ticket: "Billet", other: "Autre" };
const PERMISSION_FR = { express: "Oui (consentement exprès)", implied: "Oui (client récent)", expired: "Non : dernier achat il y a plus de 2 ans", opted_out: "Non : désabonné", none: "Pas de courriel" };
const BOOKING_STATE = { done: ["ok", "Séjour fait"], upcoming: ["warn", "À venir"], cancelled: ["bad", "Annulée"] };
const day = (iso) => (iso ? new Date(`${iso}T12:00:00`).toLocaleDateString("fr-CA", { dateStyle: "medium" }) : "—");
const fullName = (c) => [c.firstName, c.lastName].filter(Boolean).join(" ") || (c.anonymizedAt ? "Client anonymisé" : "Sans nom");
const phone = (d) => (d && d.length === 10 ? `${d.slice(0, 3)} ${d.slice(3, 6)}-${d.slice(6)}` : d ?? "");
const quebecToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date());
const Segment = ({ s }) => html`<span class=${`seg seg-${s}`}>${SEGMENT_FR[s] ?? s}</span>`;
const CustomerStatus = ({ s }) => (s ? html`<span class=${`badge ${CUSTOMER_STATUS[s][0]}`}>${CUSTOMER_STATUS[s][1]}</span>` : "—");
const number = (n) => Number(n ?? 0).toLocaleString("fr-CA");
// Reading the whole file is for managers and up; importing and exporting it, owners and admins.
const CUSTOMER_ROLES = ["owner", "admin", "manager"];
const CUSTOMER_FILE_ROLES = ["owner", "admin"];

function CustomerImport({ api, base, onDone }) {
  const [file, setFile] = useState(null);
  const [reportDate, setReportDate] = useState(quebecToday());
  const [complete, setComplete] = useState(true);
  const [progress, setProgress] = useState("");
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const run = async (e) => {
    e.preventDefault();
    setError(null); setResult(null); setBusy(true);
    try {
      let parsed;
      try { parsed = parseReservationsReport(new Uint8Array(await file.arrayBuffer())); } catch {
        throw new Error("Ce fichier n'est pas un rapport de réservations Réservation camping.ca (reservations.csv).");
      }
      const total = { rows: 0, customersCreated: 0, bookingsCreated: 0, bookingsUpdated: 0, cardNumbersRemoved: 0, cancelled: 0 };
      const size = 250;
      const batches = Math.ceil(parsed.rows.length / size);
      for (let i = 0; i < batches; i++) {
        setProgress(`Envoi du lot ${i + 1} sur ${batches}…`);
        const { import: r } = await api(`${base}/customers/import`, { method: "POST", body: { reportDate, rows: parsed.rows.slice(i * size, (i + 1) * size) } });
        for (const k of ["rows", "customersCreated", "bookingsCreated", "bookingsUpdated", "cardNumbersRemoved"]) total[k] += r[k];
      }
      if (complete && parsed.rows.length) {
        setProgress("Repérage des réservations annulées…");
        total.cancelled = (await api(`${base}/customers/import/complete`, { method: "POST", body: { reportDate } })).import.cancelled;
      }
      setResult({ ...total, unreadable: parsed.unreadable });
      onDone();
    } catch (err) { setError(err); } finally { setBusy(false); setProgress(""); }
  };
  return html`<form class="card" aria-label="Importer un rapport de réservations" onSubmit=${run}>
      <h3>Importer un rapport de réservations</h3>
      <p class="muted">Le fichier reservations.csv de Réservation camping.ca. Il est lu sur cet ordinateur : seuls le nom, les coordonnées, le site, les dates, le nombre de personnes et le total sont envoyés. Les commentaires, les plaques, les paiements et tout numéro de carte n'en sortent jamais.</p>
      <div class="fields">
        <label>Rapport (CSV)<input type="file" accept=".csv,text/csv" required onChange=${(e) => setFile(e.target.files[0] ?? null)} /></label>
        <label>Date du rapport<input type="date" required max=${quebecToday()} value=${reportDate} onInput=${(e) => setReportDate(e.target.value)} /></label>
        <label class="check"><input type="checkbox" checked=${complete} onChange=${(e) => setComplete(e.target.checked)} /> Ce rapport liste toutes les réservations à venir (celles qui n'y sont plus sont annulées)</label>
        <button type="submit" disabled=${busy || !file}>Importer</button>
      </div>
      <p class="muted" role="status" aria-live="polite">${progress}</p>
      ${error && html`<${Failure} error=${error} />`}
      ${result && html`<div class="alert ok" role="status"><strong>Import terminé.</strong> ${number(result.rows)} réservations lues · ${number(result.customersCreated)} nouveaux clients ·
        ${number(result.bookingsCreated)} nouvelles réservations · ${number(result.bookingsUpdated)} mises à jour${complete ? html` · ${number(result.cancelled)} annulées` : ""}${result.cardNumbersRemoved ? html` · ${number(result.cardNumbersRemoved)} numéro(s) de carte retiré(s)` : ""}${result.unreadable ? html` · ${number(result.unreadable)} ligne(s) illisible(s)` : ""}.</div>`}
    </form>`;
}

function Customers({ api, base, prefix, role }) {
  const [filters, setFilters] = useState({ segment: "", status: "", q: "", emailable: "" });
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const PAGE = 100;
  const params = (extra) => new URLSearchParams(Object.entries({ ...filters, ...extra }).filter(([, v]) => v !== "")).toString();
  const qs = params({ limit: String(PAGE), offset: String(offset) });
  const [state, reload] = useLoad(() => api(`${base}/customers?${qs}`), [base, qs]);
  const pick = (patch) => { setOffset(0); setFilters({ ...filters, ...patch }); };
  const manageFile = CUSTOMER_FILE_ROLES.includes(role);
  const summary = state.data?.summary;
  const list = state.data?.customers ?? [];
  const total = state.data?.total ?? 0;
  // Each area sits in its own element, so redrawing the list never remounts the import form
  // (Preact matches unkeyed siblings by type).
  return html`<h1>Clients</h1>
    <div>${summary && html`<div class="grid">
      <div class="kpi"><div class="label">Clients</div><div class="value">${number(summary.customers)}</div></div>
      <div class="kpi"><div class="label">Joignables par courriel</div><div class="value">${number(summary.emailable)}</div></div>
      <div class="kpi"><div class="label">Actifs cette saison</div><div class="value">${number(summary.statuses.active)}</div></div>
      <div class="kpi"><div class="label">À relancer</div><div class="value">${number(summary.statuses.lapsed)}</div></div>
    </div>
    <h2>Par fréquence</h2>
    <div class="segments" role="group" aria-label="Filtrer par fréquence">
      ${SEGMENTS.filter(([key]) => key !== "prospect" || summary.segments.prospect > 0).map(([key, label, hint]) => html`<button type="button" class=${`seg-tile s-${key}`}
        aria-pressed=${filters.segment === key ? "true" : "false"} onClick=${() => pick({ segment: filters.segment === key ? "" : key })}>
        <span class="n">${number(summary.segments[key])}</span><span><${Segment} s=${key} /></span><span class="hint">${hint}</span></button>`)}
    </div>`}</div>
    <form class="inline card" role="search" onSubmit=${(e) => { e.preventDefault(); pick({ q: search.trim().length >= 2 ? search.trim() : "" }); }}>
      <label>Rechercher (nom, courriel ou téléphone)<input type="search" value=${search} onInput=${(e) => setSearch(e.target.value)} /></label>
      <label>Fréquence<select value=${filters.segment} onChange=${(e) => pick({ segment: e.target.value })}>
        <option value="">Toutes</option>${SEGMENTS.map(([key, label]) => html`<option value=${key}>${label}</option>`)}</select></label>
      <label>Saison<select value=${filters.status} onChange=${(e) => pick({ status: e.target.value })}>
        <option value="">Toutes</option>${Object.entries(CUSTOMER_STATUS).map(([key, [, label]]) => html`<option value=${key}>${label}</option>`)}</select></label>
      <label class="check"><input type="checkbox" checked=${filters.emailable === "true"} onChange=${(e) => pick({ emailable: e.target.checked ? "true" : "" })} /> Courriel permis seulement</label>
      <button type="submit">Rechercher</button>
      ${manageFile && html`<button type="button" class="secondary" onClick=${() => download(api, `${base}/customers.csv?${params({})}`, `clients-${quebecToday()}.csv`)}>Exporter (CSV)</button>`}
    </form>
    <div>${state.loading && !state.data ? html`<${Loading} />` : state.error ? html`<${Failure} error=${state.error} />` : list.length === 0 ? html`<p class="muted">Aucun client trouvé.</p>` : html`
      <div class="table-scroll" role="region" aria-label="Liste des clients" tabindex="0"><table><thead><tr><th>Client</th><th>Fréquence</th><th class="num">Visites</th><th>Dernière visite</th><th>Prochaine arrivée</th><th>Préféré</th><th class="num">Dépensé</th><th>Saison</th></tr></thead>
        <tbody>${list.map((c) => html`<tr>
          <td><a href=${`#${prefix}/customer/${c.id}`}>${fullName(c)}</a>${c.email ? html`<br /><span class="muted">${c.email}</span>` : ""}</td>
          <td><${Segment} s=${c.segment} /></td><td class="num">${c.visits}</td><td>${day(c.lastVisitOn)}</td><td>${day(c.nextArrivalOn)}</td>
          <td>${CATEGORY_FR[c.favoriteCategory] ?? "—"}</td><td class="num">${money(c.spentCents)}</td><td><${CustomerStatus} s=${c.status} /></td></tr>`)}</tbody></table></div>
      <p class="row"><span class="muted">${number(offset + 1)}–${number(offset + list.length)} sur ${number(total)}</span>
        <button class="secondary" disabled=${offset === 0} onClick=${() => setOffset(Math.max(0, offset - PAGE))}>Précédent</button>
        <button class="secondary" disabled=${offset + PAGE >= total} onClick=${() => setOffset(offset + PAGE)}>Suivant</button></p>`}</div>
    <div>${manageFile && html`<h2>Importer</h2><${CustomerImport} api=${api} base=${base} onDone=${reload} />`}</div>`;
}

function CustomerDetail({ api, base, customerId, role }) {
  const [state, reload] = useLoad(() => api(`${base}/customers/${customerId}`), [base, customerId]);
  const [error, setError] = useState(null);
  const act = (fn) => async () => { setError(null); try { await fn(); reload(); } catch (err) { setError(err); } };
  if (state.loading && !state.data) return html`<h1>Client</h1><${Loading} />`;
  if (state.error) return html`<h1>Client</h1><${Failure} error=${state.error} />`;
  const c = state.data.customer;
  const patch = (body) => act(() => api(`${base}/customers/${c.id}`, { method: "PATCH", body }));
  const anonymize = act(async () => {
    if (!confirm("Anonymiser ce client pour de bon ? Son nom et ses coordonnées seront effacés ; ses séjours restent dans les statistiques.")) return;
    await api(`${base}/customers/${c.id}/anonymize`, { method: "POST" });
  });
  const address = [[c.addressUnit, c.addressLine].filter(Boolean).join("-"), c.city, c.region, c.postalCode, c.country].filter(Boolean).join(", ");
  const emailOn = ["express", "implied"].includes(c.emailPermission);
  return html`<h1>${fullName(c)}</h1>
    <p class="row"><${Segment} s=${c.segment} /> <${CustomerStatus} s=${c.status} />${c.anonymizedAt ? html`<span class="badge">Anonymisé le ${when(c.anonymizedAt)}</span>` : ""}</p>
    ${error && html`<${Failure} error=${error} />`}
    <div class="grid">
      ${[["Visites", c.visits], ["Séjours", c.stays], ["À venir", c.upcoming], ["Dépensé", money(c.spentCents)], ["Première visite", day(c.firstVisitOn)], ["Dernière visite", day(c.lastVisitOn)], ["Prochaine arrivée", day(c.nextArrivalOn)]]
        .map(([label, v]) => html`<div class="kpi"><div class="label">${label}</div><div class="value">${v}</div></div>`)}
    </div>
    ${!c.anonymizedAt && html`<h2>Coordonnées</h2>
      <div class="card"><dl class="facts">
        <dt>Courriel</dt><dd>${c.email ?? "—"}</dd><dt>Cellulaire</dt><dd>${phone(c.mobilePhone) || "—"}</dd>
        <dt>Téléphone maison</dt><dd>${phone(c.homePhone) || "—"}</dd><dt>Téléphone travail</dt><dd>${phone(c.workPhone) || "—"}</dd>
        <dt>Adresse</dt><dd>${address || "—"}</dd><dt>Deuxième personne</dt><dd>${c.companionName ?? "—"}</dd>
      </dl></div>
      <h2>Courriels et textos</h2>
      <div class="card">
        <p>Courriels promotionnels : <strong>${PERMISSION_FR[c.emailPermission]}</strong>${c.emailPermission === "implied" ? ` jusqu'au ${day(c.impliedConsentUntil)}` : ""}.</p>
        <p class="muted">Loi canadienne anti-pourriel : un achat permet d'écrire au client pendant 2 ans ; après, il faut son consentement (par exemple l'inscription à l'infolettre).</p>
        <p class="row">
          ${emailOn ? html`<button class="secondary" onClick=${patch({ emailOptOut: true })}>Désabonner des courriels</button>`
            : c.email && html`<button class="secondary" onClick=${patch({ emailConsent: true })}>Le client a consenti aux courriels</button>`}
          ${c.smsOptOutAt ? html`<button class="secondary" onClick=${patch({ smsOptOut: false })}>Permettre les textos</button>`
            : html`<button class="secondary" onClick=${patch({ smsOptOut: true })}>Arrêter les textos</button>`}
        </p>
      </div>`}
    <h2>Réservations</h2>
    ${c.bookings.length === 0 ? html`<p class="muted">Aucune réservation.</p>` : html`<div class="table-scroll" role="region" aria-label="Réservations du client" tabindex="0"><table><thead><tr><th>Réservation</th><th>Quoi</th><th>Arrivée</th><th>Départ</th><th class="num">Personnes</th><th class="num">Total</th><th>État</th></tr></thead>
      <tbody>${c.bookings.map((b) => html`<tr><td>${b.sourceRef}</td><td>${CATEGORY_FR[b.category] ?? b.category}${b.item ? html` <span class="muted">${b.item}</span>` : ""}</td>
        <td>${day(b.startsOn)}</td><td>${day(b.endsOn)}</td><td class="num">${b.adults + b.children}${b.pets ? ` + ${b.pets} animal` : ""}</td><td class="num">${money(b.totalCents)}</td>
        <td><span class=${`badge ${BOOKING_STATE[b.state][0]}`}>${BOOKING_STATE[b.state][1]}</span></td></tr>`)}</tbody></table></div>`}
    ${CUSTOMER_FILE_ROLES.includes(role) && !c.anonymizedAt && html`<h2>Loi 25</h2>
      <p class="row"><button class="danger" onClick=${anonymize}>Anonymiser ce client</button><span class="muted">À sa demande : efface son nom et ses coordonnées pour de bon.</span></p>`}`;
}

// ── Run 42: e-mail campaigns ────────────────────────────────────────────────
const CAMPAIGN_STATUS = { draft: ["", "Brouillon"], sending: ["warn", "Envoi en cours"], sent: ["ok", "Envoyée"], cancelled: ["bad", "Annulée"] };
const CampaignStatus = ({ s }) => html`<span class=${`badge ${CAMPAIGN_STATUS[s][0]}`}>${CAMPAIGN_STATUS[s][1]}</span>`;
const EMPTY_CAMPAIGN = { name: "", language: "fr", kind: "one_time", delayDays: 3, subject: "", preheader: "", heading: "Bonjour {prénom},", body: "", imageUrl: "", ctaLabel: "", ctaUrl: "", audience: { segments: [], statuses: [], categories: [] } };
// Run 45: an automation shows whether it runs instead of a send status.
const CampaignBadge = ({ c }) => (c.kind === "after_visit" && c.status === "draft"
  ? html`<span class=${`badge ${c.active ? "ok" : ""}`}>${c.active ? "Automatique : en marche" : "Automatique : en pause"} (J+${c.delayDays})</span>`
  : html`<${CampaignStatus} s=${c.status} />`);

function MarketingSettings({ api, base }) {
  const [state, reload] = useLoad(() => api(`${base}/settings/marketing`), [base]);
  const [f, setF] = useState(null);
  const [msg, setMsg] = useState(null);
  const [error, setError] = useState(null);
  const current = f ?? state.data?.marketing ?? { senderAddress: "", contact: "" };
  const save = async (e) => {
    e.preventDefault(); setError(null); setMsg(null);
    try { await api(`${base}/settings/marketing`, { method: "PUT", body: { senderAddress: current.senderAddress ?? "", contact: current.contact ?? "" } }); setF(null); reload(); setMsg("Enregistré."); }
    catch (err) { setError(err); }
  };
  return html`<form class="card" aria-label="Expéditeur des campagnes" onSubmit=${save}>
      <h3>Expéditeur</h3>
      <p class="muted">La loi canadienne anti-pourriel exige, au bas de chaque courriel, l'adresse postale de l'expéditeur et un moyen de le joindre. Chaque courriel a aussi un lien de désabonnement en un clic.</p>
      <div class="fields">
        <label>Adresse postale<input required minlength="5" maxlength="300" value=${current.senderAddress ?? ""} onInput=${(e) => setF({ ...current, senderAddress: e.target.value })} /></label>
        <label>Nous joindre (courriel, téléphone ou site)<input required minlength="3" maxlength="200" value=${current.contact ?? ""} onInput=${(e) => setF({ ...current, contact: e.target.value })} /></label>
        <button type="submit">Enregistrer</button>
      </div>
      ${msg && html`<p class="muted" role="status">${msg}</p>`}${error && html`<${Failure} error=${error} />`}
    </form>`;
}

function NewsletterSettings({ api, base }) {
  const [state, reload] = useLoad(() => api(`${base}/settings/newsletter`), [base]);
  const [f, setF] = useState(null);
  const [msg, setMsg] = useState(null);
  const [error, setError] = useState(null);
  const n = state.data?.newsletter;
  const current = f ?? { rewardCode: n?.rewardCode ?? "", rewardText: n?.rewardText ?? "" };
  const save = async (e) => {
    e.preventDefault(); setError(null); setMsg(null);
    try {
      await api(`${base}/settings/newsletter`, { method: "PUT", body: { rewardCode: current.rewardCode.trim() || null, rewardText: current.rewardText.trim() || null } });
      setF(null); reload(); setMsg("Enregistré.");
    } catch (err) { setError(err); }
  };
  return html`<form class="card" aria-label="Infolettre" onSubmit=${save}>
      <h3>Infolettre</h3>
      <p class="muted">Les inscriptions des sites web (Promo Havana) reçoivent un courriel de confirmation. Seul le clic de la personne l'ajoute aux clients, avec son consentement exprès ; la page de confirmation affiche alors le code de bienvenue.</p>
      ${n && html`<p>${number(n.signups.confirmed)} inscriptions confirmées (${number(n.signups.confirmedLast30Days)} ces 30 derniers jours) · ${number(n.signups.pending)} en attente de confirmation</p>`}
      <div class="fields">
        <label>Code de bienvenue (facultatif)<input pattern="[A-Za-z0-9-]{3,32}" value=${current.rewardCode} onInput=${(e) => setF({ ...current, rewardCode: e.target.value })} /></label>
        <label>Ce qu'il donne<input maxlength="200" value=${current.rewardText} onInput=${(e) => setF({ ...current, rewardText: e.target.value })} /></label>
        <button type="submit">Enregistrer</button>
      </div>
      <p class="muted">Créez aussi ce code dans « Codes promo » de l'événement pour qu'il fonctionne à la caisse.</p>
      ${msg && html`<p class="muted" role="status">${msg}</p>`}${error && html`<${Failure} error=${error} />`}
    </form>`;
}

function Campaigns({ api, base, prefix }) {
  const [state] = useLoad(() => api(`${base}/campaigns`), [base]);
  const list = state.data?.campaigns ?? [];
  return html`<h1>Campagnes</h1>
    <p class="row"><a class="button" href=${`#${prefix}/campaign`}>Nouvelle campagne</a>
      <span class="muted">Courriels aux clients qui peuvent en recevoir (consentement exprès, ou client depuis moins de 2 ans).</span></p>
    <div>${state.loading && !state.data ? html`<${Loading} />` : state.error ? html`<${Failure} error=${state.error} />` : list.length === 0 ? html`<p class="muted">Aucune campagne.</p>` : html`
      <div class="table-scroll" role="region" aria-label="Campagnes" tabindex="0"><table><thead><tr><th>Campagne</th><th>Statut</th><th class="num">Destinataires</th><th class="num">Envoyés</th><th class="num">Désabonnés</th><th>Créée le</th></tr></thead>
        <tbody>${list.map((c) => html`<tr><td><a href=${`#${prefix}/campaign/${c.id}`}>${c.name}</a><br /><span class="muted">${c.subject}</span></td>
          <td><${CampaignBadge} c=${c} /></td><td class="num">${number(c.kind === "after_visit" ? c.sent + c.pending : c.recipients)}</td><td class="num">${number(c.sent)}</td><td class="num">${number(c.unsubscribed)}</td><td>${when(c.createdAt)}</td></tr>`)}</tbody></table></div>`}</div>
    <div><${MarketingSettings} api=${api} base=${base} /></div>
    <div><${NewsletterSettings} api=${api} base=${base} /></div>`;
}

function CampaignEditor({ api, base, prefix, campaignId }) {
  const [state, reload] = useLoad(() => (campaignId ? api(`${base}/campaigns/${campaignId}`) : Promise.resolve({ campaign: null })), [base, campaignId]);
  const [f, setF] = useState(null);
  const [count, setCount] = useState(null);
  const [testTo, setTestTo] = useState("");
  const [msg, setMsg] = useState(null);
  const [error, setError] = useState(null);
  const loaded = state.data?.campaign;
  const c = f ?? (loaded ? { ...EMPTY_CAMPAIGN, ...Object.fromEntries(Object.entries(loaded).map(([k, v]) => [k, v ?? ""])), delayDays: loaded.delayDays ?? 3,
    audience: { segments: loaded.audienceSegments, statuses: loaded.audienceStatuses, categories: loaded.audienceCategories ?? [] } } : EMPTY_CAMPAIGN);
  const draft = !loaded || loaded.status === "draft";
  const automatic = c.kind === "after_visit";
  const audienceKey = JSON.stringify(c.audience);
  useEffect(() => {
    if (!draft || automatic) return;
    let live = true;
    api(`${base}/campaigns/audience`, { method: "POST", body: c.audience }).then((r) => live && setCount(r.recipients), () => live && setCount(null));
    return () => { live = false; };
  }, [base, audienceKey, draft, automatic]);
  if (state.loading && !state.data) return html`<h1>Campagne</h1><${Loading} />`;
  if (state.error) return html`<h1>Campagne</h1><${Failure} error=${state.error} />`;
  const set = (patch) => setF({ ...c, ...patch });
  const toggle = (kind, key) => {
    const list = c.audience[kind];
    set({ audience: { ...c.audience, [kind]: list.includes(key) ? list.filter((k) => k !== key) : [...list, key] } });
  };
  const body = () => ({
    name: c.name, language: c.language, subject: c.subject, preheader: c.preheader || null, heading: c.heading, body: c.body,
    imageUrl: c.imageUrl || null, ctaLabel: c.ctaLabel || null, ctaUrl: c.ctaUrl || null, audience: c.audience,
    kind: c.kind, delayDays: automatic ? Number(c.delayDays) : null,
  });
  const act = (fn) => async (e) => { e?.preventDefault?.(); setError(null); setMsg(null); try { await fn(); } catch (err) { setError(err); } };
  const save = act(async () => {
    if (loaded) { await api(`${base}/campaigns/${loaded.id}`, { method: "PUT", body: body() }); setF(null); reload(); setMsg("Brouillon enregistré."); }
    else { const r = await api(`${base}/campaigns`, { method: "POST", body: body() }); location.hash = `#${prefix}/campaign/${r.campaign.id}`; }
  });
  const test = act(async () => { await api(`${base}/campaigns/${loaded.id}/test`, { method: "POST", body: { email: testTo } }); setMsg(`Essai en route vers ${testTo} (moins d'une minute).`); reload(); });
  const send = act(async () => {
    if (f) throw new Error("Enregistrez d'abord vos changements.");
    if (!confirm(`Envoyer « ${loaded.subject} » à ${number(count)} clients ? Un envoi ne s'annule plus pour les courriels déjà partis.`)) return;
    await api(`${base}/campaigns/${loaded.id}/send`, { method: "POST", body: { expectedRecipients: count } }); reload(); setMsg("Envoi lancé.");
  });
  const cancel = act(async () => { if (!confirm("Arrêter cette campagne ? Les courriels pas encore partis ne le seront jamais.")) return; await api(`${base}/campaigns/${loaded.id}/cancel`, { method: "POST" }); reload(); });
  const turn = (active) => act(async () => {
    if (f) throw new Error("Enregistrez d'abord vos changements.");
    await api(`${base}/campaigns/${loaded.id}/automation`, { method: "POST", body: { active } }); reload();
    setMsg(active ? "Automatisation en marche : elle écrira après chaque visite qui se termine à partir d'aujourd'hui." : "Automatisation en pause.");
  });
  const field = (label, key, attrs = {}) => html`<label>${label}<input value=${c[key] ?? ""} disabled=${!draft} onInput=${(e) => set({ [key]: e.target.value })} ...${attrs} /></label>`;
  return html`<h1>${loaded ? loaded.name : "Nouvelle campagne"}</h1>
    <p class="row"><a href=${`#${prefix}/campaigns`}>← Campagnes</a>${loaded && html`<${CampaignBadge} c=${loaded} />`}</p>
    ${error && html`<${Failure} error=${error} />`}${msg && html`<div class="alert ok" role="status">${msg}</div>`}
    ${loaded && (!draft || loaded.kind === "after_visit") && html`<div class="grid">
      ${[["Destinataires", loaded.recipients], ["Envoyés", loaded.sent], ["En attente", loaded.pending], ["Non envoyés", loaded.skipped + loaded.failed], ["Désabonnés", loaded.unsubscribed]]
        .map(([label, v]) => html`<div class="kpi"><div class="label">${label}</div><div class="value">${number(v)}</div></div>`)}</div>
      ${(loaded.status === "sending" || (loaded.kind === "after_visit" && loaded.status === "draft")) && html`<p class="row"><button class="danger" onClick=${cancel}>${loaded.kind === "after_visit" ? "Arrêter pour de bon" : "Arrêter l'envoi"}</button></p>`}`}
    <form class="card" aria-label="Contenu de la campagne" onSubmit=${save}>
      <div class="fields">
        ${field("Nom (pour l'équipe)", "name", { required: true, maxlength: 120 })}
        <label>Langue<select value=${c.language} disabled=${!draft} onChange=${(e) => set({ language: e.target.value })}><option value="fr">Français</option><option value="en">English</option></select></label>
        <label>Type<select value=${c.kind} disabled=${!draft || loaded?.active} onChange=${(e) => set({ kind: e.target.value })}>
          <option value="one_time">Envoi unique</option><option value="after_visit">Automatique après chaque visite</option></select></label>
        ${automatic && html`<label>Jours après le départ<input type="number" min="0" max="60" required value=${c.delayDays} disabled=${!draft} onInput=${(e) => set({ delayDays: e.target.value })} /></label>`}
      </div>
      <div class="stack">
        ${field("Objet du courriel", "subject", { required: true, maxlength: 150 })}
        ${field("Aperçu dans la boîte de réception (facultatif)", "preheader", { maxlength: 150 })}
        ${field("Titre", "heading", { required: true, maxlength: 150 })}
        <label>Texte<textarea rows="8" required maxlength="10000" disabled=${!draft} value=${c.body} onInput=${(e) => set({ body: e.target.value })}></textarea></label>
        <p class="muted">Une ligne vide sépare les paragraphes. {prénom} est remplacé par le prénom du client${automatic ? ", {visite} par ce qu'il a réservé (le site ou l'événement)" : ""}.</p>
        ${field("Image (lien https, facultatif)", "imageUrl", { type: "url", maxlength: 500 })}
        <div class="fields">${field("Bouton : texte (facultatif)", "ctaLabel", { maxlength: 60 })}${field("Bouton : lien https", "ctaUrl", { type: "url", maxlength: 500 })}</div>
      </div>
      <h3>Destinataires</h3>
      ${automatic && html`<fieldset disabled=${!draft}><legend>Après quelles visites (aucune case : toutes)</legend>
        <div class="row">${Object.entries(CATEGORY_FR).map(([key, label]) => html`<label class="check"><input type="checkbox" checked=${c.audience.categories.includes(key)} onChange=${() => toggle("categories", key)} /> ${label}</label>`)}</div></fieldset>`}
      <fieldset disabled=${!draft}><legend>Fréquence (aucune case : tous)</legend>
        <div class="row">${SEGMENTS.map(([key, label]) => html`<label class="check"><input type="checkbox" checked=${c.audience.segments.includes(key)} onChange=${() => toggle("segments", key)} /> <${Segment} s=${key} /></label>`)}</div></fieldset>
      <fieldset disabled=${!draft}><legend>Saison (aucune case : toutes)</legend>
        <div class="row">${Object.entries(CUSTOMER_STATUS).map(([key, [, label]]) => html`<label class="check"><input type="checkbox" checked=${c.audience.statuses.includes(key)} onChange=${() => toggle("statuses", key)} /> ${label}</label>`)}</div></fieldset>
      ${draft && !automatic && html`<p role="status" aria-live="polite"><strong>${count === null ? "…" : number(count)}</strong> clients peuvent recevoir cette campagne (une fois par adresse).</p>`}
      ${draft && automatic && html`<p class="muted">Chaque client qui peut recevoir des courriels l'aura ${c.delayDays} jour(s) après son départ, une fois par visite et jamais deux fois en 7 jours. Seules les visites qui se terminent après la mise en marche comptent.</p>`}
      ${draft && html`
        <p class="row"><button type="submit">${loaded ? "Enregistrer le brouillon" : "Créer le brouillon"}</button></p>`}
    </form>
    ${loaded && draft && html`<form class="card" aria-label="Essai et envoi" onSubmit=${test}>
      <h3>Essayer, puis envoyer</h3>
      <div class="fields">
        <label>Envoyer un essai à<input type="email" required value=${testTo} onInput=${(e) => setTestTo(e.target.value)} /></label>
        <button type="submit" class="secondary">Envoyer l'essai</button>
        ${loaded.kind === "after_visit"
          ? (loaded.active ? html`<button type="button" class="secondary" onClick=${turn(false)}>Mettre en pause</button>` : html`<button type="button" onClick=${turn(true)}>Mettre en marche</button>`)
          : html`<button type="button" disabled=${!count} onClick=${send}>Envoyer à ${count === null ? "…" : number(count)} clients</button>`}
      </div>
      <p class="muted">${loaded.tests ? `${loaded.tests} essai(s) envoyé(s). ` : ""}${loaded.kind === "after_visit" ? "Les messages sont préparés chaque jour, puis partent avec les autres courriels." : "Les courriels partent par lots, en quelques minutes à quelques heures selon le nombre."}</p>
    </form>`}`;
}

function Brand() {
  return html`<div class="brand"><span class="mark" aria-hidden="true">A</span>
    <span><span class="name">ALKAO</span><span class="sub">Billetterie · TAKATAK</span></span></div>`;
}

const TABS = [["dashboard", "Tableau de bord"], ["events", "Événements"], ["venues", "Lieux"], ["orders", "Commandes"], ["scanner", "Scanner"], ["payments", "Paiements"]];
// Run 30: the journal needs audit.read (owner, admin).
const JOURNAL_ROLES = ["owner", "admin"];

function parseRoute(hash) {
  const m = /^#\/c\/([0-9a-f-]{36})\/b\/([0-9a-f-]{36})\/([a-z]+)(?:\/([0-9a-f-]{36}))?$/.exec(hash);
  return m ? { clientId: m[1], brandId: m[2], page: m[3], id: m[4] } : null;
}

// Run 30: the signed-in person's id, read from the token, so the journal can say "Vous".
// Display only: the API checks the token itself.
function tokenSubject(token) {
  try { return JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).sub ?? null; } catch { return null; }
}

function Shell({ api, route, email, me, testMode, onLogout }) {
  const prefix = `/c/${route.clientId}/b/${route.brandId}`;
  const base = `/v1/admin/clients/${route.clientId}/brands/${route.brandId}`;
  const [status] = useLoad(() => api(`${base}/status`), [base]);
  const page = route.page;
  const tab = page === "event" ? "events" : page === "order" ? "orders" : page === "customer" ? "customers" : page === "campaign" ? "campaigns" : page;
  const disabled = status.data && !status.data.ticketing.active;
  const body = disabled ? html`<div class="alert warn">${REASON_FR[status.data.ticketing.reason] ?? status.data.ticketing.reason}</div>`
    : page === "dashboard" ? html`<${Dashboard} api=${api} base=${base} prefix=${prefix} />`
    : page === "events" ? html`<${Events} api=${api} base=${base} prefix=${prefix} />`
    : page === "event" ? html`<${EventDetail} api=${api} base=${base} eventId=${route.id} />`
    : page === "venues" ? html`<${Venues} api=${api} base=${base} />`
    : page === "orders" ? html`<${Orders} api=${api} base=${base} prefix=${prefix} />`
    : page === "order" ? html`<${OrderDetail} api=${api} base=${base} orderId=${route.id} role=${status.data?.role} me=${me} />`
    : page === "journal" ? html`<${Journal} api=${api} base=${base} prefix=${prefix} me=${me} />`
    : page === "scanner" ? html`<${Scanner} api=${api} base=${base} />`
    : page === "payments" ? html`<${Payments} api=${api} base=${base} />`
    : page === "customers" ? html`<${Customers} api=${api} base=${base} prefix=${prefix} role=${status.data?.role} />`
    : page === "customer" ? html`<${CustomerDetail} api=${api} base=${base} customerId=${route.id} role=${status.data?.role} />`
    : page === "campaigns" ? html`<${Campaigns} api=${api} base=${base} prefix=${prefix} />`
    : page === "campaign" ? html`<${CampaignEditor} key=${route.id ?? "new"} api=${api} base=${base} prefix=${prefix} campaignId=${route.id ?? null} />`
    : html`<p>Page inconnue.</p>`;
  const links = [...TABS, ...(CUSTOMER_ROLES.includes(status.data?.role) ? [["customers", "Clients"]] : []), ...(CUSTOMER_FILE_ROLES.includes(status.data?.role) ? [["campaigns", "Campagnes"]] : []), ...(JOURNAL_ROLES.includes(status.data?.role) ? [["journal", "Journal"]] : [])]
    .map(([key, label]) => html`<a class=${tab === key ? "active" : ""} aria-current=${tab === key ? "page" : null} href=${`#${prefix}/${key}`}>${label}</a>`);
  // Run 40: standalone, a TAKATAK-style dark sidebar; inside the TAKATAK dashboard, which has
  // its own, the links sit in the white top bar instead.
  return html`<div class=${embedded ? "layout embedded" : "layout"}>
    ${!embedded && html`<aside class="side">
      <${Brand} />
      <nav class="side-nav" aria-label="Billetterie"><p class="section">Billetterie</p>${links}</nav>
    </aside>`}
    <div class="page">
      <header class="top">
        ${embedded && html`<nav class="tabs" aria-label="Billetterie">${links}</nav>`}<a class="where" href="#/">Changer d'espace</a>
        ${status.data && html`<span class="badge">${ROLE_FR[status.data.role] ?? status.data.role}</span>`}${testMode}<span class="spacer"></span>
        <span class="who">${email ?? ""}</span>${onLogout && html`<button class="secondary" onClick=${onLogout}>Déconnexion</button>`}</header>
      <main>${status.error ? html`<${Failure} error=${status.error} />` : body}</main>
    </div>
  </div>`;
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
  // Run 32: with Stripe test keys, every screen says nothing is real.
  const testMode = config.paymentsMode === "test" ? html`<span class="badge warn" role="status">Stripe en mode test : aucun paiement réel</span>` : null;
  return route ? html`<${Shell} api=${api} route=${route} email=${session.email} me=${tokenSubject(session.accessToken)} testMode=${testMode} onLogout=${onLogout} />`
    : html`<header class="top"><${Brand} />${testMode}<span class="spacer"></span>${onLogout && html`<button class="secondary" onClick=${onLogout}>Déconnexion</button>`}</header><${Workspaces} api=${api} />`;
}

render(html`<${App} />`, document.getElementById("app"));
