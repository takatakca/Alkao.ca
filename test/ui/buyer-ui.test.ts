import { existsSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { serve, type ServerType } from "@hono/node-server";
import { chromium, type Browser, type Page } from "playwright-core";
import qrcode from "qrcode-generator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, pub, testApp, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { completedSession, FakeGateway, signedStripeEvent } from "../helpers/fake-gateway.js";
import { seedTwoTenants, TEST_CREDENTIAL_SECRET, type SeedResult, type TenantFixture } from "../helpers/seed.js";

/** End-to-end: the buyer opens the link from their tickets email in a real Chromium. */
const executablePath = process.env.ALKAO_CHROMIUM_PATH ?? (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);

let db: TestDatabase;
let seed: SeedResult;
let app: TestApp;
let server: ServerType;
let origin: string;
let browser: Browser;
const pageErrors: string[] = [];

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  app = testApp(db.pool, { paymentGateway: new FakeGateway(), credentialMasterSecret: TEST_CREDENTIAL_SECRET });
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

const typeId = (t: TenantFixture, code: string) => t.types.find((x) => x.code === code)!.id;

// Each new session a quarter-hour after the previous one: the page labels sessions to the
// minute, and two at the same minute could not be told apart (a random minute sometimes did).
let sessionCount = 0;
async function session(t: TenantFixture) {
  sessionCount += 1;
  const { rows } = await db.pool.query<{ id: string }>(
    `INSERT INTO public.ticketing_sessions (client_id, brand_id, event_id, starts_at, capacity, status)
     VALUES ($1, $2, $3, date_trunc('minute', now()) + interval '12 days' + make_interval(mins => $4 * 15), 40, 'on_sale') RETURNING id`,
    [t.clientId, t.brandId, t.eventId, sessionCount],
  );
  return rows[0]!.id;
}

async function buy(t: TenantFixture, items: Record<string, number>) {
  const h = await call(app, "POST", `${pub(t.clientId, t.brandId)}/holds`, {
    body: { sessionId: await session(t), items: Object.entries(items).map(([code, quantity]) => ({ ticketTypeId: typeId(t, code), quantity })) },
  });
  const co = await call(app, "POST", `${pub(t.clientId, t.brandId)}/holds/${h.body.hold.id}/checkout`, {
    headers: { "x-alkao-hold-token": h.body.hold.token },
    body: { buyer: { email: "billets@example.com", fullName: "Jade Gagnon" }, successUrl: `${t.returnOrigin}/ok`, cancelUrl: `${t.returnOrigin}/ko` },
  });
  if (co.body.checkoutUrl) {
    const e = signedStripeEvent("checkout.session.completed", completedSession(co.body.checkoutUrl.split("/").pop(), h.body.hold.quote.totalCents, `pi_${randomUUID().slice(0, 8)}`), t.stripeAccountId);
    await call(app, "POST", "/v1/webhooks/stripe", { body: e.body, headers: { "stripe-signature": e.signature } });
  }
  return { orderId: co.body.order.id as string, token: co.body.order.token as string };
}

const linkFor = (t: TenantFixture, o: { orderId: string; token: string }) =>
  `${origin}/billets#${new URLSearchParams({ c: t.clientId, b: t.brandId, o: o.orderId, k: o.token })}`;

async function open(url: string): Promise<Page> {
  const page = await (await browser.newContext({ locale: "fr-CA" })).newPage();
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(url);
  return page;
}

function qrFor(payload: string) {
  const qr = qrcode(0, "M");
  qr.addData(payload);
  qr.make();
  return qr.createDataURL(8, 2);
}

describe("buyer tickets page", () => {
  it("is served with a strict policy and never indexed", async () => {
    const res = await fetch(`${origin}/billets`);
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("shows the event and one QR code per ticket, encoding exactly its credential", async () => {
    const f = seed.festi;
    const o = await buy(f, { GENERAL: 2 });
    const order = (await call(app, "GET", `${pub(f.clientId, f.brandId)}/orders/${o.orderId}`, { headers: { "x-alkao-order-token": o.token } })).body.order;
    const page = await open(linkFor(f, o));
    await page.getByRole("heading", { level: 1 }).waitFor();
    expect(await page.getByRole("heading", { level: 1 }).textContent()).toBe(order.event.title);
    expect(await page.getByText("FESTI-ICE", { exact: true }).isVisible()).toBe(true);
    const qrs = page.getByRole("img", { name: /^Code QR du billet / });
    expect(await qrs.count()).toBe(2);
    const srcs = await qrs.evaluateAll((els) => els.map((e) => e.getAttribute("src")));
    expect(srcs).toEqual(order.tickets.map((t: { credential: string }) => qrFor(t.credential)));
    expect(await page.getByRole("button", { name: "Voir les autres séances" }).count()).toBe(0);
  });

  it("offers the session as a calendar file, without the personal link (Run 31)", async () => {
    const f = seed.festi;
    const o = await buy(f, { GENERAL: 1 });
    const order = (await call(app, "GET", `${pub(f.clientId, f.brandId)}/orders/${o.orderId}`, { headers: { "x-alkao-order-token": o.token } })).body.order;
    const page = await open(linkFor(f, o));
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Ajouter à mon calendrier" }).click()]);
    expect(download.suggestedFilename()).toBe(`${order.reference}.ics`);
    const ics = readFileSync((await download.path())!, "utf8");
    const unfolded = ics.replace(/\r\n /g, "");
    expect(unfolded).toContain(`UID:${o.orderId}@alkao`);
    expect(unfolded).toContain(`DTSTART:${new Date(order.event.startsAt).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}`);
    expect(unfolded).toContain(`SUMMARY:${order.event.title}`);
    expect(unfolded).toContain(`Commande ${order.reference}`);
    expect(ics).not.toContain(o.token);
    expect(ics).not.toContain("/billets");
  });

  it("explains a wrong or incomplete link without revealing anything", async () => {
    const f = seed.festi;
    const o = await buy(f, { GENERAL: 1 });
    const wrong = await open(linkFor(f, { orderId: o.orderId, token: "x".repeat(43) }));
    await wrong.getByRole("alert").getByText("Ce lien n'est plus valide", { exact: false }).waitFor();
    expect(await wrong.getByRole("img").count()).toBe(0);
    // The right token under another Client's URL is refused too.
    const crossed = await open(linkFor(seed.havana, o));
    await crossed.getByRole("alert").waitFor();
    expect(await crossed.getByRole("img").count()).toBe(0);
    const incomplete = await open(`${origin}/billets`);
    await incomplete.getByRole("alert").getByText("Lien incomplet", { exact: false }).waitFor();
  });

  it("lets the buyer use Flex Météo once, then shows the new tickets", async () => {
    const f = seed.festi;
    const o = await buy(f, { GENERAL: 1, CHILD: 1, FLEX_WEATHER: 2 });
    const target = await session(f);
    const page = await open(linkFor(f, o));
    await page.getByRole("button", { name: "Voir les autres séances" }).click();
    page.on("dialog", (d) => void d.accept());
    const row = page.locator("ul.sessions li").filter({ has: page.getByRole("button", { name: "Choisir" }) });
    await row.first().waitFor();
    const { rows } = await db.pool.query<{ starts_at: Date }>(`SELECT starts_at FROM public.ticketing_sessions WHERE id = $1`, [target]);
    const label = new Intl.DateTimeFormat("fr-CA", { dateStyle: "full", timeStyle: "short", timeZone: "America/Toronto" }).format(rows[0]!.starts_at);
    await row.filter({ hasText: label }).getByRole("button", { name: "Choisir" }).click();
    await page.getByText("Changement de séance confirmé", { exact: false }).waitFor();
    expect(await page.getByRole("img", { name: /^Code QR du billet / }).count()).toBe(2);
    expect(await page.getByRole("button", { name: "Voir les autres séances" }).count()).toBe(0);

    const { rows: moved } = await db.pool.query(`SELECT session_id FROM public.ticketing_orders WHERE exchange_of_order_id = $1`, [o.orderId]);
    expect(moved).toEqual([{ session_id: target }]);
    // The original link now explains that its tickets were replaced.
    const before = await open(linkFor(f, o));
    await before.getByText("Ces billets ont été remplacés", { exact: false }).waitFor();
    expect(await before.getByRole("img", { name: /^Code QR du billet / }).count()).toBe(0);
  });

  it("offers an open-date ticket a change of date as often as needed (Run 37)", async () => {
    const f = seed.festi;
    await db.pool.query(`UPDATE public.ticketing_ticket_types SET open_date = true WHERE event_id = $1 AND code = 'OPEN_DATE'`, [f.eventId]);
    const o = await buy(f, { OPEN_DATE: 1 });
    const page = await open(linkFor(f, o));
    await page.getByRole("heading", { name: "Changer de date (billet ouvert)" }).waitFor();
    expect(await page.getByText("Votre billet ouvert peut changer de date autant de fois que nécessaire", { exact: false }).isVisible()).toBe(true);
  });

  it("wears the Brand's look and shows one large code at a time at the gate (Run 50)", async () => {
    const h = seed.havana;
    await db.pool.query(
      `INSERT INTO public.ticketing_brand_settings (client_id, brand_id, logo_url, accent_color, on_accent_color, website_url, support_phone)
       VALUES ($1, $2, 'https://cdn.example.com/logo.svg', '#0f766e', '#ffffff', 'https://www.example.com/', '+1 514 555-0100')
       ON CONFLICT (client_id, brand_id) DO UPDATE SET logo_url = EXCLUDED.logo_url, accent_color = EXCLUDED.accent_color,
         on_accent_color = EXCLUDED.on_accent_color, website_url = EXCLUDED.website_url, support_phone = EXCLUDED.support_phone`,
      [h.clientId, h.brandId],
    );
    await db.pool.query(`UPDATE public.ticketing_events SET image_url = 'https://cdn.example.com/photo.svg' WHERE id = $1`, [h.eventId]);
    const o = await buy(h, { GENERAL: 2 });
    const context = await browser.newContext({ locale: "fr-CA" });
    // The Brand's images, served locally: no request leaves the test.
    await context.route("https://cdn.example.com/**", (r) =>
      r.fulfill({ contentType: "image/svg+xml", body: `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="40"><rect width="160" height="40" fill="#fff"/></svg>` }));
    const page = await context.newPage();
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await page.goto(linkFor(h, o));
    await page.getByRole("img", { name: "Havana Resort — Événements" }).waitFor();
    const bg = (selector: string) => page.locator(selector).first().evaluate((e) => (globalThis as any).getComputedStyle(e).backgroundColor as string);
    expect(await bg(".top")).toBe("rgb(15, 118, 110)");
    expect(await bg(".ticket-band")).toBe("rgb(15, 118, 110)");
    expect(await page.locator("img.photo").getAttribute("src")).toBe("https://cdn.example.com/photo.svg");
    expect(await page.getByRole("link", { name: "+1 514 555-0100" }).getAttribute("href")).toBe("tel:+15145550100");
    expect(await page.getByRole("link", { name: "www.example.com" }).getAttribute("href")).toBe("https://www.example.com/");
    expect(await page.getByText("Billet 2 sur 2").count()).toBe(1);

    await page.getByRole("button", { name: "Plein écran pour l'entrée" }).first().click();
    const gate = page.getByRole("dialog", { name: "Billet 1 sur 2" });
    await gate.waitFor();
    expect(await gate.getByRole("img", { name: /^Code QR du billet / }).count()).toBe(1);
    expect(await gate.getByRole("button", { name: "Billet précédent" }).isDisabled()).toBe(true);
    await page.keyboard.press("ArrowRight");
    await page.getByRole("dialog", { name: "Billet 2 sur 2" }).waitFor();
    expect(await page.getByRole("button", { name: "Billet suivant" }).isDisabled()).toBe(true);
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "detached" });
  });

  it("keeps the Brand's name when its logo cannot be shown (Run 50)", async () => {
    const h = seed.havana;
    const o = await buy(h, { GENERAL: 1 });
    const context = await browser.newContext({ locale: "fr-CA" });
    await context.route("https://cdn.example.com/**", (r) => r.fulfill({ status: 404, body: "" }));
    const page = await context.newPage();
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await page.goto(linkFor(h, o));
    await page.locator(".top .brand", { hasText: "Havana Resort — Événements" }).waitFor();
    await page.locator("img.photo").waitFor({ state: "hidden" });
  });

  it("opens the tickets without a network once they were seen on this device (Run 51)", async () => {
    const sw = await fetch(`${origin}/billets/sw.js`);
    expect(sw.headers.get("service-worker-allowed")).toBe("/billets");
    expect(sw.headers.get("content-type")).toContain("javascript");

    const f = seed.festi;
    const o = await buy(f, { GENERAL: 2 });
    // Its own server, stopped halfway: the phone then has no network at all.
    const own = await new Promise<ServerType>((resolve) => {
      const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
    });
    const ownOrigin = `http://127.0.0.1:${(own.address() as AddressInfo).port}`;
    const at = (k: string) => `${ownOrigin}/billets#${new URLSearchParams({ c: f.clientId, b: f.brandId, o: o.orderId, k })}`;
    const context = await browser.newContext({ locale: "fr-CA" });
    const page = await context.newPage();
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await page.goto(at(o.token));
    await page.getByText("Billets enregistrés sur cet appareil", { exact: false }).waitFor();
    await page.waitForFunction(() => Boolean((globalThis as any).navigator.serviceWorker.controller));

    await new Promise((r) => { own.close(r); (own as unknown as { closeAllConnections?: () => void }).closeAllConnections?.(); });
    await page.reload();
    await page.getByText("Hors ligne : voici vos billets", { exact: false }).waitFor();
    expect(await page.getByRole("img", { name: /^Code QR du billet / }).count()).toBe(2);
    await page.getByRole("button", { name: "Plein écran pour l'entrée" }).first().click();
    await page.getByRole("dialog", { name: "Billet 1 sur 2" }).waitFor();

    // Another link to the same order shows nothing kept on this device.
    const other = await context.newPage();
    other.on("pageerror", (e) => pageErrors.push(e.message));
    await other.goto(at("x".repeat(43)));
    await other.getByRole("alert").getByText("Pas de réseau", { exact: false }).waitFor();
    expect(await other.getByRole("img", { name: /^Code QR du billet / }).count()).toBe(0);
    await context.close();
  });

  it("keeps nothing on a door-sale device (Run 51)", async () => {
    const f = seed.festi;
    const o = await buy(f, { GENERAL: 1 });
    const page = await open(`${linkFor(f, o)}&porte=1`);
    await page.getByRole("img", { name: /^Code QR du billet / }).waitFor();
    expect(await page.getByText("Billets enregistrés sur cet appareil", { exact: false }).count()).toBe(0);
    expect(await page.evaluate(() => Object.keys((globalThis as any).localStorage).filter((k) => k.startsWith("alkao.billets.")))).toEqual([]);
  });

  it("ran without script errors", () => {
    expect(pageErrors).toEqual([]);
  });
});
