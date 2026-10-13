import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { buildId } from "../../src/config.js";
import { BOOTSTRAP_FILE, listMigrations, migrateDatabase } from "../../src/db/migrate.js";
import { containerSettings, startWorkerLoop } from "../../src/ops/container.js";
import { checkDatabase } from "../../src/ops/golive.js";
import { call, testApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";

/** Run 62: ALKAO in one container (Coolify): migrations on start, background jobs, no test shim. */
const ROOT = join(import.meta.dirname, "..", "..");
const made: TestDatabase[] = [];
afterEach(async () => {
  await Promise.all(made.splice(0).map((d) => d.drop()));
});

async function database(empty: boolean) {
  const d = await createTestDatabase({ empty });
  made.push(d);
  return d;
}

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

const defaultGrants = (q: pg.Client) =>
  q.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_default_acl").then((r) => r.rows[0]!.n);

describe("migrations on a new production PostgreSQL", () => {
  it("bring an empty database up to this code without the test shim, closed to anon", async () => {
    const d = await database(true);
    const applied = await withClient(d.url, (c) => migrateDatabase(c));
    expect(applied).toEqual(listMigrations().map((m) => m.name));

    const checks = await checkDatabase(d.pool);
    expect(checks.filter((c) => c.status === "fail" && c.area !== "Clients et billetterie")).toEqual([]);
    expect(checks).toContainEqual(expect.objectContaining({ status: "ok", message: "RLS active partout, rien pour anon, lecture seule pour le personnel connecté" }));
    // Nothing granted by default: a table added by hand stays closed to anon and authenticated.
    await withClient(d.url, async (c) => {
      expect(await defaultGrants(c)).toBe(0);
      await c.query("CREATE TABLE public.added_by_hand (x int)");
      const { rows } = await c.query<{ anon: boolean; staff: boolean }>(
        "SELECT has_table_privilege('anon', 'public.added_by_hand', 'SELECT') AS anon, has_table_privilege('authenticated', 'public.added_by_hand', 'SELECT') AS staff",
      );
      expect(rows[0]).toEqual({ anon: false, staff: false });
      // auth.uid() reads the caller's claims, as on Supabase.
      await c.query("BEGIN");
      await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: "00000000-0000-4000-8000-000000000001" })]);
      expect((await c.query<{ id: string }>("SELECT auth.uid() AS id")).rows[0]!.id).toBe("00000000-0000-4000-8000-000000000001");
      await c.query("ROLLBACK");
    });

    expect(await withClient(d.url, (c) => migrateDatabase(c))).toEqual([]);
  });

  it("change nothing Supabase already has (auth.uid(), default grants)", async () => {
    const d = await database(false);
    await withClient(d.url, async (c) => {
      const before = { uid: (await c.query("SELECT pg_get_functiondef('auth.uid()'::regprocedure) AS f")).rows[0].f, grants: await defaultGrants(c) };
      await c.query(readFileSync(BOOTSTRAP_FILE, "utf8"));
      expect(await migrateDatabase(c)).toEqual([]);
      const after = { uid: (await c.query("SELECT pg_get_functiondef('auth.uid()'::regprocedure) AS f")).rows[0].f, grants: await defaultGrants(c) };
      expect(after).toEqual(before);
    });
  });

  it("take turns when two containers start together", async () => {
    const d = await database(true);
    const [a, b] = await Promise.all([withClient(d.url, (c) => migrateDatabase(c)), withClient(d.url, (c) => migrateDatabase(c))]);
    expect([a.length, b.length].sort()).toEqual([0, listMigrations().length]);
  });
});

describe("container settings", () => {
  it("are off by default, so docker run serves as before", () => {
    expect(containerSettings({})).toEqual({ migrateOnStart: false, runWorkers: false, workerIntervalMs: 60_000 });
    expect(containerSettings({ ALKAO_MIGRATE_ON_START: "true", ALKAO_RUN_WORKERS: "1", ALKAO_WORKER_INTERVAL_SECONDS: "30" })).toEqual({
      migrateOnStart: true, runWorkers: true, workerIntervalMs: 30_000,
    });
    expect(containerSettings({ ALKAO_MIGRATE_ON_START: "yes" }).migrateOnStart).toBe(false);
    expect(() => containerSettings({ ALKAO_WORKER_INTERVAL_SECONDS: "5" })).toThrow(/between 15 and 3600/);
  });
});

describe("the release in /health", () => {
  it("shows a commit or tag, and leaves out anything else", async () => {
    expect(buildId(" 2707b92055fc\n")).toBe("2707b92055fc");
    expect(buildId("v1.2.0")).toBe("v1.2.0");
    expect(buildId("")).toBeNull();
    expect(buildId("not a build; id")).toBeNull();
    const pool = new pg.Pool({ connectionString: "postgres://nobody@127.0.0.1:1/none" });
    expect((await call(testApp(pool, { buildId: "2707b92055fc" }), "GET", "/health")).body).toMatchObject({ service: "alkao", build: "2707b92055fc" });
    expect((await call(testApp(pool), "GET", "/health")).body).not.toHaveProperty("build");
    await pool.end();
  });
});

describe("background jobs loop", () => {
  it("runs one pass at a time, and stop waits for the pass under way", async () => {
    let running = 0;
    let most = 0;
    let passes = 0;
    let finished = 0;
    const loop = startWorkerLoop(async () => {
      running++;
      passes++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 40));
      running--;
      finished++;
    }, 5);
    await new Promise((r) => setTimeout(r, 130));
    await loop.stop();
    expect(passes).toBeGreaterThanOrEqual(2);
    expect(most).toBe(1);
    expect(finished).toBe(passes);
    const after = passes;
    await new Promise((r) => setTimeout(r, 30));
    expect(passes).toBe(after);
  });

  it("keeps going after a failed pass", async () => {
    let passes = 0;
    const loop = startWorkerLoop(async () => {
      passes++;
      if (passes === 1) throw new Error("boom");
    }, 5);
    await new Promise((r) => setTimeout(r, 40));
    await loop.stop();
    expect(passes).toBeGreaterThanOrEqual(2);
  });
});

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

describe("the image's entry (scripts/container.ts)", () => {
  it("migrates, serves its build in /health, runs the jobs and stops on SIGTERM", async () => {
    const d = await database(true);
    const port = await freePort();
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/container.ts"], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH, DATABASE_URL: d.url, PORT: String(port), NODE_ENV: "production",
        ALKAO_MIGRATE_ON_START: "true", ALKAO_RUN_WORKERS: "true", ALKAO_BUILD_ID: "abc123def456", ALKAO_LOG_REQUESTS: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (b) => (output += b));
    child.stderr.on("data", (b) => (output += b));
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    try {
      const until = async (done: () => Promise<boolean> | boolean) => {
        for (let i = 0; i < 300 && !(await done()); i++) await new Promise((r) => setTimeout(r, 100));
      };
      const get = (path: string) => fetch(`http://127.0.0.1:${port}${path}`).catch(() => null);
      await until(async () => (await get("/health/ready"))?.ok === true);
      expect(await (await get("/health"))!.json()).toMatchObject({ ok: true, service: "alkao", build: "abc123def456" });
      await until(() => output.includes("alkao cron "));
      expect(output).toContain(`alkao migrations applied: ${listMigrations()[0]!.name}`);
      expect(output).toMatch(/alkao cron \S+ \{"ran":true/);
      expect(output).not.toContain(d.url);
    } finally {
      child.kill("SIGTERM");
    }
    expect(await exited).toBe(0);
    expect(output).toContain("alkao stopping (SIGTERM)");
  }, 60_000);
});
