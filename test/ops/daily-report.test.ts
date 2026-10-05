import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTransaction } from "../../src/db/pool.js";
import { dailyReport } from "../../src/ops/reports.js";
import { adm, call, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { seedTwoTenants, type SeedResult, type TenantFixture } from "../helpers/seed.js";

/**
 * Run 26: sales day by day, for the accountant. Sales count on the day they were paid, in the
 * venue's time zone; refunds on the day Stripe completed them.
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

/** A 10 $ order with 0,50 $ TPS and 1,00 $ TVQ, paid at `paidAt`, the way checkout records it. */
async function paidAt(t: TenantFixture, paidAt: string, reference: string) {
  const general = t.types.find((x) => x.code === "GENERAL")!;
  return withTransaction(db.pool, async (tx) => {
    const { rows: buyer } = await tx.query<{ id: string }>(
      `INSERT INTO public.ticketing_buyers (client_id, brand_id, email) VALUES ($1, $2, $3) RETURNING id`,
      [t.clientId, t.brandId, `${reference.toLowerCase()}@example.com`],
    );
    const { rows: order } = await tx.query<{ id: string }>(
      `INSERT INTO public.ticketing_orders (client_id, brand_id, event_id, session_id, buyer_id, reference, subtotal_cents, tax_cents, total_cents, commission_cents)
       VALUES ($1, $2, $3, $4, $5, $6, 1000, 150, 1150, 60) RETURNING id`,
      [t.clientId, t.brandId, t.eventId, t.sessionId, buyer[0]!.id, reference],
    );
    await tx.query(
      `INSERT INTO public.ticketing_order_lines (order_id, client_id, brand_id, event_id, ticket_type_id, kind, code_snapshot, name_snapshot, quantity, unit_price_cents, line_total_cents)
       VALUES ($1, $2, $3, $4, $5, 'admission', 'GENERAL', 'Général', 1, 1000, 1000)`,
      [order[0]!.id, t.clientId, t.brandId, t.eventId, general.id],
    );
    await tx.query(
      `INSERT INTO public.ticketing_order_taxes (order_id, client_id, brand_id, event_id, code, rate_ppm, taxable_cents, amount_cents)
       VALUES ($1, $2, $3, $4, 'GST', 50000, 1000, 50), ($1, $2, $3, $4, 'QST', 99750, 1000, 100)`,
      [order[0]!.id, t.clientId, t.brandId, t.eventId],
    );
    await tx.query(`UPDATE public.ticketing_orders SET status = 'paid', paid_at = $2 WHERE id = $1`, [order[0]!.id, paidAt]);
    return order[0]!.id;
  });
}

/** A 5 $ refund on that order, completed by Stripe now. */
async function refund(t: TenantFixture, orderId: string) {
  await withTransaction(db.pool, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO public.ticketing_refunds (client_id, brand_id, event_id, order_id, amount_cents, commission_refund_cents, requested_by)
       VALUES ($1, $2, $3, $4, 500, 26, 'user') RETURNING id`,
      [t.clientId, t.brandId, t.eventId, orderId],
    );
    await tx.query(`UPDATE public.ticketing_refunds SET status = 'succeeded' WHERE id = $1`, [rows[0]!.id]);
    await tx.query(`UPDATE public.ticketing_orders SET refunded_cents = 500, commission_refunded_cents = 26, status = 'partially_refunded' WHERE id = $1`, [orderId]);
  });
}

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", dateStyle: "short" }).format(new Date());
const scope = (t: TenantFixture) => ({ clientId: t.clientId, brandId: t.brandId });

describe("the day-by-day report", () => {
  it("puts each sale on its paying day in the venue's time zone, and each refund on the day it was made", async () => {
    const f = seed.festi;
    // 23:30 on Feb 28 and 00:30 on Mar 1 in Montréal: two days, although 1 h apart.
    const lateFeb = await paidAt(f, "2026-03-01T04:30:00Z", "FEBR-2828");
    await paidAt(f, "2026-03-01T05:30:00Z", "MARS-0101");
    const todayBefore = (await dailyReport(db.pool, scope(f), {})).days.find((d) => d.day === today());
    await refund(f, lateFeb);

    const window = await dailyReport(db.pool, scope(f), { from: "2026-02-27T00:00:00Z", to: "2026-03-03T00:00:00Z" });
    expect(window.timeZone).toBe("America/Toronto");
    expect(window.days).toEqual([
      { day: "2026-02-28", orders: 1, subtotalCents: 1000, taxCents: 150, gstCents: 50, qstCents: 100, grossCents: 1150, refunds: 0, refundedCents: 0, commissionCents: 60, commissionRefundedCents: 0, netToClientCents: 1090 },
      { day: "2026-03-01", orders: 1, subtotalCents: 1000, taxCents: 150, gstCents: 50, qstCents: 100, grossCents: 1150, refunds: 0, refundedCents: 0, commissionCents: 60, commissionRefundedCents: 0, netToClientCents: 1090 },
    ]);
    expect(window.totals).toMatchObject({ orders: 2, grossCents: 2300, gstCents: 100, qstCents: 200, netToClientCents: 2180 });

    // The refund was made today: it is added to today's row, not to the day of the sale.
    const all = await dailyReport(db.pool, scope(f), {});
    const now = all.days.find((d) => d.day === today())!;
    expect(now.refunds - (todayBefore?.refunds ?? 0)).toBe(1);
    expect(now.refundedCents - (todayBefore?.refundedCents ?? 0)).toBe(500);
    expect(now.commissionRefundedCents - (todayBefore?.commissionRefundedCents ?? 0)).toBe(26);
    expect(all.days.find((d) => d.day === "2026-02-28")).toMatchObject({ refundedCents: 0 });
    // Totals add up to the rows, and net = gross − refunds − net commission.
    const sum = (k: "grossCents" | "refundedCents" | "netToClientCents") => all.days.reduce((n, d) => n + d[k], 0);
    expect(all.totals.grossCents).toBe(sum("grossCents"));
    expect(all.totals.netToClientCents).toBe(sum("netToClientCents"));
    expect(all.totals.netToClientCents).toBe(all.totals.grossCents - all.totals.refundedCents - (all.totals.commissionCents - all.totals.commissionRefundedCents));
  });

  it("filters by event, and never mixes another Client's sales", async () => {
    const f = seed.festi;
    const h = seed.havana;
    await paidAt(f, "2026-04-10T15:00:00Z", "AVRK-1010");
    const otherEvent = await dailyReport(db.pool, scope(f), { eventId: h.eventId });
    expect(otherEvent.days).toEqual([]);
    const havana = await dailyReport(db.pool, scope(h), {});
    expect(havana.days.map((d) => d.day)).not.toContain("2026-04-10");
    expect(havana.days.map((d) => d.day)).not.toContain("2026-02-28");
  });

  it("is served as JSON and as a CSV for the accountant, to managers but not gate staff", async () => {
    const f = seed.festi;
    const base = adm(f.clientId, f.brandId);
    const owner = await tokenFor(seed.users.festiOwner);
    const q = "?from=2026-02-27T00:00:00Z&to=2026-03-03T00:00:00Z";
    const json = await call(app, "GET", `${base}/reports/daily${q}`, { token: owner });
    expect(json.status).toBe(200);
    expect(json.body.report.days.map((d: { day: string }) => d.day)).toEqual(["2026-02-28", "2026-03-01"]);

    const res = await app.request(`${base}/reports/daily.csv${q}`, { headers: { authorization: `Bearer ${owner}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="alkao-ventes-par-jour.csv"');
    const lines = (await res.text()).trim().split("\r\n");
    expect(lines[0]).toBe("day,orders,subtotal_cents,tax_cents,gst_cents,qst_cents,gross_cents,refunds,refunded_cents,commission_cents,commission_refunded_cents,net_to_client_cents");
    expect(lines.slice(1)).toEqual(["2026-02-28,1,1000,150,50,100,1150,0,0,60,0,1090", "2026-03-01,1,1000,150,50,100,1150,0,0,60,0,1090"]);
    const { rows } = await db.pool.query(`SELECT count(*)::int AS n FROM public.ticketing_audit_log WHERE action = 'reports.daily_exported'`);
    expect(rows[0].n).toBe(1);

    const h = seed.havana;
    expect((await call(app, "GET", `${adm(h.clientId, h.brandId)}/reports/daily`, { token: await tokenFor(seed.users.havanaStaff) })).status).toBe(403);
    expect((await call(app, "GET", `${base}/reports/daily?from=2026-03-03T00:00:00Z&to=2026-03-01T00:00:00Z`, { token: owner })).status).toBe(400);
  });
});
