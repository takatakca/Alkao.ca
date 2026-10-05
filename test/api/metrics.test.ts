import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHold } from "../../src/db/commerce.js";
import { withTransaction } from "../../src/db/pool.js";
import { collectMetrics } from "../../src/ops/metrics.js";
import { testApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { seedTwoTenants, type SeedResult } from "../helpers/seed.js";

/** Run 24: platform health for monitoring, behind a bearer token, with no tenant data. */
const TOKEN = "metrics-test-token-0123456789abcdef0123";
let db: TestDatabase;
let seed: SeedResult;

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
});

afterAll(async () => {
  await db?.drop();
});

const value = (text: string, metric: string) => {
  const line = text.split("\n").find((l) => l.startsWith(`${metric} `));
  return line ? Number(line.split(" ")[1]) : undefined;
};

describe("GET /metrics", () => {
  it("does not exist without a token, and refuses a missing or wrong one", async () => {
    expect((await testApp(db.pool).request("/metrics")).status).toBe(404);
    const app = testApp(db.pool, { metricsToken: TOKEN });
    expect((await app.request("/metrics")).status).toBe(401);
    expect((await app.request("/metrics", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await app.request("/metrics", { headers: { authorization: TOKEN } })).status).toBe(401);
    const ok = await app.request("/metrics", { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
    expect(ok.headers.get("cache-control")).toBe("no-store");
  });

  it("reports what the alerts watch, in the Prometheus format, and nothing about any Client", async () => {
    const h = seed.havana;
    // A refund Stripe failed on, and emails due an hour ago that the worker never sent.
    await db.pool.query(
      `INSERT INTO public.ticketing_refunds (client_id, brand_id, event_id, order_id, amount_cents, commission_refund_cents, requested_by, last_error)
       VALUES ($1, $2, $3, $4, 100, 0, 'user', 'refund_payment')`,
      [h.clientId, h.brandId, h.eventId, h.orderId],
    );
    await db.pool.query(`UPDATE public.ticketing_email_outbox SET next_attempt_at = now() - interval '1 hour' WHERE status = 'pending'`);

    const text = await collectMetrics(db.pool);
    for (const name of ["alkao_up", "alkao_email_pending_total", "alkao_email_oldest_due_seconds", "alkao_refunds_stuck_total", "alkao_holds_unswept_total", "alkao_disputes_open_total"]) {
      expect(text).toContain(`# TYPE ${name} gauge`);
    }
    expect(value(text, "alkao_up")).toBe(1);
    expect(value(text, "alkao_refunds_stuck_total")).toBe(1);
    expect(value(text, "alkao_email_pending_total")).toBeGreaterThan(0);
    expect(value(text, "alkao_email_oldest_due_seconds")).toBeGreaterThanOrEqual(3600);
    expect(value(text, "alkao_holds_unswept_total")).toBe(0);
    expect(text).toMatch(/^alkao_payment_events_total\{outcome="processed"\} \d+$/m);
    // A buyer's hold, then three hours with no sweeper: it shows as unswept.
    const general = h.types.find((t) => t.code === "GENERAL")!;
    await withTransaction(db.pool, (tx) =>
      createHold(tx, {
        clientId: h.clientId, brandId: h.brandId, eventId: h.eventId, sessionId: h.sessionId, admissions: 1,
        items: [{ ticketTypeId: general.id, quantity: 1, unitPriceCents: general.priceCents }], expiresAt: new Date(Date.now() + 600_000),
      }),
    );
    expect(value(await collectMetrics(db.pool), "alkao_holds_active_total")).toBe(1);
    const later = await collectMetrics(db.pool, new Date(Date.now() + 3 * 3_600_000));
    expect(value(later, "alkao_holds_unswept_total")).toBeGreaterThan(0);
    // Platform-wide counts only.
    for (const secret of [h.clientId, h.brandId, seed.festi.clientId, "example.com", "Havana", "FESTI"]) expect(text).not.toContain(secret);
    expect(text.endsWith("\n")).toBe(true);
  });
});
