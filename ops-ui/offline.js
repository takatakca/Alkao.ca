// ALKAO Operations — offline gate scanning (Run 09).
// The device downloads the session's scanner manifest (alkao.scanner.v1). Without a network it
// checks each QR code itself:
//   1. the ALK1 format;
//   2. the key id against the manifest;
//   3. the Ed25519 signature (WebCrypto);
//   4. revocation, admission on this device, and the gate window.
// Every attempt is queued and sent to the batch endpoint once back online. The server stays the
// authority: a ticket admitted at two offline gates is reported as a conflict after the sync.
const PAYLOAD_RE = /^ALK1\.(k[0-9a-z]{10})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{86})$/;
const KEY = (sessionId) => `alkao.ops.offline.${sessionId}`;

const b64u = (s) => {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};

export function loadOffline(sessionId) {
  try { return JSON.parse(localStorage.getItem(KEY(sessionId)) ?? "null"); } catch { return null; }
}
export function saveOffline(sessionId, store) {
  if (store) localStorage.setItem(KEY(sessionId), JSON.stringify(store)); else localStorage.removeItem(KEY(sessionId));
}
export function newOfflineStore(manifest, now = Date.now()) {
  return { manifest, downloadedAt: now, localAdmitted: [], queue: [], conflicts: 0, synced: 0 };
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
    return null; // Ed25519 not supported by this browser: rely on the manifest list alone.
  }
}

/** Check one QR code against the stored manifest, record it, and return the result. */
export async function offlineScan(store, raw, now = Date.now()) {
  const payload = raw.trim();
  store.queue.push({ payload, scannedAt: new Date(now).toISOString() });
  const m = PAYLOAD_RE.exec(payload);
  if (!m) return { result: "malformed" };
  const [, kid, qrId, signature] = m;
  const key = store.manifest.keys.find((k) => k.kid === kid);
  if (!key) return { result: "unknown_key" };
  if ((await verifySignature(key.publicKey, `ALK1.${kid}.${qrId}`, signature)) === false) return { result: "invalid_signature" };
  if (store.manifest.revoked.some((r) => r.qrId === qrId)) return { result: "revoked" };
  const credential = store.manifest.credentials.find((c) => c.qrId === qrId);
  if (!credential) return { result: "unknown_credential" };
  const ticket = { ticketTypeName: credential.ticketTypeName };
  if (store.localAdmitted.includes(qrId) || store.manifest.admitted.some((a) => a.qrId === qrId)) return { result: "already_admitted", ticket };
  const { opensAt, closesAt } = store.manifest.session.admission;
  if (now < Date.parse(opensAt)) return { result: "too_early", ticket };
  if (now > Date.parse(closesAt)) return { result: "too_late", ticket };
  store.localAdmitted.push(qrId);
  store.queue[store.queue.length - 1].admittedOffline = true;
  return { result: "admitted", ticket };
}

/**
 * Send queued scans (500 at a time). Returns false if the network is still down. A scan
 * admitted offline that the server answers "already_admitted" was let in at another gate too.
 */
export async function syncOffline(store, send) {
  while (store.queue.length > 0) {
    const batch = store.queue.slice(0, 500);
    let results;
    try {
      results = await send(batch.map(({ payload, scannedAt }) => ({ payload, scannedAt })));
    } catch (error) {
      if (error?.status && error.status !== 401 && error.status < 500) store.queue.splice(0, batch.length);
      return false;
    }
    results.forEach((r, i) => { if (batch[i]?.admittedOffline && r.result === "already_admitted") store.conflicts++; });
    store.synced += batch.length;
    store.queue.splice(0, batch.length);
  }
  return true;
}
