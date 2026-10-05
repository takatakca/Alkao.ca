import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { applyMigrations } from "../../src/db/migrate.js";
import { createPool, type Db, type Tx } from "../../src/db/pool.js";

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:54329/postgres";
const SHIM = readFileSync(join(import.meta.dirname, "..", "..", "supabase", "tests", "supabase_shim.sql"), "utf8");

/**
 * Tests run on local, ephemeral PostgreSQL only — never staging or production. Any
 * non-loopback host is refused, whatever TEST_DATABASE_URL says.
 */
export function assertLocalDatabaseUrl(url: string): void {
  const host = new URL(url).hostname;
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
    throw new Error(`Refusing non-local test database host "${host}". ALKAO tests use local ephemeral PostgreSQL only.`);
  }
}

export interface TestDatabase {
  name: string;
  url: string;
  pool: Db;
  drop(): Promise<void>;
}

/** Create a throwaway database with the Supabase shim and every ALKAO migration applied. */
export async function createTestDatabase(): Promise<TestDatabase> {
  assertLocalDatabaseUrl(ADMIN_URL);
  const name = `alkao_test_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }

  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const setup = new pg.Client({ connectionString: url.toString() });
  await setup.connect();
  try {
    await setup.query(SHIM);
    await applyMigrations(setup);
  } finally {
    await setup.end();
  }

  const pool = createPool(url.toString(), 20);
  return {
    name,
    url: url.toString(),
    pool,
    async drop() {
      // pool.end() resolves before its sockets close; wait for the backends to go away
      // instead of killing them (a killed, closing client raises an unhandled error).
      await pool.end();
      const a = new pg.Client({ connectionString: ADMIN_URL });
      await a.connect();
      try {
        for (let attempt = 0; ; attempt++) {
          try {
            await a.query(attempt < 50 ? `DROP DATABASE IF EXISTS ${name}` : `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
            break;
          } catch (error) {
            if ((error as { code?: string }).code !== "55006" || attempt >= 50) throw error;
            await new Promise((r) => setTimeout(r, 20));
          }
        }
      } finally {
        await a.end();
      }
    },
  };
}

/**
 * Run `fn` as a Data API caller: SET LOCAL ROLE anon/authenticated with the PostgREST JWT
 * claims GUC, inside a transaction that is always rolled back.
 */
export async function asRole<T>(
  db: Db,
  role: "anon" | "authenticated",
  userId: string | null,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const tx = await db.connect();
  try {
    await tx.query("BEGIN");
    await tx.query(`SET LOCAL ROLE ${role}`);
    const claims = userId ? { sub: userId, role } : { role };
    await tx.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    return await fn(tx);
  } finally {
    await tx.query("ROLLBACK").catch(() => undefined);
    tx.release();
  }
}

/** Run a statement in a savepoint and return the PostgreSQL error code, or null on success. */
export async function errorCode(tx: Tx, sql: string, params: unknown[] = []): Promise<string | null> {
  await tx.query("SAVEPOINT probe");
  try {
    await tx.query(sql, params);
    await tx.query("RELEASE SAVEPOINT probe");
    return null;
  } catch (error) {
    await tx.query("ROLLBACK TO SAVEPOINT probe");
    return (error as { code?: string }).code ?? "unknown";
  }
}
