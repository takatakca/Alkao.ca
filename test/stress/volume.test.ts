import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listOrders } from "../../src/db/catalog.js";
import { sessionCredentials } from "../../src/db/credentials.js";
import type { Db } from "../../src/db/pool.js";
import { attendeesRows, ordersRows, salesReport } from "../../src/ops/reports.js";
import { adm, call, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { seedTwoTenants, type SeedResult } from "../helpers/seed.js";
import { seedVolume, type VolumeResult } from "../helpers/volume.js";

/**
 * Volume (Run 18): a few seasons of FESTI-ICE sales (12,000 orders, about 30,000 tickets,
 * the gate's scans) next to Havana's. The hot queries can read only the rows they need,
 * through their indexes, and still return exactly the right rows.
 */
let db: TestDatabase;
let seed: SeedResult;
let festi: VolumeResult;
let havana: VolumeResult;
let app: TestApp;

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  festi = await seedVolume(db.pool, seed.festi, { pastSessions: 4, futureSessions: 8, ordersPerSession: 1000, tag: "festi" });
  havana = await seedVolume(db.pool, seed.havana, { pastSessions: 2, futureSessions: 2, ordersPerSession: 300, tag: "havana", referencePrefix: "W" });
  app = testApp(db.pool);
}, 180_000);

afterAll(async () => {
  await db?.drop();
});

/** Runs `fn` with a database that records every statement, and returns them. */
async function statements(fn: (q: Db) => Promise<unknown>) {
  const seen: { sql: string; params: unknown[] }[] = [];
  const q = { query: (sql: string, params: unknown[]) => (seen.push({ sql, params }), db.pool.query(sql, params)) } as unknown as Db;
  const started = performance.now();
  await fn(q);
  return { seen, ms: performance.now() - started };
}

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  Plans?: PlanNode[];
}
/**
 * The plan with full table reads discouraged. At this test's size reading a small table in
 * full can still be the cheaper choice, so the planner's pick says little; what keeps a query
 * fast at production size is that it *can* be answered from its indexes.
 */
async function planOf(sql: string, params: unknown[]): Promise<PlanNode> {
  const c = await db.pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL enable_seqscan = off");
    const { rows } = await c.query(`EXPLAIN (FORMAT JSON) ${sql}`, params);
    return rows[0]["QUERY PLAN"][0].Plan;
  } finally {
    await c.query("ROLLBACK");
    c.release();
  }
}
const nodes = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(nodes)];
/** Tables the statements of `fn` must read in full. */
async function seqScanned(fn: (q: Db) => Promise<unknown>) {
  const { seen } = await statements(fn);
  const tables = new Set<string>();
  for (const s of seen) for (const n of nodes(await planOf(s.sql, s.params))) if (n["Node Type"] === "Seq Scan") tables.add(n["Relation Name"]!);
  return tables;
}
async function indexesUsed(fn: (q: Db) => Promise<unknown>) {
  const { seen } = await statements(fn);
  const used = new Set<string>();
  for (const s of seen) for (const n of nodes(await planOf(s.sql, s.params))) if (n["Index Name"]) used.add(n["Index Name"]);
  return used;
}

const BIG = ["ticketing_orders", "ticketing_buyers", "ticketing_tickets", "ticketing_credentials", "ticketing_scans", "ticketing_order_lines"];
const big = (tables: Set<string>) => [...tables].filter((t) => BIG.includes(t));
const scope = () => ({ clientId: seed.festi.clientId, brandId: seed.festi.brandId });

describe("volume", () => {
  it("the season is consistent: sold counts, credentials and scans add up", async () => {
    expect(festi.tickets).toBeGreaterThan(25_000);
    const { rows } = await db.pool.query(
      `SELECT s.id, s.sold_count,
              (SELECT count(*)::int FROM public.ticketing_tickets t WHERE t.session_id = s.id AND t.status = 'valid') AS valid,
              (SELECT count(*)::int FROM public.ticketing_credentials c WHERE c.session_id = s.id AND c.status = 'active') AS credentials
       FROM public.ticketing_sessions s WHERE s.id = ANY($1::uuid[])`,
      [festi.sessionIds],
    );
    for (const r of rows) {
      expect(r.sold_count).toBe(r.valid);
      expect(r.credentials).toBe(r.valid);
    }
    expect(rows.reduce((n, r) => n + r.valid, 0)).toBe(festi.tickets);
    expect(festi.scans).toBeGreaterThan(5_000);
  });

  it("order search finds the right order by reference, email or name, through its indexes", async () => {
    const token = await tokenFor(seed.users.festiOwner);
    const search = async (q: string, clientId = seed.festi.clientId, brandId = seed.festi.brandId, user = token) =>
      (await call(app, "GET", `${adm(clientId, brandId)}/orders?q=${encodeURIComponent(q)}`, { token: user })).body.orders as
        { reference: string; buyerEmail: string; buyerName: string }[];
    const { reference, email, fullName } = festi.sample;

    expect((await search(reference.toLowerCase())).map((o) => o.reference)).toEqual([reference]);
    expect((await search(email.toUpperCase())).map((o) => o.buyerEmail)).toEqual([email]);
    expect((await search(fullName.slice(9))).map((o) => o.buyerName)).toContain(fullName);
    expect(await search("zzzz-nobody")).toEqual([]);
    // Havana never sees FESTI-ICE's orders, at any volume.
    const havanaToken = await tokenFor(seed.users.havanaOwner);
    expect(await search(reference, seed.havana.clientId, seed.havana.brandId, havanaToken)).toEqual([]);
    expect(await search(havana.sample.reference)).toEqual([]);

    // A term every volume buyer matches returns their latest orders, as a plain scan would.
    const everyone = await listOrders(db.pool, scope(), 50, undefined, "acheteur festi");
    const plain = async (before: Date | null) =>
      (await db.pool.query<{ reference: string }>(
        `SELECT o.reference FROM public.ticketing_orders o JOIN public.ticketing_buyers b ON b.id = o.buyer_id
         WHERE o.client_id = $1 AND o.brand_id = $2 AND b.full_name ILIKE 'acheteur festi%' AND ($3::timestamptz IS NULL OR o.created_at < $3)
         ORDER BY o.created_at DESC LIMIT 50`,
        [seed.festi.clientId, seed.festi.brandId, before],
      )).rows.map((r) => r.reference);
    expect(everyone.map((o) => o.reference)).toEqual(await plain(null));
    // Paging still applies inside a search.
    const before = everyone[49]!.createdAt as Date;
    const page2 = await listOrders(db.pool, scope(), 50, before.toISOString(), "acheteur festi");
    expect(page2.map((o) => o.reference)).toEqual(await plain(before));

    for (const q of [reference.toLowerCase(), email.toUpperCase(), fullName.slice(9), "zzzz-nobody"]) {
      expect(big(await seqScanned((db) => listOrders(db, scope(), 50, undefined, q))), q).toEqual([]);
    }
    const used = await indexesUsed((db) => listOrders(db, scope(), 50, undefined, fullName.slice(9)));
    expect(used).toContain("ticketing_buyers_name_search_idx");
    expect(used).toContain("ticketing_buyers_email_search_idx");
    expect(used).toContain("ticketing_orders_reference_search_idx");
  });

  it("the gate manifest and the attendee list read only their session", async () => {
    const sessionId = festi.pastSessionIds[0]!;
    const manifest = await sessionCredentials(db.pool, scope(), sessionId);
    const { rows } = await db.pool.query(`SELECT count(*)::int AS n FROM public.ticketing_credentials WHERE session_id = $1`, [sessionId]);
    expect(manifest).toHaveLength(rows[0].n);
    expect(manifest.filter((c) => c.admitted).length).toBeGreaterThan(rows[0].n / 2);
    expect(big(await seqScanned((db) => sessionCredentials(db, scope(), sessionId)))).toEqual([]);
    expect(big(await seqScanned((db) => attendeesRows(db, scope(), sessionId)))).toEqual([]);
  });

  it("a day's sales report and export read only that day's orders", async () => {
    const to = new Date();
    const from = new Date(to.getTime() - 86_400_000);
    const f = { from: from.toISOString(), to: to.toISOString() };
    const report = await salesReport(db.pool, scope(), f);
    const { rows } = await db.pool.query(
      `SELECT count(*)::int AS orders, coalesce(sum(total_cents), 0)::bigint AS gross FROM public.ticketing_orders
       WHERE client_id = $1 AND brand_id = $2 AND status IN ('paid', 'partially_refunded', 'refunded') AND exchange_of_order_id IS NULL
         AND paid_at >= $3 AND paid_at < $4`,
      [seed.festi.clientId, seed.festi.brandId, from, to],
    );
    expect(report.totals.orders).toBe(rows[0].orders);
    expect(String(report.totals.grossCents)).toBe(String(rows[0].gross));
    expect(rows[0].orders).toBeGreaterThan(100);
    expect(await ordersRows(db.pool, scope(), f)).toHaveLength(rows[0].orders);

    const used = await indexesUsed((db) => salesReport(db, scope(), f));
    expect(used).toContain("ticketing_orders_paid_idx");
    expect(big(await seqScanned((db) => ordersRows(db, scope(), f)))).toEqual([]);
  });

  it("the email worker finds a cancellation refund by order without reading every cancellation", async () => {
    const f = seed.festi;
    // Three cancelled sessions' worth of orders.
    for (const sessionId of festi.futureSessionIds.slice(0, 3)) {
      const { rows: job } = await db.pool.query<{ id: string }>(
        `INSERT INTO public.ticketing_session_cancellations (client_id, brand_id, event_id, session_id, reason)
         VALUES ($1, $2, $3, $4, 'volume') RETURNING id`,
        [f.clientId, f.brandId, f.eventId, sessionId],
      );
      await db.pool.query(
        `INSERT INTO public.ticketing_session_cancellation_orders (cancellation_id, client_id, brand_id, event_id, order_id)
         SELECT $1, client_id, brand_id, event_id, id FROM public.ticketing_orders WHERE session_id = $2`,
        [job[0]!.id, sessionId],
      );
    }
    await db.pool.query(`ANALYZE public.ticketing_session_cancellation_orders`);
    const plan = await planOf(
      `SELECT i.amount_cents FROM public.ticketing_session_cancellation_orders i
       WHERE i.order_id = $1 AND i.client_id = $2 AND i.brand_id = $3 ORDER BY i.created_at DESC LIMIT 1`,
      [f.orderId, f.clientId, f.brandId],
    );
    expect(nodes(plan).map((n) => n["Index Name"])).toContain("ticketing_session_cancellation_orders_order_idx");
  });

  it("every hot query answers well under a second at this volume", async () => {
    const s = scope();
    const sessionId = festi.pastSessionIds[0]!;
    const timings: Record<string, number> = {};
    const time = async (name: string, fn: (q: Db) => Promise<unknown>) => (timings[name] = (await statements(fn)).ms);
    await time("orders", (q) => listOrders(q, s, 50));
    await time("search", (q) => listOrders(q, s, 50, undefined, festi.sample.reference));
    await time("manifest", (q) => sessionCredentials(q, s, sessionId));
    await time("attendees", (q) => attendeesRows(q, s, sessionId));
    await time("report", (q) => salesReport(q, s, {}));
    for (const [name, ms] of Object.entries(timings)) expect(ms, `${name}: ${ms.toFixed(1)} ms`).toBeLessThan(1_000);
  });
});
