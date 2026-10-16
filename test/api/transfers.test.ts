import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, pub, testApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { seedPaidOrder, seedTwoTenants, TEST_CREDENTIAL_SECRET, type SeedResult } from "../helpers/seed.js";
import { transferClaimSecret } from "../../src/delivery/transfer-token.js";

let db: TestDatabase;
let seed: SeedResult;
const scope = () => ({ clientId: seed.havana.clientId, brandId: seed.havana.brandId });
const base = () => pub(seed.havana.clientId, seed.havana.brandId);
const enabledApp = () => testApp(db.pool, { transferApiEnabled: true, credentialMasterSecret: TEST_CREDENTIAL_SECRET });
const newOrder = async () => seedPaidOrder(db.pool, seed.havana,
  `run80-buyer-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`, { GENERAL: 1 });

const create = (app: ReturnType<typeof enabledApp>, orderId: string, ticketId: string, address = "friend@example.com", token = `secret-${orderId}`) =>
  call(app, "POST", `${base()}/orders/${orderId}/transfers`, {
    headers: { "x-alkao-order-token": token },
    body: { ticketId, recipientEmail: address },
  });

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
});
afterAll(async () => { await db?.drop(); });

describe("Run 80 transfer API release and authorization", () => {
  it("is invisible until the explicit global release switch AND signing secret are configured", async () => {
    const order = await newOrder();
    const path = `${base()}/orders/${order.orderId}/transfers`;
    const body = { ticketId: order.ticketIds[0], recipientEmail: "friend@example.com" };
    for (const app of [testApp(db.pool), testApp(db.pool, { credentialMasterSecret: TEST_CREDENTIAL_SECRET }),
      testApp(db.pool, { transferApiEnabled: true })]) {
      const res = await call(app, "POST", path, { headers: { "x-alkao-order-token": `secret-${order.orderId}` }, body });
      expect(res).toEqual({ status: 404, body: { error: { code: "not_found" } } });
      const list = await call(app, "GET", path, { headers: { "x-alkao-order-token": `secret-${order.orderId}` } });
      expect(list.status).toBe(404);
    }
    const n = (await db.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM public.ticketing_transfer_requests WHERE ticket_id = $1",
      [order.ticketIds[0]],
    )).rows[0]?.n;
    expect(n).toBe(0);
  });

  it("enforces Brand opt-in and valid sender order token, without disclosing recipient proof", async () => {
    const app = enabledApp();
    const order = await newOrder();
    const ticketId = order.ticketIds[0]!;
    const off = await create(app, order.orderId, ticketId);
    expect(off.status).toBe(422);
    expect((await create(app, order.orderId, ticketId, "friend@example.com", "wrong")).status).toBe(404);
    await db.pool.query("UPDATE public.ticketing_brand_settings SET ticket_transfers_enabled = true WHERE client_id = $1 AND brand_id = $2",
      [scope().clientId, scope().brandId]);
    const foreign = await call(app, "POST",
      `${pub(seed.festi.clientId, seed.festi.brandId)}/orders/${order.orderId}/transfers`,
      { headers: { "x-alkao-order-token": `secret-${order.orderId}` },
        body: { ticketId, recipientEmail: "friend@example.com" } });
    expect(foreign.status).toBe(404);
    const own = await create(app, order.orderId, ticketId);
    expect(own.status).toBe(202);
    expect(own.body.transfer).toMatchObject({ ticketId, status: "pending" });
    expect(own.body.transfer.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(JSON.stringify(own.body)).not.toMatch(/recipientClaimSecret|claim_token|secret-/i);
    const list = await call(app, "GET", `${base()}/orders/${order.orderId}/transfers`,
      { headers: { "x-alkao-order-token": `secret-${order.orderId}` } });
    expect(list.status).toBe(200);
    expect(list.body.transfers).toHaveLength(1);
    expect(list.body.transfers[0].id).toBe(own.body.transfer.id);
    expect(JSON.stringify(list.body)).not.toContain("friend@example.com");
    expect((await call(app, "GET", `${base()}/orders/${order.orderId}/transfers`,
      { headers: { "x-alkao-order-token": "bad" } })).status).toBe(404);
  });

  it("recipient claims once; original buyer cannot read new QR and another tenant is isolated", async () => {
    const app = enabledApp();
    const order = await newOrder();
    const ticketId = order.ticketIds[0]!;
    const invited = await create(app, order.orderId, ticketId, "Recipient@Example.com");
    expect(invited.status).toBe(202);
    const id: string = invited.body.transfer.id;
    const secret = transferClaimSecret(TEST_CREDENTIAL_SECRET, scope(), id, ticketId, "recipient@example.com");
    const claimUrl = `${base()}/transfers/${id}/claim`;
    expect((await call(app, "POST", claimUrl, { body: { secret: `secret-${order.orderId}` } })).status).toBe(400);
    expect((await call(app, "POST", claimUrl, { body: { secret: "A".repeat(43) } })).status).toBe(404);
    const claim = await call(app, "POST", claimUrl, { body: { secret } });
    expect(claim.status).toBe(200);
    expect(claim.body.transfer).toMatchObject({ id, ticketId });
    const token: string = claim.body.transfer.accessToken;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token).not.toBe(secret);
    expect((await call(app, "POST", claimUrl, { body: { secret } })).status).toBe(404);
    const ticketUrl = `${base()}/transfers/${id}/ticket`;
    expect((await call(app, "GET", ticketUrl)).status).toBe(404);
    expect((await call(app, "GET", ticketUrl,
      { headers: { "x-alkao-transfer-token": secret } })).status).toBe(404);
    expect((await call(app, "GET", ticketUrl,
      { headers: { "x-alkao-transfer-token": `secret-${order.orderId}` } })).status).toBe(404);
    const own = await call(app, "GET", ticketUrl,
      { headers: { "x-alkao-transfer-token": token } });
    expect(own.status).toBe(200);
    expect(own.body.ticket.id).toBe(ticketId);
    expect(own.body.ticket.credential).toMatch(/^ALK1\./);
    expect(JSON.stringify(own.body)).not.toContain("recipient@example.com");
    const blockedExchange = await call(app, "POST", `${base()}/orders/${order.orderId}/exchange`,
      { headers: { "x-alkao-order-token": `secret-${order.orderId}` },
        body: { sessionId: seed.havana.sessionId } });
    expect(blockedExchange).toEqual({ status: 409, body: { error: { code: "order_has_transfer" } } });
    const original = await call(app, "GET", `${base()}/orders/${order.orderId}`,
      { headers: { "x-alkao-order-token": `secret-${order.orderId}` } });
    expect(original.status).toBe(200);
    expect(original.body.order.tickets.find((t: { id: string }) => t.id === ticketId).credential).toBeNull();
    const cross = await call(app, "GET", `${pub(seed.festi.clientId, seed.festi.brandId)}/transfers/${id}/ticket`,
      { headers: { "x-alkao-transfer-token": token } });
    expect(cross.status).toBe(422);
  });

  it("cancellation is order-scoped and makes the recipient proof non-claimable", async () => {
    const app = enabledApp();
    const order = await newOrder();
    const ticketId = order.ticketIds[0]!;
    const invited = await create(app, order.orderId, ticketId, "cancel@example.com");
    expect(invited.status).toBe(202);
    const id = invited.body.transfer.id;
    const foreign = await call(app, "DELETE", `${base()}/orders/${seed.havana.orderId}/transfers/${id}`,
      { headers: { "x-alkao-order-token": `secret-${seed.havana.orderId}` } });
    expect(foreign.status).toBe(200);
    expect(foreign.body.cancelled).toBe(false);
    const cancel = await call(app, "DELETE", `${base()}/orders/${order.orderId}/transfers/${id}`,
      { headers: { "x-alkao-order-token": `secret-${order.orderId}` } });
    expect(cancel).toEqual({ status: 200, body: { cancelled: true } });
    const secret = transferClaimSecret(TEST_CREDENTIAL_SECRET, scope(), id, ticketId, "cancel@example.com");
    const claim = await call(app, "POST", `${base()}/transfers/${id}/claim`, { body: { secret } });
    expect(claim.status).toBe(404);
    expect((await call(app, "DELETE", `${base()}/orders/${order.orderId}/transfers/${id}`,
      { headers: { "x-alkao-order-token": `secret-${order.orderId}` } })).body.cancelled).toBe(false);
  });
});
