import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adm, call, pub, stopServer, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { line, report } from "../helpers/reservations.js";
import { seedAfterSale, seedPaidOrder, withMeal, seedTwoTenants, TEST_CREDENTIAL_SECRET, type SeedResult } from "../helpers/seed.js";

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
  await stopServer(server);
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

  it("beeps and vibrates once for a ticket let in, twice for a refusal, unless turned off (Run 33)", async () => {
    const t = seed.havana;
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO public.ticketing_sessions (client_id, brand_id, event_id, starts_at, capacity, status)
       VALUES ($1, $2, $3, now() + interval '20 minutes', 20, 'on_sale') RETURNING id`,
      [t.clientId, t.brandId, t.eventId],
    );
    const sessionId = rows[0]!.id;
    const toddler = t.types.find((x) => x.code === "TODDLER")!.id;
    const h = await call(app, "POST", `${pub(t.clientId, t.brandId)}/holds`, { body: { sessionId, items: [{ ticketTypeId: toddler, quantity: 1 }] } });
    const co = await call(app, "POST", `${pub(t.clientId, t.brandId)}/holds/${h.body.hold.id}/checkout`, {
      headers: { "x-alkao-hold-token": h.body.hold.token },
      body: { buyer: { email: "bip@example.com" }, successUrl: `${t.returnOrigin}/ok`, cancelUrl: `${t.returnOrigin}/ko` },
    });
    const order = await call(app, "GET", `${pub(t.clientId, t.brandId)}/orders/${co.body.order.id}`, { headers: { "x-alkao-order-token": co.body.order.token } });
    const qr = order.body.order.tickets[0].credential as string;

    const page = await signedIn(seed.users.havanaStaff);
    // A recording speaker and vibrator: what the gate would hear and feel.
    await page.context().addInitScript(() => {
      const w = globalThis as unknown as { __signals: unknown[][]; AudioContext: unknown };
      w.__signals = [];
      Object.defineProperty(navigator, "vibrate", { configurable: true, value: (p: unknown) => (w.__signals.push(["vibrate", p]), true) });
      w.AudioContext = class {
        currentTime = 0;
        destination = {};
        resume() { return Promise.resolve(); }
        createGain() { return { gain: { value: 0 }, connect: (d: unknown) => d }; }
        createOscillator() {
          const o = { type: "", frequency: { value: 0 }, connect: (g: unknown) => g, start: () => w.__signals.push(["beep", o.frequency.value]), stop: () => undefined };
          return o;
        }
      };
    });
    const signals = () => page.evaluate(() => (globalThis as unknown as { __signals: unknown[][] }).__signals.splice(0));
    const scanner = async () => {
      await page.goto(`${origin}/ops#${brandPath()}/scanner`);
      await page.getByLabel("Événement").selectOption({ label: "Havana Resort — Événements 2026-2027" });
      await page.locator(`option[value="${sessionId}"]`).waitFor({ state: "attached" });
      await page.getByLabel("Séance").selectOption(sessionId);
      return page.getByLabel("Code du billet (lecteur ou saisie)");
    };
    const input = await scanner();
    await input.fill(qr);
    await input.press("Enter");
    await page.getByRole("status").getByText("ENTRÉE ACCEPTÉE").waitFor();
    await expect.poll(signals).toEqual([["vibrate", 80], ["beep", 880]]);
    await input.fill(qr);
    await input.press("Enter");
    await page.getByRole("status").getByText("DÉJÀ ENTRÉ").waitFor();
    await expect.poll(signals).toEqual([["vibrate", [120, 80, 120]], ["beep", 220], ["beep", 220]]);

    // Turned off, it stays off on this device.
    await page.getByLabel("Son et vibration").uncheck();
    await input.fill(qr);
    await input.press("Enter");
    await page.getByRole("status").getByText("DÉJÀ ENTRÉ").waitFor();
    const again = await scanner();
    expect(await page.getByLabel("Son et vibration").isChecked()).toBe(false);
    await again.fill(qr);
    await again.press("Enter");
    await page.getByRole("status").getByText("DÉJÀ ENTRÉ").waitFor();
    expect(await signals()).toEqual([]);
  });

  it("lets a ticket in without its QR code, found by the order reference (Run 22)", async () => {
    const t = seed.havana;
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO public.ticketing_sessions (client_id, brand_id, event_id, starts_at, capacity, status)
       VALUES ($1, $2, $3, now() + interval '20 minutes', 20, 'on_sale') RETURNING id`,
      [t.clientId, t.brandId, t.eventId],
    );
    const sessionId = rows[0]!.id;
    const fed = await withMeal(db.pool, t);
    const order = await seedPaidOrder(db.pool, { ...fed, sessionId }, "sans-qr@example.com", { GENERAL: 2, CHILD: 2, MEAL: 4, FLEX_WEATHER: 4 });
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
    // Runs 55, 57: the meals bought with the order, to hand over at the gate (Flex Météo is a
    // session-change right, not an item), and the session's count.
    const meal = fed.types.find((x) => x.code === "MEAL")!.name;
    await found.getByText(`Options : ${meal} × 4`).waitFor();
    expect(await found.textContent()).not.toContain("Flex");
    const prep = page.getByLabel("Options de la séance");
    await prep.getByText(meal).waitFor();
    expect(await prep.textContent()).toContain("0 / 4");
    await found.getByRole("button", { name: "Faire entrer" }).first().click();
    await page.getByRole("status").getByText("ENTRÉE ACCEPTÉE").waitFor();
    await page.getByRole("status").getByText("Options à remettre").waitFor();
    await page.getByRole("status").getByText(`${meal} × 4`).waitFor();
    await prep.getByText("4 / 4").waitFor();
    await found.getByText("Entré le", { exact: false }).first().waitFor();
    await found.getByRole("button", { name: "Faire entrer" }).first().click();
    await page.getByRole("status").getByText("Options déjà remises à une entrée précédente").waitFor();
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

  it("duplicates an event, sessions a week later, and opens the copy (Run 28)", async () => {
    const f = seed.festi;
    const page = await signedIn(seed.users.festiOwner);
    await page.goto(`${origin}/ops#/c/${f.clientId}/b/${f.brandId}/event/${f.eventId}`);
    await page.getByRole("heading", { name: "Vendre en ligne" }).waitFor();
    const answers = ["FESTI-ICE — édition suivante", "7"];
    page.on("dialog", (d) => void d.accept(answers.shift()));
    await page.getByRole("button", { name: "Dupliquer l'événement" }).click();
    await page.getByRole("heading", { name: /^FESTI-ICE — édition suivante/ }).waitFor();
    expect(page.url()).not.toContain(f.eventId);
    const { rows } = await db.pool.query(
      `SELECT e.status, count(s.id)::int AS sessions FROM public.ticketing_events e LEFT JOIN public.ticketing_sessions s ON s.event_id = e.id
       WHERE e.title = 'FESTI-ICE — édition suivante' GROUP BY e.status`,
    );
    expect(rows).toEqual([{ status: "draft", sessions: expect.any(Number) }]);
    expect(rows[0].sessions).toBeGreaterThan(0);
  });

  it("creates a season of sessions after a preview, then puts them on sale at once (Run 29)", async () => {
    const f = seed.festi;
    const page = await signedIn(seed.users.festiOwner);
    await page.goto(`${origin}/ops#/c/${f.clientId}/b/${f.brandId}/event/${f.eventId}`);
    await page.getByRole("button", { name: "Créer plusieurs séances…" }).click();
    const form = page.getByRole("form", { name: "Créer plusieurs séances" });
    // Fridays and Saturdays from 2027-02-05 to 2027-02-14, 17:00 to 17:45 every 15 minutes.
    await form.getByLabel("Du", { exact: true }).fill("2027-02-05");
    await form.getByLabel("Au", { exact: true }).fill("2027-02-14");
    for (const day of ["Lun", "Mar", "Mer", "Jeu", "Dim"]) await form.getByRole("checkbox", { name: day }).uncheck();
    await form.getByLabel("Première séance").fill("17:00");
    await form.getByLabel("Dernière séance (facultatif)").fill("17:45");
    await form.getByLabel("Toutes les (minutes)").fill("15");
    await form.getByLabel("Capacité par séance").fill("60");
    await form.getByRole("button", { name: "Aperçu" }).click();
    await form.getByRole("status").getByText(/^16 séance\(s\) à créer/).waitFor();
    const countIn = async (status: string) =>
      (await db.pool.query(`SELECT count(*)::int AS n FROM public.ticketing_sessions WHERE event_id = $1 AND starts_at >= '2027-02-05' AND starts_at < '2027-02-15' AND status = $2`, [f.eventId, status])).rows[0].n;
    expect(await countIn("draft")).toBe(0);
    await form.getByRole("button", { name: "Créer 16 séance(s)" }).click();
    await form.getByRole("status").getByText("16 séance(s) créée(s).").waitFor();
    expect(await countIn("draft")).toBe(16);

    page.on("dialog", (d) => void d.accept());
    await page.getByRole("button", { name: "Ouvrir les ventes des brouillons à venir" }).click();
    await expect.poll(() => countIn("on_sale")).toBe(16);
  });

  it("shows who did what in the journal and on the order, to owners only (Run 30)", async () => {
    const h = seed.havana;
    // Something this owner did: the journal says "Vous".
    const owner = await tokenFor(seed.users.havanaOwner);
    const sent = await call(app, "POST", `${adm(h.clientId, h.brandId)}/orders/${h.orderId}/tickets-email`, { token: owner });
    expect(sent.status).toBe(202);
    // And something that is not about an order, for the filter to leave out.
    expect((await call(app, "POST", `${adm(h.clientId, h.brandId)}/venues`, { token: owner, body: { name: "Salle du journal" } })).status).toBe(201);
    const page = await signedIn(seed.users.havanaOwner);
    // The filtered answer comes late, as on a busy network: the page must not show stale rows meanwhile.
    await page.route("**/audit?*action=order*", async (r) => { await new Promise((ok) => setTimeout(ok, 400)); await r.continue(); });
    await page.goto(`${origin}/ops#${brandPath()}/dashboard`);
    await page.getByRole("link", { name: "Journal" }).click();
    await page.getByRole("heading", { name: "Journal" }).waitFor();
    // Everything first (catalog, sessions, orders…), then only orders.
    await page.getByRole("cell", { name: "Lieu créé" }).first().waitFor();
    await page.getByLabel("Afficher").selectOption({ label: "Commandes" });
    // Never the unfiltered rows while the filtered ones load.
    await expect.poll(() => page.locator("tbody tr td:nth-child(3)").allTextContents()).not.toContain("Lieu créé");
    await page.getByRole("cell", { name: "Commande payée" }).first().waitFor();
    const mine = page.getByRole("row").filter({ hasText: "Billets envoyés par courriel" }).first();
    expect(await mine.getByRole("cell").nth(1).textContent()).toBe("Vous (propriétaire)");
    const actions = await page.locator("tbody tr td:nth-child(3)").allTextContents();
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((a) => /^(Commande|Billets|Lien|Changement|Payée)/.test(a))).toBe(true);
    await page.getByRole("link", { name: "Commande", exact: true }).first().click();
    await page.getByRole("heading", { name: "Historique" }).waitFor();
    await page.getByRole("cell", { name: "Commande payée" }).waitFor();

    const staff = await signedIn(seed.users.havanaStaff);
    await staff.goto(`${origin}/ops#${brandPath()}/scanner`);
    await staff.getByRole("heading", { name: "Scanner" }).waitFor();
    expect(await staff.getByRole("link", { name: "Journal" }).count()).toBe(0);
  });

  it("creates a promo code on the event page and switches it off (Run 36)", async () => {
    const f = seed.festi;
    const page = await signedIn(seed.users.festiOwner);
    await page.goto(`${origin}/ops#/c/${f.clientId}/b/${f.brandId}/event/${f.eventId}`);
    const form = page.getByRole("form", { name: "Nouveau code promo" });
    await form.getByLabel("Code promo").fill("famille-10");
    await form.getByLabel("Type de rabais").selectOption("amount");
    await form.getByLabel("Rabais ($)").fill("10");
    await form.getByLabel("Utilisations max. (facultatif)").fill("50");
    await form.getByRole("button", { name: "Créer le code" }).click();
    const row = page.getByRole("row").filter({ hasText: "FAMILLE-10" });
    await row.waitFor();
    expect(await row.getByRole("cell").nth(2).textContent()).toBe("0 / 50");
    await row.getByRole("button", { name: "Désactiver" }).click();
    await row.getByText("Désactivé").waitFor();
    const { rows } = await db.pool.query(`SELECT kind, amount_cents, max_uses, active FROM public.ticketing_promo_codes WHERE code = 'FAMILLE-10'`);
    expect(rows).toEqual([{ kind: "amount", amount_cents: 1000, max_uses: 50, active: false }]);
  });

  it("imports a reservations report, colours customers by frequency and opens one (Run 41)", async () => {
    const page = await signedIn(seed.users.havanaOwner);
    await page.goto(`${origin}/ops#${brandPath()}/customers`);
    await page.getByRole("heading", { name: "Clients", exact: true }).waitFor();
    await page.getByText("Aucun client trouvé.").waitFor();
    const who = { Nom: "FIDÈLE", Prénom: "DENIS", Courriel: "denis@example.com", Cellulaire: "514-555-0199", Commentaires: "carte 4111 1111 1111 1111" };
    const stays = [["301", "2023-07-01"], ["302", "2023-08-01"], ["303", "2024-07-01"], ["304", "2024-08-01"], ["305", "2025-07-01"]];
    const file = report([
      ...stays.map(([n, d]) => line(n!, "CHALET 5", d!, d!.replace(/-01$/, "-03"), who)),
      line("401", "CABANA 2", "2025-07-15", "2025-07-16", { Nom: "Exemple", Prénom: "Alice", Courriel: "alice@example.com" }),
    ]);
    const form = page.getByRole("form", { name: "Importer un rapport de réservations" });
    await form.getByLabel("Rapport (CSV)").setInputFiles({ name: "reservations.csv", mimeType: "text/csv", buffer: Buffer.from(file) });
    await form.getByRole("button", { name: "Importer" }).click();
    await page.getByText("Import terminé.").waitFor();
    expect(await page.getByRole("status").filter({ hasText: "Import terminé." }).textContent()).toContain("6 réservations lues · 2 nouveaux clients");
    // The comment (and the card number in it) never left the browser.
    const { rows } = await db.pool.query(`SELECT count(*)::int AS n FROM public.ticketing_customer_bookings b JOIN public.ticketing_customers c ON c.id = b.customer_id WHERE row_to_json(b)::text LIKE '%4111%' OR row_to_json(c)::text LIKE '%4111%'`);
    expect(rows[0].n).toBe(0);

    const loyal = page.getByRole("button", { name: /Fidèle/ });
    await loyal.click();
    expect(await loyal.getAttribute("aria-pressed")).toBe("true");
    await page.getByRole("row").filter({ hasText: "Alice" }).waitFor({ state: "detached" });
    await page.getByRole("link", { name: "Denis Fidèle" }).click();
    await page.getByRole("heading", { name: "Réservations" }).waitFor();
    expect(await page.locator(".kpi").filter({ hasText: "Visites" }).locator(".value").textContent()).toBe("5");
    await page.getByRole("button", { name: "Désabonner des courriels" }).click();
    await page.getByText("Non : désabonné").waitFor();
  });

  it("keeps the customer file away from gate staff (Run 41)", async () => {
    const page = await signedIn(seed.users.havanaStaff);
    await page.goto(`${origin}/ops#${brandPath()}/scanner`);
    await page.getByRole("heading", { name: "Scanner" }).waitFor();
    expect(await page.getByRole("link", { name: "Clients" }).count()).toBe(0);
  });

  it("writes a campaign, tries it, and sends it to the customers who may receive it (Run 42)", async () => {
    const page = await signedIn(seed.users.havanaOwner);
    page.on("dialog", (d) => void d.accept());
    await page.goto(`${origin}/ops#${brandPath()}/campaigns`);
    await page.getByRole("heading", { name: "Campagnes", exact: true }).waitFor();
    const sender = page.getByRole("form", { name: "Expéditeur des campagnes" });
    await sender.getByLabel("Adresse postale").fill("1 rue Exemple, Maricourt (Québec) J0E 2L2");
    await sender.getByLabel("Nous joindre (courriel, téléphone ou site)").fill("info@example.com");
    await sender.getByRole("button", { name: "Enregistrer" }).click();
    await sender.getByText("Enregistré.").waitFor();
    // Run 44: the newsletter's welcome code.
    const newsletter = page.getByRole("form", { name: "Infolettre" });
    await newsletter.getByLabel("Code de bienvenue (facultatif)").fill("HAVANA5");
    await newsletter.getByLabel("Ce qu'il donne").fill("5 % sur vos billets");
    await newsletter.getByRole("button", { name: "Enregistrer" }).click();
    await newsletter.getByText("Enregistré.").waitFor();
    const { rows: nl } = await db.pool.query(`SELECT newsletter_reward_code, newsletter_reward_text FROM public.ticketing_brand_settings WHERE brand_id = $1`, [seed.havana.brandId]);
    expect(nl[0]).toEqual({ newsletter_reward_code: "HAVANA5", newsletter_reward_text: "5 % sur vos billets" });

    await page.getByRole("link", { name: "Nouvelle campagne" }).click();
    const form = page.getByRole("form", { name: "Contenu de la campagne" });
    await form.getByLabel("Nom (pour l'équipe)").fill("Halloween 2026");
    await form.getByLabel("Objet du courriel").fill("{prénom}, Halloween revient !");
    await form.getByLabel("Texte", { exact: true }).fill("Les soirées Halloween reviennent.\n\nRéservez votre chalet.");
    await form.getByLabel("Bouton : texte (facultatif)").fill("Acheter mes billets");
    await form.getByLabel("Bouton : lien https").fill("https://promohavana.ca/promos/halloween");
    // Denis unsubscribed in the Run 41 test: only Alice may receive it.
    await form.getByText("1 clients peuvent recevoir cette campagne").waitFor();
    await form.getByRole("button", { name: "Créer le brouillon" }).click();
    await page.getByRole("heading", { name: "Halloween 2026" }).waitFor();

    const send = page.getByRole("form", { name: "Essai et envoi" });
    await send.getByLabel("Envoyer un essai à").fill("equipe@example.com");
    await send.getByRole("button", { name: "Envoyer l'essai" }).click();
    await page.getByText("Essai en route vers equipe@example.com").waitFor();
    await send.getByRole("button", { name: "Envoyer à 1 clients" }).click();
    await page.getByText("Envoi lancé.").waitFor();
    await page.getByText("Envoi en cours").waitFor();
    const { rows } = await db.pool.query(`SELECT m.email, m.customer_id IS NULL AS test FROM public.ticketing_campaign_messages m ORDER BY m.created_at`);
    expect(rows).toEqual([{ email: "equipe@example.com", test: true }, { email: "alice@example.com", test: false }]);
  });

  it("shows a campaign held for its bounces, resumes it, and marks the address that refused (Run 48)", async () => {
    const page = await signedIn(seed.users.havanaOwner);
    page.on("dialog", (d) => void d.accept());
    const { rows } = await db.pool.query<{ id: string }>(
      `UPDATE public.ticketing_campaigns SET held_at = now(), held_reason = 'bounces' WHERE name = 'Halloween 2026' RETURNING id`,
    );
    await db.pool.query(`UPDATE public.ticketing_customers SET email_bounced_at = now() WHERE email = 'alice@example.com'`);
    await page.goto(`${origin}/ops#${brandPath()}/campaigns`);
    await page.getByText("Suspendue : à vérifier").waitFor();
    await page.goto(`${origin}/ops#${brandPath()}/campaign/${rows[0]!.id}`);
    await page.getByText("trop d'adresses de cette liste refusent les courriels").waitFor();
    await page.locator(".kpi").filter({ hasText: "Adresses refusées" }).waitFor();
    await page.getByRole("button", { name: "Reprendre l'envoi" }).click();
    await page.getByText("Envoi repris.").waitFor();
    expect(await page.getByRole("button", { name: "Reprendre l'envoi" }).count()).toBe(0);
    const { rows: c } = await db.pool.query<{ id: string }>(`SELECT id FROM public.ticketing_customers WHERE email = 'alice@example.com'`);
    await page.goto(`${origin}/ops#${brandPath()}/customer/${c[0]!.id}`);
    await page.getByText("Non : l'adresse refuse les courriels").waitFor();
    await page.getByText("cette adresse a refusé un courriel").waitFor();
    expect(await page.getByRole("button", { name: "Le client a consenti aux courriels" }).count()).toBe(0);
    await db.pool.query(`UPDATE public.ticketing_customers SET email_bounced_at = NULL WHERE email = 'alice@example.com'`);
  });

  it("sets up an automatic e-mail after each chalet stay and turns it on (Run 45)", async () => {
    const page = await signedIn(seed.users.havanaOwner);
    await page.goto(`${origin}/ops#${brandPath()}/campaign`);
    const form = page.getByRole("form", { name: "Contenu de la campagne" });
    await form.getByLabel("Nom (pour l'équipe)").fill("Merci après un chalet");
    await form.getByLabel("Type").selectOption("after_visit");
    await form.getByLabel("Jours après le départ").fill("2");
    await form.getByLabel("Objet du courriel").fill("Merci {prénom} !");
    await form.getByLabel("Texte", { exact: true }).fill("Comment était {visite} ?");
    await form.getByRole("checkbox", { name: "Chalet" }).check();
    await form.getByText("2 jour(s) après son départ").waitFor();
    await form.getByRole("button", { name: "Créer le brouillon" }).click();
    await page.getByText("Automatique : en pause (J+2)").waitFor();
    await page.getByRole("button", { name: "Mettre en marche" }).click();
    await page.getByText("Automatique : en marche (J+2)").waitFor();
    const { rows } = await db.pool.query(`SELECT kind, delay_days, audience_categories, active FROM public.ticketing_campaigns WHERE name = 'Merci après un chalet'`);
    expect(rows).toEqual([{ kind: "after_visit", delay_days: 2, audience_categories: ["chalet"], active: true }]);
  });

  it("writes a text-message campaign with a live preview of what is sent (Run 46)", async () => {
    const page = await signedIn(seed.users.havanaOwner);
    await page.goto(`${origin}/ops#${brandPath()}/campaign`);
    const form = page.getByRole("form", { name: "Contenu de la campagne" });
    await form.getByLabel("Nom (pour l'équipe)").fill("Texto chalets");
    await form.getByLabel("Canal").selectOption("sms");
    await form.getByLabel("Texte du message").fill("Bonjour {prénom}, -20 % ce week-end !");
    await form.getByText("Bonjour Marie, -20 % ce week-end ! - Votre marque. Répondez STOP pour ne plus en recevoir.").waitFor();
    await form.getByText("1 texto(s) facturé(s) par client").waitFor();
    await form.getByRole("button", { name: "Créer le brouillon" }).click();
    await page.getByRole("heading", { name: "Texto chalets" }).waitFor();
    await page.getByText("- Havana Resort — Événements. Répondez STOP").waitFor();
    await page.getByLabel("Envoyer un essai au").waitFor();
    const { rows } = await db.pool.query(`SELECT channel, subject, body FROM public.ticketing_campaigns WHERE name = 'Texto chalets'`);
    expect(rows).toEqual([{ channel: "sms", subject: "Texto chalets", body: "Bonjour {prénom}, -20 % ce week-end !" }]);
  });

  it("sets the Brand's look with a live preview, refusing hard-to-read colours (Run 50)", async () => {
    const page = await signedIn(seed.users.havanaOwner);
    await page.context().route("https://cdn.example.com/**", (r) =>
      r.fulfill({ contentType: "image/svg+xml", body: `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="40"><rect width="160" height="40" fill="#fff"/></svg>` }));
    await page.goto(`${origin}/ops#${brandPath()}/appearance`);
    await page.getByRole("heading", { name: "Apparence" }).waitFor();
    // An SVG logo would be missing from many e-mail apps: the page says so.
    await page.getByLabel(/Adresse de l'image du logo/).fill("https://cdn.example.com/logo.svg");
    await page.getByText("n'affichent pas les images SVG", { exact: false }).waitFor();
    await page.getByLabel(/Adresse de l'image du logo/).fill("https://cdn.example.com/logo.png");
    await page.getByText("n'affichent pas les images SVG", { exact: false }).waitFor({ state: "detached" });
    await page.getByRole("region", { name: "Aperçu" }).getByRole("img", { name: "Havana Resort — Événements" }).waitFor();
    await page.getByLabel("Utiliser la couleur de la marque").check();
    await page.getByLabel("Couleur principale (bandeau, boutons)").fill("#ffd54f");
    // A yellow takes black text by itself.
    await page.getByText("Lisible", { exact: true }).waitFor();
    await page.getByLabel("Texte sur cette couleur").fill("#ffffff");
    await page.getByText("Trop peu lisible").waitFor();
    expect(await page.getByRole("button", { name: "Enregistrer" }).isDisabled()).toBe(true);
    await page.getByRole("button", { name: "Texte blanc ou noir, au plus lisible" }).click();
    await page.getByText("Lisible", { exact: true }).waitFor();
    expect(await page.locator(".look-band").evaluate((e) => (globalThis as any).getComputedStyle(e).backgroundColor)).toBe("rgb(255, 213, 79)");
    await page.getByLabel("Téléphone").fill("+1 514 555-0100");
    await page.getByRole("button", { name: "Enregistrer" }).click();
    await page.getByRole("status").getByText("Enregistré.", { exact: false }).waitFor();
    const { rows } = await db.pool.query(
      `SELECT logo_url, accent_color, on_accent_color, support_phone FROM public.ticketing_brand_settings WHERE client_id = $1 AND brand_id = $2`,
      [seed.havana.clientId, seed.havana.brandId],
    );
    expect(rows).toEqual([{ logo_url: "https://cdn.example.com/logo.png", accent_color: "#ffd54f", on_accent_color: "#000000", support_phone: "+1 514 555-0100" }]);

    // The event's photo, from the event page.
    await page.goto(`${origin}/ops#${brandPath()}/event/${seed.havana.eventId}`);
    page.once("dialog", (d) => void d.accept("https://cdn.example.com/photo.svg"));
    await page.getByRole("button", { name: "Ajouter une photo" }).click();
    await page.getByRole("button", { name: "Changer la photo" }).waitFor();
    expect(await page.locator("img.event-photo").getAttribute("src")).toBe("https://cdn.example.com/photo.svg");
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
    await stopServer(embedServer);
    await stopServer(parent);
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
