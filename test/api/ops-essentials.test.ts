import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { adm, call, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { seedTwoTenants, type SeedResult } from "../helpers/seed.js";

let db: TestDatabase;
let seed: SeedResult;
let app: TestApp;

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  app = testApp(db.pool);
});

afterAll(async () => {
  await db?.drop();
});

const orders = async (q: string, clientId = seed.havana.clientId, brandId = seed.havana.brandId, user = seed.users.havanaOwner) =>
  call(app, "GET", `${adm(clientId, brandId)}/orders?q=${encodeURIComponent(q)}`, { token: await tokenFor(user) });

describe("order search (Run 14)", () => {
  it("finds an order by reference, email or name, within the Client only", async () => {
    const { rows } = await db.pool.query<{ reference: string; email: string; full_name: string | null }>(
      `SELECT o.reference, b.email, b.full_name FROM public.ticketing_orders o JOIN public.ticketing_buyers b ON b.id = o.buyer_id WHERE o.id = $1`,
      [seed.havana.orderId],
    );
    const o = rows[0]!;
    const ids = async (q: string) => ((await orders(q)).body.orders as { id: string }[]).map((x) => x.id);
    expect(await ids(o.reference.slice(0, 6).toLowerCase())).toContain(seed.havana.orderId);
    expect(await ids(o.email.slice(0, 5).toUpperCase())).toContain(seed.havana.orderId);
    if (o.full_name) expect(await ids(o.full_name.slice(1, 5))).toContain(seed.havana.orderId);
    expect(await ids("zzzz-nothing")).toEqual([]);
    // Wildcards are literal: "%%" does not mean "everything".
    expect(await ids("%%")).toEqual([]);
    expect(await ids("__")).toEqual([]);
    // FESTI-ICE's search never returns Havana's order.
    const festi = await orders(o.reference.slice(0, 6), seed.festi.clientId, seed.festi.brandId, seed.users.festiOwner);
    expect((festi.body.orders as { id: string }[]).map((x) => x.id)).not.toContain(seed.havana.orderId);
    expect((await orders("a")).status).toBe(400);
  });
});

describe("gate counter, readiness and logs (Run 14)", () => {
  it("counts valid tickets and admissions for a session", async () => {
    const h = seed.havana;
    const res = await call(app, "GET", `${adm(h.clientId, h.brandId)}/sessions/${h.sessionId}/attendance`, { token: await tokenFor(seed.users.havanaStaff) });
    expect(res.status).toBe(200);
    const { rows } = await db.pool.query(
      `SELECT (SELECT count(*)::int FROM public.ticketing_tickets WHERE session_id = $1 AND status = 'valid') AS valid,
              (SELECT count(DISTINCT ticket_id)::int FROM public.ticketing_scans WHERE session_id = $1 AND result = 'admitted') AS admitted,
              (SELECT capacity FROM public.ticketing_sessions WHERE id = $1) AS capacity`,
      [h.sessionId],
    );
    expect(res.body.attendance).toEqual(rows[0]);
    expect(res.body.attendance.valid).toBeGreaterThan(0);
  });

  it("is ready when the database answers, and says so when it does not", async () => {
    expect((await call(app, "GET", "/health/ready")).body).toEqual({ ok: true, database: "up" });
    const dead = new pg.Pool({ connectionString: "postgres://nobody@127.0.0.1:1/none", connectionTimeoutMillis: 300 });
    const down = testApp(dead);
    const res = await call(down, "GET", "/health/ready");
    expect(res).toEqual({ status: 503, body: { ok: false, database: "down" } });
    await dead.end();
  });

  it("logs the route pattern, never ids, tokens or queries", async () => {
    const logged = testApp(db.pool, { logRequests: true });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const h = seed.havana;
      await call(logged, "GET", `${adm(h.clientId, h.brandId)}/orders/${h.orderId}?secret=1`, { token: await tokenFor(seed.users.havanaOwner) });
      const line = spy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('"route"'))!;
      const entry = JSON.parse(line);
      expect(entry).toMatchObject({ method: "GET", route: "/v1/admin/clients/:clientId/brands/:brandId/orders/:orderId", status: 200 });
      expect(line).not.toContain(h.orderId);
      expect(line).not.toContain(h.clientId);
      expect(line).not.toContain("secret");
      expect(line).not.toMatch(/Bearer|eyJ/);
    } finally {
      spy.mockRestore();
    }
  });
});
