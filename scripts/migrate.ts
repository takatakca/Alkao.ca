import pg from "pg";
import { migrateDatabase } from "../src/db/migrate.js";

// Apply pending ALKAO migrations to DATABASE_URL (a dedicated Supabase project or plain
// PostgreSQL). On plain PostgreSQL it first creates what the migrations use from Supabase
// (supabase/bootstrap/plain_postgres.sql: the roles and auth.uid()); on Supabase that step does nothing.
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const applied = await migrateDatabase(client);
  console.log(applied.length ? `applied: ${applied.join(", ")}` : "up to date");
} finally {
  await client.end();
}
