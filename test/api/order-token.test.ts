import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, pub, testApp, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { seedTwoTenants, type SeedResult } from "../helpers/seed.js";

/** Run 76: the optional expiry on order access tokens is enforced everywhere
 * a buyer can read QR codes or submit a session exchange. */
let db: TestDatabase;
let seed: SeedResult;
let app: TestApp;
beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  app = testApp(db.pool);
});
afterAll(async () => { await db?.drop(); });

const url = (s: { clientId: string; brandId: string; orderId: string }) =>
  `${pub(s.clientId, s.brandId)}/orders/${s.orderId}`;
const header = (orderId: string) => ({ "x-alkao-order-token": `secret-${orderId}` });

describe("Run 76: order token authorization and expiry", () => {
  it("keeps existing no-expiry tokens valid and never exposes another tenant", async () => {
    const h = seed.havana;
    const own = await call(app, "GET", url(h), { headers: header(h.orderId) });
    expect(own.status).toBe(200);
    expect(own.body.order.id).toBe(h.orderId);
    const foreign = await call(app, "GET",
      `${pub(seed.festi.clientId, seed.festi.brandId)}/orders/${h.orderId}`,
      { headers: header(h.orderId) });
    expect(foreign.status).toBe(404);
    const wrong = await call(app, "GET", url(h), { headers: { "x-alkao-order-token": "incorrect" } });
    expect(wrong.status).toBe(404);
  });

  it("denies expired and exact-boundary tokens for both order reading and exchanges", async () => {
    const h = seed.havana;
    const scope = [h.clientId, h.brandId, h.orderId];
    const change = async (expiredAt: string) => db.pool.query(
      `UPDATE public.ticketing_access_tokens SET expires_at = $4::timestamptz
       WHERE client_id = $1 AND brand_id = $2 AND subject_id = $3 AND subject_type = 'order'
         AND purpose = 'checkout'`,
      [...scope, expiredAt],
    );
    const fixed = new Date("2026-10-14T19:00:00.000Z");
    const clocked = testApp(db.pool, { now: () => fixed });
    try {
      await change("2026-10-14T19:00:00.000Z");
      expect((await call(clocked, "GET", url(h), { headers: header(h.orderId) })).status).toBe(404);
      const body = { sessionId: h.sessionId };
      const post = await call(clocked, "POST", `${url(h)}/exchange`, {
        headers: header(h.orderId), body,
      });
      expect(post).toEqual({ status: 404, body: { error: { code: "order_not_found" } } });
      await change("2026-10-14T19:00:01.000Z");
      expect((await call(clocked, "GET", url(h), { headers: header(h.orderId) })).status).toBe(200);
      await change("2026-10-14T18:59:59.000Z");
      expect((await call(clocked, "GET", url(h), { headers: header(h.orderId) })).status).toBe(404);
    } finally {
      await db.pool.query(
        `UPDATE public.ticketing_access_tokens SET expires_at = NULL
         WHERE client_id = $1 AND brand_id = $2 AND subject_id = $3
           AND subject_type = 'order' AND purpose = 'checkout'`, scope,
      );
    }
    expect((await call(app, "GET", url(h), { headers: header(h.orderId) })).status).toBe(200);
  });
});
