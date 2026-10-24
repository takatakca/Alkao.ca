import { existsSync, mkdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adm, call, stopServer, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { FakeGateway } from "../helpers/fake-gateway.js";
import { seedTwoTenants, type SeedResult, type TenantFixture } from "../helpers/seed.js";

/**
 * Run 97: a buyer sees a presale price against the regular one, when it ends and what is
 * left, and applies a coupon in one click, in a real Chromium. Screenshots go to
 * ALKAO_SCREENSHOTS when it is set.
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
let label = "";
const pageErrors: string[] = [];

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  t = seed.havana;
  app = testApp(db.pool, { paymentGateway: new FakeGateway() });
  server = await new Promise<ServerType>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), args: ["--no-sandbox"] });
  if (shots) mkdirSync(shots, { recursive: true });

  // One date, a presale ticket for it and a public coupon, set up as staff would.
  await db.pool.query(`UPDATE public.ticketing_sessions SET status = 'closed' WHERE event_id = $1`, [t.eventId]);
  const { rows } = await db.pool.query<{ starts_at: Date }>(
    `INSERT INTO public.ticketing_sessions (client_id, brand_id, event_id, starts_at, capacity, status)
     VALUES ($1, $2, $3, date_trunc('minute', now()) + interval '20 days', 300, 'on_sale') RETURNING starts_at`,
    [t.clientId, t.brandId, t.eventId],
  );
  label = new Intl.DateTimeFormat("fr-CA", { timeZone: "America/Toronto", dateStyle: "full", timeStyle: "short" }).format(rows[0]!.starts_at);
  const token = await tokenFor(seed.users.havanaOwner);
  const base = adm(t.clientId, t.brandId);
  const general = t.types.find((x) => x.code === "GENERAL")!;
  const presale = await call(app, "POST", `${base}/events/${t.eventId}/ticket-types`, {
    token,
    body: {
      code: "GENERAL_PRE", name: "Admission générale — Prévente", priceCents: 2395, maxQuantity: 10, countsAsAdult: true,
      presaleOf: general.id, salesEndAt: new Date(Date.now() + 10 * 86_400_000).toISOString(), quantityLimit: 12, sortOrder: 0,
    },
  });
  expect(presale.status, JSON.stringify(presale.body)).toBe(201);
  const coupon = await call(app, "POST", `${base}/events/${t.eventId}/promo-codes`, {
    token,
    body: { code: "PREVENTE10", kind: "percent", percent: 10, public: true, label: "Coupon prévente", endsAt: new Date(Date.now() + 5 * 86_400_000).toISOString(), maxUses: 100 },
  });
  expect(coupon.status, JSON.stringify(coupon.body)).toBe(201);
  // Run 99: a second coupon, kept off presale prices.
  const regular = await call(app, "POST", `${base}/events/${t.eventId}/promo-codes`, {
    token, body: { code: "REGULIER5", kind: "amount", amountCents: 500, public: true, label: "Prix régulier", excludesPresales: true },
  });
  expect(regular.status, JSON.stringify(regular.body)).toBe(201);
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await stopServer(server);
  await db?.drop();
});

async function shop(query = "", viewport = { width: 1280, height: 900 }): Promise<Page> {
  const context = await browser.newContext({ locale: "fr-CA", viewport });
  const page = await context.newPage();
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(`${origin}/acheter/${t.clientId}/${t.brandId}/${t.eventId}${query}`);
  await page.getByRole("heading", { level: 1 }).waitFor();
  return page;
}

describe("Run 97: presales and coupons in the shop", () => {
  it("shows the presale against the regular price, then a coupon applies in one click", async () => {
    const page = await shop();
    // The hero says it first: the presale, its saving, the regular price struck through.
    const hero = page.locator(".hero-book");
    await expect.poll(() => hero.textContent()).toContain("Prix prévente");
    // The struck price sits next to the presale price it belongs to, never next to "From".
    expect(await hero.locator(".hb-deal").textContent()).toMatch(/Prix prévente\s*23,95\s\$\s*au lieu de\s*29,95\s\$\s*−20 %\s*jusqu'au /);

    // A single date on sale is already chosen.
    await page.getByRole("button", { name: "Ajouter Admission générale — Prévente", exact: true }).waitFor();
    const row = page.locator(".type.is-deal");
    expect(await row.textContent()).toMatch(/Prix prévente.*−20 %.*Admission générale — Prévente.*23,95\s\$.*au lieu de.*29,95\s\$/s);
    expect(await row.locator(".deal-meta span").allTextContents()).toEqual([expect.stringMatching(/^Jusqu'au /), "Plus que 12 à ce prix"]);
    // The presale comes right before the regular ticket it undercuts.
    const names = await page.locator(".types .type .name").allTextContents();
    expect(names.indexOf("Admission générale — Prévente")).toBe(names.indexOf("Admission générale — 13 ans et +") - 1);

    // The coupon, with its label, end and uses left; one click applies it.
    const card = page.locator(".coupon").filter({ hasText: "PREVENTE10" });
    expect(await card.textContent()).toMatch(/−10 %.*de rabais.*Coupon prévente.*jusqu'au .*100 restants.*PREVENTE10/s);
    // Run 99: a coupon kept off presale prices says so while the presale is on.
    expect(await page.locator(".coupon").filter({ hasText: "REGULIER5" }).locator(".coupon-meta").textContent()).toBe("hors prix prévente");
    await card.getByRole("button", { name: "Appliquer", exact: true }).click();
    await page.getByRole("button", { name: "Appliqué", exact: true, pressed: true }).waitFor();
    await page.getByRole("button", { name: "Ajouter Admission générale — Prévente", exact: true }).click();
    await page.getByRole("button", { name: "Ajouter Admission générale — Prévente", exact: true }).click();
    const box = page.locator(".quote-box");
    await expect.poll(() => box.textContent()).toMatch(/2 × Admission générale — Prévente\s*47,90\s\$.*Rabais \(PREVENTE10\)\s*−4,79\s\$/s);
    if (shots) await page.screenshot({ path: `${shots}/presale-shop.png`, fullPage: true });
    expect(label).not.toBe("");
  });

  it("no more than what is left at the presale price can be chosen", async () => {
    await db.pool.query(`UPDATE public.ticketing_ticket_types SET quantity_limit = 2 WHERE code = 'GENERAL_PRE'`);
    const page = await shop();
    const add = page.getByRole("button", { name: "Ajouter Admission générale — Prévente", exact: true });
    await add.click();
    await add.click();
    expect(await add.isDisabled()).toBe(true);
    expect(await page.locator(".type.is-deal .deal-meta").textContent()).toMatch(/Plus que 2 à ce prix/);
    await db.pool.query(`UPDATE public.ticketing_ticket_types SET quantity_limit = 12 WHERE code = 'GENERAL_PRE'`);
  });

  it("a coupon kept off presale prices explains itself on presale tickets (Run 99)", async () => {
    const page = await shop();
    await page.locator(".coupon").filter({ hasText: "REGULIER5" }).getByRole("button", { name: "Appliquer", exact: true }).click();
    await page.getByRole("button", { name: "Ajouter Admission générale — Prévente", exact: true }).click();
    await page.getByText("Ce code ne s'applique pas aux billets en prévente : il vaut pour les billets au prix régulier.").waitFor();
    if (shots) await page.locator(".side").screenshot({ path: `${shots}/coupon-presale-only.png` });
  });

  it("counts a presale down in its last 48 hours, to its real end (Run 101)", async () => {
    await db.pool.query(`UPDATE public.ticketing_ticket_types SET sales_end_at = now() + interval '5 hours' WHERE code = 'GENERAL_PRE'`);
    try {
      const page = await shop();
      const meta = page.locator(".type.is-deal .deal-meta span").first();
      await expect.poll(() => meta.textContent()).toMatch(/^Se termine dans [45] h \d+ min$/);
      expect(await page.locator(".hero-book .hb-deal-until").textContent()).toMatch(/^Se termine dans [45] h \d+ min$/);
      if (shots) await page.locator(".type.is-deal").screenshot({ path: `${shots}/presale-countdown.png` });
    } finally {
      await db.pool.query(`UPDATE public.ticketing_ticket_types SET sales_end_at = now() + interval '10 days' WHERE code = 'GENERAL_PRE'`);
    }
  });

  it("announces the next price phase on the presale row (Run 104)", async () => {
    const token = await tokenFor(seed.users.havanaOwner);
    const { rows: [pre] } = await db.pool.query<{ sales_end_at: Date }>(`SELECT sales_end_at FROM public.ticketing_ticket_types WHERE code = 'GENERAL_PRE'`);
    const next = await call(app, "POST", `${adm(t.clientId, t.brandId)}/events/${t.eventId}/ticket-types`, {
      token,
      body: {
        code: "GENERAL_PRE2", name: "Admission générale — Dernière chance", priceCents: 2695, maxQuantity: 10, countsAsAdult: true,
        presaleOf: t.types.find((x) => x.code === "GENERAL")!.id, salesStartAt: pre!.sales_end_at.toISOString(), salesEndAt: new Date(pre!.sales_end_at.getTime() + 5 * 86_400_000).toISOString(),
      },
    });
    expect(next.status, JSON.stringify(next.body)).toBe(201);
    try {
      const page = await shop();
      const meta = page.locator(".type.is-deal .deal-meta");
      await expect.poll(() => meta.first().textContent()).toMatch(/Ensuite : 26,95\s\$/);
      // The phase still to come is not sold yet.
      expect(await page.getByRole("button", { name: "Ajouter Admission générale — Dernière chance", exact: true }).count()).toBe(0);
      if (shots) await page.locator(".type.is-deal").first().screenshot({ path: `${shots}/price-phase-next.png` });
    } finally {
      await db.pool.query(`UPDATE public.ticketing_ticket_types SET active = false WHERE code = 'GENERAL_PRE2'`);
    }
  });

  it("alkao.ca shows the presale on the event's card", async () => {
    const token = await tokenFor(seed.users.havanaOwner);
    expect((await call(app, "PUT", `${adm(t.clientId, t.brandId)}/appearance`, { token, body: { showOnAlkao: true } })).status).toBe(200);
    const context = await browser.newContext({ locale: "fr-CA", viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
    const page = await context.newPage();
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await page.goto(`${origin}/`);
    await page.locator(".grid .card .deal-ribbon").first().waitFor();
    expect(await page.locator(".grid .card .deal-ribbon").first().textContent()).toBe("Prévente −20 %");
    if (shots) await page.locator("#evenements").screenshot({ path: `${shots}/presale-home.png` });
    await context.close();
  });

  it("a coupon shared as a link is applied on arrival, on a phone too", async () => {
    const page = await shop("?coupon=prevente10", { width: 390, height: 844 });
    await page.getByText("Code PREVENTE10 appliqué").waitFor();
    await page.getByRole("button", { name: "Appliqué", exact: true, pressed: true }).waitFor();
    if (shots) await page.screenshot({ path: `${shots}/presale-shop-phone.png`, fullPage: true });
    expect(pageErrors).toEqual([]);
  });
});
