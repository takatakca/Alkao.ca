import { expireStaleHolds } from "../db/commerce.js";
import { withTransaction, type Db } from "../db/pool.js";

/** Expire every hold past its deadline, returning the seats to inventory. Safe to run anywhere, any time. */
export async function sweepExpiredHolds(db: Db, now = new Date()): Promise<number> {
  return withTransaction(db, (tx) => expireStaleHolds(tx, now));
}

/** Sweep on an interval until stopped. */
export function startSweeper(db: Db, intervalMs: number, log: (msg: string) => void = console.log): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const expired = await sweepExpiredHolds(db);
      if (expired > 0) log(`alkao sweeper: expired ${expired} hold(s)`);
    } catch (error) {
      log(`alkao sweeper: ${(error as Error).message}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  void tick();
  return () => clearInterval(timer);
}
