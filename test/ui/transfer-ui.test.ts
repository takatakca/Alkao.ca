import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, pub, stopServer, testApp, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { seedPaidOrder, seedTwoTenants, TEST_CREDENTIAL_SECRET, type SeedResult } from "../helpers/seed.js";
import { transferClaimSecret } from "../../src/delivery/transfer-token.js";

const executablePath = process.env.ALKAO_CHROMIUM_PATH ??
  (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
let db: TestDatabase;
let seed: SeedResult;
let app: TestApp;
let server: ServerType;
let origin: string;
let browser: Browser;
let errors: string[];

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  await db.pool.query(`UPDATE public.ticketing_brand_settings SET ticket_transfers_enabled = true
    WHERE client_id = $1 AND brand_id = $2`, [seed.havana.clientId, seed.havana.brandId]);
  app = testApp(db.pool, { transferApiEnabled: true, credentialMasterSecret: TEST_CREDENTIAL_SECRET });
  server = await new Promise<ServerType>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), args: ["--no-sandbox"] });
  errors = [];
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await stopServer(server);
  await db?.drop();
});

describe("Run 80 recipient ticket page in real browser", () => {
  it("serves a private, accessible shell with strict CSP and no referer", async () => {
    const res = await fetch(`${origin}/billets/transfert`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  it("claims on explicit consent and replaces one-time invitation secret with recipient-only QR access", async () => {
    const h = seed.havana;
    const order = await seedPaidOrder(db.pool, h, `browser-${randomUUID()}@example.com`, { GENERAL: 1 });
    const ticketId = order.ticketIds[0]!;
    const invite = await call(app, "POST", `${pub(h.clientId, h.brandId)}/orders/${order.orderId}/transfers`, {
      headers: { "x-alkao-order-token": `secret-${order.orderId}` },
      body: { ticketId, recipientEmail: "recipient@example.com" },
    });
    expect(invite.status).toBe(202);
    const requestId = invite.body.transfer.id as string;
    const secret = transferClaimSecret(TEST_CREDENTIAL_SECRET,
      { clientId: h.clientId, brandId: h.brandId }, requestId, ticketId, "recipient@example.com");
    const url = `${origin}/billets/transfert#${new URLSearchParams({
      c: h.clientId, b: h.brandId, r: requestId, k: secret,
    })}`;
    const context = await browser.newContext({ locale: "fr-CA" });
    const senderPage = await context.newPage();
    await senderPage.goto(`${origin}/billets#${new URLSearchParams({
      c: h.clientId, b: h.brandId, o: order.orderId, k: `secret-${order.orderId}`,
    })}`);
    await senderPage.getByRole("heading", { name: "Transférer un billet" }).waitFor();
    expect(await senderPage.getByText("Invitation en attente d’acceptation").isVisible()).toBe(true);
    const page = await context.newPage();
    page.on("pageerror", e => errors.push(e.message));
    await page.goto(url);
    expect(await page.getByRole("heading", { level: 1 }).textContent()).toBe("Recevoir mon billet");
    await page.getByRole("button", { name: "Confirmer et recevoir mon billet" }).waitFor();
    expect(await page.getByRole("img", { name: "Code QR de votre billet" }).count()).toBe(0);
    await page.getByRole("button", { name: "Confirmer et recevoir mon billet" }).click();
    const qr = page.getByRole("img", { name: "Code QR de votre billet" });
    await qr.waitFor({ state: "visible" });
    expect(await qr.getAttribute("src")).toMatch(/^data:image\/gif;base64,/);
    expect(page.url()).toContain("#c=");
    expect(page.url()).toContain("&a=");
    expect(page.url()).not.toContain("&k=");
    expect(errors).toEqual([]);
    const saved = page.url();
    await page.reload();
    await qr.waitFor({ state: "visible" });
    expect(page.url()).toBe(saved);
    const seller = await call(app, "GET", `${pub(h.clientId, h.brandId)}/orders/${order.orderId}`, {
      headers: { "x-alkao-order-token": `secret-${order.orderId}` },
    });
    expect(seller.body.order.tickets.find((t: { id: string }) => t.id === ticketId).credential).toBeNull();
    await senderPage.reload();
    await senderPage.getByText("Transféré à un destinataire").waitFor();
    expect(await senderPage.getByRole("img", { name: /^Code QR du billet/ }).count()).toBe(0);
    await context.close();
  });

  it("allows the authorized sender to prepare and cancel an invitation from the actual ticket page", async () => {
    const h = seed.havana;
    const order = await seedPaidOrder(db.pool, h, `buyer-panel-${randomUUID()}@example.com`, { GENERAL: 1 });
    const context = await browser.newContext({ locale: "fr-CA" });
    const page = await context.newPage();
    await page.goto(`${origin}/billets#${new URLSearchParams({
      c: h.clientId, b: h.brandId, o: order.orderId, k: `secret-${order.orderId}`,
    })}`);
    await page.getByRole("heading", { name: "Transférer un billet" }).waitFor();
    await page.getByLabel("Courriel du destinataire").fill("test-friend@example.com");
    await page.getByRole("button", { name: "Préparer le transfert" }).click();
    await page.getByText("Invitation en attente d’acceptation").waitFor();
    expect(await page.getByText("Demande enregistrée.", { exact: false }).count()).toBe(1);
    const requests = (await db.pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM public.ticketing_transfer_requests
       WHERE ticket_id = $1 ORDER BY created_at DESC`, [order.ticketIds[0]],
    )).rows;
    expect(requests).toHaveLength(1);
    expect(requests[0]?.status).toBe("pending");
    await page.getByRole("button", { name: "Annuler la demande" }).click();
    await page.getByText("Demande annulée", { exact: false }).waitFor();
    expect((await db.pool.query<{ status: string }>(
      "SELECT status FROM public.ticketing_transfer_requests WHERE id = $1",
      [requests[0]!.id],
    )).rows[0]?.status).toBe("cancelled");
    await context.close();
  });

  it("does not claim on page open, and switches language without revealing a token in markup", async () => {
    const context = await browser.newContext({ locale: "fr-CA" });
    const page = await context.newPage();
    await page.goto(`${origin}/billets/transfert`);
    await page.getByRole("status").first().waitFor();
    expect(await page.getByRole("button", { name: "Confirmer et recevoir mon billet" }).isHidden()).toBe(true);
    await page.getByRole("button", { name: "English" }).click();
    expect(await page.getByRole("heading", { name: "Receive my ticket" }).isVisible()).toBe(true);
    expect(await page.getByRole("img").count()).toBe(0);
    await context.close();
  });
});
