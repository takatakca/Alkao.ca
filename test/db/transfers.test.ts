import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, asRole, errorCode, type TestDatabase } from "../helpers/db.js";
import { seedPaidOrder, seedTwoTenants, type SeedResult } from "../helpers/seed.js";

let db: TestDatabase;
let seed: SeedResult;
let ticket: string;

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  // The seed's gate fixtures are not admitted; use a dedicated order for these tests.
  const paid = await seedPaidOrder(db.pool, seed.havana, "transfer-owner@example.com");
  ticket = paid.ticketIds[0]!;
});
afterAll(async () => { await db?.drop(); });

const h = () => seed.havana;
const payload = (overrides: Record<string, unknown> = {}) => ({
  client_id: h().clientId, brand_id: h().brandId, event_id: h().eventId,
  session_id: h().sessionId, ticket_id: ticket,
  recipient_email: "Recipient@example.com",
  claim_token_hash: createHash("sha256").update(randomUUID()).digest(),
  expires_at: new Date(Date.now() + 86_400_000),
  ...overrides,
});
const insert = async (values: ReturnType<typeof payload>) => db.pool.query<{ id: string; recipient_email: string }>(
  `INSERT INTO public.ticketing_transfer_requests
   (client_id, brand_id, event_id, session_id, ticket_id, recipient_email, claim_token_hash, expires_at)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
   RETURNING id, recipient_email`,
  [values.client_id, values.brand_id, values.event_id, values.session_id,
   values.ticket_id, values.recipient_email, values.claim_token_hash, values.expires_at],
);

describe("Run 77: transfer request safety boundary (not yet a buyer-facing feature)", () => {
  it("defaults every brand to disabled, requires opt-in and prevents self-transfer", async () => {
    expect((await db.pool.query<{ ticket_transfers_enabled: boolean }>(
      `SELECT ticket_transfers_enabled FROM public.ticketing_brand_settings WHERE client_id = $1 AND brand_id = $2`,
      [h().clientId, h().brandId],
    )).rows[0]?.ticket_transfers_enabled).toBe(false);
    await expect(insert(payload())).rejects.toMatchObject({ code: "23514" });
    await db.pool.query(`UPDATE public.ticketing_brand_settings SET ticket_transfers_enabled = true
      WHERE client_id = $1 AND brand_id = $2`, [h().clientId, h().brandId]);
    await expect(insert(payload({ recipient_email: "transfer-owner@example.com" }))).rejects.toMatchObject({ code: "23514" });
    const { rows } = await insert(payload({ recipient_email: " Recipient@Example.com " }));
    expect(rows[0]?.recipient_email).toBe("recipient@example.com");
    await expect(insert(payload())).rejects.toMatchObject({ code: "23505" });
    const id = rows[0]!.id;
    await expect(db.pool.query(`UPDATE public.ticketing_transfer_requests SET recipient_email = 'other@example.com' WHERE id = $1`, [id]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(db.pool.query(`UPDATE public.ticketing_transfer_requests SET status = 'claimed' WHERE id = $1`, [id]))
      .rejects.toMatchObject({ code: "23514" });
    await db.pool.query(`UPDATE public.ticketing_transfer_requests SET status = 'cancelled' WHERE id = $1`, [id]);
    await expect(db.pool.query(`UPDATE public.ticketing_transfer_requests SET status = 'pending' WHERE id = $1`, [id]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(db.pool.query(`DELETE FROM public.ticketing_transfer_requests WHERE id = $1`, [id]))
      .rejects.toMatchObject({ code: "23514" });
  });

  it("rejects forged tenant references, unscanned-QR invalidity and invalid TTL", async () => {
    await expect(insert(payload({ client_id: seed.festi.clientId, brand_id: seed.festi.brandId })))
      .rejects.toMatchObject({ code: "23514" });
    await expect(insert(payload({ event_id: seed.festi.eventId })))
      .rejects.toMatchObject({ code: "23514" });
    await expect(insert(payload({ expires_at: new Date(Date.now() + 3 * 86_400_000) })))
      .rejects.toMatchObject({ code: "23514" });
    await expect(insert(payload({ expires_at: new Date(Date.now() - 1_000) })))
      .rejects.toMatchObject({ code: "23514" });
    await db.pool.query(`UPDATE public.ticketing_tickets SET status = 'void', void_reason = 'admin', voided_at = now()
      WHERE id = $1`, [ticket]);
    await expect(insert(payload())).rejects.toMatchObject({ code: "23514" });
  });

  it("keeps private recipient addresses and hashes server-only", async () => {
    const result = await asRole(db.pool, "authenticated", seed.users.havanaOwner, async (tx) =>
      errorCode(tx, `SELECT recipient_email FROM public.ticketing_transfer_requests LIMIT 1`));
    expect(result).toBe("42501");
    const anonymous = await asRole(db.pool, "anon", null, async (tx) =>
      errorCode(tx, `SELECT claim_token_hash FROM public.ticketing_transfer_requests LIMIT 1`));
    expect(anonymous).toBe("42501");
  });
});
