import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stopServer, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { seedTwoTenants, type SeedResult } from "../helpers/seed.js";

/**
 * Run 32: with Stripe test keys, staff and buyers are told that nothing is real, so a test
 * deployment is never mistaken for the live one (and the other way around).
 */
const executablePath = process.env.ALKAO_CHROMIUM_PATH ?? (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);

let db: TestDatabase;
let seed: SeedResult;
let browser: Browser;
const servers: ServerType[] = [];
const pageErrors: string[] = [];

async function start(app: TestApp) {
  const server = await new Promise<ServerType>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), args: ["--no-sandbox"] });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  for (const s of servers) await stopServer(s);
  await db?.drop();
});

describe("Stripe test mode", () => {
  it("is announced in the public configs only when payments are configured", async () => {
    const shop = async (mode?: "test" | "live") =>
      (await testApp(db.pool, mode ? { paymentsMode: mode } : {}).request("/shop/config.json")).json();
    expect(await shop()).toEqual({ publicUrl: null });
    expect(await shop("test")).toEqual({ publicUrl: null, paymentsMode: "test" });
    expect(await shop("live")).toEqual({ publicUrl: null, paymentsMode: "live" });
    const ops = await (await testApp(db.pool, { paymentsMode: "test" }).request("/ops/config.json")).json();
    expect(ops).toEqual({ supabaseUrl: null, supabaseAnonKey: null, embedOrigins: [], paymentsMode: "test" });
  });

  it("shows a banner to buyers and a badge to staff in test mode, and nothing in live mode", async () => {
    const h = seed.havana;
    const test = await start(testApp(db.pool, { paymentsMode: "test" }));
    const live = await start(testApp(db.pool, { paymentsMode: "live" }));
    const page = await (await browser.newContext({ locale: "fr-CA" })).newPage();
    page.on("pageerror", (e) => pageErrors.push(e.message));

    await page.goto(`${test}/acheter/${h.clientId}/${h.brandId}/${h.eventId}`);
    await page.getByRole("heading", { level: 1 }).waitFor();
    expect(await page.getByRole("status").filter({ hasText: "Mode test : aucun paiement réel" }).isVisible()).toBe(true);
    await page.goto(`${live}/acheter/${h.clientId}/${h.brandId}/${h.eventId}`);
    await page.getByRole("heading", { level: 1 }).waitFor();
    expect(await page.getByText("Mode test", { exact: false }).count()).toBe(0);

    const token = await tokenFor(seed.users.havanaOwner, { expiresIn: "30m" });
    const staff = await browser.newContext({ locale: "fr-CA" });
    await staff.addInitScript((t) => {
      sessionStorage.setItem("alkao.ops.session", JSON.stringify({ accessToken: t, refreshToken: null, expiresAt: Date.now() + 1_800_000, email: "ops@example.com" }));
    }, token);
    const ops = await staff.newPage();
    ops.on("pageerror", (e) => pageErrors.push(e.message));
    await ops.goto(`${test}/ops#/c/${h.clientId}/b/${h.brandId}/dashboard`);
    await ops.getByRole("status").filter({ hasText: "Stripe en mode test : aucun paiement réel" }).waitFor();
    await ops.goto(`${test}/ops#/`);
    await ops.getByRole("status").filter({ hasText: "Stripe en mode test" }).waitFor();
    await ops.goto(`${live}/ops#/c/${h.clientId}/b/${h.brandId}/dashboard`);
    await ops.getByRole("link", { name: "Tableau de bord" }).waitFor();
    expect(await ops.getByText("Stripe en mode test").count()).toBe(0);
  });

  it("ran without script errors", () => {
    expect(pageErrors).toEqual([]);
  });
});
