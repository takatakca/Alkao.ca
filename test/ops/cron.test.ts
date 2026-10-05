import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EmailMessage, EmailSender } from "../../src/delivery/email.js";
import { runBackgroundOnce } from "../../src/ops/cron.js";
import { PaymentsService } from "../../src/payments/service.js";
import { call, pub, testApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { FakeGateway } from "../helpers/fake-gateway.js";
import { seedTwoTenants, TEST_CREDENTIAL_SECRET, type SeedResult } from "../helpers/seed.js";

/** Run 39: `npm run cron`, every background worker once, for cPanel cron. */
let db: TestDatabase;
let seed: SeedResult;

class Outbox implements EmailSender {
  sent: EmailMessage[] = [];
  async send(m: EmailMessage) { this.sent.push(m); return `msg_${this.sent.length}`; }
}

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
});

afterAll(async () => {
  await db?.drop();
});

// A moment ahead: emails stamped in the same millisecond would not be due yet.
const soon = () => new Date(Date.now() + 1000);
const pendingEmails = async () =>
  (await db.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.ticketing_email_outbox WHERE status = 'pending'`)).rows[0]!.n;

/** A hold made through the shop (10 minutes long); `later` is past its deadline. */
async function hold() {
  const f = seed.festi;
  const h = await call(testApp(db.pool), "POST", `${pub(f.clientId, f.brandId)}/holds`, {
    body: { sessionId: f.sessionId, items: [{ ticketTypeId: f.types.find((t) => t.code === "GENERAL")!.id, quantity: 1 }] },
  });
  expect(h.status).toBe(201);
  return h.body.hold.id as string;
}
const later = () => new Date(Date.now() + 11 * 60_000);

describe("background pass for cron", () => {
  it("frees expired seats even without email or Stripe settings, and leaves emails queued", async () => {
    const id = await hold();
    const before = await pendingEmails();
    expect(before).toBeGreaterThan(0);
    const r = await runBackgroundOnce(db.pool, { email: null, payments: null }, later());
    expect(r).toEqual({ ran: true, expiredHolds: 1, remindersQueued: 0, emails: null, cancellationJobs: null });
    expect((await db.pool.query(`SELECT status FROM public.ticketing_holds WHERE id = $1`, [id])).rows[0].status).toBe("expired");
    expect(await pendingEmails()).toBe(before);
  });

  it("sends the queued emails and advances cancellations when configured", async () => {
    const sender = new Outbox();
    const payments = new PaymentsService({ db: db.pool, gateway: new FakeGateway(), now: () => new Date(), onboarding: null });
    const r = await runBackgroundOnce(db.pool, {
      email: { sender, publicUrl: "https://billets.alkao.test", credentialMasterSecret: TEST_CREDENTIAL_SECRET },
      payments,
    }, soon());
    expect(r.ran).toBe(true);
    expect(r.emails!.sent).toBe(sender.sent.length);
    expect(sender.sent.length).toBeGreaterThan(0);
    expect(r.cancellationJobs).toBe(0);
    expect(await pendingEmails()).toBe(0);
  });

  it("does nothing while another pass holds the lock, and takes it again afterwards", async () => {
    const other = await db.pool.connect();
    try {
      await other.query(`SELECT pg_advisory_lock(hashtext('alkao_cron'))`);
      await hold();
      expect(await runBackgroundOnce(db.pool, { email: null, payments: null }, later())).toMatchObject({ ran: false, expiredHolds: 0 });
      await other.query(`SELECT pg_advisory_unlock(hashtext('alkao_cron'))`);
    } finally {
      other.release();
    }
    expect(await runBackgroundOnce(db.pool, { email: null, payments: null }, later())).toMatchObject({ ran: true, expiredHolds: 1 });
  });
});
