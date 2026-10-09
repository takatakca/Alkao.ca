import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emailCodes, MAX_CODES_IN_EMAIL, qrGif } from "../../src/delivery/codes.js";
import { ResendEmailSender, type EmailMessage, type EmailSender } from "../../src/delivery/email.js";
import { deliverTicketEmails } from "../../src/delivery/worker.js";
import { call, pub, testApp, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { seedTwoTenants, TEST_CREDENTIAL_SECRET, type SeedResult } from "../helpers/seed.js";

// Run 52: the tickets' QR codes inside the tickets and reminder e-mails. Synthetic data only.

class FakeSender implements EmailSender {
  sent: EmailMessage[] = [];
  async send(m: EmailMessage) {
    this.sent.push(m);
    return `msg_${this.sent.length}`;
  }
}

let db: TestDatabase;
let seed: SeedResult;
let app: TestApp;

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  app = testApp(db.pool, { credentialMasterSecret: TEST_CREDENTIAL_SECRET });
  await db.pool.query(`UPDATE public.ticketing_email_outbox SET status = 'skipped', last_error = 'seed' WHERE status = 'pending'`);
});

afterAll(async () => {
  await db?.drop();
});

const deliver = async () => {
  const sender = new FakeSender();
  await deliverTicketEmails(db.pool, { sender, publicUrl: "https://billets.alkao.test", credentialMasterSecret: TEST_CREDENTIAL_SECRET }, new Date(Date.now() + 1000));
  return sender.sent;
};

/** The QR payloads the tickets page shows for the order, by ticket. */
async function pageCredentials(orderId: string) {
  const t = seed.havana;
  const res = await call(app, "GET", `${pub(t.clientId, t.brandId)}/orders/${orderId}`, { headers: { "x-alkao-order-token": `secret-${orderId}` } });
  expect(res.status).toBe(200);
  return (res.body.order.tickets as { id: string; status: string; credential: string | null }[]).filter((x) => x.status === "valid" && x.credential);
}

describe("QR codes inside the e-mails", () => {
  it("carry exactly the tickets page's codes, as inline images the HTML points to", async () => {
    const t = seed.havana;
    await db.pool.query(
      `UPDATE public.ticketing_email_outbox SET status = 'pending', attempts = 0, next_attempt_at = now(), sent_at = NULL, last_error = NULL
       WHERE order_id = $1 AND kind = 'order_tickets'`,
      [t.orderId],
    );
    const [m] = await deliver();
    expect(m).toBeDefined();
    const tickets = await pageCredentials(t.orderId);
    expect(tickets.length).toBeGreaterThan(0);
    expect(m!.attachments).toHaveLength(tickets.length);
    for (const ticket of tickets) {
      const code = ticket.id.slice(0, 8).toUpperCase();
      const a = m!.attachments!.find((x) => x.filename === `billet-${code}.gif`)!;
      expect(a, code).toBeDefined();
      expect(a.contentType).toBe("image/gif");
      expect(a.content).toBe(qrGif(ticket.credential!));
      expect(m!.html).toContain(`src="cid:${a.contentId}"`);
      expect(m!.html).toContain(`alt="Code QR du billet ${code}"`);
    }
    expect(m!.html).toContain("Vos codes QR");
    expect(m!.text).toContain("Vos codes QR sont aussi dans ce courriel");
    // Run 54: the options bought, which have no QR code of their own.
    const flex = t.types.find((x) => x.code === "FLEX_WEATHER")!;
    expect(m!.html).toContain(`Options : ${flex.name} × 4`);
    expect(m!.text).toContain(`Options : ${flex.name} × 4`);
  });

  it("are in the reminder the day before too", async () => {
    const t = seed.havana;
    await db.pool.query(`UPDATE public.ticketing_sessions SET starts_at = now() + interval '20 hours' WHERE id = $1`, [t.sessionId]);
    await db.pool.query(`DELETE FROM public.ticketing_email_outbox WHERE order_id = $1 AND kind = 'reminder'`, [t.orderId]);
    await db.pool.query(
      `INSERT INTO public.ticketing_email_outbox (client_id, brand_id, event_id, order_id, kind) VALUES ($1, $2, $3, $4, 'reminder')`,
      [t.clientId, t.brandId, t.eventId, t.orderId],
    );
    const [m] = await deliver();
    expect(m!.subject).toMatch(/^Rappel/);
    expect(m!.attachments).toHaveLength((await pageCredentials(t.orderId)).length);
    expect(m!.html).toContain("Vos codes QR");
  });

  it("leave a voided ticket out", async () => {
    const t = seed.havana;
    const before = await pageCredentials(t.orderId);
    await db.pool.query(`UPDATE public.ticketing_tickets SET status = 'void', void_reason = 'admin', voided_at = now() WHERE id = $1`, [before[0]!.id]);
    await db.pool.query(
      `UPDATE public.ticketing_email_outbox SET status = 'pending', attempts = 0, next_attempt_at = now(), sent_at = NULL WHERE order_id = $1 AND kind = 'order_tickets'`,
      [t.orderId],
    );
    const [m] = await deliver();
    expect(m!.attachments).toHaveLength(before.length - 1);
    expect(m!.html).not.toContain(before[0]!.id.slice(0, 8).toUpperCase());
  });

  it("stay out of the e-mail above the limit, or before any credential exists", async () => {
    const many = { payloadsForOrder: async () => new Map(Array.from({ length: MAX_CODES_IN_EMAIL + 1 }, (_, i) => [`t${i}`, `p${i}`])) };
    expect(await emailCodes(db.pool, many, { clientId: seed.havana.clientId, brandId: seed.havana.brandId }, seed.havana.orderId)).toBeNull();
    const none = { payloadsForOrder: async () => new Map<string, string>() };
    expect(await emailCodes(db.pool, none, { clientId: seed.havana.clientId, brandId: seed.havana.brandId }, seed.havana.orderId)).toBeNull();
  });

  it("go to Resend as inline attachments with their content id", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ id: "em_1" }), { status: 200 });
    }) as typeof fetch;
    await new ResendEmailSender("re_test_key", "billets@alkao.ca", fetchImpl).send({
      to: "a@example.com", fromName: "B", subject: "S", text: "T", html: `<img src="cid:billet-1@alkao">`, idempotencyKey: "k",
      attachments: [{ filename: "billet-1.gif", content: "R0lGOD", contentType: "image/gif", contentId: "billet-1@alkao" }],
    });
    expect(body.attachments).toEqual([{ filename: "billet-1.gif", content: "R0lGOD", content_type: "image/gif", content_id: "billet-1@alkao" }]);
  });
});
