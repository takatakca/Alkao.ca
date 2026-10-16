// ALKAO Operations — offline gate scanning (Run 09).
// The device downloads the session's scanner manifest (alkao.scanner.v1). Without a network it
// checks each QR code itself:
//   1. the ALK1 format;
//   2. the key id against the manifest;
//   3. the Ed25519 signature (WebCrypto);
//   4. revocation, admission on this device, and the gate window.
// Only locally admitted tickets are queued for online reconciliation. A QR rejected
// offline MUST NOT become an unattended admission just because connectivity returns.
// The server stays the
// authority: a ticket admitted at two offline gates is reported as a conflict after the sync.
const PAYLOAD_RE = /^ALK1\.(k[0-9a-z]{10})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{86})$/;
const KEY = (sessionId) => `alkao.ops.offline.${sessionId}`;
const INCIDENT_KEY = (sessionId) => `alkao.ops.incidents.${sessionId}`;

// Incidents are locally retained after leaving offline mode. They contain only
// the public credential identifier and server outcome, never the signed QR
// payload, email, buyer identity, authentication token or signing key.
export function loadIncidentReport(sessionId) {
  const raw = localStorage.getItem(INCIDENT_KEY(sessionId));
  if (!raw) return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error("offline_incident_report_corrupt"); }
  if (!Array.isArray(parsed) || parsed.some((v) =>
    !v || typeof v.id !== "string" || typeof v.result !== "string" ||
    typeof v.reconciledAt !== "string"))
    throw new Error("offline_incident_report_corrupt");
  return parsed;
}

/** Caller holds the same Web Lock as the offline audit and must not delete
 * that audit unless the write succeeds. A malformed existing report is never
 * silently overwritten. Repeat archiving is idempotent across failed exits.
 */
export function archiveOfflineIncidents(sessionId, store, now = Date.now()) {
  const existing = loadIncidentReport(sessionId);
  const current = Array.isArray(store?.incidents) ? store.incidents : [];
  const missing = Math.max(0, (store?.conflicts || 0) - current.length);
  const legacy = missing ? [{
    id: `legacy-${sessionId}-${store.downloadedAt}`,
    qrId: "", result: "legacy_unspecified", scannedAt: "",
    reconciledAt: new Date(now).toISOString(), count: missing,
  }] : [];
  const ids = new Set(existing.map((e) => e.id));
  const combined = [...existing];
  for (const item of [...current, ...legacy]) {
    if (ids.has(item.id)) continue;
    ids.add(item.id);
    combined.push(item);
  }
  if (combined.length !== existing.length)
    localStorage.setItem(INCIDENT_KEY(sessionId), JSON.stringify(combined));
  return combined;
}

/** CSV export contains no signed QR or buyer PII. Escape CSV formula inputs
 * even though all recorded qrIds/outcomes are already constrained.
 */
export function incidentReportCsv(incidents) {
  const esc = (value) => {
    const raw = String(value ?? "");
    const safe = /^[=+@\-\t\r]/.test(raw) ? "'" + raw : raw;
    return '"' + safe.replaceAll('"', '""') + '"';
  };
  const header = ["Credential ID", "Server result", "Offline scanned at", "Reconciled at", "Count"];
  const rows = incidents.map((r) => [r.qrId, r.result, r.scannedAt, r.reconciledAt, r.count ?? 1]);
  return [header, ...rows].map((r) => r.map(esc).join(",")).join("\r\n") + "\r\n";
}


// Serialize local scanner operations so an async network sync cannot overwrite
// an admission scanned while the HTTP request was in flight. Queue continues
// after a failed request; operations in one Operations tab remain FIFO.
/** Protect the per-session localStorage audit across multiple browser tabs.
 * Web Locks are origin-scoped and held across an async HTTP batch, not just
 * around the final write. Never grant NEW offline admissions without a lock.
 * Recovery mode is only for uploading already recorded entries or safe exit
 * from a preexisting queue on browsers that lost Web Locks support.
 */
export async function withOfflineSessionLock(sessionId, operation, { recovery = false } = {}) {
  const manager = globalThis.navigator?.locks;
  if (typeof manager?.request !== "function") {
    if (recovery) return operation();
    throw new Error("offline_lock_unavailable");
  }
  return manager.request(`alkao.ops.offline.audit.${sessionId}`, { mode: "exclusive" }, operation);
}

export function createOfflineCoordinator() {
  let previous = Promise.resolve();
  return (operation) => {
    const current = previous.then(operation, operation);
    previous = current.catch(() => {});
    return current;
  };
}

const b64u = (s) => {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};

// A stored list is dropped 24 h after its gates close, once everything is synced: a lost
// device does not keep a session's credential list forever.
const KEEP_AFTER_CLOSE_MS = 24 * 3600_000;
export function loadOffline(sessionId, now = Date.now()) {
  let store = null;
  try { store = JSON.parse(localStorage.getItem(KEY(sessionId)) ?? "null"); } catch { return null; }
  const closesAt = Date.parse(store?.manifest?.session?.admission?.closesAt ?? "");
  if (store && store.queue.length === 0 && Number.isFinite(closesAt) && now > closesAt + KEEP_AFTER_CLOSE_MS) {
    // A reconciliation discrepancy remains important even when the temporary
    // scan manifest passes its retention window. Archive before deleting.
    // If archiving cannot persist, fail closed and keep the original audit.
    if (store.conflicts > 0) archiveOfflineIncidents(sessionId, store, now);
    localStorage.removeItem(KEY(sessionId));
    return null;
  }
  return store;
}
export function saveOffline(sessionId, store) {
  if (store) localStorage.setItem(KEY(sessionId), JSON.stringify(store)); else localStorage.removeItem(KEY(sessionId));
}
export function newOfflineStore(manifest, now = Date.now()) {
  return { manifest, downloadedAt: now, localAdmitted: [], localEntered: [], queue: [], incidents: [], conflicts: 0, synced: 0 };
}

const keyCache = new Map();
async function verifySignature(publicKey, signed, signature) {
  if (!globalThis.crypto?.subtle) return null;
  try {
    let key = keyCache.get(publicKey);
    if (!key) {
      key = await crypto.subtle.importKey("raw", b64u(publicKey), { name: "Ed25519" }, false, ["verify"]);
      keyCache.set(publicKey, key);
    }
    return await crypto.subtle.verify({ name: "Ed25519" }, key, b64u(signature), new TextEncoder().encode(signed));
  } catch {
    return null; // Crypto not supported: never fall back to manifest-only admission.
  }
}

/** Check one QR code against the stored manifest, record it, and return the result. */
export async function offlineScan(store, raw, now = Date.now()) {
  // A manifest is a time-limited snapshot of revocations. A transferred QR
  // must NOT remain admissible from an older offline copy. Never queue/accept
  // a scan when validity cannot be proved; operator must reconnect/refresh.
  const validUntil = Date.parse(store?.manifest?.validUntil ?? "");
  if (!Number.isFinite(validUntil) || now >= validUntil)
    return { result: "manifest_expired" };
  const payload = raw.trim();
  const m = PAYLOAD_RE.exec(payload);
  if (!m) return { result: "malformed" };
  const [, kid, qrId, signature] = m;
  const key = store.manifest.keys.find((k) => k.kid === kid);
  if (!key) return { result: "unknown_key" };
  // A matching id in a local manifest is NOT authentication. If the browser
  // cannot verify Ed25519, the operator must reconnect and use online scan.
  const verification = await verifySignature(key.publicKey, `ALK1.${kid}.${qrId}`, signature);
  if (verification !== true)
    return { result: verification === null ? "signature_unavailable" : "invalid_signature" };
  if (store.manifest.revoked.some((r) => r.qrId === qrId)) return { result: "revoked" };
  const credential = store.manifest.credentials.find((c) => c.qrId === qrId);
  if (!credential) return { result: "unknown_credential" };
  const ticket = { ticketTypeName: credential.ticketTypeName };
  if (store.localAdmitted.includes(qrId) || store.manifest.admitted.some((a) => a.qrId === qrId)) return { result: "already_admitted", ticket };
  const { opensAt, closesAt } = store.manifest.session.admission;
  if (now < Date.parse(opensAt)) return { result: "too_early", ticket };
  if (now > Date.parse(closesAt)) return { result: "too_late", ticket };
  store.localAdmitted.push(qrId);
  store.queue.push({ payload, scannedAt: new Date(now).toISOString(), admittedOffline: true });
  // Run 58: the order's options to hand over, once per order (also on this device).
  const bought = credential.purchase && store.manifest.purchases?.find((p) => p.ref === credential.purchase);
  if (!bought) return { result: "admitted", ticket };
  store.localEntered ??= [];
  const already = bought.entered || store.localEntered.includes(bought.ref);
  if (!already) store.localEntered.push(bought.ref);
  return { result: "admitted", ticket, options: { items: bought.items, already } };
}

/**
 * Reconcile actual offline admissions only (500 at a time). Never discard a
 * batch unless the server acknowledges every result in its original index.
 * A rejected offline entry is not an admission and must never be uploaded for
 * automatic admission once online. Divergent results require gate follow-up.
 */
const SERVER_SCAN_RESULTS = new Set([
  "admitted", "already_admitted", "revoked", "wrong_session", "too_early",
  "too_late", "unknown_credential", "invalid_signature", "unknown_key", "malformed",
]);
export async function syncOffline(store, send) {
  // Existing devices can have entries from older software which queued denied
  // scans. Never replay such QR payloads as fresh admissions on reconnect.
  store.queue = store.queue.filter((entry) => entry?.admittedOffline === true);
  while (store.queue.length > 0) {
    const batch = store.queue.slice(0, 500);
    let results;
    try {
      results = await send(batch.map(({ payload, scannedAt }) => ({ payload, scannedAt })));
    } catch {
      // Even HTTP 400/403 or a timeout may follow partial server processing.
      // Keep all entries until every one is explicitly acknowledged.
      return false;
    }
    if (!Array.isArray(results) || results.length !== batch.length ||
        results.some((r, i) => !r || r.index !== i || !SERVER_SCAN_RESULTS.has(r.result)))
      return false;
    // The scanner admitted these people offline, but the server is authoritative.
    // A revoked, already admitted, or otherwise denied ticket is an incident.
    store.incidents ??= [];
    for (let i = 0; i < results.length; i++) {
      if (batch[i]?.admittedOffline && results[i].result !== "admitted") {
        store.conflicts++;
        const original = batch[i];
        const qrId = PAYLOAD_RE.exec(original.payload)?.[2] ?? "";
        // Do not persist the signed QR; a bearer ticket must not end up in
        // an exported gate incident report.
        const scannedAt = Number.isFinite(Date.parse(original.scannedAt))
          ? new Date(original.scannedAt).toISOString() : "";
        const reconciledAt = new Date().toISOString();
        const id = `${qrId}:${scannedAt}:${results[i].result}`;
        store.incidents.push({ id, qrId, scannedAt, reconciledAt, result: results[i].result });
      }
    }
    store.synced += batch.length;
    store.queue.splice(0, batch.length);
  }
  return true;
}
