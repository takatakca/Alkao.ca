import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EmailMessage, EmailSender } from "../../src/delivery/email.js";
import { deliverTicketEmails } from "../../src/delivery/worker.js";
import { call, pub, testApp, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { seedPaidOrder, seedTwoTenants, TEST_CREDENTIAL_SECRET, type SeedResult, type TenantFixture } from "../helpers/seed.js";

/**
 * Run 27: "Retrouver mes billets". A buyer who lost the email gets the tickets sent again to
 * the same address. The answer never says whether the address bought anything.
 */
let db: TestDatabase;
let seed: SeedResult;
let app: TestApp;
let sent: EmailMessage[];
const sender: EmailSender = { send: async (m) => (sent.push(m), `msg_${sent.length}`) };
// A moment later: queued rows are stamped in microseconds (see the delivery tests).
const deliver = () => deliverTicketEmails(db.pool, { sender, publicUrl: "https://billets.alkao.test", credentialMasterSecret: TEST_CREDENTIAL_SECRET }, new Date(Date.now() + 1000));

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
});

beforeEach(async () => {
  sent = [];
  // A fresh app per test: its rate limiters start empty.
  app = testApp(db.pool, { credentialMasterSecret: TEST_CREDENTIAL_SECRET });
  // Every email so far went out at purchase.
  await db.pool.query(`UPDATE public.ticketing_email_outbox SET status = 'sent', sent_at = now() WHERE status = 'pending'`);
});

afterAll(async () => {
  await db?.drop();
});

const ask = (t: TenantFixture, email: string) => call(app, "POST", `${pub(t.clientId, t.brandId)}/tickets/resend`, { body: { email } });
const pending = async () =>
  (await db.pool.query<{ order_id: string }>(`SELECT order_id FROM public.ticketing_email_outbox WHERE status = 'pending' ORDER BY order_id`)).rows.map((r) => r.order_id);

async function pastOrder(t: TenantFixture, email: string) {
  const { rows } = await db.pool.query<{ id: string }>(
    `INSERT INTO public.ticketing_sessions (client_id, brand_id, event_id, starts_at, ends_at, capacity, status)
     VALUES ($1, $2, $3, now() - interval '2 days', now() - interval '2 days' + interval '3 hours', 20, 'on_sale') RETURNING id`,
    [t.clientId, t.brandId, t.eventId],
  );
  return seedPaidOrder(db.pool, { ...t, sessionId: rows[0]!.id }, email);
}

describe("finding one's tickets again", () => {
  it("sends the tickets of upcoming orders again, to the address that bought them", async () => {
    const h = seed.havana;
    const upcoming = await seedPaidOrder(db.pool, h, "perdu@example.com");
    const over = await pastOrder(h, "perdu@example.com");
    await db.pool.query(`UPDATE public.ticketing_email_outbox SET status = 'sent', sent_at = now() WHERE status = 'pending'`);

    const res = await ask(h, "  PERDU@Example.com ");
    expect(res).toEqual({ status: 202, body: { ok: true } });
    expect(await pending()).toEqual([upcoming.orderId]); // not the session already over
    expect(over.orderId).not.toBe(upcoming.orderId);
    await deliver();
    expect(sent.map((m) => m.to)).toEqual(["perdu@example.com"]);
    expect(sent[0]!.text).toContain("https://billets.alkao.test/billets#");
    const { rows } = await db.pool.query(
      `SELECT actor_type FROM public.ticketing_audit_log WHERE action = 'order.tickets_email_requested' AND entity_id = $1`,
      [upcoming.orderId],
    );
    expect(rows).toEqual([{ actor_type: "public" }]);
  });

  it("answers the same for an address that bought nothing, and never crosses Clients", async () => {
    const h = seed.havana;
    const f = seed.festi;
    await seedPaidOrder(db.pool, f, "deux-marques@example.com");
    await db.pool.query(`UPDATE public.ticketing_email_outbox SET status = 'sent', sent_at = now() WHERE status = 'pending'`);

    expect(await ask(h, "personne@example.com")).toEqual({ status: 202, body: { ok: true } });
    // The address bought at FESTI-ICE, not at Havana: Havana's shop sends nothing.
    expect(await ask(h, "deux-marques@example.com")).toEqual({ status: 202, body: { ok: true } });
    expect(await pending()).toEqual([]);
  });

  it("never writes to an anonymized buyer", async () => {
    const h = seed.havana;
    const order = await seedPaidOrder(db.pool, h, "efface@example.com");
    await db.pool.query(`UPDATE public.ticketing_email_outbox SET status = 'sent', sent_at = now() WHERE status = 'pending'`);
    await db.pool.query(`INSERT INTO public.ticketing_buyer_erasures (buyer_id, client_id, brand_id, requested_by) VALUES ($1, $2, $3, 'test')`, [order.buyerId, h.clientId, h.brandId]);
    expect((await ask(h, "efface@example.com")).status).toBe(202);
    expect(await pending()).toEqual([]);
  });

  it("cannot flood an inbox: three sends per address per hour, five requests per caller per 10 minutes", async () => {
    const h = seed.havana;
    const order = await seedPaidOrder(db.pool, h, "inonde@example.com");
    const requested = async () =>
      (await db.pool.query(`SELECT count(*)::int AS n FROM public.ticketing_audit_log WHERE action = 'order.tickets_email_requested' AND entity_id = $1 AND actor_type = 'public'`, [order.orderId])).rows[0].n;
    for (let i = 0; i < 4; i++) expect((await ask(h, "inonde@example.com")).status).toBe(202);
    expect(await requested()).toBe(3); // the 4th was answered the same, and did nothing
    expect((await ask(h, "autre@example.com")).status).toBe(202);
    const sixth = await ask(h, "encore@example.com");
    expect(sixth.status).toBe(429);
    expect(sixth.body.error.code).toBe("rate_limited");
  });

  it("refuses something that is not an email", async () => {
    expect((await ask(seed.havana, "pas-un-courriel")).status).toBe(400);
  });
});
