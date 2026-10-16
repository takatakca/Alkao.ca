import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adm, call, testApp, tokenFor } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { seedTwoTenants, TEST_CREDENTIAL_SECRET, type SeedResult } from "../helpers/seed.js";

let db: TestDatabase;
let seed: SeedResult;

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
});
afterAll(async () => { await db?.drop(); });

describe("Run 80 Brand transfer release settings", () => {
  it("requires an active platform release and owner/admin permission", async () => {
    const path = adm(seed.havana.clientId, seed.havana.brandId) + "/settings/transfers";
    const owner = await tokenFor(seed.users.havanaOwner);
    const staff = await tokenFor(seed.users.havanaStaff);
    const off = testApp(db.pool, { credentialMasterSecret: TEST_CREDENTIAL_SECRET });
    const status = await call(off, "GET", path, { token: owner });
    expect(status.status).toBe(200);
    expect(status.body.transfers).toMatchObject({ enabled: false, available: false });
    expect((await call(off, "PUT", path, { token: owner, body: { enabled: true } })).status).toBe(409);
    const enabled = testApp(db.pool, {
      credentialMasterSecret: TEST_CREDENTIAL_SECRET, transferApiEnabled: true,
    });
    expect((await call(enabled, "PUT", path, { token: staff, body: { enabled: false } })).status).toBe(403);
    const disabled = await call(enabled, "PUT", path, { token: owner, body: { enabled: false } });
    expect(disabled).toEqual({ status: 200, body: { transfers: { enabled: false, available: true } } });
    const active = await call(enabled, "PUT", path, { token: owner, body: { enabled: true } });
    expect(active).toEqual({ status: 200, body: { transfers: { enabled: true, available: true } } });
    expect((await call(enabled, "GET", path, { token: staff })).status).toBe(403);
    const audit = await db.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM public.ticketing_audit_log WHERE client_id = $1 AND brand_id = $2 AND action = 'settings.transfers_updated'",
      [seed.havana.clientId, seed.havana.brandId],
    );
    expect(audit.rows[0]?.n).toBe(2);
  });
});
