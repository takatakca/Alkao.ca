import pg from "pg";
import { applyMigrations } from "../src/db/migrate.js";

// Apply pending ALKAO migrations to DATABASE_URL (standalone PostgreSQL). On Supabase, use
// the Supabase CLI instead. On plain PostgreSQL, run supabase/tests/supabase_shim.sql once
// first: migrations use the Supabase roles (anon, authenticated, service_role) and auth.uid().
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const applied = await applyMigrations(client);
  console.log(applied.length ? `applied: ${applied.join(", ")}` : "up to date");
} finally {
  await client.end();
}
