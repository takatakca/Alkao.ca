import { existsSync, readFileSync } from "node:fs";
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
    await expect.poll(() => page.locator("[data-caption]:not([hidden]) .caption-title").textContent()).toBe("Concerts");
    await page.getByRole("button", { name: "Mettre le carrousel en pause" }).click();
    await page.getByRole("button", { name: "Reprendre le carrousel" }).waitFor();

    await page.locator(".grid .card").getByRole("button", { name: "Aperçu" }).click();
    const dialog = page.getByRole("dialog", { name: TITLE });
    await dialog.waitFor();
    expect(await dialog.getByRole("link", { name: /Voir les billets/ }).getAttribute("href")).toBe(`/acheter/${seed.havana.clientId}/${seed.havana.brandId}/${seed.havana.eventId}`);
    await dialog.getByRole("button", { name: "Ajouter aux favoris" }).click();
    await page.keyboard.press("Escape");
    await expect.poll(() => page.locator(".grid .card .fav").getAttribute("aria-pressed")).toBe("true");
    await page.reload();
    await expect.poll(() => page.locator(".grid .card .fav").getAttribute("aria-pressed")).toBe("true");
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
    await log.getByText(/^Bonjour\. Posez votre question/).waitFor({ timeout: 5000 });
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

  it("Run 66: adds a date to the calendar, links to directions and remembers what was viewed", async () => {
    const { page, context, errors } = await home();
    expect(await page.locator("[data-recent]").isVisible()).toBe(false);
    await page.locator(".grid .card").getByRole("button", { name: "Aperçu" }).click();
    const dialog = page.getByRole("dialog", { name: TITLE });
    await dialog.waitFor();
    // Run 69: nothing said by the organizer, nothing shown.
    expect(await dialog.locator("[data-p-facts]").isVisible()).toBe(false);
    expect(await dialog.locator("[data-p-access]").isVisible()).toBe(false);
    const map = dialog.getByRole("link", { name: "Itinéraire vers Havana Resort, Maricourt (nouvel onglet)" });
    expect(await map.getAttribute("href")).toBe("https://www.google.com/maps/search/?api=1&query=Havana%20Resort%2C%20Maricourt");
    expect(await map.getAttribute("target")).toBe("_blank");
    expect(await map.getAttribute("rel")).toBe("noopener noreferrer");
    const [download] = await Promise.all([page.waitForEvent("download"), dialog.getByRole("button", { name: "Ajouter au calendrier", exact: true }).click()]);
    expect(download.suggestedFilename()).toBe("alkao-havana-resort-evenements-2026-2027.ics");
    const ics = readFileSync((await download.path())!, "utf8");
    expect(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")).toBe(true);
    expect(ics).toMatch(/\r\nDTSTART:\d{8}T\d{6}Z\r\n/);
    expect(ics).toContain(`\r\nUID:${seed.havana.eventId}-`);
    expect(ics).toContain("\r\nSUMMARY:Havana Resort — Événements 2026-2027\r\n");
    expect(ics).toContain("\r\nLOCATION:Havana Resort\\, Maricourt\r\n");
    // Each listed date has its own button too.
    expect(await dialog.getByRole("button", { name: /^Ajouter au calendrier : / }).count()).toBe(1);
    await page.keyboard.press("Escape");

    await page.reload();
    const recent = page.getByRole("list", { name: "Vus récemment" });
    await recent.waitFor();
    expect(await recent.locator(".card").count()).toBe(1);
    // The copy works like the original: its quick view opens.
    await recent.getByRole("button", { name: "Aperçu" }).click();
    await dialog.waitFor();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog", { name: "Rechercher" });
    await palette.getByText("Vus récemment").waitFor();
    await palette.getByRole("link", { name: new RegExp(TITLE) }).waitFor();
    await page.keyboard.press("Escape");
    // Cleared on request, and stays cleared.
    await page.getByRole("button", { name: "Effacer les événements vus récemment" }).click();
    await expect.poll(() => recent.isVisible()).toBe(false);
    await page.reload();
    await page.waitForTimeout(300);
    expect(await page.locator("[data-recent]").isVisible()).toBe(false);
    expect(errors).toEqual([]);
    await context.close();
  });

  it("Run 67: follows the organizer from the quick view, with a confirmation e-mail to come", async () => {
    const { page, context, errors } = await home();
    await page.locator(".grid .card").getByRole("button", { name: "Aperçu" }).click();
    const preview = page.getByRole("dialog", { name: TITLE });
    await preview.waitFor();
    const followBtn = preview.getByRole("button", { name: /^Suivre / });
    const brand = (await followBtn.textContent())!.replace(/^Suivre /, "").trim();
    await followBtn.click();
    const dialog = page.getByRole("dialog", { name: `Suivre ${brand}` });
    await dialog.waitFor();
    await expect.poll(() => page.evaluate(() => (globalThis as any).document.activeElement?.getAttribute("name"))).toBe("email");
    await dialog.getByRole("textbox", { name: "Courriel" }).fill("pas-une-adresse");
    await dialog.getByRole("button", { name: "Suivre" }).click();
    // The browser refuses the address itself: nothing is sent.
    expect(await dialog.getByRole("status").isVisible()).toBe(false);
    await dialog.getByRole("textbox", { name: "Courriel" }).fill("abonne@example.test");
    await dialog.getByRole("textbox", { name: "Prénom (facultatif)" }).fill("Alex");
    await dialog.getByRole("button", { name: "Suivre" }).click();
    await dialog.getByText(`Presque fini! Ouvrez le courriel de ${brand} et confirmez votre inscription.`).waitFor();
    const { rows } = await db.pool.query<{ status: string; source: string; first_name: string }>(
      `SELECT status, source, first_name FROM public.ticketing_newsletter_signups WHERE email = 'abonne@example.test'`);
    expect(rows).toEqual([{ status: "pending", source: "alkao", first_name: "Alex" }]);
    // Escape closes the form and comes back to the quick view, on the button that opened it.
    await page.keyboard.press("Escape");
    await expect.poll(() => dialog.isVisible()).toBe(false);
    expect(await preview.isVisible()).toBe(true);
    await expect.poll(() => page.evaluate(() => (globalThis as any).document.activeElement?.hasAttribute("data-p-follow"))).toBe(true);
    expect(errors).toEqual([]);
    await context.close();
  });

  it("Run 90: filter menus, and the photo viewer from the quick view and on the venue's page", async () => {
    const h = seed.havana;
    const { page, context, errors } = await home();
    const menu = (id: string) => page.locator("details.dd").filter({ has: page.locator(`#${id}`) });
    const isOpen = (id: string) => menu(id).evaluate((d: any) => d.open);
    await menu("f-price").locator("summary").click();
    await expect.poll(() => isOpen("f-price")).toBe(true);
    // One menu open at a time; Escape closes it and gives the focus back to its button.
    await menu("f-sort").locator("summary").click();
    await expect.poll(() => isOpen("f-price")).toBe(false);
    await expect.poll(() => isOpen("f-sort")).toBe(true);
    await page.keyboard.press("Escape");
    await expect.poll(() => isOpen("f-sort")).toBe(false);
    expect(await menu("f-sort").locator("summary").evaluate((el) => el === (globalThis as any).document.activeElement)).toBe(true);

    await page.locator(".grid .card").getByRole("button", { name: "Aperçu" }).click();
    const preview = page.getByRole("dialog", { name: TITLE });
    await preview.waitFor();
    const enlarge = preview.getByRole("button", { name: "Agrandir la photo" });
    await enlarge.click();
    const viewer = page.locator("dialog.zoom");
    await expect.poll(() => viewer.evaluate((d: any) => d.open)).toBe(true);
    expect(await viewer.locator(".zoom-stage img").getAttribute("src")).toBe("https://photos.alkao.test/event.webp");
    expect(await viewer.locator(".zoom-title").textContent()).toBe(TITLE);
    await viewer.getByRole("button", { name: "Zoom avant" }).click();
    await expect.poll(() => viewer.locator(".zoom-stage").getAttribute("class")).toContain("is-zoomed");
    await page.keyboard.press("0");
    await expect.poll(() => viewer.locator(".zoom-stage").getAttribute("class")).not.toContain("is-zoomed");
    await page.keyboard.press("Escape");
    await expect.poll(() => viewer.evaluate((d: any) => d.open)).toBe(false);
    // The quick view is still open, and the focus is back on the button that opened the viewer.
    expect(await preview.isVisible()).toBe(true);
    expect(await enlarge.evaluate((b) => b === (globalThis as any).document.activeElement)).toBe(true);
    await page.keyboard.press("Escape");

    await page.goto(`${origin}/salles/${h.clientId}/${h.brandId}/${h.venueId}`);
    await page.getByRole("heading", { level: 1, name: "Havana Resort" }).waitFor();
    await page.getByRole("button", { name: `Agrandir la photo : ${TITLE}` }).click();
    await expect.poll(() => page.locator("dialog.zoom").evaluate((d: any) => d.open)).toBe(true);
    // A single photo: no counter, no arrows.
    expect(await page.locator("dialog.zoom .zoom-count").textContent()).toBe("");
    expect(await page.locator("dialog.zoom .zoom-side").first().isHidden()).toBe(true);
    await page.keyboard.press("Escape");
    // The home's quick view works on the venue's page too.
    await page.locator(".grid .card").getByRole("button", { name: "Aperçu" }).click();
    await page.getByRole("dialog", { name: TITLE }).waitFor();
    expect(errors).toEqual([]);
    await context.close();
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
