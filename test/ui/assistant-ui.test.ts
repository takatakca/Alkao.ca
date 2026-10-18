import { existsSync, mkdirSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTransaction } from "../../src/db/pool.js";
import { EventFile, importEvent } from "../../src/ops/events-import.js";
import { stopServer, testApp, tokenFor } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { seedTwoTenants, type SeedResult } from "../helpers/seed.js";
import { FakeWriter } from "../helpers/writer.js";

/**
 * Run 92: the writing assistant in /ops, driven like a staff member. A fake model answers;
 * the draft lands in the form, and nothing is saved until staff save it.
 * Screenshots go to ALKAO_SCREENSHOTS when it is set.
 */
const executablePath = process.env.ALKAO_CHROMIUM_PATH ?? (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
const shots = process.env.ALKAO_SCREENSHOTS;
const NOW = new Date("2026-10-01T12:00:00Z");
const havana = EventFile.parse(JSON.parse(readFileSync(new URL("../../catalogs/havana-halloween-2026.json", import.meta.url), "utf8")));

let db: TestDatabase;
let seed: SeedResult;
let server: ServerType;
let origin: string;
let browser: Browser;
let eventId: string;
const writer = new FakeWriter([]);
const pageErrors: string[] = [];

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  eventId = (await withTransaction(db.pool, (tx) => importEvent(tx, { clientId: seed.havana.clientId, brandId: seed.havana.brandId }, havana,
    { capacity: 300, publish: true, listOnAlkao: false, now: NOW }))).eventId;
  const app = testApp(db.pool, { now: () => NOW, writer });
  server = await new Promise<ServerType>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), args: ["--no-sandbox"] });
  if (shots) mkdirSync(shots, { recursive: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await stopServer(server);
  await db?.drop();
});

async function signedIn(): Promise<Page> {
  const token = await tokenFor(seed.users.havanaOwner, { expiresIn: "30m" });
  const context = await browser.newContext({ locale: "fr-CA", viewport: { width: 1280, height: 900 } });
  await context.addInitScript((t) => {
    sessionStorage.setItem("alkao.ops.session", JSON.stringify({ accessToken: t, refreshToken: null, expiresAt: Date.now() + 1_800_000, email: "ops@example.com" }));
  }, token);
  const page = await context.newPage();
  page.on("pageerror", (e) => pageErrors.push(e.message));
  return page;
}

const brandPath = () => `/c/${seed.havana.clientId}/b/${seed.havana.brandId}`;

describe("Run 92: the writing assistant in /ops", () => {
  it("fills a new campaign from a one-line brief, with the event's shop as the button", async () => {
    writer.asked = [];
    (writer as unknown as { answers: unknown[] }).answers = [{
      subject: "Halloween Havana : encore deux samedis",
      preheader: "Le 24 et le 31 octobre, de 14 h à 22 h",
      heading: "Bonjour {prénom},",
      body: "Il reste deux samedis pour le train de l'Halloween, le 24 et le 31 octobre, de 14 h à 22 h.\n\nAdulte 25 $ + taxes, enfant 12 $ + taxes.",
      ctaLabel: "Choisir ma date",
    }];
    const page = await signedIn();
    await page.goto(`${origin}/ops#${brandPath()}/campaign`);
    const card = page.getByRole("form", { name: "Rédiger avec l'assistant" });
    await card.waitFor();
    await card.getByLabel("Événement").selectOption({ label: "Halloween Havana 2026" });
    await card.getByLabel("Consigne").fill("Rappeler aux familles qu'il reste deux samedis");
    await card.getByRole("button", { name: "Rédiger le brouillon" }).click();
    await page.getByRole("status").filter({ hasText: "Brouillon inséré" }).waitFor();
    await expect.poll(() => page.getByLabel("Objet du courriel").inputValue()).toBe("Halloween Havana : encore deux samedis");
    expect(await page.getByLabel("Nom (pour l'équipe)").inputValue()).toBe("Halloween Havana : encore deux samedis");
    expect(await page.getByLabel("Bouton : lien https").inputValue()).toBe(`${origin}/acheter/${seed.havana.clientId}/${seed.havana.brandId}/${eventId}`);
    expect(writer.asked[0]!.prompt).toContain("Rappeler aux familles qu'il reste deux samedis");
    if (shots) await page.screenshot({ path: `${shots}/campaign-assistant.png`, fullPage: true });
    // Nothing is saved by the assistant.
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM public.ticketing_campaigns`)).rows[0].n).toBe(0);
  });

  it("lists the reasons when the draft breaks a rule", async () => {
    (writer as unknown as { answers: unknown[] }).answers = [{ subject: "Rabais de 30 %", preheader: "", heading: "Bonjour", body: "Texte", ctaLabel: "Acheter" }];
    const page = await signedIn();
    await page.goto(`${origin}/ops#${brandPath()}/campaign`);
    const card = page.getByRole("form", { name: "Rédiger avec l'assistant" });
    await card.getByLabel("Consigne").fill("Relancer");
    await card.getByRole("button", { name: "Rédiger le brouillon" }).click();
    await card.getByRole("alert").filter({ hasText: "30 %" }).waitFor();
    expect(await page.getByLabel("Objet du courriel").inputValue()).toBe("");
  });

  it("edits the event page by hand, and the assistant writes its sections, saved with the form (Run 93)", async () => {
    const page = await signedIn();
    await page.goto(`${origin}/ops#${brandPath()}/event/${eventId}`);
    const form = page.getByRole("form", { name: "Page de l’événement" });
    await form.waitFor();
    await form.getByLabel("Durée (minutes)").fill("120");
    await form.getByLabel("Format").fill("Parcours extérieur");
    await form.getByLabel("Résumé (une ligne sous le titre)").fill("Train hanté et village décoré");
    await form.getByRole("button", { name: "Ajouter : Galerie" }).click();
    await form.getByRole("group", { name: "Galerie" }).getByLabel("Photo (lien https)").fill("https://photos.alkao.test/train.webp");
    await form.getByRole("button", { name: "Ajouter : FAQ" }).click();
    await form.getByRole("group", { name: "FAQ" }).getByLabel("Question").fill("Y a-t-il du stationnement ?");
    await form.getByRole("group", { name: "FAQ" }).getByLabel("Réponse").fill("Oui, sur le site.");

    (writer as unknown as { answers: unknown[] }).answers = [{
      summary: "Train hanté, village décoré et spectacle",
      highlights: [{ title: "Le train de l'Halloween", text: "Un tour du site à bord du petit train." }, { title: "Le village hanté", text: "Des décors à parcourir à pied." }],
      steps: [{ title: "Arrivée", text: "Présentez votre billet à l'entrée." }],
      faq: [{ question: "Faut-il réserver ?", answer: "Oui, les places sont par soirée." }],
    }];
    await form.getByLabel("Notes pour rédiger la page (facultatif)").fill("Train, village hanté");
    await form.getByRole("button", { name: "Rédiger la page avec l’assistant" }).click();
    await form.getByRole("status").filter({ hasText: "Brouillon de l’assistant inséré" }).waitFor();
    await expect.poll(() => form.getByLabel("Résumé (une ligne sous le titre)").inputValue()).toBe("Train hanté, village décoré et spectacle");
    expect(await form.getByRole("group", { name: "Points forts" }).getByLabel("Titre").count()).toBe(2);
    // The gallery the organizer chose is not touched by the assistant.
    expect(await form.getByRole("group", { name: "Galerie" }).getByLabel("Photo (lien https)").inputValue()).toBe("https://photos.alkao.test/train.webp");
    if (shots) await page.screenshot({ path: `${shots}/event-page-editor.png`, fullPage: true });
    // Nothing is saved until staff save.
    expect((await db.pool.query(`SELECT page FROM public.ticketing_events WHERE id = $1`, [eventId])).rows[0].page).toEqual({});

    await form.getByRole("button", { name: "Enregistrer la page" }).click();
    await form.getByRole("status").filter({ hasText: "Enregistré." }).waitFor();
    const { rows } = await db.pool.query(`SELECT duration_minutes, format, page FROM public.ticketing_events WHERE id = $1`, [eventId]);
    expect(rows[0]).toMatchObject({ duration_minutes: 120, format: "Parcours extérieur" });
    expect(rows[0].page).toMatchObject({
      summary: "Train hanté, village décoré et spectacle",
      highlights: [{ title: "Le train de l'Halloween", text: "Un tour du site à bord du petit train.", imageUrl: null }, { title: "Le village hanté", text: "Des décors à parcourir à pied.", imageUrl: null }],
      gallery: [{ url: "https://photos.alkao.test/train.webp", alt: null }],
      steps: [{ title: "Arrivée", text: "Présentez votre billet à l'entrée.", imageUrl: null }],
      faq: [{ question: "Faut-il réserver ?", answer: "Oui, les places sont par soirée." }],
    });
  });

  it("says what a ticket includes, shown under « Plus d'infos » in the shop (Run 93)", async () => {
    const page = await signedIn();
    await page.goto(`${origin}/ops#${brandPath()}/event/${eventId}`);
    page.once("dialog", (d) => d.accept("Accès au site, au train et au spectacle."));
    await page.getByRole("row", { name: /^ADULT/ }).getByRole("button", { name: "Dire ce qui est inclus" }).click();
    await page.getByRole("row", { name: /^ADULT/ }).getByRole("button", { name: "Modifier ce qui est inclus" }).waitFor();
    const { rows } = await db.pool.query(`SELECT description FROM public.ticketing_ticket_types WHERE event_id = $1 AND code = 'ADULT'`, [eventId]);
    expect(rows[0].description).toBe("Accès au site, au train et au spectacle.");
  });

  it("drafts the event description, saved only with the form", async () => {
    (writer as unknown as { answers: unknown[] }).answers = [{ description: "Un parcours en train dans le site décoré pour l'Halloween, avec maquillage pour les enfants." }];
    const page = await signedIn();
    await page.goto(`${origin}/ops#${brandPath()}/event/${eventId}`);
    await page.getByRole("heading", { name: "Fiche de l’événement" }).waitFor();
    await page.getByLabel("Notes pour l’assistant (facultatif)").fill("Train, maquillage pour enfants");
    await page.getByRole("button", { name: "Rédiger avec l’assistant" }).click();
    await expect.poll(() => page.getByLabel("Description").inputValue()).toMatch(/parcours en train/);
    if (shots) await page.screenshot({ path: `${shots}/event-assistant.png`, fullPage: true });
    await page.getByRole("button", { name: "Enregistrer la fiche" }).click();
    await page.getByRole("status").filter({ hasText: "Enregistré." }).waitFor();
    const { rows } = await db.pool.query(`SELECT description FROM public.ticketing_events WHERE id = $1`, [eventId]);
    expect(rows[0].description).toMatch(/parcours en train/);
    expect(pageErrors).toEqual([]);
  });
});
