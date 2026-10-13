/**
 * Run 62: ALKAO in one long-running container (Coolify, or any Docker host), started by
 * scripts/container.ts. Two switches, both off by default, so `docker run` behaves as before:
 *
 *   - ALKAO_MIGRATE_ON_START: bring the database up to this code before serving
 *     (src/db/migrate.ts migrateDatabase), so a new release never serves an older schema;
 *   - ALKAO_RUN_WORKERS: the background jobs (scripts/cron.ts: seats, emails, texts,
 *     cancellations), one pass every ALKAO_WORKER_INTERVAL_SECONDS. Several containers may
 *     run them: the cron lock lets one pass work at a time.
 */
export interface ContainerSettings {
  migrateOnStart: boolean;
  runWorkers: boolean;
  workerIntervalMs: number;
}

const on = (v: string | undefined) => v === "true" || v === "1";

export function containerSettings(env: NodeJS.ProcessEnv): ContainerSettings {
  const seconds = Number(env.ALKAO_WORKER_INTERVAL_SECONDS ?? 60);
  if (!Number.isInteger(seconds) || seconds < 15 || seconds > 3600) {
    throw new Error("ALKAO_WORKER_INTERVAL_SECONDS must be a whole number of seconds between 15 and 3600");
  }
  return { migrateOnStart: on(env.ALKAO_MIGRATE_ON_START), runWorkers: on(env.ALKAO_RUN_WORKERS), workerIntervalMs: seconds * 1000 };
}

/**
 * One pass now, then one every `intervalMs`. A pass still working when the next is due
 * makes that one skip, never two at once. `stop()` waits for the pass under way.
 */
export function startWorkerLoop(pass: () => Promise<void>, intervalMs: number): { stop(): Promise<void> } {
  let running: Promise<void> | null = null;
  let stopped = false;
  const tick = () => {
    if (running || stopped) return;
    running = pass()
      .catch((error: unknown) => console.error(`alkao jobs failed: ${(error as Error).message}`))
      .finally(() => {
        running = null;
      });
  };
  const timer = setInterval(tick, intervalMs);
  tick();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}
