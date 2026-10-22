import { existsSync, mkdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CreateCheckoutInput } from "../../src/payments/gateway.js";
import { adm, call, stopServer, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { completedSession, FakeGateway, signedStripeEvent } from "../helpers/fake-gateway.js";
import { seedTwoTenants, TEST_CREDENTIAL_SECRET, type SeedResult, type TenantFixture } from "../helpers/seed.js";

/**
 * Run 98: a buyer picks a festival pass instead of a one-day ticket, sees the dates it covers,
 * pays, and finds every date on the ticket, in a real Chromium; Stripe is the fake gateway.
 * Screenshots go to ALKAO_SCREENSHOTS when it is set.
 */
const executablePath = process.env.ALKAO_CHROMIUM_PATH ?? (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
const shots = process.env.ALKAO_SCREENSHOTS;
const PUBLIC_URL = "https://billets.alkao.test";

let db: TestDatabase;
let seed: SeedResult;
let gateway: FakeGateway;
let app: TestApp;
let server: ServerType;
let origin: string;
let browser: Browser;
let t: TenantFixture;
const days: string[] = [];
const PASS = "Passe festival — 3 jours";
const pageErrors: string[] = [];

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  t = seed.havana;
  gateway = new FakeGateway();
  app = testApp(db.pool, { paymentGateway: gateway, credentialMasterSecret: TEST_CREDENTIAL_SECRET, publicUrl: PUBLIC_URL });
  server = await new Promise<ServerType>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), args: ["--no-sandbox"] });
  if (shots) mkdirSync(shots, { recursive: true });

  // A three-day festival, a pass for all three, set up as staff would.
  await db.pool.query(`UPDATE public.ticketing_sessions SET status = 'closed' WHERE event_id = $1`, [t.eventId]);
  for (const day of [20, 21, 22]) {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO public.ticketing_sessions (client_id, brand_id, event_id, starts_at, capacity, status)
       VALUES ($1, $2, $3, date_trunc('day', now()) + make_interval(days => $4, hours => 17), 30, 'on_sale') RETURNING id`,
      [t.clientId, t.brandId, t.eventId, day],
    );
    days.push(rows[0]!.id);
  }
  const token = await tokenFor(seed.users.havanaOwner);
  const made = await call(app, "POST", `${adm(t.clientId, t.brandId)}/events/${t.eventId}/ticket-types`, {
    token, body: { code: "FEST_PASS", name: PASS, priceCents: 7495, maxQuantity: 10, countsAsAdult: true, pass: true, sortOrder: 0 },
  });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await stopServer(server);
  await db?.drop();
});

async function shop(viewport = { width: 1280, height: 900 }): Promise<Page> {
  const context = await browser.newContext({ locale: "fr-CA", viewport });
  await context.route("https://checkout.stripe.com/**", (r) => r.fulfill({ contentType: "text/html", body: "<h1>Stripe (test)</h1>" }));
  const page = await context.newPage();
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(`${origin}/acheter/${t.clientId}/${t.brandId}/${t.eventId}`);
  await page.getByRole("heading", { level: 1 }).waitFor();
  return page;
}
const plus = (page: Page, name: string) => page.getByRole("button", { name: `Ajouter ${name}`, exact: true });

describe("Run 98: festival passes in the shop and on the tickets", () => {
  it("sells a pass for every date, and the ticket lists each one", async () => {
    const page = await shop();
    const modes = page.getByRole("group", { name: "Type de billet" });
    await modes.getByRole("button", { name: "Billet d'un jour", pressed: true }).waitFor();
    // One-day tickets do not show the pass, and the reverse.
    expect(await plus(page, PASS).count()).toBe(0);
    // The hero offers the pass; a click switches the panel to it.
    if (shots) await page.locator(".hero").screenshot({ path: `${shots}/pass-hero.png` });
    await page.getByRole("button", { name: /^Voir la passe festival — Les 3 dates, 74,95\s\$$/ }).click();
    await modes.getByRole("button", { name: "Passe festival", pressed: true }).waitFor();
    await modes.getByRole("button", { name: "Billet d'un jour" }).click();
    // Back on one-day tickets, a date is chosen first.
    await page.getByRole("heading", { name: /Choisissez votre séance/ }).waitFor();
    await modes.getByRole("button", { name: "Passe festival" }).click();
    await page.getByRole("heading", { name: /Les dates de la passe/ }).waitFor();
    expect(await page.locator(".pass-list li").count()).toBe(3);
    expect(await page.locator(".pass-note").textContent()).toMatch(/Une entrée par date, avec le même code QR\.\s*30 passes restantes/);
    expect(await page.getByRole("button", { name: "Ajouter Admission générale — 13 ans et +", exact: true }).count()).toBe(0);
    expect(await page.locator(".types .type").filter({ hasText: PASS }).textContent()).toMatch(/Valide 3 dates/);

    await plus(page, PASS).click();
    await plus(page, PASS).click();
    await page.getByRole("cell", { name: "Total" }).waitFor();
    if (shots) await page.screenshot({ path: `${shots}/pass-shop.png`, fullPage: true });
    await page.getByRole("button", { name: "Continuer" }).click();
    await page.getByLabel("Courriel (vos billets y seront envoyés)").fill("festivalier@example.com");
    await page.getByLabel("Nom complet").fill("Sam Tremblay");
    await page.getByRole("button", { name: /^Payer / }).click();
    await page.waitForURL(/checkout\.stripe\.com/);

    const input = gateway.callsOf("createCheckoutSession").at(-1) as CreateCheckoutInput;
    const e = signedStripeEvent("checkout.session.completed", completedSession(page.url().split("/").pop()!, input.amountTotalCents, "pi_pass_e2e"), t.stripeAccountId);
    expect((await call(app, "POST", "/v1/webhooks/stripe", { body: e.body, headers: { "stripe-signature": e.signature } })).body.outcome).toBe("processed");
    await page.goto(input.successUrl.replace(PUBLIC_URL, origin));
    await page.waitForURL(/\/billets#/);
    await page.getByRole("img", { name: /^Code QR du billet / }).first().waitFor();
    expect(await page.getByRole("img", { name: /^Code QR du billet / }).count()).toBe(2);

    // The ticket shows its first date on the stub, then the others, and how entry works.
    const ticket = page.locator(".slide.is-current .ticket");
    expect(await ticket.locator(".pass-days p").textContent()).toBe("Valide aussi");
    expect(await ticket.locator(".pass-days li").count()).toBe(2);
    expect(await ticket.locator(".pass-entry").textContent()).toBe("Une entrée par date avec le même code QR.");
    if (shots) await page.screenshot({ path: `${shots}/pass-tickets.png`, fullPage: true });

    // The order belongs to the first date; each date sold two seats.
    const { rows } = await db.pool.query<{ id: string; sold_count: number }>(
      `SELECT id, sold_count FROM public.ticketing_sessions WHERE id = ANY($1::uuid[])`, [days],
    );
    expect(rows.map((r) => r.sold_count)).toEqual([2, 2, 2]);
    const order = await db.pool.query(`SELECT session_id FROM public.ticketing_orders WHERE status = 'paid' AND session_id = ANY($1::uuid[])`, [days]);
    expect(order.rows).toEqual([{ session_id: days[0] }]);
  });

  it("an event selling only passes opens on the pass, on a phone too", async () => {
    await db.pool.query(`UPDATE public.ticketing_ticket_types SET active = false WHERE event_id = $1 AND kind = 'admission' AND NOT pass`, [t.eventId]);
    try {
      const page = await shop({ width: 390, height: 844 });
      await page.getByRole("heading", { name: /Les dates de la passe/ }).waitFor();
      expect(await page.getByRole("group", { name: "Type de billet" }).count()).toBe(0);
      expect(await page.locator(".hb-pass").count()).toBe(0);
      expect(await page.locator(".pass-note").textContent()).toMatch(/28 passes restantes/);
      await plus(page, PASS).click();
      await page.getByRole("cell", { name: "Total" }).waitFor();
      expect(await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")).toBe(true);
      if (shots) await page.screenshot({ path: `${shots}/pass-shop-phone.png`, fullPage: true });
    } finally {
      await db.pool.query(`UPDATE public.ticketing_ticket_types SET active = true WHERE event_id = $1 AND kind = 'admission'`, [t.eventId]);
    }
    expect(pageErrors).toEqual([]);
  });
});
