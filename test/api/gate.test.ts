import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { call, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { seedTwoTenants, type SeedResult } from "../helpers/seed.js";

/**
 * The frozen rule: Ticketing is disabled by default and every route — public mutations
 * included — checks enablement server-side. Routes are enumerated from the app itself, so a
 * route added later without the gate fails this suite.
 */

let db: TestDatabase;
let seed: SeedResult;

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
});

afterAll(async () => {
  await db?.drop();
});

// The Stripe webhook is authenticated by Stripe's signature and must still settle (or
// refund) checkouts opened while Ticketing was active.
const UNGATED = new Set([
  "GET /health",
  "POST /v1/control/events",
  "POST /v1/control/state",
  "POST /v1/webhooks/stripe",
  "GET /v1/admin/clients/:clientId/brands/:brandId/status",
  // The caller's own memberships (no tenant id in the request).
  "GET /v1/admin/me",
]);

// Static files of the Operations app, the buyer's tickets page and the hosted shop: no
// data, every call goes through the gated API.
const isOpsAsset = (path: string) =>
  path === "/ops" || path.startsWith("/ops/") || path === "/billets" || path.startsWith("/billets/") ||
  path.startsWith("/acheter/") || path.startsWith("/shop/") || path === "/widget.js";

function routesOf(app: TestApp) {
  const seen = new Set<string>();
  const out: { method: string; path: string }[] = [];
  for (const r of app.routes) {
    if (r.method === "ALL") continue;
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ method: r.method, path: r.path });
  }
  return out;
}

function concrete(path: string, clientId: string, brandId: string) {
  return path
    .replace(":clientId", clientId)
    .replace(":brandId", brandId)
    .replace(/:[A-Za-z]+/g, () => randomUUID());
}

async function holdCount() {
  const { rows } = await db.pool.query(`SELECT count(*)::int AS n FROM public.ticketing_holds`);
  return rows[0].n as number;
}

async function expectAllGated(app: TestApp, clientId: string, brandId: string, reason: string) {
  const token = await tokenFor(seed.users.havanaOwner);
  const routes = routesOf(app).filter((r) => !UNGATED.has(`${r.method} ${r.path}`) && !isOpsAsset(r.path));
  expect(routes.length).toBeGreaterThan(15);
  for (const r of routes) {
    const path = concrete(r.path, clientId, brandId);
    const body = r.method === "POST" || r.method === "PATCH" ? { sessionId: seed.havana.sessionId, items: [] } : undefined;
    if (r.path.startsWith("/v1/public/")) {
      const res = await call(app, r.method, path, body === undefined ? {} : { body });
      expect([r.method, r.path, res.status, res.body?.error?.code]).toEqual([r.method, r.path, 404, "ticketing_unavailable"]);
    } else if (r.path.startsWith("/v1/admin/")) {
      const res = await call(app, r.method, path, body === undefined ? { token } : { token, body });
      expect([r.method, r.path, res.status, res.body?.error]).toEqual([
        r.method,
        r.path,
        403,
        { code: "ticketing_disabled", details: { reason } },
      ]);
    } else {
      throw new Error(`route ${r.method} ${r.path} is neither public, admin nor explicitly ungated`);
    }
  }
}

describe("Ticketing gate on every route", () => {
  it("knows every route: public and admin routes are gated, only health/control/status are not", () => {
    const app = testApp(db.pool);
    for (const r of routesOf(app)) {
      const key = `${r.method} ${r.path}`;
      expect(UNGATED.has(key) || isOpsAsset(r.path) || r.path.startsWith("/v1/public/clients/:clientId/brands/:brandId/") || r.path.startsWith("/v1/admin/clients/:clientId/brands/:brandId/"), key).toBe(true);
    }
  });

  it("deployment switch off (the default): every route refuses, and no hold is written", async () => {
    const app = testApp(db.pool, { operationalApiEnabled: false });
    const before = await holdCount();
    await expectAllGated(app, seed.havana.clientId, seed.havana.brandId, "operational_api_disabled");
    expect(await holdCount()).toBe(before);
  });

  it("no entitlement for the Brand: every route refuses, and no hold is written", async () => {
    await db.pool.query(`UPDATE public.ticketing_entitlements SET status = 'inactive' WHERE client_id = $1`, [seed.havana.clientId]);
    try {
      const app = testApp(db.pool);
      const before = await holdCount();
      await expectAllGated(app, seed.havana.clientId, seed.havana.brandId, "entitlement_inactive");
      expect(await holdCount()).toBe(before);
    } finally {
      await db.pool.query(`UPDATE public.ticketing_entitlements SET status = 'active' WHERE client_id = $1`, [seed.havana.clientId]);
    }
  });

  it("an entitlement for one Brand never enables another Brand of the same Client", async () => {
    const otherBrand = randomUUID();
    await db.pool.query(`INSERT INTO public.ticketing_brands (id, client_id, name) VALUES ($1, $2, 'Havana Spa')`, [otherBrand, seed.havana.clientId]);
    const app = testApp(db.pool);
    await expectAllGated(app, seed.havana.clientId, otherBrand, "no_entitlement");
  });

  it("a Brand paired with the wrong Client is refused", async () => {
    const app = testApp(db.pool);
    const res = await call(app, "GET", `/v1/public/clients/${seed.havana.clientId}/brands/${seed.festi.brandId}/events`);
    expect(res).toEqual({ status: 404, body: { error: { code: "ticketing_unavailable" } } });
  });

  it.each([
    ["client suspended", `UPDATE public.ticketing_clients SET status = 'suspended' WHERE id = $1`, `UPDATE public.ticketing_clients SET status = 'active' WHERE id = $1`, "client_inactive"],
    ["brand archived", `UPDATE public.ticketing_brands SET status = 'archived' WHERE client_id = $1`, `UPDATE public.ticketing_brands SET status = 'active' WHERE client_id = $1`, "brand_inactive"],
    ["entitlement expired", `UPDATE public.ticketing_entitlements SET valid_until = now() - interval '1 minute', valid_from = NULL WHERE client_id = $1`, `UPDATE public.ticketing_entitlements SET valid_until = NULL WHERE client_id = $1`, "entitlement_expired"],
    ["entitlement not started", `UPDATE public.ticketing_entitlements SET valid_from = now() + interval '1 day' WHERE client_id = $1`, `UPDATE public.ticketing_entitlements SET valid_from = NULL WHERE client_id = $1`, "entitlement_not_yet_valid"],
  ])("%s: public hold creation is refused server-side", async (_label, off, on, reason) => {
    await db.pool.query(off, [seed.havana.clientId]);
    try {
      const app = testApp(db.pool);
      const before = await holdCount();
      const typeId = seed.havana.types.find((t) => t.code === "GENERAL")!.id;
      const res = await call(app, "POST", `/v1/public/clients/${seed.havana.clientId}/brands/${seed.havana.brandId}/holds`, {
        body: { sessionId: seed.havana.sessionId, items: [{ ticketTypeId: typeId, quantity: 1 }] },
      });
      expect(res.status).toBe(404);
      expect(await holdCount()).toBe(before);
      const status = await call(app, "GET", `/v1/admin/clients/${seed.havana.clientId}/brands/${seed.havana.brandId}/status`, {
        token: await tokenFor(seed.users.havanaOwner),
      });
      expect(status.body.ticketing).toEqual({ active: false, reason });
    } finally {
      await db.pool.query(on, [seed.havana.clientId]);
    }
  });

  it("with everything active, the same hold request succeeds", async () => {
    const app = testApp(db.pool);
    const typeId = seed.havana.types.find((t) => t.code === "GENERAL")!.id;
    const res = await call(app, "POST", `/v1/public/clients/${seed.havana.clientId}/brands/${seed.havana.brandId}/holds`, {
      body: { sessionId: seed.havana.sessionId, items: [{ ticketTypeId: typeId, quantity: 1 }] },
    });
    expect(res.status).toBe(201);
  });
});
