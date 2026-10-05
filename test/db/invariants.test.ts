import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHold, createOrderFromHold, expireStaleHolds, recordOrderPaid, releaseHold } from "../../src/db/commerce.js";
import { withTransaction } from "../../src/db/pool.js";
import { buildQuote, DomainError, type Quote } from "../../src/domain/index.js";
import { createTestDatabase, errorCode, type TestDatabase } from "../helpers/db.js";
import { seedPaidOrder, seedTwoTenants, type SeedResult, type TenantFixture } from "../helpers/seed.js";

let db: TestDatabase;
let seed: SeedResult;

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
});

afterAll(async () => {
  await db?.drop();
});

const scope = (t: TenantFixture) => ({ clientId: t.clientId, brandId: t.brandId });
const typeId = (t: TenantFixture, code: string) => t.types.find((x) => x.code === code)!.id;

async function newSession(t: TenantFixture, capacity: number): Promise<string> {
  const { rows } = await db.pool.query<{ id: string }>(
    `INSERT INTO public.ticketing_sessions (client_id, brand_id, event_id, starts_at, capacity, status)
     VALUES ($1, $2, $3, now() + (random() * interval '300 days') + interval '1 day', $4, 'on_sale') RETURNING id`,
    [t.clientId, t.brandId, t.eventId, capacity],
  );
  return rows[0]!.id;
}

async function session(id: string) {
  const { rows } = await db.pool.query<{ capacity: number; reserved_count: number; sold_count: number }>(
    `SELECT capacity, reserved_count, sold_count FROM public.ticketing_sessions WHERE id = $1`,
    [id],
  );
  return rows[0]!;
}

function generalQuote(t: TenantFixture, quantity: number): Quote {
  const r = buildQuote(t.types, [{ ticketTypeId: typeId(t, "GENERAL"), quantity }], "CA-QC");
  if (!r.ok) throw new Error("quote");
  return r.quote;
}

function holdInput(t: TenantFixture, sessionId: string, quantity: number, ttlMs = 600_000) {
  return {
    ...scope(t),
    eventId: t.eventId,
    sessionId,
    admissions: quantity,
    items: [{ ticketTypeId: typeId(t, "GENERAL"), quantity, unitPriceCents: 2995 }],
    expiresAt: new Date(Date.now() + ttlMs),
  };
}

describe("inventory", () => {
  it("never oversells under concurrent holds", async () => {
    const t = seed.havana;
    const sessionId = await newSession(t, 10);
    const attempts = await Promise.allSettled(
      Array.from({ length: 30 }, () => withTransaction(db.pool, (tx) => createHold(tx, holdInput(t, sessionId, 1)))),
    );
    const ok = attempts.filter((a) => a.status === "fulfilled");
    const failed = attempts.filter((a): a is PromiseRejectedResult => a.status === "rejected");
    expect(ok).toHaveLength(10);
    expect(failed).toHaveLength(20);
    for (const f of failed) expect((f.reason as DomainError).code).toBe("sold_out");
    expect(await session(sessionId)).toMatchObject({ capacity: 10, reserved_count: 10, sold_count: 0 });
  });

  it("counters follow holds and tickets exactly", async () => {
    const t = seed.havana;
    const sessionId = await newSession(t, 5);
    const quote = generalQuote(t, 3);
    const orderId = await withTransaction(db.pool, async (tx) => {
      const hold = await createHold(tx, holdInput(t, sessionId, 3));
      const order = await createOrderFromHold(tx, { ...scope(t), holdId: hold.id, buyer: { email: "a@example.com" }, quote, commissionCents: 0 });
      return order.id;
    });
    expect(await session(sessionId)).toMatchObject({ reserved_count: 3, sold_count: 0 });

    const ticketIds = await withTransaction(db.pool, (tx) => recordOrderPaid(tx, scope(t), orderId, new Date()));
    expect(ticketIds).toHaveLength(3);
    expect(await session(sessionId)).toMatchObject({ reserved_count: 0, sold_count: 3 });

    await db.pool.query(
      `UPDATE public.ticketing_tickets SET status = 'void', void_reason = 'refunded', voided_at = now() WHERE id = $1`,
      [ticketIds[0]],
    );
    expect(await session(sessionId)).toMatchObject({ reserved_count: 0, sold_count: 2 });
  });

  it("returns capacity when holds are released or expire", async () => {
    const t = seed.festi;
    const sessionId = await newSession(t, 4);
    const a = await withTransaction(db.pool, (tx) => createHold(tx, holdInput(t, sessionId, 2)));
    await withTransaction(db.pool, (tx) => createHold(tx, holdInput(t, sessionId, 2, 1_000)));
    await expect(withTransaction(db.pool, (tx) => createHold(tx, holdInput(t, sessionId, 1)))).rejects.toMatchObject({ code: "sold_out" });

    expect(await withTransaction(db.pool, (tx) => releaseHold(tx, scope(t), a.id))).toBe(true);
    expect(await withTransaction(db.pool, (tx) => releaseHold(tx, scope(t), a.id))).toBe(false);
    expect(await session(sessionId)).toMatchObject({ reserved_count: 2 });

    const expired = await withTransaction(db.pool, (tx) => expireStaleHolds(tx, new Date(Date.now() + 5_000), sessionId));
    expect(expired).toBe(1);
    expect(await session(sessionId)).toMatchObject({ reserved_count: 0 });
  });

  it("cannot release another Client's hold", async () => {
    const t = seed.havana;
    const sessionId = await newSession(t, 2);
    const hold = await withTransaction(db.pool, (tx) => createHold(tx, holdInput(t, sessionId, 1)));
    expect(await withTransaction(db.pool, (tx) => releaseHold(tx, scope(seed.festi), hold.id))).toBe(false);
    expect(await session(sessionId)).toMatchObject({ reserved_count: 1 });
  });

  it("refuses holds on sessions that are not on sale", async () => {
    const t = seed.havana;
    const sessionId = await newSession(t, 5);
    await db.pool.query(`UPDATE public.ticketing_sessions SET status = 'paused' WHERE id = $1`, [sessionId]);
    await expect(withTransaction(db.pool, (tx) => createHold(tx, holdInput(t, sessionId, 1)))).rejects.toMatchObject({
      code: "session_not_on_sale",
    });
  });

  it("refuses to lower capacity below what is committed", async () => {
    const t = seed.havana;
    const sessionId = await newSession(t, 5);
    await withTransaction(db.pool, (tx) => createHold(tx, holdInput(t, sessionId, 3)));
    const tx = await db.pool.connect();
    try {
      await tx.query("BEGIN");
      expect(await errorCode(tx, `UPDATE public.ticketing_sessions SET capacity = 2 WHERE id = $1`, [sessionId])).toBe("23514");
      expect(await errorCode(tx, `UPDATE public.ticketing_sessions SET capacity = 3 WHERE id = $1`, [sessionId])).toBeNull();
    } finally {
      await tx.query("ROLLBACK");
      tx.release();
    }
  });

  it("closes a hold once and keeps its quantity consistent with its items", async () => {
    const t = seed.havana;
    const sessionId = await newSession(t, 5);
    const hold = await withTransaction(db.pool, (tx) => createHold(tx, holdInput(t, sessionId, 2)));
    await withTransaction(db.pool, (tx) => releaseHold(tx, scope(t), hold.id));
    const tx = await db.pool.connect();
    try {
      await tx.query("BEGIN");
      expect(await errorCode(tx, `UPDATE public.ticketing_holds SET status = 'active' WHERE id = $1`, [hold.id])).toBe("23514");
      expect(await errorCode(tx, `UPDATE public.ticketing_holds SET quantity = 1 WHERE id = $1`, [hold.id])).toBe("23514");
      expect(await errorCode(tx, `DELETE FROM public.ticketing_holds WHERE id = $1`, [hold.id])).toBe("23514");
    } finally {
      await tx.query("ROLLBACK");
      tx.release();
    }
    const mismatch = { ...holdInput(t, sessionId, 3), items: [{ ticketTypeId: typeId(t, "GENERAL"), quantity: 2, unitPriceCents: 2995 }] };
    await expect(withTransaction(db.pool, (tx2) => createHold(tx2, mismatch))).rejects.toThrow(/hold_quantity_mismatch/);
    expect(await session(sessionId)).toMatchObject({ reserved_count: 0 });
  });
});

describe("tenant integrity", () => {
  it("rejects a child row pointing at another Client's parent", async () => {
    const h = seed.havana;
    const f = seed.festi;
    const activeHold = await withTransaction(db.pool, async (t) => createHold(t, holdInput(h, await newSession(h, 5), 1)));
    const tx = await db.pool.connect();
    try {
      await tx.query("BEGIN");
      // FESTI-ICE event at a Havana venue
      expect(
        await errorCode(tx, `INSERT INTO public.ticketing_events (client_id, brand_id, venue_id, slug, title) VALUES ($1, $2, $3, 'x', 'x')`, [
          f.clientId, f.brandId, h.venueId,
        ]),
      ).toBe("23503");
      // FESTI-ICE session on a Havana event
      expect(
        await errorCode(tx, `INSERT INTO public.ticketing_sessions (client_id, brand_id, event_id, starts_at, capacity) VALUES ($1, $2, $3, now(), 1)`, [
          f.clientId, f.brandId, h.eventId,
        ]),
      ).toBe("23503");
      // Brand claimed by the wrong Client
      expect(
        await errorCode(tx, `INSERT INTO public.ticketing_venues (client_id, brand_id, name) VALUES ($1, $2, 'x')`, [h.clientId, f.brandId]),
      ).toBe("23503");
      // Hold item with another Client's ticket type
      expect(
        await errorCode(
          tx,
          `INSERT INTO public.ticketing_hold_items (hold_id, client_id, brand_id, event_id, ticket_type_id, quantity, unit_price_cents)
           VALUES ($1, $2, $3, $4, $5, 1, 0)`,
          [activeHold.id, h.clientId, h.brandId, h.eventId, typeId(f, "GENERAL")],
        ),
      ).toBe("23503");
      // Ticket on another Client's order
      expect(
        await errorCode(
          tx,
          `INSERT INTO public.ticketing_tickets (client_id, brand_id, event_id, session_id, order_id, order_line_id, ticket_type_id)
           SELECT $1, $2, $3, $4, l.order_id, l.id, l.ticket_type_id FROM public.ticketing_order_lines l WHERE l.order_id = $5 LIMIT 1`,
          [h.clientId, h.brandId, h.eventId, h.sessionId, f.orderId],
        ),
      ).toMatch(/^235(03|14)$/); // composite FK, or the issuance trigger that runs first
      // A brand never moves to another Client
      expect(await errorCode(tx, `UPDATE public.ticketing_brands SET client_id = $1 WHERE id = $2`, [h.clientId, f.brandId])).toBe("23514");
    } finally {
      await tx.query("ROLLBACK");
      tx.release();
    }
  });

  it("carries client_id and brand_id in every foreign key between business-scoped tables", async () => {
    const { rows } = await db.pool.query<{ conname: string; source: string; cols: string[]; target_has_brand: boolean }>(
      `SELECT con.conname, s.relname AS source,
              ARRAY(SELECT a.attname::text FROM unnest(con.conkey) k JOIN pg_attribute a
                    ON a.attrelid = con.conrelid AND a.attnum = k) AS cols,
              EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = con.confrelid AND a.attname = 'brand_id') AS target_has_brand
       FROM pg_constraint con
       JOIN pg_class s ON s.oid = con.conrelid JOIN pg_namespace n ON n.oid = s.relnamespace
       WHERE con.contype = 'f' AND n.nspname = 'public'`,
    );
    const scoped = rows.filter((r) => r.target_has_brand && r.source !== "ticketing_audit_log");
    expect(scoped.length).toBeGreaterThan(10);
    for (const r of scoped) {
      expect(r.cols, r.conname).toEqual(expect.arrayContaining(["client_id", "brand_id"]));
    }
  });

  it("requires client_id and brand_id on every business-scoped table", async () => {
    const clientLevel = new Set(["ticketing_clients", "ticketing_brands", "ticketing_memberships", "ticketing_control_events", "ticketing_audit_log"]);
    const { rows } = await db.pool.query<{ table_name: string; column_name: string; is_nullable: string }>(
      `SELECT table_name, column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name IN ('client_id', 'brand_id')`,
    );
    const { rows: tables } = await db.pool.query<{ relname: string }>(
      `SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE nspname = 'public' AND relkind = 'r'`,
    );
    for (const { relname } of tables) {
      if (clientLevel.has(relname)) continue;
      for (const col of ["client_id", "brand_id"]) {
        const c = rows.find((r) => r.table_name === relname && r.column_name === col);
        expect(c, `${relname}.${col}`).toBeDefined();
        expect(c!.is_nullable, `${relname}.${col}`).toBe("NO");
      }
    }
  });

  it("references TAKATAK master ids without any foreign key outside ALKAO", async () => {
    const { rows } = await db.pool.query<{ conname: string; target: string }>(
      `SELECT con.conname, tn.nspname || '.' || t.relname AS target
       FROM pg_constraint con
       JOIN pg_class s ON s.oid = con.conrelid JOIN pg_namespace sn ON sn.oid = s.relnamespace
       JOIN pg_class t ON t.oid = con.confrelid JOIN pg_namespace tn ON tn.oid = t.relnamespace
       WHERE con.contype = 'f' AND sn.nspname = 'public'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.target, r.conname).toMatch(/^public\.ticketing_/);
  });

  it("keeps buyers separate per Client even with the same email", async () => {
    const email = `same-${randomUUID().slice(0, 6)}@example.com`;
    await seedPaidOrder(db.pool, seed.havana, email);
    await seedPaidOrder(db.pool, seed.festi, email.toUpperCase());
    await seedPaidOrder(db.pool, seed.festi, email);
    const { rows } = await db.pool.query(`SELECT client_id FROM public.ticketing_buyers WHERE email_normalized = $1`, [email]);
    expect(rows).toHaveLength(2);
  });
});

describe("orders and tickets", () => {
  async function pendingOrder(t: TenantFixture, quantity = 2) {
    const sessionId = await newSession(t, 20);
    const quote = generalQuote(t, quantity);
    return withTransaction(db.pool, async (tx) => {
      const hold = await createHold(tx, holdInput(t, sessionId, quantity));
      return createOrderFromHold(tx, { ...scope(t), holdId: hold.id, buyer: { email: "p@example.com" }, quote, commissionCents: 100 });
    });
  }

  async function probe(fn: (tx: import("pg").PoolClient) => Promise<void>) {
    const tx = await db.pool.connect();
    try {
      await tx.query("BEGIN");
      await fn(tx);
    } finally {
      await tx.query("ROLLBACK");
      tx.release();
    }
  }

  it("keeps order money immutable and transitions forward only", async () => {
    const t = seed.havana;
    await probe(async (tx) => {
      expect(await errorCode(tx, `UPDATE public.ticketing_orders SET total_cents = 1, subtotal_cents = 1, tax_cents = 0 WHERE id = $1`, [t.orderId])).toBe("23514");
      expect(await errorCode(tx, `UPDATE public.ticketing_orders SET commission_cents = 0 WHERE id = $1`, [t.orderId])).toBe("23514");
      expect(await errorCode(tx, `UPDATE public.ticketing_orders SET status = 'pending_payment', paid_at = NULL WHERE id = $1`, [t.orderId])).toBe("23514");
      expect(await errorCode(tx, `UPDATE public.ticketing_orders SET status = 'cancelled' WHERE id = $1`, [t.orderId])).toBe("23514");
      expect(await errorCode(tx, `DELETE FROM public.ticketing_orders WHERE id = $1`, [t.orderId])).toBe("23514");
      expect(await errorCode(tx, `DELETE FROM public.ticketing_order_lines WHERE order_id = $1`, [t.orderId])).toBe("23514");
      expect(await errorCode(tx, `UPDATE public.ticketing_order_taxes SET amount_cents = 0 WHERE order_id = $1`, [t.orderId])).toBe("23514");
    });
  });

  it("bounds refunds by the total and commission refunds by the commission, monotonically", async () => {
    const t = seed.havana;
    const { rows } = await db.pool.query<{ total_cents: number; commission_cents: number }>(
      `SELECT total_cents, commission_cents FROM public.ticketing_orders WHERE id = $1`,
      [t.orderId],
    );
    const { total_cents: total, commission_cents: commission } = rows[0]!;
    await probe(async (tx) => {
      const set = (status: string, refunded: number, commissionRefunded: number) =>
        errorCode(tx, `UPDATE public.ticketing_orders SET status = $2, refunded_cents = $3, commission_refunded_cents = $4 WHERE id = $1`, [
          t.orderId, status, refunded, commissionRefunded,
        ]);
      expect(await set("partially_refunded", total + 1, 0)).toBe("23514");
      expect(await set("partially_refunded", 100, commission + 1)).toBe("23514");
      expect(await set("refunded", total - 1, commission)).toBe("23514"); // refunded means everything
      expect(await set("refunded", total, commission - 1)).toBe("23514"); // ... including the commission
      expect(await set("paid", 100, 0)).toBe("23514"); // a refund changes the status
      expect(await set("partially_refunded", 500, 30)).toBeNull();
      expect(await set("partially_refunded", 400, 30)).toBe("23514"); // never decreases
      expect(await set("refunded", total, commission)).toBeNull();
      expect(await set("partially_refunded", total, commission)).toBe("23514"); // refunded is final
    });
  });

  it("issues tickets only for paid orders and never beyond the quantity", async () => {
    const t = seed.festi;
    const order = await pendingOrder(t, 2);
    await probe(async (tx) => {
      expect(
        await errorCode(
          tx,
          `INSERT INTO public.ticketing_tickets (client_id, brand_id, event_id, session_id, order_id, order_line_id, ticket_type_id)
           SELECT o.client_id, o.brand_id, o.event_id, o.session_id, o.id, l.id, l.ticket_type_id
           FROM public.ticketing_orders o JOIN public.ticketing_order_lines l ON l.order_id = o.id WHERE o.id = $1`,
          [order.id],
        ),
      ).toBe("23514");
    });
    const ids = await withTransaction(db.pool, (tx) => recordOrderPaid(tx, scope(t), order.id, new Date()));
    expect(ids).toHaveLength(2);
    await probe(async (tx) => {
      expect(
        await errorCode(
          tx,
          `INSERT INTO public.ticketing_tickets (client_id, brand_id, event_id, session_id, order_id, order_line_id, ticket_type_id)
           SELECT o.client_id, o.brand_id, o.event_id, o.session_id, o.id, l.id, l.ticket_type_id
           FROM public.ticketing_orders o JOIN public.ticketing_order_lines l ON l.order_id = o.id WHERE o.id = $1`,
          [order.id],
        ),
      ).toBe("23514");
      // Lines cannot be added once paid.
      expect(
        await errorCode(
          tx,
          `INSERT INTO public.ticketing_order_lines (order_id, client_id, brand_id, event_id, ticket_type_id, kind, code_snapshot, name_snapshot, quantity, unit_price_cents, line_total_cents)
           VALUES ($1, $2, $3, $4, $5, 'admission', 'CHILD', 'x', 1, 0, 0)`,
          [order.id, t.clientId, t.brandId, t.eventId, typeId(t, "CHILD")],
        ),
      ).toBe("23514");
    });
    await expect(withTransaction(db.pool, (tx) => recordOrderPaid(tx, scope(t), order.id, new Date()))).rejects.toMatchObject({
      code: "order_not_pending",
    });
  });

  it("makes a void ticket final and tickets undeletable", async () => {
    const t = seed.havana;
    const [id] = t.ticketIds;
    await db.pool.query(`UPDATE public.ticketing_tickets SET status = 'void', void_reason = 'admin', voided_at = now() WHERE id = $1`, [id]);
    await probe(async (tx) => {
      expect(await errorCode(tx, `UPDATE public.ticketing_tickets SET status = 'valid', void_reason = NULL, voided_at = NULL WHERE id = $1`, [id])).toBe("23514");
      expect(await errorCode(tx, `UPDATE public.ticketing_tickets SET order_id = $2 WHERE id = $1`, [id, seed.festi.orderId])).toBe("23514");
      expect(await errorCode(tx, `DELETE FROM public.ticketing_tickets WHERE id = $1`, [id])).toBe("23514");
    });
  });

  it("checks order money against its lines and taxes at commit", async () => {
    const t = seed.havana;
    const sessionId = await newSession(t, 5);
    const quote = generalQuote(t, 1);
    const wrong = { ...quote, totalCents: quote.totalCents + 1, taxCents: quote.taxCents + 1 };
    await expect(
      withTransaction(db.pool, async (tx) => {
        const hold = await createHold(tx, holdInput(t, sessionId, 1));
        await createOrderFromHold(tx, { ...scope(t), holdId: hold.id, buyer: { email: "w@example.com" }, quote: wrong, commissionCents: 0 });
      }),
    ).rejects.toThrow(/order_tax_mismatch/);
    expect(await session(sessionId)).toMatchObject({ reserved_count: 0 });
  });

  it("refuses an order from an expired or foreign hold", async () => {
    const t = seed.havana;
    const sessionId = await newSession(t, 5);
    const quote = generalQuote(t, 1);
    const hold = await withTransaction(db.pool, (tx) => createHold(tx, holdInput(t, sessionId, 1, 1_000)));
    await expect(
      withTransaction(db.pool, (tx) =>
        createOrderFromHold(tx, { ...scope(seed.festi), holdId: hold.id, buyer: { email: "x@example.com" }, quote, commissionCents: 0 }),
      ),
    ).rejects.toMatchObject({ code: "hold_not_found" });
    await expect(
      withTransaction(db.pool, (tx) =>
        createOrderFromHold(
          tx,
          { ...scope(t), holdId: hold.id, buyer: { email: "x@example.com" }, quote, commissionCents: 0 },
          new Date(Date.now() + 5_000),
        ),
      ),
    ).rejects.toMatchObject({ code: "hold_not_active" });
  });

  it("keeps the audit log append-only", async () => {
    await probe(async (tx) => {
      expect(await errorCode(tx, `UPDATE public.ticketing_audit_log SET action = 'x.y'`)).toBe("23514");
      expect(await errorCode(tx, `DELETE FROM public.ticketing_audit_log`)).toBe("23514");
    });
  });
});
