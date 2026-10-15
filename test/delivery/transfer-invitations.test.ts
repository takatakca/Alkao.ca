import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { seedPaidOrder, seedTwoTenants, TEST_CREDENTIAL_SECRET, type SeedResult } from "../helpers/seed.js";
import { prepareTransferInvitation, cancelTransferInvitation } from "../../src/ops/transfer-request.js";
import { transferClaimHash, transferClaimSecret, transferClaimUrl } from "../../src/delivery/transfer-token.js";
import { deliverRecipientInvitations, recipientInvitationEmail } from "../../src/delivery/transfer-invitations.js";
import { EmailSendError, type EmailMessage, type EmailSender } from "../../src/delivery/email.js";

let db: TestDatabase;
let seed: SeedResult;
const url = "https://billets.alkao.test";
const scope = () => ({ clientId: seed.havana.clientId, brandId: seed.havana.brandId });
class Sender implements EmailSender {
  messages: EmailMessage[] = [];
  fail: EmailSendError | null = null;
  async send(message: EmailMessage) {
    if (this.fail) throw this.fail;
    this.messages.push(message);
    return `delivery-${this.messages.length}`;
  }
}
const config = (sender: Sender, key = TEST_CREDENTIAL_SECRET) =>
  ({ sender, publicUrl: url, credentialMasterSecret: key });
const invite = async (ticketIndex = 0, recipient = "friend@example.com") => {
  const order = await seedPaidOrder(db.pool, seed.havana, `buyer-${randomUUID()}@example.com`);
  const item = await prepareTransferInvitation(db.pool, scope(), order.orderId,
    order.ticketIds[ticketIndex]!, `secret-${order.orderId}`, recipient, TEST_CREDENTIAL_SECRET);
  return { ...item, orderId: order.orderId };
};

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  await db.pool.query(`UPDATE public.ticketing_brand_settings SET ticket_transfers_enabled = true
    WHERE client_id = $1 AND brand_id = $2`, [scope().clientId, scope().brandId]);
});
afterAll(async () => { await db?.drop(); });

describe("Run 78: staging queue for recipient email (not connected to worker)", () => {
  it("reconstructs one-time proof from the master secret and sends to recipient only", async () => {
    const created = await invite();
    const derived = transferClaimSecret(TEST_CREDENTIAL_SECRET, scope(), created.id,
      created.ticketId, created.recipientEmail);
    expect(derived).toBe(created.recipientClaimSecret);
    const saved = (await db.pool.query<{ claim_token_hash: Buffer }>(
      `SELECT claim_token_hash FROM public.ticketing_transfer_requests WHERE id = $1`, [created.id],
    )).rows[0]!;
    expect(saved.claim_token_hash.equals(transferClaimHash(derived))).toBe(true);
    const sender = new Sender();
    const sent = await deliverRecipientInvitations(db.pool, config(sender), new Date(Date.now() + 1000));
    expect(sent.sent).toBe(1);
    expect(sender.messages).toHaveLength(1);
    const msg = sender.messages[0]!;
    expect(msg.to).toBe("friend@example.com");
    const target = transferClaimUrl(url, scope(), created.id, derived);
    expect(msg.text).toContain(target);
    expect(msg.html).toContain("Examiner le transfert");
    expect(new URL(target).search).toBe("");
    expect(new URL(target).hash).toContain("k=");
    expect(msg.text).not.toContain("secret-" + created.orderId);
    const row = (await db.pool.query<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM public.ticketing_transfer_invitation_outbox WHERE request_id = $1`,
      [created.id],
    )).rows[0];
    expect(row).toEqual({ status: "sent", attempts: 1 });
    const again = await deliverRecipientInvitations(db.pool, config(sender), new Date(Date.now() + 3000));
    expect(again.sent).toBe(0);
    expect(sender.messages).toHaveLength(1);
  });

  it("never emails cancelled or no-longer-authorized invitations", async () => {
    const cancelled = await invite(0, "cancel@example.com");
    expect(await cancelTransferInvitation(db.pool, scope(), cancelled.orderId, cancelled.id,
      `secret-${cancelled.orderId}`)).toBe(true);
    const other = await invite(1, "other@example.com");
    await db.pool.query(`UPDATE public.ticketing_brand_settings SET ticket_transfers_enabled = false
      WHERE client_id = $1 AND brand_id = $2`, [scope().clientId, scope().brandId]);
    const sender = new Sender();
    try {
      const result = await deliverRecipientInvitations(db.pool, config(sender), new Date(Date.now() + 1000));
      expect(result.skipped).toBe(2);
      expect(sender.messages).toEqual([]);
      const errors = (await db.pool.query<{ last_error: string }>(
        `SELECT last_error FROM public.ticketing_transfer_invitation_outbox
         WHERE request_id = ANY($1::uuid[]) ORDER BY last_error`, [[cancelled.id, other.id]],
      )).rows.map((r) => r.last_error);
      expect(errors).toEqual(["brand_disabled", "request_closed"]);
    } finally {
      await db.pool.query(`UPDATE public.ticketing_brand_settings SET ticket_transfers_enabled = true
       WHERE client_id = $1 AND brand_id = $2`, [scope().clientId, scope().brandId]);
    }
  });

  it("retries transient provider failures without persisting a recipient secret", async () => {
    const created = await invite(2, "retry@example.com");
    const sender = new Sender();
    sender.fail = new EmailSendError("temporary provider outage", true);
    expect((await deliverRecipientInvitations(db.pool, config(sender), new Date(Date.now() + 1000))).retried).toBe(1);
    sender.fail = null;
    expect((await deliverRecipientInvitations(db.pool, config(sender), new Date(Date.now() + 180000))).sent).toBe(1);
    const status = (await db.pool.query<{ attempts: number; status: string; last_error: string | null }>(
      `SELECT attempts, status, last_error FROM public.ticketing_transfer_invitation_outbox WHERE request_id = $1`,
      [created.id],
    )).rows[0]!;
    expect(status).toEqual({ attempts: 2, status: "sent", last_error: null });
    const noSecret = JSON.stringify(await db.pool.query(
      `SELECT status, last_error, provider_message_id FROM public.ticketing_transfer_invitation_outbox WHERE request_id = $1`,
      [created.id],
    ));
    expect(noSecret).not.toContain(created.recipientClaimSecret);
  });

  it("rejects a rotated master key and escapes untrusted names in the template", async () => {
    await invite(3, "rotation@example.com");
    const sender = new Sender();
    const result = await deliverRecipientInvitations(db.pool, config(sender, "different-valid-master-key"), new Date(Date.now() + 1000));
    expect(result.skipped).toBe(1);
    expect(sender.messages).toHaveLength(0);
    const email = recipientInvitationEmail({
      brandName: "<b>Unsafe</b>", eventTitle: "Jazz & <script>alert(1)</script>",
      link: "https://example.test/billets/transfert#k=abc", language: "en",
    });
    expect(email.html).toContain("&lt;script&gt;");
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("Review transfer");
  });
});
