import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migrateDatabase } from "../src/db/migrate.js";
import { containerSettings, startWorkerLoop } from "../src/ops/container.js";

// Run 62: the Docker image's entry (docs/ALKAO_DEPLOY_COOLIFY.md). Migrations first when
// ALKAO_MIGRATE_ON_START is on, then the server, then the background jobs when
// ALKAO_RUN_WORKERS is on: each pass is scripts/cron.ts in its own process, as on MochaHost.
// Log lines hold counts and migration names only, never a setting's value.
const settings = containerSettings(process.env);
let jobs: { stop(): Promise<void> } | null = null;

// The container's first process: without these handlers it would ignore `docker stop` until
// killed. A pass under way gets a few seconds to finish; each of its steps is safe to repeat.
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    console.log(`alkao stopping (${signal})`);
    setTimeout(() => process.exit(0), 8000).unref();
    void (jobs?.stop() ?? Promise.resolve()).finally(() => process.exit(0));
  });
}

if (settings.migrateOnStart) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const applied = await migrateDatabase(client);
    console.log(applied.length ? `alkao migrations applied: ${applied.join(", ")}` : "alkao migrations: up to date");
  } finally {
    await client.end();
  }
}

await import("../src/server.js");

const cron = fileURLToPath(new URL("./cron.ts", import.meta.url));
jobs = settings.runWorkers
  ? startWorkerLoop(
      () =>
        new Promise<void>((resolve) => {
          const child = spawn(process.execPath, ["--import", "tsx", cron], { stdio: "inherit" });
          child.on("error", (error) => {
            console.error(`alkao jobs could not start: ${error.message}`);
            resolve();
          });
          child.on("exit", () => resolve());
        }),
      settings.workerIntervalMs,
    )
  : null;
console.log(`alkao container: background jobs ${jobs ? `every ${settings.workerIntervalMs / 1000} s` : "off (ALKAO_RUN_WORKERS)"}`);
