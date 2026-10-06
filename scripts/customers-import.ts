import { readFileSync } from "node:fs";
import { parseReservationsReport } from "../ops-ui/reservations-csv.js";
import { completeImport, importRows } from "../src/db/customers.js";
import { createPool, withTransaction } from "../src/db/pool.js";
import { isUuid } from "../src/domain/ids.js";

// Run 41: load Réservation camping.ca reports into the customer file, oldest first — the
// first load of a Client's history, or a catch-up. Prints totals only, never a customer.
//
// Usage: npm run customers:import -- --client <uuid> --brand <uuid> <report.csv>@<YYYY-MM-DD> [...] [--incomplete]
//   Each file comes with the day the report was produced. --incomplete: the reports do not
//   list every upcoming booking, so none is taken for cancelled.
// Env: DATABASE_URL.
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const clientId = flag("--client");
const brandId = flag("--brand");
const incomplete = args.includes("--incomplete");
const reports = args
  .filter((a, i) => !a.startsWith("--") && !["--client", "--brand"].includes(args[i - 1] ?? ""))
  .map((a) => {
    const m = /^(.+)@(\d{4}-\d{2}-\d{2})$/.exec(a);
    if (!m) throw new Error(`"${a}": expected <file>@<YYYY-MM-DD>`);
    return { file: m[1]!, reportDate: m[2]! };
  })
  .sort((a, b) => a.reportDate.localeCompare(b.reportDate));
if (!isUuid(clientId) || !isUuid(brandId) || reports.length === 0) {
  console.error("usage: npm run customers:import -- --client <uuid> --brand <uuid> <report.csv>@<YYYY-MM-DD> [...] [--incomplete]");
  process.exit(2);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(2);
}

const db = createPool(url, 2);
const scope = { clientId, brandId };
const actor = { type: "system" as const, id: null };
const BATCH = 400;
const totals = { rows: 0, customersCreated: 0, bookingsCreated: 0, bookingsUpdated: 0, cancelled: 0, cardNumbersRemoved: 0, unreadable: 0 };
try {
  for (const { file, reportDate } of reports) {
    const parsed = parseReservationsReport(readFileSync(file));
    totals.unreadable += parsed.unreadable;
    for (let i = 0; i < parsed.rows.length; i += BATCH) {
      const r = await withTransaction(db, (tx) => importRows(tx, scope, { source: "reservation_camping", reportDate, rows: parsed.rows.slice(i, i + BATCH) }, actor));
      totals.rows += r.rows;
      totals.customersCreated += r.customersCreated;
      totals.bookingsCreated += r.bookingsCreated;
      totals.bookingsUpdated += r.bookingsUpdated;
      totals.cardNumbersRemoved += r.cardNumbersRemoved;
    }
    if (!incomplete && parsed.rows.length > 0) {
      totals.cancelled += (await withTransaction(db, (tx) => completeImport(tx, scope, { source: "reservation_camping", reportDate }, actor))).cancelled;
    }
    console.log(`${reportDate}: ${parsed.rows.length} row(s)${parsed.unreadable ? `, ${parsed.unreadable} unreadable` : ""}`);
  }
  console.log(JSON.stringify(totals));
} finally {
  await db.end();
}
