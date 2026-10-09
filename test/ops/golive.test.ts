import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { serve, type ServerType } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listMigrations } from "../../src/db/migrate.js";
import { checkDatabase, checkEnvironment, checkLive, type Check } from "../../src/ops/golive.js";
import { ipKind } from "../../src/api/client-ip.js";
import { call, stopServer, testApp, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { FakeGateway } from "../helpers/fake-gateway.js";
import { seedTwoTenants, TEST_CREDENTIAL_SECRET, type SeedResult } from "../helpers/seed.js";

/** Run 38: `npm run check:golive` reads settings, the database and the running service. */
let db: TestDatabase;
let seed: SeedResult;
let server: ServerType;
let origin: string;
let app: TestApp;

const secret = () => randomBytes(36).toString("base64url");
const GOOD: Record<string, string> = {
  DATABASE_URL: "postgres://alkao:db-password-never-shown@db.internal:5432/alkao",
  NODE_ENV: "production",
  ALKAO_OPERATIONAL_API_ENABLED: "true",
  ALKAO_CONTROL_KEYS: `takatak-1:${secret()}`,
  SUPABASE_JWKS_URL: "https://proj.supabase.co/auth/v1/.well-known/jwks.json",
  SUPABASE_URL: "https://proj.supabase.co",
  SUPABASE_ANON_KEY: `anon-${secret()}`,
  STRIPE_SECRET_KEY: `sk_live_${secret()}`,
  STRIPE_WEBHOOK_SECRET: `whsec_${secret()}`,
  ALKAO_STRIPE_ONBOARDING_REFRESH_URL: "https://billets.alkao.test/ops",
  ALKAO_STRIPE_ONBOARDING_RETURN_URL: "https://billets.alkao.test/ops",
  ALKAO_CREDENTIAL_MASTER_SECRET: secret(),
  ALKAO_PUBLIC_URL: "https://billets.alkao.test",
  RESEND_API_KEY: `re_${secret()}`,
  RESEND_WEBHOOK_SECRET: `whsec_${randomBytes(24).toString("base64")}`,
  ALKAO_EMAIL_FROM: "billets@alkao.test",
  ALKAO_METRICS_TOKEN: secret(),
  ALKAO_OPS_FRAME_ANCESTORS: "https://app.takatak.test",
};
const SECRETS = ["db-password-never-shown", GOOD.ALKAO_CONTROL_KEYS!.split(":")[1]!, GOOD.STRIPE_SECRET_KEY!, GOOD.STRIPE_WEBHOOK_SECRET!,
  GOOD.ALKAO_CREDENTIAL_MASTER_SECRET!, GOOD.RESEND_API_KEY!, GOOD.RESEND_WEBHOOK_SECRET!.slice(6), GOOD.ALKAO_METRICS_TOKEN!];

const of = (checks: Check[], status: Check["status"]) => checks.filter((c) => c.status === status).map((c) => `${c.area} : ${c.message}`);
const text = (checks: Check[]) => checks.map((c) => `${c.message} ${c.fix ?? ""}`).join("\n");

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  // The app is built once the port is known, so its public URL can be this server.
  server = await new Promise<ServerType>((resolve) => {
    const s = serve({ fetch: (req) => app.fetch(req), port: 0, hostname: "127.0.0.1" }, () => resolve(s));
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  await stopServer(server);
  await db?.drop();
});

const ready = (overrides: Parameters<typeof testApp>[1] = {}) =>
  testApp(db.pool, {
    paymentGateway: new FakeGateway(), paymentsMode: "live", credentialMasterSecret: TEST_CREDENTIAL_SECRET, publicUrl: origin, metricsToken: secret(),
    opsUi: { supabaseUrl: "https://proj.supabase.co", supabaseAnonKey: "anon-public-key-0123456789", frameAncestors: ["https://app.takatak.test"] },
    ...overrides,
  });

describe("go-live check: settings", () => {
  it("passes a complete production setup, and never repeats a secret", () => {
    const checks = checkEnvironment(GOOD);
    expect(of(checks, "fail")).toEqual([]);
    expect(of(checks, "warn")).toEqual([]);
    expect(text(checks)).toContain("takatak-1");
    expect(text(checks)).toContain("https://app.takatak.test");
    for (const s of SECRETS) expect(text(checks)).not.toContain(s);
  });

  it("names everything missing, from blocking to advice", () => {
    const checks = checkEnvironment({ DATABASE_URL: GOOD.DATABASE_URL });
    expect(of(checks, "fail").map((m) => m.split(" : ")[0])).toEqual([
      "Contrat de contrôle TAKATAK", "Connexion du personnel", "Connexion du personnel", "Paiements Stripe", "Paiements Stripe",
      "Codes QR et liens", "Codes QR et liens",
    ]);
    expect(of(checks, "warn").map((m) => m.split(" : ")[0])).toEqual(["Configuration", "Mise en service", "Courriels", "Surveillance"]);
    expect(of(checkEnvironment({}), "fail")).toContain("Base de données : DATABASE_URL manque");
  });

  it("refuses what the server would refuse, test keys, placeholders and bad origins", () => {
    const checks = checkEnvironment({
      ...GOOD, STRIPE_SECRET_KEY: "pk_live_abc", STRIPE_WEBHOOK_SECRET: "", ALKAO_CREDENTIAL_MASTER_SECRET: "change-me-change-me-change-me-change-me",
      ALKAO_OPS_FRAME_ANCESTORS: "https://app.takatak.test, https://bad.test/, http://bad.test",
    });
    const fails = of(checks, "fail");
    expect(fails).toContain("Configuration : STRIPE_SECRET_KEY : format invalide");
    expect(fails).toContain("Configuration : STRIPE_WEBHOOK_SECRET est vide");
    expect(fails).toContain("Codes QR et liens : ALKAO_CREDENTIAL_MASTER_SECRET ressemble à un exemple");
    expect(of(checks, "warn")).toContain("Intégration au tableau de bord TAKATAK : Origine(s) ignorée(s) : https://bad.test/, http://bad.test");
    expect(text(checks)).not.toContain("pk_live_abc");

    const test = checkEnvironment({ ...GOOD, STRIPE_SECRET_KEY: `sk_test_${secret()}` });
    expect(of(test, "fail")).toEqual([]);
    expect(of(test, "warn")).toEqual(["Paiements Stripe : Clé de TEST : aucun vrai paiement, le bandeau « Mode test » est affiché"]);
  });

  it("checks the optional Twilio setup for texts (Run 46)", () => {
    expect(of(checkEnvironment(GOOD), "ok")).toContain("Textos (SMS) : Non configurés (optionnel) : les campagnes par texto attendent dans la file");
    const sid = `AC${"0123456789abcdef".repeat(2)}`;
    const half = checkEnvironment({ ...GOOD, TWILIO_ACCOUNT_SID: sid });
    expect(of(half, "fail")).toEqual(["Textos (SMS) : Réglages Twilio incomplets : aucun texto ne part"]);
    const token = secret();
    const full = checkEnvironment({ ...GOOD, TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_MESSAGING_SERVICE_SID: `MG${"fedcba9876543210".repeat(2)}` });
    expect(of(full, "fail")).toEqual([]);
    expect(of(full, "ok")).toContain("Textos (SMS) : Twilio configuré (Messaging Service …3210). Webhook des réponses STOP : https://billets.alkao.test/v1/webhooks/twilio/sms");
    expect(text(full)).not.toContain(token);
  });

  it("asks for Resend's webhook, so dead addresses and complaints are taken off (Run 48)", () => {
    expect(of(checkEnvironment(GOOD), "ok")).toEqual(expect.arrayContaining([
      "Courriels : Rebonds et plaintes suivis (webhook https://billets.alkao.test/v1/webhooks/resend)",
      "Courriels : Campagnes : au plus 300 courriels par heure (ALKAO_CAMPAIGN_EMAILS_PER_HOUR)",
    ]));
    const { RESEND_WEBHOOK_SECRET: _, ...without } = GOOD;
    const checks = checkEnvironment({ ...without, ALKAO_CAMPAIGN_EMAILS_PER_HOUR: "1000" });
    expect(of(checks, "warn")).toEqual(["Courriels : RESEND_WEBHOOK_SECRET manque : les adresses qui rebondissent et les plaintes pour pourriel ne sont pas retirées"]);
    expect(checks.find((c) => c.message.startsWith("RESEND_WEBHOOK_SECRET"))!.fix).toContain("https://billets.alkao.test/v1/webhooks/resend");
    expect(of(checks, "ok")).toContain("Courriels : Campagnes : au plus 1000 courriels par heure (ALKAO_CAMPAIGN_EMAILS_PER_HOUR)");
    expect(of(checkEnvironment({ ...GOOD, ALKAO_CAMPAIGN_EMAILS_PER_HOUR: "300/h" }), "fail")).toEqual([
      "Courriels : ALKAO_CAMPAIGN_EMAILS_PER_HOUR n'est pas un nombre entier de 1 à 100000 : npm run cron n'envoie alors aucun courriel, billets compris",
    ]);
  });
});

describe("go-live check: database", () => {
  it("passes a migrated, set-up database", async () => {
    const checks = await checkDatabase(db.pool);
    expect(of(checks, "fail")).toEqual([]);
    expect(of(checks, "warn")).toEqual([]);
    expect(of(checks, "ok")).toContain(`Base de données : Les ${listMigrations().length} migrations sont appliquées`);
    expect(of(checks, "ok")).toContain("Sécurité des données : RLS active partout, rien pour anon, lecture seule pour le personnel connecté");
  });

  it("finds a hole in RLS or grants, a missing migration and code older than the database", async () => {
    const tx = await db.pool.connect();
    try {
      await tx.query("BEGIN");
      const last = listMigrations().at(-1)!.name;
      await tx.query(`ALTER TABLE public.ticketing_promo_codes DISABLE ROW LEVEL SECURITY`);
      await tx.query(`GRANT SELECT ON public.ticketing_buyers TO anon`);
      await tx.query(`GRANT INSERT ON public.ticketing_venues TO authenticated`);
      await tx.query(`CREATE POLICY golive_test ON public.ticketing_events FOR ALL TO authenticated USING (true)`);
      await tx.query(`DELETE FROM alkao_meta.schema_migrations WHERE name = $1`, [last]);
      await tx.query(`INSERT INTO alkao_meta.schema_migrations (name) VALUES ('29991231000100_from_the_future.sql')`);
      const checks = await checkDatabase(tx);
      expect(of(checks, "fail")).toEqual([
        `Base de données : 1 migration(s) sur ${listMigrations().length} manquante(s), à partir de ${last}`,
        "Sécurité des données : RLS désactivée sur : ticketing_promo_codes",
        "Sécurité des données : Politiques RLS autres que la lecture par « authenticated » sur : ticketing_events",
        "Sécurité des données : Le rôle anon (clé publique) a des droits sur : ticketing_buyers",
        "Sécurité des données : Le rôle authenticated peut écrire dans : ticketing_venues",
      ]);
      expect(of(checks, "warn")).toEqual(["Base de données : La base a 1 migration(s) que ce code ne connaît pas (29991231000100_from_the_future.sql)"]);
    } finally {
      await tx.query("ROLLBACK");
      tx.release();
    }
  });

  it("says when the background workers are behind or Stripe is unfinished", async () => {
    const tx = await db.pool.connect();
    try {
      await tx.query("BEGIN");
      const f = seed.festi;
      await tx.query(
        `INSERT INTO public.ticketing_holds (client_id, brand_id, event_id, session_id, quantity, expires_at, created_at)
         VALUES ($1, $2, $3, $4, 1, now() - interval '20 minutes', now() - interval '30 minutes')`,
        [f.clientId, f.brandId, f.eventId, f.sessionId],
      );
      await tx.query(`UPDATE public.ticketing_payment_accounts SET charges_enabled = false WHERE client_id = $1`, [f.clientId]);
      const checks = await checkDatabase(tx);
      expect(of(checks, "fail")).toEqual([]);
      const { rows } = await tx.query<{ name: string }>(`SELECT name FROM public.ticketing_clients WHERE id = $1`, [f.clientId]);
      expect(of(checks, "warn")).toEqual([
        `Clients et billetterie : Stripe pas encore terminé pour : ${rows[0]!.name}`,
        "Tâches de fond : 1 réservation(s) expirée(s) non libérée(s) : npm run worker:sweeper ne tourne pas",
      ]);
    } finally {
      await tx.query("ROLLBACK");
      tx.release();
    }
  });

  it("says when campaign e-mails, texts or sign-up confirmations are late, and when the welcome code does not exist (Runs 42–46)", async () => {
    const tx = await db.pool.connect();
    try {
      await tx.query("BEGIN");
      const h = seed.havana;
      const { rows: c } = await tx.query<{ id: string }>(
        `INSERT INTO public.ticketing_campaigns (client_id, brand_id, name, subject, heading, body) VALUES ($1, $2, 'Retard', 'Retard', 'Retard', 'Retard') RETURNING id`,
        [h.clientId, h.brandId],
      );
      await tx.query(
        `INSERT INTO public.ticketing_campaign_messages (client_id, brand_id, campaign_id, email, next_attempt_at) VALUES ($1, $2, $3, 'retard@example.com', now() - interval '2 hours')`,
        [h.clientId, h.brandId, c[0]!.id],
      );
      await tx.query(
        `INSERT INTO public.ticketing_campaign_messages (client_id, brand_id, campaign_id, phone, next_attempt_at) VALUES ($1, $2, $3, '5145550101', now() - interval '2 hours')`,
        [h.clientId, h.brandId, c[0]!.id],
      );
      await tx.query(
        `INSERT INTO public.ticketing_newsletter_signups (client_id, brand_id, email, next_attempt_at) VALUES ($1, $2, 'nouvelle@example.com', now() - interval '1 hour')`,
        [h.clientId, h.brandId],
      );
      await tx.query(
        `INSERT INTO public.ticketing_brand_settings (client_id, brand_id, newsletter_reward_code) VALUES ($1, $2, 'HAVANA5')
         ON CONFLICT (client_id, brand_id) DO UPDATE SET newsletter_reward_code = 'HAVANA5'`,
        [h.clientId, h.brandId],
      );
      const checks = await checkDatabase(tx);
      const warns = of(checks, "warn");
      expect(warns).toContain("Clients et billetterie : Le code de bienvenue HAVANA5 (Havana Resort — Événements) n'existe dans aucun événement : il sera refusé à la caisse");
      expect(warns).toContain("Tâches de fond : 1 courriel(s) de campagne en retard : npm run cron (ou worker:email) ne tourne pas ou échoue");
      expect(warns).toContain("Tâches de fond : 1 texto(s) de campagne en retard");
      expect(warns).toContain("Tâches de fond : 1 confirmation(s) d'inscription à l'infolettre en retard : la personne attend son courriel");
      await tx.query(`INSERT INTO public.ticketing_promo_codes (client_id, brand_id, event_id, code, kind, percent) VALUES ($1, $2, $3, 'HAVANA5', 'percent', 5)`, [h.clientId, h.brandId, h.eventId]);
      expect(of(await checkDatabase(tx), "warn").some((w) => w.includes("HAVANA5"))).toBe(false);
    } finally {
      await tx.query("ROLLBACK");
      tx.release();
    }
  });

  it("names a campaign held for its bounces, and does not call paced e-mails late (Run 48)", async () => {
    const tx = await db.pool.connect();
    try {
      await tx.query("BEGIN");
      const h = seed.havana;
      const campaign = async (name: string, held: boolean) => (await tx.query<{ id: string }>(
        `INSERT INTO public.ticketing_campaigns (client_id, brand_id, name, subject, heading, body, status, queued_at, held_at, held_reason)
         VALUES ($1, $2, $3, $3, $3, $3, 'sending', now(), ${held ? "now(), 'bounces'" : "NULL, NULL"}) RETURNING id`,
        [h.clientId, h.brandId, name],
      )).rows[0]!.id;
      const message = (id: string, email: string, sentAgo: string | null) => tx.query(
        sentAgo
          ? `INSERT INTO public.ticketing_campaign_messages (client_id, brand_id, campaign_id, email, status, sent_at) VALUES ($1, $2, $3, $4, 'sent', now() - $5::interval)`
          : `INSERT INTO public.ticketing_campaign_messages (client_id, brand_id, campaign_id, email, next_attempt_at) VALUES ($1, $2, $3, $4, now() - interval '2 hours')`,
        sentAgo ? [h.clientId, h.brandId, id, email, sentAgo] : [h.clientId, h.brandId, id, email],
      );
      const held = await campaign("Vieille liste", true);
      await message(held, "attend@example.com", null);
      let warns = of(await checkDatabase(tx), "warn");
      expect(warns).toContain("Tâches de fond : Campagne « Vieille liste » (Havana Resort — Événements) suspendue : trop d'adresses qui rebondissent");
      expect(warns.some((w) => w.includes("courriel(s) de campagne en retard"))).toBe(false);
      // Waiting while others go out at the hourly pace is not late either.
      const paced = await campaign("Au rythme", false);
      await message(paced, "plus-tard@example.com", null);
      await message(paced, "parti@example.com", "10 minutes");
      warns = of(await checkDatabase(tx), "warn");
      expect(warns.some((w) => w.includes("courriel(s) de campagne en retard"))).toBe(false);
    } finally {
      await tx.query("ROLLBACK");
      tx.release();
    }
  });

  it("asks for control:apply on a database with no Client yet", async () => {
    const empty = await createTestDatabase();
    try {
      const checks = await checkDatabase(empty.pool);
      expect(of(checks, "fail")).toEqual([]);
      expect(of(checks, "warn")).toEqual(["Clients et billetterie : Aucun Client configuré"]);
    } finally {
      await empty.drop();
    }
  });
});

describe("go-live check: the running service", () => {
  it("passes a ready deployment and finds the Brand's shop", async () => {
    app = ready();
    const f = seed.festi;
    const checks = await checkLive(origin, { clientId: f.clientId, brandId: f.brandId });
    expect(of(checks, "fail")).toEqual([]);
    expect(of(checks, "warn")).toEqual([]);
    expect(of(checks, "ok")).toEqual(expect.arrayContaining([
      "Paiements Stripe : Webhook en place : les envois non signés sont refusés",
      "Connexion du personnel : /ops prêt, affichable dans https://app.takatak.test",
      `Boutique : Boutique : ${origin}/acheter/${f.clientId}/${f.brandId}`,
    ]));
    expect(of(checks, "ok").find((m) => m.startsWith("Boutique : Billetterie active :"))).toBeDefined();
  });

  it("checks HTTPS and HSTS behind the real address", async () => {
    app = ready({ publicUrl: "https://billets.alkao.test", paymentsMode: "test" });
    // The host's proxy in front, adding the buyer's address as the last X-Forwarded-For entry.
    const viaProxy = (forwardedFor: string | null): typeof fetch => async (input, init) => {
      const req = new Request(String(input).replace("https://billets.alkao.test", "http://localhost"), init);
      if (forwardedFor) req.headers.set("x-forwarded-for", forwardedFor);
      return app.fetch(req);
    };
    const checks = await checkLive("https://billets.alkao.test", { fetch: viaProxy("203.0.113.9") });
    expect(of(checks, "fail")).toEqual([]);
    expect(of(checks, "ok")).toEqual(expect.arrayContaining([
      "Site en ligne : https://billets.alkao.test en HTTPS", "En-têtes de sécurité : HSTS actif",
      "En-têtes de sécurité : ALKAO voit l'adresse de chaque acheteur (limites par acheteur)",
    ]));
    expect(of(checks, "warn")).toEqual(["Paiements Stripe : Mode TEST : aucun vrai paiement, bandeau affiché aux acheteurs"]);

    // Without the buyer's address (a wrong ALKAO_TRUSTED_PROXY_HOPS), every buyer would share one limit.
    const blind = await checkLive("https://billets.alkao.test", { fetch: viaProxy(null) });
    expect(of(blind, "warn")).toContain(
      "En-têtes de sécurité : ALKAO ne voit pas l'adresse des acheteurs (unknown) : en pleine vente, tous partageraient la même limite de réservations",
    );
  });

  it("names what a half-configured deployment is missing", async () => {
    app = testApp(db.pool, { publicUrl: "https://ailleurs.alkao.test" });
    const checks = await checkLive(origin, { clientId: seed.festi.clientId, brandId: "00000000-0000-4000-8000-000000000000" });
    expect(of(checks, "fail")).toEqual([
      "Paiements Stripe : Paiements non configurés sur le serveur",
      "Paiements Stripe : Webhook coupé : paiements non configurés",
      "Connexion du personnel : /ops ne peut pas afficher la connexion (SUPABASE_URL, SUPABASE_ANON_KEY)",
      "Boutique : La billetterie n'est pas active pour cette Brand",
    ]);
    expect(of(checks, "warn")).toEqual([
      `Boutique : ALKAO_PUBLIC_URL (https://ailleurs.alkao.test) n'est pas l'adresse vérifiée (${origin})`,
      "En-têtes de sécurité : /metrics coupé : aucune alerte possible",
    ]);
  });

  it("tells a buyer's public address from a proxy's or none", async () => {
    expect(["203.0.113.9", "2001:db8::1", "::ffff:198.51.100.7"].map(ipKind)).toEqual(["public", "public", "public"]);
    expect(["10.0.0.5", "172.20.1.1", "192.168.1.2", "127.0.0.1", "100.64.0.1", "::1", "fd00::1", "fe80::1"].map(ipKind)).toEqual(Array(8).fill("private"));
    expect(["", "unknown"].map(ipKind)).toEqual(["unknown", "unknown"]);
    const local = testApp(db.pool);
    expect((await call(local, "GET", "/health/client", { headers: { "x-forwarded-for": "10.1.1.1, 203.0.113.9" } })).body).toEqual({ ok: true, client: "public" });
    expect((await call(local, "GET", "/health/client", { headers: { "x-forwarded-for": "10.0.0.5" } })).body).toEqual({ ok: true, client: "private" });
    expect((await call(local, "GET", "/health/client")).body).toEqual({ ok: true, client: "unknown" });
  });

  it("says when it cannot reach the service, or it is not served over HTTPS", async () => {
    const down: typeof fetch = async () => { throw new Error("ECONNREFUSED"); };
    expect(of(await checkLive("http://billets.alkao.test", { fetch: down }), "fail")).toEqual([
      "Site en ligne : http://billets.alkao.test n'est pas en HTTPS",
      "Site en ligne : Injoignable",
    ]);
    expect(of(await checkLive("pas une adresse"), "fail")).toEqual(["Site en ligne : Adresse invalide : pas une adresse"]);
  });
});

describe("npm run check:golive", () => {
  const run = (args: string[], env: Record<string, string>) =>
    promisify(execFile)(process.execPath, ["--import", "tsx", "scripts/golive-check.ts", ...args], { env: { PATH: process.env.PATH!, ...env } })
      .then((r) => ({ code: 0, out: r.stdout }), (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, out: e.stdout, err: e.stderr }));

  it("exits 0 with only warnings, 1 with a blocking problem, and prints no secret", async () => {
    app = ready();
    const good = await run(["--url", origin], { ...GOOD, DATABASE_URL: db.url, NODE_ENV: "production" });
    expect(good.out, JSON.stringify(good)).toContain("Réglages de ce serveur");
    expect(good.out).toContain("Base de données");
    expect(good.out).toContain(`Service en ligne : ${origin}`);
    expect(good.out).toContain("Résultat : rien de bloquant");
    expect(good.code).toBe(0);
    for (const s of SECRETS) expect(good.out).not.toContain(s);

    // From another computer: only the service, which here has no payments.
    app = testApp(db.pool, { publicUrl: origin });
    const remote = await run(["--url", origin], {});
    expect(remote.out).not.toContain("Réglages de ce serveur");
    expect(remote.out).toContain("✘ Paiements Stripe : Paiements non configurés sur le serveur");
    expect(remote.code).toBe(1);
  }, 60_000);
});
