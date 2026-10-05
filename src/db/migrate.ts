import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "supabase", "migrations");

export interface Migration {
  name: string;
  sql: string;
}

export function listMigrations(dir = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((f) => /^\d{14}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") }));
}

/**
 * Apply pending migrations, each in its own transaction, recorded in
 * alkao_meta.schema_migrations. For Supabase projects use the Supabase CLI instead; this
 * runner serves standalone deployments and ephemeral test databases.
 */
export async function applyMigrations(client: pg.ClientBase, dir = MIGRATIONS_DIR): Promise<string[]> {
  await client.query(`
    CREATE SCHEMA IF NOT EXISTS alkao_meta;
    REVOKE ALL ON SCHEMA alkao_meta FROM PUBLIC;
    CREATE TABLE IF NOT EXISTS alkao_meta.schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE alkao_meta.schema_migrations ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON TABLE alkao_meta.schema_migrations FROM PUBLIC;
  `);
  const done = new Set(
    (await client.query<{ name: string }>("SELECT name FROM alkao_meta.schema_migrations")).rows.map((r) => r.name),
  );
  const applied: string[] = [];
  for (const m of listMigrations(dir)) {
    if (done.has(m.name)) continue;
    await client.query("BEGIN");
    try {
      await client.query(m.sql);
      await client.query("INSERT INTO alkao_meta.schema_migrations (name) VALUES ($1)", [m.name]);
      await client.query("COMMIT");
      applied.push(m.name);
    } catch (error) {
      await client.query("ROLLBACK");
      throw new Error(`migration ${m.name} failed: ${(error as Error).message}`, { cause: error });
    }
  }
  return applied;
}
