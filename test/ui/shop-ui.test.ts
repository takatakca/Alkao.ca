import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CreateCheckoutInput } from "../../src/payments/gateway.js";
import { call, testApp, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { completedSession, FakeGateway, signedStripeEvent } from "../helpers/fake-gateway.js";
import { seedTwoTenants, TEST_CREDENTIAL_SECRET, type SeedResult, type TenantFixture } from "../helpers/seed.js";

/** End-to-end: a buyer uses the hosted shop in a real Chromium; Stripe is the fake gateway. */
const executablePath = process.env.ALKAO_CHROMIUM_PATH ?? (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
const PUBLIC_URL = "https://billets.alkao.test";

let db: TestDatabase;
let seed: SeedResult;
let gateway: FakeGateway;
let app: TestApp;
let server: ServerType;
let origin: string;
let browser: Browser;
const pageErrors: string[] = [];

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  gateway = new FakeGateway();
  app = testApp(db.pool, { paymentGateway: gateway, credentialMasterSecret: TEST_CREDENTIAL_SECRET, publicUrl: PUBLIC_URL });
  server = await new Promise<ServerType>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), args: ["--no-sandbox"] });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await new Promise((r) => server?.close(r));
  await db?.drop();
});

async function session(t: TenantFixture, daysAhead: number) {
  const { rows } = await db.pool.query<{ id: string; starts_at: Date }>(
    `INSERT INTO public.ticketing_sessions (client_id, brand_id, event_id, starts_at, capacity, status)
     VALUES ($1, $2, $3, date_trunc('minute', now()) + make_interval(days => $4), 30, 'on_sale') RETURNING id, starts_at`,
    [t.clientId, t.brandId, t.eventId, daysAhead],
  );
  const label = new Intl.DateTimeFormat("fr-CA", { dateStyle: "full", timeStyle: "short", timeZone: "America/Toronto" }).format(rows[0]!.starts_at);
  return { id: rows[0]!.id, label };
}

async function shop(t: TenantFixture): Promise<Page> {
  const context = await browser.newContext({ locale: "fr-CA" });
  // The fake Stripe Checkout page.
  await context.route("https://checkout.stripe.com/**", (r) => r.fulfill({ contentType: "text/html", body: "<h1>Stripe (test)</h1>" }));
  const page = await context.newPage();
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(`${origin}/acheter/${t.clientId}/${t.brandId}/${t.eventId}`);
  await page.getByRole("heading", { level: 1 }).waitFor();
  return page;
}

const plus = (page: Page, name: string) => page.getByRole("button", { name: `Ajouter ${name}`, exact: true });
const local = (url: string) => url.replace(PUBLIC_URL, origin);

describe("hosted ticket shop", () => {
  it("sells paid tickets: session, quantities, server quote, hold, Stripe, then the buyer's QR codes", async () => {
    const f = seed.festi;
    const s = await session(f, 20);
    const page = await shop(f);
    expect(await page.getByText("FESTI-ICE", { exact: true }).isVisible()).toBe(true);
    await page.getByRole("button", { name: new RegExp(s.label) }).click();
    const general = f.types.find((x) => x.code === "GENERAL")!;
    await plus(page, general.name).click();
    await plus(page, general.name).click();
    await page.getByRole("cell", { name: "Total" }).waitFor();
    expect(await page.getByRole("cell", { name: "TPS" }).isVisible()).toBe(true);
    expect(await page.getByRole("cell", { name: "TVQ" }).isVisible()).toBe(true);
    await page.getByRole("button", { name: "Continuer" }).click();

    await page.getByText("Places réservées pendant", { exact: false }).waitFor();
    await page.getByLabel("Courriel (vos billets y seront envoyés)").fill("jade@example.com");
    await page.getByLabel("Nom complet").fill("Jade Gagnon");
    await page.getByRole("button", { name: /^Payer / }).click();
    await page.waitForURL(/checkout\.stripe\.com/);

    // Stripe confirms the payment, then sends the buyer back to the shop.
    const input = gateway.callsOf("createCheckoutSession").at(-1) as CreateCheckoutInput;
    expect(input.successUrl).toMatch(new RegExp(`^${PUBLIC_URL}/acheter/merci/${f.clientId}/${f.brandId}/[0-9a-f-]{36}$`));
    expect(input.customerEmail).toBe("jade@example.com");
    const sessionId = page.url().split("/").pop()!;
    const e = signedStripeEvent("checkout.session.completed", completedSession(sessionId, input.amountTotalCents, "pi_shop_e2e"), f.stripeAccountId);
    expect((await call(app, "POST", "/v1/webhooks/stripe", { body: e.body, headers: { "stripe-signature": e.signature } })).body.outcome).toBe("processed");

    await page.goto(local(input.successUrl));
    await page.waitForURL(/\/billets#/);
    await page.getByRole("img", { name: /^Code QR du billet / }).first().waitFor();
    expect(await page.getByRole("img", { name: /^Code QR du billet / }).count()).toBe(2);

    const { rows } = await db.pool.query(
      `SELECT o.status, o.total_cents, b.email FROM public.ticketing_orders o JOIN public.ticketing_buyers b ON b.id = o.buyer_id WHERE o.session_id = $1`,
      [s.id],
    );
    expect(rows).toEqual([{ status: "paid", total_cents: input.amountTotalCents, email: "jade@example.com" }]);
  });

  it("gives free tickets straight away", async () => {
    const h = seed.havana;
    const s = await session(h, 21);
    const page = await shop(h);
    await page.getByRole("button", { name: new RegExp(s.label) }).click();
    const toddler = h.types.find((x) => x.code === "TODDLER")!;
    await plus(page, toddler.name).click();
    await page.getByRole("cell", { name: "Total" }).waitFor();
    await page.getByRole("button", { name: "Continuer" }).click();
    await page.getByLabel("Courriel (vos billets y seront envoyés)").fill("bebe@example.com");
    await page.getByLabel("Nom complet").fill("Léa Roy");
    await page.getByRole("button", { name: "Obtenir mes billets" }).click();
    await page.waitForURL(/\/billets#/);
    await page.getByRole("img", { name: /^Code QR du billet / }).waitFor();
  });

  it("explains the cart rules in French and will not continue", async () => {
    const f = seed.festi;
    const s = await session(f, 22);
    const page = await shop(f);
    await page.getByRole("button", { name: new RegExp(s.label) }).click();
    const flex = f.types.find((x) => x.code === "FLEX_WEATHER")!;
    await plus(page, flex.name).click();
    await page.getByRole("alert").getByText("s'ajoute à une entrée", { exact: false }).waitFor();
    expect(await page.getByRole("button", { name: "Continuer" }).isDisabled()).toBe(true);
  });

  it("lets a buyer who left Stripe resume or free the seats", async () => {
    const f = seed.festi;
    const s = await session(f, 23);
    const page = await shop(f);
    await page.getByRole("button", { name: new RegExp(s.label) }).click();
    await plus(page, f.types.find((x) => x.code === "GENERAL")!.name).click();
    await page.getByRole("cell", { name: "Total" }).waitFor();
    await page.getByRole("button", { name: "Continuer" }).click();
    await page.getByLabel("Courriel (vos billets y seront envoyés)").fill("hesite@example.com");
    await page.getByLabel("Nom complet").fill("Paul Hésite");
    await page.getByRole("button", { name: /^Payer / }).click();
    await page.waitForURL(/checkout\.stripe\.com/);
    const input = gateway.callsOf("createCheckoutSession").at(-1) as CreateCheckoutInput;

    await page.goto(local(input.cancelUrl));
    await page.getByText("Paiement non terminé", { exact: false }).waitFor();
    await page.getByRole("button", { name: "Libérer mes places" }).click();
    await page.getByRole("button", { name: new RegExp(s.label) }).waitFor();
    const { rows } = await db.pool.query(`SELECT reserved_count, sold_count FROM public.ticketing_sessions WHERE id = $1`, [s.id]);
    expect(rows).toEqual([{ reserved_count: 0, sold_count: 0 }]);
  });

  it("says so when the organizer's ticketing is closed, and serves nothing for a malformed address", async () => {
    const h = seed.havana;
    await db.pool.query(`UPDATE public.ticketing_entitlements SET status = 'suspended' WHERE client_id = $1`, [h.clientId]);
    try {
      const page = await (await browser.newContext({ locale: "fr-CA" })).newPage();
      await page.goto(`${origin}/acheter/${h.clientId}/${h.brandId}/${h.eventId}`);
      await page.getByRole("alert").getByText("fermée pour le moment", { exact: false }).waitFor();
    } finally {
      await db.pool.query(`UPDATE public.ticketing_entitlements SET status = 'active' WHERE client_id = $1`, [h.clientId]);
    }
    expect((await fetch(`${origin}/acheter/havana/resort/patin`)).status).toBe(404);
    const res = await fetch(`${origin}/acheter/${h.clientId}/${h.brandId}`);
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
  });

  it("only accepts ALKAO's own shop or the Brand's sites as Stripe return pages", async () => {
    const f = seed.festi;
    const s = await session(f, 24);
    const general = f.types.find((x) => x.code === "GENERAL")!.id;
    const hold = await call(app, "POST", `/v1/public/clients/${f.clientId}/brands/${f.brandId}/holds`, { body: { sessionId: s.id, items: [{ ticketTypeId: general, quantity: 1 }] } });
    const attempt = (url: string) =>
      call(app, "POST", `/v1/public/clients/${f.clientId}/brands/${f.brandId}/holds/${hold.body.hold.id}/checkout`, {
        headers: { "x-alkao-hold-token": hold.body.hold.token },
        body: { buyer: { email: "a@example.com" }, successUrl: url, cancelUrl: url },
      });
    expect((await attempt("https://phishing.example/merci")).body.error.code).toBe("return_url_not_allowed");
    expect((await attempt(`${PUBLIC_URL}/acheter/merci/${f.clientId}/${f.brandId}/${hold.body.hold.id}`)).status).toBe(201);
  });

  it("ran without script errors", () => {
    expect(pageErrors).toEqual([]);
  });
});
