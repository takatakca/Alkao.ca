import { listMigrations } from "../src/db/migrate.js";
import { checkMigrationSql } from "./migration-rules.js";

const problems = listMigrations().flatMap((m) => checkMigrationSql(m.name, m.sql));
if (problems.length > 0) {
  for (const p of problems) console.error(`✗ ${p}`);
  process.exit(1);
}
console.log(`✓ ${listMigrations().length} migrations: every ticketing table enables RLS in its own migration`);
