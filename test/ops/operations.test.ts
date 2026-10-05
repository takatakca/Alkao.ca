import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { csvCell, toCsv } from "../../src/ops/csv.js";
import { sweepExpiredHolds } from "../../src/ops/sweeper.js";
import { adm, call, pub, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { seedPaidOrder, seedTwoTenants, type SeedResult, type TenantFixture } from "../helpers/seed.js";

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

const typeId = (t: TenantFixture, code: string) => t.types.find((x) => x.code === code)!.id;

describe("CSV safety", () => {
  it("quotes separators and neutralizes spreadsheet formulas", () => {
    expect(csvCell("Tremblay, Marie")).toBe('"Tremblay, Marie"');
    expect(csvCell('Le "Patineur"')).toBe('"Le ""Patineur"""');
    expect(csvCell("=HYPERLINK(\"http://evil\")")).toBe("\"'=HYPERLINK(\"\"http://evil\"\")\"");
    expect(csvCell("+1 514")).toBe("'+1 514");
    expect(csvCell("-5")).toBe("'-5");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell(null)).toBe("");
    expect(csvCell(new Date("2026-12-20T18:00:00Z"))).toBe("2026-12-20T18:00:00.000Z");
    expect(toCsv(["a", "b"], [[1, "x"]])).toBe("a,b\r\n1,x\r\n");
  });
});

describe("holds sweeper and public availability", () => {
  it("shows lapsed holds as available at once, and the sweeper returns their seats", async () => {
    const t = seed.havana;
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO public.ticketing_sessions (client_id, brand_id, event_id, starts_at, capacity, status)
       VALUES ($1, $2, $3, now() + interval '40 days', 4, 'on_sale') RETURNING id`,
      [t.clientId, t.brandId, t.eventId],
    );
    const sessionId = rows[0]!.id;
    let clock = new Date();
    const timed = testApp(db.pool, { now: () => clock, holdTtlSeconds: 60 });
    const held = await call(timed, "POST", `${pub(t.clientId, t.brandId)}/holds`, {
      body: { sessionId, items: [{ ticketTypeId: typeId(t, "GENERAL"), quantity: 3 }] },
    });
    expect(held.status).toBe(201);
    const available = async () => {
      const res = await call(timed, "GET", `${pub(t.clientId, t.brandId)}/events/${t.eventId}`);
      return res.body.sessions.find((s: { id: string }) => s.id === sessionId).available;
    };
    expect(await available()).toBe(1);
    clock = new Date(clock.getTime() + 61_000);
    expect(await available()).toBe(4); // lapsed hold no longer shown as taken

    expect(await sweepExpiredHolds(db.pool, clock)).toBeGreaterThanOrEqual(1);
    const { rows: s } = await db.pool.query(`SELECT reserved_count FROM public.ticketing_sessions WHERE id = $1`, [sessionId]);
    expect(s[0].reserved_count).toBe(0);
    expect(await sweepExpiredHolds(db.pool, clock)).toBe(0);
  });
});

describe("sales report", () => {
  it("reconciles money to the cent with the order ledger", async () => {
    const f = seed.festi;
    await seedPaidOrder(db.pool, f);
    const token = await tokenFor(seed.users.festiOwner);
    const res = await call(app, "GET", `${adm(f.clientId, f.brandId)}/reports/sales?eventId=${f.eventId}`, { token });
    expect(res.status).toBe(200);
    const r = res.body.report;

    const { rows } = await db.pool.query(
      `SELECT count(*)::int AS orders, sum(total_cents)::int AS gross, sum(tax_cents)::int AS tax, sum(refunded_cents)::int AS refunded,
              sum(commission_cents)::int AS commission, sum(commission_refunded_cents)::int AS commission_refunded
       FROM public.ticketing_orders WHERE client_id = $1 AND status IN ('paid', 'partially_refunded', 'refunded')`,
      [f.clientId],
    );
    const ledger = rows[0];
    expect(r.totals).toMatchObject({
      orders: ledger.orders,
      grossCents: ledger.gross,
      taxCents: ledger.tax,
      refundedCents: ledger.refunded,
      commissionCents: ledger.commission,
      commissionRefundedCents: ledger.commission_refunded,
      netToClientCents: ledger.gross - ledger.refunded - (ledger.commission - ledger.commission_refunded),
    });
    expect(r.totals.taxes.GST + r.totals.taxes.QST).toBe(ledger.tax);
    expect(r.totals.subtotalCents + r.totals.taxCents).toBe(r.totals.grossCents);
    const ticketRevenue = r.ticketTypes.reduce((n: number, l: { revenueCents: number }) => n + l.revenueCents, 0);
    expect(ticketRevenue).toBe(r.totals.subtotalCents);

    const main = r.sessions.find((s: { sessionId: string }) => s.sessionId === f.sessionId);
    const { rows: sess } = await db.pool.query(`SELECT capacity, sold_count, reserved_count FROM public.ticketing_sessions WHERE id = $1`, [f.sessionId]);
    expect(main).toMatchObject({ capacity: sess[0].capacity, sold: sess[0].sold_count, held: sess[0].reserved_count });

    // Another Client's money never appears.
    const { rows: hv } = await db.pool.query(`SELECT sum(total_cents)::int AS g FROM public.ticketing_orders WHERE client_id = $1`, [seed.havana.clientId]);
    expect(hv[0].g).toBeGreaterThan(0);
    const empty = await call(app, "GET", `${adm(f.clientId, f.brandId)}/reports/sales?eventId=${seed.havana.eventId}`, { token });
    expect(empty.body.report.totals.orders).toBe(0);
    expect(empty.body.report.sessions).toEqual([]);
  });

  it("filters by payment date", async () => {
    const f = seed.festi;
    const token = await tokenFor(seed.users.festiOwner);
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const res = await call(app, "GET", `${adm(f.clientId, f.brandId)}/reports/sales?from=${encodeURIComponent(future)}`, { token });
    expect(res.body.report.totals).toMatchObject({ orders: 0, grossCents: 0, netToClientCents: 0 });
    const bad = await call(app, "GET", `${adm(f.clientId, f.brandId)}/reports/sales?from=${encodeURIComponent(future)}&to=${encodeURIComponent(new Date().toISOString())}`, { token });
    expect(bad.status).toBe(400);
  });
});

describe("exports", () => {
  it("exports a session's attendees as CSV, audited, for managers only", async () => {
    const t = seed.havana;
    await db.pool.query(`UPDATE public.ticketing_buyers SET full_name = '=cmd|calc' WHERE client_id = $1`, [t.clientId]);
    const owner = await tokenFor(seed.users.havanaOwner);
    const res = await app.request(`${adm(t.clientId, t.brandId)}/reports/attendees.csv?sessionId=${t.sessionId}`, {
      headers: { authorization: `Bearer ${owner}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    const body = await res.text();
    const lines = body.trim().split("\r\n");
    expect(lines[0]).toBe("order_reference,ticket_id,ticket_type,ticket_type_name,buyer_name,buyer_email,ticket_status,admitted_at");
    const { rows } = await db.pool.query(`SELECT count(*)::int AS n FROM public.ticketing_tickets WHERE session_id = $1`, [t.sessionId]);
    expect(lines).toHaveLength(rows[0].n + 1);
    expect(body).toContain("'=cmd|calc");
    expect(body).not.toContain(seed.festi.clientId);

    const { rows: audit } = await db.pool.query(`SELECT action FROM public.ticketing_audit_log WHERE client_id = $1 AND action LIKE 'reports.%'`, [t.clientId]);
    expect(audit.map((a) => a.action)).toEqual(["reports.attendees_exported"]);

    const staff = await tokenFor(seed.users.havanaStaff);
    expect((await call(app, "GET", `${adm(t.clientId, t.brandId)}/reports/attendees.csv?sessionId=${t.sessionId}`, { token: staff })).status).toBe(403);
    expect((await call(app, "GET", `${adm(t.clientId, t.brandId)}/reports/sales`, { token: staff })).status).toBe(403);
    const festiOwner = await tokenFor(seed.users.festiOwner);
    const cross = await app.request(`${adm(seed.festi.clientId, seed.festi.brandId)}/reports/attendees.csv?sessionId=${t.sessionId}`, {
      headers: { authorization: `Bearer ${festiOwner}` },
    });
    expect((await cross.text()).trim().split("\r\n")).toHaveLength(1); // header only
  });

  it("exports paid orders as CSV", async () => {
    const t = seed.havana;
    const owner = await tokenFor(seed.users.havanaOwner);
    const res = await app.request(`${adm(t.clientId, t.brandId)}/reports/orders.csv`, { headers: { authorization: `Bearer ${owner}` } });
    const lines = (await res.text()).trim().split("\r\n");
    const { rows } = await db.pool.query(
      `SELECT count(*)::int AS n FROM public.ticketing_orders WHERE client_id = $1 AND status IN ('paid', 'partially_refunded', 'refunded')`,
      [t.clientId],
    );
    expect(lines).toHaveLength(rows[0].n + 1);
    expect(lines[0]).toContain("commission_cents");
  });
});
