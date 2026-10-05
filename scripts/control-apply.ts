import { readFileSync } from "node:fs";
import { applyProvisioning, buildProvisioningEvents, ProvisioningPlan } from "../src/control/provision.js";

// Usage: npm run control:apply -- plan.json [--dry-run]
// Env: ALKAO_URL, ALKAO_CONTROL_KEY_ID, ALKAO_CONTROL_SECRET (one of ALKAO's ALKAO_CONTROL_KEYS).
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const dryRun = args.includes("--dry-run");
if (!file) {
  console.error("usage: npm run control:apply -- <plan.json> [--dry-run]");
  process.exit(2);
}

const plan = ProvisioningPlan.parse(JSON.parse(readFileSync(file, "utf8")));
const events = buildProvisioningEvents(plan, Date.now());

if (dryRun) {
  for (const e of events) console.log(`${e.label}\n  ${e.body}`);
  console.log(`\n${events.length} event(s), dry run: nothing sent.`);
  process.exit(0);
}

const url = process.env.ALKAO_URL;
const keyId = process.env.ALKAO_CONTROL_KEY_ID;
const secret = process.env.ALKAO_CONTROL_SECRET;
if (!url || !keyId || !secret) {
  console.error("ALKAO_URL, ALKAO_CONTROL_KEY_ID and ALKAO_CONTROL_SECRET are required (or use --dry-run).");
  process.exit(2);
}
if (!/^https:\/\//.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(url)) {
  console.error("ALKAO_URL must be HTTPS (http is allowed for localhost only).");
  process.exit(2);
}

const { ok, results } = await applyProvisioning({ url, keyId, secret }, events);
for (const r of results) console.log(`${r.status === 200 ? "OK  " : "FAIL"} ${r.label}: ${r.outcome}`);
console.log(ok ? `\n${results.length} event(s) applied.` : "\nStopped at the first refusal; nothing after it was sent.");
process.exit(ok ? 0 : 1);
