import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EmailMessage, EmailSender } from "../../src/delivery/email.js";
import { deliverTicketEmails } from "../../src/delivery/worker.js";
import { adm, call, pub, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { seedTwoTenants, TEST_CREDENTIAL_SECRET, type SeedResult } from "../helpers/seed.js";

/**
 * Run 65 (OPC, in force 12 September 2026): the seller tells buyers at once when an event's
 * time or place changes, and shows its exchange and refund policy before the sale.
 */
class Outbox implements EmailSender {
  sent: EmailMessage[] = [];
  async send(m: EmailMessage) { this.sent.push(m); return `msg_${this.sent.length}`; }
}

let db: TestDatabase;
let seed: SeedResult;
let app: TestApp;
let owner: string;
let outbox: Outbox;
const deliver = () => deliverTicketEmails(db.pool, { sender: outbox, publicUrl: "https://billets.alkao.test", credentialMasterSecret: TEST_CREDENTIAL_SECRET }, new Date(Date.now() + 1000));
const changes = async () =>
  (await db.pool.query<{ old_place: string; new_place: string; old_ends_at: Date | null; new_ends_at: Date | null }>(
    `SELECT old_place, new_place, old_ends_at, new_ends_at FROM public.ticketing_session_changes WHERE client_id = $1 ORDER BY created_at`, [seed.havana.clientId])).rows;
const notices = async () =>
  (await db.pool.query<{ order_id: string; status: string }>(
    `SELECT order_id, status FROM public.ticketing_email_outbox WHERE client_id = $1 AND kind = 'session_changed' ORDER BY created_at`, [seed.havana.clientId])).rows;

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  app = testApp(db.pool, { credentialMasterSecret: TEST_CREDENTIAL_SECRET });
  owner = await tokenFor(seed.users.havanaOwner);
  await db.pool.query(`UPDATE public.ticketing_email_outbox SET status = 'skipped', last_error = 'seed'`);
});

// The orders that hold valid tickets for the seeded session (the seed makes more than one).
const holders = async () =>
  (await db.pool.query<{ order_id: string }>(
    `SELECT DISTINCT order_id FROM public.ticketing_tickets WHERE session_id = $1 AND status = 'valid' ORDER BY order_id`, [seed.havana.sessionId])).rows.map((r) => r.order_id);

beforeEach(async () => {
  outbox = new Outbox();
  // Each test sends only what it queues.
  await db.pool.query(`UPDATE public.ticketing_email_outbox SET status = 'skipped', last_error = 'earlier test' WHERE status = 'pending'`);
});

afterAll(async () => {
  await db?.drop();
});

describe("change of time or place (OPC)", () => {
  it("a venue's new name or address tells every order with valid tickets, once per change", async () => {
    const h = seed.havana;
    // A session without tickets has nobody to tell.
    await db.pool.query(
      `INSERT INTO public.ticketing_sessions (client_id, brand_id, event_id, starts_at, capacity, status)
       VALUES ($1, $2, $3, now() + interval '12 days', 20, 'on_sale')`, [h.clientId, h.brandId, h.eventId]);
    const orders = await holders();
    expect(orders).toContain(h.orderId);
    const res = await call(app, "PATCH", `${adm(h.clientId, h.brandId)}/venues/${h.venueId}`, { token: owner, body: { name: "Pavillon du Lac", addressLine1: "100 chemin du Lac" } });
    expect(res.status).toBe(200);
    expect(res.body.buyersNotified).toBe(orders.length);
    expect(await changes()).toEqual([expect.objectContaining({ old_place: "Havana Resort · Maricourt", new_place: "Pavillon du Lac · 100 chemin du Lac · Maricourt" })]);
    expect((await notices()).map((n) => n.order_id).sort()).toEqual(orders);

    // Saving the same values again changes nothing, and tells nobody.
    const same = await call(app, "PATCH", `${adm(h.clientId, h.brandId)}/venues/${h.venueId}`, { token: owner, body: { name: "Pavillon du Lac" } });
    expect(same.body.buyersNotified).toBe(0);
    expect(await notices()).toHaveLength(orders.length);

    const r = await deliver();
    expect(r.sent).toBe(orders.length);
    const mail = outbox.sent[0]!;
    expect(mail.subject).toMatch(/^Changement à votre événement — Havana Resort — Événements 2026-2027 \(/);
    expect(mail.text).toContain("a changé le lieu de Havana Resort — Événements 2026-2027.");
    expect(mail.text).toContain("Avant : ");
    expect(mail.text).toContain("· Havana Resort · Maricourt");
    expect(mail.text).toContain("Maintenant : ");
    expect(mail.text).toContain("· Pavillon du Lac · 100 chemin du Lac · Maricourt");
    expect(mail.text).toMatch(/Afficher mes billets : https:\/\/billets\.alkao\.test\/billets#/);
    expect(mail.html).toContain("<s>");
  });

  it("a session's new end time is a change of schedule, with the policy repeated", async () => {
    const h = seed.havana;
    await call(app, "PUT", `${adm(h.clientId, h.brandId)}/appearance`, { token: owner, body: { refundPolicy: "Aucun remboursement,\nsauf annulation de l'événement." } });
    const { rows } = await db.pool.query<{ starts_at: Date }>(`SELECT starts_at FROM public.ticketing_sessions WHERE id = $1`, [h.sessionId]);
    const endsAt = new Date(rows[0]!.starts_at.getTime() + 3 * 3600_000).toISOString();
    const res = await call(app, "PATCH", `${adm(h.clientId, h.brandId)}/sessions/${h.sessionId}`, { token: owner, body: { endsAt } });
    expect(res.status).toBe(200);
    const orders = await holders();
    expect(res.body).toMatchObject({ session: { id: h.sessionId }, buyersNotified: orders.length });
    expect((await changes()).at(-1)).toMatchObject({ old_ends_at: null, new_ends_at: new Date(endsAt) });
    // The same orders are told about this second change too.
    expect(await notices()).toHaveLength(2 * orders.length);
    await deliver();
    const mail = outbox.sent[0]!;
    expect(mail.text).toContain("a changé l'horaire de");
    expect(mail.text).toContain("Politique d'échange et de remboursement :\nAucun remboursement,\nsauf annulation de l'événement.");
    expect(mail.html).toContain("Aucun remboursement,<br>sauf annulation de l&#39;événement.");
  });

  it("tells nobody about a past session, nor anyone whose tickets are no longer valid", async () => {
    const h = seed.havana;
    await db.pool.query(`UPDATE public.ticketing_sessions SET starts_at = now() - interval '1 day', ends_at = NULL WHERE id = $1`, [h.sessionId]);
    const past = await call(app, "PATCH", `${adm(h.clientId, h.brandId)}/venues/${h.venueId}`, { token: owner, body: { city: "Sorel" } });
    expect(past.body.buyersNotified).toBe(0);
    await db.pool.query(`UPDATE public.ticketing_sessions SET starts_at = now() + interval '30 days' WHERE id = $1`, [h.sessionId]);

    // Queued, then the tickets are cancelled before the e-mail goes: it is skipped, not sent.
    const queued = await call(app, "PATCH", `${adm(h.clientId, h.brandId)}/venues/${h.venueId}`, { token: owner, body: { city: "Saint-Ours" } });
    const orders = await holders();
    expect(queued.body.buyersNotified).toBe(orders.length);
    await db.pool.query(`UPDATE public.ticketing_tickets SET status = 'void', void_reason = 'cancelled', voided_at = now() WHERE order_id = ANY($1)`, [orders]);
    const r = await deliver();
    expect(r).toMatchObject({ sent: 0, skipped: orders.length });
    expect((await notices()).at(-1)!.status).toBe("skipped");
  });
});

describe("exchange and refund policy (OPC)", () => {
  it("is plain text the shop gets with the Brand, and markup is refused", async () => {
    const h = seed.havana;
    const saved = await call(app, "PUT", `${adm(h.clientId, h.brandId)}/appearance`, { token: owner, body: { refundPolicy: "  Échange possible jusqu'à 48 h avant.  " } });
    expect(saved.status).toBe(200);
    expect(saved.body.appearance.refundPolicy).toBe("Échange possible jusqu'à 48 h avant.");
    const shop = await call(app, "GET", `${pub(h.clientId, h.brandId)}/events/${h.eventId}`);
    expect(shop.body.event.brand.refundPolicy).toBe("Échange possible jusqu'à 48 h avant.");
    const bad = await call(app, "PUT", `${adm(h.clientId, h.brandId)}/appearance`, { token: owner, body: { refundPolicy: "<b>Non</b>" } });
    expect(bad.status).toBe(400);
    const cleared = await call(app, "PUT", `${adm(h.clientId, h.brandId)}/appearance`, { token: owner, body: {} });
    expect(cleared.body.appearance.refundPolicy).toBeNull();
  });
});
