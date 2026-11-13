import { existsSync, mkdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adm, call, stopServer, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { FakeGateway } from "../helpers/fake-gateway.js";
import { seedTwoTenants, type SeedResult } from "../helpers/seed.js";

/**
 * Run 109: a buyer sees a merchant voucher in a real Chromium: its validity instead of a date
 * to pick, its value struck above its price, its conditions, and a cart ready at once.
 * Screenshots go to ALKAO_SCREENSHOTS when it is set.
 */
const executablePath = process.env.ALKAO_CHROMIUM_PATH ?? (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
const shots = process.env.ALKAO_SCREENSHOTS;
const DAY = 86_400_000;

let db: TestDatabase;
let seed: SeedResult;
let app: TestApp;
let server: ServerType;
let origin: string;
let browser: Browser;
let shop = "";

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  app = testApp(db.pool, { paymentGateway: new FakeGateway() });
  server = await new Promise<ServerType>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), args: ["--no-sandbox"] });
  if (shots) mkdirSync(shots, { recursive: true });

  // A voucher, set up as a merchant would in /ops: valid since yesterday, for 60 days.
  const h = seed.havana;
  const token = await tokenFor(seed.users.havanaOwner);
  const base = adm(h.clientId, h.brandId);
  const ev = await call(app, "POST", `${base}/events`, { token, body: {
    venueId: h.venueId, slug: "souper-pour-deux", title: "Souper pour deux au Bistro", voucher: true, category: "gastronomie",
    page: { terms: "Valide du lundi au jeudi\nUn bon par table\nRéservation requise au 514 555-0100" },
  } });
  expect(ev.status, JSON.stringify(ev.body)).toBe(201);
  const eventId = ev.body.event.id;
  const window = await call(app, "POST", `${base}/events/${eventId}/sessions`, { token, body: {
    startsAt: new Date(Date.now() - DAY).toISOString(), endsAt: new Date(Date.now() + 60 * DAY).toISOString(), capacity: 100,
  } });
  expect(window.status, JSON.stringify(window.body)).toBe(201);
  await call(app, "PATCH", `${base}/sessions/${window.body.session.id}`, { token, body: { status: "on_sale" } });
  const type = await call(app, "POST", `${base}/events/${eventId}/ticket-types`, { token, body: {
    code: "SOUPER2", name: "Souper pour deux (entrée, plat, dessert)", priceCents: 4500, valueCents: 8000, maxQuantity: 4, countsAsAdult: true,
  } });
  expect(type.status, JSON.stringify(type.body)).toBe(201);
  await call(app, "PATCH", `${base}/events/${eventId}`, { token, body: { status: "published" } });
  shop = `/acheter/${h.clientId}/${h.brandId}/${eventId}`;
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await stopServer(server);
  await db?.drop();
});

describe("Run 109: a merchant voucher in the shop", () => {
  it("shows its validity, its value and its conditions, and is ready to buy", async () => {
    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ locale: "fr-CA", viewport });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`${origin}${shop}`);
      await page.getByRole("heading", { level: 1, name: "Souper pour deux au Bistro" }).waitFor();

      // The hero: "Bon d'achat", "Valide jusqu'au …", the value struck above the price.
      const hero = page.locator(".hero");
      await expect.poll(() => hero.locator(".eyebrow").textContent()).toContain("Bon d'achat");
      expect(await hero.locator(".hero-where").textContent()).toMatch(/Valide jusqu'au \d{1,2} \S+/);
      const deal = hero.locator(".hb-deal");
      expect(await deal.textContent()).toMatch(/Bon d'achat\s*45,00\s\$\s*Valeur 80,00\s\$\s*−43 %\s*35,00\s\$ d'économie par bon/);

      // The panel: the validity instead of a calendar; the only window is already chosen.
      const panel = page.locator("#billets");
      await panel.getByRole("heading", { name: /Période de validité/ }).waitFor();
      expect(await panel.locator(".voucher-window").textContent()).toMatch(/Valide jusqu'au/);
      expect(await panel.locator(".calendar, .cal").count()).toBe(0);
      const row = panel.locator(".type").filter({ hasText: "Souper pour deux" });
      expect(await row.locator(".type-deal").textContent()).toMatch(/Bon d'achat\s*−43 %/);
      expect(await row.locator(".was").textContent()).toMatch(/Valeur\s*80,00\s\$/);
      await row.getByRole("button", { name: /Ajouter/ }).click();
      await expect.poll(() => row.locator("output").textContent()).toBe("1");

      // The conditions, one per line, in their own tab and section.
      await page.getByRole("link", { name: "Conditions" }).first().waitFor();
      const terms = page.locator("#conditions");
      expect(await terms.getByRole("heading", { level: 2 }).textContent()).toBe("Conditions de l'offre");
      expect(await terms.locator("li").allTextContents()).toEqual(["Valide du lundi au jeudi", "Un bon par table", "Réservation requise au 514 555-0100"]);

      const overflow = await page.evaluate(() => (globalThis as any).document.documentElement.scrollWidth - (globalThis as any).innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      if (shots) await page.screenshot({ path: `${shots}/voucher-shop-${viewport.width}.png`, fullPage: true });
      expect(errors).toEqual([]);
      await context.close();
    }
  });
});
