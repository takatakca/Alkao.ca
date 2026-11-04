import { existsSync, mkdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adm, stopServer, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { seedTwoTenants, type SeedResult, type TenantFixture } from "../helpers/seed.js";

/**
 * Run 106: the "Passés" filter and the filter bar, in a real Chromium, on a computer and on a
 * phone. Screenshots go to ALKAO_SCREENSHOTS when it is set.
 */
const executablePath = process.env.ALKAO_CHROMIUM_PATH ?? (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
const shots = process.env.ALKAO_SCREENSHOTS;
let db: TestDatabase;
let seed: SeedResult;
let app: TestApp;
let server: ServerType;
let origin: string;
let browser: Browser;
let t: TenantFixture;
const pageErrors: string[] = [];

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  t = seed.havana;
  app = testApp(db.pool, { publicUrl: "https://alkao.test" });
  server = await new Promise<ServerType>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), args: ["--no-sandbox"] });
  if (shots) mkdirSync(shots, { recursive: true });
  const r = await app.request(`${adm(t.clientId, t.brandId)}/appearance`, {
    method: "PUT", headers: { authorization: `Bearer ${await tokenFor(seed.users.havanaOwner)}`, "content-type": "application/json" }, body: JSON.stringify({ showOnAlkao: true }),
  });
  expect(r.status).toBe(200);
  await db.pool.query(`UPDATE public.ticketing_sessions SET status = 'on_sale', starts_at = now() + interval '20 days' WHERE event_id = $1`, [t.eventId]);
  const { rows } = await db.pool.query<{ id: string }>(
    `INSERT INTO public.ticketing_events (client_id, brand_id, venue_id, slug, title, description, status)
     SELECT client_id, brand_id, venue_id, 'halloween-ui', 'Halloween Havana', 'Soirée costumée en famille', 'published' FROM public.ticketing_events WHERE id = $1 RETURNING id`,
    [t.eventId],
  );
  for (const days of [-10, -3]) {
    await db.pool.query(
      `INSERT INTO public.ticketing_sessions (client_id, brand_id, event_id, starts_at, capacity, status) VALUES ($1, $2, $3, now() + make_interval(days => $4), 100, 'closed')`,
      [t.clientId, t.brandId, rows[0]!.id, days],
    );
  }
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await stopServer(server);
  await db?.drop();
});

describe("Run 106: the past and the filter bar in the browser", () => {
  it("on a computer: the bar stays in view, « Passés » shows the past, « À venir » goes back", async () => {
    const context = await browser.newContext({ locale: "fr-CA", viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await page.goto(`${origin}/?periode=passes#evenements`);
    const bar = page.getByRole("group", { name: "Affiner" });
    await bar.waitFor();
    expect(await bar.evaluate((el) => (globalThis as any).getComputedStyle(el).position)).toBe("sticky");
    const card = page.locator("article.card.is-past");
    await expect.poll(() => card.count()).toBe(1);
    expect(await card.textContent()).toMatch(/Terminé[\s\S]*Halloween Havana[\s\S]*2 dates[\s\S]*Voir l’événement/);
    if (shots) await page.locator("#evenements").screenshot({ path: `${shots}/home-past-desktop.png` });
    await page.getByRole("group", { name: "Période" }).getByRole("link", { name: /À venir/ }).click();
    await page.getByRole("heading", { name: "Événements en vente" }).waitFor();
    await page.getByRole("link", { name: "Voir les billets" }).first().waitFor();
    expect(await page.locator("article.card.is-past").count()).toBe(0);
    expect(pageErrors).toEqual([]);
    await context.close();
  });

  it("on a phone: a filter comes off with one tap, and nothing overflows the screen", async () => {
    const context = await browser.newContext({ locale: "fr-CA", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await page.goto(`${origin}/?periode=passes&q=halloween#evenements`);
    await page.getByText("1 événement", { exact: true }).waitFor();
    expect(await page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth")).toBe(true);
    if (shots) await page.locator("#evenements").screenshot({ path: `${shots}/home-past-phone.png` });
    await page.getByRole("link", { name: "Retirer le filtre : « halloween »" }).click();
    await page.waitForURL((url) => url.searchParams.get("periode") === "passes" && !url.searchParams.has("q"));
    await page.locator("article.card.is-past").first().waitFor();
    expect(pageErrors).toEqual([]);
    await context.close();
  });
});
