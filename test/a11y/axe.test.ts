import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { serve, type ServerType } from "@hono/node-server";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, pub, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { FakeGateway } from "../helpers/fake-gateway.js";
import { seedAfterSale, seedTwoTenants, TEST_CREDENTIAL_SECRET, type SeedResult } from "../helpers/seed.js";

/**
 * Accessibility (Run 17): axe-core (WCAG 2.1 A and AA rules) on every buyer and staff page,
 * in the states people actually see. Light and dark colour schemes are both checked.
 */
const executablePath = process.env.ALKAO_CHROMIUM_PATH ?? (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
const AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

let db: TestDatabase;
let seed: SeedResult;
let app: TestApp;
let server: ServerType;
let origin: string;
let browser: Browser;

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  // Run 19: the dispute and outside-refund notices are part of the audited pages.
  await seedAfterSale(db.pool, seed.havana, seed.havana.orderId);
  // Run 32: in Stripe test mode, so the test-mode banner and badge are audited on every page.
  app = testApp(db.pool, { paymentGateway: new FakeGateway(), credentialMasterSecret: TEST_CREDENTIAL_SECRET, publicUrl: "https://billets.alkao.test", paymentsMode: "test" });
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

interface Finding { id: string; impact: string | null; help: string; nodes: string[] }

/** Run axe in the page (evaluated through the devtools protocol, so the page's CSP stays strict). */
async function audit(page: Page): Promise<Finding[]> {
  await page.evaluate(AXE);
  const result = await page.evaluate(async () => {
    const axe = (globalThis as any).axe;
    const r = await axe.run((globalThis as any).document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } });
    return r.violations.map((v: any) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 5).map((n: any) => n.target.join(" ")) }));
  });
  return result as Finding[];
}

async function pageFor(scheme: "light" | "dark", init?: (page: Page) => Promise<void>) {
  const context = await browser.newContext({ locale: "fr-CA", colorScheme: scheme });
  const page = await context.newPage();
  if (init) await init(page);
  return page;
}

async function signedIn(scheme: "light" | "dark", userId: string) {
  const token = await tokenFor(userId, { expiresIn: "30m" });
  const context = await browser.newContext({ locale: "fr-CA", colorScheme: scheme });
  await context.addInitScript((t) => {
    sessionStorage.setItem("alkao.ops.session", JSON.stringify({ accessToken: t, refreshToken: null, expiresAt: Date.now() + 1_800_000, email: "ops@example.com" }));
  }, token);
  return context.newPage();
}

async function freeOrderLink() {
  const h = seed.havana;
  const { rows } = await db.pool.query<{ id: string }>(
    `INSERT INTO public.ticketing_sessions (client_id, brand_id, event_id, starts_at, capacity, status)
     VALUES ($1, $2, $3, now() + interval '9 days' + (random() * interval '1 hour'), 20, 'on_sale') RETURNING id`,
    [h.clientId, h.brandId, h.eventId],
  );
  const toddler = h.types.find((t) => t.code === "TODDLER")!.id;
  const hold = await call(app, "POST", `${pub(h.clientId, h.brandId)}/holds`, { body: { sessionId: rows[0]!.id, items: [{ ticketTypeId: toddler, quantity: 1 }] } });
  const co = await call(app, "POST", `${pub(h.clientId, h.brandId)}/holds/${hold.body.hold.id}/checkout`, {
    headers: { "x-alkao-hold-token": hold.body.hold.token },
    body: { buyer: { email: `a11y${randomUUID().slice(0, 6)}@example.com`, fullName: "Ana Lys" }, successUrl: `${h.returnOrigin}/ok`, cancelUrl: `${h.returnOrigin}/ko` },
  });
  return { sessionId: rows[0]!.id, url: `${origin}/billets#${new URLSearchParams({ c: h.clientId, b: h.brandId, o: co.body.order.id, k: co.body.order.token })}` };
}

const report = (where: string, findings: Finding[]) =>
  findings.map((f) => `${where}: ${f.id} (${f.impact}) ${f.help} → ${f.nodes.join(" | ")}`);

describe.each(["light", "dark"] as const)("accessibility (%s)", (scheme) => {
  it("buyer pages: shop, checkout form, tickets", async () => {
    const h = seed.havana;
    const problems: string[] = [];
    const shop = await pageFor(scheme);
    await shop.goto(`${origin}/acheter/${h.clientId}/${h.brandId}`);
    await shop.getByRole("heading", { level: 1 }).waitFor();
    problems.push(...report("events list", await audit(shop)));

    const { url } = await freeOrderLink();
    await shop.goto(`${origin}/acheter/${h.clientId}/${h.brandId}/${h.eventId}`);
    await shop.getByRole("heading", { level: 1 }).waitFor();
    problems.push(...report("event", await audit(shop)));
    await shop.locator("button.session:not([disabled])").first().click();
    const toddler = h.types.find((t) => t.code === "TODDLER")!;
    await shop.getByRole("button", { name: `Ajouter ${toddler.name}`, exact: true }).click();
    await shop.getByRole("cell", { name: "Total" }).waitFor();
    problems.push(...report("quantities and quote", await audit(shop)));
    await shop.getByRole("button", { name: "Continuer" }).click();
    await shop.getByLabel("Nom complet").waitFor();
    problems.push(...report("buyer form", await audit(shop)));

    const tickets = await pageFor(scheme);
    await tickets.goto(url);
    await tickets.getByRole("img", { name: /^Code QR du billet / }).waitFor();
    problems.push(...report("tickets", await audit(tickets)));

    // Run 35: the door-sale shop and the tickets page with its "next sale" button.
    await shop.goto(`${origin}/acheter/${h.clientId}/${h.brandId}/${h.eventId}?porte=1`);
    await shop.getByText("Vente à la porte", { exact: true }).waitFor();
    problems.push(...report("door sale", await audit(shop)));
    await tickets.goto(`${url}&porte=1`);
    await tickets.reload(); // only the fragment changed
    await tickets.getByRole("link", { name: "Nouvelle vente à la porte" }).waitFor();
    problems.push(...report("tickets after a door sale", await audit(tickets)));
    expect(problems).toEqual([]);
  }, 60_000);

  it("staff pages: sign-in, workspaces, dashboard, event, orders, order, scanner, payments, journal", async () => {
    const h = seed.havana;
    const prefix = `/c/${h.clientId}/b/${h.brandId}`;
    const problems: string[] = [];
    const login = await pageFor(scheme);
    await login.goto(`${origin}/ops`);
    await login.getByRole("button", { name: "Se connecter" }).waitFor();
    problems.push(...report("sign-in", await audit(login)));

    const page = await signedIn(scheme, seed.users.havanaOwner);
    const visit = async (hash: string, ready: () => Promise<unknown>, name: string) => {
      await page.goto(`${origin}/ops#${hash}`);
      await ready();
      problems.push(...report(name, await audit(page)));
    };
    await visit("/", () => page.getByRole("heading", { name: "Choisir un espace" }).waitFor(), "workspaces");
    await visit(`${prefix}/dashboard`, () => page.getByRole("heading", { name: "Tableau de bord" }).waitFor(), "dashboard");
    await visit(`${prefix}/events`, () => page.getByRole("heading", { name: "Événements" }).waitFor(), "events");
    await visit(`${prefix}/event/${h.eventId}`, () => page.getByRole("heading", { name: "Vendre en ligne" }).waitFor(), "event");
    await visit(`${prefix}/venues`, () => page.getByRole("heading", { name: "Lieux" }).waitFor(), "venues");
    await visit(`${prefix}/orders`, () => page.getByRole("heading", { name: "Commandes" }).waitFor(), "orders");
    await visit(`${prefix}/order/${h.orderId}`, () => page.getByRole("heading", { name: "Courriel des billets" }).waitFor(), "order");
    await visit(`${prefix}/scanner`, () => page.getByRole("heading", { name: "Scanner" }).waitFor(), "scanner");
    await visit(`${prefix}/payments`, () => page.getByRole("heading", { name: "Paiements (Stripe)" }).waitFor(), "payments");
    await visit(`${prefix}/journal`, () => page.getByRole("cell", { name: "Commande payée" }).first().waitFor(), "journal");
    // Run 41: the customer file, with one customer in every frequency colour.
    const customerId = await seedCustomers(h.clientId, h.brandId);
    await visit(`${prefix}/customers`, () => page.getByRole("heading", { name: "Par fréquence" }).waitFor(), "customers");
    await visit(`${prefix}/customer/${customerId}`, () => page.getByRole("heading", { name: "Réservations" }).waitFor(), "customer");
    expect(problems).toEqual([]);
  }, 90_000);
});

/** Made-up customers with 5, 3, 2, 1 and 0 visits (one upcoming, one cancelled); once per database. */
async function seedCustomers(clientId: string, brandId: string): Promise<string> {
  const { rows: done } = await db.pool.query<{ id: string }>(`SELECT id FROM public.ticketing_customers WHERE client_id = $1 AND email = 'axe-5@example.com'`, [clientId]);
  if (done[0]) return done[0].id;
  let first = "";
  for (const [n, visits, extra] of [[5, 5, ""], [3, 3, ""], [2, 2, ""], [1, 1, ""], [0, 0, "upcoming"], [9, 0, "cancelled"]] as const) {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO public.ticketing_customers (client_id, brand_id, first_name, last_name, email, mobile_phone, city, region, country)
       VALUES ($1, $2, 'Client', $3, $4, '5145550100', 'Maricourt', 'QC', 'CA') RETURNING id`,
      [clientId, brandId, `Exemple ${n}`, `axe-${n}@example.com`],
    );
    first ||= rows[0]!.id;
    const stays = Array.from({ length: visits }, (_, i) => [`${2020 + i}-07-01`, `${2020 + i}-07-03`]);
    if (extra) stays.push(["2099-07-01", "2099-07-03"]);
    for (const [i, [from, to]] of stays.entries()) {
      await db.pool.query(
        `INSERT INTO public.ticketing_customer_bookings (client_id, brand_id, customer_id, source, source_ref, category, item, starts_on, ends_on, first_report_on, last_report_on, cancelled_on, total_cents)
         VALUES ($1, $2, $3, 'reservation_camping', $4, 'chalet', 'CHALET 5', $5, $6, '2020-01-01', '2020-01-01', $7, 25000)`,
        [clientId, brandId, rows[0]!.id, `AXE-${n}-${i}`, from, to, extra === "cancelled" ? "2020-01-02" : null],
      );
    }
  }
  return first;
}
