import { existsSync, mkdirSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stopServer, testApp, tokenFor } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { seedTwoTenants, type SeedResult } from "../helpers/seed.js";

/**
 * Run 97: staff make a presale from a regular ticket and show a code as a coupon, in /ops,
 * in a real Chromium. Screenshots go to ALKAO_SCREENSHOTS when it is set.
 */
const executablePath = process.env.ALKAO_CHROMIUM_PATH ?? (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
const shots = process.env.ALKAO_SCREENSHOTS;

let db: TestDatabase;
let seed: SeedResult;
let server: ServerType;
let origin: string;
let browser: Browser;
const pageErrors: string[] = [];

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  const app = testApp(db.pool);
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

async function eventPage(): Promise<Page> {
  const token = await tokenFor(seed.users.havanaOwner, { expiresIn: "30m" });
  const context = await browser.newContext({ locale: "fr-CA", viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  await context.addInitScript((t) => {
    sessionStorage.setItem("alkao.ops.session", JSON.stringify({ accessToken: t, refreshToken: null, expiresAt: Date.now() + 1_800_000, email: "ops@example.com" }));
  }, token);
  const page = await context.newPage();
  page.on("pageerror", (e) => pageErrors.push(e.message));
  const h = seed.havana;
  await page.goto(`${origin}/ops#/c/${h.clientId}/b/${h.brandId}/event/${h.eventId}`);
  await page.getByRole("form", { name: "Créer une prévente" }).waitFor();
  return page;
}
const local = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

describe("Run 97: presales and coupons in /ops", () => {
  it("makes a presale from a regular ticket, refusing a price that is not lower", async () => {
    const page = await eventPage();
    const form = page.getByRole("form", { name: "Créer une prévente" });
    await form.getByLabel("Billet régulier").selectOption({ label: "Admission générale — 13 ans et + (29,95 $)" });
    await form.getByLabel("Prix prévente ($)").fill("29,95");
    await form.getByLabel("Quantité (toutes séances)").fill("200");
    await form.getByRole("button", { name: "Créer la prévente" }).click();
    await page.getByText("Le prix prévente doit être plus bas que le prix régulier (29,95 $).").waitFor();

    await form.getByLabel("Prix prévente ($)").fill("23,95");
    await form.getByText("Rabais montré aux acheteurs : −20 % (29,95 $ barré).", { exact: false }).waitFor();
    await form.getByLabel("Fin de la prévente").fill(local(new Date(Date.now() + 10 * 86_400_000)));
    await form.getByRole("button", { name: "Créer la prévente" }).click();
    const row = page.getByRole("row", { name: /^GENERAL_PRE / });
    await row.waitFor();
    expect(await row.textContent()).toMatch(/Admission générale — 13 ans et \+ — Prévente.*23,95\s\$.*Prévente de GENERAL.*jusqu'au .*0 \/ 200 vendus ou réservés/s);
    const { rows } = await db.pool.query(
      `SELECT p.price_cents, p.quantity_limit, p.sales_end_at IS NOT NULL AS ends, r.code AS regular FROM public.ticketing_ticket_types p JOIN public.ticketing_ticket_types r ON r.id = p.presale_of WHERE p.code = 'GENERAL_PRE'`,
    );
    expect(rows[0]).toEqual({ price_cents: 2395, quantity_limit: 200, ends: true, regular: "GENERAL" });

    // Its quantity can change later.
    page.once("dialog", (d) => d.accept("150"));
    await row.getByRole("button", { name: "0 / 200 vendus ou réservés" }).click();
    await row.getByRole("button", { name: "0 / 150 vendus ou réservés" }).waitFor();
    if (shots) await page.screenshot({ path: `${shots}/presale-ops.png`, fullPage: true });
  });

  it("shows a code as a public coupon, with its name, and copies its link", async () => {
    const page = await eventPage();
    const form = page.getByRole("form", { name: "Nouveau code promo" });
    await form.getByLabel("Code promo").fill("prevente15");
    await form.getByLabel("Rabais (%)").fill("15");
    await form.getByLabel("Coupon public (montré à tous les acheteurs)").check();
    await form.getByLabel("Nom du coupon (facultatif)").fill("Coupon prévente");
    // Run 99: kept off presale prices.
    await form.getByLabel("Non cumulable avec la prévente").check();
    await form.getByRole("button", { name: "Créer le code" }).click();
    const row = page.getByRole("row", { name: /^PREVENTE15 / });
    await row.waitFor();
    expect(await row.textContent()).toMatch(/Public Coupon prévente.*Non cumulable/s);
    await row.getByRole("button", { name: "Rendre cumulable" }).click();
    await row.getByRole("button", { name: "Rendre non cumulable" }).waitFor();
    await row.getByRole("button", { name: "Copier le lien du coupon" }).click();
    await row.getByRole("button", { name: "Lien copié" }).waitFor();
    const h = seed.havana;
    expect(await page.evaluate("navigator.clipboard.readText()")).toBe(`${origin}/acheter/${h.clientId}/${h.brandId}/${h.eventId}?coupon=PREVENTE15`);
    await row.getByRole("button", { name: "Rendre privé" }).click();
    await row.getByRole("button", { name: "Montrer comme coupon" }).waitFor();
    const { rows } = await db.pool.query(`SELECT public, label, excludes_presales FROM public.ticketing_promo_codes WHERE code = 'PREVENTE15'`);
    expect(rows[0]).toEqual({ public: false, label: "Coupon prévente", excludes_presales: false });
  });

  it("makes a partner company's codes, downloads its file, and switches them off (Run 103)", async () => {
    const page = await eventPage();
    const form = page.getByRole("form", { name: "Codes pour une entreprise" });
    await form.getByLabel("Entreprise").fill("Caisse Desjardins de Valleyfield");
    await form.getByLabel("Nombre de codes").fill("25");
    await form.getByLabel("Rabais (%)").fill("15");
    await form.getByRole("button", { name: "Créer les codes" }).click();
    await page.getByText("25 codes créés pour Caisse Desjardins de Valleyfield.", { exact: false }).waitFor();
    const row = page.getByRole("region", { name: "Codes des entreprises" }).getByRole("row", { name: /^Caisse Desjardins de Valleyfield / });
    expect(await row.textContent()).toMatch(/Caisse Desjardins de Valleyfield\s*25\s*0 \/ 25\s*15 %.*Actifs/s);
    if (shots) await page.locator("form[aria-label='Codes pour une entreprise']").screenshot({ path: `${shots}/partner-codes-form.png` });

    const [file] = await Promise.all([page.waitForEvent("download"), row.getByRole("button", { name: "Télécharger les codes (CSV)" }).click()]);
    expect(file.suggestedFilename()).toBe("alkao-codes-caisse-desjardins-de-valleyfield.csv");
    const text = readFileSync((await file.path())!, "utf8");
    expect(text.trim().split("\r\n")).toHaveLength(26);
    expect(text).toContain(`?coupon=CAISSEDE-`);

    await row.getByRole("button", { name: "Désactiver tous" }).click();
    await row.getByRole("button", { name: "Réactiver tous" }).waitFor();
    const { rows } = await db.pool.query(`SELECT count(*)::int AS n FROM public.ticketing_promo_codes WHERE partner = 'Caisse Desjardins de Valleyfield' AND NOT active`);
    expect(rows[0].n).toBe(25);
    if (shots) await page.getByRole("region", { name: "Codes des entreprises" }).screenshot({ path: `${shots}/partner-codes-table.png` });
    expect(pageErrors).toEqual([]);
  });
});
