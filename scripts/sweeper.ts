import { createPool } from "../src/db/pool.js";
import { startSweeper } from "../src/ops/sweeper.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const intervalMs = Number(process.env.ALKAO_SWEEP_INTERVAL_SECONDS ?? 60) * 1000;
const db = createPool(url, 2);
const stop = startSweeper(db, intervalMs);
console.log(`alkao sweeper running every ${intervalMs / 1000}s`);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stop();
    void db.end().then(() => process.exit(0));
  });
}
