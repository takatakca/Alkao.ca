import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { rulesOnSale, type TicketTypeRule } from "../../src/domain/catalog.js";
import { adm, call, pub, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { completedSession, FakeGateway, signedStripeEvent } from "../helpers/fake-gateway.js";
import { seedTwoTenants, type SeedResult, type TenantFixture } from "../helpers/seed.js";

/**
 * Run 97: presale tickets (a cheaper ticket that ends on a date or after a number sold, for
 * the whole event) and coupons (a promo code shown to every buyer). Made-up buyers only.
 */
let db: TestDatabase;
let seed: SeedResult;
let gateway: FakeGateway;
let app: TestApp;
let t: TenantFixture;
let presaleId = "";

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  t = seed.havana;
});

beforeEach(() => {
  gateway = new FakeGateway();
  app = testApp(db.pool, { paymentGateway: gateway });
});

afterAll(async () => {
  await db?.drop();
});

const owner = () => tokenFor(seed.users.havanaOwner);
const general = () => t.types.find((x) => x.code === "GENERAL")!;
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
const createType = async (body: Record<string, unknown>) =>
  call(app, "POST", `${adm(t.clientId, t.brandId)}/events/${t.eventId}/ticket-types`, { token: await owner(), body });
const presaleBody = (extra: Record<string, unknown> = {}) => ({
  code: "GENERAL_PRE", name: "Admission générale — Prévente", priceCents: 2395, maxQuantity: 10, countsAsAdult: true,
  presaleOf: general().id, salesEndAt: inDays(10), quantityLimit: 3, ...extra,
});
const publicEvent = async (a: TestApp = app) => (await call(a, "GET", `${pub(t.clientId, t.brandId)}/events/${t.eventId}`)).body;
const hold = (cart: { ticketTypeId: string; quantity: number }[], promoCode?: string) =>
  call(app, "POST", `${pub(t.clientId, t.brandId)}/holds`, { body: { sessionId: t.sessionId, items: cart, ...(promoCode ? { promoCode } : {}) } });
const counts = async () =>
  (await db.pool.query(`SELECT reserved_count, sold_count FROM public.ticketing_ticket_type_counts WHERE ticket_type_id = $1`, [presaleId])).rows[0];
const remaining = async (a: TestApp = app) =>
  (await publicEvent(a)).ticketTypes.find((x: { id: string }) => x.id === presaleId)?.remaining as number | undefined;

async function pay(h: { id: string; token: string; quote: { totalCents: number } }) {
  const co = await call(app, "POST", `${pub(t.clientId, t.brandId)}/holds/${h.id}/checkout`, {
    headers: { "x-alkao-hold-token": h.token },
    body: { buyer: { email: `prevente-${randomUUID().slice(0, 6)}@example.com` }, successUrl: `${t.returnOrigin}/ok`, cancelUrl: `${t.returnOrigin}/ko` },
  });
  expect(co.status, JSON.stringify(co.body)).toBe(201);
  const e = signedStripeEvent("checkout.session.completed", completedSession(co.body.checkoutUrl.split("/").pop(), h.quote.totalCents, `pi_${randomUUID().slice(0, 8)}`), t.stripeAccountId);
  expect((await call(app, "POST", "/v1/webhooks/stripe", { body: e.body, headers: { "stripe-signature": e.signature } })).body.outcome).toBe("processed");
  return co.body.order as { id: string; token: string };
}

describe("presale tickets", () => {
  it("a type whose sale has ended is sold no more", () => {
    const base: TicketTypeRule = { ...general(), salesEndAt: new Date("2026-11-01T04:00:00Z") };
    expect(rulesOnSale([base], new Date("2026-10-31T12:00:00Z"))[0]!.active).toBe(true);
    expect(rulesOnSale([base], new Date("2026-11-01T04:00:00Z"))[0]!.active).toBe(false);
    expect(rulesOnSale([{ ...base, salesEndAt: null }], new Date("2030-01-01"))[0]!.active).toBe(true);
  });

  it("undercut a regular ticket of the same event, and always end", async () => {
    expect((await createType(presaleBody({ priceCents: 2995 }))).body.error.code).toBe("presale_price_not_lower");
    expect((await createType(presaleBody({ salesEndAt: null, quantityLimit: null }))).status).toBe(400);
    const addOn = t.types.find((x) => x.kind === "add_on")!;
    expect((await createType(presaleBody({ code: "FLEX_PRE", kind: "add_on", addOnScope: "per_admission", presaleOf: addOn.id, countsAsAdult: false, priceCents: 100 }))).status).toBe(400);
    // A ticket of another Brand's event is not a ticket of this event.
    const other = seed.festi.types.find((x) => x.code === "GENERAL")!.id;
    expect((await createType(presaleBody({ presaleOf: other }))).status).toBe(422);

    const made = await createType(presaleBody());
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    presaleId = made.body.ticketType.id;
    expect(made.body.ticketType).toMatchObject({ presaleOf: general().id, quantityLimit: 3, priceCents: 2395 });

    // The regular price cannot drop to the presale's (or below).
    const lower = await call(app, "PATCH", `${adm(t.clientId, t.brandId)}/ticket-types/${general().id}`, { token: await owner(), body: { priceCents: 2395 } });
    expect(lower.body.error.code).toBe("presale_price_not_lower");
  });

  it("are shown with the regular ticket they undercut, their end and what is left", async () => {
    const body = await publicEvent();
    const pre = body.ticketTypes.find((x: { id: string }) => x.id === presaleId);
    expect(pre).toMatchObject({ code: "GENERAL_PRE", presaleOf: general().id, quantityLimit: 3, remaining: 3 });
    expect(new Date(pre.salesEndAt).getTime()).toBeGreaterThan(Date.now());
    expect(body.ticketTypes.find((x: { id: string }) => x.id === general().id).remaining).toBeNull();
  });

  it("a cart reserves them for the whole event, and cannot take more than is left", async () => {
    const first = await hold([{ ticketTypeId: presaleId, quantity: 2 }]);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.hold.quote.lines[0]).toMatchObject({ code: "GENERAL_PRE", unitPriceCents: 2395 });
    expect(await counts()).toEqual({ reserved_count: 2, sold_count: 0 });
    expect(await remaining()).toBe(1);
    const second = await hold([{ ticketTypeId: presaleId, quantity: 2 }]);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("ticket_type_sold_out");
    // The regular ticket is still there.
    const regular = await hold([{ ticketTypeId: general().id, quantity: 2 }]);
    expect(regular.status).toBe(201);
    const release = (h: { id: string; token: string }) =>
      call(app, "DELETE", `${pub(t.clientId, t.brandId)}/holds/${h.id}`, { headers: { "x-alkao-hold-token": h.token } });
    await release(first.body.hold);
    await release(regular.body.hold);
    expect(await counts()).toEqual({ reserved_count: 0, sold_count: 0 });
    expect(await remaining()).toBe(3);
  });

  it("an abandoned cart past its deadline never takes a ticket, even before the sweep", async () => {
    const brief = testApp(db.pool, { paymentGateway: gateway, holdTtlSeconds: 1 });
    const lapsing = await call(brief, "POST", `${pub(t.clientId, t.brandId)}/holds`, { body: { sessionId: t.sessionId, items: [{ ticketTypeId: presaleId, quantity: 3 }] } });
    expect(lapsing.status, JSON.stringify(lapsing.body)).toBe(201);
    expect(await remaining()).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(await remaining()).toBe(3);
    const next = await hold([{ ticketTypeId: presaleId, quantity: 3 }]);
    expect(next.status, JSON.stringify(next.body)).toBe(201);
    await call(app, "DELETE", `${pub(t.clientId, t.brandId)}/holds/${next.body.hold.id}`, { headers: { "x-alkao-hold-token": next.body.hold.token } });
    await db.pool.query(`UPDATE public.ticketing_holds SET status = 'expired' WHERE id = $1 AND status = 'active'`, [lapsing.body.hold.id]);
    expect(await counts()).toEqual({ reserved_count: 0, sold_count: 0 });
  });

  it("a paid order keeps them; a full refund gives them back", async () => {
    const h = await hold([{ ticketTypeId: presaleId, quantity: 2 }]);
    const order = await pay(h.body.hold);
    expect(await counts()).toEqual({ reserved_count: 0, sold_count: 2 });
    expect(await remaining()).toBe(1);
    const refund = await call(app, "POST", `${adm(t.clientId, t.brandId)}/orders/${order.id}/refunds`, { token: await owner(), body: {} });
    expect(refund.body.refund.status).toBe("succeeded");
    expect(await counts()).toEqual({ reserved_count: 0, sold_count: 0 });
  });

  it("a limit set later starts from what is already sold, and never goes below it", async () => {
    const patch = async (body: Record<string, unknown>) =>
      call(app, "PATCH", `${adm(t.clientId, t.brandId)}/ticket-types/${presaleId}`, { token: await owner(), body });
    await pay((await hold([{ ticketTypeId: presaleId, quantity: 1 }])).body.hold);
    // Without a limit for a while, a sale is not counted…
    expect((await patch({ quantityLimit: null })).status).toBe(200);
    await pay((await hold([{ ticketTypeId: presaleId, quantity: 1 }])).body.hold);
    // …and a limit set again counts both, refusing one below them.
    const tooLow = await patch({ quantityLimit: 1 });
    expect(tooLow.status).toBe(409);
    expect(tooLow.body.error.code).toBe("quantity_limit_below_committed");
    const raised = await patch({ quantityLimit: 5 });
    expect(raised.status, JSON.stringify(raised.body)).toBe(200);
    expect(await counts()).toEqual({ reserved_count: 0, sold_count: 2 });
    expect(await remaining()).toBe(3);
    const staff = await call(app, "GET", `${adm(t.clientId, t.brandId)}/events/${t.eventId}/ticket-types`, { token: await owner() });
    expect(staff.body.ticketTypes.find((x: { id: string }) => x.id === presaleId)).toMatchObject({ quotaSold: 2, quotaReserved: 0 });
  });

  it("a copied event keeps its presale, against the copy's own regular ticket, moved with the dates", async () => {
    const copy = await call(app, "POST", `${adm(t.clientId, t.brandId)}/events/${t.eventId}/duplicate`, { token: await owner(), body: { shiftDays: 7 } });
    expect(copy.status, JSON.stringify(copy.body)).toBe(201);
    const { rows } = await db.pool.query(
      `SELECT p.code, p.quantity_limit, p.sales_end_at, r.code AS regular_code, r.event_id = p.event_id AS same_event,
              (SELECT sales_end_at FROM public.ticketing_ticket_types WHERE id = $2) AS original_end
       FROM public.ticketing_ticket_types p JOIN public.ticketing_ticket_types r ON r.id = p.presale_of
       WHERE p.event_id = $1`,
      [copy.body.event.id, presaleId],
    );
    expect(rows).toEqual([expect.objectContaining({ code: "GENERAL_PRE", quantity_limit: 5, regular_code: "GENERAL", same_event: true })]);
    expect(rows[0].sales_end_at.getTime() - rows[0].original_end.getTime()).toBe(7 * 86_400_000);
  });

  it("end on their date: hidden, refused in a cart, and no longer a price on alkao.ca", async () => {
    const later = testApp(db.pool, { paymentGateway: gateway, now: () => new Date(Date.now() + 11 * 86_400_000) });
    expect((await publicEvent(later)).ticketTypes.some((x: { id: string }) => x.id === presaleId)).toBe(false);
    const late = await call(later, "POST", `${pub(t.clientId, t.brandId)}/holds`, { body: { sessionId: t.sessionId, items: [{ ticketTypeId: presaleId, quantity: 1 }] } });
    expect(late.status).toBe(422);
    expect(late.body.error.details).toEqual([expect.objectContaining({ code: "inactive_ticket_type", ticketTypeId: presaleId })]);
  });
});

describe("coupons", () => {
  const createCode = async (body: Record<string, unknown>) =>
    call(app, "POST", `${adm(t.clientId, t.brandId)}/events/${t.eventId}/promo-codes`, { token: await owner(), body });

  it("a public code is shown to every buyer with its label; a private one never is", async () => {
    const made = await createCode({ code: "PREVENTE15", kind: "percent", percent: 15, public: true, label: "Coupon prévente", endsAt: inDays(5), maxUses: 50 });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body.promoCode).toMatchObject({ public: true, label: "Coupon prévente" });
    await createCode({ code: "MEMBRES10", kind: "percent", percent: 10 });
    expect((await createCode({ code: "BADLABEL", kind: "percent", percent: 10, public: true, label: "<b>gras</b>" })).status).toBe(400);

    const coupons = (await publicEvent()).coupons;
    expect(coupons).toEqual([expect.objectContaining({ code: "PREVENTE15", label: "Coupon prévente", kind: "percent", percent: 15, remaining: 50 })]);
    expect(JSON.stringify(coupons)).not.toContain("MEMBRES10");

    // A coupon applies like any code, and its uses count down.
    const h = await hold([{ ticketTypeId: general().id, quantity: 2 }], "prevente15");
    expect(h.status).toBe(201);
    expect(h.body.hold.quote).toMatchObject({ promoCode: "PREVENTE15", discountCents: Math.round(2 * 2995 * 0.15) });
    await pay(h.body.hold);
    expect((await publicEvent()).coupons[0].remaining).toBe(49);
  });

  it("a coupon turned private, or off, leaves the page", async () => {
    const { rows } = await db.pool.query(`SELECT id FROM public.ticketing_promo_codes WHERE code = 'PREVENTE15'`);
    const patch = async (body: Record<string, unknown>) =>
      call(app, "PATCH", `${adm(t.clientId, t.brandId)}/promo-codes/${rows[0].id}`, { token: await owner(), body });
    expect((await patch({ public: false })).body.promoCode.public).toBe(false);
    expect((await publicEvent()).coupons).toEqual([]);
    await patch({ public: true });
    expect((await publicEvent()).coupons).toHaveLength(1);
    await patch({ active: false });
    expect((await publicEvent()).coupons).toEqual([]);
  });

  it("a code kept off presale prices only reduces regular tickets, and says why on a presale-only cart (Run 99)", async () => {
    await db.pool.query(`UPDATE public.ticketing_ticket_types SET quantity_limit = NULL WHERE id = $1`, [presaleId]);
    const made = await createCode({ code: "REGULIER20", kind: "percent", percent: 20, public: true, excludesPresales: true });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body.promoCode).toMatchObject({ excludesPresales: true });
    expect((await publicEvent()).coupons).toEqual([expect.objectContaining({ code: "REGULIER20", excludesPresales: true })]);

    const quote = (items: { ticketTypeId: string; quantity: number }[]) =>
      call(app, "POST", `${pub(t.clientId, t.brandId)}/events/${t.eventId}/quote`, { body: { items, promoCode: "regulier20" } });
    const presaleOnly = await quote([{ ticketTypeId: presaleId, quantity: 2 }]);
    expect(presaleOnly.status).toBe(422);
    expect(presaleOnly.body.error).toMatchObject({ code: "promo_code_invalid", details: { reason: "presale_only" } });
    expect((await hold([{ ticketTypeId: presaleId, quantity: 1 }], "REGULIER20")).body.error.details).toEqual({ reason: "presale_only" });

    // A mixed cart: the presale ticket keeps its price, the regular one gets the 20 %, and the
    // payment charges exactly that.
    const mixed = await hold([{ ticketTypeId: presaleId, quantity: 1 }, { ticketTypeId: general().id, quantity: 1 }], "REGULIER20");
    expect(mixed.status, JSON.stringify(mixed.body)).toBe(201);
    expect(mixed.body.hold.quote).toMatchObject({ subtotalCents: 2395 + 2995, discountCents: Math.round(2995 * 0.2) });
    const order = await pay(mixed.body.hold);
    const { rows: [paid] } = await db.pool.query(`SELECT discount_cents, total_cents FROM public.ticketing_orders WHERE id = $1`, [order.id]);
    expect(paid).toEqual({ discount_cents: Math.round(2995 * 0.2), total_cents: mixed.body.hold.quote.totalCents });

    // Made cumulative again, it applies to the whole cart.
    const patch = await call(app, "PATCH", `${adm(t.clientId, t.brandId)}/promo-codes/${made.body.promoCode.id}`, { token: await owner(), body: { excludesPresales: false } });
    expect(patch.body.promoCode.excludesPresales).toBe(false);
    expect((await quote([{ ticketTypeId: presaleId, quantity: 1 }, { ticketTypeId: general().id, quantity: 1 }])).body.quote.discountCents).toBe(Math.round((2395 + 2995) * 0.2));
  });
});
