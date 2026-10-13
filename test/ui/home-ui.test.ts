import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { chromium, type Browser, type BrowserContextOptions } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stopServer, testApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { seedTwoTenants, type SeedResult } from "../helpers/seed.js";

/** Run 64: the platform home's interactions in a real Chromium (home-ui/home.js). */
const executablePath = process.env.ALKAO_CHROMIUM_PATH ?? (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);

let db: TestDatabase;
let seed: SeedResult;
let server: ServerType;
let origin: string;
let browser: Browser;
const TITLE = "Havana Resort — Événements 2026-2027";

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  const h = seed.havana;
  await db.pool.query(
    `INSERT INTO public.ticketing_brand_settings (client_id, brand_id, show_on_alkao) VALUES ($1, $2, true)
     ON CONFLICT (client_id, brand_id) DO UPDATE SET show_on_alkao = true`, [h.clientId, h.brandId]);
  // A real photo makes the event one of the carousel's slides.
  await db.pool.query(`UPDATE public.ticketing_events SET image_url = 'https://photos.alkao.test/event.webp', description = 'Festival sur glace' WHERE id = $1`, [h.eventId]);
  const app = testApp(db.pool, { publicUrl: "https://alkao.test" });
  server = await new Promise<ServerType>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), args: ["--no-sandbox"] });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await stopServer(server);
  await db?.drop();
});

async function home(options: BrowserContextOptions = { locale: "fr-CA" }, path = "/") {
  const context = await browser.newContext(options);
  await context.route("https://photos.alkao.test/**", (r) => r.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="9"/>' }));
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(`${origin}${path}`);
  await page.getByRole("heading", { level: 1 }).waitFor();
  return { page, context, errors };
}

describe("platform home in the browser", () => {
  it("runs under its policy: carousel, quick view and favourites that stay in this browser", async () => {
    const { page, context, errors } = await home();
    const slides = page.locator("[data-slide]");
    expect(await slides.count()).toBe(4);
    await expect.poll(() => page.locator("[data-caption]:not([hidden]) .caption-title").textContent()).toBe(TITLE);
    await page.getByRole("button", { name: "Diapositive suivante" }).click();
    await expect.poll(() => page.locator("[data-caption]:not([hidden]) .caption-title").textContent()).toBe("La scène, au premier rang.");
    await page.getByRole("button", { name: "Mettre le carrousel en pause" }).click();
    await page.getByRole("button", { name: "Reprendre le carrousel" }).waitFor();

    await page.locator(".card").getByRole("button", { name: "Aperçu" }).click();
    const dialog = page.getByRole("dialog", { name: TITLE });
    await dialog.waitFor();
    expect(await dialog.getByRole("link", { name: /Voir les billets/ }).getAttribute("href")).toBe(`/acheter/${seed.havana.clientId}/${seed.havana.brandId}/${seed.havana.eventId}`);
    await dialog.getByRole("button", { name: "Ajouter aux favoris" }).click();
    await page.keyboard.press("Escape");
    await expect.poll(() => page.locator(".card .fav").getAttribute("aria-pressed")).toBe("true");
    await page.reload();
    await expect.poll(() => page.locator(".card .fav").getAttribute("aria-pressed")).toBe("true");
    expect(errors).toEqual([]);
    await context.close();
  });

  it("finds events, categories and answers in the search palette (Ctrl+K)", async () => {
    const { page, context, errors } = await home();
    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog", { name: "Rechercher" });
    await palette.waitFor();
    await palette.getByRole("searchbox").fill("havana");
    await palette.getByRole("link", { name: new RegExp(TITLE) }).waitFor();
    await palette.getByRole("searchbox").fill("rembours");
    await palette.getByRole("link", { name: "Puis-je être remboursé?" }).click();
    expect(await page.locator("#faq-remboursement").getAttribute("open")).toBe("");
    expect(errors).toEqual([]);
    await context.close();
  });

  it("the assistant answers from the help topics and the events on sale", async () => {
    const { page, context, errors } = await home();
    await page.getByRole("button", { name: "Ouvrir l’assistant ALKAO" }).click();
    const panel = page.getByRole("region", { name: "Assistant ALKAO" });
    const log = panel.getByRole("log");
    await log.getByText(/Bonjour!/).waitFor({ timeout: 5000 });
    await panel.getByRole("textbox").fill("J'ai perdu mes billets");
    await panel.getByRole("button", { name: "Envoyer" }).click();
    await log.getByText(/Retrouver mes billets/).first().waitFor({ timeout: 5000 });
    await panel.getByRole("button", { name: "Trouver un événement" }).click();
    await log.getByRole("link", { name: new RegExp(TITLE) }).waitFor({ timeout: 5000 });
    await page.keyboard.press("Escape");
    await expect.poll(() => panel.isVisible()).toBe(false);
    expect(errors).toEqual([]);
    await context.close();
  });

  it("suggests English once to an English browser, and remembers the answer", async () => {
    const { page, context } = await home({ locale: "en-CA" });
    const toast = page.getByRole("status").filter({ hasText: "Prefer English?" });
    await toast.waitFor({ timeout: 6000 });
    expect(await toast.getByRole("link", { name: "Switch to English" }).getAttribute("href")).toBe("/?lang=en");
    await toast.getByRole("button", { name: "No thanks" }).click();
    await page.reload();
    await page.waitForTimeout(3000);
    expect(await toast.isVisible()).toBe(false);
    await context.close();

    const fr = await home({ locale: "fr-CA" });
    await fr.page.waitForTimeout(3000);
    expect(await fr.page.locator("[data-lang-toast]").isVisible()).toBe(false);
    await fr.context.close();
  });

  it("still works without JavaScript: first slide, search form and answers", async () => {
    const { page, context } = await home({ locale: "fr-CA", javaScriptEnabled: false });
    expect(await page.locator("[data-caption]:not([hidden])").count()).toBe(1);
    await page.getByRole("searchbox", { name: "Quoi" }).fill("introuvable");
    await page.getByRole("button", { name: "Rechercher" }).first().click();
    await page.getByText("Aucun événement en vente ne correspond").waitFor();
    expect(await page.locator("[data-open-assistant]").first().isVisible()).toBe(false);
    await context.close();
  });
});
