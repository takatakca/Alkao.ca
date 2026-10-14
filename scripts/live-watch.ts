import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { watchAddress } from "../src/ops/live-watch.js";

// Run 63: npx tsx scripts/live-watch.ts [--expect-build <commit>] https://alkao.ca [more addresses]
// Exits 1 when an address stopped answering. Writes the GitHub job summary when there is one.
const { values, positionals } = parseArgs({ options: { "expect-build": { type: "string" }, "require-build": { type: "boolean" } }, allowPositionals: true });
if (!positionals.length || positionals.some((o) => !/^https:\/\/[a-z0-9.-]+$/.test(o)) || (values["require-build"] && !/^[0-9a-f]{40}$/i.test(values["expect-build"] ?? ""))) {
  throw new Error("usage: live-watch.ts [--expect-build <commit>] https://<address> …");
}

const results = await Promise.all(positionals.map((origin) => watchAddress(origin, { expectBuild: values["expect-build"], requireBuild: values["require-build"] ?? false })));
const report = results.map((r) => [`${r.ok ? "✔" : "✘"} ${r.origin}`, ...r.lines.map((l) => `  ${l}`)].join("\n")).join("\n\n");
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## ALKAO en ligne\n\n\`\`\`\n${report}\n\`\`\`\n`);
process.exitCode = results.every((r) => r.ok) ? 0 : 1;
