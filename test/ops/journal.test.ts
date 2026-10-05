import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeAudit } from "../../src/db/catalog.js";
import type { Db } from "../../src/db/pool.js";
import { withTransaction } from "../../src/db/pool.js";
import { orderHistory } from "../../src/ops/journal.js";
import { adm, call, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { seedPaidOrder, seedTwoTenants, type SeedResult, type TenantFixture } from "../helpers/seed.js";

/**
 * Run 30: the audit journal for staff (filters, paging that skips nothing) and the history of
 * one order. The log is only read; nothing in it changes.
 */
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

const scope = (t: TenantFixture) => ({ clientId: t.clientId, brandId: t.brandId });
const journal = async (t: TenantFixture, query: string, user = seed.users.havanaOwner) =>
  call(app, "GET", `${adm(t.clientId, t.brandId)}/audit${query}`, { token: await tokenFor(user) });
type Entry = { id: string; action: string; actorType: string; actorRole: string | null; entityType: string; entityId: string | null; createdAt: string };

describe("the audit journal", () => {
  it("filters by family of actions and by what it is about, with the actor's role", async () => {
    const h = seed.havana;
    const owner = await tokenFor(seed.users.havanaOwner);
    const made = await call(app, "POST", `${adm(h.clientId, h.brandId)}/events/${h.eventId}/sessions`, { token: owner, body: { startsAt: "2027-09-01T22:00:00Z", capacity: 9 } });
    await call(app, "PATCH", `${adm(h.clientId, h.brandId)}/sessions/${made.body.session.id}`, { token: owner, body: { capacity: 8 } });

    const sessions = await journal(h, "?action=session");
    expect(sessions.status).toBe(200);
    const entries: Entry[] = sessions.body.entries;
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries.every((e) => e.action.startsWith("session."))).toBe(true);
    expect(entries.slice(0, 2).map((e) => [e.action, e.actorType, e.actorRole])).toEqual([["session.updated", "user", "owner"], ["session.created", "user", "owner"]]);

    const exact = await journal(h, `?action=session.created&entityType=session&entityId=${made.body.session.id}`);
    expect(exact.body.entries.map((e: Entry) => e.action)).toEqual(["session.created"]);
    // "session" is a family: "sessions.batch_created" is another one.
    expect((await journal(h, "?action=sess")).body.entries).toEqual([]);
  });

  it("pages through entries written in the same instant without skipping any", async () => {
    const h = seed.havana;
    await withTransaction(db.pool, async (tx) => {
      for (let i = 0; i < 5; i++) await writeAudit(tx, scope(h), { type: "system", id: null }, "test.same_instant", { type: "test", id: String(i) });
    });
    const seen: string[] = [];
    let cursor = "";
    for (let page = 0; page < 5; page++) {
      const res = await journal(h, `?action=test&limit=2${cursor}`);
      const entries: Entry[] = res.body.entries;
      seen.push(...entries.map((e) => e.entityId!));
      if (entries.length < 2) break;
      const last = entries[entries.length - 1]!;
      cursor = `&beforeId=${last.id}`;
    }
    expect(seen).toEqual(["4", "3", "2", "1", "0"]);
    // An id from another Client is no cursor at all.
    const festiEntry = (await journal(seed.festi, "?limit=1", seed.users.festiOwner)).body.entries[0] as Entry;
    expect((await journal(h, `?action=test&beforeId=${festiEntry.id}`)).body.entries).toEqual([]);
  });

  it("is for owners and admins, and refuses incoherent queries", async () => {
    const h = seed.havana;
    const f = seed.festi;
    expect((await journal(h, "", seed.users.havanaStaff)).status).toBe(403);
    expect((await journal(f, "", seed.users.both)).status).toBe(403); // manager at FESTI-ICE
    expect((await journal(h, "?beforeId=-3")).status).toBe(400);
    expect((await journal(h, "?action=Order.Paid")).status).toBe(400);
    expect((await journal(h, "?entityType=order;drop")).status).toBe(400);
  });
});

describe("the history of an order", () => {
  it("gathers the order, its refunds, tickets, exchange and buyer, oldest first, and nothing else", async () => {
    const h = seed.havana;
    const order = await seedPaidOrder(db.pool, h, "historique@example.com");
    const other = await seedPaidOrder(db.pool, h, "autre-historique@example.com");
    const user = { type: "user" as const, id: seed.users.havanaOwner };
    await withTransaction(db.pool, async (tx) => {
      await writeAudit(tx, scope(h), user, "order.tickets_email_requested", { type: "order", id: order.orderId }, { kind: "order_tickets" });
      await writeAudit(tx, scope(h), user, "refund.requested", { type: "refund", id: "00000000-0000-4000-8000-000000000001" }, { orderId: order.orderId, amountCents: 500 });
      await writeAudit(tx, scope(h), user, "credentials.reissued", { type: "ticket", id: order.ticketIds[0]! }, { credentialId: "x" });
      await writeAudit(tx, scope(h), user, "order.exchanged", { type: "order", id: other.orderId }, { exchangeOrderId: order.orderId });
      await writeAudit(tx, scope(h), user, "buyer.anonymized", { type: "buyer", id: order.buyerId }, { orders: 1 });
      // Not about this order.
      await writeAudit(tx, scope(h), user, "order.tickets_link_rotated", { type: "order", id: other.orderId });
      await writeAudit(tx, scope(h), user, "refund.requested", { type: "refund", id: "00000000-0000-4000-8000-000000000002" }, { orderId: other.orderId });
    });
    // Another Client's entry naming the same order id stays out.
    await writeAudit(db.pool, scope(seed.festi), { type: "system", id: null }, "order.paid", { type: "order", id: order.orderId });

    const res = await call(app, "GET", `${adm(h.clientId, h.brandId)}/orders/${order.orderId}/history`, { token: await tokenFor(seed.users.havanaOwner) });
    expect(res.status).toBe(200);
    expect(res.body.entries.map((e: Entry) => e.action)).toEqual([
      "order.paid", "order.tickets_email_requested", "refund.requested", "credentials.reissued", "order.exchanged", "buyer.anonymized",
    ]);
    expect(res.body.entries[1]).toMatchObject({ actorType: "user", actorRole: "owner", entityType: "order", entityId: order.orderId });

    const f = seed.festi;
    expect((await call(app, "GET", `${adm(h.clientId, h.brandId)}/orders/${f.orderId}/history`, { token: await tokenFor(seed.users.havanaOwner) })).status).toBe(404);
    expect((await call(app, "GET", `${adm(f.clientId, f.brandId)}/orders/${f.orderId}/history`, { token: await tokenFor(seed.users.both) })).status).toBe(403);
  });

  it("reads the log through its indexes, at a season's volume", async () => {
    const h = seed.havana;
    // 30 000 entries about other things; the history should not read them all.
    await db.pool.query(
      `INSERT INTO public.ticketing_audit_log (client_id, brand_id, actor_type, action, entity_type, entity_id, data)
       SELECT $1, $2, 'system', 'test.volume', 'order', gen_random_uuid()::text, jsonb_build_object('orderId', gen_random_uuid()::text)
       FROM generate_series(1, 30000)`,
      [h.clientId, h.brandId],
    );
    await db.pool.query("ANALYZE public.ticketing_audit_log");
    const client = await db.pool.connect();
    try {
      const plans: string[] = [];
      const explaining = {
        query: async (sql: string, params: unknown[]) => {
          if (!sql.includes("ticketing_audit_log")) return client.query(sql, params);
          const r = await client.query<{ "QUERY PLAN": string }>(`EXPLAIN ${sql}`, params);
          plans.push(r.rows.map((x) => x["QUERY PLAN"]).join("\n"));
          return { rows: [] };
        },
      } as unknown as Db;
      await orderHistory(explaining, scope(h), h.orderId);
      expect(plans).toHaveLength(1);
      expect(plans[0]).not.toMatch(/Seq Scan on ticketing_audit_log/);
      expect(plans[0]).toMatch(/ticketing_audit_log_entity_idx/);
      expect(plans[0]).toMatch(/ticketing_audit_log_order_ref_idx/);
    } finally {
      client.release();
    }
  });
});
