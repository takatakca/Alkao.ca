import { parseArgs } from "node:util";
import { createPool } from "../src/db/pool.js";
import { checkDatabase, checkEnvironment, checkLive, type Check } from "../src/ops/golive.js";

// Run 38: the go-live check. Reads only; never writes to the database or to Stripe.
//   npm run check:golive                                   settings and database, where ALKAO runs
//   npm run check:golive -- --url https://billets.example.ca [--client <uuid> --brand <uuid>]
// With --url and no DATABASE_URL here, only the running service is checked (from any computer).
const { values } = parseArgs({
  options: { url: { type: "string" }, client: { type: "string" }, brand: { type: "string" } },
});

const sections: [title: string, checks: Check[]][] = [];
const remoteOnly = Boolean(values.url) && !process.env.DATABASE_URL;
if (!remoteOnly) {
  sections.push(["Réglages de ce serveur", checkEnvironment(process.env)]);
  if (process.env.DATABASE_URL) {
    const db = createPool(process.env.DATABASE_URL, 1);
    try {
      sections.push(["Base de données", await checkDatabase(db)]);
    } catch (error) {
      sections.push(["Base de données", [{ area: "Base de données", status: "fail", message: `Vérification interrompue : ${(error as Error).message}` }]]);
    } finally {
      await db.end().catch(() => undefined);
    }
  }
}
if (values.url) sections.push([`Service en ligne : ${values.url}`, await checkLive(values.url, { clientId: values.client, brandId: values.brand })]);

const MARK = { ok: "✔", warn: "⚠", fail: "✘" } as const;
console.log("ALKAO : vérification avant mise en ligne\n");
for (const [title, checks] of sections) {
  console.log(title);
  for (const c of checks) {
    console.log(`  ${MARK[c.status]} ${c.area} : ${c.message}`);
    if (c.fix && c.status !== "ok") console.log(`      → ${c.fix}`);
  }
  console.log("");
}
const all = sections.flatMap(([, checks]) => checks);
const failures = all.filter((c) => c.status === "fail").length;
const warnings = all.filter((c) => c.status === "warn").length;
console.log(failures
  ? `Résultat : ${failures} problème(s) à régler avant la mise en ligne, ${warnings} avertissement(s).`
  : `Résultat : rien de bloquant, ${warnings} avertissement(s).`);
process.exitCode = failures ? 1 : 0;
