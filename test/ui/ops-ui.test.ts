import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, pub, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { seedAfterSale, seedPaidOrder, seedTwoTenants, TEST_CREDENTIAL_SECRET, type SeedResult } from "../helpers/seed.js";

/**
 * End-to-end: the real server, a real Chromium, the Operations app driven like a staff member.
 * Chromium: ALKAO_CHROMIUM_PATH, else the preinstalled /opt/pw-browsers/chromium, else
 * Playwright's own (CI runs `npx playwright-core install chromium`).
 */
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
  app = testApp(db.pool, { credentialMasterSecret: TEST_CREDENTIAL_SECRET });
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

async function signedIn(userId: string): Promise<Page> {
  const token = await tokenFor(userId, { expiresIn: "30m" });
  const context = await browser.newContext({ locale: "fr-CA" });
  await context.addInitScript((t) => {
    sessionStorage.setItem("alkao.ops.session", JSON.stringify({ accessToken: t, refreshToken: null, expiresAt: Date.now() + 1_800_000, email: "ops@example.com" }));
  }, token);
  const page = await context.newPage();
  page.on("pageerror", (e) => pageErrors.push(e.message));
  return page;
}

const brandPath = () => `/c/${seed.havana.clientId}/b/${seed.havana.brandId}`;

describe("ALKAO Operations app", () => {
  it("is served with a strict content security policy", async () => {
    const res = await fetch(`${origin}/ops`);
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(await (await fetch(`${origin}/ops/config.json`)).json()).toEqual({ supabaseUrl: null, supabaseAnonKey: null, embedOrigins: [] });
  });

  it("asks for credentials when signed out", async () => {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${origin}/ops`);
    await page.getByRole("button", { name: "Se connecter" }).waitFor();
  });

  it("lets an owner pick a workspace and see the dashboard", async () => {
    const page = await signedIn(seed.users.havanaOwner);
    await page.goto(`${origin}/ops#/`);
    await page.getByText("Havana Resort — Événements").click();
    await page.getByRole("heading", { name: "Tableau de bord" }).waitFor();
    // The figures load after the page frame (Run 26).
    await page.getByText("Ventes brutes").waitFor();
    expect(await page.getByText("Net client (avant frais Stripe)").isVisible()).toBe(true);
    // FESTI-ICE (another Client) is not offered to a Havana-only owner.
    await page.goto(`${origin}/ops#/`);
    await page.getByRole("heading", { name: "Choisir un espace" }).waitFor();
    expect(await page.getByText("FESTI-ICE").count()).toBe(0);
  });

  it("builds the catalog: venue, event, session on sale, ticket type", async () => {
    const page = await signedIn(seed.users.havanaOwner);
    await page.goto(`${origin}/ops#${brandPath()}/venues`);
    await page.getByLabel("Nom").fill("Sentier glacé");
    await page.getByLabel("Ville").fill("Maricourt");
    await page.getByRole("button", { name: "Ajouter le lieu" }).click();
    await page.getByRole("cell", { name: "Sentier glacé" }).waitFor();

    await page.goto(`${origin}/ops#${brandPath()}/events`);
    await page.getByLabel("Titre").fill("Soirée Patin Rétro");
    await page.getByRole("button", { name: "Créer l'événement" }).click();
    await page.getByRole("link", { name: "Soirée Patin Rétro" }).click();
    await page.getByRole("heading", { name: /Soirée Patin Rétro/ }).waitFor();

    await page.getByLabel("Début").fill("2027-01-15T18:30");
    await page.getByLabel("Capacité").fill("250");
    await page.getByRole("button", { name: "Ajouter la séance" }).click();
    await page.getByRole("button", { name: "Mettre en vente" }).click();
    await page.getByRole("button", { name: "Pause" }).waitFor();

    await page.getByLabel("Code", { exact: true }).fill("ADULTE");
    await page.getByLabel("Nom", { exact: true }).fill("Adulte");
    await page.getByLabel("Prix ($)").fill("24,95");
    await page.getByRole("button", { name: "Ajouter", exact: true }).click();
    await page.getByRole("cell", { name: "ADULTE", exact: true }).waitFor();
    await page.getByRole("button", { name: "Publier" }).click();
    await page.getByRole("button", { name: "Retirer de la vente publique" }).waitFor();

    const { rows } = await db.pool.query(
      `SELECT e.status, s.status AS session_status, s.capacity, t.price_cents
       FROM public.ticketing_events e JOIN public.ticketing_sessions s ON s.event_id = e.id JOIN public.ticketing_ticket_types t ON t.event_id = e.id
       WHERE e.client_id = $1 AND e.title = 'Soirée Patin Rétro'`,
      [seed.havana.clientId],
    );
    expect(rows).toEqual([{ status: "published", session_status: "on_sale", capacity: 250, price_cents: 2495 }]);
  });

  it("shows an order and explains in French why it cannot be refunded", async () => {
    const page = await signedIn(seed.users.havanaOwner);
    await page.goto(`${origin}/ops#${brandPath()}/order/${seed.havana.orderId}`);
    await page.getByRole("heading", { name: /^Commande / }).waitFor();
    expect(await page.getByText("Test Buyer").isVisible()).toBe(true);
    page.on("dialog", (d) => void d.accept());
    await page.getByRole("button", { name: "Rembourser", exact: true }).click();
    await page.getByRole("alert").waitFor();
    expect(await page.getByRole("alert").textContent()).toContain("Paiements non configurés");
  });

  it("shows the tickets email state and sends it again", async () => {
    const page = await signedIn(seed.users.havanaOwner);
    await page.goto(`${origin}/ops#${brandPath()}/order/${seed.havana.orderId}`);
    await page.getByRole("heading", { name: "Courriel des billets" }).waitFor();
    await page.getByRole("button", { name: "Renvoyer les billets par courriel" }).click();
    await page.getByText("Billets renvoyés à", { exact: false }).waitFor();
    await page.getByText("En attente d'envoi").waitFor();
  });

  it("scans tickets at the gate: accepted once, then already in", async () => {
    const t = seed.havana;
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO public.ticketing_sessions (client_id, brand_id, event_id, starts_at, capacity, status)
       VALUES ($1, $2, $3, now() + interval '15 minutes', 20, 'on_sale') RETURNING id`,
      [t.clientId, t.brandId, t.eventId],
    );
    const toddler = t.types.find((x) => x.code === "TODDLER")!.id;
    const h = await call(app, "POST", `${pub(t.clientId, t.brandId)}/holds`, { body: { sessionId: rows[0]!.id, items: [{ ticketTypeId: toddler, quantity: 1 }] } });
    const co = await call(app, "POST", `${pub(t.clientId, t.brandId)}/holds/${h.body.hold.id}/checkout`, {
      headers: { "x-alkao-hold-token": h.body.hold.token },
      body: { buyer: { email: "gate@example.com" }, successUrl: `${t.returnOrigin}/ok`, cancelUrl: `${t.returnOrigin}/ko` },
    });
    const order = await call(app, "GET", `${pub(t.clientId, t.brandId)}/orders/${co.body.order.id}`, { headers: { "x-alkao-order-token": co.body.order.token } });
    const qr = order.body.order.tickets[0].credential as string;

    const page = await signedIn(seed.users.havanaStaff);
    await page.goto(`${origin}/ops#${brandPath()}/scanner`);
    await page.getByLabel("Événement").selectOption({ label: "Havana Resort — Événements 2026-2027" });
    const sessionId = rows[0]!.id;
    await page.locator(`option[value="${sessionId}"]`).waitFor({ state: "attached" });
    await page.getByLabel("Séance").selectOption(sessionId);
    const input = page.getByLabel("Code du billet (lecteur ou saisie)");
    await input.fill(qr);
    await input.press("Enter");
    await page.getByRole("status").getByText("ENTRÉE ACCEPTÉE").waitFor();
    // Run 14: the live counter follows the gate.
    await page.getByRole("status", { name: "Entrées" }).getByText("1 / 1").waitFor();
    await input.fill(qr);
    await input.press("Enter");
    await page.getByRole("status").getByText("DÉJÀ ENTRÉ").waitFor();
  });

  it("lets a ticket in without its QR code, found by the order reference (Run 22)", async () => {
    const t = seed.havana;
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO public.ticketing_sessions (client_id, brand_id, event_id, starts_at, capacity, status)
       VALUES ($1, $2, $3, now() + interval '20 minutes', 20, 'on_sale') RETURNING id`,
      [t.clientId, t.brandId, t.eventId],
    );
    const sessionId = rows[0]!.id;
    const order = await seedPaidOrder(db.pool, { ...t, sessionId }, "sans-qr@example.com");
    const { rows: o } = await db.pool.query<{ reference: string }>(`SELECT reference FROM public.ticketing_orders WHERE id = $1`, [order.orderId]);

    const page = await signedIn(seed.users.havanaStaff);
    await page.goto(`${origin}/ops#${brandPath()}/scanner`);
    await page.getByLabel("Événement").selectOption({ label: "Havana Resort — Événements 2026-2027" });
    await page.locator(`option[value="${sessionId}"]`).waitFor({ state: "attached" });
    await page.getByLabel("Séance").selectOption(sessionId);
    await page.getByLabel("Sans code QR : référence de la commande").fill(o[0]!.reference.toLowerCase());
    await page.getByRole("button", { name: "Chercher" }).click();
    const found = page.getByLabel("Commande trouvée");
    await found.getByText(o[0]!.reference).waitFor();
    expect(await found.textContent()).not.toContain("sans-qr@example.com");
    await found.getByRole("button", { name: "Faire entrer" }).first().click();
    await page.getByRole("status").getByText("ENTRÉE ACCEPTÉE").waitFor();
    await found.getByText("Entré le", { exact: false }).first().waitFor();
  });

  it("finds an order by its reference or the buyer's email", async () => {
    const { rows } = await db.pool.query<{ reference: string; email: string }>(
      `SELECT o.reference, b.email FROM public.ticketing_orders o JOIN public.ticketing_buyers b ON b.id = o.buyer_id WHERE o.id = $1`,
      [seed.havana.orderId],
    );
    const page = await signedIn(seed.users.havanaOwner);
    await page.goto(`${origin}/ops#${brandPath()}/orders`);
    const box = page.getByLabel("Rechercher (référence, courriel ou nom)");
    await box.fill(rows[0]!.reference);
    await page.getByRole("button", { name: "Rechercher" }).click();
    await page.getByRole("link", { name: rows[0]!.reference }).waitFor();
    await box.fill("introuvable-xyz");
    await page.getByRole("button", { name: "Rechercher" }).click();
    await page.getByText("Aucune commande trouvée.").waitFor();
  });

  it("scans offline at the gate, then syncs and reports a ticket let in at two gates", async () => {
    const t = seed.havana;
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO public.ticketing_sessions (client_id, brand_id, event_id, starts_at, capacity, status)
       VALUES ($1, $2, $3, now() + interval '20 minutes', 20, 'on_sale') RETURNING id`,
      [t.clientId, t.brandId, t.eventId],
    );
    const sessionId = rows[0]!.id;
    const toddler = t.types.find((x) => x.code === "TODDLER")!.id;
    const buyOne = async () => {
      const h = await call(app, "POST", `${pub(t.clientId, t.brandId)}/holds`, { body: { sessionId, items: [{ ticketTypeId: toddler, quantity: 1 }] } });
      const co = await call(app, "POST", `${pub(t.clientId, t.brandId)}/holds/${h.body.hold.id}/checkout`, {
        headers: { "x-alkao-hold-token": h.body.hold.token },
        body: { buyer: { email: "porte@example.com" }, successUrl: `${t.returnOrigin}/ok`, cancelUrl: `${t.returnOrigin}/ko` },
      });
      const order = await call(app, "GET", `${pub(t.clientId, t.brandId)}/orders/${co.body.order.id}`, { headers: { "x-alkao-order-token": co.body.order.token } });
      return order.body.order.tickets[0] as { id: string; credential: string };
    };
    const first = await buyOne();
    const second = await buyOne();

    const page = await signedIn(seed.users.havanaStaff);
    await page.goto(`${origin}/ops#${brandPath()}/scanner`);
    await page.getByLabel("Événement").selectOption({ label: "Havana Resort — Événements 2026-2027" });
    await page.locator(`option[value="${sessionId}"]`).waitFor({ state: "attached" });
    await page.getByLabel("Séance").selectOption(sessionId);
    await page.getByRole("button", { name: "Préparer le mode hors ligne" }).click();
    await page.getByText("0 en attente de synchronisation").waitFor();

    await page.context().setOffline(true);
    const input = page.getByLabel("Code du billet (lecteur ou saisie)");
    const scan = async (code: string, expected: string) => {
      await input.fill(code);
      await input.press("Enter");
      await page.getByRole("status").getByText(expected).waitFor();
    };
    await scan(first.credential, "ENTRÉE ACCEPTÉE");
    expect(await page.getByText("Vérifié sur l'appareil (hors ligne)").isVisible()).toBe(true);
    await scan(first.credential, "DÉJÀ ENTRÉ");
    const forged = first.credential.slice(0, -2) + (first.credential.endsWith("AA") ? "BA" : "AA");
    await scan(forged, "FAUX BILLET");
    await scan(second.credential, "ENTRÉE ACCEPTÉE");
    await page.getByText("4 en attente de synchronisation").waitFor();
    // Nothing reached the server yet.
    const logged = async () => (await db.pool.query(`SELECT result, offline FROM public.ticketing_scans WHERE session_id = $1 ORDER BY id`, [sessionId])).rows;
    expect(await logged()).toEqual([]);

    // Meanwhile another gate, online, lets the second ticket in.
    const owner = await tokenFor(seed.users.havanaOwner);
    const other = await call(app, "POST", `/v1/admin/clients/${t.clientId}/brands/${t.brandId}/scanner/scans`, { token: owner, body: { sessionId, payload: second.credential, deviceId: "porte-nord" } });
    expect(other.body.scan.result).toBe("admitted");

    await page.context().setOffline(false);
    await page.getByRole("button", { name: "Synchroniser maintenant" }).click();
    await page.getByText("0 en attente de synchronisation").waitFor();
    await page.getByText("1 billet(s) aussi entré(s) à une autre porte").waitFor();
    const results = (await logged()).map((r: { result: string }) => r.result);
    expect(results.filter((r: string) => r === "admitted")).toHaveLength(2);
    expect(results).toContain("invalid_signature");
    const { rows: admissions } = await db.pool.query(`SELECT count(*)::int AS n FROM public.ticketing_scans WHERE ticket_id = $1 AND result = 'admitted'`, [second.id]);
    expect(admissions[0].n).toBe(1);
  });

  it("cancels a session from the event page and shows the refunds", async () => {
    const t = seed.havana;
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO public.ticketing_sessions (client_id, brand_id, event_id, starts_at, capacity, status)
       VALUES ($1, $2, $3, now() + interval '40 days', 20, 'on_sale') RETURNING id`,
      [t.clientId, t.brandId, t.eventId],
    );
    const sessionId = rows[0]!.id;
    const toddler = t.types.find((x) => x.code === "TODDLER")!.id;
    const h = await call(app, "POST", `${pub(t.clientId, t.brandId)}/holds`, { body: { sessionId, items: [{ ticketTypeId: toddler, quantity: 1 }] } });
    await call(app, "POST", `${pub(t.clientId, t.brandId)}/holds/${h.body.hold.id}/checkout`, {
      headers: { "x-alkao-hold-token": h.body.hold.token },
      body: { buyer: { email: "annule@example.com" }, successUrl: `${t.returnOrigin}/ok`, cancelUrl: `${t.returnOrigin}/ko` },
    });
    const page = await signedIn(seed.users.havanaOwner);
    page.on("dialog", (d) => void d.accept("Tempête"));
    await page.goto(`${origin}/ops#${brandPath()}/event/${t.eventId}`);
    const { rows: s } = await db.pool.query<{ starts_at: Date }>(`SELECT starts_at FROM public.ticketing_sessions WHERE id = $1`, [sessionId]);
    const label = new Date(s[0]!.starts_at).toLocaleString("fr-CA", { dateStyle: "medium", timeStyle: "short" });
    await page.getByRole("row", { name: new RegExp(label) }).getByRole("button", { name: "Annuler la séance" }).click();
    await page.getByText("Séance annulée : tout le monde est remboursé.").waitFor();
    expect(await page.getByText("1 gratuite(s) annulée(s)", { exact: false }).isVisible()).toBe(true);
    const { rows: after } = await db.pool.query(`SELECT status FROM public.ticketing_sessions WHERE id = $1`, [sessionId]);
    expect(after).toEqual([{ status: "cancelled" }]);
  });

  it("gives the shop link and the website button code for an event", async () => {
    const t = seed.havana;
    const page = await signedIn(seed.users.havanaOwner);
    await page.goto(`${origin}/ops#${brandPath()}/event/${t.eventId}`);
    await page.getByRole("heading", { name: "Vendre en ligne" }).waitFor();
    expect(await page.getByRole("link", { name: `${origin}/acheter/${t.clientId}/${t.brandId}/${t.eventId}` }).isVisible()).toBe(true);
    const code = await page.getByLabel("Bouton pour votre site (copiez ce code dans la page)").inputValue();
    expect(code).toBe(`<script src="${origin}/widget.js" data-client="${t.clientId}" data-brand="${t.brandId}" data-event="${t.eventId}" data-label="Acheter des billets" async></script>`);
  });

  it("flags a Stripe dispute and a refund made in Stripe, on the dashboard and the order", async () => {
    // FESTI-ICE, so Havana's pages in the other tests stay as they are.
    const f = seed.festi;
    const order = await seedPaidOrder(db.pool, f, "conteste@example.com");
    await seedAfterSale(db.pool, f, order.orderId, 1000);
    const page = await signedIn(seed.users.festiOwner);
    await page.goto(`${origin}/ops#/c/${f.clientId}/b/${f.brandId}/dashboard`);
    const notice = page.getByRole("region", { name: /^À traiter/ });
    await notice.waitFor();
    expect(await notice.textContent()).toContain("Litiges Stripe ouverts (1)");
    expect(await notice.textContent()).toContain("Réponse attendue");
    expect(await notice.textContent()).toContain("Remboursés dans Stripe, billets encore valides (1)");
    await notice.getByRole("link").first().click();
    await page.getByRole("heading", { name: /^Commande / }).waitFor();
    const banner = page.getByRole("alert").filter({ hasText: "Litige Stripe (rétrofacturation)" });
    expect(await banner.textContent()).toContain("motif : fraude");
    expect(await banner.textContent()).toContain("ALKAO n'a annulé aucun billet");
    expect(await page.getByText("Remboursé directement dans Stripe, hors ALKAO", { exact: false }).textContent()).toContain("10,00");
    expect(await page.getByRole("columnheader", { name: "Entré" }).isVisible()).toBe(true);
  });

  it("exports a buyer's data and anonymizes the buyer on request (Law 25)", async () => {
    const f = seed.festi;
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO public.ticketing_sessions (client_id, brand_id, event_id, starts_at, capacity, status)
       VALUES ($1, $2, $3, now() - interval '2 days', 20, 'on_sale') RETURNING id`,
      [f.clientId, f.brandId, f.eventId],
    );
    const order = await seedPaidOrder(db.pool, { ...f, sessionId: rows[0]!.id }, "loi25@example.com");
    const page = await signedIn(seed.users.festiOwner);
    await page.goto(`${origin}/ops#/c/${f.clientId}/b/${f.brandId}/order/${order.orderId}`);
    await page.getByRole("heading", { name: "Données personnelles (Loi 25)" }).waitFor();
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Exporter les données de l'acheteur" }).click()]);
    expect(download.suggestedFilename()).toMatch(/^alkao-donnees-acheteur-.+\.json$/);
    const exported = JSON.parse(await new Response((await download.createReadStream()) as unknown as ReadableStream).text());
    expect(exported.buyer.email).toBe("loi25@example.com");

    page.on("dialog", (d) => void d.accept());
    await page.getByRole("button", { name: "Anonymiser l'acheteur" }).click();
    await page.getByText("Acheteur anonymisé le", { exact: false }).waitFor();
    expect(await page.getByText("loi25@example.com").count()).toBe(0);
  });

  it("turns the reminder email off and on from the dashboard (Run 23)", async () => {
    const f = seed.festi;
    const page = await signedIn(seed.users.festiOwner);
    await page.goto(`${origin}/ops#/c/${f.clientId}/b/${f.brandId}/dashboard`);
    await page.getByRole("heading", { name: "Courriels aux acheteurs" }).waitFor();
    await page.getByText("activé", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Désactiver" }).click();
    await page.getByText("désactivé", { exact: true }).waitFor();
    const { rows } = await db.pool.query(`SELECT reminder_emails FROM public.ticketing_brand_settings WHERE client_id = $1 AND brand_id = $2`, [f.clientId, f.brandId]);
    expect(rows).toEqual([{ reminder_emails: false }]);
    await page.getByRole("button", { name: "Activer" }).click();
    await page.getByText("activé", { exact: true }).waitFor();
  });

  it("offers to retry a refund Stripe has not settled (Run 24)", async () => {
    const f = seed.festi;
    const order = await seedPaidOrder(db.pool, f, "reessayer@example.com");
    await db.pool.query(
      `INSERT INTO public.ticketing_refunds (client_id, brand_id, event_id, order_id, amount_cents, commission_refund_cents, requested_by, last_error)
       VALUES ($1, $2, $3, $4, 500, 0, 'user', 'refund_payment')`,
      [f.clientId, f.brandId, f.eventId, order.orderId],
    );
    const page = await signedIn(seed.users.festiOwner);
    await page.goto(`${origin}/ops#/c/${f.clientId}/b/${f.brandId}/order/${order.orderId}`);
    await page.getByRole("heading", { name: "Remboursements" }).waitFor();
    expect(await page.getByText("(refund_payment)").isVisible()).toBe(true);
    await page.getByRole("button", { name: "Réessayer" }).click();
    // This test deployment has no Stripe: the retry reaches ALKAO, which says so.
    await page.getByRole("alert").getByText("Paiements non configurés", { exact: false }).waitFor();
  });

  it("reports a chosen period, day by day, and exports it for the accountant (Run 26)", async () => {
    const page = await signedIn(seed.users.havanaOwner);
    await page.goto(`${origin}/ops#${brandPath()}/dashboard`);
    await page.getByRole("heading", { name: "Par jour" }).waitFor();
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", dateStyle: "short" }).format(new Date());
    await page.getByRole("cell", { name: today }).waitFor();
    // Last month: nothing was sold then.
    await page.getByLabel("Période").selectOption("lastMonth");
    await page.getByText("Aucune vente ni aucun remboursement sur cette période.").waitFor();
    await page.getByLabel("Période").selectOption("today");
    await page.getByRole("cell", { name: today }).waitFor();
    const [file] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Exporter par jour (CSV)" }).click()]);
    expect(file.suggestedFilename()).toBe("alkao-ventes-par-jour.csv");
    const csv = await new Response((await file.createReadStream()) as unknown as ReadableStream).text();
    expect(csv.split("\r\n")[0]).toMatch(/^day,orders,subtotal_cents,tax_cents,gst_cents,qst_cents/);
    expect(csv).toContain(`${today},`);
  });

  it("hides money from gate staff", async () => {
    const page = await signedIn(seed.users.havanaStaff);
    await page.goto(`${origin}/ops#${brandPath()}/dashboard`);
    await page.getByRole("alert").waitFor();
    expect(await page.getByRole("alert").textContent()).toContain("Votre rôle ne permet pas cette action.");
  });

  it("ran without script errors", () => {
    expect(pageErrors).toEqual([]);
  });
});

describe("ALKAO Operations embedded in the TAKATAK dashboard", () => {
  // A stand-in TAKATAK page on another origin frames /ops and answers its postMessage handshake.
  let parent: Server;
  let parentOrigin: string;
  let embedServer: ServerType;
  let embedOrigin: string;
  let token: string;

  beforeAll(async () => {
    token = await tokenFor(seed.users.havanaOwner, { expiresIn: "30m" });
    const badToken = await tokenFor(seed.users.havanaOwner, { secret: "not-the-alkao-jwt-secret-0123456789abcdef", expiresIn: "30m" });
    parent = createServer((req, res) => {
      const accessToken = req.url === "/bad" ? badToken : token;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><title>TAKATAK</title><iframe id="f" src="${embedOrigin}/ops#/" style="width:1000px;height:700px"></iframe>
<script>
  window.received = [];
  let sent = 0;
  addEventListener("message", (e) => {
    if (e.origin !== ${JSON.stringify(embedOrigin)} || e.source !== document.getElementById("f").contentWindow) return;
    window.received.push(e.data.type);
    sent++;
    // The first token is about to lapse, so ALKAO must ask for another before its first call.
    const expiresAt = Date.now() + (sent === 1 ? 30000 : 1800000);
    e.source.postMessage({ type: "alkao.session", accessToken: ${JSON.stringify(accessToken)}, expiresAt, email: "ops@takatak.ca" }, e.origin);
  });
</script>`);
    });
    await new Promise<void>((r) => parent.listen(0, "127.0.0.1", r));
    // "localhost" vs "127.0.0.1": two distinct origins on the same machine.
    parentOrigin = `http://localhost:${(parent.address() as AddressInfo).port}`;
    const embedApp = testApp(db.pool, { opsUi: { supabaseUrl: null, supabaseAnonKey: null, frameAncestors: [parentOrigin] } });
    embedServer = await new Promise<ServerType>((resolve) => {
      const s = serve({ fetch: embedApp.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
    });
    embedOrigin = `http://127.0.0.1:${(embedServer.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    await new Promise((r) => embedServer?.close(r));
    await new Promise((r) => parent?.close(r));
  });

  it("allows only the configured parent to frame it", async () => {
    const res = await fetch(`${embedOrigin}/ops`);
    expect(res.headers.get("content-security-policy")).toContain(`frame-ancestors ${parentOrigin}`);
    expect(await (await fetch(`${embedOrigin}/ops/config.json`)).json()).toMatchObject({ embedOrigins: [parentOrigin] });
  });

  it("signs in with the token handed over by TAKATAK and asks again when it lapses", async () => {
    const page = await (await browser.newContext({ locale: "fr-CA" })).newPage();
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await page.goto(`${parentOrigin}/`);
    const frame = page.frameLocator("#f");
    await frame.getByRole("heading", { name: "Choisir un espace" }).waitFor();
    expect(await page.evaluate(() => (globalThis as any).received)).toEqual(["alkao.ready", "alkao.session_expired"]);
    // No login form, no logout: the TAKATAK session is the only session.
    expect(await frame.getByRole("button", { name: "Se connecter" }).count()).toBe(0);
    expect(await frame.getByRole("button", { name: "Déconnexion" }).count()).toBe(0);

    // A message that does not come from the parent window is ignored: a forged token would be
    // rejected by the API and make ALKAO ask TAKATAK again.
    const inner = page.frames().find((f) => f.url().startsWith(embedOrigin))!;
    await inner.evaluate(() => (globalThis as any).postMessage({ type: "alkao.session", accessToken: "forged", expiresAt: Date.now() + 9e6 }, "*"));
    await frame.getByText("Havana Resort — Événements").click();
    await frame.getByRole("heading", { name: "Tableau de bord" }).waitFor();
    expect(await page.evaluate(() => (globalThis as any).received)).toEqual(["alkao.ready", "alkao.session_expired"]);
  });

  it("stops asking when ALKAO rejects the TAKATAK token", async () => {
    const page = await (await browser.newContext({ locale: "fr-CA" })).newPage();
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await page.goto(`${parentOrigin}/bad`);
    await page.frameLocator("#f").getByRole("alert").getByText("ALKAO n'accepte pas la session TAKATAK", { exact: false }).waitFor();
    await page.waitForTimeout(500);
    // ready, renewal of the lapsing token, one retry after the 401, then nothing.
    expect(await page.evaluate(() => (globalThis as any).received)).toEqual(["alkao.ready", "alkao.session_expired", "alkao.session_expired"]);
  });

  it("refuses to render inside a page that is not allowed to frame it", async () => {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${origin}/health`);
    await page.setContent(`<iframe id="f" src="${embedOrigin}/ops#/"></iframe>`);
    await page.waitForTimeout(500);
    const inner = page.frames().find((f) => f.url().startsWith(embedOrigin));
    expect(await inner?.locator("#app").count().catch(() => 0) ?? 0).toBe(0);
  });

  it("ran without script errors", () => {
    expect(pageErrors).toEqual([]);
  });
});
