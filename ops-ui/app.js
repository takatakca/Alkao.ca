// ALKAO Operations — standalone web app (Run 04, step 1).
// Plain ES modules, no build step. Every call goes to the gated ALKAO admin API with the
// signed-in user's Supabase access token; the app itself holds no data.
import { html, render, useEffect, useState, useCallback, useRef, useMemo } from "/ops/vendor/htm-preact.js";
import { loadOffline, newOfflineStore, offlineScan, saveOffline, syncOffline, createOfflineCoordinator, withOfflineSessionLock, loadIncidentReport, archiveOfflineIncidents, incidentReportCsv } from "/ops/offline.js";
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

// Run 55: "Repas × 2 · Gonflables × 2", the options bought with an order.
const optionsText = (items) => items.map((o) => `${o.name} × ${o.quantity}`).join(" · ");

const SCAN_FR = {
  admitted: ["ok", "ENTRÉE ACCEPTÉE"], already_admitted: ["bad", "DÉJÀ ENTRÉ"], revoked: ["bad", "BILLET ANNULÉ"],
  wrong_session: ["warn", "MAUVAISE SÉANCE"], too_early: ["warn", "TROP TÔT"], too_late: ["warn", "TROP TARD"],
  unknown_credential: ["bad", "BILLET INCONNU"], invalid_signature: ["bad", "FAUX BILLET"], unknown_key: ["bad", "BILLET D'UN AUTRE ORGANISATEUR"],
  malformed: ["bad", "CODE ILLISIBLE"],
  manifest_expired: ["warn", "LISTE EXPIRÉE — RECONNECTER"],
  storage_unavailable: ["bad", "ADMISSION NON ENREGISTRÉE — NE PAS ADMETTRE"],
  offline_lock_unavailable: ["bad", "VERROU DE SÉCURITÉ ABSENT — SCAN EN LIGNE"],
  signature_unavailable: ["warn", "SIGNATURE NON VÉRIFIABLE — PASSER EN LIGNE"],
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
  flex_not_purchased: "Cette commande n'a pas l'option de changement de séance.", already_exchanged: "Le changement de séance a déjà été utilisé.",
  ticket_already_used: "Un billet est déjà entré : changement impossible.", session_not_available: "Séance non disponible.",
  add_on_sold_out: "Les options de cette commande sont complètes pour cette séance (stock par séance).",
  payments_not_configured: "Paiements non configurés sur ce déploiement.", credentials_not_configured: "Codes QR non configurés sur ce déploiement.",
  appearance_low_contrast: "Ces deux couleurs ne sont pas assez lisibles ensemble (contraste minimum 4,5 : 1).",
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
  campaign_not_held: "Cette campagne n'est pas suspendue.",
  assistant_disabled: "L'assistant de rédaction n'est pas activé sur ce déploiement.",
  assistant_daily_limit: "Limite quotidienne de brouillons atteinte pour cette marque : réessayez demain.",
  assistant_draft_rejected: "L'assistant n'a pas respecté les règles (prix, rabais ou lien inventé). Précisez la consigne ou rédigez vous-même :",
  assistant_refused: "L'assistant a refusé cette demande : reformulez la consigne.",
  assistant_unparsed: "L'assistant a répondu dans un format inattendu : réessayez.",
  assistant_unavailable: "L'assistant ne répond pas pour le moment : réessayez dans quelques minutes.",
  assistant_rate_limited: "L'assistant est très sollicité : réessayez dans une minute.",
};
const errText = (e) => (e instanceof ApiError ? ERRORS_FR[e.code] ?? `Erreur : ${e.code}` : String(e?.message ?? e));

function useLoad(fn, deps) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  // Returns the load, so an action can show its message once the screen shows the new state.
  const reload = useCallback(() => {
    setState((s) => ({ ...s, loading: true }));
    return fn().then((data) => setState({ loading: false, data, error: null }), (error) => setState({ loading: false, data: null, error }));
  }, deps);
  useEffect(() => { reload(); }, [reload]);
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
function periodRange(period, now = new Date()) {
  const day = (y, m, d) => new Date(y, m, d);
  const [y, m, d] = [now.getFullYear(), now.getMonth(), now.getDate()];
  return {
    today: [day(y, m, d), day(y, m, d + 1)],
    "7d": [day(y, m, d - 6), day(y, m, d + 1)],
    month: [day(y, m, 1), day(y, m + 1, 1)],
    lastMonth: [day(y, m - 1, 1), day(y, m, 1)],
  }[period] ?? null;
}
function rangeQuery(range, eventId) {
  const q = new URLSearchParams();
  if (range) { q.set("from", range[0].toISOString()); q.set("to", range[1].toISOString()); }
  if (eventId) q.set("eventId", eventId);
  const text = q.toString();
  return text ? `?${text}` : "";
}

// Run 92: the same stretch of time just before, cut at the same hour, so that a period in
// progress is compared with as much of the previous one. "Depuis le début" has none.
const PREVIOUS_FR = { today: "hier à la même heure", "7d": "les 7 jours précédents", month: "le mois dernier à pareille date", lastMonth: "le mois précédent" };
function previousRange(period, now) {
  const [y, m, d] = [now.getFullYear(), now.getMonth(), now.getDate()];
  const at = (yy, mm, dd) => new Date(yy, mm, dd, now.getHours(), now.getMinutes(), now.getSeconds());
  if (period === "today") return [new Date(y, m, d - 1), at(y, m, d - 1)];
  if (period === "7d") return [new Date(y, m, d - 13), at(y, m, d - 7)];
  if (period === "month") {
    const end = at(y, m - 1, d); // past the end of a shorter month, the whole month
    const cap = new Date(y, m, 1);
    return [new Date(y, m - 1, 1), end < cap ? end : cap];
  }
  if (period === "lastMonth") return [new Date(y, m - 2, 1), new Date(y, m - 1, 1)];
  return null;
}

const num = (n) => Number(n ?? 0).toLocaleString("fr-CA");
const word = (n, one, other) => (Number(n) > 1 ? other : one);
const many = (n, one, other) => `${num(n)} ${word(n, one, other)}`;
// Rounded down: a session one seat short of full never reads 100 %.
const percent = (part, whole) => `${num(Math.floor((part / whole) * 100))} %`;
const minus = (cents) => `− ${money(cents)}`;
const sum = (list, key) => list.reduce((n, x) => n + Number(x[key] ?? 0), 0);
const admissionsSold = (types) => sum(types.filter((t) => t.kind === "admission"), "quantity");
const optionsSold = (types) => sum(types.filter((t) => t.kind === "add_on"), "quantity");

// Calendar days as the daily report writes them (YYYY-MM-DD).
const isoDay = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
const parseDay = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const shortDay = (s) => parseDay(s).toLocaleDateString("fr-CA", { day: "numeric", month: "short" });
const mediumDay = (s) => parseDay(s).toLocaleDateString("fr-CA", { dateStyle: "medium" });
const longDay = (s) => parseDay(s).toLocaleDateString("fr-CA", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

/** Sessions that take place in the period (all of them for "Depuis le début"), cancelled ones aside. */
function sessionFigures(sessions, range, now) {
  const kept = sessions.filter((s) => s.status !== "cancelled" && (!range || (new Date(s.startsAt) >= range[0] && new Date(s.startsAt) < range[1])));
  const started = kept.filter((s) => new Date(s.startsAt) <= now);
  return {
    count: kept.length, capacity: sum(kept, "capacity"), sold: sum(kept, "sold"),
    started: started.length, startedSold: sum(started, "sold"), admitted: sum(started, "admitted"),
  };
}

function Delta({ cur, prev, format, label }) {
  if (prev === null || prev === undefined) return null;
  if (prev > 0) {
    const change = Math.round(((cur - prev) / prev) * 100);
    const text = change > 0 ? `+${num(change)} %` : change < 0 ? `−${num(-change)} %` : "0 %";
    return html`<div class="delta"><strong>${text}</strong> vs ${label}</div>`;
  }
  return html`<div class="delta">vs ${format(prev)} ${label}</div>`;
}

function Meter({ ratio, high }) {
  return html`<div class=${high ? "meter high" : "meter"} aria-hidden="true"><span style=${{ width: `${Math.min(100, Math.max(0, ratio * 100))}%` }}></span></div>`;
}

function Stat({ label, value, flag, meter, context, delta }) {
  return html`<div class="stat">
    <div class="label">${label}${flag}</div>
    <div class="value">${value}</div>
    ${meter}
    ${context && html`<div class="context">${context}</div>`}
    ${delta}
  </div>`;
}

function KpiBand({ totals, types, prev, prevLabel, seats }) {
  const p = prev ? { totals: prev.totals, admissions: admissionsSold(prev.ticketTypes) } : null;
  const delta = (cur, before, format) => p && html`<${Delta} cur=${cur} prev=${before} format=${format} label=${prevLabel} />`;
  const admissions = admissionsSold(types);
  const options = optionsSold(types);
  const fill = seats.capacity > 0 ? seats.sold / seats.capacity : null;
  const entries = seats.startedSold > 0 ? seats.admitted / seats.startedSold : null;
  const fillFlag = fill !== null && fill >= 0.9 && html` <span class="badge warn">${seats.sold >= seats.capacity ? "Complet" : "Presque complet"}</span>`;
  return html`<section class="kpis" aria-label="Indicateurs clés">
    <${Stat} label="Net client" value=${money(totals.netToClientCents)} context="Avant frais Stripe"
      delta=${delta(totals.netToClientCents, p?.totals.netToClientCents, money)} />
    <${Stat} label="Ventes brutes" value=${money(totals.grossCents)} context="Taxes comprises"
      delta=${delta(totals.grossCents, p?.totals.grossCents, money)} />
    <${Stat} label="Commandes" value=${num(totals.orders)}
      context=${totals.orders > 0 ? `Panier moyen ${money(Math.round(totals.grossCents / totals.orders))}` : "Aucune commande payée"}
      delta=${delta(totals.orders, p?.totals.orders, num)} />
    <${Stat} label="Billets vendus" value=${num(admissions)} context=${options > 0 ? `Et ${many(options, "option", "options")}` : "Billets d'entrée"}
      delta=${delta(admissions, p?.admissions, num)} />
    <${Stat} label="Taux de remplissage" value=${fill === null ? "—" : percent(seats.sold, seats.capacity)} flag=${fillFlag}
      meter=${fill !== null && html`<${Meter} ratio=${fill} high=${fill >= 0.9} />`}
      context=${fill === null ? "Aucune séance sur la période" : `${num(seats.sold)} sur ${num(seats.capacity)} places · ${many(seats.count, "séance", "séances")}`} />
    <${Stat} label="Entrées" value=${entries === null ? "—" : percent(seats.admitted, seats.startedSold)}
      meter=${entries !== null && html`<${Meter} ratio=${entries} />`}
      context=${seats.started === 0 ? "Aucune séance commencée" : entries === null ? "Aucun billet pour les séances commencées"
        : `${num(seats.admitted)} sur ${many(seats.startedSold, "billet", "billets")} des séances commencées`} />
  </section>`;
}

// What the buyers paid, down to what the Client keeps (the old money tiles, as one statement).
function Ledger({ totals }) {
  const commission = totals.commissionCents - totals.commissionRefundedCents;
  const refunded = Number(totals.refundedCents);
  const discount = Number(totals.discountCents ?? 0);
  return html`<section class="card ledger" aria-labelledby="ledger-title">
    <div class="card-head"><h2 id="ledger-title">Du brut au net</h2></div>
    <dl>
      <div class="ledger-row"><dt>Payé par les acheteurs</dt><dd>${money(totals.grossCents)}</dd></div>
      <div class="ledger-row sub"><dt>dont taxes (TPS + TVQ)</dt><dd>${money(totals.taxCents)}</dd></div>
      ${discount > 0 && html`<div class="ledger-row sub"><dt>Rabais (codes promo), déjà déduits</dt><dd>${money(discount)}</dd></div>`}
      <div class="ledger-row"><dt>Remboursé</dt><dd class=${refunded > 0 ? "neg" : ""}>${refunded > 0 ? minus(refunded) : money(0)}</dd></div>
      <div class="ledger-row"><dt>Commission TAKATAK</dt><dd>${commission !== 0 ? minus(commission) : money(0)}</dd></div>
      <div class="ledger-row total"><dt>Net client (avant frais Stripe)</dt><dd>${money(totals.netToClientCents)}</dd></div>
    </dl>
    <p class="note">Stripe retient ses frais de traitement sur chaque paiement ; ils ne sont pas déduits ici.</p>
  </section>`;
}

function useWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    setWidth(Math.floor(el.getBoundingClientRect().width));
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** Every calendar day of the period up to today, with the report's row when it has one. */
function chartDays(rows, range, now) {
  if (rows.length < 2) return null;
  let start = range ? isoDay(range[0]) : rows[0].day;
  let end = isoDay(range ? new Date(Math.min(range[1].getTime() - 1, now.getTime())) : now);
  if (rows[0].day < start) start = rows[0].day;
  if (rows[rows.length - 1].day > end) end = rows[rows.length - 1].day;
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const out = [];
  for (let dt = parseDay(start); out.length < 4000; dt = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() + 1)) {
    const day = isoDay(dt);
    if (day > end) break;
    out.push({ day, row: byDay.get(day) ?? null });
  }
  return out;
}

function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}
function yScale(min, max) {
  const step = Math.max(1, niceStep((max - min || 100) / 4));
  const lo = Math.floor(min / step) * step;
  const hi = Math.max(lo + step, Math.ceil(max / step) * step);
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v));
  return { lo, hi, step, ticks };
}
const axisMoney = (cents, step) => (cents / 100).toLocaleString("fr-CA", {
  style: "currency", currency: "CAD", minimumFractionDigits: 0, maximumFractionDigits: step < 100 ? 2 : 0,
  ...(Math.abs(cents) >= 10_000_000 ? { notation: "compact" } : {}),
});
// A column with a 4 px rounded end, square on the zero line.
function barPath(x, w, base, end) {
  const r = Math.min(4, w / 2, Math.abs(base - end));
  const s = end <= base ? 1 : -1;
  return `M${x},${base}V${end + s * r}Q${x},${end} ${x + r},${end}H${x + w - r}Q${x + w},${end} ${x + w},${end + s * r}V${base}Z`;
}

const CHART_H = 248;
function SalesTrend({ report, range, now }) {
  const [box, width] = useWidth();
  const [active, setActive] = useState(null);
  const [spoken, setSpoken] = useState("");
  const series = useMemo(() => (report ? chartDays(report.days, range, now) : null), [report, range, now]);
  const withData = report?.days ?? [];
  let body;
  if (!report) body = html`<div class="chart-empty"><p class="muted">Chargement…</p></div>`;
  else if (!series) {
    body = html`<div class="chart-empty">
      <p class="chart-empty-title">${withData.length === 0 ? "Aucune vente sur cette période." : `Une seule journée de ventes : le ${longDay(withData[0].day)}, ${money(withData[0].netToClientCents)} net client.`}</p>
      <p class="muted">Le graphique jour par jour apparaît dès que deux journées ont des ventes.</p>
    </div>`;
  } else if (width > 0) {
    const n = series.length;
    const values = series.map((d) => Number(d.row?.netToClientCents ?? 0));
    const { lo, hi, step, ticks } = yScale(Math.min(0, ...values), Math.max(0, ...values));
    const labels = ticks.map((t) => axisMoney(t, step));
    const left = Math.ceil(Math.max(...labels.map((l) => l.length)) * 6.6) + 12;
    const top = 22, bottom = CHART_H - 28, plotH = bottom - top;
    const plotW = Math.max(40, width - left - 4);
    const band = plotW / n;
    const barW = Math.min(24, Math.max(1, band - Math.max(2, band * 0.3)));
    const y = (v) => top + ((hi - v) / (hi - lo)) * plotH;
    const zero = y(0);
    const center = (i) => left + (i + 0.5) * band;
    const anchor = (x) => (x - 26 < left ? "start" : x + 26 > width ? "end" : "middle");
    const every = Math.ceil(n / Math.max(2, Math.floor(plotW / 76)));
    const xTicks = [];
    for (let i = n - 1; i >= 0; i -= every) xTicks.push(i);
    let peak = 0;
    values.forEach((v, i) => { if (v > values[peak]) peak = i; });
    const describe = (d) => `${longDay(d.day)} : ${d.row ? `${money(d.row.netToClientCents)} net client, ${many(d.row.orders, "commande", "commandes")}` : "aucune vente"}`;
    const indexAt = (e) => {
      const i = Math.floor((e.clientX - e.currentTarget.getBoundingClientRect().left - left) / band);
      return i >= 0 && i < n ? i : null;
    };
    const onKey = (e) => {
      const moves = { ArrowRight: 1, ArrowLeft: -1 };
      if (e.key === "Escape") { setActive(null); return; }
      if (!(e.key in moves) && e.key !== "Home" && e.key !== "End") return;
      e.preventDefault();
      const from = active ?? n - 1;
      const next = e.key === "Home" ? 0 : e.key === "End" ? n - 1 : Math.min(n - 1, Math.max(0, from + moves[e.key]));
      setActive(next);
      setSpoken(describe(series[next]));
    };
    const a = active !== null ? series[active] : null;
    const tipStyle = active === null ? null : center(active) > width / 2
      ? { right: `${Math.round(width - (left + active * band) + 8)}px` }
      : { left: `${Math.round(left + (active + 1) * band + 8)}px` };
    const days = withData.length;
    const summary = `Ventes nettes par jour, du ${shortDay(series[0].day)} au ${shortDay(series[n - 1].day)} : ${many(days, "jour", "jours")} avec des ventes ou des remboursements`
      + (values[peak] > 0 ? `, meilleur jour le ${longDay(series[peak].day)} avec ${money(values[peak])}` : "")
      + ". Flèches gauche et droite pour lire chaque jour ; le tableau des données suit.";
    body = html`<div class="plot" tabindex="0" role="group" aria-label=${summary}
        onKeyDown=${onKey} onFocus=${() => setActive((i) => i ?? n - 1)} onBlur=${() => setActive(null)}>
      <svg width=${width} height=${CHART_H} viewBox=${`0 0 ${width} ${CHART_H}`} aria-hidden="true"
        onPointerMove=${(e) => setActive(indexAt(e))} onPointerDown=${(e) => setActive(indexAt(e))}
        onPointerLeave=${(e) => { if (e.pointerType !== "touch") setActive(null); }}>
        ${active !== null && html`<rect class="hover-band" x=${left + active * band} y=${top} width=${band} height=${plotH} />`}
        ${ticks.map((t, i) => html`<line class=${t === 0 ? "axis" : "grid"} x1=${left} x2=${width} y1=${Math.round(y(t)) + 0.5} y2=${Math.round(y(t)) + 0.5} />
          <text class="tick" x=${left - 8} y=${y(t)} text-anchor="end" dominant-baseline="middle">${labels[i]}</text>`)}
        ${series.map((d, i) => d.row && html`<path class=${active === i ? "bar is-active" : "bar"} data-day=${d.day}
          d=${barPath(left + i * band + (band - barW) / 2, barW, zero, y(values[i]))} />`)}
        ${values[peak] > 0 && html`<text class="peak" x=${center(peak)} y=${y(values[peak]) - 7} text-anchor=${anchor(center(peak))}>${money(values[peak])}</text>`}
        ${xTicks.map((i) => html`<text class="tick" x=${center(i)} y=${bottom + 18} text-anchor=${anchor(center(i))}>${shortDay(series[i].day)}</text>`)}
      </svg>
      ${a && html`<div class="chart-tip" aria-hidden="true" style=${tipStyle}>
        <div class="tip-day">${longDay(a.day)}</div>
        ${a.row ? html`<div class="tip-value">${money(a.row.netToClientCents)}</div><div class="tip-key">Net client</div>
          <dl class="tip-rows">
            <div><dt>Brut</dt><dd>${money(a.row.grossCents)}</dd></div>
            <div><dt>Commandes</dt><dd>${num(a.row.orders)}</dd></div>
            ${a.row.refundedCents > 0 && html`<div><dt>Remboursé</dt><dd class="neg">${minus(a.row.refundedCents)}</dd></div>`}
          </dl>` : html`<div class="tip-key">Aucune vente ni remboursement</div>`}
      </div>`}
      <p class="sr-only" aria-live="polite">${spoken}</p>
    </div>
    <details class="chart-data">
      <summary>Voir les données du graphique</summary>
      <table><thead><tr><th>Jour</th><th class="num">Net client</th><th class="num">Commandes</th><th class="num">Remboursé</th></tr></thead>
        <tbody>${withData.map((r) => html`<tr><td>${mediumDay(r.day)}</td><td class="num">${money(r.netToClientCents)}</td><td class="num">${num(r.orders)}</td><td class="num">${money(r.refundedCents)}</td></tr>`)}</tbody></table>
    </details>`;
  } else body = html`<div class="chart-empty"></div>`;
  return html`<section class="card trend" aria-labelledby="trend-title">
    <div class="card-head"><div><h2 id="trend-title">Ventes nettes</h2>
      <p class="sub">Net client de chaque jour${report ? ` (heure de ${report.timeZone})` : ""}</p></div></div>
    <div class="trend-body" ref=${box}>${body}</div>
  </section>`;
}

function sessionDay(iso, now) {
  const dt = new Date(iso);
  const days = Math.round((new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86_400_000);
  const day = days === 0 ? "Aujourd'hui" : days === 1 ? "Demain" : dt.toLocaleDateString("fr-CA", { weekday: "short", day: "numeric", month: "short" });
  return { today: days === 0, text: `${day} · ${dt.toLocaleTimeString("fr-CA", { hour: "2-digit", minute: "2-digit" })}` };
}

function UpcomingSessions({ sessions, titles, prefix, now }) {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const ahead = sessions.filter((s) => s.status !== "cancelled" && new Date(s.startsAt) >= startOfToday);
  const list = ahead.slice(0, 5);
  const share = (n, s) => `${s.capacity > 0 ? Math.min(100, (n / s.capacity) * 100) : 0}%`;
  return html`<section class="card upcoming" aria-labelledby="upcoming-title">
    <div class="card-head">
      <div><h2 id="upcoming-title">Prochaines séances</h2>
        <p class="sub">${ahead.length > list.length ? `Les ${list.length} prochaines sur ${num(ahead.length)}` : many(ahead.length, "séance à venir", "séances à venir")}</p></div>
      ${list.length > 0 && html`<ul class="legend" aria-label="Légende">
        <li><span class="key key-sold"></span>Vendus</li><li><span class="key key-held"></span>Réservés</li><li><span class="key key-free"></span>Libres</li></ul>`}
    </div>
    ${list.length === 0 ? html`<p class="muted">Aucune séance à venir. <a href=${`#${prefix}/events`}>Ajouter des séances à un événement</a></p>` : html`
    <ul class="sessions">${list.map((s) => {
      const when = sessionDay(s.startsAt, now);
      const ratio = s.capacity > 0 ? s.sold / s.capacity : 0;
      const flag = s.capacity > 0 && (s.available === 0 ? "Complet" : ratio >= 0.9 ? "Presque complet" : null);
      return html`<li class="session">
        <div class="session-top">
          <div class="session-when"><strong>${when.text}</strong>
            ${titles.has(s.eventId) ? html`<a href=${`#${prefix}/event/${s.eventId}`}>${titles.get(s.eventId)}</a>` : null}</div>
          <div class="session-tags">${flag && html`<span class="badge warn">${flag}</span>`}<${Badge} status=${s.status} /></div>
        </div>
        <div class="fill" aria-hidden="true">
          ${s.sold > 0 && html`<span class="fill-sold" style=${{ width: share(s.sold, s) }}></span>`}
          ${s.held > 0 && html`<span class="fill-held" style=${{ width: share(s.held, s) }}></span>`}
          <span class="fill-free"></span>
        </div>
        <div class="session-nums">
          <span><strong>${num(s.sold)}</strong> ${word(s.sold, "vendu", "vendus")}</span><span>${many(s.held, "réservé", "réservés")}</span><span>${many(s.available, "libre", "libres")}</span>
          <span class="muted">sur ${num(s.capacity)}${s.capacity > 0 ? ` · ${percent(s.sold, s.capacity)}` : ""}</span>
          ${when.today && html`<span class="entries">Entrés <strong>${num(s.admitted)}</strong></span>`}
        </div>
      </li>`;
    })}</ul>`}
  </section>`;
}

function TicketMix({ types }) {
  const total = sum(types, "revenueCents");
  const max = Math.max(1, ...types.map((t) => Number(t.revenueCents)));
  const byRevenue = (a, b) => Number(b.revenueCents) - Number(a.revenueCents) || b.quantity - a.quantity;
  const group = (title, rows) => rows.length > 0 && html`<li class="mix-group"><span class="mix-title">${title}</span>
    <ul>${rows.sort(byRevenue).map((t) => html`<li class="mix-row">
      <div class="mix-line"><span class="mix-name">${t.code}</span><span class="mix-value">${money(t.revenueCents)}</span></div>
      <div class="mix-bar" aria-hidden="true"><span style=${{ width: `${(Number(t.revenueCents) / max) * 100}%` }}></span></div>
      <div class="mix-meta">${many(t.quantity, "vendu", "vendus")}${total > 0 ? ` · ${percent(Number(t.revenueCents), total)} du revenu` : ""}</div>
    </li>`)}</ul></li>`;
  return html`<section class="card mix" aria-labelledby="mix-title">
    <div class="card-head"><div><h2 id="mix-title">Billets et options</h2><p class="sub">Revenu avant taxes et rabais</p></div></div>
    ${types.length === 0 ? html`<p class="muted">Aucun billet vendu sur cette période.</p>`
      : html`<ul class="mix-list">${group("Billets", types.filter((t) => t.kind === "admission"))}${group("Options", types.filter((t) => t.kind !== "admission"))}</ul>`}
  </section>`;
}

function Dashboard({ api, base, prefix }) {
  const [period, setPeriod] = useState("all");
  const [eventId, setEventId] = useState("");
  // The moment the figures are taken, fixed per choice so the queries do not change between renders.
  const asOf = useMemo(() => new Date(), [period, eventId]);
  const range = useMemo(() => periodRange(period, asOf), [period, asOf]);
  const query = rangeQuery(range, eventId);
  const before = useMemo(() => previousRange(period, asOf), [period, asOf]);
  const beforeQuery = before ? rangeQuery(before, eventId) : null;
  const [events] = useLoad(() => api(`${base}/events`), [base]);
  const [state] = useLoad(() => api(`${base}/reports/sales${query}`), [base, query]);
  const [daily] = useLoad(() => api(`${base}/reports/daily${query}`), [base, query]);
  const [previous] = useLoad(() => (beforeQuery ? api(`${base}/reports/sales${beforeQuery}`) : Promise.resolve(null)), [base, beforeQuery]);
  const [campaigns] = useLoad(() => api(`${base}/reports/campaigns${query}`), [base, query]);
  const [todo] = useLoad(() => api(`${base}/attention`), [base]);
  const eventList = events.data?.events ?? [];
  const head = html`<div class="dash-head">
      <h1>Tableau de bord</h1>
      <div class="dash-filters" role="group" aria-label="Filtres du rapport">
        <label>Période<select value=${period} onChange=${(e) => setPeriod(e.target.value)}>
          ${PERIODS.map(([key, label]) => html`<option value=${key}>${label}</option>`)}</select></label>
        <label>Événement<select value=${eventId} onChange=${(e) => setEventId(e.target.value)}>
          <option value="">Tous</option>${eventList.map((ev) => html`<option value=${ev.id}>${ev.title}</option>`)}</select></label>
      </div>
    </div>
    ${todo.data?.attention.total > 0 && html`<${Attention} a=${todo.data.attention} prefix=${prefix} />`}`;
  if (state.error) return html`${head}<${Failure} error=${state.error} />`;
  if (!state.data) return html`${head}<${Loading} />`;
  const { totals, sessions, ticketTypes } = state.data.report;
  const days = daily.data?.report;
  const prev = before && !previous.loading ? previous.data?.report ?? null : null;
  const titles = new Map(eventList.map((ev) => [ev.id, ev.title]));
  // Figures of the previous choice stay on screen, dimmed, while the new ones load (not on first load).
  const refreshing = state.loading || Boolean(daily.loading && daily.data);
  return html`
    ${head}
    <div class=${refreshing ? "dash is-refreshing" : "dash"}>
      <${KpiBand} totals=${totals} types=${ticketTypes} prev=${prev} prevLabel=${PREVIOUS_FR[period]} seats=${sessionFigures(sessions, range, asOf)} />
      <p class="footnote">Montants : commandes payées sur la période, taxes comprises. Remplissage et entrées : séances qui ont lieu sur la période.</p>
      <div class="overview">
        <${SalesTrend} report=${days} range=${range} now=${asOf} />
        <${Ledger} totals=${totals} />
        <${UpcomingSessions} sessions=${sessions} titles=${titles} prefix=${prefix} now=${asOf} />
        <${TicketMix} types=${ticketTypes} />
      </div>
      <section class="details" aria-labelledby="details-title">
        <div class="section-head">
          <h2 id="details-title">Détail des ventes</h2>
          <div class="row">
            <button class="secondary" onClick=${() => download(api, `${base}/reports/orders.csv${query}`, "alkao-commandes.csv")}>Exporter les commandes (CSV)</button>
            <button class="secondary" onClick=${() => download(api, `${base}/reports/daily.csv${query}`, "alkao-ventes-par-jour.csv")}>Exporter par jour (CSV)</button>
          </div>
        </div>
        <h3>Séances</h3>
        <div class="table-scroll" role="region" aria-label="Séances" tabindex="0"><table><thead><tr><th>Début</th><th>Statut</th><th class="num">Capacité</th><th class="num">Vendus</th><th class="num">Réservés</th><th class="num">Disponibles</th><th class="num">Entrés</th></tr></thead>
          <tbody>${sessions.map((s) => html`<tr><td>${when(s.startsAt)}</td><td><${Badge} status=${s.status} /></td><td class="num">${s.capacity}</td><td class="num">${s.sold}</td><td class="num">${s.held}</td><td class="num">${s.available}</td><td class="num">${s.admitted}</td></tr>`)}</tbody></table></div>
        <h3>Par type de billet</h3>
        <table><thead><tr><th>Code</th><th class="num">Quantité</th><th class="num">Revenu</th></tr></thead>
          <tbody>${ticketTypes.map((t) => html`<tr><td>${t.code}</td><td class="num">${t.quantity}</td><td class="num">${money(t.revenueCents)}</td></tr>`)}</tbody></table>
        ${days && html`<h3>Par jour</h3>
          <p class="muted">Ventes au jour du paiement, remboursements au jour où Stripe les a faits (heure de ${days.timeZone}).</p>
          ${days.days.length === 0 ? html`<p class="muted">Aucune vente ni aucun remboursement sur cette période.</p>` : html`
          <div class="table-scroll" role="region" aria-label="Ventes par jour" tabindex="0"><table><thead><tr><th>Jour</th><th class="num">Commandes</th><th class="num">Avant taxes</th><th class="num">TPS</th><th class="num">TVQ</th><th class="num">Brut</th><th class="num">Remboursé</th><th class="num">Commission nette</th><th class="num">Net client</th></tr></thead>
            <tbody>${days.days.map((r) => html`<tr><td>${r.day}</td><td class="num">${r.orders}</td><td class="num">${money(r.subtotalCents)}</td><td class="num">${money(r.gstCents)}</td><td class="num">${money(r.qstCents)}</td><td class="num">${money(r.grossCents)}</td><td class="num">${money(r.refundedCents)}</td><td class="num">${money(r.commissionCents - r.commissionRefundedCents)}</td><td class="num">${money(r.netToClientCents)}</td></tr>`)}
              <tr><th>Total</th><th class="num">${days.totals.orders}</th><th class="num">${money(days.totals.subtotalCents)}</th><th class="num">${money(days.totals.gstCents)}</th><th class="num">${money(days.totals.qstCents)}</th><th class="num">${money(days.totals.grossCents)}</th><th class="num">${money(days.totals.refundedCents)}</th><th class="num">${money(days.totals.commissionCents - days.totals.commissionRefundedCents)}</th><th class="num">${money(days.totals.netToClientCents)}</th></tr></tbody></table></div>`}`}
        ${campaigns.data?.report.rows.some((r) => r.source || r.campaign) && html`<h3>Par provenance (publicités)</h3>
          <p class="muted">Selon les étiquettes UTM des liens. « Direct » : sans étiquette. Net = payé moins remboursé, taxes comprises.</p>
          <div class="table-scroll" role="region" aria-label="Ventes par provenance" tabindex="0"><table><thead><tr><th>Source</th><th>Support</th><th>Campagne</th><th class="num">Commandes</th><th class="num">Entrées</th><th class="num">Options</th><th class="num">Net</th></tr></thead>
            <tbody>${campaigns.data.report.rows.map((r) => html`<tr><td>${r.source || "Direct"}</td><td>${r.medium || "—"}</td><td>${r.campaign || "—"}</td><td class="num">${r.orders}</td><td class="num">${r.admissions}</td><td class="num">${money(r.addOnCents)}</td><td class="num">${money(r.netCents)}</td></tr>`)}</tbody></table></div>`}
      </section>
    </div>
    <${Reminders} api=${api} base=${base} />
    <${TransferSettings} api=${api} base=${base} />`;
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

// Run 80: per-Brand ticket transfer release. Owner/admin only on the API.
// The platform switch must be enabled first; otherwise this remains read-only.
function TransferSettings({ api, base }) {
  const [state, reload] = useLoad(() => api(`${base}/settings/transfers`), [base]);
  const [error, setError] = useState(null);
  if (!state.data) return null;
  const enabled = state.data.transfers.enabled;
  const available = state.data.transfers.available;
  const toggle = async () => {
    setError(null);
    try {
      await api(`${base}/settings/transfers`, { method: "PUT", body: { enabled: !enabled } });
      reload();
    } catch (err) { setError(err); }
  };
  return html`<h2>Transfert de billets</h2>
    <div class="card row">
      ${error && html`<${Failure} error=${error} />`}
      <span>
        Transfert gratuit de billets entre acheteurs :
        <strong>${enabled ? " autorisé" : " non autorisé"}</strong>.
        ${!available && html`<small class="muted"> Indisponible jusqu’à la validation de la plateforme et de l’envoi des courriels.</small>`}
      </span>
      <button class="secondary" disabled=${!available && !enabled}
        onClick=${toggle}>${enabled ? "Désactiver" : "Autoriser"}</button>
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
    ${group("Courriels non reçus", a.emails, (e) => html`${order(e.orderId, e.reference)} · ${EMAIL_KIND_FR[e.kind] ?? e.kind} · ${e.buyerEmail}${e.bouncedAt ? " · adresse refusée : appelez le client pour la corriger" : e.lastError ? ` · ${e.lastError}` : ""}`)}
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
// ── Run 72: presale codes: their holders buy before the public sale opens ──
function PresaleCodes({ api, base, eventId, event }) {
  const [state, reload] = useLoad(() => api(`${base}/events/${eventId}/presale-codes`), [base, eventId]);
  const [f, setF] = useState({ code: "", label: "", opensAt: "" });
  const [error, setError] = useState(null);
  const act = (fn) => async (e) => { e?.preventDefault?.(); setError(null); try { await fn(); reload(); } catch (err) { setError(err); } };
  const create = act(async () => {
    await api(`${base}/events/${eventId}/presale-codes`, { method: "POST", body: {
      code: f.code.trim().toUpperCase(), label: f.label.trim() || null, opensAt: new Date(f.opensAt).toISOString(),
    } });
    setF({ code: "", label: "", opensAt: "" });
  });
  const toggle = (p) => act(() => api(`${base}/presale-codes/${p.id}`, { method: "PATCH", body: { active: !p.active } }));
  const list = state.data?.presaleCodes ?? [];
  return html`<h2>Prévente</h2>
    <p class="muted">${event.salesOpenAt ? `Vente publique : ${when(event.salesOpenAt)}. ` : "Aucune date d'ouverture de la vente publique : un code de prévente ne change rien tant qu'elle n'est pas fixée. "}Les détenteurs d'un code achètent plus tôt, aux mêmes prix et dans les mêmes places.</p>
    ${error && html`<${Failure} error=${error} />`}
    <form class="inline card" aria-label="Nouveau code de prévente" onSubmit=${create}>
      <label>Code de prévente<input required pattern="[A-Za-z0-9-]{3,32}" value=${f.code} onInput=${(e) => setF({ ...f, code: e.target.value })} /></label>
      <label>Pour qui (facultatif)<input maxlength="80" placeholder="Membres, fan club…" value=${f.label} onInput=${(e) => setF({ ...f, label: e.target.value })} /></label>
      <label>Prévente à partir du<input type="datetime-local" required value=${f.opensAt} onInput=${(e) => setF({ ...f, opensAt: e.target.value })} /></label>
      <button type="submit">Créer le code</button>
    </form>
    ${state.loading ? html`<${Loading} />` : list.length === 0 ? html`<p class="muted">Aucun code de prévente.</p>` : html`<table><thead><tr><th>Code</th><th>Pour qui</th><th>À partir du</th><th>Statut</th><th></th></tr></thead>
      <tbody>${list.map((p) => html`<tr><td><code>${p.code}</code></td><td>${p.label ?? "—"}</td><td>${when(p.opensAt)}</td>
        <td><span class="badge ${p.active ? "ok" : "bad"}">${p.active ? "Actif" : "Désactivé"}</span></td>
        <td><button class="secondary" onClick=${toggle(p)}>${p.active ? "Désactiver" : "Réactiver"}</button></td></tr>`)}</tbody></table>`}`;
}

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

// ── Run 69: what a buyer wants to know before choosing (shop, ALKAO home, search engines) ──
const CATEGORY_LABELS = { concerts: "Concerts", festivals: "Festivals", sports: "Sports", famille: "Famille", "plein-air": "Plein air et camping", spectacles: "Théâtre et humour", soirees: "Soirées", experiences: "Expériences" };
const LANGUAGE_LABELS = { fr: "Français", en: "Anglais", "fr-en": "Français et anglais", none: "Sans paroles (musique, cirque…)" };
const AGE_CHOICES = [["", "Non précisé"], ["0", "Pour tous"], ["6", "6 ans et plus"], ["12", "12 ans et plus"], ["14", "14 ans et plus"], ["16", "16 ans et plus"], ["18", "18 ans et plus"]];
function EventFacts({ api, base, eventId, event, assistant }) {
  const initial = () => ({
    description: event.description ?? "",
    category: event.category ?? "", minAge: event.minAge == null ? "" : String(event.minAge),
    doors: event.doorsOpenMinutes == null ? "" : String(event.doorsOpenMinutes), language: event.language ?? "", accessibility: event.accessibility ?? "",
  });
  const [f, setF] = useState(initial);
  const [msg, setMsg] = useState(null);
  const [error, setError] = useState(null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (patch) => { setMsg(null); setF({ ...f, ...patch }); };
  // Run 92: a description drafted from the event's own facts and the notes typed here.
  const draft = async () => {
    setError(null); setMsg(null); setBusy(true);
    try {
      const r = await api(`${base}/events/${eventId}/assistant/description`, { method: "POST", body: { notes } });
      setF({ ...f, description: r.draft.description });
      setMsg("Brouillon de l’assistant inséré : relisez-le, puis enregistrez la fiche.");
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  const save = async (e) => {
    e.preventDefault(); setError(null); setMsg(null);
    const doors = String(f.doors).trim();
    try {
      if (doors !== "" && !(Number.isInteger(Number(doors)) && Number(doors) >= 0 && Number(doors) <= 600)) throw new Error("Ouverture des portes : un nombre de minutes entre 0 et 600.");
      await api(`${base}/events/${eventId}`, { method: "PATCH", body: {
        description: String(f.description).trim() || null,
        category: f.category || null, minAge: f.minAge === "" ? null : Number(f.minAge),
        doorsOpenMinutes: doors === "" ? null : Number(doors), language: f.language || null,
        accessibility: String(f.accessibility).trim() || null,
      } });
      // No reload of the page: it would show "Chargement…" and lose this message; the form already holds what was saved.
      setMsg("Enregistré. La billetterie et l’accueil ALKAO montrent ces informations.");
    } catch (err) { setError(err); }
  };
  return html`<form class="card facts-form" onSubmit=${save}>
    <p class="muted">Facultatif : ce qui n’est pas rempli n’est pas affiché. Montré dans la billetterie, sur l’accueil ALKAO et aux moteurs de recherche.</p>
    <label>Description<textarea rows="6" maxlength="5000" placeholder="Ce qu’on y vit, pour qui, ce qui est inclus." value=${f.description}
      onInput=${(e) => set({ description: e.target.value })}></textarea></label>
    ${assistant && html`<div class="assistant-row">
      <label>Notes pour l’assistant (facultatif)<input maxlength="1000" placeholder="Tour de train, maquillage pour enfants, chocolat chaud…" value=${notes} onInput=${(e) => setNotes(e.target.value)} /></label>
      <button type="button" class="secondary" disabled=${busy} onClick=${draft}>${busy ? "Rédaction…" : "Rédiger avec l’assistant"}</button>
    </div>`}
    <div class="inline">
      <label>Catégorie<select value=${f.category} onChange=${(e) => set({ category: e.target.value })}>
        <option value="">Non précisée</option>${Object.entries(CATEGORY_LABELS).map(([k, l]) => html`<option value=${k}>${l}</option>`)}</select></label>
      <label>Âge<select value=${f.minAge} onChange=${(e) => set({ minAge: e.target.value })}>
        ${AGE_CHOICES.map(([k, l]) => html`<option value=${k}>${l}</option>`)}</select></label>
      <label>Ouverture des portes (minutes avant)<input type="number" min="0" max="600" step="5" value=${f.doors} placeholder="ex. 60" onInput=${(e) => set({ doors: e.target.value })} /></label>
      <label>Langue<select value=${f.language} onChange=${(e) => set({ language: e.target.value })}>
        <option value="">Non précisée</option>${Object.entries(LANGUAGE_LABELS).map(([k, l]) => html`<option value=${k}>${l}</option>`)}</select></label>
    </div>
    <label>Accessibilité<textarea rows="3" maxlength="1000" placeholder="Accès en fauteuil roulant, places pour accompagnateur, carte CAL acceptée, sous-titres…" value=${f.accessibility}
      onInput=${(e) => set({ accessibility: e.target.value })}></textarea></label>
    ${error && html`<${AssistantFailure} error=${error} />`}
    <div class="row"><button type="submit">Enregistrer la fiche</button>${msg && html`<span class="badge ok" role="status">${msg}</span>`}</div>
  </form>`;
}

// ── Run 93: the event page's sections (hero facts, highlights, gallery, "Le jour J", FAQ) ──
const PAGE_LISTS = {
  highlights: { title: "Points forts", hint: "Une photo, un titre et quelques mots. Montrés en rangée sous le titre de la page.", max: 10, blank: { title: "", text: "", imageUrl: "" },
    fields: [["title", "Titre", 80], ["text", "Texte (facultatif)", 400, true], ["imageUrl", "Photo (lien https, facultatif)", 500]] },
  gallery: { title: "Galerie", hint: "Des photos du lieu ou des éditions passées. Elles s'ouvrent en grand dans la page.", max: 24, blank: { url: "", alt: "" },
    fields: [["url", "Photo (lien https)", 500], ["alt", "Ce qu'on y voit (facultatif)", 150]] },
  steps: { title: "Le jour J", hint: "Le déroulement de la visite, dans l'ordre.", max: 10, blank: { title: "", text: "", imageUrl: "" },
    fields: [["title", "Étape", 80], ["text", "Texte (facultatif)", 400, true], ["imageUrl", "Photo (lien https, facultatif)", 500]] },
  faq: { title: "FAQ", hint: "Vos questions et réponses. La page ajoute d'elle-même celles qu'elle connaît déjà : âge, durée, langue, accessibilité, remboursement, réception des billets.", max: 20, blank: { question: "", answer: "" },
    fields: [["question", "Question", 200], ["answer", "Réponse", 1500, true]] },
};
const clean = (v) => { const t = String(v ?? "").trim(); return t === "" ? null : t; };

function EventPageEditor({ api, base, eventId, event, assistant }) {
  const initial = () => {
    const p = event.page ?? {};
    const rows = (key) => (p[key] ?? []).map((r) => Object.fromEntries(Object.keys(PAGE_LISTS[key].blank).map((k) => [k, r[k] ?? ""])));
    return { duration: event.durationMinutes == null ? "" : String(event.durationMinutes), format: event.format ?? "", summary: p.summary ?? "", notice: p.notice ?? "",
      highlights: rows("highlights"), gallery: rows("gallery"), steps: rows("steps"), faq: rows("faq") };
  };
  const [f, setF] = useState(initial);
  const [msg, setMsg] = useState(null);
  const [error, setError] = useState(null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (patch) => { setMsg(null); setF((x) => ({ ...x, ...patch })); };
  const edit = (key, i, field, value) => set({ [key]: f[key].map((r, k) => (k === i ? { ...r, [field]: value } : r)) });
  const move = (key, i, d) => { const list = [...f[key]]; const j = i + d; if (j < 0 || j >= list.length) return; [list[i], list[j]] = [list[j], list[i]]; set({ [key]: list }); };
  const drop = (key, i) => set({ [key]: f[key].filter((_, k) => k !== i) });
  const add = (key) => set({ [key]: [...f[key], { ...PAGE_LISTS[key].blank }] });
  const save = async (e) => {
    e.preventDefault(); setError(null); setMsg(null);
    const d = String(f.duration).trim();
    try {
      if (d !== "" && !(Number.isInteger(Number(d)) && Number(d) >= 5 && Number(d) <= 1440)) throw new Error("Durée : un nombre de minutes entre 5 et 1440.");
      const list = (key, required) => f[key].filter((r) => clean(r[required])).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, clean(v)])));
      await api(`${base}/events/${eventId}`, { method: "PATCH", body: {
        durationMinutes: d === "" ? null : Number(d), format: clean(f.format),
        page: { summary: clean(f.summary), notice: clean(f.notice), highlights: list("highlights", "title"), gallery: list("gallery", "url"), steps: list("steps", "title"), faq: list("faq", "question") },
      } });
      setMsg("Enregistré. La page de l’événement est à jour.");
    } catch (err) { setError(err); }
  };
  // The assistant writes the texts; the photos already chosen stay where they are.
  const draft = async () => {
    setError(null); setMsg(null); setBusy(true);
    try {
      const { draft: d } = await api(`${base}/events/${eventId}/assistant/page`, { method: "POST", body: { notes } });
      const keepPhotos = (key, items) => items.map((r, i) => ({ ...PAGE_LISTS[key].blank, ...r, imageUrl: f[key][i]?.imageUrl ?? "" }));
      setF((x) => ({ ...x, summary: d.summary, highlights: keepPhotos("highlights", d.highlights), steps: keepPhotos("steps", d.steps), faq: d.faq }));
      setMsg("Brouillon de l’assistant inséré : relisez-le, ajoutez vos photos, puis enregistrez la page.");
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  const [, , clientId, , brandId] = base.split("/").slice(2);
  const section = (key) => {
    const L = PAGE_LISTS[key];
    return html`<fieldset class="page-list" aria-label=${L.title}>
      <legend>${L.title} <span class="muted">(${f[key].length}/${L.max})</span></legend>
      <p class="muted">${L.hint}</p>
      ${f[key].map((r, i) => html`<div class="page-row">
        <div class="page-fields">${L.fields.map(([k, label, max, long]) => long
          ? html`<label>${label}<textarea rows="2" maxlength=${max} value=${r[k]} onInput=${(e) => edit(key, i, k, e.target.value)}></textarea></label>`
          : html`<label>${label}<input maxlength=${max} type=${k === "url" || k === "imageUrl" ? "url" : "text"} value=${r[k]} onInput=${(e) => edit(key, i, k, e.target.value)} /></label>`)}</div>
        <div class="page-tools">
          <button type="button" class="secondary" aria-label=${`Monter : ${L.title} ${i + 1}`} disabled=${i === 0} onClick=${() => move(key, i, -1)}>↑</button>
          <button type="button" class="secondary" aria-label=${`Descendre : ${L.title} ${i + 1}`} disabled=${i === f[key].length - 1} onClick=${() => move(key, i, 1)}>↓</button>
          <button type="button" class="link" aria-label=${`Retirer : ${L.title} ${i + 1}`} onClick=${() => drop(key, i)}>Retirer</button>
        </div>
      </div>`)}
      ${f[key].length < L.max && html`<button type="button" class="secondary" onClick=${() => add(key)}>Ajouter : ${L.title}</button>`}
    </fieldset>`;
  };
  return html`<form class="card page-form" aria-label="Page de l’événement" onSubmit=${save}>
    <p class="muted">Ce qui est rempli s’affiche sur la page de l’événement (<a href=${`/acheter/${clientId}/${brandId}/${eventId}`} target="_blank" rel="noopener">voir la page</a>). Rien n’est inventé : les dates, les prix et les places viennent de la billetterie.</p>
    <div class="inline">
      <label>Durée (minutes)<input type="number" min="5" max="1440" step="5" placeholder="ex. 90" value=${f.duration} onInput=${(e) => set({ duration: e.target.value })} /></label>
      <label>Format<input maxlength="80" placeholder="Exposition intérieure, spectacle en plein air…" value=${f.format} onInput=${(e) => set({ format: e.target.value })} /></label>
    </div>
    <label>Résumé (une ligne sous le titre)<input maxlength="120" placeholder="18 tableaux · 20 étapes · réalité virtuelle en option" value=${f.summary} onInput=${(e) => set({ summary: e.target.value })} /></label>
    <label>À savoir avant de réserver (facultatif)<textarea rows="2" maxlength="600" placeholder="Contenu qui peut choquer, parcours dans le noir, renonciation à signer…" value=${f.notice} onInput=${(e) => set({ notice: e.target.value })}></textarea></label>
    ${assistant && html`<div class="assistant-row">
      <label>Notes pour rédiger la page (facultatif)<input maxlength="1000" placeholder="Ce qu’on y vit, ce qui est inclus, le déroulement…" value=${notes} onInput=${(e) => setNotes(e.target.value)} /></label>
      <button type="button" class="secondary" disabled=${busy} onClick=${draft}>${busy ? "Rédaction…" : "Rédiger la page avec l’assistant"}</button>
    </div>`}
    ${section("highlights")}${section("gallery")}${section("steps")}${section("faq")}
    ${error && html`<${AssistantFailure} error=${error} />`}
    <div class="row"><button type="submit">Enregistrer la page</button>${msg && html`<span class="badge ok" role="status">${msg}</span>`}</div>
  </form>`;
}

function EventDetail({ api, base, eventId, assistant }) {
  const [ev, reloadEvent] = useLoad(() => api(`${base}/events/${eventId}`), [base, eventId]);
  const [sessions, reloadSessions] = useLoad(() => api(`${base}/events/${eventId}/sessions`), [base, eventId]);
  const [types, reloadTypes] = useLoad(() => api(`${base}/events/${eventId}/ticket-types`), [base, eventId]);
  const [error, setError] = useState(null);
  const [sess, setSess] = useState({ startsAt: "", capacity: 100 });
  const [tt, setTt] = useState({ code: "", name: "", price: "", maxQuantity: 10, minQuantity: 0, kind: "admission", countsAsAdult: true, grantsSessionChange: false, openDate: false, addOnScope: "up_to_admissions", stock: "", active: true });
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
      addOnScope: addOn ? tt.addOnScope : null, grantsSessionChange: addOn && tt.grantsSessionChange, openDate: !addOn && tt.openDate,
      stockPerSession: addOn && String(tt.stock).trim() !== "" ? Number(tt.stock) : null, active: tt.active,
    } });
    setTt({ ...tt, code: "", name: "", price: "", stock: "" }); reloadTypes();
  });
  // Run 49: change a price, a stock, or take a type off sale (an add-on stays hidden until its price is confirmed).
  const editType = (t, field) => act(async () => {
    let body;
    if (field === "price") {
      const v = prompt(`Prix de ${t.name} ($)`, (t.priceCents / 100).toFixed(2)); if (v === null) return;
      const cents = Math.round(Number(v.replace(",", ".")) * 100);
      if (!Number.isInteger(cents) || cents < 0) throw new Error("Prix invalide.");
      body = { priceCents: cents };
    } else if (field === "description") {
      // Run 93: shown under "Plus d'infos" on the event page.
      const v = prompt(`Ce que comprend ${t.name} (montré sous « Plus d'infos » dans la billetterie ; vide = rien)`, t.description ?? ""); if (v === null) return;
      body = { description: v.trim() === "" ? null : v.trim() };
    } else if (field === "stock") {
      const v = prompt(`Stock de ${t.name} par séance (vide = sans limite)`, t.stockPerSession ?? ""); if (v === null) return;
      body = { stockPerSession: v.trim() === "" ? null : Number(v.trim()) };
    } else body = { active: !t.active };
    await api(`${base}/ticket-types/${t.id}`, { method: "PATCH", body }); reloadTypes();
  });
  // Run 50: the event's photo, at the top of the tickets page, the shop and the tickets e-mail.
  const setPhoto = act(async () => {
    const v = prompt("Adresse de la photo de l'événement (https://…, format paysage 16:9 de préférence).\nLaissez vide pour retirer la photo.", event.imageUrl ?? "");
    if (v === null) return;
    const url = v.trim();
    if (url && !httpsUrl(url)) throw new Error("L'adresse de la photo doit commencer par https://.");
    await api(`${base}/events/${eventId}`, { method: "PATCH", body: { imageUrl: url || null } }); reloadEvent();
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
    ${event.imageUrl && html`<img class="event-photo" src=${event.imageUrl} alt="" />`}
    <div class="row card">
      ${event.status !== "published" && html`<button onClick=${setEventStatus("published")}>Publier</button>`}
      ${event.status === "published" && html`<button class="secondary" onClick=${setEventStatus("draft")}>Retirer de la vente publique</button>`}
      <button class="secondary" onClick=${duplicate}>Dupliquer l'événement</button>
      <button class="secondary" onClick=${setPhoto}>${event.imageUrl ? "Changer la photo" : "Ajouter une photo"}</button>
      <span class="muted">Portes : ${event.admissionOpensBeforeMinutes} min avant · ${event.admissionClosesAfterMinutes} min après</span>
    </div>

    <h2>Fiche de l’événement</h2>
    <${EventFacts} api=${api} base=${base} eventId=${eventId} event=${event} assistant=${assistant} />

    <h2>Page de l’événement</h2>
    <${EventPageEditor} api=${api} base=${base} eventId=${eventId} event=${event} assistant=${assistant} />

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
    ${sessions.loading ? html`<${Loading} />` : html`<table><thead><tr><th>Début</th><th>Statut</th><th class="num">Capacité</th><th class="num">Vendus</th><th class="num">Réservés</th><th class="num">En attente</th><th></th></tr></thead>
      <tbody>${(sessions.data?.sessions ?? []).map((s) => html`<tr>
        <td>${when(s.startsAt)}</td><td><${Badge} status=${s.status} /></td>
        <td class="num"><button class="link" onClick=${setCapacity(s.id, s.capacity)}>${s.capacity}</button></td><td class="num">${s.soldCount}</td><td class="num">${s.reservedCount}</td><td class="num" title="Liste d'attente : ces personnes reçoivent un courriel dès que des places se libèrent">${s.waitlistCount ?? 0}</td>
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
    <${PresaleCodes} api=${api} base=${base} eventId=${eventId} event=${event} />

    <h2>Types de billets</h2>
    <form class="inline card" onSubmit=${addType}>
      <label>Code<input required pattern="[A-Za-z0-9_]{1,40}" value=${tt.code} onInput=${(e) => setTt({ ...tt, code: e.target.value })} /></label>
      <label>Nom<input required value=${tt.name} onInput=${(e) => setTt({ ...tt, name: e.target.value })} /></label>
      <label>Prix ($)<input required inputmode="decimal" value=${tt.price} onInput=${(e) => setTt({ ...tt, price: e.target.value })} /></label>
      <label>Min<input type="number" min="0" value=${tt.minQuantity} onInput=${(e) => setTt({ ...tt, minQuantity: e.target.value })} /></label>
      <label>Max<input type="number" min="1" value=${tt.maxQuantity} onInput=${(e) => setTt({ ...tt, maxQuantity: e.target.value })} /></label>
      <label>Genre<select value=${tt.kind} onChange=${(e) => setTt({ ...tt, kind: e.target.value })}><option value="admission">Admission</option><option value="add_on">Option (ajout)</option></select></label>
      ${tt.kind === "admission"
        ? html`<label class="check"><input type="checkbox" checked=${tt.countsAsAdult} onChange=${(e) => setTt({ ...tt, countsAsAdult: e.target.checked })} /> Adulte</label>
            <label class="check"><input type="checkbox" checked=${tt.openDate} onChange=${(e) => setTt({ ...tt, openDate: e.target.checked })} /> Billet ouvert (date modifiable)</label>`
        : html`<label>Quantité<select value=${tt.addOnScope} onChange=${(e) => setTt({ ...tt, addOnScope: e.target.value })}>
              <option value="up_to_admissions">Jusqu'à une par personne</option><option value="per_admission">Exactement une par personne</option><option value="per_order">Libre (min–max)</option></select></label>
            <label>Stock par séance<input type="number" min="0" placeholder="sans limite" value=${tt.stock} onInput=${(e) => setTt({ ...tt, stock: e.target.value })} /></label>
            <label class="check"><input type="checkbox" checked=${tt.grantsSessionChange} onChange=${(e) => setTt({ ...tt, grantsSessionChange: e.target.checked })} /> Permet un changement de séance (Flex)</label>`}
      <label class="check"><input type="checkbox" checked=${tt.active} onChange=${(e) => setTt({ ...tt, active: e.target.checked })} /> En vente dès maintenant</label>
      <button type="submit">Ajouter</button>
    </form>
    ${types.loading ? html`<${Loading} />` : html`<div class="table-scroll" role="region" aria-label="Types de billets" tabindex="0"><table><thead><tr><th>Code</th><th>Nom</th><th class="num">Prix</th><th class="num">Min–Max</th><th>Genre</th><th class="num">Stock / séance</th><th>Vente</th></tr></thead>
      <tbody>${(types.data?.ticketTypes ?? []).map((t) => html`<tr><td>${t.code}</td><td>${t.name}<br />
        <button class="link" title=${t.description ?? ""} onClick=${editType(t, "description")}>${t.description ? "Modifier ce qui est inclus" : "Dire ce qui est inclus"}</button></td>
        <td class="num"><button class="link" onClick=${editType(t, "price")}>${money(t.priceCents)}</button></td><td class="num">${t.minQuantity}–${t.maxQuantity}</td>
        <td>${t.kind === "add_on" ? `${t.grantsSessionChange ? "Option (Flex)" : "Option"} · ${ADD_ON_SCOPE_FR[t.addOnScope] ?? ""}` : t.countsAsAdult ? "Admission adulte" : "Admission"}${t.openDate ? " · billet ouvert" : ""}</td>
        <td class="num">${t.kind === "add_on" ? html`<button class="link" onClick=${editType(t, "stock")}>${t.stockPerSession ?? "sans limite"}</button>` : "—"}</td>
        <td><button class=${t.active ? "secondary" : ""} onClick=${editType(t, "active")}>${t.active ? "Retirer de la vente" : "Mettre en vente"}</button></td></tr>`)}</tbody></table></div>`}`;
}

const ADD_ON_SCOPE_FR = { per_admission: "une par personne", up_to_admissions: "jusqu'à une par personne", per_order: "quantité libre" };

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
      <p class="muted">Payée le ${when(o.paidAt)} · Total ${money(o.totalCents)}${o.discountCents > 0 ? ` (rabais ${money(o.discountCents)}, code ${o.promoCode})` : ""} · Remboursé ${money(o.refundedCents)} · Commission ${money(o.commissionCents - o.commissionRefundedCents)}</p>
      ${o.attribution && html`<p class="muted">Provenance : ${[o.attribution.source, o.attribution.medium, o.attribution.campaign].filter(Boolean).join(" / ") || "—"}${o.attribution.landing ? ` · page ${o.attribution.landing}` : ""}</p>`}</div>
    <table><thead><tr><th>Ligne</th><th class="num">Qté</th><th class="num">Prix</th><th class="num">Total</th></tr></thead>
      <tbody>${o.lines.map((l) => html`<tr><td>${l.nameSnapshot}</td><td class="num">${l.quantity}</td><td class="num">${money(l.unitPriceCents)}</td><td class="num">${money(l.lineTotalCents)}</td></tr>`)}
        ${o.taxes.map((t) => html`<tr><td class="muted">${t.code === "GST" ? "TPS" : "TVQ"}</td><td></td><td></td><td class="num">${money(t.amountCents)}</td></tr>`)}</tbody></table>
    <h2>Courriel des billets</h2>
    <div class="card"><div class="row">
      ${(o.emails ?? []).length === 0 ? html`<span class="muted">Aucun courriel envoyé.</span>`
        : o.emails.map((e) => html`<span><${Badge} status=${`email_${e.status}`} /> ${e.sentAt ? when(e.sentAt) : ""}${e.lastError && e.status !== "sent" ? html` <span class="muted">(${e.lastError})</span>` : ""}${e.bouncedAt ? html` <span class="badge bad">Adresse refusée</span>` : ""}</span>`)}
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
      <h2>Changement de séance (option de changement ou billet ouvert)</h2>
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
  "brand.appearance_updated": "Apparence de la marque modifiée",
  "buyer.exported": "Données de l'acheteur exportées", "buyer.anonymized": "Acheteur anonymisé",
  "credentials.key_rotated": "Clé des codes QR remplacée", "credentials.reissued": "Code QR réémis", "scan.manual_admission": "Entrée sans code QR",
  "reports.daily_exported": "Rapport par jour exporté", "reports.attendees_exported": "Liste des participants exportée", "reports.orders_exported": "Commandes exportées",
  "settings.reminders_updated": "Courriels de rappel modifiés",
  "assistant.drafted": "Brouillon demandé à l'assistant de rédaction",
};
const ROLE_FR = { owner: "propriétaire", admin: "administrateur", manager: "gestionnaire", editor: "éditeur", staff: "personnel", viewer: "lecteur" };
const FAMILIES = [["", "Tout"], ["order", "Commandes"], ["refund", "Remboursements"], ["payment", "Paiements Stripe"], ["tickets", "Billets annulés"],
  ["buyer", "Données personnelles"], ["session", "Séances"], ["event", "Événements"], ["reports", "Exports"], ["assistant", "Assistant de rédaction"], ["control", "Synchronisation TAKATAK"]];
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
  // A reconciliation discrepancy must remain reviewable after exiting offline
  // mode. This ledger is local to the authorized scanner browser/device.
  const [archivedIncidents, setArchivedIncidents] = useState([]);
  const [prep, setPrep] = useState(null);
  const [reference, setReference] = useState("");
  const [found, setFound] = useState(null);
  const [sound, setSound] = useState(soundWanted);
  // One FIFO per scanner instance. Sync, scan and exit must never read and
  // subsequently overwrite different snapshots of the same local admission log.
  const offlineCoordinator = useRef(null);
  if (!offlineCoordinator.current) offlineCoordinator.current = createOfflineCoordinator();
  const exclusiveOffline = (operation, { recovery = false } = {}) => offlineCoordinator.current(
    () => withOfflineSessionLock(sessionId, operation, { recovery }),
  ).catch((err) => {
    // Some embedded/private browsers disable Web Locks. Never allow new
    // admissions in that case: a second tab could overwrite their audit.
    if (err?.message === "offline_lock_unavailable") {
      setLast({ result: "offline_lock_unavailable", offline: true });
      setError(new Error("Mode hors ligne indisponible sur cet appareil : verrouillage de sécurité non pris en charge. Utilisez le scan en ligne."));
    } else setError(err);
  });
  const toggleSound = (on) => { setSound(on); try { localStorage.setItem(SOUND_KEY, on ? "on" : "off"); } catch {} };
  const deviceId = (() => { let id = localStorage.getItem("alkao.ops.device"); if (!id) { id = `ops-${crypto.randomUUID().slice(0, 8)}`; localStorage.setItem("alkao.ops.device", id); } return id; })();

  useEffect(() => { if (eventId) api(`${base}/events/${eventId}/sessions`).then((r) => setSessions(r.sessions), setError); }, [eventId]);
  useEffect(() => {
    if (!sessionId) return;
    setOffline(loadOffline(sessionId));
    try { setArchivedIncidents(loadIncidentReport(sessionId)); }
    catch (err) { setArchivedIncidents([]); setError(err); }
    api(`${base}/sessions/${sessionId}/scanner-manifest`).then((r) => setManifest(r.manifest), (err) => { if (!loadOffline(sessionId)) setError(err); });
  }, [sessionId]);

  // ── Offline mode (Run 09): the device checks QR codes itself and syncs later ──
  const persist = (store) => { saveOffline(sessionId, store); setOffline(store ? { ...store } : null); };
  const goOffline = () => exclusiveOffline(async () => {
    setError(null);
    // Starting offline mode must never reset a previous audit queue.
    const existing = loadOffline(sessionId);
    if (existing) { setOffline({ ...existing }); return; }
    try {
      const r = await api(`${base}/sessions/${sessionId}/scanner-manifest`);
      setManifest(r.manifest);
      persist(newOfflineStore(r.manifest));
    } catch (err) { setError(err); }
  });
  // Caller holds the FIFO. Do not invoke the public sync() wrapper here,
  // otherwise leaving offline mode would deadlock waiting on itself.
  const syncCurrent = async () => {
    const store = loadOffline(sessionId); if (!store) return;
    const send = async (scans) => (await api(`${base}/scanner/scans/batch`, { method: "POST", body: { sessionId, deviceId, scans } })).scans;
    const done = await syncOffline(store, send);
    if (done) { try { store.manifest = (await api(`${base}/sessions/${sessionId}/scanner-manifest`)).manifest; store.downloadedAt = Date.now(); store.localAdmitted = []; store.localEntered = []; } catch {} }
    persist(store);
  };
  // Keep previous audits recoverable even if a browser loses Web Locks support.
  const sync = () => exclusiveOffline(syncCurrent, { recovery: true });
  const leaveOffline = () => exclusiveOffline(async () => {
    setError(null);
    await syncCurrent();
    const store = loadOffline(sessionId);
    if (store?.queue.length) {
      // Never discard local audit records with a pending server acknowledgment.
      setError(new Error(`${store.queue.length} admission(s) non synchronisée(s). Reconnectez-vous et synchronisez avant de quitter le mode hors ligne.`));
      return;
    }
    // Before clearing the scanner's temporary audit, permanently retain the
    // disagreement details (without signed QR, buyer PII or access token).
    // Storage failure keeps the offline audit intact and blocks safe exit.
    const report = archiveOfflineIncidents(sessionId, store);
    setArchivedIncidents(report);
    persist(null);
  }, { recovery: true });
  useEffect(() => {
    if (!offline) return;
    const t = setInterval(() => { if (navigator.onLine && loadOffline(sessionId)?.queue.length) void sync(); }, 15_000);
    return () => clearInterval(t);
  }, [Boolean(offline), sessionId]);

  // Export from this device only. No signed QR, visitor name or buyer email.
  const visibleIncidents = [...archivedIncidents, ...(offline?.incidents ?? [])]
    .filter((item, i, entries) => entries.findIndex((x) => x.id === item.id) === i);
  const exportIncidents = () => {
    if (!visibleIncidents.length) return;
    try {
      const csv = incidentReportCsv(visibleIncidents);
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `alkao-incidents-${sessionId}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) { setError(err); }
  };
  // Run 14: live gate counter, refreshed every 10 s and after each scan (online only).
  // Run 57: with it, the session's options to prepare and how many were handed over.
  const refreshAttendance = () => {
    if (!sessionId || loadOffline(sessionId)) return;
    api(`${base}/sessions/${sessionId}/attendance`).then((r) => setAttendance(r.attendance), () => {});
    api(`${base}/sessions/${sessionId}/options`).then((r) => setPrep(r.options), () => {});
  };
  useEffect(() => {
    setAttendance(null); setPrep(null);
    if (!sessionId) return;
    refreshAttendance();
    const t = setInterval(refreshAttendance, 10_000);
    return () => clearInterval(t);
  }, [sessionId]);

  const submit = async (value) => {
    const code = (value ?? payload).trim(); if (!code || !sessionId) return;
    setError(null); setPayload("");
    const store = loadOffline(sessionId);
    if (store) {
      return exclusiveOffline(async () => {
        // Re-read only AFTER any earlier sync finishes to avoid overwriting it.
        const latest = loadOffline(sessionId);
        if (!latest) { setError(new Error("Mode hors ligne indisponible. Reconnectez-vous avant de scanner.")); return; }
        const r = await offlineScan(latest, code);
        try { persist(latest); }
        catch {
          // A physically admitted attendee with no durable audit is unsafe.
          // Do not display a successful admission when storage is full/blocked.
          setLast({ result: "storage_unavailable", offline: true });
          setError(new Error("Stockage local indisponible. N'admettez pas le billet; reconnectez-vous."));
          return;
        }
        setLast({ ...r, offline: true });
      });
    }
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
    ${prep?.length > 0 && html`<div class="card" aria-label="Options de la séance">
      <h2>Options de la séance</h2>
      <ul class="prep">${prep.map((o) => html`<li><span>${o.name}</span><span><strong>${o.handedOver} / ${o.sold}</strong> <span class="muted">remis</span></span></li>`)}</ul></div>`}
    ${sessionId && html`<div class="card row" aria-label="Mode hors ligne">
      ${offline ? html`<span class="badge warn">Hors ligne</span>
          <span class="muted">Liste du ${when(new Date(offline.downloadedAt).toISOString())} · ${offline.manifest.credentials.length} billets</span>
          <span>${offline.queue.length} en attente de synchronisation</span>
          ${offline.conflicts > 0 && html`<span class="badge bad">${offline.conflicts} admission(s) hors ligne contestée(s) — vérifier les écarts avec le serveur</span>`}
          ${offline.incidentArchiveFailed && html`<span role="alert" class="badge bad">Archivage des incidents impossible : journal conservé. Vérifiez le stockage local avant de quitter le scanner.</span>`}
          <button class="secondary" onClick=${sync}>Synchroniser maintenant</button>
          <button class="secondary" onClick=${leaveOffline}>Quitter le mode hors ligne</button>`
        : html`<span class="muted">Réseau instable à la porte ?</span><button class="secondary" onClick=${goOffline}>Préparer le mode hors ligne</button>`}
    </div>`}
    ${sessionId && visibleIncidents.length > 0 && html`<section class="card noprint" aria-label="Incidents de synchronisation hors ligne">
      <h2>Incidents de synchronisation hors ligne</h2>
      <p class="muted">${visibleIncidents.length} écart(s) conservé(s) sur cet appareil, même après avoir quitté le mode hors ligne.
        L'accueil doit comparer ces admissions avec le journal du serveur avant toute correction. Aucun code QR complet ni donnée personnelle n'est exporté.</p>
      <button type="button" class="secondary" onClick=${exportIncidents}>Télécharger le rapport CSV des incidents</button>
      <ul class="prep">${visibleIncidents.slice(-20).map((item) => html`<li key=${item.id}>
        <span>${item.qrId || "Identifiant historique indisponible"} · ${item.result}</span>
        <span class="muted">${item.scannedAt || "Ancienne admission"} · ${item.count ?? 1}</span>
      </li>`)}</ul>
    </section>`}
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
        ${last.options && html`<div class=${`scan-options${last.options.already ? " given" : ""}`}>
          <strong>${last.options.already ? "Options déjà remises à une entrée précédente" : "Options à remettre"}</strong>
          <span>${optionsText(last.options.items)}</span></div>`}
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
        ${found.options?.length > 0 && html`<p><strong>Options :</strong> ${optionsText(found.options)}</p>`}
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
      <label>Origines HTTPS (une par ligne), ex. https://www.exemple.ca
        <textarea rows="3" value=${origins ?? current.join("\n")} onInput=${(e) => setOrigins(e.target.value)}></textarea></label>
      <div class="row"><button type="submit">Enregistrer</button>${saved && html`<span class="badge ok">Enregistré</span>`}</div>
    </form>`;
}

// ── Shell and routing ───────────────────────────────────────────────────────
// Run 40: the brand block (electric-blue tile, name, small caps line), in the TAKATAK brand (BRAND.md).
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
const PERMISSION_FR = { express: "Oui (consentement exprès)", implied: "Oui (client récent)", expired: "Non : dernier achat il y a plus de 2 ans", opted_out: "Non : désabonné", bounced: "Non : l'adresse refuse les courriels", none: "Pas de courriel" };
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
        ${c.emailBouncedAt && html`<p class="alert warn">Le ${when(c.emailBouncedAt)}, cette adresse a refusé un courriel (elle n'existe plus ou est mal écrite). ALKAO n'y écrit plus ; une nouvelle adresse (import, achat ou inscription à l'infolettre) rétablit les envois.</p>`}
        <p class="muted">Loi canadienne anti-pourriel : un achat permet d'écrire au client pendant 2 ans ; après, il faut son consentement (par exemple l'inscription à l'infolettre).</p>
        <p class="row">
          ${emailOn ? html`<button class="secondary" onClick=${patch({ emailOptOut: true })}>Désabonner des courriels</button>`
            : c.email && !c.emailBouncedAt && html`<button class="secondary" onClick=${patch({ emailConsent: true })}>Le client a consenti aux courriels</button>`}
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
// Run 46: a text's footer, and its length in texts (GSM-7: 160, or 153 each when split; otherwise 70 / 67).
const SMS_STOP = { fr: "Répondez STOP pour ne plus en recevoir.", en: "Reply STOP to opt out." };
const GSM = /^[A-Za-z0-9 @£$¥èéùìòÇØøÅå\n\rΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà^{}\\[~\]|€]*$/;
const smsSegments = (t) => { const [one, part] = GSM.test(t) ? [160, 153] : [70, 67]; return t.length <= one ? 1 : Math.ceil(t.length / part); };
const EMPTY_CAMPAIGN = { name: "", language: "fr", channel: "email", kind: "one_time", delayDays: 3, subject: "", preheader: "", heading: "Bonjour {prénom},", body: "", imageUrl: "", ctaLabel: "", ctaUrl: "", audience: { segments: [], statuses: [], categories: [] } };
// Run 45: an automation shows whether it runs instead of a send status. Run 48: held first.
const CampaignBadge = ({ c }) => (c.heldAt && ["draft", "sending"].includes(c.status) ? html`<span class="badge bad">Suspendue : à vérifier</span>`
  : c.kind === "after_visit" && c.status === "draft"
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
      <p class="muted">Les inscriptions des sites web (les vitrines) reçoivent un courriel de confirmation. Seul le clic de la personne l'ajoute aux clients, avec son consentement exprès ; la page de confirmation affiche alors le code de bienvenue.</p>
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
        <tbody>${list.map((c) => html`<tr><td><a href=${`#${prefix}/campaign/${c.id}`}>${c.name}</a><br /><span class="muted">${c.channel === "sms" ? "Texto" : c.subject}</span></td>
          <td><${CampaignBadge} c=${c} /></td><td class="num">${number(c.kind === "after_visit" ? c.sent + c.pending : c.recipients)}</td><td class="num">${number(c.sent)}</td><td class="num">${number(c.unsubscribed)}</td><td>${when(c.createdAt)}</td></tr>`)}</tbody></table></div>`}</div>
    <div><${MarketingSettings} api=${api} base=${base} /></div>
    <div><${NewsletterSettings} api=${api} base=${base} /></div>`;
}

// ── Run 92: the writing assistant (a draft from the catalog; staff read, correct and save) ──
const AssistantFailure = ({ error }) => (error instanceof ApiError && error.code === "assistant_draft_rejected" && Array.isArray(error.details)
  ? html`<div class="alert bad" role="alert"><p>${ERRORS_FR.assistant_draft_rejected}</p><ul>${error.details.map((d) => html`<li>${d}</li>`)}</ul></div>`
  : html`<${Failure} error=${error} />`);

function AssistantCampaign({ api, base, channel, language, onDraft }) {
  const [events] = useLoad(() => api(`${base}/events`), [base]);
  const [eventId, setEventId] = useState("");
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  const run = async (e) => {
    e.preventDefault(); setError(null); setDone(false); setBusy(true);
    try {
      const r = await api(`${base}/assistant/campaign`, { method: "POST", body: { channel, language, eventId: eventId || null, brief } });
      onDraft(r.draft, eventId || null); setDone(true);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  const published = (events.data?.events ?? []).filter((ev) => ev.status === "published");
  return html`<form class="card assistant-card" aria-label="Rédiger avec l'assistant" onSubmit=${run}>
    <h3>Rédiger avec l’assistant</h3>
    <p class="muted">Donnez le but en une phrase. L’assistant écrit ${channel === "sms" ? "le texto" : "l’objet, le titre, le texte et le bouton"} à partir de vos dates, lieux et tarifs. Il n’invente ni prix ni rabais, et rien ne part sans vous. N’y mettez aucun renseignement personnel sur vos clients.</p>
    <div class="fields">
      <label>Événement<select value=${eventId} onChange=${(e) => setEventId(e.target.value)}>
        <option value="">Tout ce qui est en vente</option>${published.map((ev) => html`<option value=${ev.id}>${ev.title}</option>`)}</select></label>
    </div>
    <label>Consigne<textarea rows="2" required minlength="3" maxlength="600" placeholder="Ex. : rappeler aux familles qu’il reste deux samedis d’Halloween" value=${brief} onInput=${(e) => setBrief(e.target.value)}></textarea></label>
    ${error && html`<${AssistantFailure} error=${error} />`}
    ${done && html`<div class="alert ok" role="status">Brouillon inséré dans le formulaire ci-dessous. Relisez-le et corrigez-le avant d’enregistrer.</div>`}
    <p class="row"><button type="submit" disabled=${busy}>${busy ? "Rédaction…" : "Rédiger le brouillon"}</button></p>
  </form>`;
}

function CampaignEditor({ api, base, prefix, campaignId, assistant }) {
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
  const sms = c.channel === "sms";
  const audienceKey = JSON.stringify(c.audience);
  useEffect(() => {
    if (!draft || automatic) return;
    let live = true;
    api(`${base}/campaigns/audience`, { method: "POST", body: { ...c.audience, channel: c.channel } }).then((r) => live && setCount(r.recipients), () => live && setCount(null));
    return () => { live = false; };
  }, [base, audienceKey, draft, automatic, c.channel]);
  if (state.loading && !state.data) return html`<h1>Campagne</h1><${Loading} />`;
  if (state.error) return html`<h1>Campagne</h1><${Failure} error=${state.error} />`;
  const set = (patch) => setF({ ...c, ...patch });
  const toggle = (kind, key) => {
    const list = c.audience[kind];
    set({ audience: { ...c.audience, [kind]: list.includes(key) ? list.filter((k) => k !== key) : [...list, key] } });
  };
  const body = () => ({
    name: c.name, language: c.language, channel: c.channel, ctaUrl: c.ctaUrl || null, audience: c.audience, body: c.body,
    kind: c.kind, delayDays: automatic ? Number(c.delayDays) : null,
    ...(sms ? {} : { subject: c.subject, preheader: c.preheader || null, heading: c.heading, imageUrl: c.imageUrl || null, ctaLabel: c.ctaLabel || null }),
  });
  const act = (fn) => async (e) => { e?.preventDefault?.(); setError(null); setMsg(null); try { await fn(); } catch (err) { setError(err); } };
  const save = act(async () => {
    if (loaded) { await api(`${base}/campaigns/${loaded.id}`, { method: "PUT", body: body() }); setF(null); reload(); setMsg("Brouillon enregistré."); }
    else { const r = await api(`${base}/campaigns`, { method: "POST", body: body() }); location.hash = `#${prefix}/campaign/${r.campaign.id}`; }
  });
  const test = act(async () => {
    await api(`${base}/campaigns/${loaded.id}/test`, { method: "POST", body: loaded.channel === "sms" ? { phone: testTo } : { email: testTo } });
    setMsg(`Essai en route vers ${testTo} (moins d'une minute${loaded.channel === "sms" ? ", entre 9 h et 21 h" : ""}).`); reload();
  });
  const smsPreview = [c.body.replace(/(\s?)\{(?:prénom|prenom|first_name)\}/giu, "$1Marie").replace(/\s+/g, " ").trim(), c.ctaUrl, `- ${loaded?.brandName ?? "Votre marque"}. ${SMS_STOP[c.language]}`].filter(Boolean).join(" ");
  const send = act(async () => {
    if (f) throw new Error("Enregistrez d'abord vos changements.");
    if (!confirm(`Envoyer « ${loaded.subject} » à ${number(count)} clients ? Un envoi ne s'annule plus pour les courriels déjà partis.`)) return;
    await api(`${base}/campaigns/${loaded.id}/send`, { method: "POST", body: { expectedRecipients: count } }); await reload(); setMsg("Envoi lancé.");
  });
  const cancel = act(async () => { if (!confirm("Arrêter cette campagne ? Les courriels pas encore partis ne le seront jamais.")) return; await api(`${base}/campaigns/${loaded.id}/cancel`, { method: "POST" }); reload(); });
  const resume = act(async () => {
    if (!confirm("Reprendre l'envoi ? Les adresses refusées sont déjà retirées ; si les rebonds continuent, l'envoi s'arrêtera de nouveau.")) return;
    await api(`${base}/campaigns/${loaded.id}/resume`, { method: "POST" }); await reload(); setMsg("Envoi repris.");
  });
  const held = loaded?.heldAt && ["draft", "sending"].includes(loaded.status);
  const turn = (active) => act(async () => {
    if (f) throw new Error("Enregistrez d'abord vos changements.");
    await api(`${base}/campaigns/${loaded.id}/automation`, { method: "POST", body: { active } }); reload();
    setMsg(active ? "Automatisation en marche : elle écrira après chaque visite qui se termine à partir d'aujourd'hui." : "Automatisation en pause.");
  });
  const field = (label, key, attrs = {}) => html`<label>${label}<input value=${c[key] ?? ""} disabled=${!draft} onInput=${(e) => set({ [key]: e.target.value })} ...${attrs} /></label>`;
  // Run 92: the assistant's draft fills the text fields; the button leads to the event's shop.
  const applyDraft = (d, eventId) => {
    const [, , clientId, , brandId] = base.split("/").slice(2);
    const url = c.ctaUrl || (eventId ? `${location.origin}/acheter/${clientId}/${brandId}/${eventId}` : "");
    set({ ...d, name: c.name || (d.subject ?? d.body).slice(0, 120), ctaUrl: url, ...(sms ? {} : { ctaLabel: url ? d.ctaLabel : "" }) });
  };
  return html`<h1>${loaded ? loaded.name : "Nouvelle campagne"}</h1>
    <p class="row"><a href=${`#${prefix}/campaigns`}>← Campagnes</a>${loaded && html`<${CampaignBadge} c=${loaded} />`}</p>
    ${error && html`<${Failure} error=${error} />`}${msg && html`<div class="alert ok" role="status">${msg}</div>`}
    ${loaded && (!draft || loaded.kind === "after_visit") && html`<div class="grid">
      ${[["Destinataires", loaded.recipients], ["Envoyés", loaded.sent], ["En attente", loaded.pending], ["Non envoyés", loaded.skipped + loaded.failed], ["Désabonnés", loaded.unsubscribed],
        ...(loaded.channel === "email" ? [["Adresses refusées", loaded.bounced], ["Plaintes (pourriel)", loaded.complained]] : [])]
        .map(([label, v]) => html`<div class="kpi"><div class="label">${label}</div><div class="value">${number(v)}</div></div>`)}</div>
      ${held && html`<div class="alert warn" role="status"><p><strong>Envoi suspendu le ${when(loaded.heldAt)}</strong> : ${loaded.heldReason === "complaints"
        ? "plusieurs personnes ont marqué ce courriel comme pourriel."
        : "trop d'adresses de cette liste refusent les courriels (plus de 4 %)."} Continuer pourrait faire bloquer l'expéditeur, courriels de billets compris.</p>
        <p>Vérifiez à qui elle s'adresse (une vieille liste rebondit beaucoup), puis reprenez ou arrêtez l'envoi.</p>
        <p class="row"><button onClick=${resume}>Reprendre l'envoi</button></p></div>`}
      ${(loaded.status === "sending" || (loaded.kind === "after_visit" && loaded.status === "draft")) && html`<p class="row"><button class="danger" onClick=${cancel}>${loaded.kind === "after_visit" ? "Arrêter pour de bon" : "Arrêter l'envoi"}</button></p>`}`}
    ${assistant && draft && !automatic && html`<${AssistantCampaign} api=${api} base=${base} channel=${c.channel} language=${c.language} onDraft=${applyDraft} />`}
    <form class="card" aria-label="Contenu de la campagne" onSubmit=${save}>
      <div class="fields">
        ${field("Nom (pour l'équipe)", "name", { required: true, maxlength: 120 })}
        <label>Langue<select value=${c.language} disabled=${!draft} onChange=${(e) => set({ language: e.target.value })}><option value="fr">Français</option><option value="en">English</option></select></label>
        <label>Canal<select value=${c.channel} disabled=${!draft || automatic} onChange=${(e) => set({ channel: e.target.value })}>
          <option value="email">Courriel</option><option value="sms">Texto (SMS)</option></select></label>
        <label>Type<select value=${c.kind} disabled=${!draft || loaded?.active || sms} onChange=${(e) => set({ kind: e.target.value })}>
          <option value="one_time">Envoi unique</option><option value="after_visit">Automatique après chaque visite</option></select></label>
        ${automatic && html`<label>Jours après le départ<input type="number" min="0" max="60" required value=${c.delayDays} disabled=${!draft} onInput=${(e) => set({ delayDays: e.target.value })} /></label>`}
      </div>
      ${sms ? html`<div class="stack">
        <label>Texte du message<textarea rows="4" required maxlength="300" disabled=${!draft} value=${c.body} onInput=${(e) => set({ body: e.target.value })}></textarea></label>
        ${field("Lien (https, facultatif)", "ctaUrl", { type: "url", maxlength: 500 })}
        <p class="muted">Aperçu, avec le nom de la marque et la façon d'arrêter, ajoutés à chaque texto : « ${smsPreview} » — ${smsPreview.length} caractères, ${smsSegments(smsPreview)} texto(s) facturé(s) par client. {prénom} est remplacé par le prénom. Les lettres ê, â, ô, î, û, ç passent dans un alphabet plus court (70 caractères par texto). Envoi entre 9 h et 21 h seulement.</p>
      </div>` : html`<div class="stack">
        ${field("Objet du courriel", "subject", { required: true, maxlength: 150 })}
        ${field("Aperçu dans la boîte de réception (facultatif)", "preheader", { maxlength: 150 })}
        ${field("Titre", "heading", { required: true, maxlength: 150 })}
        <label>Texte<textarea rows="8" required maxlength="10000" disabled=${!draft} value=${c.body} onInput=${(e) => set({ body: e.target.value })}></textarea></label>
        <p class="muted">Une ligne vide sépare les paragraphes. {prénom} est remplacé par le prénom du client${automatic ? ", {visite} par ce qu'il a réservé (le site ou l'événement)" : ""}.</p>
        ${field("Image (lien https, facultatif)", "imageUrl", { type: "url", maxlength: 500 })}
        <div class="fields">${field("Bouton : texte (facultatif)", "ctaLabel", { maxlength: 60 })}${field("Bouton : lien https", "ctaUrl", { type: "url", maxlength: 500 })}</div>
      </div>`}
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
        ${loaded.channel === "sms"
          ? html`<label>Envoyer un essai au<input type="tel" required value=${testTo} onInput=${(e) => setTestTo(e.target.value)} /></label>`
          : html`<label>Envoyer un essai à<input type="email" required value=${testTo} onInput=${(e) => setTestTo(e.target.value)} /></label>`}
        <button type="submit" class="secondary">Envoyer l'essai</button>
        ${loaded.kind === "after_visit"
          ? (loaded.active ? html`<button type="button" class="secondary" onClick=${turn(false)}>Mettre en pause</button>` : html`<button type="button" onClick=${turn(true)}>Mettre en marche</button>`)
          : html`<button type="button" disabled=${!count} onClick=${send}>Envoyer à ${count === null ? "…" : number(count)} clients</button>`}
      </div>
      <p class="muted">${loaded.tests ? `${loaded.tests} essai(s) envoyé(s). ` : ""}${loaded.kind === "after_visit" ? "Les messages sont préparés chaque jour, puis partent avec les autres courriels." : "Les courriels partent par lots, en quelques minutes à quelques heures selon le nombre."}</p>
    </form>`}`;
}

// ── Run 50: the Brand's look on the tickets page, the shop and the buyer e-mails ──
// The same WCAG contrast as the API (src/domain/appearance.ts), to warn before saving.
const MIN_CONTRAST = 4.5;
const HEX = /^#[0-9a-f]{6}$/;
const lum = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
};
const contrast = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
/** White or black, whichever reads better on the colour. */
const inkFor = (hex) => (contrast(hex, "#ffffff") >= contrast(hex, "#000000") ? "#ffffff" : "#000000");
const httpsUrl = (u) => /^https:\/\/[^\s"'<>\\]+$/.test(u ?? "");
const EMPTY_LOOK = { logoUrl: "", accentColor: "", onAccentColor: "", websiteUrl: "", supportEmail: "", supportPhone: "", addressLine: "", refundPolicy: "", showOnAlkao: false };

function Appearance({ api, base, role }) {
  const [state, reload] = useLoad(() => api(`${base}/appearance`), [base]);
  const [f, setF] = useState(null);
  const [msg, setMsg] = useState(null);
  const [error, setError] = useState(null);
  const [logoBroken, setLogoBroken] = useState(false);
  const canEdit = ["owner", "admin", "manager", "editor"].includes(role);
  if (state.loading && !state.data) return html`<h1>Apparence</h1><${Loading} />`;
  if (state.error) return html`<h1>Apparence</h1><${Failure} error=${state.error} />`;
  const saved = state.data.appearance;
  const brandName = saved.brandName ?? "Votre marque";
  const look = f ?? Object.fromEntries(Object.keys(EMPTY_LOOK).map((k) => [k, saved[k] ?? ""]));
  const set = (patch) => { setMsg(null); setF({ ...look, ...patch }); };
  const coloured = HEX.test(look.accentColor);
  const ratio = coloured && HEX.test(look.onAccentColor) ? contrast(look.accentColor, look.onAccentColor) : null;
  const readable = ratio === null || ratio >= MIN_CONTRAST;
  const accent = coloured ? look.accentColor : "#1c1917";
  const onAccent = coloured && HEX.test(look.onAccentColor) ? look.onAccentColor : "#ffffff";
  const logo = httpsUrl(look.logoUrl) && !logoBroken ? look.logoUrl : null;
  const save = async (e) => {
    e.preventDefault(); setError(null); setMsg(null);
    const v = (s) => (String(s ?? "").trim() === "" ? null : String(s).trim());
    try {
      await api(`${base}/appearance`, { method: "PUT", body: {
        logoUrl: v(look.logoUrl), accentColor: coloured ? look.accentColor : null, onAccentColor: coloured ? onAccent : null,
        websiteUrl: v(look.websiteUrl), supportEmail: v(look.supportEmail), supportPhone: v(look.supportPhone), addressLine: v(look.addressLine),
        refundPolicy: v(look.refundPolicy), showOnAlkao: Boolean(look.showOnAlkao),
      } });
      await reload(); setF(null); setMsg("Enregistré. L’apparence et la visibilité sur ALKAO sont à jour.");
    } catch (err) { setError(err); }
  };
  const field = (key, label, attrs = {}) => html`<label>${label}<input ...${attrs} disabled=${!canEdit} value=${look[key]}
    onInput=${(e) => { if (key === "logoUrl") setLogoBroken(false); set({ [key]: e.target.value }); }} /></label>`;

  return html`<h1>Apparence</h1>
    <p class="muted">Le logo, la couleur et les coordonnées de ${brandName} sur la page des billets, la billetterie en ligne et chaque courriel aux acheteurs (billets, rappels, remboursements). Sans réglage, ALKAO garde un style neutre.</p>
    <div class="look-grid">
      <form class="card" aria-label="Apparence de la marque" onSubmit=${save}>
        <h3>Logo</h3>
        ${field("logoUrl", "Adresse de l'image du logo (https://…, PNG à fond transparent)", { type: "url", maxlength: 500, placeholder: "https://…/logo.png" })}
        <p class="muted">Le logo s'affiche sur la couleur principale, comme dans l'aperçu : prenez la version qui s'y lit bien (souvent la version blanche).</p>
        ${look.logoUrl && !httpsUrl(look.logoUrl) && html`<p class="alert warn">L'adresse doit commencer par https://.</p>`}
        ${/\.svg(?:[?#]|$)/i.test(look.logoUrl) && html`<p class="alert warn">Plusieurs logiciels de courriel n'affichent pas les images SVG : le logo manquerait dans les courriels aux acheteurs. Utilisez plutôt un PNG.</p>`}
        ${logoBroken && html`<p class="alert warn">Cette image ne s'affiche pas. Vérifiez l'adresse.</p>`}

        <h3>Couleur</h3>
        <label class="check"><input type="checkbox" disabled=${!canEdit} checked=${coloured}
          onChange=${(e) => set(e.target.checked ? { accentColor: "#0f766e", onAccentColor: inkFor("#0f766e") } : { accentColor: "", onAccentColor: "" })} />
          Utiliser la couleur de la marque</label>
        ${coloured && html`<div class="fields">
          <label>Couleur principale (bandeau, boutons)<span class="swatch-row"><input type="color" disabled=${!canEdit} value=${look.accentColor}
            onInput=${(e) => set({ accentColor: e.target.value, onAccentColor: inkFor(e.target.value) })} /><code>${look.accentColor}</code></span></label>
          <label>Texte sur cette couleur<span class="swatch-row"><input type="color" disabled=${!canEdit} value=${onAccent}
            onInput=${(e) => set({ onAccentColor: e.target.value })} /><code>${onAccent}</code></span></label>
          <button type="button" class="secondary" disabled=${!canEdit} onClick=${() => set({ onAccentColor: inkFor(look.accentColor) })}>Texte blanc ou noir, au plus lisible</button>
        </div>
        ${ratio !== null && html`<p>${readable
          ? html`<span class="badge ok">Lisible</span> <span class="muted">Contraste ${ratio.toFixed(1).replace(".", ",")} : 1 (minimum ${String(MIN_CONTRAST).replace(".", ",")}).</span>`
          : html`<span class="badge bad">Trop peu lisible</span> <span class="muted">Contraste ${ratio.toFixed(1).replace(".", ",")} : 1 ; il faut au moins ${String(MIN_CONTRAST).replace(".", ",")}. Choisissez un texte plus clair ou plus foncé.</span>`}</p>`}`}

        <h3>Coordonnées</h3>
        <p class="muted">Affichées au bas de la page des billets et des courriels, pour que l'acheteur sache qui joindre.</p>
        <div class="stack">
          ${field("websiteUrl", "Site web (https://…)", { type: "url", maxlength: 500, placeholder: "https://" })}
          ${field("supportEmail", "Courriel pour les acheteurs", { type: "email", maxlength: 254 })}
          ${field("supportPhone", "Téléphone", { type: "tel", maxlength: 40 })}
          ${field("addressLine", "Adresse", { maxlength: 200 })}
        </div>
        <h3>Politique d'échange et de remboursement</h3>
        <p class="muted">Obligatoire au Québec (OPC) : l'acheteur la voit avant de payer, puis sur la page de ses billets et dans son courriel. Texte simple, 2 000 caractères au plus.</p>
        <label>Votre politique<textarea rows="5" maxlength="2000" disabled=${!canEdit} value=${look.refundPolicy}
          placeholder="Exemple : Billets non remboursables, sauf annulation de l'événement. Changement de date possible jusqu'à 48 h avant, selon les places."
          onInput=${(e) => set({ refundPolicy: e.target.value })}></textarea></label>
        ${!String(look.refundPolicy ?? "").trim() && html`<p class="alert warn">Sans politique, la billetterie affiche seulement « selon la politique de l'organisateur » et vos coordonnées.</p>`}
        <h3>ALKAO</h3>
        <label class="check"><input type="checkbox" disabled=${!canEdit} checked=${Boolean(look.showOnAlkao)}
          onChange=${(e) => set({ showOnAlkao: e.target.checked })} />
          Afficher mes événements sur ALKAO</label>
        <p class="muted">Désactivé par défaut. Quand cette option est activée, seuls vos événements publiés, actuellement en vente et avec des places disponibles peuvent apparaître sur la page publique d’ALKAO.</p>

        ${canEdit && html`<div class="row"><button type="submit" disabled=${!readable}>Enregistrer</button>
          ${f && html`<button type="button" class="secondary" onClick=${() => { setF(null); setMsg(null); }}>Annuler les changements</button>`}</div>`}
        ${msg && html`<p class="muted" role="status">${msg}</p>`}${error && html`<${Failure} error=${error} />`}
      </form>

      <section class="card look-preview" aria-label="Aperçu" style=${{ "--look-accent": accent, "--look-ink": onAccent }}>
        <h3>Aperçu</h3>
        <div class="look-phone">
          <div class="look-band">${logo ? html`<img src=${logo} alt=${brandName} onError=${() => setLogoBroken(true)} />` : html`<strong>${brandName}</strong>`}<span>EN</span></div>
          <div class="look-body">
            <p class="look-title">Votre événement</p>
            <div class="look-ticket"><div class="look-ticket-band"><strong>Admission générale</strong><span>Billet 1 sur 2</span></div>
              <div class="look-qr" aria-hidden="true"></div></div>
            <span class="look-button">Plein écran pour l'entrée</span>
            ${(look.websiteUrl || look.supportEmail || look.supportPhone || look.addressLine) && html`<p class="look-contact">
              ${[String(look.websiteUrl).replace(/^https:\/\//, "").replace(/\/$/, ""), look.supportEmail, look.supportPhone, look.addressLine].filter((x) => String(x).trim()).join(" · ")}</p>`}
          </div>
        </div>
        ${saved.updatedAt && html`<p class="muted">Dernière modification : ${when(saved.updatedAt)}</p>`}
      </section>
    </div>`;
}

function Brand() {
  return html`<div class="brand"><span class="mark" aria-hidden="true">A</span>
    <span><span class="name">ALKAO</span><span class="sub">Billetterie · TAKATAK</span></span></div>`;
}

const TABS = [["dashboard", "Tableau de bord"], ["events", "Événements"], ["venues", "Lieux"], ["orders", "Commandes"], ["scanner", "Scanner"], ["payments", "Paiements"], ["appearance", "Apparence"]];
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
    : page === "event" ? html`<${EventDetail} api=${api} base=${base} eventId=${route.id} assistant=${status.data?.assistant} />`
    : page === "venues" ? html`<${Venues} api=${api} base=${base} />`
    : page === "orders" ? html`<${Orders} api=${api} base=${base} prefix=${prefix} />`
    : page === "order" ? html`<${OrderDetail} api=${api} base=${base} orderId=${route.id} role=${status.data?.role} me=${me} />`
    : page === "journal" ? html`<${Journal} api=${api} base=${base} prefix=${prefix} me=${me} />`
    : page === "scanner" ? html`<${Scanner} api=${api} base=${base} />`
    : page === "payments" ? html`<${Payments} api=${api} base=${base} />`
    : page === "appearance" ? html`<${Appearance} api=${api} base=${base} role=${status.data?.role} />`
    : page === "customers" ? html`<${Customers} api=${api} base=${base} prefix=${prefix} role=${status.data?.role} />`
    : page === "customer" ? html`<${CustomerDetail} api=${api} base=${base} customerId=${route.id} role=${status.data?.role} />`
    : page === "campaigns" ? html`<${Campaigns} api=${api} base=${base} prefix=${prefix} />`
    : page === "campaign" ? html`<${CampaignEditor} key=${route.id ?? "new"} api=${api} base=${base} prefix=${prefix} campaignId=${route.id ?? null} assistant=${status.data?.assistant} />`
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
