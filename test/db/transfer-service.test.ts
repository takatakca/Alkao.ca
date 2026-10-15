import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { seedPaidOrder, seedTwoTenants, TEST_CREDENTIAL_SECRET, type SeedResult } from "../helpers/seed.js";
import { prepareTransferInvitation, cancelTransferInvitation } from "../../src/ops/transfer-request.js";

let db: TestDatabase;
let seed: SeedResult;
let orderId: string;
let ticketIds: string[];

const scope = () => ({ clientId: seed.havana.clientId, brandId: seed.havana.brandId });
const key = () => `secret-${orderId}`;

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  const order = await seedPaidOrder(db.pool, seed.havana, "transfer-purchase@example.com");
  orderId = order.orderId;
  ticketIds = order.ticketIds;
});
afterAll(async () => { await db?.drop(); });

describe("Run 77 private transfer service — invitation creation and cancellation", () => {
  it("requires the correct tenant and a valid order bearer, and defaults transfers off", async () => {
    await expect(prepareTransferInvitation(db.pool, scope(), orderId, ticketIds[0]!, key(), "recipient@example.com", TEST_CREDENTIAL_SECRET))
      .rejects.toMatchObject({ code: "constraint_violation" });
    await db.pool.query(
      `UPDATE public.ticketing_brand_settings SET ticket_transfers_enabled = true
       WHERE client_id = $1 AND brand_id = $2`, [scope().clientId, scope().brandId],
    );
    await expect(prepareTransferInvitation(db.pool, scope(), orderId, ticketIds[0]!, "wrong", "recipient@example.com", TEST_CREDENTIAL_SECRET))
      .rejects.toMatchObject({ code: "order_not_found" });
    await expect(prepareTransferInvitation(db.pool, scope(), orderId, seed.festi.ticketIds[1]!, key(), "recipient@example.com", TEST_CREDENTIAL_SECRET))
      .rejects.toMatchObject({ code: "ticket_not_found" });
    await expect(prepareTransferInvitation(db.pool,
      { clientId: seed.festi.clientId, brandId: seed.festi.brandId },
      orderId, ticketIds[0]!, key(), "recipient@example.com", TEST_CREDENTIAL_SECRET))
      .rejects.toMatchObject({ code: "order_not_found" });
    await expect(prepareTransferInvitation(db.pool, scope(), orderId, ticketIds[0]!, key(), "not an email", TEST_CREDENTIAL_SECRET))
      .rejects.toMatchObject({ code: "invalid_recipient_email" });
  });

  it("creates a hashed, one-time invitation and cancels without revealing a recipient token in audit", async () => {
    const t = await prepareTransferInvitation(db.pool, scope(), orderId, ticketIds[0]!, key(), " Recipient@Example.com ", TEST_CREDENTIAL_SECRET);
    expect(t.recipientEmail).toBe("recipient@example.com");
    expect(t.recipientClaimSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const delivery = await db.pool.query<{ status: string }>(
      `SELECT status FROM public.ticketing_transfer_invitation_outbox
       WHERE request_id = $1 AND client_id = $2 AND brand_id = $3`,
      [t.id, scope().clientId, scope().brandId],
    );
    expect(delivery.rows[0]?.status).toBe("pending");
    const row = (await db.pool.query<{ recipient_email: string; claim_token_hash: Buffer; status: string }>(
      `SELECT recipient_email, claim_token_hash, status FROM public.ticketing_transfer_requests WHERE id = $1`, [t.id],
    )).rows[0]!;
    expect(row).toMatchObject({ recipient_email: "recipient@example.com", status: "pending" });
    expect(row.claim_token_hash.equals(createHash("sha256").update(t.recipientClaimSecret).digest())).toBe(true);
    expect(await cancelTransferInvitation(db.pool, scope(), orderId, t.id, key())).toBe(true);
    expect(await cancelTransferInvitation(db.pool, scope(), orderId, t.id, key())).toBe(false);
    const entries = await db.pool.query<{ action: string; data: Record<string, unknown> }>(
      `SELECT action, data FROM public.ticketing_audit_log
       WHERE client_id = $1 AND brand_id = $2 AND action LIKE 'ticket.transfer_%'`,
      [scope().clientId, scope().brandId],
    );
    expect(entries.rows.map((r) => r.action).sort()).toEqual(["ticket.transfer_cancelled", "ticket.transfer_requested"]);
    expect(JSON.stringify(entries.rows)).not.toContain(t.recipientClaimSecret);
    expect(JSON.stringify(entries.rows)).not.toContain(t.recipientEmail);
  });

  it("prevents duplicate pending requests, wrong-order cancellation and expired order credentials", async () => {
    const t = await prepareTransferInvitation(db.pool, scope(), orderId, ticketIds[1]!, key(), "friend@example.com", TEST_CREDENTIAL_SECRET);
    await expect(prepareTransferInvitation(db.pool, scope(), orderId, ticketIds[1]!, key(), "friend2@example.com", TEST_CREDENTIAL_SECRET))
      .rejects.toMatchObject({ code: "conflict" });
    expect(await cancelTransferInvitation(db.pool, scope(), seed.havana.orderId, t.id,
      `secret-${seed.havana.orderId}`)).toBe(false);
    const now = new Date();
    await db.pool.query(
      `UPDATE public.ticketing_access_tokens SET expires_at = $4
       WHERE subject_type = 'order' AND subject_id = $1 AND client_id = $2
         AND brand_id = $3 AND purpose = 'checkout'`,
      [orderId, scope().clientId, scope().brandId, new Date(now.getTime() - 1000)],
    );
    try {
      await expect(cancelTransferInvitation(db.pool, scope(), orderId, t.id, key(), now))
        .rejects.toMatchObject({ code: "order_not_found" });
    } finally {
      await db.pool.query(
        `UPDATE public.ticketing_access_tokens SET expires_at = NULL
         WHERE subject_type = 'order' AND subject_id = $1 AND client_id = $2 AND brand_id = $3 AND purpose = 'checkout'`,
        [orderId, scope().clientId, scope().brandId],
      );
    }
    expect(await cancelTransferInvitation(db.pool, scope(), orderId, t.id, key())).toBe(true);
  });
});
