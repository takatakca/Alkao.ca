import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { FakeGateway } from "../helpers/fake-gateway.js";
import { seedAfterSale, seedTwoTenants, TEST_CREDENTIAL_SECRET, type SeedResult } from "../helpers/seed.js";

/**
 * Security sweep (Run 13): every admin route that takes an id is called by Havana's owner,
 * on Havana's own URL, with FESTI-ICE's ids, using a valid body so the request reaches the
 * database. None may succeed, and nothing of FESTI-ICE may change.
 */
let db: TestDatabase;
let seed: SeedResult;
let app: TestApp;

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  // Run 25: FESTI-ICE also has a Stripe dispute and a refund made in Stripe, so the sweep
  // watches those rows too.
  await seedAfterSale(db.pool, seed.festi, seed.festi.orderId);
  app = testApp(db.pool, { paymentGateway: new FakeGateway(), credentialMasterSecret: TEST_CREDENTIAL_SECRET, publicUrl: "https://billets.alkao.test" });
});

afterAll(async () => {
  await db?.drop();
});

async function festiSnapshot() {
  const c = seed.festi.clientId;
  const q = async (sql: string) => (await db.pool.query(sql, [c])).rows;
  return JSON.stringify({
    venues: await q(`SELECT id, name, updated_at FROM public.ticketing_venues WHERE client_id = $1 ORDER BY id`),
    events: await q(`SELECT id, title, status, updated_at FROM public.ticketing_events WHERE client_id = $1 ORDER BY id`),
    sessions: await q(`SELECT id, capacity, status, sold_count, reserved_count, updated_at FROM public.ticketing_sessions WHERE client_id = $1 ORDER BY id`),
    types: await q(`SELECT id, name, price_cents, updated_at FROM public.ticketing_ticket_types WHERE client_id = $1 ORDER BY id`),
    orders: await q(`SELECT id, status, refunded_cents FROM public.ticketing_orders WHERE client_id = $1 ORDER BY id`),
    promoCodes: await q(`SELECT id, code, active, max_uses, used_count, updated_at FROM public.ticketing_promo_codes WHERE client_id = $1 ORDER BY id`),
    tickets: await q(`SELECT id, status FROM public.ticketing_tickets WHERE client_id = $1 ORDER BY id`),
    refunds: await q(`SELECT id, status FROM public.ticketing_refunds WHERE client_id = $1 ORDER BY id`),
    credentials: await q(`SELECT id, status FROM public.ticketing_credentials WHERE client_id = $1 ORDER BY id`),
    scans: await q(`SELECT count(*)::int AS n FROM public.ticketing_scans WHERE client_id = $1`),
    emails: await q(`SELECT id, status FROM public.ticketing_email_outbox WHERE client_id = $1 ORDER BY id`),
    tokens: await q(`SELECT token_hash FROM public.ticketing_access_tokens WHERE client_id = $1 ORDER BY token_hash`),
    cancellations: await q(`SELECT id FROM public.ticketing_session_cancellations WHERE client_id = $1`),
    audit: await q(`SELECT count(*)::int AS n FROM public.ticketing_audit_log WHERE client_id = $1`),
    // Runs 19–23
    buyers: await q(`SELECT id, email, full_name, phone, updated_at FROM public.ticketing_buyers WHERE client_id = $1 ORDER BY id`),
    erasures: await q(`SELECT buyer_id FROM public.ticketing_buyer_erasures WHERE client_id = $1`),
    disputes: await q(`SELECT id, status, updated_at FROM public.ticketing_payment_disputes WHERE client_id = $1 ORDER BY id`),
    chargeRefunds: await q(`SELECT order_id, refunded_cents FROM public.ticketing_charge_refund_totals WHERE client_id = $1`),
    settings: await q(`SELECT checkout_return_origins, reminder_emails, marketing_sender_address, marketing_contact, newsletter_reward_code, newsletter_reward_text FROM public.ticketing_brand_settings WHERE client_id = $1`),
    // Run 41
    customers: await q(`SELECT id, email, email_opt_out_at, anonymized_at, updated_at FROM public.ticketing_customers WHERE client_id = $1 ORDER BY id`),
    bookings: await q(`SELECT id, customer_id, cancelled_on, updated_at FROM public.ticketing_customer_bookings WHERE client_id = $1 ORDER BY id`),
    // Run 42
    campaigns: await q(`SELECT id, status, subject, updated_at FROM public.ticketing_campaigns WHERE client_id = $1 ORDER BY id`),
    campaignMessages: await q(`SELECT id, status FROM public.ticketing_campaign_messages WHERE client_id = $1 ORDER BY id`),
    // Run 44
    signups: await q(`SELECT id, status, email_status FROM public.ticketing_newsletter_signups WHERE client_id = $1 ORDER BY id`),
  });
}

describe("tenant isolation sweep", () => {
  it("no admin route acts on another Client's records through its own URL", async () => {
    const h = seed.havana;
    const f = seed.festi;
    const { rows: refunds } = await db.pool.query<{ id: string }>(`SELECT id FROM public.ticketing_refunds WHERE client_id = $1 LIMIT 1`, [f.clientId]);
    const { rows: promo } = await db.pool.query<{ id: string }>(
      `INSERT INTO public.ticketing_promo_codes (client_id, brand_id, event_id, code, kind, percent) VALUES ($1, $2, $3, 'FESTIONLY', 'percent', 10) RETURNING id`,
      [f.clientId, f.brandId, f.eventId],
    );
    const { rows: customer } = await db.pool.query<{ id: string }>(
      `INSERT INTO public.ticketing_customers (client_id, brand_id, first_name, email) VALUES ($1, $2, 'Festi', 'festi-client@example.com') RETURNING id`,
      [f.clientId, f.brandId],
    );
    await db.pool.query(
      `INSERT INTO public.ticketing_customer_bookings (client_id, brand_id, customer_id, source, source_ref, category, starts_on, ends_on, first_report_on, last_report_on)
       VALUES ($1, $2, $3, 'reservation_camping', 'F-1', 'chalet', '2027-01-10', '2027-01-12', '2026-01-01', '2026-01-01')`,
      [f.clientId, f.brandId, customer[0]!.id],
    );
    const { rows: campaign } = await db.pool.query<{ id: string }>(
      `INSERT INTO public.ticketing_campaigns (client_id, brand_id, name, subject, heading, body) VALUES ($1, $2, 'Festi', 'Festi', 'Festi', 'Festi') RETURNING id`,
      [f.clientId, f.brandId],
    );
    await db.pool.query(
      `INSERT INTO public.ticketing_brand_settings (client_id, brand_id, marketing_sender_address, marketing_contact) VALUES ($1, $2, '1 rue Festi, Montréal', 'festi@example.com')
       ON CONFLICT (client_id, brand_id) DO UPDATE SET marketing_sender_address = EXCLUDED.marketing_sender_address, marketing_contact = EXCLUDED.marketing_contact`,
      [f.clientId, f.brandId],
    );
    const ids: Record<string, string> = {
      campaignId: campaign[0]!.id,
      customerId: customer[0]!.id,
      venueId: f.venueId, eventId: f.eventId, sessionId: f.sessionId, ticketTypeId: f.types[0]!.id,
      orderId: f.orderId, ticketId: f.ticketIds[0]!, refundId: refunds[0]!.id, holdId: f.holdId, promoCodeId: promo[0]!.id,
    };
    const bodies: Record<string, unknown> = {
      "PATCH /venues/:venueId": { name: "Pirate" },
      "PATCH /events/:eventId": { title: "Pirate" },
      "POST /events/:eventId/sessions": { startsAt: "2027-03-01T18:00:00Z", capacity: 10 },
      "PATCH /sessions/:sessionId": { capacity: 1 },
      "POST /events/:eventId/ticket-types": { code: "PIRATE", name: "Pirate", priceCents: 100, maxQuantity: 5 },
      "PATCH /ticket-types/:ticketTypeId": { name: "Pirate" },
      "POST /orders/:orderId/refunds": {},
      "POST /orders/:orderId/exchange": { sessionId: f.sessionId },
      "POST /sessions/:sessionId/cancel": { reason: "pirate" },
      // Runs 20–22: valid bodies and queries, so each reaches the database.
      "POST /orders/:orderId/tickets/void": { ticketIds: [f.ticketIds[0]], reason: "pirate" },
      // Run 29
      "POST /events/:eventId/sessions/batch": { fromDate: "2027-03-01", toDate: "2027-03-02", firstStart: "18:00", capacity: 10 },
      "POST /events/:eventId/sessions/status": { from: "draft", to: "on_sale" },
      // Run 36
      "POST /events/:eventId/promo-codes": { code: "PIRATE", kind: "percent", percent: 10 },
      "PATCH /promo-codes/:promoCodeId": { active: false },
      // Run 41
      "PATCH /customers/:customerId": { emailOptOut: true },
      // Run 42
      "PUT /campaigns/:campaignId": { name: "Pirate", subject: "Pirate", heading: "Pirate", body: "Pirate", audience: {} },
      "POST /campaigns/:campaignId/test": { email: "pirate@example.com" },
      "POST /campaigns/:campaignId/send": { expectedRecipients: 1 },
    };
    const { rows: festiOrder } = await db.pool.query<{ reference: string }>(`SELECT reference FROM public.ticketing_orders WHERE id = $1`, [f.orderId]);
    const queries: Record<string, string> = {
      "GET /sessions/:sessionId/lookup": `?reference=${festiOrder[0]!.reference}`,
    };
    const owner = await tokenFor(seed.users.havanaOwner);
    const before = await festiSnapshot();
    const prefix = "/v1/admin/clients/:clientId/brands/:brandId";
    const seen = new Set<string>();
    const results: string[] = [];
    for (const r of app.routes) {
      if (r.method === "ALL" || !r.path.startsWith(prefix)) continue;
      const rest = r.path.slice(prefix.length);
      if (!/:[A-Za-z]+/.test(rest) || seen.has(`${r.method} ${rest}`)) continue;
      seen.add(`${r.method} ${rest}`);
      const path = `/v1/admin/clients/${h.clientId}/brands/${h.brandId}${rest.replace(/:([A-Za-z]+)/g, (_, name: string) => ids[name] ?? "00000000-0000-4000-8000-000000000000")}`;
      const key = `${r.method} ${rest}`;
      const res = await call(app, r.method, `${path}${queries[key] ?? ""}`, { token: owner, ...(r.method === "GET" ? {} : { body: bodies[key] ?? {} }) });
      results.push(`${key} → ${res.status}`);
      expect(res.status, `${key} answered ${res.status}: ${JSON.stringify(res.body)}`).toBeGreaterThanOrEqual(400);
      expect([400, 403, 404, 409, 422]).toContain(res.status);
    }
    expect(results.length).toBeGreaterThanOrEqual(25);
    for (const key of ["GET /orders/:orderId/buyer/export", "POST /orders/:orderId/buyer/anonymize", "POST /orders/:orderId/tickets/void", "GET /sessions/:sessionId/lookup",
      "POST /events/:eventId/duplicate", "POST /events/:eventId/sessions/batch", "POST /events/:eventId/sessions/status", "GET /orders/:orderId/history",
      "GET /events/:eventId/promo-codes", "POST /events/:eventId/promo-codes", "PATCH /promo-codes/:promoCodeId",
      "GET /customers/:customerId", "PATCH /customers/:customerId", "POST /customers/:customerId/anonymize",
      "GET /campaigns/:campaignId", "PUT /campaigns/:campaignId", "POST /campaigns/:campaignId/test", "POST /campaigns/:campaignId/send", "POST /campaigns/:campaignId/cancel"]) {
      expect(results.some((r) => r.startsWith(`${key} → 404`)), `${key}: ${results.find((r) => r.startsWith(key))}`).toBe(true);
    }

    // Routes that take another Client's ids in the body rather than the path.
    const base = `/v1/admin/clients/${h.clientId}/brands/${h.brandId}`;
    for (const [path, body] of [
      ["/scanner/admit", { sessionId: f.sessionId, ticketId: f.ticketIds[0] }],
      ["/scanner/admit", { sessionId: h.sessionId, ticketId: f.ticketIds[0] }],
      ["/scanner/scans", { sessionId: f.sessionId, payload: "ALK1.x.y.z" }],
    ] as const) {
      const res = await call(app, "POST", `${base}${path}`, { token: owner, body });
      expect(res.status, `${path} ${JSON.stringify(body)} → ${res.status}`).toBe(404);
    }
    expect(await festiSnapshot()).toBe(before);
  });

  it("no public route serves another Client's hold or order through its own URL", async () => {
    const h = seed.havana;
    const f = seed.festi;
    const base = `/v1/public/clients/${h.clientId}/brands/${h.brandId}`;
    const before = await festiSnapshot();
    for (const [method, path, header] of [
      ["GET", `${base}/holds/${f.holdId}`, "x-alkao-hold-token"],
      ["DELETE", `${base}/holds/${f.holdId}`, "x-alkao-hold-token"],
      ["GET", `${base}/orders/${f.orderId}`, "x-alkao-order-token"],
      ["POST", `${base}/orders/${f.orderId}/exchange`, "x-alkao-order-token"],
      ["GET", `${base}/events/${f.eventId}`, ""],
    ] as const) {
      const res = await call(app, method, path, { headers: header ? { [header]: "x".repeat(43) } : {}, ...(method === "POST" ? { body: { sessionId: f.sessionId } } : {}) });
      expect([403, 404, 409], `${method} ${path} → ${res.status}`).toContain(res.status);
    }
    expect(await festiSnapshot()).toBe(before);
  });
});

describe("request hardening", () => {
  it("refuses oversized bodies before parsing them", async () => {
    const h = seed.havana;
    const res = await call(app, "POST", `/v1/public/clients/${h.clientId}/brands/${h.brandId}/events/${h.eventId}/quote`, {
      body: JSON.stringify({ items: [], pad: "x".repeat(300 * 1024) }),
    });
    expect(res).toMatchObject({ status: 413, body: { error: { code: "payload_too_large" } } });
  });

  it("marks API responses as not cacheable, not sniffable and not frameable, with HSTS", async () => {
    const res = await app.request(`/v1/public/clients/${seed.havana.clientId}/brands/${seed.havana.brandId}/events`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("strict-transport-security")).toContain("max-age=");
  });

  it("rate-limits by the address our proxy saw, not by a forged X-Forwarded-For", async () => {
    const limited = testApp(db.pool, { publicHoldsPerMinute: 2 });
    const h = seed.havana;
    const hold = (xff: string) =>
      call(limited, "POST", `/v1/public/clients/${h.clientId}/brands/${h.brandId}/holds`, {
        headers: { "x-forwarded-for": xff },
        body: { sessionId: h.sessionId, items: [{ ticketTypeId: h.types.find((t) => t.code === "TODDLER")!.id, quantity: 1 }] },
      });
    // The attacker rotates the left part; the right-most entry is what our proxy appended.
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await hold(`10.0.0.${i}, 203.0.113.9`)).status);
    expect(statuses.slice(2)).toEqual([429, 429]);
    // Another real client is not affected.
    expect((await hold("198.51.100.4")).status).not.toBe(429);
  });
});
