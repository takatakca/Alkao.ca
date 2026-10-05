import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asRole, createTestDatabase, errorCode, type TestDatabase } from "../helpers/db.js";
import { seedTwoTenants, type SeedResult } from "../helpers/seed.js";

/**
 * Proves the frozen rule: no anonymous access to any private row, and a Client's members
 * never read another Client's Ticketing data — through PostgREST-equivalent roles.
 */

type Visibility = "all_members" | "managers" | "admins" | "own_or_admins" | "none";

/** Every ticketing_* table must be listed here; the coverage test fails otherwise. */
const EXPECTED: Record<string, Visibility> = {
  ticketing_clients: "all_members",
  ticketing_brands: "all_members",
  ticketing_memberships: "own_or_admins",
  ticketing_entitlements: "all_members",
  ticketing_control_events: "none",
  ticketing_audit_log: "admins",
  ticketing_venues: "all_members",
  ticketing_events: "all_members",
  ticketing_sessions: "all_members",
  ticketing_ticket_types: "all_members",
  ticketing_holds: "all_members",
  ticketing_hold_items: "all_members",
  ticketing_buyers: "managers",
  ticketing_orders: "managers",
  ticketing_order_lines: "managers",
  ticketing_order_taxes: "managers",
  ticketing_tickets: "all_members",
  ticketing_access_tokens: "none",
  // Run 02
  ticketing_payment_accounts: "admins",
  ticketing_brand_settings: "all_members",
  ticketing_payments: "managers",
  ticketing_refunds: "managers",
  ticketing_payment_events: "none",
  // Run 03
  ticketing_credential_keys: "all_members",
  ticketing_credentials: "all_members",
  ticketing_scans: "all_members",
  // Run 06
  ticketing_email_outbox: "none",
  // Run 10
  ticketing_session_cancellations: "none",
  ticketing_session_cancellation_orders: "none",
  // Run 19
  ticketing_payment_disputes: "none",
  ticketing_charge_refund_totals: "none",
  // Run 20
  ticketing_buyer_erasures: "none",
};

const clientColumn = (table: string) => (table === "ticketing_clients" ? "id" : "client_id");

let db: TestDatabase;
let seed: SeedResult;
let tables: string[];

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  tables = (
    await db.pool.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY 1`,
    )
  ).rows.map((r) => r.relname);
});

afterAll(async () => {
  await db?.drop();
});

/** Rows of `table` visible to the caller, grouped by client id; null if access is denied. */
async function visibleByClient(role: "anon" | "authenticated", userId: string | null, table: string) {
  return asRole(db.pool, role, userId, async (tx) => {
    const code = await errorCode(tx, `SELECT 1 FROM public.${table} LIMIT 1`);
    if (code === "42501") return null;
    if (code) throw new Error(`unexpected error ${code} reading ${table}`);
    if (table === "ticketing_control_events") {
      const { rows } = await tx.query(`SELECT count(*)::int AS n FROM public.${table}`);
      return { total: rows[0].n as number, havana: 0, festi: 0, other: 0 };
    }
    const { rows } = await tx.query<{ c: string; n: number }>(
      `SELECT ${clientColumn(table)}::text AS c, count(*)::int AS n FROM public.${table} GROUP BY 1`,
    );
    const by = new Map(rows.map((r) => [r.c, r.n]));
    const havana = by.get(seed.havana.clientId) ?? 0;
    const festi = by.get(seed.festi.clientId) ?? 0;
    const total = rows.reduce((n, r) => n + r.n, 0);
    return { total, havana, festi, other: total - havana - festi };
  });
}

describe("RLS coverage (catalog checks)", () => {
  it("lists an expectation for every ticketing table, and nothing else lives in public", () => {
    expect(tables.filter((t) => !t.startsWith("ticketing_"))).toEqual([]);
    expect([...tables].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it("enables RLS on every public table", async () => {
    const { rows } = await db.pool.query(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity`,
    );
    expect(rows).toEqual([]);
  });

  it("has SELECT-only policies, none for anon or PUBLIC", async () => {
    const { rows } = await db.pool.query<{ tablename: string; cmd: string; roles: string[] }>(
      `SELECT tablename, cmd, roles::text[] AS roles FROM pg_policies WHERE schemaname = 'public'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const p of rows) {
      expect(p.cmd, p.tablename).toBe("SELECT");
      expect(p.roles, p.tablename).toEqual(["authenticated"]);
    }
  });

  it("grants anon nothing and authenticated SELECT only", async () => {
    const { rows } = await db.pool.query<{ grantee: string; table_name: string; privilege_type: string }>(
      `SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated', 'PUBLIC')`,
    );
    expect(rows.filter((r) => r.grantee !== "authenticated")).toEqual([]);
    expect(rows.filter((r) => r.privilege_type !== "SELECT")).toEqual([]);
    const readable = new Set(rows.map((r) => r.table_name));
    for (const [table, vis] of Object.entries(EXPECTED)) {
      expect(readable.has(table), table).toBe(vis !== "none");
    }
  });

  it("keeps RLS helpers out of anon's reach", async () => {
    const { rows } = await db.pool.query<{ anon: boolean; auth: boolean }>(
      `SELECT has_function_privilege('anon', 'alkao_private.is_client_member(uuid)', 'EXECUTE') AS anon,
              has_schema_privilege('anon', 'alkao_private', 'USAGE') AS auth`,
    );
    expect(rows[0]).toEqual({ anon: false, auth: false });
  });
});

describe("anonymous access", () => {
  it("reads zero private rows from every ticketing table", async () => {
    for (const table of tables) {
      const seen = await visibleByClient("anon", null, table);
      expect(seen, table).toBeNull(); // permission denied: not a single row
    }
  });

  it("cannot write anywhere", async () => {
    await asRole(db.pool, "anon", null, async (tx) => {
      expect(await errorCode(tx, `INSERT INTO public.ticketing_clients (id, name) VALUES (gen_random_uuid(), 'x')`)).toBe("42501");
      expect(await errorCode(tx, `UPDATE public.ticketing_sessions SET capacity = 0`)).toBe("42501");
      expect(await errorCode(tx, `DELETE FROM public.ticketing_orders`)).toBe("42501");
    });
  });
});

describe("cross-Client isolation", () => {
  it("a signed-in user without membership sees nothing", async () => {
    for (const table of tables) {
      const seen = await visibleByClient("authenticated", seed.users.stranger, table);
      if (seen) expect(seen.total, table).toBe(0);
    }
  });

  it("a suspended membership sees nothing", async () => {
    for (const table of tables) {
      const seen = await visibleByClient("authenticated", seed.users.suspended, table);
      if (seen) expect(seen.total, table).toBe(0);
    }
  });

  for (const [who, mine, theirs] of [
    ["havanaOwner", "havana", "festi"],
    ["festiOwner", "festi", "havana"],
  ] as const) {
    it(`${who} reads only its own Client's rows, in every table`, async () => {
      for (const table of tables) {
        const seen = await visibleByClient("authenticated", seed.users[who], table);
        if (EXPECTED[table] === "none") {
          expect(seen, table).toBeNull();
          continue;
        }
        expect(seen, table).not.toBeNull();
        expect(seen![theirs], `${table}: other Client rows`).toBe(0);
        expect(seen!.other, `${table}: unknown rows`).toBe(0);
        expect(seen![mine], `${table}: own rows`).toBeGreaterThan(0);
      }
    });
  }

  it("two memberships, two roles: manager at FESTI-ICE, viewer at Havana", async () => {
    for (const table of tables) {
      const seen = await visibleByClient("authenticated", seed.users.both, table);
      const vis = EXPECTED[table];
      if (vis === "none") {
        expect(seen, table).toBeNull();
        continue;
      }
      expect(seen!.other, table).toBe(0);
      if (vis === "all_members") {
        expect(seen!.havana, table).toBeGreaterThan(0);
        expect(seen!.festi, table).toBeGreaterThan(0);
      } else if (vis === "managers") {
        expect(seen!.festi, table).toBeGreaterThan(0);
        expect(seen!.havana, `${table}: viewer must not read Havana buyers/orders`).toBe(0);
      } else if (vis === "admins") {
        expect(seen!.total, table).toBe(0);
      } else if (vis === "own_or_admins") {
        expect(seen!.havana, table).toBe(1);
        expect(seen!.festi, table).toBe(1);
      }
    }
  });

  it("staff read the catalog and tickets but no buyer data, order money or audit", async () => {
    for (const table of tables) {
      const seen = await visibleByClient("authenticated", seed.users.havanaStaff, table);
      const vis = EXPECTED[table];
      if (vis === "none") {
        expect(seen, table).toBeNull();
        continue;
      }
      expect(seen!.festi, table).toBe(0);
      if (vis === "all_members") expect(seen!.havana, table).toBeGreaterThan(0);
      if (vis === "managers" || vis === "admins") expect(seen!.total, table).toBe(0);
      if (vis === "own_or_admins") expect(seen!.total, table).toBe(1);
    }
  });

  it("owners see their Client's full membership list; others only their own row", async () => {
    const ownerView = await visibleByClient("authenticated", seed.users.havanaOwner, "ticketing_memberships");
    expect(ownerView!.havana).toBe(4); // owner, staff, both (viewer), suspended
    const staffView = await visibleByClient("authenticated", seed.users.havanaStaff, "ticketing_memberships");
    expect(staffView!.total).toBe(1);
  });

  it("a Client member cannot write, even to their own Client", async () => {
    await asRole(db.pool, "authenticated", seed.users.havanaOwner, async (tx) => {
      const { clientId, brandId, eventId, sessionId, orderId } = seed.havana;
      expect(await errorCode(tx, `UPDATE public.ticketing_sessions SET capacity = 99999 WHERE id = $1`, [sessionId])).toBe("42501");
      expect(await errorCode(tx, `UPDATE public.ticketing_orders SET refunded_cents = 1 WHERE id = $1`, [orderId])).toBe("42501");
      expect(await errorCode(tx, `DELETE FROM public.ticketing_tickets WHERE client_id = $1`, [clientId])).toBe("42501");
      expect(
        await errorCode(
          tx,
          `INSERT INTO public.ticketing_events (client_id, brand_id, venue_id, slug, title) VALUES ($1, $2, $3, 'x', 'x')`,
          [clientId, brandId, eventId],
        ),
      ).toBe("42501");
      expect(
        await errorCode(tx, `INSERT INTO public.ticketing_memberships (client_id, user_id, role) VALUES ($1, gen_random_uuid(), 'owner')`, [
          seed.festi.clientId,
        ]),
      ).toBe("42501");
    });
  });

  it("forged claims do not help: identity is auth.uid() only", async () => {
    await asRole(db.pool, "authenticated", seed.users.stranger, async (tx) => {
      await tx.query("SELECT set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({
          sub: seed.users.stranger,
          role: "authenticated",
          user_metadata: { client_id: seed.havana.clientId, role: "owner" },
          app_metadata: { client_id: seed.havana.clientId },
        }),
      ]);
      const { rows } = await tx.query(`SELECT count(*)::int AS n FROM public.ticketing_orders`);
      expect(rows[0].n).toBe(0);
    });
  });
});
