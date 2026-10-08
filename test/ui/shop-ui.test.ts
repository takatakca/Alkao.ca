import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CreateCheckoutInput } from "../../src/payments/gateway.js";
import { call, testApp, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { completedSession, FakeGateway, signedStripeEvent } from "../helpers/fake-gateway.js";
import { seedPaidOrder, seedTwoTenants, TEST_CREDENTIAL_SECRET, type SeedResult, type TenantFixture } from "../helpers/seed.js";

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

  it("puts a buy button on a Brand's own website", async () => {
    const f = seed.festi;
    const res = await fetch(`${origin}/widget.js`);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    const page = await (await browser.newContext({ locale: "fr-CA" })).newPage();
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await page.setContent(`<!doctype html><title>festi-ice.ca</title><main>
      <p>Billets en vente</p>
      <script src="${origin}/widget.js" data-client="${f.clientId}" data-brand="${f.brandId}" data-event="${f.eventId}" data-label="Réserver ma place"></script>
      <script src="${origin}/widget.js" data-client="festi" data-brand="${f.brandId}"></script>
    </main>`);
    const button = page.getByRole("link", { name: "Réserver ma place" });
    await button.waitFor();
    expect(await button.getAttribute("href")).toBe(`${origin}/acheter/${f.clientId}/${f.brandId}/${f.eventId}`);
    expect(await page.locator("a.alkao-buy").count()).toBe(1); // the malformed tag adds nothing
    await button.click();
    await page.waitForURL(`${origin}/acheter/${f.clientId}/${f.brandId}/${f.eventId}`);
    await page.getByRole("heading", { level: 1 }).waitFor();
  });

  it("serves English buyers in English, from the shop to their tickets (Run 16)", async () => {
    const h = seed.havana;
    const s = await session(h, 25);
    const context = await browser.newContext({ locale: "en-US" });
    const page = await context.newPage();
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await page.goto(`${origin}/acheter/${h.clientId}/${h.brandId}/${h.eventId}`);
    await page.getByRole("heading", { name: "1. Choose your session" }).waitFor();
    const label = new Intl.DateTimeFormat("en-CA", { dateStyle: "full", timeStyle: "short", timeZone: "America/Toronto" }).format(
      (await db.pool.query(`SELECT starts_at FROM public.ticketing_sessions WHERE id = $1`, [s.id])).rows[0].starts_at,
    );
    await page.getByRole("button", { name: new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).click();
    const toddler = h.types.find((x) => x.code === "TODDLER")!;
    await page.getByRole("button", { name: `Add ${toddler.name}`, exact: true }).click();
    await page.getByRole("cell", { name: "Total" }).waitFor();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByLabel("Email (your tickets will be sent there)").fill("tourist@example.com");
    await page.getByLabel("Full name").fill("Sam Tourist");
    await page.getByRole("button", { name: "Get my tickets" }).click();
    await page.waitForURL(/\/billets#/);
    await page.getByText("Show each ticket's QR code at the entrance", { exact: false }).waitFor();
    expect(await page.getByRole("img", { name: /^QR code of ticket / }).count()).toBe(1);
    const { rows } = await db.pool.query(`SELECT language FROM public.ticketing_buyers WHERE email = 'tourist@example.com'`);
    expect(rows).toEqual([{ language: "en" }]);

    // The switch goes back to French, and ?lang= wins over the browser.
    await page.getByRole("button", { name: "Français" }).click();
    await page.getByText("Présentez le code QR de chaque billet", { exact: false }).waitFor();
    const forced = await context.newPage();
    await forced.goto(`${origin}/acheter/${h.clientId}/${h.brandId}/${h.eventId}?lang=en`);
    await forced.getByRole("heading", { name: "1. Choose your session" }).waitFor();
  });

  it("puts an English buy button on a Brand's site with data-lang", async () => {
    const f = seed.festi;
    const page = await (await browser.newContext({ locale: "fr-CA" })).newPage();
    await page.setContent(`<!doctype html><script src="${origin}/widget.js" data-client="${f.clientId}" data-brand="${f.brandId}" data-lang="en"></script>`);
    const button = page.getByRole("link", { name: "Buy tickets" });
    await button.waitFor();
    expect(await button.getAttribute("href")).toBe(`${origin}/acheter/${f.clientId}/${f.brandId}?lang=en`);
  });

  it("sends a buyer's tickets again from the shop, without saying whether the address bought (Run 27)", async () => {
    const t = seed.havana;
    await seedPaidOrder(db.pool, t, "retrouve@example.com");
    await db.pool.query(`UPDATE public.ticketing_email_outbox SET status = 'sent', sent_at = now() WHERE status = 'pending'`);
    const page = await shop(t);
    await page.getByRole("heading", { name: "Vous avez déjà acheté ? Retrouvez vos billets" }).waitFor();
    await page.getByLabel("Le courriel utilisé pour l'achat").fill("retrouve@example.com");
    await page.getByRole("button", { name: "Renvoyer mes billets" }).click();
    await page.getByRole("status").getByText("Si une commande à venir correspond à cette adresse", { exact: false }).waitFor();
    const { rows } = await db.pool.query(
      `SELECT x.status FROM public.ticketing_email_outbox x JOIN public.ticketing_orders o ON o.id = x.order_id
       JOIN public.ticketing_buyers b ON b.id = o.buyer_id WHERE b.email = 'retrouve@example.com'`,
    );
    expect(rows).toEqual([{ status: "pending" }]);
  });

  it("takes a promo code before taxes and explains a wrong one (Run 36)", async () => {
    const f = seed.festi;
    await db.pool.query(
      `INSERT INTO public.ticketing_promo_codes (client_id, brand_id, event_id, code, kind, percent) VALUES ($1, $2, $3, 'HIVER25', 'percent', 25)`,
      [f.clientId, f.brandId, f.eventId],
    );
    const s = await session(f, 21);
    const page = await shop(f);
    await page.getByRole("button", { name: new RegExp(s.label) }).click();
    await plus(page, f.types.find((x) => x.code === "GENERAL")!.name).click();
    await page.getByRole("cell", { name: "Total" }).waitFor();
    await page.getByLabel("Code promo").fill("pasbon");
    await page.getByRole("button", { name: "Appliquer" }).click();
    await page.getByRole("alert").getByText("Ce code n'existe pas pour cet événement.").waitFor();
    await page.getByLabel("Code promo").fill("hiver25");
    await page.getByRole("button", { name: "Appliquer" }).click();
    await page.getByRole("cell", { name: "Rabais (HIVER25)" }).waitFor();
    await page.getByRole("button", { name: "Continuer" }).click();
    await page.getByText("Places réservées pendant", { exact: false }).waitFor();
    expect(await page.getByRole("cell", { name: "Rabais (HIVER25)" }).isVisible()).toBe(true);
    const { rows } = await db.pool.query(`SELECT promo_code_id IS NOT NULL AS coded FROM public.ticketing_holds WHERE session_id = $1`, [s.id]);
    expect(rows).toEqual([{ coded: true }]);
  });

  // Run 35: at the door, today's sessions only; the tickets show right after payment.
  // (Skipped in the last minutes of a Montréal day, when "in 10 minutes" is already tomorrow.)
  const lateNight = Number(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date()).replace(":", "")) >= 2345;
  it.skipIf(lateNight)("sells at the door: today's sessions only, card through Stripe, tickets on screen, then the next sale (Run 35)", async () => {
    const f = seed.festi;
    const { rows } = await db.pool.query<{ id: string; starts_at: Date }>(
      `INSERT INTO public.ticketing_sessions (client_id, brand_id, event_id, starts_at, capacity, status)
       VALUES ($1, $2, $3, date_trunc('minute', now()) + interval '10 minutes', 30, 'on_sale') RETURNING id, starts_at`,
      [f.clientId, f.brandId, f.eventId],
    );
    const tonight = new Intl.DateTimeFormat("fr-CA", { dateStyle: "full", timeStyle: "short", timeZone: "America/Toronto" }).format(rows[0]!.starts_at);
    const later = await session(f, 3);

    const context = await browser.newContext({ locale: "fr-CA" });
    await context.route("https://checkout.stripe.com/**", (r) => r.fulfill({ contentType: "text/html", body: "<h1>Stripe (test)</h1>" }));
    const page = await context.newPage();
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await page.goto(`${origin}/acheter/${f.clientId}/${f.brandId}/${f.eventId}?porte=1`);
    await page.getByRole("heading", { level: 1 }).waitFor();
    expect(await page.getByText("Vente à la porte", { exact: true }).isVisible()).toBe(true);
    expect(await page.getByRole("button", { name: new RegExp(tonight) }).count()).toBe(1);
    expect(await page.getByRole("button", { name: new RegExp(later.label) }).count()).toBe(0);
    expect(await page.getByRole("heading", { name: /Retrouvez vos billets/ }).count()).toBe(0);

    await page.getByRole("button", { name: new RegExp(tonight) }).click();
    await plus(page, f.types.find((x) => x.code === "GENERAL")!.name).click();
    await page.getByRole("cell", { name: "Total" }).waitFor();
    await page.getByRole("button", { name: "Continuer" }).click();
    await page.getByLabel("Courriel (vos billets y seront envoyés)").fill("porte@example.com");
    await page.getByLabel("Nom complet").fill("Client Porte");
    await page.getByRole("button", { name: /^Payer / }).click();
    await page.waitForURL(/checkout\.stripe\.com/);

    // The same Stripe payment as online, so the same TAKATAK commission.
    const input = gateway.callsOf("createCheckoutSession").at(-1) as CreateCheckoutInput;
    expect(input.cancelUrl).toMatch(/\?porte=1#annule=/);
    expect(input.applicationFeeCents).toBeGreaterThan(0);
    const e = signedStripeEvent("checkout.session.completed", completedSession(page.url().split("/").pop()!, input.amountTotalCents, "pi_door_e2e"), f.stripeAccountId);
    expect((await call(app, "POST", "/v1/webhooks/stripe", { body: e.body, headers: { "stripe-signature": e.signature } })).body.outcome).toBe("processed");

    await page.goto(local(input.successUrl));
    await page.waitForURL(/\/billets#.*porte=1/);
    await page.getByRole("img", { name: /^Code QR du billet / }).first().waitFor();
    await page.getByRole("link", { name: "Nouvelle vente à la porte" }).click();
    await page.waitForURL(new RegExp(`/acheter/${f.clientId}/${f.brandId}/${f.eventId}\\?porte=1$`));
    await page.getByText("Vente à la porte", { exact: true }).waitFor();
  });

  it("sells in the Brand's look: logo, colour and the event's photo (Run 50)", async () => {
    const accent = () => {
      const g = globalThis as any;
      return String(g.getComputedStyle(g.document.documentElement).getPropertyValue("--accent")).trim();
    };
    const h = seed.havana;
    await db.pool.query(
      `INSERT INTO public.ticketing_brand_settings (client_id, brand_id, logo_url, accent_color, on_accent_color)
       VALUES ($1, $2, 'https://cdn.example.com/logo.svg', '#0f766e', '#ffffff')
       ON CONFLICT (client_id, brand_id) DO UPDATE SET logo_url = EXCLUDED.logo_url, accent_color = EXCLUDED.accent_color, on_accent_color = EXCLUDED.on_accent_color`,
      [h.clientId, h.brandId],
    );
    await db.pool.query(`UPDATE public.ticketing_events SET image_url = 'https://cdn.example.com/photo.svg' WHERE id = $1`, [h.eventId]);
    const context = await browser.newContext({ locale: "fr-CA" });
    await context.route("https://cdn.example.com/**", (r) =>
      r.fulfill({ contentType: "image/svg+xml", body: `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="40"><rect width="160" height="40" fill="#fff"/></svg>` }));
    const page = await context.newPage();
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await page.goto(`${origin}/acheter/${h.clientId}/${h.brandId}/${h.eventId}`);
    await page.getByRole("img", { name: "Havana Resort — Événements" }).waitFor();
    expect(await page.locator("img.photo").getAttribute("src")).toBe("https://cdn.example.com/photo.svg");
    expect(await page.evaluate(accent)).toBe("#0f766e");
    // FESTI-ICE keeps its own (neutral) look.
    const other = await shop(seed.festi);
    expect(await other.evaluate(accent)).not.toBe("#0f766e");
    expect(await other.locator("img.photo").count()).toBe(0);
  });

  it("ran without script errors", () => {
    expect(pageErrors).toEqual([]);
  });
});
