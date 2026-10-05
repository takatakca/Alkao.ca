import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyMessage } from "../../src/credentials/keys.js";
import { parsePayload } from "../../src/credentials/payload.js";
import { adm, call, pub, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { seedTwoTenants, TEST_CREDENTIAL_SECRET, type SeedResult, type TenantFixture } from "../helpers/seed.js";

let db: TestDatabase;
let seed: SeedResult;
let app: TestApp;
let staff: string;
let owner: string;

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  app = testApp(db.pool, { credentialMasterSecret: TEST_CREDENTIAL_SECRET });
  staff = await tokenFor(seed.users.havanaStaff);
  owner = await tokenFor(seed.users.havanaOwner);
});

afterAll(async () => {
  await db?.drop();
});

const typeId = (t: TenantFixture, code: string) => t.types.find((x) => x.code === code)!.id;
const gate = (t: TenantFixture) => adm(t.clientId, t.brandId);

/** A session starting `startsInMinutes` from now (gates open 60 min before by default). */
async function session(t: TenantFixture, startsInMinutes: number) {
  const { rows } = await db.pool.query<{ id: string }>(
    `INSERT INTO public.ticketing_sessions (client_id, brand_id, event_id, starts_at, capacity, status)
     VALUES ($1, $2, $3, now() + make_interval(mins => $4) + (random() * interval '1 second'), 50, 'on_sale') RETURNING id`,
    [t.clientId, t.brandId, t.eventId, startsInMinutes],
  );
  return rows[0]!.id;
}

/** Free toddler tickets through the public flow; returns their QR payloads. */
async function tickets(t: TenantFixture, sessionId: string, count = 2, a: TestApp = app) {
  const h = await call(a, "POST", `${pub(t.clientId, t.brandId)}/holds`, {
    body: { sessionId, items: [{ ticketTypeId: typeId(t, "TODDLER"), quantity: count }] },
  });
  expect(h.status).toBe(201);
  const co = await call(a, "POST", `${pub(t.clientId, t.brandId)}/holds/${h.body.hold.id}/checkout`, {
    headers: { "x-alkao-hold-token": h.body.hold.token },
    body: { buyer: { email: "famille@example.com" }, successUrl: `${t.returnOrigin}/ok`, cancelUrl: `${t.returnOrigin}/ko` },
  });
  expect(co.body.order.status).toBe("paid");
  const order = await call(a, "GET", `${pub(t.clientId, t.brandId)}/orders/${co.body.order.id}`, {
    headers: { "x-alkao-order-token": co.body.order.token },
  });
  return {
    orderId: co.body.order.id as string,
    tickets: order.body.order.tickets as { id: string; status: string; credential: string | null }[],
  };
}

async function scan(t: TenantFixture, sessionId: string, payload: string, token = staff, deviceId = "gate-1") {
  const res = await call(app, "POST", `${gate(t)}/scanner/scans`, { token, body: { sessionId, payload, deviceId } });
  return res.body.scan ?? res.body;
}

describe("credentials on tickets", () => {
  it("every ticket gets a signed QR payload on the buyer's order page", async () => {
    const t = seed.havana;
    const sid = await session(t, 10);
    const { tickets: list } = await tickets(t, sid, 3);
    expect(list).toHaveLength(3);
    for (const ticket of list) expect(ticket.credential).toMatch(/^ALK1\.k[0-9a-z]{10}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{86}$/);
    expect(new Set(list.map((x) => x.credential)).size).toBe(3);
  });

  it("returns no payload while credentials are not configured", async () => {
    const t = seed.havana;
    const plain = testApp(db.pool);
    const { tickets: list } = await tickets(t, await session(t, 10), 1, plain);
    expect(list[0]!.credential).toBeNull();
    const res = await call(plain, "POST", `${gate(t)}/scanner/scans`, { token: staff, body: { sessionId: t.sessionId, payload: "x" } });
    expect(res).toEqual({ status: 503, body: { error: { code: "credentials_not_configured" } } });
  });
});

describe("gate scanning", () => {
  it("admits a ticket once; every later scan is already_admitted", async () => {
    const t = seed.havana;
    const sid = await session(t, 10);
    const { tickets: list } = await tickets(t, sid, 1);
    const first = await scan(t, sid, list[0]!.credential!);
    expect(first).toMatchObject({ result: "admitted", ticket: { id: list[0]!.id, ticketTypeCode: "TODDLER" } });
    const second = await scan(t, sid, list[0]!.credential!, staff, "gate-2");
    expect(second).toMatchObject({ result: "already_admitted", admittedBy: "gate-1" });
  });

  it("admits exactly once under concurrent scans at several gates", async () => {
    const t = seed.havana;
    const sid = await session(t, 10);
    const { tickets: list } = await tickets(t, sid, 1);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => scan(t, sid, list[0]!.credential!, staff, `gate-${i}`)));
    expect(results.filter((r) => r.result === "admitted")).toHaveLength(1);
    expect(results.filter((r) => r.result === "already_admitted")).toHaveLength(7);
  });

  it("refuses wrong sessions, early and late arrivals, forgeries and other Clients' tickets", async () => {
    const t = seed.havana;
    const now = await session(t, 10);
    const later = await session(t, 600);
    const past = await session(t, -300);
    const { tickets: forLater } = await tickets(t, later, 1);
    const { tickets: forNow } = await tickets(t, now, 1);
    const { tickets: forPast } = await tickets(t, past, 1).catch(() => ({ tickets: [] as { credential: string | null }[] }));
    expect(forPast).toEqual([]); // past sessions are not sellable

    expect((await scan(t, now, forLater[0]!.credential!)).result).toBe("wrong_session");
    expect((await scan(t, later, forLater[0]!.credential!)).result).toBe("too_early");

    const credential = forNow[0]!.credential!;
    const tampered = credential.slice(0, -3) + (credential.endsWith("AAA") ? "BBB" : "AAA");
    expect((await scan(t, now, tampered)).result).toBe("invalid_signature");
    expect((await scan(t, now, "https://example.com/not-a-ticket")).result).toBe("malformed");

    const f = seed.festi;
    const festiSession = await session(f, 10);
    const { tickets: festi } = await tickets(f, festiSession, 1);
    expect((await scan(t, now, festi[0]!.credential!)).result).toBe("unknown_key");

    // A session whose gates are closed.
    await db.pool.query(`UPDATE public.ticketing_events SET admission_closes_after_minutes = 0, admission_opens_before_minutes = 1440 WHERE id = $1`, [t.eventId]);
    try {
      const { rows } = await db.pool.query<{ id: string }>(
        `INSERT INTO public.ticketing_sessions (client_id, brand_id, event_id, starts_at, capacity, status)
         VALUES ($1, $2, $3, now() + interval '20 minutes', 10, 'on_sale') RETURNING id`,
        [t.clientId, t.brandId, t.eventId],
      );
      const { tickets: soon } = await tickets(t, rows[0]!.id, 1);
      await db.pool.query(`UPDATE public.ticketing_sessions SET starts_at = now() - interval '5 minutes' WHERE id = $1`, [rows[0]!.id]);
      expect((await scan(t, rows[0]!.id, soon[0]!.credential!)).result).toBe("too_late");
    } finally {
      await db.pool.query(`UPDATE public.ticketing_events SET admission_closes_after_minutes = 120, admission_opens_before_minutes = 60 WHERE id = $1`, [t.eventId]);
    }
  });

  it("refuses a refunded ticket and a reissued credential's old QR", async () => {
    const t = seed.havana;
    const sid = await session(t, 10);
    const { tickets: list } = await tickets(t, sid, 2);
    await db.pool.query(`UPDATE public.ticketing_tickets SET status = 'void', void_reason = 'refunded', voided_at = now() WHERE id = $1`, [list[0]!.id]);
    expect((await scan(t, sid, list[0]!.credential!)).result).toBe("revoked");

    const reissued = await call(app, "POST", `${gate(t)}/tickets/${list[1]!.id}/credential/reissue`, { token: owner });
    expect(reissued.status).toBe(201);
    expect((await scan(t, sid, list[1]!.credential!)).result).toBe("revoked");
    expect((await scan(t, sid, reissued.body.credential.payload)).result).toBe("admitted");
    // Admission is per ticket: no second entry with yet another credential.
    const again = await call(app, "POST", `${gate(t)}/tickets/${list[1]!.id}/credential/reissue`, { token: owner });
    expect((await scan(t, sid, again.body.credential.payload)).result).toBe("already_admitted");
    // Void tickets cannot be reissued.
    expect((await call(app, "POST", `${gate(t)}/tickets/${list[0]!.id}/credential/reissue`, { token: owner })).status).toBe(404);
  });

  it("keeps old QR codes valid across key rotation, until the old key is revoked", async () => {
    const f = seed.festi;
    const festiOwner = await tokenFor(seed.users.festiOwner);
    const sid = await session(f, 10);
    const { tickets: list } = await tickets(f, sid, 2);
    const oldKid = parsePayload(list[0]!.credential!)!.kid;

    const rotated = await call(app, "POST", `${gate(f)}/credential-keys/rotate`, { token: festiOwner });
    expect(rotated.status).toBe(201);
    expect(rotated.body.key.kid).not.toBe(oldKid);
    expect((await call(app, "POST", `${gate(f)}/credential-keys/rotate`, { token: await tokenFor(seed.users.both) })).status).toBe(403);

    expect((await scan(f, sid, list[0]!.credential!, festiOwner)).result).toBe("admitted");
    await db.pool.query(`UPDATE public.ticketing_credential_keys SET status = 'revoked' WHERE kid = $1`, [oldKid]);
    expect((await scan(f, sid, list[1]!.credential!, festiOwner)).result).toBe("unknown_key");
  });
});

describe("scanner manifest and offline gates", () => {
  it("gives a gate everything to verify offline: keys, window, valid, admitted and revoked credentials", async () => {
    const t = seed.havana;
    const sid = await session(t, 10);
    const { tickets: list } = await tickets(t, sid, 3);
    await scan(t, sid, list[0]!.credential!);
    await db.pool.query(`UPDATE public.ticketing_tickets SET status = 'void', void_reason = 'admin', voided_at = now() WHERE id = $1`, [list[1]!.id]);

    const res = await call(app, "GET", `${gate(t)}/sessions/${sid}/scanner-manifest`, { token: staff });
    expect(res.status).toBe(200);
    const m = res.body.manifest;
    expect(m.format).toBe("alkao.scanner.v1");
    expect(Date.parse(m.validUntil) - Date.parse(m.generatedAt)).toBe(10 * 60_000);
    expect(Date.parse(m.session.admission.opensAt)).toBe(Date.parse(m.session.startsAt) - 60 * 60_000);
    const ids = (xs: { qrId: string }[]) => xs.map((x) => x.qrId);
    const qr = (p: string) => p.split(".")[2];
    expect(ids(m.credentials)).toEqual([qr(list[2]!.credential!)]);
    expect(ids(m.admitted)).toEqual([qr(list[0]!.credential!)]);
    expect(ids(m.revoked)).toEqual([qr(list[1]!.credential!)]);

    // Offline verification with only the manifest.
    const parsed = parsePayload(list[2]!.credential!)!;
    const key = m.keys.find((k: { kid: string }) => k.kid === parsed.kid);
    expect(verifyMessage(key.publicKey, parsed.signedMessage, parsed.signature)).toBe(true);
    expect(JSON.stringify(m)).not.toMatch(/@example\.com|buyer|price/i);
  });

  it("syncs offline scans: device time order decides, the first admission wins", async () => {
    const t = seed.havana;
    const sid = await session(t, 10);
    const { tickets: list } = await tickets(t, sid, 2);
    const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
    const res = await call(app, "POST", `${gate(t)}/scanner/scans/batch`, {
      token: staff,
      body: {
        sessionId: sid,
        deviceId: "offline-gate",
        scans: [
          { payload: list[0]!.credential!, scannedAt: at(2) },
          { payload: list[0]!.credential!, scannedAt: at(5) },
          { payload: list[1]!.credential!, scannedAt: at(1) },
          { payload: "garbage", scannedAt: at(1) },
        ],
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.scans.map((s: { index: number; result: string }) => [s.index, s.result])).toEqual([
      [0, "already_admitted"],
      [1, "admitted"],
      [2, "admitted"],
      [3, "malformed"],
    ]);
    const log = await call(app, "GET", `${gate(t)}/sessions/${sid}/scans`, { token: staff });
    expect(log.body.scans).toHaveLength(4);
    expect(log.body.scans.every((s: { offline: boolean }) => s.offline)).toBe(true);
  });

  it("limits scanning to the Client's gate staff and above", async () => {
    const t = seed.havana;
    const sid = await session(t, 10);
    const viewer = await tokenFor(seed.users.both);
    const festiOwner = await tokenFor(seed.users.festiOwner);
    expect((await call(app, "GET", `${gate(t)}/sessions/${sid}/scanner-manifest`, { token: viewer })).status).toBe(403);
    expect((await call(app, "GET", `${gate(t)}/sessions/${sid}/scanner-manifest`, { token: festiOwner })).status).toBe(404);
    expect((await call(app, "GET", `${gate(seed.festi)}/sessions/${sid}/scanner-manifest`, { token: festiOwner })).body.error.code).toBe("session_not_found");
    expect((await call(app, "POST", `${gate(t)}/tickets/${randomUUID()}/credential/reissue`, { token: staff })).status).toBe(403);
  });
});

describe("database guarantees", () => {
  it("admits a ticket at most once and never edits the gate log", async () => {
    const t = seed.havana;
    const { rows } = await db.pool.query(`SELECT id, ticket_id FROM public.ticketing_credentials WHERE ticket_id = $1`, [t.ticketIds[1]]);
    const insert = () =>
      db.pool.query(
        `INSERT INTO public.ticketing_scans (client_id, brand_id, event_id, session_id, credential_id, ticket_id, result, scanned_by, scanned_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'admitted', $7, now())`,
        [t.clientId, t.brandId, t.eventId, t.sessionId, rows[0].id, rows[0].ticket_id, seed.users.havanaStaff],
      );
    await insert();
    await expect(insert()).rejects.toMatchObject({ code: "23505" });
    await expect(db.pool.query(`UPDATE public.ticketing_scans SET result = 'too_late'`)).rejects.toMatchObject({ code: "23514" });
    await expect(db.pool.query(`DELETE FROM public.ticketing_scans`)).rejects.toMatchObject({ code: "23514" });
  });

  it("gives every ticket exactly one active credential", async () => {
    const { rows } = await db.pool.query(
      `SELECT t.id FROM public.ticketing_tickets t
       WHERE t.status = 'valid' AND (SELECT count(*) FROM public.ticketing_credentials c WHERE c.ticket_id = t.id AND c.status = 'active') <> 1`,
    );
    expect(rows).toEqual([]);
  });
});
