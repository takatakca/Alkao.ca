import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyProvisioning, buildProvisioningEvents, ProvisioningPlan } from "../../src/control/provision.js";
import { call, CONTROL_KEY_ID, CONTROL_SECRET, pub, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";

const BASE = "https://alkao.test";
let db: TestDatabase;
let app: TestApp;
const target = { url: BASE, keyId: CONTROL_KEY_ID, secret: CONTROL_SECRET };
// The CLI's HTTP calls, served by the in-process app.
const viaApp = (() => ((input: string | URL | Request, init?: RequestInit) => app.request(String(input).replace(BASE, ""), init))) as () => typeof fetch;

beforeAll(async () => {
  db = await createTestDatabase();
  app = testApp(db.pool);
});

afterAll(async () => {
  await db?.drop();
});

function plan() {
  const ids = { client: randomUUID(), sales: randomUUID(), other: randomUUID(), owner: randomUUID(), gate: randomUUID() };
  const p = ProvisioningPlan.parse({
    clients: [
      {
        clientId: ids.client,
        name: "Havana Resort",
        commission: { rateBps: 250, fixedCentsPerPaidAdmission: 75 },
        brands: [
          { brandId: ids.sales, name: "Havana Resort — Événements", ticketing: { status: "active" } },
          { brandId: ids.other, name: "Havana Resort — Spa" },
        ],
        members: [
          { userId: ids.owner, role: "owner" },
          { userId: ids.gate, role: "staff" },
        ],
      },
    ],
  });
  return { p, ids };
}

describe("control:apply provisioning", () => {
  it("sets up a Client, its Brands, staff and Ticketing in dependency order", async () => {
    const { p, ids } = plan();
    const events = buildProvisioningEvents(p, Date.now());
    expect(events.map((e) => JSON.parse(e.body).type)).toEqual([
      "client.upserted", "brand.upserted", "brand.upserted", "membership.upserted", "membership.upserted", "entitlement.updated",
    ]);
    const { ok, results } = await applyProvisioning(target, events, viaApp());
    expect(ok).toBe(true);
    expect(results.map((r) => r.outcome)).toEqual(Array(6).fill("applied"));

    // Ticketing is on for the activated Brand only.
    expect((await call(app, "GET", `${pub(ids.client, ids.sales)}/events`)).status).toBe(200);
    expect((await call(app, "GET", `${pub(ids.client, ids.other)}/events`)).status).toBe(404);
    const me = await call(app, "GET", "/v1/admin/me", { token: await tokenFor(ids.gate) });
    expect(me.body.memberships).toMatchObject([{ clientId: ids.client, role: "staff" }]);
    const { rows } = await db.pool.query(`SELECT commission_rate_bps, commission_fixed_cents FROM public.ticketing_clients WHERE id = $1`, [ids.client]);
    expect(rows).toEqual([{ commission_rate_bps: 250, commission_fixed_cents: 75 }]);

    // Sending the same events again changes nothing.
    const again = await applyProvisioning(target, events, viaApp());
    expect(again.results.map((r) => r.outcome)).toEqual(Array(6).fill("duplicate"));
  });

  it("lets a newer plan win and never lets an older one come back", async () => {
    const { p, ids } = plan();
    const t0 = Date.now();
    await applyProvisioning(target, buildProvisioningEvents(p, t0), viaApp());
    p.clients[0]!.members[1]!.status = "removed";
    p.clients[0]!.brands[0]!.ticketing!.status = "suspended";
    const newer = await applyProvisioning(target, buildProvisioningEvents(p, t0 + 1000), viaApp());
    expect(newer.ok).toBe(true);
    expect((await call(app, "GET", `${pub(ids.client, ids.sales)}/events`)).status).toBe(404);
    expect((await call(app, "GET", "/v1/admin/me", { token: await tokenFor(ids.gate) })).body.memberships).toEqual([]);

    p.clients[0]!.members[1]!.status = "active";
    p.clients[0]!.brands[0]!.ticketing!.status = "active";
    const older = await applyProvisioning(target, buildProvisioningEvents(p, t0 + 500), viaApp());
    expect(new Set(older.results.map((r) => r.outcome))).toEqual(new Set(["stale"]));
    expect((await call(app, "GET", `${pub(ids.client, ids.sales)}/events`)).status).toBe(404);
  });

  it("stops at the first refusal and sends nothing after it", async () => {
    const { p, ids } = plan();
    const sent: string[] = [];
    const counting = ((input: string | URL | Request, init?: RequestInit) => {
      sent.push(String(input));
      return app.request(String(input).replace(BASE, ""), init);
    }) as typeof fetch;
    const r = await applyProvisioning({ ...target, secret: "not-the-control-secret-0123456789abcdef" }, buildProvisioningEvents(p, Date.now()), counting);
    expect(r.ok).toBe(false);
    expect(r.results).toMatchObject([{ status: 401, outcome: "invalid_signature" }]);
    expect(sent).toHaveLength(1);
    const { rowCount } = await db.pool.query(`SELECT 1 FROM public.ticketing_clients WHERE id = $1`, [ids.client]);
    expect(rowCount).toBe(0);
  });

  it("refuses an invalid plan before sending anything", () => {
    expect(() => ProvisioningPlan.parse({ clients: [{ clientId: "havana", name: "Havana", commission: { rateBps: 0, fixedCentsPerPaidAdmission: 0 } }] })).toThrow();
    const { p } = plan();
    p.clients[0]!.brands[0]!.ticketing = { status: "active", validFrom: "2027-02-01T00:00:00Z", validUntil: "2027-01-01T00:00:00Z" };
    expect(() => buildProvisioningEvents(p, Date.now())).toThrow(/validFrom must be before validUntil/);
  });
});
