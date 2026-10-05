import type { TenantScope } from "./commerce.js";
import type { Db, Tx } from "./pool.js";

type Queryable = Db | Tx;

export interface KeyRow {
  kid: string;
  clientId: string;
  version: number;
  publicKey: string;
  status: "active" | "retired" | "revoked";
}

function keyRow(r: { kid: string; client_id: string; version: number; public_key: string; status: KeyRow["status"] }): KeyRow {
  return { kid: r.kid, clientId: r.client_id, version: r.version, publicKey: r.public_key, status: r.status };
}

export async function getActiveKey(q: Queryable, clientId: string): Promise<KeyRow | null> {
  const { rows } = await q.query(
    `SELECT kid, client_id, version, public_key, status FROM public.ticketing_credential_keys WHERE client_id = $1 AND status = 'active'`,
    [clientId],
  );
  return rows[0] ? keyRow(rows[0]) : null;
}

export async function getKey(q: Queryable, kid: string): Promise<KeyRow | null> {
  const { rows } = await q.query(`SELECT kid, client_id, version, public_key, status FROM public.ticketing_credential_keys WHERE kid = $1`, [kid]);
  return rows[0] ? keyRow(rows[0]) : null;
}

/** Keys a scanner must trust for this Client: the active one and retired ones still in circulation. */
export async function verifyingKeys(q: Queryable, clientId: string): Promise<KeyRow[]> {
  const { rows } = await q.query(
    `SELECT kid, client_id, version, public_key, status FROM public.ticketing_credential_keys
     WHERE client_id = $1 AND status IN ('active', 'retired') ORDER BY version DESC`,
    [clientId],
  );
  return rows.map(keyRow);
}

export async function nextKeyVersion(q: Queryable, clientId: string): Promise<number> {
  const { rows } = await q.query<{ v: number }>(`SELECT coalesce(max(version), 0) + 1 AS v FROM public.ticketing_credential_keys WHERE client_id = $1`, [clientId]);
  return rows[0]!.v;
}

export async function insertKey(q: Queryable, k: { kid: string; clientId: string; version: number; publicKey: string }): Promise<void> {
  await q.query(
    `INSERT INTO public.ticketing_credential_keys (kid, client_id, version, public_key) VALUES ($1, $2, $3, $4)`,
    [k.kid, k.clientId, k.version, k.publicKey],
  );
}

export async function retireActiveKey(tx: Tx, clientId: string): Promise<void> {
  await tx.query(`UPDATE public.ticketing_credential_keys SET status = 'retired', retired_at = now() WHERE client_id = $1 AND status = 'active'`, [clientId]);
}

// ── Credentials ─────────────────────────────────────────────────────────────
export interface CredentialRow {
  id: string;
  ticketId: string;
  sessionId: string;
  eventId: string;
  status: "active" | "revoked";
  revokeReason: string | null;
  ticketTypeCode: string;
  ticketTypeName: string;
}

export async function getCredential(q: Queryable, s: TenantScope, credentialId: string): Promise<CredentialRow | null> {
  const { rows } = await q.query<{
    id: string; ticket_id: string; session_id: string; event_id: string; status: CredentialRow["status"]; revoke_reason: string | null; code: string; name: string;
  }>(
    `SELECT c.id, c.ticket_id, c.session_id, c.event_id, c.status, c.revoke_reason, tt.code, tt.name
     FROM public.ticketing_credentials c
     JOIN public.ticketing_tickets t ON t.id = c.ticket_id AND t.client_id = c.client_id AND t.brand_id = c.brand_id
     JOIN public.ticketing_ticket_types tt ON tt.id = t.ticket_type_id AND tt.client_id = t.client_id AND tt.brand_id = t.brand_id
     WHERE c.id = $1 AND c.client_id = $2 AND c.brand_id = $3`,
    [credentialId, s.clientId, s.brandId],
  );
  const r = rows[0];
  return r
    ? { id: r.id, ticketId: r.ticket_id, sessionId: r.session_id, eventId: r.event_id, status: r.status, revokeReason: r.revoke_reason, ticketTypeCode: r.code, ticketTypeName: r.name }
    : null;
}

/** Active credential per valid ticket of an order. */
export async function activeCredentialsForOrder(q: Queryable, s: TenantScope, orderId: string): Promise<Map<string, string>> {
  const { rows } = await q.query<{ ticket_id: string; id: string }>(
    `SELECT c.ticket_id, c.id FROM public.ticketing_credentials c
     JOIN public.ticketing_tickets t ON t.id = c.ticket_id AND t.client_id = c.client_id AND t.brand_id = c.brand_id
     WHERE t.order_id = $1 AND c.client_id = $2 AND c.brand_id = $3 AND c.status = 'active' AND t.status = 'valid'`,
    [orderId, s.clientId, s.brandId],
  );
  return new Map(rows.map((r) => [r.ticket_id, r.id]));
}

/** Revoke a ticket's active credential and issue a new one (lost phone, leaked screenshot). */
export async function reissueCredential(tx: Tx, s: TenantScope, ticketId: string): Promise<string | null> {
  const { rows: t } = await tx.query<{ status: string }>(
    `SELECT status FROM public.ticketing_tickets WHERE id = $1 AND client_id = $2 AND brand_id = $3 FOR UPDATE`,
    [ticketId, s.clientId, s.brandId],
  );
  if (!t[0] || t[0].status !== "valid") return null;
  await tx.query(
    `UPDATE public.ticketing_credentials SET status = 'revoked', revoke_reason = 'reissued', revoked_at = now()
     WHERE ticket_id = $1 AND status = 'active'`,
    [ticketId],
  );
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO public.ticketing_credentials (client_id, brand_id, event_id, session_id, ticket_id)
     SELECT client_id, brand_id, event_id, session_id, id FROM public.ticketing_tickets WHERE id = $1
     RETURNING id`,
    [ticketId],
  );
  return rows[0]!.id;
}

// ── Sessions as seen by a gate ──────────────────────────────────────────────
export interface GateSession {
  id: string;
  eventId: string;
  startsAt: Date;
  endsAt: Date | null;
  opensAt: Date;
  closesAt: Date;
}

export async function getGateSession(q: Queryable, s: TenantScope, sessionId: string): Promise<GateSession | null> {
  const { rows } = await q.query<{ id: string; event_id: string; starts_at: Date; ends_at: Date | null; opens_at: Date; closes_at: Date }>(
    `SELECT s.id, s.event_id, s.starts_at, s.ends_at,
            s.starts_at - make_interval(mins => e.admission_opens_before_minutes) AS opens_at,
            coalesce(s.ends_at, s.starts_at) + make_interval(mins => e.admission_closes_after_minutes) AS closes_at
     FROM public.ticketing_sessions s
     JOIN public.ticketing_events e ON e.id = s.event_id AND e.client_id = s.client_id AND e.brand_id = s.brand_id
     WHERE s.id = $1 AND s.client_id = $2 AND s.brand_id = $3`,
    [sessionId, s.clientId, s.brandId],
  );
  const r = rows[0];
  return r ? { id: r.id, eventId: r.event_id, startsAt: r.starts_at, endsAt: r.ends_at, opensAt: r.opens_at, closesAt: r.closes_at } : null;
}

export async function sessionCredentials(q: Queryable, s: TenantScope, sessionId: string) {
  // A credential's ticket is always in the credential's session (composite key): saying so
  // in the join lets the manifest read only this session's tickets (Run 18).
  const { rows } = await q.query<{ id: string; status: "active" | "revoked"; code: string; name: string; admitted: boolean }>(
    `SELECT c.id, c.status, tt.code, tt.name,
            EXISTS (SELECT 1 FROM public.ticketing_scans sc WHERE sc.ticket_id = c.ticket_id AND sc.result = 'admitted') AS admitted
     FROM public.ticketing_credentials c
     JOIN public.ticketing_tickets t ON t.id = c.ticket_id AND t.session_id = c.session_id AND t.client_id = c.client_id AND t.brand_id = c.brand_id
     JOIN public.ticketing_ticket_types tt ON tt.id = t.ticket_type_id AND tt.client_id = t.client_id AND tt.brand_id = t.brand_id
     WHERE c.session_id = $1 AND c.client_id = $2 AND c.brand_id = $3
     ORDER BY c.created_at, c.id`,
    [sessionId, s.clientId, s.brandId],
  );
  return rows;
}

// ── Scans ───────────────────────────────────────────────────────────────────
/** When each ticket of an order entered at the gate (Run 19: evidence for a dispute). */
export async function admissionsForOrder(q: Queryable, s: TenantScope, orderId: string): Promise<Map<string, Date>> {
  const { rows } = await q.query<{ ticket_id: string; scanned_at: Date }>(
    `SELECT sc.ticket_id, sc.scanned_at
     FROM public.ticketing_tickets t
     JOIN public.ticketing_scans sc ON sc.ticket_id = t.id AND sc.result = 'admitted'
     WHERE t.order_id = $1 AND t.client_id = $2 AND t.brand_id = $3`,
    [orderId, s.clientId, s.brandId],
  );
  return new Map(rows.map((r) => [r.ticket_id, r.scanned_at]));
}

export async function findAdmission(q: Queryable, ticketId: string): Promise<{ scannedAt: Date; deviceId: string | null } | null> {
  const { rows } = await q.query<{ scanned_at: Date; device_id: string | null }>(
    `SELECT scanned_at, device_id FROM public.ticketing_scans WHERE ticket_id = $1 AND result = 'admitted'`,
    [ticketId],
  );
  return rows[0] ? { scannedAt: rows[0].scanned_at, deviceId: rows[0].device_id } : null;
}

export async function insertScan(
  q: Queryable,
  s: TenantScope & {
    eventId: string;
    sessionId: string;
    credentialId: string | null;
    ticketId: string | null;
    result: string;
    deviceId: string | null;
    scannedBy: string;
    scannedAt: Date;
    offline: boolean;
  },
): Promise<void> {
  await q.query(
    `INSERT INTO public.ticketing_scans
       (client_id, brand_id, event_id, session_id, credential_id, ticket_id, result, device_id, scanned_by, scanned_at, offline)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [s.clientId, s.brandId, s.eventId, s.sessionId, s.credentialId, s.ticketId, s.result, s.deviceId, s.scannedBy, s.scannedAt, s.offline],
  );
}

export async function listScans(q: Queryable, s: TenantScope, sessionId: string, limit: number) {
  const { rows } = await q.query(
    `SELECT id, credential_id AS "credentialId", ticket_id AS "ticketId", result, device_id AS "deviceId",
            scanned_by AS "scannedBy", scanned_at AS "scannedAt", received_at AS "receivedAt", offline
     FROM public.ticketing_scans WHERE session_id = $1 AND client_id = $2 AND brand_id = $3
     ORDER BY received_at DESC, id DESC LIMIT $4`,
    [sessionId, s.clientId, s.brandId, limit],
  );
  return rows;
}
