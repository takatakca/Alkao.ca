import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EmailMessage, EmailSender } from "../../src/delivery/email.js";
import { queueReminders, queueVoucherExpiry, VOUCHER_EXPIRY_DAYS_BEFORE } from "../../src/delivery/reminders.js";
import { voucherExpiryEmail } from "../../src/delivery/templates.js";
import { deliverTicketEmails } from "../../src/delivery/worker.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { seedTenant, TEST_CREDENTIAL_SECRET, type TenantFixture } from "../helpers/seed.js";

/**
 * Run 112: a reminder before a merchant voucher expires, once per order, 7 days before its
 * validity window ends, while one of its vouchers is still unredeemed. The clock is passed in.
 */
const DAY = 86_400_000;
let db: TestDatabase;
let sent: EmailMessage[];
const sender: EmailSender = { send: async (m) => (sent.push(m), `msg_${sent.length}`) };
const deliver = (now: Date) => deliverTicketEmails(db.pool, { sender, publicUrl: "https://billets.alkao.test", credentialMasterSecret: TEST_CREDENTIAL_SECRET }, now);

beforeAll(async () => { db = await createTestDatabase(); });
afterAll(async () => { await db?.drop(); });
beforeEach(async () => {
  sent = [];
  await db.pool.query(`UPDATE public.ticketing_email_outbox SET status = 'skipped', last_error = 'earlier_test' WHERE status = 'pending'`);
});

/**
 * A tenant whose paid order is for a voucher. By default its window ends 10 days after its
 * session's start (30 days ahead); `endsInDays` makes it valid since yesterday until then, so the
 * worker can deliver close to today's clock (it drops e-mails waiting more than 72 h).
 */
async function voucherOrder(name: string, endsInDays?: number): Promise<TenantFixture & { endsAt: Date }> {
  const t = await seedTenant(db.pool, name, `${name} Offres`, 50);
  await db.pool.query(`UPDATE public.ticketing_events SET voucher = true, title = 'Souper pour deux' WHERE id = $1`, [t.eventId]);
  const { rows } = endsInDays === undefined
    ? await db.pool.query<{ ends_at: Date }>(
      `UPDATE public.ticketing_sessions SET ends_at = starts_at + interval '10 days' WHERE id = $1 RETURNING ends_at`, [t.sessionId])
    : await db.pool.query<{ ends_at: Date }>(
      `UPDATE public.ticketing_sessions SET starts_at = now() - interval '1 day', ends_at = now() + make_interval(days => $2) WHERE id = $1 RETURNING ends_at`,
      [t.sessionId, endsInDays]);
  return { ...t, endsAt: rows[0]!.ends_at };
}
/** The business scans a voucher (its own QR credential, issued with the ticket). */
const redeem = (ticketId: string) => db.pool.query(
  `INSERT INTO public.ticketing_scans (client_id, brand_id, event_id, session_id, credential_id, ticket_id, result, scanned_by, scanned_at)
   SELECT c.client_id, c.brand_id, c.event_id, c.session_id, c.id, c.ticket_id, 'admitted', $2, now()
   FROM public.ticketing_credentials c WHERE c.ticket_id = $1 AND c.status = 'active' LIMIT 1`, [ticketId, randomUUID()]);
const queued = async (orderId: string) =>
  (await db.pool.query(`SELECT status FROM public.ticketing_email_outbox WHERE order_id = $1 AND kind = 'voucher_expiry'`, [orderId])).rows;

describe("Run 112: before a voucher expires", () => {
  it("is queued once, within the last 7 days of the window, for a voucher only", async () => {
    const t = await voucherOrder("Bistro Est");
    expect(VOUCHER_EXPIRY_DAYS_BEFORE).toBe(7);
    // Eight days before the end: too early.
    await queueVoucherExpiry(db.pool, new Date(t.endsAt.getTime() - 8 * DAY));
    expect(await queued(t.orderId)).toEqual([]);
    // Three days before: queued, and only once, whatever how often it runs.
    const at = new Date(t.endsAt.getTime() - 3 * DAY);
    await queueReminders(db.pool, at);
    await queueReminders(db.pool, at);
    expect(await queued(t.orderId)).toHaveLength(1);
    // After the end: nothing more.
    expect(await queueVoucherExpiry(db.pool, new Date(t.endsAt.getTime() + DAY))).toBe(0);

    // A dated event with the same session gets no voucher notice.
    const d = await seedTenant(db.pool, "Salle Ouest", "Salle Ouest Spectacles", 50);
    await db.pool.query(`UPDATE public.ticketing_sessions SET ends_at = starts_at + interval '10 days' WHERE id = $1`, [d.sessionId]);
    await queueVoucherExpiry(db.pool, at);
    expect(await queued(d.orderId)).toEqual([]);
  });

  it("says how many vouchers are left and until when, with the link; and skips once all are redeemed", async () => {
    const t = await voucherOrder("Spa Nord", 3);
    // 13 hours on: past the 12 hours after payment, well within the 72 hours an e-mail may wait.
    const at = new Date(Date.now() + 13 * 3_600_000);
    await queueVoucherExpiry(db.pool, at);
    // One of the order's vouchers was redeemed at the business already.
    const { rows: tickets } = await db.pool.query<{ id: string }>(
      `SELECT id FROM public.ticketing_tickets WHERE order_id = $1 AND status = 'valid' ORDER BY id`, [t.orderId]);
    expect(tickets.length).toBeGreaterThan(1);
    expect((await redeem(tickets[0]!.id)).rowCount).toBe(1);
    const r = await deliver(at);
    const mail = sent.find((m) => m.subject.startsWith("Votre bon expire le"));
    expect(r.sent).toBeGreaterThanOrEqual(1);
    expect(mail?.subject).toMatch(/^Votre bon expire le \d{1,2} \S+ \d{4} — Souper pour deux$/);
    expect(mail?.text).toContain(`Il vous reste ${tickets.length - 1} bons non utilisés`);
    expect(mail?.text).toMatch(/Bon valide jusqu'au \S+ \d{1,2} \S+ \d{4}/);
    expect(mail?.text).toContain("https://billets.alkao.test/billets#");
    expect(mail?.text).toContain("Présentez le code QR au commerce avant cette date.");

    // Every voucher redeemed before the e-mail went: nothing is sent.
    const u = await voucherOrder("Spa Sud", 3);
    const atU = new Date(Date.now() + 13 * 3_600_000);
    await queueVoucherExpiry(db.pool, atU);
    const { rows: all } = await db.pool.query<{ id: string }>(`SELECT id FROM public.ticketing_tickets WHERE order_id = $1 AND status = 'valid'`, [u.orderId]);
    for (const k of all) await redeem(k.id);
    sent = [];
    await deliver(atU);
    expect(sent.filter((m) => m.subject.startsWith("Votre bon expire"))).toEqual([]);
    expect((await queued(u.orderId))[0]?.status).toBe("skipped");
    // And a fully redeemed order is not queued at all.
    const w = await voucherOrder("Spa Ouest");
    const { rows: allW } = await db.pool.query<{ id: string }>(`SELECT id FROM public.ticketing_tickets WHERE order_id = $1 AND status = 'valid'`, [w.orderId]);
    for (const k of allW) await redeem(k.id);
    await queueVoucherExpiry(db.pool, new Date(w.endsAt.getTime() - 3 * DAY));
    expect(await queued(w.orderId)).toEqual([]);
  });

  it("follows the organizer's reminder setting", async () => {
    const t = await voucherOrder("Spa Centre");
    await db.pool.query(
      `INSERT INTO public.ticketing_brand_settings (client_id, brand_id, reminder_emails) VALUES ($1, $2, false)
       ON CONFLICT (client_id, brand_id) DO UPDATE SET reminder_emails = false`, [t.clientId, t.brandId]);
    await queueVoucherExpiry(db.pool, new Date(t.endsAt.getTime() - 3 * DAY));
    expect(await queued(t.orderId)).toEqual([]);
  });

  it("reads well in English", () => {
    const mail = voucherExpiryEmail({
      language: "en", brandName: "Bistro", buyerName: "Ana", reference: "ALK-1", eventTitle: "Dinner for two",
      startsAt: new Date("2026-11-01T04:00:00Z"), validUntil: new Date("2026-12-31T23:59:00-05:00"), unredeemed: 1,
      venueName: "Bistro", city: "Montréal", timezone: "America/Toronto", validTickets: 2, link: "https://alkao.test/billets",
    });
    expect(mail.subject).toBe("Your voucher expires on December 31, 2026 — Dinner for two");
    expect(mail.text).toContain("You have 1 unused voucher left. A quick reminder for your order ALK-1: they are valid until");
  });
});
