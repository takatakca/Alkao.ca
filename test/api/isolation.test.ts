import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { FakeGateway } from "../helpers/fake-gateway.js";
import { seedTwoTenants, TEST_CREDENTIAL_SECRET, type SeedResult } from "../helpers/seed.js";

/**
 * Security sweep (Run 13): every admin route that takes an id is called by Havana's owner,
 * on Havana's own URL, with FESTI-ICE's ids, using a valid body so the request reaches the
 * database. None may succeed, and nothing of FESTI-ICE may change.
 */
let db: TestDatabase;
let seed: SeedResult;
let app: TestApp;

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  app = testApp(db.pool, { paymentGateway: new FakeGateway(), credentialMasterSecret: TEST_CREDENTIAL_SECRET, publicUrl: "https://billets.alkao.test" });
});

afterAll(async () => {
  await db?.drop();
});

async function festiSnapshot() {
  const c = seed.festi.clientId;
  const q = async (sql: string) => (await db.pool.query(sql, [c])).rows;
  return JSON.stringify({
    venues: await q(`SELECT id, name, updated_at FROM public.ticketing_venues WHERE client_id = $1 ORDER BY id`),
    events: await q(`SELECT id, title, status, updated_at FROM public.ticketing_events WHERE client_id = $1 ORDER BY id`),
    sessions: await q(`SELECT id, capacity, status, sold_count, reserved_count, updated_at FROM public.ticketing_sessions WHERE client_id = $1 ORDER BY id`),
    types: await q(`SELECT id, name, price_cents, updated_at FROM public.ticketing_ticket_types WHERE client_id = $1 ORDER BY id`),
    orders: await q(`SELECT id, status, refunded_cents FROM public.ticketing_orders WHERE client_id = $1 ORDER BY id`),
    tickets: await q(`SELECT id, status FROM public.ticketing_tickets WHERE client_id = $1 ORDER BY id`),
    refunds: await q(`SELECT id, status FROM public.ticketing_refunds WHERE client_id = $1 ORDER BY id`),
    credentials: await q(`SELECT id, status FROM public.ticketing_credentials WHERE client_id = $1 ORDER BY id`),
    scans: await q(`SELECT count(*)::int AS n FROM public.ticketing_scans WHERE client_id = $1`),
    emails: await q(`SELECT id, status FROM public.ticketing_email_outbox WHERE client_id = $1 ORDER BY id`),
    tokens: await q(`SELECT token_hash FROM public.ticketing_access_tokens WHERE client_id = $1 ORDER BY token_hash`),
    cancellations: await q(`SELECT id FROM public.ticketing_session_cancellations WHERE client_id = $1`),
    audit: await q(`SELECT count(*)::int AS n FROM public.ticketing_audit_log WHERE client_id = $1`),
  });
}

describe("tenant isolation sweep", () => {
  it("no admin route acts on another Client's records through its own URL", async () => {
    const h = seed.havana;
    const f = seed.festi;
    const { rows: refunds } = await db.pool.query<{ id: string }>(`SELECT id FROM public.ticketing_refunds WHERE client_id = $1 LIMIT 1`, [f.clientId]);
    const ids: Record<string, string> = {
      venueId: f.venueId, eventId: f.eventId, sessionId: f.sessionId, ticketTypeId: f.types[0]!.id,
      orderId: f.orderId, ticketId: f.ticketIds[0]!, refundId: refunds[0]!.id, holdId: f.holdId,
    };
    const bodies: Record<string, unknown> = {
      "PATCH /venues/:venueId": { name: "Pirate" },
      "PATCH /events/:eventId": { title: "Pirate" },
      "POST /events/:eventId/sessions": { startsAt: "2027-03-01T18:00:00Z", capacity: 10 },
      "PATCH /sessions/:sessionId": { capacity: 1 },
      "POST /events/:eventId/ticket-types": { code: "PIRATE", name: "Pirate", priceCents: 100, maxQuantity: 5 },
      "PATCH /ticket-types/:ticketTypeId": { name: "Pirate" },
      "POST /orders/:orderId/refunds": {},
      "POST /orders/:orderId/exchange": { sessionId: f.sessionId },
      "POST /sessions/:sessionId/cancel": { reason: "pirate" },
    };
    const owner = await tokenFor(seed.users.havanaOwner);
    const before = await festiSnapshot();
    const prefix = "/v1/admin/clients/:clientId/brands/:brandId";
    const seen = new Set<string>();
    const results: string[] = [];
    for (const r of app.routes) {
      if (r.method === "ALL" || !r.path.startsWith(prefix)) continue;
      const rest = r.path.slice(prefix.length);
      if (!/:[A-Za-z]+/.test(rest) || seen.has(`${r.method} ${rest}`)) continue;
      seen.add(`${r.method} ${rest}`);
      const path = `/v1/admin/clients/${h.clientId}/brands/${h.brandId}${rest.replace(/:([A-Za-z]+)/g, (_, name: string) => ids[name] ?? "00000000-0000-4000-8000-000000000000")}`;
      const key = `${r.method} ${rest}`;
      const res = await call(app, r.method, path, { token: owner, ...(r.method === "GET" ? {} : { body: bodies[key] ?? {} }) });
      results.push(`${key} → ${res.status}`);
      expect(res.status, `${key} answered ${res.status}: ${JSON.stringify(res.body)}`).toBeGreaterThanOrEqual(400);
      expect([400, 403, 404, 409, 422]).toContain(res.status);
    }
    expect(results.length).toBeGreaterThanOrEqual(20);
    expect(await festiSnapshot()).toBe(before);
  });

  it("no public route serves another Client's hold or order through its own URL", async () => {
    const h = seed.havana;
    const f = seed.festi;
    const base = `/v1/public/clients/${h.clientId}/brands/${h.brandId}`;
    const before = await festiSnapshot();
    for (const [method, path, header] of [
      ["GET", `${base}/holds/${f.holdId}`, "x-alkao-hold-token"],
      ["DELETE", `${base}/holds/${f.holdId}`, "x-alkao-hold-token"],
      ["GET", `${base}/orders/${f.orderId}`, "x-alkao-order-token"],
      ["POST", `${base}/orders/${f.orderId}/exchange`, "x-alkao-order-token"],
      ["GET", `${base}/events/${f.eventId}`, ""],
    ] as const) {
      const res = await call(app, method, path, { headers: header ? { [header]: "x".repeat(43) } : {}, ...(method === "POST" ? { body: { sessionId: f.sessionId } } : {}) });
      expect([403, 404, 409], `${method} ${path} → ${res.status}`).toContain(res.status);
    }
    expect(await festiSnapshot()).toBe(before);
  });
});

describe("request hardening", () => {
  it("refuses oversized bodies before parsing them", async () => {
    const h = seed.havana;
    const res = await call(app, "POST", `/v1/public/clients/${h.clientId}/brands/${h.brandId}/events/${h.eventId}/quote`, {
      body: JSON.stringify({ items: [], pad: "x".repeat(300 * 1024) }),
    });
    expect(res).toMatchObject({ status: 413, body: { error: { code: "payload_too_large" } } });
  });

  it("marks API responses as not cacheable, not sniffable and not frameable, with HSTS", async () => {
    const res = await app.request(`/v1/public/clients/${seed.havana.clientId}/brands/${seed.havana.brandId}/events`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("strict-transport-security")).toContain("max-age=");
  });

  it("rate-limits by the address our proxy saw, not by a forged X-Forwarded-For", async () => {
    const limited = testApp(db.pool, { publicHoldsPerMinute: 2 });
    const h = seed.havana;
    const hold = (xff: string) =>
      call(limited, "POST", `/v1/public/clients/${h.clientId}/brands/${h.brandId}/holds`, {
        headers: { "x-forwarded-for": xff },
        body: { sessionId: h.sessionId, items: [{ ticketTypeId: h.types.find((t) => t.code === "TODDLER")!.id, quantity: 1 }] },
      });
    // The attacker rotates the left part; the right-most entry is what our proxy appended.
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await hold(`10.0.0.${i}, 203.0.113.9`)).status);
    expect(statuses.slice(2)).toEqual([429, 429]);
    // Another real client is not affected.
    expect((await hold("198.51.100.4")).status).not.toBe(429);
  });
});
