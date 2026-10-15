import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { seedPaidOrder, seedTwoTenants, TEST_CREDENTIAL_SECRET, type SeedResult } from "../helpers/seed.js";
import { prepareTransferInvitation, cancelTransferInvitation } from "../../src/ops/transfer-request.js";
import { acceptTransferInvitation, transferredCredentialForRecipient } from "../../src/ops/transfer-acceptance.js";
import { CredentialsService } from "../../src/scanner/service.js";
import { insertScan } from "../../src/db/credentials.js";

let db: TestDatabase;
let seed: SeedResult;
const scope = () => ({ clientId: seed.havana.clientId, brandId: seed.havana.brandId });
const creds = () => new CredentialsService({ db: db.pool,
  masterSecret: TEST_CREDENTIAL_SECRET, now: () => new Date() });
const fresh = async () => {
  const paid = await seedPaidOrder(db.pool, seed.havana, `claim-owner-${randomUUID()}@example.com`);
  const request = await prepareTransferInvitation(db.pool, scope(), paid.orderId, paid.ticketIds[0]!,
    `secret-${paid.orderId}`, "recipient@example.com", TEST_CREDENTIAL_SECRET);
  return { paid, request };
};

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  await db.pool.query(`UPDATE public.ticketing_brand_settings SET ticket_transfers_enabled = true
    WHERE client_id = $1 AND brand_id = $2`, [scope().clientId, scope().brandId]);
});
afterAll(async () => { await db?.drop(); });

describe("Run 79: transaction-safe acceptance and recipient QR", () => {
  it("accepts once, revokes old QR, issues a new one and hides it from the sender", async () => {
    const { paid, request } = await fresh();
    const original = await db.pool.query<{ id: string }>(
      `SELECT id FROM public.ticketing_credentials WHERE ticket_id = $1 AND status = 'active'`,
      [request.ticketId],
    );
    const originalId = original.rows[0]!.id;
    const result = await acceptTransferInvitation(db.pool, scope(), request.id,
      request.recipientClaimSecret, TEST_CREDENTIAL_SECRET);
    expect(result.ticketId).toBe(request.ticketId);
    expect(result.credentialId).not.toBe(originalId);
    expect(result.recipientAccessToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const states = (await db.pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM public.ticketing_credentials WHERE ticket_id = $1 ORDER BY created_at, id`,
      [request.ticketId],
    )).rows;
    expect(states).toHaveLength(2);
    expect(states.find(x => x.id === originalId)?.status).toBe("revoked");
    expect(states.find(x => x.id === result.credentialId)?.status).toBe("active");
    expect((await db.pool.query<{ status: string }>(
      `SELECT status FROM public.ticketing_transfer_requests WHERE id = $1`, [request.id],
    )).rows[0]?.status).toBe("claimed");
    expect((await creds().payloadsForOrder(scope(), paid.orderId)).has(request.ticketId)).toBe(false);
    const recipient = await transferredCredentialForRecipient(db.pool, scope(), request.id,
      result.recipientAccessToken);
    expect(recipient).toEqual({ ticketId: request.ticketId, credentialId: result.credentialId });
    const payload = await creds().payloadFor(scope().clientId, recipient.credentialId);
    expect(payload.length).toBeGreaterThan(20);
    const manifest = await creds().manifest(scope(), seed.havana.sessionId);
    expect(manifest.revoked.map(x => x.id)).toContain(originalId);
    expect(manifest.credentials.map(x => x.id)).toContain(result.credentialId);
    await expect(acceptTransferInvitation(db.pool, scope(), request.id,
      request.recipientClaimSecret, TEST_CREDENTIAL_SECRET))
      .rejects.toMatchObject({ code: "transfer_unavailable" });
    await expect(transferredCredentialForRecipient(db.pool, scope(), request.id,
      request.recipientClaimSecret)).rejects.toMatchObject({ code: "transfer_unavailable" });
    await expect(transferredCredentialForRecipient(db.pool, { clientId: seed.festi.clientId,
      brandId: seed.festi.brandId }, request.id, result.recipientAccessToken))
      .rejects.toMatchObject({ code: "transfer_unavailable" });
  });

  it("refuses wrong, cancelled and late claims without revoking the original QR", async () => {
    const { paid, request } = await fresh();
    await expect(acceptTransferInvitation(db.pool, scope(), request.id,
      "invalid", TEST_CREDENTIAL_SECRET)).rejects.toMatchObject({ code: "transfer_unavailable" });
    await expect(acceptTransferInvitation(db.pool, scope(), request.id,
      "A".repeat(43), TEST_CREDENTIAL_SECRET)).rejects.toMatchObject({ code: "transfer_unavailable" });
    expect((await db.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM public.ticketing_transfer_acceptances WHERE ticket_id = $1`,
      [request.ticketId],
    )).rows[0]?.count).toBe(0);
    expect(await cancelTransferInvitation(db.pool, scope(), paid.orderId, request.id,
      `secret-${paid.orderId}`)).toBe(true);
    await expect(acceptTransferInvitation(db.pool, scope(), request.id,
      request.recipientClaimSecret, TEST_CREDENTIAL_SECRET))
      .rejects.toMatchObject({ code: "transfer_unavailable" });
    const late = await fresh();
    await expect(acceptTransferInvitation(db.pool, scope(), late.request.id,
      late.request.recipientClaimSecret, TEST_CREDENTIAL_SECRET,
      new Date(Date.now() + 30 * 3600_000)))
      .rejects.toMatchObject({ code: "transfer_unavailable" });
  });

  it("allows only one of two concurrent recipients to claim a ticket", async () => {
    const { request } = await fresh();
    const attempts = await Promise.allSettled([1, 2].map(() =>
      acceptTransferInvitation(db.pool, scope(), request.id,
        request.recipientClaimSecret, TEST_CREDENTIAL_SECRET)));
    expect(attempts.filter(x => x.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(x => x.status === "rejected")).toHaveLength(1);
    expect((await db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.ticketing_transfer_acceptances WHERE request_id = $1`,
      [request.id],
    )).rows[0]?.n).toBe(1);
    await expect(prepareTransferInvitation(db.pool, scope(),
      (await db.pool.query<{ order_id: string }>(
        `SELECT order_id FROM public.ticketing_tickets WHERE id = $1`, [request.ticketId],
      )).rows[0]!.order_id, request.ticketId,
      "no", "friend@example.com", TEST_CREDENTIAL_SECRET))
      .rejects.toBeDefined();
  });

  it("cannot claim a ticket admitted at the gate or after the Brand revokes permission", async () => {
    const scanned = await fresh();
    const original = (await db.pool.query<{ id: string }>(
      `SELECT id FROM public.ticketing_credentials WHERE ticket_id = $1 AND status = 'active'`,
      [scanned.request.ticketId],
    )).rows[0]!.id;
    await insertScan(db.pool, {
      ...scope(), eventId: seed.havana.eventId, sessionId: seed.havana.sessionId,
      credentialId: original, ticketId: scanned.request.ticketId, result: "admitted",
      deviceId: "claim-race", scannedBy: seed.users.havanaStaff,
      scannedAt: new Date(), offline: false,
    });
    await expect(acceptTransferInvitation(db.pool, scope(), scanned.request.id,
      scanned.request.recipientClaimSecret, TEST_CREDENTIAL_SECRET))
      .rejects.toMatchObject({ code: "transfer_unavailable" });

    const disabled = await fresh();
    await db.pool.query(`UPDATE public.ticketing_brand_settings SET ticket_transfers_enabled = false
      WHERE client_id = $1 AND brand_id = $2`, [scope().clientId, scope().brandId]);
    try {
      await expect(acceptTransferInvitation(db.pool, scope(), disabled.request.id,
        disabled.request.recipientClaimSecret, TEST_CREDENTIAL_SECRET))
        .rejects.toMatchObject({ code: "transfer_unavailable" });
    } finally {
      await db.pool.query(`UPDATE public.ticketing_brand_settings SET ticket_transfers_enabled = true
        WHERE client_id = $1 AND brand_id = $2`, [scope().clientId, scope().brandId]);
    }
  });

  it("the claim and recipient access histories are private even to a tenant member", async () => {
    const { asRole, errorCode } = await import("../helpers/db.js");
    const anon = await asRole(db.pool, "anon", null,
      tx => errorCode(tx, `SELECT recipient_access_hash FROM public.ticketing_transfer_acceptances LIMIT 1`));
    expect(anon).toBe("42501");
    const user = await asRole(db.pool, "authenticated", seed.users.havanaOwner,
      tx => errorCode(tx, `SELECT request_id FROM public.ticketing_transfer_acceptances LIMIT 1`));
    expect(user).toBe("42501");
  });
});
