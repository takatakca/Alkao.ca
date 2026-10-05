import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EmailMessage, EmailSender } from "../../src/delivery/email.js";
import { queueReminders } from "../../src/delivery/reminders.js";
import { reminderEmail } from "../../src/delivery/templates.js";
import { deliverTicketEmails } from "../../src/delivery/worker.js";
import { adm, call, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { seedPaidOrder, seedTwoTenants, TEST_CREDENTIAL_SECRET, type SeedResult, type TenantFixture } from "../helpers/seed.js";

/**
 * Run 23: one reminder per order, during the 24 hours before the session, with the buyer's
 * tickets link. The clock is passed in, so each case is checked at the moment it matters.
 */
const HOUR = 3_600_000;
const PUBLIC_URL = "https://billets.alkao.test";

let db: TestDatabase;
let seed: SeedResult;
let app: TestApp;
let sent: EmailMessage[];
const sender: EmailSender = { send: async (m) => (sent.push(m), `msg_${sent.length}`) };
const deliver = (now: Date) => deliverTicketEmails(db.pool, { sender, publicUrl: PUBLIC_URL, credentialMasterSecret: TEST_CREDENTIAL_SECRET }, now);

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  app = testApp(db.pool, { credentialMasterSecret: TEST_CREDENTIAL_SECRET });
});

beforeEach(async () => {
  sent = [];
  // Each test looks only at the emails it causes.
  await db.pool.query(`UPDATE public.ticketing_email_outbox SET status = 'skipped', last_error = 'earlier_test' WHERE status = 'pending'`);
});

afterAll(async () => {
  await db?.drop();
});

/** An order paid now, for a session starting `hours` from now. */
async function orderIn(t: TenantFixture, hours: number, email: string) {
  const { rows } = await db.pool.query<{ id: string; starts_at: Date }>(
    `INSERT INTO public.ticketing_sessions (client_id, brand_id, event_id, starts_at, capacity, status)
     VALUES ($1, $2, $3, now() + make_interval(hours => $4), 50, 'on_sale') RETURNING id, starts_at`,
    [t.clientId, t.brandId, t.eventId, hours],
  );
  const order = await seedPaidOrder(db.pool, { ...t, sessionId: rows[0]!.id }, email);
  // Its tickets email went out at purchase.
  await db.pool.query(`UPDATE public.ticketing_email_outbox SET status = 'sent', sent_at = now() WHERE order_id = $1 AND kind = 'order_tickets'`, [order.orderId]);
  return { ...order, sessionId: rows[0]!.id, startsAt: rows[0]!.starts_at };
}
const reminders = async (orderId: string) =>
  (await db.pool.query(`SELECT status, last_error FROM public.ticketing_email_outbox WHERE order_id = $1 AND kind = 'reminder'`, [orderId])).rows;
const at = (hoursFromNow: number) => new Date(Date.now() + hoursFromNow * HOUR);

describe("reminder emails", () => {
  it("queues one reminder in the 24 hours before the session, not right after the purchase, and sends it", async () => {
    const t = seed.havana;
    const order = await orderIn(t, 30, "rappel@example.com");
    expect(await queueReminders(db.pool, at(1))).toBe(0); // the session is 29 h away
    expect(await queueReminders(db.pool, at(10))).toBe(0); // 20 h away, but bought 10 h ago
    expect(await queueReminders(db.pool, at(13))).toBe(1);
    expect(await queueReminders(db.pool, at(14))).toBe(0); // once per order, ever
    expect(await reminders(order.orderId)).toEqual([{ status: "pending", last_error: null }]);

    const r = await deliver(at(13));
    expect(r.sent).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("rappel@example.com");
    expect(sent[0]!.subject).toMatch(/^Rappel : .+ — /);
    expect(sent[0]!.text).toContain(`${PUBLIC_URL}/billets#`);
    expect(await reminders(order.orderId)).toEqual([{ status: "sent", last_error: null }]);
  });

  it("is not queued for a cancelled session, an order without valid tickets, an anonymized buyer or a Brand that turned it off", async () => {
    const h = seed.havana;
    const cancelled = await orderIn(h, 30, "annulee@example.com");
    await db.pool.query(`UPDATE public.ticketing_sessions SET status = 'cancelled' WHERE id = $1`, [cancelled.sessionId]);
    const voided = await orderIn(h, 30, "plus-de-billet@example.com");
    await db.pool.query(`UPDATE public.ticketing_tickets SET status = 'void', void_reason = 'admin', voided_at = now() WHERE order_id = $1`, [voided.orderId]);
    const forgotten = await orderIn(h, 30, "oublie@example.com");
    await db.pool.query(`INSERT INTO public.ticketing_buyer_erasures (buyer_id, client_id, brand_id, requested_by) VALUES ($1, $2, $3, 'test')`, [forgotten.buyerId, h.clientId, h.brandId]);

    const f = seed.festi;
    const off = await orderIn(f, 30, "marque-off@example.com");
    const owner = await tokenFor(seed.users.festiOwner);
    const put = await call(app, "PUT", `${adm(f.clientId, f.brandId)}/settings/reminders`, { token: owner, body: { enabled: false } });
    expect(put.body).toEqual({ reminders: { enabled: false } });

    await queueReminders(db.pool, at(13));
    for (const o of [cancelled, voided, forgotten, off]) expect(await reminders(o.orderId), o.orderId).toEqual([]);

    // Back on: FESTI-ICE's buyers get it again.
    await call(app, "PUT", `${adm(f.clientId, f.brandId)}/settings/reminders`, { token: owner, body: { enabled: true } });
    await queueReminders(db.pool, at(13));
    expect(await reminders(off.orderId)).toEqual([{ status: "pending", last_error: null }]);
  });

  it("is dropped if the session is cancelled or has started by the time it would go out", async () => {
    const t = seed.havana;
    const cancelled = await orderIn(t, 30, "annulee-apres@example.com");
    const late = await orderIn(t, 26, "en-retard@example.com");
    await queueReminders(db.pool, at(13));
    await db.pool.query(`UPDATE public.ticketing_sessions SET status = 'cancelled' WHERE id = $1`, [cancelled.sessionId]);
    // The worker was down until after the second session started.
    await deliver(at(27));
    expect(sent).toEqual([]);
    expect(await reminders(cancelled.orderId)).toEqual([{ status: "skipped", last_error: "session_cancelled" }]);
    expect(await reminders(late.orderId)).toEqual([{ status: "skipped", last_error: "session_started" }]);
  });

  it("can be turned off by owners, admins and managers, not by gate staff", async () => {
    const h = seed.havana;
    expect((await call(app, "GET", `${adm(h.clientId, h.brandId)}/settings/reminders`, { token: await tokenFor(seed.users.havanaOwner) })).body).toEqual({ reminders: { enabled: true } });
    expect((await call(app, "GET", `${adm(h.clientId, h.brandId)}/settings/reminders`, { token: await tokenFor(seed.users.havanaStaff) })).status).toBe(403);
    expect((await call(app, "PUT", `${adm(h.clientId, h.brandId)}/settings/reminders`, { token: await tokenFor(seed.users.havanaStaff), body: { enabled: false } })).status).toBe(403);
    const { rows } = await db.pool.query(`SELECT count(*)::int AS n FROM public.ticketing_audit_log WHERE action = 'settings.reminders_updated'`);
    expect(rows[0].n).toBe(2); // the two FESTI-ICE changes above
  });
});

describe("the reminder email", () => {
  const data = {
    brandName: "FESTI-ICE", buyerName: "Ana <Lys>", reference: "K7PM-2QXA", eventTitle: "Nuit <glacée>",
    startsAt: new Date("2027-01-16T00:30:00Z"), venueName: "Parc", city: "Québec", timezone: "America/Toronto", validTickets: 2,
    link: "https://billets.alkao.test/billets#c=1",
  };
  it("is in French by default and in English on request, with every value escaped", () => {
    const fr = reminderEmail(data);
    expect(fr.subject).toBe("Rappel : Nuit <glacée> — vendredi 15 janvier 2027 à 19 h 30");
    expect(fr.text).toContain("Petit rappel pour votre commande K7PM-2QXA");
    expect(fr.text).toContain("2 billets");
    expect(fr.html).toContain("Nuit &lt;glacée&gt;");
    expect(fr.html).not.toContain("<glacée>");
    expect(fr.html).toContain("Ana &lt;Lys&gt;");
    const en = reminderEmail({ ...data, language: "en" });
    expect(en.subject).toMatch(/^Reminder: Nuit <glacée> — Friday, January 15, 2027 at 7:30\sp\.m\.$/);
    expect(en.text).toContain("A quick reminder for your order K7PM-2QXA");
    expect(en.html).toContain('lang="en"');
  });
});
