import { existsSync, mkdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adm, call, pub, stopServer, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { seedTwoTenants, TEST_CREDENTIAL_SECRET, type SeedResult, type TenantFixture } from "../helpers/seed.js";

/**
 * Run 105: the return offer, as a buyer sees it on the tickets page and as staff choose it in
 * /ops, in a real Chromium. Screenshots go to ALKAO_SCREENSHOTS when it is set.
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
let nextEventId = "";
const pageErrors: string[] = [];

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  t = seed.havana;
  app = testApp(db.pool, { credentialMasterSecret: TEST_CREDENTIAL_SECRET });
  server = await new Promise<ServerType>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), args: ["--no-sandbox"] });
  if (shots) mkdirSync(shots, { recursive: true });
  const { rows } = await db.pool.query<{ id: string }>(
    `INSERT INTO public.ticketing_events (client_id, brand_id, venue_id, slug, title, status)
     SELECT client_id, brand_id, venue_id, 'festival-hiver-ui', 'Festival d''hiver', 'published' FROM public.ticketing_events WHERE id = $1 RETURNING id`,
    [t.eventId],
  );
  nextEventId = rows[0]!.id;
  await db.pool.query(
    `INSERT INTO public.ticketing_sessions (client_id, brand_id, event_id, starts_at, capacity, status) VALUES ($1, $2, $3, now() + interval '60 days', 500, 'on_sale')`,
    [t.clientId, t.brandId, nextEventId],
  );
  const made = await call(app, "POST", `${adm(t.clientId, t.brandId)}/events/${nextEventId}/promo-codes`, {
    token: await tokenFor(seed.users.havanaOwner), body: { code: "RETOUR15", kind: "percent", percent: 15, endsAt: new Date(Date.now() + 45 * 86_400_000).toISOString() },
  });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await stopServer(server);
  await db?.drop();
});

describe("Run 105: the return offer in the browser", () => {
  it("staff choose the code in /ops, among the Brand's codes", async () => {
    const token = await tokenFor(seed.users.havanaOwner, { expiresIn: "30m" });
    const context = await browser.newContext({ locale: "fr-CA", viewport: { width: 1280, height: 900 } });
    await context.addInitScript((tk) => {
      sessionStorage.setItem("alkao.ops.session", JSON.stringify({ accessToken: tk, refreshToken: null, expiresAt: Date.now() + 1_800_000, email: "ops@example.com" }));
    }, token);
    const page = await context.newPage();
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await page.goto(`${origin}/ops#/c/${t.clientId}/b/${t.brandId}/event/${t.eventId}`);
    const form = page.getByRole("form", { name: "Offre de retour" });
    await form.waitFor();
    await form.getByText("Aucune offre n'est montrée.").waitFor();
    await form.getByLabel("Code offert").selectOption({ label: "RETOUR15 — Festival d'hiver (−15 %)" });
    await form.getByRole("button", { name: "Enregistrer" }).click();
    await form.getByText("Montré aux acheteurs : −15 % sur Festival d'hiver avec le code RETOUR15.").waitFor();
    if (shots) await form.screenshot({ path: `${shots}/return-offer-ops.png` });
    await context.close();
  });

  it("a buyer sees it on the tickets page, and its button opens the next event with the code", async () => {
    const toddler = t.types.find((x) => x.code === "TODDLER")!;
    const h = await call(app, "POST", `${pub(t.clientId, t.brandId)}/holds`, { body: { sessionId: t.sessionId, items: [{ ticketTypeId: toddler.id, quantity: 1 }] } });
    const co = await call(app, "POST", `${pub(t.clientId, t.brandId)}/holds/${h.body.hold.id}/checkout`, {
      headers: { "x-alkao-hold-token": h.body.hold.token },
      body: { buyer: { email: "retour@example.com" }, successUrl: `${t.returnOrigin}/ok`, cancelUrl: `${t.returnOrigin}/ko` },
    });
    const context = await browser.newContext({ locale: "fr-CA", viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await page.goto(`${origin}/billets#${new URLSearchParams({ c: t.clientId, b: t.brandId, o: co.body.order.id, k: co.body.order.token })}`);
    const card = page.getByRole("region", { name: "Votre prochaine sortie" });
    await card.waitFor();
    expect(await card.textContent()).toMatch(/−15 %\s*de rabais\s*sur Festival d'hiver, avec ce code\s*RETOUR15\s*Valable jusqu'au /);
    const link = card.getByRole("link", { name: "Voir l'événement" });
    expect(await link.getAttribute("href")).toBe(`/acheter/${t.clientId}/${t.brandId}/${nextEventId}?coupon=RETOUR15`);
    if (shots) await card.screenshot({ path: `${shots}/return-offer-tickets.png` });
    await link.click();
    await page.getByText("Code RETOUR15 appliqué").waitFor();
    expect(pageErrors).toEqual([]);
    await context.close();
  });
});
