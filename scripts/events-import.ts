import { readFileSync } from "node:fs";
import { createPool, withTransaction } from "../src/db/pool.js";
import { isUuid } from "../src/domain/ids.js";
import { EventFile, importEvent } from "../src/ops/events-import.js";

// Run 91: put one Brand's event on ALKAO from a file (venue, event, dates, ticket types), in
// one transaction. Safe to run again; past dates are skipped. Prints what it did, nothing else.
//
// Usage: npm run events:import -- --client <uuid> --brand <uuid> <event.json> [--capacity <n>] [--publish] [--list-on-alkao] [--update-page] [--dry-run]
//   --capacity       seats per date, for every date the file leaves without one
//   --publish        put the new dates on sale and publish the event
//   --list-on-alkao  the Brand's consent to list its events on alkao.ca ("Afficher mes événements sur ALKAO")
//   --update-page    on an event already there, take its page from the file (texts, photo, sections,
//                    what each ticket includes); never its dates, prices or status (Run 94)
//   --dry-run        do everything, then roll back
// Env: DATABASE_URL.
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const valued = new Set(["--client", "--brand", "--capacity"]);
const clientId = flag("--client");
const brandId = flag("--brand");
const capacityArg = flag("--capacity");
const file = args.find((a, i) => !a.startsWith("--") && !valued.has(args[i - 1] ?? ""));
const capacity = capacityArg === undefined ? null : Number(capacityArg);
if (!isUuid(clientId) || !isUuid(brandId) || !file || (capacity !== null && (!Number.isInteger(capacity) || capacity < 0))) {
  console.error("usage: npm run events:import -- --client <uuid> --brand <uuid> <event.json> [--capacity <n>] [--publish] [--list-on-alkao] [--update-page] [--dry-run]");
  process.exit(2);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(2);
}

const plan = EventFile.parse(JSON.parse(readFileSync(file, "utf8")));
const dryRun = args.includes("--dry-run");
const db = createPool(url, 2);
const ROLLBACK = new Error("dry run");
try {
  let result: Awaited<ReturnType<typeof importEvent>> | null = null;
  try {
    await withTransaction(db, async (tx) => {
      result = await importEvent(tx, { clientId, brandId }, plan, {
        capacity, publish: args.includes("--publish"), listOnAlkao: args.includes("--list-on-alkao"), updatePage: args.includes("--update-page"), now: new Date(),
      });
      if (dryRun) throw ROLLBACK;
    });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
  console.log(JSON.stringify(result, null, 2));
  if (dryRun) console.log("Dry run: nothing was saved.");
} finally {
  await db.end();
}
