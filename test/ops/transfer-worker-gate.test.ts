import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runBackgroundOnce } from "../../src/ops/cron.js";
import { prepareTransferInvitation } from "../../src/ops/transfer-request.js";
import type { EmailMessage, EmailSender } from "../../src/delivery/email.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { seedPaidOrder, seedTwoTenants, TEST_CREDENTIAL_SECRET, type SeedResult } from "../helpers/seed.js";

let db: TestDatabase;
let seed: SeedResult;
const sent: EmailMessage[] = [];
const sender: EmailSender = { send: async (email) => (sent.push(email), "msg-" + sent.length) };
const email = {
  sender, publicUrl: "https://billets.alkao.test", credentialMasterSecret: TEST_CREDENTIAL_SECRET,
  transferInvitesEnabled: false,
};

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  await db.pool.query("UPDATE public.ticketing_email_outbox SET status = 'skipped', last_error = 'test'");
  await db.pool.query(
    "UPDATE public.ticketing_brand_settings SET ticket_transfers_enabled = true WHERE client_id = $1 AND brand_id = $2",
    [seed.havana.clientId, seed.havana.brandId],
  );
});
afterAll(async () => { await db?.drop(); });

describe("Run 80: transfer invitations never sent by a default-off background worker", () => {
  it("requires explicit release on cron and delivers once after switching on", async () => {
    const h = seed.havana;
    const paid = await seedPaidOrder(db.pool, h, "cron-" + randomUUID() + "@example.com", { GENERAL: 1 });
    await db.pool.query("UPDATE public.ticketing_email_outbox SET status = 'skipped', last_error = 'test'");
    const invitation = await prepareTransferInvitation(
      db.pool, { clientId: h.clientId, brandId: h.brandId }, paid.orderId,
      paid.ticketIds[0]!, "secret-" + paid.orderId, "recipient@example.com", TEST_CREDENTIAL_SECRET,
    );
    const now = new Date(Date.now() + 2000);
    const off = await runBackgroundOnce(db.pool, { email, payments: null }, now);
    expect(off.ran).toBe(true);
    expect(off.transferInvites).toBeNull();
    expect(sent.filter(m => m.to === "recipient@example.com")).toHaveLength(0);
    expect((await db.pool.query<{ status: string }>(
      "SELECT status FROM public.ticketing_transfer_invitation_outbox WHERE request_id = $1",
      [invitation.id],
    )).rows[0]?.status).toBe("pending");

    const on = await runBackgroundOnce(db.pool, {
      email: { ...email, transferInvitesEnabled: true }, payments: null,
    }, now);
    expect(on.transferInvites).toMatchObject({ sent: 1, retried: 0, failed: 0 });
    const letters = sent.filter(m => m.to === "recipient@example.com");
    expect(letters).toHaveLength(1);
    expect(letters[0]!.text).toContain("/billets/transfert#");
    expect(letters[0]!.text).not.toContain("secret-" + paid.orderId);

    const again = await runBackgroundOnce(db.pool, {
      email: { ...email, transferInvitesEnabled: true }, payments: null,
    }, new Date(now.getTime() + 1000));
    expect(again.transferInvites?.sent).toBe(0);
    expect(sent.filter(m => m.to === "recipient@example.com")).toHaveLength(1);
  });
});
