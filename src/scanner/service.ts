import { randomBytes } from "node:crypto";
import { writeAudit } from "../db/catalog.js";
import type { TenantScope } from "../db/commerce.js";
import * as creds from "../db/credentials.js";
import { withTransaction, type Db } from "../db/pool.js";
import { derivePrivateKey, publicKeyB64, signMessage, verifyMessage } from "../credentials/keys.js";
import { buildPayload, parsePayload, signedPart, uuidToB64 } from "../credentials/payload.js";
import { DomainError } from "../domain/errors.js";

export const MANIFEST_FORMAT = "alkao.scanner.v1";
export const MANIFEST_TTL_SECONDS = 10 * 60;
/** Device clocks may run ahead; offline scans dated further in the future are clamped. */
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

export type ScanResult =
  | "admitted"
  | "already_admitted"
  | "revoked"
  | "wrong_session"
  | "too_early"
  | "too_late"
  | "unknown_credential"
  | "invalid_signature"
  | "unknown_key"
  | "malformed";

export interface ScanOutcome {
  result: ScanResult;
  credentialId?: string;
  ticket?: { id: string; ticketTypeCode: string; ticketTypeName: string };
  admittedAt?: Date;
  admittedBy?: string | null;
  ticketSession?: { id: string };
}

export interface ScanInput {
  sessionId: string;
  payload: string;
  deviceId: string | null;
  /** Device time for offline scans; server time otherwise. */
  scannedAt?: Date | undefined;
  offline: boolean;
}

const newKid = () => `k${BigInt(`0x${randomBytes(8).toString("hex")}`).toString(36).padStart(10, "0").slice(-10)}`;

export class CredentialsService {
  constructor(private readonly deps: { db: Db; masterSecret: string | null; now: () => Date }) {}

  private secret(): string {
    if (!this.deps.masterSecret) throw new DomainError("credentials_not_configured");
    return this.deps.masterSecret;
  }

  get configured(): boolean {
    return Boolean(this.deps.masterSecret);
  }

  /** The Client's active signing key, created (version 1) on first use. */
  async ensureActiveKey(clientId: string): Promise<creds.KeyRow> {
    const secret = this.secret();
    const existing = await creds.getActiveKey(this.deps.db, clientId);
    if (existing) return existing;
    try {
      return await withTransaction(this.deps.db, async (tx) => {
        const version = await creds.nextKeyVersion(tx, clientId);
        const key = { kid: newKid(), clientId, version, publicKey: publicKeyB64(derivePrivateKey(secret, clientId, version)) };
        await creds.insertKey(tx, key);
        return { ...key, status: "active" as const };
      });
    } catch (error) {
      // A concurrent request created it first.
      const raced = await creds.getActiveKey(this.deps.db, clientId);
      if (raced) return raced;
      throw error;
    }
  }

  /** Start signing with a new key version. The old key keeps verifying existing QR codes. */
  async rotateKey(scope: TenantScope, actor: { type: "user"; id: string }): Promise<creds.KeyRow> {
    const secret = this.secret();
    return withTransaction(this.deps.db, async (tx) => {
      await tx.query(`SELECT 1 FROM public.ticketing_clients WHERE id = $1 FOR UPDATE`, [scope.clientId]);
      await creds.retireActiveKey(tx, scope.clientId);
      const version = await creds.nextKeyVersion(tx, scope.clientId);
      const key = { kid: newKid(), clientId: scope.clientId, version, publicKey: publicKeyB64(derivePrivateKey(secret, scope.clientId, version)) };
      await creds.insertKey(tx, key);
      await writeAudit(tx, scope, actor, "credentials.key_rotated", { type: "credential_key", id: key.kid }, { version });
      return { ...key, status: "active" as const };
    });
  }

  /** The QR payload for a credential, signed with the Client's active key. */
  async payloadFor(clientId: string, credentialId: string): Promise<string> {
    const key = await this.ensureActiveKey(clientId);
    const signature = signMessage(derivePrivateKey(this.secret(), clientId, key.version), signedPart(key.kid, credentialId));
    return buildPayload(key.kid, credentialId, signature);
  }

  /** ticketId → QR payload for an order's valid tickets (empty when not configured). */
  async payloadsForOrder(scope: TenantScope, orderId: string): Promise<Map<string, string>> {
    if (!this.configured) return new Map();
    const active = await creds.activeCredentialsForOrder(this.deps.db, scope, orderId);
    const out = new Map<string, string>();
    for (const [ticketId, credentialId] of active) out.set(ticketId, await this.payloadFor(scope.clientId, credentialId));
    return out;
  }

  async reissue(scope: TenantScope, ticketId: string, actor: { type: "user"; id: string }): Promise<{ credentialId: string; payload: string }> {
    this.secret();
    const credentialId = await withTransaction(this.deps.db, async (tx) => {
      const id = await creds.reissueCredential(tx, scope, ticketId);
      if (!id) throw new DomainError("ticket_not_found");
      await writeAudit(tx, scope, actor, "credentials.reissued", { type: "ticket", id: ticketId }, { credentialId: id });
      return id;
    });
    return { credentialId, payload: await this.payloadFor(scope.clientId, credentialId) };
  }

  /**
   * Everything a gate needs to verify QR codes offline for one session: trusted public keys,
   * the admission window, and which credentials are valid, already admitted, or revoked.
   */
  async manifest(scope: TenantScope, sessionId: string) {
    this.secret();
    await this.ensureActiveKey(scope.clientId);
    const session = await creds.getGateSession(this.deps.db, scope, sessionId);
    if (!session) throw new DomainError("session_not_found");
    const [keys, credentials] = await Promise.all([
      creds.verifyingKeys(this.deps.db, scope.clientId),
      creds.sessionCredentials(this.deps.db, scope, sessionId),
    ]);
    const now = this.deps.now();
    const entry = (c: { id: string }) => ({ id: c.id, qrId: uuidToB64(c.id) });
    return {
      format: MANIFEST_FORMAT,
      generatedAt: now,
      validUntil: new Date(now.getTime() + MANIFEST_TTL_SECONDS * 1000),
      session: {
        id: session.id,
        eventId: session.eventId,
        startsAt: session.startsAt,
        endsAt: session.endsAt,
        admission: { opensAt: session.opensAt, closesAt: session.closesAt },
      },
      keys: keys.map((k) => ({ kid: k.kid, algorithm: "Ed25519", publicKey: k.publicKey, status: k.status })),
      credentials: credentials
        .filter((c) => c.status === "active" && !c.admitted)
        .map((c) => ({ ...entry(c), ticketTypeCode: c.code, ticketTypeName: c.name })),
      admitted: credentials.filter((c) => c.admitted).map(entry),
      revoked: credentials.filter((c) => c.status === "revoked" && !c.admitted).map(entry),
    };
  }

  /** Verify one QR code at a gate and admit the ticket at most once. Every attempt is logged. */
  async scan(scope: TenantScope, input: ScanInput, scannedBy: string): Promise<ScanOutcome> {
    this.secret();
    const session = await creds.getGateSession(this.deps.db, scope, input.sessionId);
    if (!session) throw new DomainError("session_not_found");
    const now = this.deps.now();
    const at = input.scannedAt && input.scannedAt.getTime() < now.getTime() + MAX_CLOCK_SKEW_MS ? input.scannedAt : now;

    return withTransaction(this.deps.db, async (tx) => {
      const log = (result: ScanResult, credentialId: string | null = null, ticketId: string | null = null) =>
        creds.insertScan(tx, {
          ...scope,
          eventId: session.eventId,
          sessionId: session.id,
          credentialId,
          ticketId,
          result,
          deviceId: input.deviceId,
          scannedBy,
          scannedAt: at,
          offline: input.offline,
        });

      const parsed = parsePayload(input.payload);
      if (!parsed) {
        await log("malformed");
        return { result: "malformed" };
      }
      const key = await creds.getKey(tx, parsed.kid);
      // A key from another Client never verifies here, even if the QR is genuine elsewhere.
      if (!key || key.clientId !== scope.clientId || key.status === "revoked") {
        await log("unknown_key");
        return { result: "unknown_key" };
      }
      if (!verifyMessage(key.publicKey, parsed.signedMessage, parsed.signature)) {
        await log("invalid_signature");
        return { result: "invalid_signature" };
      }
      const credential = await creds.getCredential(tx, scope, parsed.credentialId);
      if (!credential) {
        await log("unknown_credential");
        return { result: "unknown_credential" };
      }
      const ticket = { id: credential.ticketId, ticketTypeCode: credential.ticketTypeCode, ticketTypeName: credential.ticketTypeName };
      const base = { credentialId: credential.id, ticket };
      const decide = async (result: ScanResult, extra: Partial<ScanOutcome> = {}): Promise<ScanOutcome> => {
        await log(result, credential.id, credential.ticketId);
        return { result, ...base, ...extra };
      };

      if (credential.status === "revoked") return decide("revoked");
      if (credential.sessionId !== session.id) return decide("wrong_session", { ticketSession: { id: credential.sessionId } });

      const previous = await creds.findAdmission(tx, credential.ticketId);
      if (previous) return decide("already_admitted", { admittedAt: previous.scannedAt, admittedBy: previous.deviceId });
      if (at < session.opensAt) return decide("too_early");
      if (at > session.closesAt) return decide("too_late");

      await tx.query("SAVEPOINT admit");
      try {
        await log("admitted", credential.id, credential.ticketId);
        await tx.query("RELEASE SAVEPOINT admit");
        return { result: "admitted", ...base, admittedAt: at };
      } catch (error) {
        await tx.query("ROLLBACK TO SAVEPOINT admit");
        if ((error as { constraint?: string }).constraint !== "ticketing_scans_one_admission") throw error;
        const winner = await creds.findAdmission(tx, credential.ticketId);
        return decide("already_admitted", { admittedAt: winner?.scannedAt, admittedBy: winner?.deviceId ?? null });
      }
    });
  }

  /** Upload scans recorded offline, in device-time order. The first admission wins. */
  async scanBatch(
    scope: TenantScope,
    input: { sessionId: string; deviceId: string; scans: { payload: string; scannedAt: Date }[] },
    scannedBy: string,
  ): Promise<(ScanOutcome & { index: number })[]> {
    const ordered = input.scans.map((s, index) => ({ ...s, index })).sort((a, b) => a.scannedAt.getTime() - b.scannedAt.getTime());
    const results: (ScanOutcome & { index: number })[] = [];
    for (const s of ordered) {
      const outcome = await this.scan(
        scope,
        { sessionId: input.sessionId, payload: s.payload, deviceId: input.deviceId, scannedAt: s.scannedAt, offline: true },
        scannedBy,
      );
      results.push({ index: s.index, ...outcome });
    }
    return results.sort((a, b) => a.index - b.index);
  }
}
