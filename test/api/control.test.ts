import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { signControlPayload } from "../../src/api/control-signature.js";
import { adm, call, CONTROL_KEY_ID, CONTROL_SECRET, controlRequest, pub, sendControl, testApp, tokenFor, type TestApp } from "../helpers/app.js";

let db: TestDatabase;
let app: TestApp;

beforeAll(async () => {
  db = await createTestDatabase();
  app = testApp(db.pool);
});

afterAll(async () => {
  await db?.drop();
});

const client = (clientId: string, version: number, extra: Record<string, unknown> = {}) =>
  controlRequest("client.upserted", {
    clientId,
    name: "Havana Resort",
    status: "active",
    commission: { rateBps: 500, fixedCentsPerPaidAdmission: 50 },
    version,
    ...extra,
  });

describe("control contract authentication", () => {
  it("rejects missing, unknown-key, wrong-secret, tampered and replayed deliveries", async () => {
    const good = client(randomUUID(), 1);
    expect((await call(app, "POST", "/v1/control/events", { body: good.body })).body.error).toEqual({
      code: "invalid_signature",
      details: { reason: "missing_headers" },
    });
    const unknown = client(randomUUID(), 1);
    expect((await sendControl(app, { ...unknown, headers: { ...unknown.headers, "x-alkao-key-id": "nope" } })).body.error.details.reason).toBe("unknown_key");
    const wrongSecret = controlRequest("client.upserted", {}, { secret: "x".repeat(40) });
    expect((await sendControl(app, wrongSecret)).body.error.details.reason).toBe("bad_signature");
    const tampered = { ...good, body: good.body.replace("Havana Resort", "Evil Corp") };
    expect((await sendControl(app, tampered)).body.error.details.reason).toBe("bad_signature");
    const old = controlRequest("client.upserted", {}, { timestamp: Math.floor(Date.now() / 1000) - 3600 });
    expect((await sendControl(app, old)).body.error.details.reason).toBe("stale_timestamp");
  });

  it("is disabled when no control key is configured", async () => {
    const unconfigured = testApp(db.pool, { controlKeys: new Map() });
    expect((await sendControl(unconfigured, client(randomUUID(), 1))).status).toBe(503);
  });

  it("validates the payload against alkao.control.v1", async () => {
    const res = await sendControl(app, controlRequest("client.upserted", { clientId: "not-a-uuid", version: 1 }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_request");
    const unknownType = await sendControl(app, controlRequest("client.deleted", { clientId: randomUUID(), version: 1 }));
    expect(unknownType.status).toBe(400);
  });
});

describe("control contract application", () => {
  it("applies once per event id, ignores stale versions", async () => {
    const clientId = randomUUID();
    const first = client(clientId, 5);
    expect((await sendControl(app, first)).body.outcome).toBe("applied");
    expect((await sendControl(app, first)).body.outcome).toBe("duplicate");
    expect((await sendControl(app, client(clientId, 4, { name: "Old name" }))).body.outcome).toBe("stale");
    expect((await sendControl(app, client(clientId, 6, { name: "Havana Resort & Spa" }))).body.outcome).toBe("applied");
    const { rows } = await db.pool.query(`SELECT name, master_version, commission_rate_bps FROM public.ticketing_clients WHERE id = $1`, [clientId]);
    expect(rows[0]).toEqual({ name: "Havana Resort & Spa", master_version: 6, commission_rate_bps: 500 });
  });

  it("refuses records for unknown Clients and Brands moving between Clients, without consuming the event", async () => {
    const clientId = randomUUID();
    const brandId = randomUUID();
    const orphan = controlRequest("brand.upserted", { clientId, brandId, name: "FESTI-ICE", status: "active", version: 1 });
    expect((await sendControl(app, orphan)).body.error.code).toBe("unknown_client");
    await sendControl(app, client(clientId, 1));
    expect((await sendControl(app, orphan)).body.outcome).toBe("applied"); // same event id, now accepted

    const otherClient = randomUUID();
    await sendControl(app, client(otherClient, 1));
    const move = controlRequest("brand.upserted", { clientId: otherClient, brandId, name: "FESTI-ICE", status: "active", version: 2 });
    expect((await sendControl(app, move)).body.error.code).toBe("brand_client_mismatch");
    const wrongPair = controlRequest("entitlement.updated", { clientId: otherClient, brandId, status: "active", version: 1 });
    expect((await sendControl(app, wrongPair)).body.error.code).toBe("brand_client_mismatch");
  });

  it("a removed membership cannot be resurrected by an older upsert", async () => {
    const clientId = randomUUID();
    const userId = randomUUID();
    await sendControl(app, client(clientId, 1));
    await sendControl(app, controlRequest("membership.upserted", { clientId, userId, role: "manager", status: "active", version: 1 }));
    await sendControl(app, controlRequest("membership.removed", { clientId, userId, version: 3 }));
    const late = await sendControl(app, controlRequest("membership.upserted", { clientId, userId, role: "owner", status: "active", version: 2 }));
    expect(late.body.outcome).toBe("stale");
    const { rows } = await db.pool.query(`SELECT role, status FROM public.ticketing_memberships WHERE client_id = $1 AND user_id = $2`, [clientId, userId]);
    expect(rows[0]).toEqual({ role: "manager", status: "suspended" });
  });

  it("drives Ticketing end to end: off until TAKATAK grants the entitlement, off again when revoked", async () => {
    const clientId = randomUUID();
    const brandId = randomUUID();
    const ownerId = randomUUID();
    await sendControl(app, client(clientId, 1));
    await sendControl(app, controlRequest("brand.upserted", { clientId, brandId, name: "FESTI-ICE", status: "active", version: 1 }));
    await sendControl(app, controlRequest("membership.upserted", { clientId, userId: ownerId, role: "owner", status: "active", version: 1 }));
    const token = await tokenFor(ownerId);

    expect((await call(app, "GET", `${pub(clientId, brandId)}/events`)).status).toBe(404);
    expect((await call(app, "GET", `${adm(clientId, brandId)}/status`, { token })).body.ticketing).toEqual({ active: false, reason: "no_entitlement" });
    expect((await call(app, "GET", `${adm(clientId, brandId)}/venues`, { token })).status).toBe(403);

    await sendControl(app, controlRequest("entitlement.updated", { clientId, brandId, status: "active", version: 1 }));
    expect((await call(app, "GET", `${pub(clientId, brandId)}/events`)).body).toEqual({ events: [] });
    expect((await call(app, "GET", `${adm(clientId, brandId)}/venues`, { token })).status).toBe(200);

    await sendControl(app, controlRequest("entitlement.updated", { clientId, brandId, status: "suspended", version: 2 }));
    expect((await call(app, "GET", `${pub(clientId, brandId)}/events`)).status).toBe(404);
    expect((await call(app, "GET", `${adm(clientId, brandId)}/status`, { token })).body.ticketing).toEqual({ active: false, reason: "entitlement_inactive" });

    const { rows } = await db.pool.query(`SELECT action FROM public.ticketing_audit_log WHERE client_id = $1 ORDER BY id`, [clientId]);
    expect(rows.map((r) => r.action)).toEqual([
      "control.client_upserted",
      "control.brand_upserted",
      "control.membership_upserted",
      "control.entitlement_updated",
      "control.entitlement_updated",
    ]);
  });
});

describe("control state (reconciliation)", () => {
  const signedState = (body: Record<string, unknown>, secret?: string) => {
    const raw = JSON.stringify({ contract: "alkao.control.v1", ...body });
    const timestamp = Math.floor(Date.now() / 1000);
    return {
      body: raw,
      headers: {
        "x-alkao-key-id": CONTROL_KEY_ID,
        "x-alkao-timestamp": String(timestamp),
        "x-alkao-signature": signControlPayload(secret ?? CONTROL_SECRET, timestamp, raw),
      },
    };
  };
  const state = (body: Record<string, unknown>, secret?: string) => {
    const r = signedState(body, secret);
    return call(app, "POST", "/v1/control/state", { body: r.body, headers: r.headers });
  };

  it("returns what ALKAO holds, with versions, only to a signed caller", async () => {
    const clientId = randomUUID();
    const brandId = randomUUID();
    const userId = randomUUID();
    await sendControl(app, client(clientId, 10));
    await sendControl(app, controlRequest("brand.upserted", { clientId, brandId, name: "Havana Resort", status: "active", version: 11 }));
    await sendControl(app, controlRequest("membership.upserted", { clientId, userId, role: "manager", status: "active", version: 12 }));
    await sendControl(app, controlRequest("entitlement.updated", { clientId, brandId, status: "active", version: 13 }));

    const res = await state({ clientIds: [clientId] });
    expect(res.status).toBe(200);
    expect(res.body.clients).toEqual([
      {
        clientId, name: "Havana Resort", status: "active", timezone: "America/Toronto",
        commission: { rateBps: 500, fixedCentsPerPaidAdmission: 50 }, version: 10,
        brands: [{ brandId, name: "Havana Resort", status: "active", version: 11, entitlement: { status: "active", validFrom: null, validUntil: null, version: 13 } }],
        members: [{ userId, role: "manager", status: "active", version: 12 }],
      },
    ]);
    const all = await state({});
    expect(all.body.clients.map((c: { clientId: string }) => c.clientId)).toContain(clientId);

    expect((await call(app, "POST", "/v1/control/state", { body: JSON.stringify({ contract: "alkao.control.v1" }) })).status).toBe(401);
    expect((await state({}, "y".repeat(40))).status).toBe(401);
    expect((await state({ clientIds: ["nope"] })).status).toBe(400);
  });
});
