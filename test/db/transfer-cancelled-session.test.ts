import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { seedPaidOrder, seedTwoTenants, TEST_CREDENTIAL_SECRET, type SeedResult } from "../helpers/seed.js";
import { prepareTransferInvitation } from "../../src/ops/transfer-request.js";
import { acceptTransferInvitation } from "../../src/ops/transfer-acceptance.js";
import { cancelSession } from "../../src/ops/cancellation.js";
import { deliverRecipientInvitations } from "../../src/delivery/transfer-invitations.js";
import type { EmailSender, EmailMessage } from "../../src/delivery/email.js";

let db: TestDatabase;
let seed: SeedResult;
const scope = () => ({ clientId: seed.havana.clientId, brandId: seed.havana.brandId });

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  await db.pool.query(`UPDATE public.ticketing_brand_settings SET ticket_transfers_enabled = true
    WHERE client_id = $1 AND brand_id = $2`, [scope().clientId, scope().brandId]);
});
afterAll(async () => { await db?.drop(); });

describe("Run 82: cancelled session prevents transfer before asynchronous refunds", () => {
  it("forbids claim, fresh invitation, direct SQL bypass and new invitation mail", async () => {
    const buyer1 = await seedPaidOrder(db.pool, seed.havana,
      `cancel-session-a-${randomUUID()}@example.com`, { GENERAL: 1 });
    const buyer2 = await seedPaidOrder(db.pool, seed.havana,
      `cancel-session-b-${randomUUID()}@example.com`, { GENERAL: 1 });
    const invitation = await prepareTransferInvitation(
      db.pool, scope(), buyer1.orderId, buyer1.ticketIds[0]!,
      `secret-${buyer1.orderId}`, "recipient@example.com", TEST_CREDENTIAL_SECRET,
    );
    const prior = (await db.pool.query<{ id: string }>(
      `SELECT id FROM public.ticketing_credentials
       WHERE ticket_id = $1 AND status = 'active'`, [buyer1.ticketIds[0]],
    )).rows[0]!.id;
    await cancelSession(db.pool, scope(), seed.havana.sessionId, "Severe weather", {
      type: "user", id: seed.users.havanaOwner,
    });
    // Workers intentionally void/refund later, so the ticket may still be valid.
    const state = (await db.pool.query<{ status: string }>(
      "SELECT status FROM public.ticketing_tickets WHERE id = $1", [buyer1.ticketIds[0]],
    )).rows[0]!.status;
    expect(state).toBe("valid");

    await expect(acceptTransferInvitation(
      db.pool, scope(), invitation.id, invitation.recipientClaimSecret,
      TEST_CREDENTIAL_SECRET,
    )).rejects.toMatchObject({ code: "transfer_unavailable" });
    expect((await db.pool.query<{ id: string }>(
      `SELECT id FROM public.ticketing_credentials
       WHERE ticket_id = $1 AND status = 'active'`, [buyer1.ticketIds[0]],
    )).rows[0]!.id).toBe(prior);

    await expect(prepareTransferInvitation(
      db.pool, scope(), buyer2.orderId, buyer2.ticketIds[0]!,
      `secret-${buyer2.orderId}`, "friend@example.com", TEST_CREDENTIAL_SECRET,
    )).rejects.toMatchObject({ code: "transfer_session_cancelled" });

    await expect(db.pool.query(
      `INSERT INTO public.ticketing_transfer_requests
       (client_id, brand_id, event_id, session_id, ticket_id,
        recipient_email, claim_token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() + interval '23 hours')`,
      [scope().clientId, scope().brandId, seed.havana.eventId, seed.havana.sessionId,
        buyer2.ticketIds[0], "friend@example.com", Buffer.alloc(32, 99)],
    )).rejects.toMatchObject({ code: "23514" });

    const sent: EmailMessage[] = [];
    const sender: EmailSender = { send: async message => {
      sent.push(message);
      return "should-not-send";
    } };
    const result = await deliverRecipientInvitations(db.pool, {
      sender, publicUrl: "https://billets.alkao.test",
      credentialMasterSecret: TEST_CREDENTIAL_SECRET,
    }, new Date(Date.now() + 1000));
    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(1);
    expect(sent).toEqual([]);
    const mail = (await db.pool.query<{ status: string; last_error: string }>(
      "SELECT status, last_error FROM public.ticketing_transfer_invitation_outbox WHERE request_id = $1",
      [invitation.id],
    )).rows[0];
    expect(mail).toEqual({ status: "skipped", last_error: "event_unavailable" });
  });
});
