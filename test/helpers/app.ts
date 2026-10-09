import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { createSupabaseJwtVerifier } from "../../src/api/auth.js";
import { createApp, type AppDeps } from "../../src/api/app.js";
import { signControlPayload } from "../../src/api/control-signature.js";
import { CONTROL_CONTRACT_VERSION } from "../../src/contracts/control-v1.js";
import type { Db } from "../../src/db/pool.js";

export const JWT_SECRET = "test-only-jwt-secret-0123456789abcdef0123456789";
export const CONTROL_KEY_ID = "takatak-test";
export const CONTROL_SECRET = "test-only-control-secret-0123456789abcdef";

export function testApp(db: Db, overrides: Partial<AppDeps> = {}) {
  return createApp({
    db,
    auth: createSupabaseJwtVerifier({ secret: JWT_SECRET }),
    operationalApiEnabled: true,
    controlKeys: new Map([[CONTROL_KEY_ID, CONTROL_SECRET]]),
    holdTtlSeconds: 600,
    publicHoldsPerMinute: 1000,
    ...overrides,
  });
}

export type TestApp = ReturnType<typeof testApp>;

/**
 * Stops a test server at once. close() alone waits for every open connection, and Chromium
 * opens sockets ahead of time that never send a request: Node keeps those until its 60 s
 * header timeout, longer than a test hook may take.
 */
export function stopServer(server: { close(done: () => void): unknown; closeAllConnections?(): void } | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

export async function tokenFor(userId: string, opts: { secret?: string; role?: string; expiresIn?: string } = {}) {
  return new SignJWT({ role: opts.role ?? "authenticated" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? "5m")
    .sign(new TextEncoder().encode(opts.secret ?? JWT_SECRET));
}

export async function call(app: TestApp, method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await app.request(path, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

export const pub = (clientId: string, brandId: string) => `/v1/public/clients/${clientId}/brands/${brandId}`;
export const adm = (clientId: string, brandId: string) => `/v1/admin/clients/${clientId}/brands/${brandId}`;

/** Build and sign a control event exactly as TAKATAK would. */
export function controlRequest(type: string, data: Record<string, unknown>, opts: { eventId?: string; timestamp?: number; secret?: string; keyId?: string } = {}) {
  const body = JSON.stringify({
    contract: CONTROL_CONTRACT_VERSION,
    eventId: opts.eventId ?? randomUUID(),
    issuedAt: new Date().toISOString(),
    type,
    data,
  });
  const ts = opts.timestamp ?? Math.floor(Date.now() / 1000);
  return {
    body,
    headers: {
      "content-type": "application/json",
      "x-alkao-key-id": opts.keyId ?? CONTROL_KEY_ID,
      "x-alkao-timestamp": String(ts),
      "x-alkao-signature": signControlPayload(opts.secret ?? CONTROL_SECRET, ts, body),
    },
  };
}

export async function sendControl(app: TestApp, req: ReturnType<typeof controlRequest>) {
  return call(app, "POST", "/v1/control/events", { body: req.body, headers: req.headers });
}
