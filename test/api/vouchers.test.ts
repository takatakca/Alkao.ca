import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { queueReminders } from "../../src/delivery/reminders.js";
import { ticketsEmail } from "../../src/delivery/templates.js";
import { adm, call, pub, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { seedTenant, seedTwoTenants, type SeedResult } from "../helpers/seed.js";

/**
 * Run 109: merchant vouchers ("bons d'achat"), as on Groupon, Tuango and PromoRabais. A voucher
 * event's session is its validity window: it sells until the window ends, and its scanner window
 * follows it. Each admission can state a face value, kept above its price by the database.
 */
const DAY = 86_400_000;
let db: TestDatabase;
let seed: SeedResult;
let app: TestApp;
let owner: string;

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  app = testApp(db.pool, { publicUrl: "https://alkao.test" });
  owner = await tokenFor(seed.users.havanaOwner);
});
afterAll(async () => { await db?.drop(); });

const TERMS = "Valide du lundi au jeudi\nUn bon par table\nRéservation requise";

/** A published voucher event whose window began two days ago and ends in 40 days. */
async function voucherEvent(slug: string, title: string) {
  const h = seed.havana;
  const a = adm(h.clientId, h.brandId);
  const created = await call(app, "POST", `${a}/events`, { token: owner, body: { venueId: h.venueId, slug, title, voucher: true, page: { terms: TERMS } } });
  expect(created.status).toBe(201);
  const eventId = created.body.event.id as string;
  const window = await call(app, "POST", `${a}/events/${eventId}/sessions`, {
    token: owner, body: { startsAt: new Date(Date.now() - 2 * DAY).toISOString(), endsAt: new Date(Date.now() + 40 * DAY).toISOString(), capacity: 50 },
  });
  expect(window.status).toBe(201);
  expect((await call(app, "PATCH", `${a}/sessions/${window.body.session.id}`, { token: owner, body: { status: "on_sale" } })).status).toBe(200);
  const type = await call(app, "POST", `${a}/events/${eventId}/ticket-types`, {
    token: owner, body: { code: "SOUPER2", name: "Souper pour deux", priceCents: 4500, valueCents: 8000, maxQuantity: 4, countsAsAdult: true },
  });
  expect(type.status).toBe(201);
  expect((await call(app, "PATCH", `${a}/events/${eventId}`, { token: owner, body: { status: "published" } })).status).toBe(200);
  return { eventId, sessionId: window.body.session.id as string, typeId: type.body.ticketType.id as string };
}

describe("Run 109: merchant vouchers", () => {
  it("needs an end to its window, and keeps its value above its price, for admissions only", async () => {
    const h = seed.havana;
    const a = adm(h.clientId, h.brandId);
    const created = await call(app, "POST", `${a}/events`, { token: owner, body: { venueId: h.venueId, slug: "spa-detente", title: "Forfait détente au spa", voucher: true, page: { terms: TERMS } } });
    expect(created.status).toBe(201);
    expect(created.body.event).toMatchObject({ voucher: true, page: { terms: TERMS } });
    const eventId = created.body.event.id;

    const noEnd = await call(app, "POST", `${a}/events/${eventId}/sessions`, { token: owner, body: { startsAt: new Date(Date.now() + DAY).toISOString(), capacity: 20 } });
    expect(noEnd.status).toBe(422);
    expect(noEnd.body.error.code).toBe("voucher_needs_end");

    const type = (body: Record<string, unknown>) => call(app, "POST", `${a}/events/${eventId}/ticket-types`, { token: owner, body: { name: "Forfait", maxQuantity: 2, ...body } });
    // A face value at or under the price, or on an option, is refused.
    expect((await type({ code: "EGAL", priceCents: 9000, valueCents: 9000 })).status).toBe(400);
    expect((await type({ code: "OPTION", kind: "add_on", addOnScope: "per_order", priceCents: 1000, valueCents: 2000 })).status).toBe(400);
    const ok = await type({ code: "DETENTE", priceCents: 9000, valueCents: 15000 });
    expect(ok.status).toBe(201);
    expect(ok.body.ticketType.valueCents).toBe(15000);
    // The database keeps it so when the value or the price moves later.
    const lowered = await call(app, "PATCH", `${a}/ticket-types/${ok.body.ticketType.id}`, { token: owner, body: { valueCents: 8000 } });
    expect(lowered.status).toBe(422);
    expect(lowered.body.error.code).toBe("value_must_exceed_price");
    const raised = await call(app, "PATCH", `${a}/ticket-types/${ok.body.ticketType.id}`, { token: owner, body: { priceCents: 16000 } });
    expect(raised.status).toBe(422);
    expect(raised.body.error.code).toBe("value_must_exceed_price");
    // Fine print is plain text only.
    expect((await call(app, "PATCH", `${a}/events/${eventId}`, { token: owner, body: { page: { terms: "<b>x</b>" } } })).status).toBe(400);
  });

  it("sells during its window, which a dated event does not", async () => {
    const h = seed.havana;
    const v = await voucherEvent("souper-bistro", "Souper pour deux au Bistro");
    const shop = await call(app, "GET", `${pub(h.clientId, h.brandId)}/events/${v.eventId}`);
    expect(shop.status).toBe(200);
    expect(shop.body.event).toMatchObject({ voucher: true, page: { terms: TERMS } });
    expect(shop.body.sessions.map((s: { id: string }) => s.id)).toEqual([v.sessionId]);
    expect(shop.body.ticketTypes.find((t: { id: string }) => t.id === v.typeId)).toMatchObject({ priceCents: 4500, valueCents: 8000 });
    const hold = await call(app, "POST", `${pub(h.clientId, h.brandId)}/holds`, { body: { sessionId: v.sessionId, items: [{ ticketTypeId: v.typeId, quantity: 2 }] } });
    expect(hold.status).toBe(201);

    // The same past start on a dated event: no longer on sale.
    await db.pool.query(`UPDATE public.ticketing_events SET voucher = false WHERE id = $1`, [v.eventId]);
    try {
      const listed = await call(app, "GET", `${pub(h.clientId, h.brandId)}/events/${v.eventId}`);
      expect(listed.body.sessions).toEqual([]);
      const refused = await call(app, "POST", `${pub(h.clientId, h.brandId)}/holds`, { body: { sessionId: v.sessionId, items: [{ ticketTypeId: v.typeId, quantity: 1 }] } });
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe("session_not_available");
    } finally {
      await db.pool.query(`UPDATE public.ticketing_events SET voucher = true WHERE id = $1`, [v.eventId]);
    }
    // Once the window has ended, it is not sold either.
    await db.pool.query(`UPDATE public.ticketing_sessions SET ends_at = now() - interval '1 minute' WHERE id = $1`, [v.sessionId]);
    try {
      expect((await call(app, "GET", `${pub(h.clientId, h.brandId)}/events/${v.eventId}`)).body.sessions).toEqual([]);
    } finally {
      await db.pool.query(`UPDATE public.ticketing_sessions SET ends_at = now() + interval '40 days' WHERE id = $1`, [v.sessionId]);
    }
  });

  it("shows on alkao.ca as a voucher: its saving on its value, until when, and no Event data", async () => {
    const h = seed.havana;
    await voucherEvent("massage-duo", "Massage duo au Spa Nordique");
    await db.pool.query(
      `INSERT INTO public.ticketing_brand_settings (client_id, brand_id, show_on_alkao) VALUES ($1, $2, true)
       ON CONFLICT (client_id, brand_id) DO UPDATE SET show_on_alkao = true`, [h.clientId, h.brandId]);
    const res = await app.request("/");
    const html = await res.text();
    const card = /<article class="card reveal" data-id="[^"]+">(?:(?!<\/article>)[\s\S])*Massage duo au Spa Nordique[\s\S]*?<\/article>/.exec(html)?.[0] ?? "";
    expect(card).toContain("<span>Bon −43 %</span>");
    expect(card).toContain('class="date-badge is-voucher"');
    expect(card).toMatch(/Valide jusqu’au \d{1,2} \S+ \d{4}/);
    expect(card).toMatch(/À partir de 45\s\$ \+ taxes <s class="was"><span class="sr-only">Valeur <\/span>80\s\$<\/s>/);
    // A voucher is not an outing on a date: not in the Event data, the week rail or the agenda.
    const ld = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "[]";
    expect(ld).not.toContain("Massage duo");
    const agenda = await (await app.request("/?vue=agenda")).text();
    expect(agenda).toContain('class="agenda-title"');
    expect(agenda).not.toMatch(/class="agenda-title"[^>]*>Massage duo/);
    // The spotlight speaks of its value, not of a regular price.
    const spot = /<article class="spotlight[\s\S]*?<\/article>/.exec(html)?.[0] ?? "";
    if (spot.includes("Massage duo") || spot.includes("Souper pour deux")) {
      expect(spot).toMatch(/Valeur <s>80\s\$<\/s>/);
      expect(spot).toMatch(/35\s\$ d’économie par bon/);
    }
  });

  it("says « valide jusqu'au » in the tickets e-mail, and sends no « see you tomorrow » reminder", async () => {
    const until = new Date("2026-12-31T23:59:00-05:00");
    const mail = ticketsEmail({
      kind: "order_tickets", brandName: "Bistro", buyerName: "Ana", reference: "ALK-1", eventTitle: "Souper pour deux",
      startsAt: new Date("2026-11-01T04:00:00Z"), voucherUntil: until, venueName: "Bistro", city: "Montréal", timezone: "America/Toronto", validTickets: 2, link: "https://alkao.test/billets",
    });
    expect(mail.text).toContain("Bon valide jusqu'au jeudi 31 décembre 2026");
    expect(mail.text).not.toContain("1 novembre");

    // A tenant of its own: a paid order whose session starts in 30 days.
    const t = await seedTenant(db.pool, "Bistro Nord", "Bistro Nord Offres", 50);
    const { rows } = await db.pool.query<{ starts_at: Date }>(`SELECT starts_at FROM public.ticketing_sessions WHERE id = $1`, [t.sessionId]);
    const dayBefore = new Date(rows[0]!.starts_at.getTime() - 12 * 3_600_000);
    const reminded = async () => (await db.pool.query(
      `SELECT 1 FROM public.ticketing_email_outbox WHERE order_id = $1 AND kind = 'reminder'`, [t.orderId])).rowCount;
    await db.pool.query(`UPDATE public.ticketing_events SET voucher = true WHERE id = $1`, [t.eventId]);
    await queueReminders(db.pool, dayBefore);
    expect(await reminded()).toBe(0);
    // The same order on a dated event is reminded (the rule is the voucher, not the clock).
    await db.pool.query(`UPDATE public.ticketing_events SET voucher = false WHERE id = $1`, [t.eventId]);
    await queueReminders(db.pool, dayBefore);
    expect(await reminded()).toBe(1);
  });

  it("keeps a voucher and its value when the event is duplicated", async () => {
    const h = seed.havana;
    const a = adm(h.clientId, h.brandId);
    const v = await voucherEvent("brunch-dimanche", "Brunch du dimanche");
    const copy = await call(app, "POST", `${a}/events/${v.eventId}/duplicate`, { token: owner, body: { title: "Brunch du dimanche (copie)", shiftDays: 60 } });
    expect(copy.status).toBe(201);
    const event = await call(app, "GET", `${a}/events/${copy.body.event.id}`, { token: owner });
    expect(event.body.event).toMatchObject({ voucher: true, page: { terms: TERMS } });
    const types = await call(app, "GET", `${a}/events/${copy.body.event.id}/ticket-types`, { token: owner });
    expect(types.body.ticketTypes.find((t: { code: string }) => t.code === "SOUPER2")).toMatchObject({ priceCents: 4500, valueCents: 8000 });
  });
});
