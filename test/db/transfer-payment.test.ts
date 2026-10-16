import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { seedPaidOrder, seedTwoTenants, TEST_CREDENTIAL_SECRET, type SeedResult } from "../helpers/seed.js";
import { withTransaction } from "../../src/db/pool.js";
import { insertRefund } from "../../src/db/payments.js";
import { prepareTransferInvitation } from "../../src/ops/transfer-request.js";
import { acceptTransferInvitation } from "../../src/ops/transfer-acceptance.js";
import { deliverRecipientInvitations } from "../../src/delivery/transfer-invitations.js";
import type { EmailMessage, EmailSender } from "../../src/delivery/email.js";

let db: TestDatabase;
let seed: SeedResult;
const scope = () => ({ clientId: seed.havana.clientId, brandId: seed.havana.brandId });
const paid = async () => seedPaidOrder(db.pool, seed.havana,
  `payment-guard-${randomUUID()}@example.com`, { GENERAL: 1 });
const invite = async (order: Awaited<ReturnType<typeof paid>>, to = "friend@example.com") =>
  prepareTransferInvitation(db.pool, scope(), order.orderId,
    order.ticketIds[0]!, `secret-${order.orderId}`, to, TEST_CREDENTIAL_SECRET);
const openRefund = async (order: Awaited<ReturnType<typeof paid>>) =>
  withTransaction(db.pool, tx => insertRefund(tx, {
    ...scope(), eventId: seed.havana.eventId, orderId: order.orderId,
    amountCents: 100, commissionRefundCents: 0,
    voidTicketIds: [order.ticketIds[0]!], reason: "safety-test", requestedBy: "test",
  }));
const dispute = async (order: Awaited<ReturnType<typeof paid>>, status: string) => {
  const { rows } = await db.pool.query<{ id: string }>(
    `INSERT INTO public.ticketing_payment_disputes
      (client_id, brand_id, event_id, order_id, stripe_dispute_id,
       amount_cents, currency, reason, status, provider_updated_at)
     VALUES ($1, $2, $3, $4, $5, 100, 'cad', 'fraudulent', $6, now())
     RETURNING id`,
    [scope().clientId, scope().brandId, seed.havana.eventId, order.orderId,
      `dp_${randomUUID().replace(/-/g,"")}`, status],
  );
  return rows[0]!.id;
};

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  await db.pool.query(
    `UPDATE public.ticketing_brand_settings SET ticket_transfers_enabled = true
     WHERE client_id = $1 AND brand_id = $2`, [scope().clientId, scope().brandId],
  );
});
afterAll(async () => { await db?.drop(); });

describe("Run 81 transfer payment eligibility", () => {
  it("rejects creation of invitations when a refund is pending, including direct database inserts", async () => {
    const order = await paid();
    await openRefund(order);
    await expect(invite(order)).rejects.toMatchObject({ code: "transfer_payment_unsettled" });
    // Backend SQL guard must also refuse attempts bypassing the application service.
    await expect(db.pool.query(
      `INSERT INTO public.ticketing_transfer_requests
         (client_id, brand_id, event_id, session_id, ticket_id,
          recipient_email, claim_token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() + interval '23 hours')`,
      [scope().clientId, scope().brandId, seed.havana.eventId,
        seed.havana.sessionId, order.ticketIds[0], "friend@example.com",
        Buffer.alloc(32, 71)],
    )).rejects.toMatchObject({ code: "23514" });
    const { rows } = await db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.ticketing_transfer_requests
       WHERE ticket_id = $1`, [order.ticketIds[0]],
    );
    expect(rows[0]?.n).toBe(0);
  });

  it("does not rotate QR when the refund begins after invitation creation", async () => {
    const order = await paid();
    const request = await invite(order);
    const before = await db.pool.query<{ id: string }>(
      `SELECT id FROM public.ticketing_credentials
       WHERE ticket_id = $1 AND status = 'active'`, [request.ticketId],
    );
    await openRefund(order);
    await expect(acceptTransferInvitation(db.pool, scope(), request.id,
      request.recipientClaimSecret, TEST_CREDENTIAL_SECRET))
      .rejects.toMatchObject({ code: "transfer_unavailable" });
    const after = await db.pool.query<{ id: string }>(
      `SELECT id FROM public.ticketing_credentials
       WHERE ticket_id = $1 AND status = 'active'`, [request.ticketId],
    );
    expect(after.rows).toEqual(before.rows);
    expect((await db.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM public.ticketing_transfer_acceptances WHERE request_id = $1",
      [request.id],
    )).rows[0]?.n).toBe(0);
  });

  it("refuses open or lost payment disputes but allows a documented win", async () => {
    const order = await paid();
    const id = await dispute(order, "needs_response");
    await expect(invite(order)).rejects.toMatchObject({ code: "transfer_payment_unsettled" });
    await db.pool.query(
      "UPDATE public.ticketing_payment_disputes SET status = 'lost', provider_updated_at = now() WHERE id = $1", [id],
    );
    await expect(invite(order)).rejects.toMatchObject({ code: "transfer_payment_unsettled" });
    await db.pool.query(
      "UPDATE public.ticketing_payment_disputes SET status = 'won', provider_updated_at = now() WHERE id = $1", [id],
    );
    const accepted = await invite(order);
    expect(accepted.id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("defers a recipient invitation during a dispute, then sends it once after a win", async () => {
    // Isolate the queue from earlier test scenarios using separate paid orders.
    await db.pool.query(`UPDATE public.ticketing_transfer_invitation_outbox
      SET status = 'skipped', last_error = 'test_isolation' WHERE status = 'pending'`);
    const order = await paid();
    const request = await invite(order, "blocked-friend@example.com");
    await dispute(order, "under_review");
    const sent: EmailMessage[] = [];
    const sender: EmailSender = { send: async message => {
      sent.push(message);
      return "should-never-send";
    } };
    const result = await deliverRecipientInvitations(db.pool, {
      sender, publicUrl: "https://tickets.alkao.test",
      credentialMasterSecret: TEST_CREDENTIAL_SECRET,
    }, new Date(Date.now() + 1000));
    expect(result).toMatchObject({ sent: 0, retried: 1 });
    expect(sent).toEqual([]);
    const status = async () => (await db.pool.query<{ status: string; last_error: string; attempts: number }>(
      `SELECT status, last_error, attempts FROM public.ticketing_transfer_invitation_outbox
       WHERE request_id = $1`, [request.id],
    )).rows[0];
    expect(await status()).toEqual({ status: "pending", last_error: "payment_unsettled", attempts: 0 });
    await db.pool.query(
      "UPDATE public.ticketing_payment_disputes SET status = 'won', provider_updated_at = now() WHERE order_id = $1",
      [order.orderId],
    );
    const delivered = await deliverRecipientInvitations(db.pool, {
      sender, publicUrl: "https://tickets.alkao.test",
      credentialMasterSecret: TEST_CREDENTIAL_SECRET,
    }, new Date(Date.now() + 16 * 60_000));
    expect(delivered.sent).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe("blocked-friend@example.com");
    expect(await status()).toEqual({ status: "sent", last_error: null, attempts: 1 });
  });
});
