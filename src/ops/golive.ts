import { EnvSchema, frameAncestorOrigins, parseControlKeys, stripeKeyMode } from "../config.js";
import { listMigrations } from "../db/migrate.js";
import type { Db, Tx } from "../db/pool.js";

/**
 * Run 38: the go-live check (`npm run check:golive`). It reads, never writes: the settings
 * of this deployment, its database (migrations, RLS, grants, setup, background workers) and,
 * given its URL, the running service as a buyer or Stripe would reach it.
 *
 * Messages are in French, for whoever turns ALKAO on. They never contain a secret: only
 * whether it is set, and the public values (origins, sender address, key ids).
 */
export type CheckStatus = "ok" | "warn" | "fail";
export interface Check {
  area: string;
  status: CheckStatus;
  message: string;
  fix?: string;
}

const ok = (area: string, message: string): Check => ({ area, status: "ok", message });
const warn = (area: string, message: string, fix?: string): Check => ({ area, status: "warn", message, ...(fix ? { fix } : {}) });
const fail = (area: string, message: string, fix?: string): Check => ({ area, status: "fail", message, ...(fix ? { fix } : {}) });

/** A secret that looks like a placeholder or has almost no variety. */
export function weakSecret(value: string): boolean {
  return new Set(value).size < 10 || /change.?me|example|replace|placeholder|secret123|password/i.test(value);
}

const ISSUE_TEXT: Record<string, string> = {
  invalid_type: "manquante ou du mauvais type",
  too_small: "trop courte ou trop petite",
  too_big: "trop longue ou trop grande",
  invalid_format: "format invalide",
  invalid_value: "valeur non permise",
};

// ── Settings ────────────────────────────────────────────────────────────────
export function checkEnvironment(env: NodeJS.ProcessEnv): Check[] {
  const out: Check[] = [];
  const has = (k: string) => Boolean(env[k]?.trim());
  const area = {
    config: "Configuration", db: "Base de données", switch: "Mise en service", control: "Contrat de contrôle TAKATAK",
    auth: "Connexion du personnel", stripe: "Paiements Stripe", qr: "Codes QR et liens", email: "Courriels",
    monitoring: "Surveillance", embed: "Intégration au tableau de bord TAKATAK",
  };

  // The server refuses to start on any of these: report them all, never the values.
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const name = String(issue.path[0] ?? "?");
      if (env[name] === undefined) continue; // a missing required setting is reported below
      out.push(env[name]!.trim() === ""
        ? fail(area.config, `${name} est vide`, `Retirez ${name} ou donnez-lui une valeur : le serveur refuse de démarrer.`)
        : fail(area.config, `${name} : ${ISSUE_TEXT[issue.code] ?? "valeur refusée"}`, `Corrigez ${name} : le serveur refuse de démarrer tant qu'elle est invalide.`));
    }
  }

  out.push(has("DATABASE_URL") ? ok(area.db, "DATABASE_URL est définie") : fail(area.db, "DATABASE_URL manque", "L'adresse de la base dédiée à ALKAO (jamais celle de TAKATAK ou de FESTI-ICE)."));
  out.push(env.NODE_ENV === "production"
    ? ok(area.config, "NODE_ENV=production")
    : warn(area.config, "NODE_ENV n'est pas « production »", "NODE_ENV=production en ligne : /ops n'accepte alors aucune origine http://localhost."));

  out.push(/^(true|1)$/.test(env.ALKAO_OPERATIONAL_API_ENABLED ?? "")
    ? ok(area.switch, "API activée : les Brands dont la billetterie est active peuvent vendre")
    : warn(area.switch, "API désactivée (par défaut) : aucune vente, et /ops refuse tout", "Dernière étape, quand tout le reste est prêt : ALKAO_OPERATIONAL_API_ENABLED=true."));

  try {
    const keys = parseControlKeys(env.ALKAO_CONTROL_KEYS);
    if (keys.size === 0) out.push(fail(area.control, "ALKAO_CONTROL_KEYS manque : impossible de configurer les Clients", "Une paire kid:secret (secret de 32 caractères ou plus), aussi donnée à npm run control:apply."));
    else if ([...keys.values()].some(weakSecret)) out.push(fail(area.control, "Un secret de ALKAO_CONTROL_KEYS ressemble à un exemple", "Générez-le : openssl rand -base64 48."));
    else out.push(ok(area.control, `${keys.size} clé(s) : ${[...keys.keys()].join(", ")}`));
  } catch {
    out.push(fail(area.control, "ALKAO_CONTROL_KEYS est mal formée", "Des paires kid:secret séparées par des virgules, secrets de 32 caractères ou plus."));
  }

  out.push(has("SUPABASE_JWKS_URL") || has("SUPABASE_JWT_SECRET")
    ? ok(area.auth, "Vérification des jetons Supabase configurée")
    : fail(area.auth, "Ni SUPABASE_JWKS_URL ni SUPABASE_JWT_SECRET : personne ne peut se connecter", "Le même projet Supabase que TAKATAK, pour que le personnel garde son compte."));
  out.push(has("SUPABASE_URL") && has("SUPABASE_ANON_KEY")
    ? ok(area.auth, "Écran de connexion de /ops configuré")
    : fail(area.auth, "SUPABASE_URL ou SUPABASE_ANON_KEY manque : /ops ne peut pas afficher la connexion"));

  if (has("STRIPE_SECRET_KEY") && has("STRIPE_WEBHOOK_SECRET")) {
    out.push(stripeKeyMode(env.STRIPE_SECRET_KEY!.trim()) === "test"
      ? warn(area.stripe, "Clé de TEST : aucun vrai paiement, le bandeau « Mode test » est affiché", "Avant la première vraie vente : la clé sk_live_ et le secret du webhook live.")
      : ok(area.stripe, "Clé LIVE : les paiements sont réels"));
  } else if (has("STRIPE_SECRET_KEY") || has("STRIPE_WEBHOOK_SECRET")) {
    out.push(fail(area.stripe, "Il faut STRIPE_SECRET_KEY et STRIPE_WEBHOOK_SECRET ensemble : les paiements restent coupés"));
  } else {
    out.push(fail(area.stripe, "Paiements non configurés : seules les commandes gratuites passent", "STRIPE_SECRET_KEY et le secret du webhook Connect https://…/v1/webhooks/stripe."));
  }
  out.push(has("ALKAO_STRIPE_ONBOARDING_REFRESH_URL") && has("ALKAO_STRIPE_ONBOARDING_RETURN_URL")
    ? ok(area.stripe, "Adresses de connexion Stripe des Clients définies")
    : fail(area.stripe, "ALKAO_STRIPE_ONBOARDING_REFRESH_URL ou _RETURN_URL manque : un Client ne peut pas connecter son compte Stripe"));

  if (!has("ALKAO_CREDENTIAL_MASTER_SECRET")) out.push(fail(area.qr, "ALKAO_CREDENTIAL_MASTER_SECRET manque : ni codes QR ni liens personnels", "Générez-le : openssl rand -base64 48."));
  else if (weakSecret(env.ALKAO_CREDENTIAL_MASTER_SECRET!)) out.push(fail(area.qr, "ALKAO_CREDENTIAL_MASTER_SECRET ressemble à un exemple", "Générez-le : openssl rand -base64 48, avant la première vente."));
  else out.push(ok(area.qr, "Secret des codes QR défini. Ne le changez jamais après le lancement : tous les codes QR cesseraient de fonctionner"));
  const publicUrl = EnvSchema.shape.ALKAO_PUBLIC_URL.safeParse(env.ALKAO_PUBLIC_URL).data;
  out.push(publicUrl
    ? ok(area.qr, `Adresse publique : ${new URL(publicUrl).origin}`)
    : fail(area.qr, "ALKAO_PUBLIC_URL manque ou n'est pas en https:// : liens des courriels et retour de paiement impossibles"));

  out.push(has("RESEND_API_KEY") && has("ALKAO_EMAIL_FROM")
    ? ok(area.email, `Expéditeur : ${env.ALKAO_EMAIL_FROM!.trim()}`)
    : warn(area.email, "RESEND_API_KEY ou ALKAO_EMAIL_FROM manque ici", "À définir là où tourne npm run worker:email : sans elles, aucun courriel de billets n'est envoyé."));

  if (!has("ALKAO_METRICS_TOKEN")) out.push(warn(area.monitoring, "ALKAO_METRICS_TOKEN manque : GET /metrics est coupé, donc aucune alerte", "Un jeton de 32 caractères ou plus, et les alertes de docs/ALKAO_RUNBOOK.md."));
  else if (weakSecret(env.ALKAO_METRICS_TOKEN!)) out.push(fail(area.monitoring, "ALKAO_METRICS_TOKEN ressemble à un exemple", "Générez-le : openssl rand -base64 48."));
  else out.push(ok(area.monitoring, "GET /metrics protégé par jeton"));

  const raw = (env.ALKAO_OPS_FRAME_ANCESTORS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (raw.length === 0) {
    out.push(ok(area.embed, "Aucune (optionnel : seulement pour afficher /ops dans le tableau de bord TAKATAK)"));
  } else {
    const accepted = frameAncestorOrigins(env.ALKAO_OPS_FRAME_ANCESTORS, env.NODE_ENV);
    const ignored = raw.filter((o) => !accepted.includes(o));
    if (accepted.length) out.push(ok(area.embed, `/ops peut s'afficher dans : ${accepted.join(", ")}`));
    if (ignored.length) out.push(warn(area.embed, `Origine(s) ignorée(s) : ${ignored.join(", ")}`, "Une origine https://hôte, sans chemin ni barre finale."));
  }
  return out;
}

// ── Database ────────────────────────────────────────────────────────────────
export async function checkDatabase(q: Db | Tx, now = new Date()): Promise<Check[]> {
  const out: Check[] = [];
  const area = { db: "Base de données", security: "Sécurité des données", setup: "Clients et billetterie", workers: "Tâches de fond" };
  try {
    const { rows } = await q.query<{ v: string }>(`SELECT current_setting('server_version') AS v`);
    out.push(ok(area.db, `PostgreSQL ${rows[0]!.v} répond`));
  } catch (error) {
    out.push(fail(area.db, `Connexion impossible : ${(error as Error).message}`, "Vérifiez DATABASE_URL et que la base accepte les connexions de ce serveur."));
    return out;
  }

  // Migrations: the ALKAO runner's table, or the Supabase CLI's (by version prefix).
  const files = listMigrations().map((m) => m.name);
  const { rows: where } = await q.query<{ alkao: boolean; supa: boolean }>(
    `SELECT to_regclass('alkao_meta.schema_migrations') IS NOT NULL AS alkao, to_regclass('supabase_migrations.schema_migrations') IS NOT NULL AS supa`,
  );
  let applied: Set<string> | null = null;
  if (where[0]!.alkao) {
    applied = new Set((await q.query<{ name: string }>(`SELECT name FROM alkao_meta.schema_migrations`)).rows.map((r) => r.name));
  } else if (where[0]!.supa) {
    const versions = new Set((await q.query<{ version: string }>(`SELECT version FROM supabase_migrations.schema_migrations`)).rows.map((r) => r.version));
    applied = new Set(files.filter((f) => versions.has(f.slice(0, 14))));
  }
  if (!applied) {
    out.push(fail(area.db, "Aucune migration ALKAO appliquée", "npm run db:migrate (PostgreSQL) ou supabase db push (projet Supabase dédié)."));
    return out;
  }
  const missing = files.filter((f) => !applied.has(f));
  out.push(missing.length
    ? fail(area.db, `${missing.length} migration(s) sur ${files.length} manquante(s), à partir de ${missing[0]}`, "npm run db:migrate (PostgreSQL) ou supabase db push (Supabase), avant de démarrer ce code.")
    : ok(area.db, `Les ${files.length} migrations sont appliquées`));
  if (where[0]!.alkao) {
    const unknown = [...applied].filter((name) => !files.includes(name));
    if (unknown.length) out.push(warn(area.db, `La base a ${unknown.length} migration(s) que ce code ne connaît pas (${unknown[0]})`, "Ce code est plus ancien que la base : déployez la dernière version."));
  }

  const { rows: env } = await q.query<{ roles: string[]; trgm: boolean }>(
    `SELECT ARRAY(SELECT r FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) r WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r)) AS roles,
            EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') AS trgm`,
  );
  if (env[0]!.roles.length) out.push(fail(area.db, `Rôles Supabase manquants : ${env[0]!.roles.join(", ")}`, "Sur PostgreSQL seul : psql -f supabase/tests/supabase_shim.sql, une fois."));
  if (!env[0]!.trgm) out.push(fail(area.db, "Extension pg_trgm absente : la recherche de commandes ne marche pas", "Elle est créée par les migrations ; vérifiez qu'elles sont toutes passées."));
  if (env[0]!.roles.length) return out;

  // The same rules as test/db/rls.test.ts, on the real database.
  const { rows: sec } = await q.query<{ no_rls: string[]; bad_policies: string[]; anon: string[]; writable: string[]; private_usage: boolean }>(
    `WITH t AS (
       SELECT c.oid, c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname LIKE 'ticketing\\_%'
     )
     SELECT ARRAY(SELECT relname::text FROM t WHERE NOT relrowsecurity ORDER BY 1) AS no_rls,
            ARRAY(SELECT DISTINCT tablename::text FROM pg_policies WHERE schemaname = 'public' AND tablename LIKE 'ticketing\\_%'
                  AND (cmd <> 'SELECT' OR roles <> ARRAY['authenticated']::name[]) ORDER BY 1) AS bad_policies,
            ARRAY(SELECT relname::text FROM t WHERE has_table_privilege('anon', oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') ORDER BY 1) AS anon,
            ARRAY(SELECT relname::text FROM t WHERE has_table_privilege('authenticated', oid, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') ORDER BY 1) AS writable,
            coalesce(has_schema_privilege('anon', to_regnamespace('alkao_private'), 'USAGE'), false) AS private_usage`,
  );
  const s = sec[0]!;
  const list = (names: string[]) => names.slice(0, 5).join(", ") + (names.length > 5 ? ` (+${names.length - 5})` : "");
  if (s.no_rls.length) out.push(fail(area.security, `RLS désactivée sur : ${list(s.no_rls)}`, "Réactivez-la (ALTER TABLE … ENABLE ROW LEVEL SECURITY) : chaque table ticketing_* l'exige."));
  if (s.bad_policies.length) out.push(fail(area.security, `Politiques RLS autres que la lecture par « authenticated » sur : ${list(s.bad_policies)}`, "Supprimez les politiques ajoutées à la main : ALKAO n'écrit que par le serveur."));
  if (s.anon.length) out.push(fail(area.security, `Le rôle anon (clé publique) a des droits sur : ${list(s.anon)}`, "REVOKE ALL ON TABLE … FROM PUBLIC, anon ; anon ne doit rien lire ni écrire."));
  if (s.writable.length) out.push(fail(area.security, `Le rôle authenticated peut écrire dans : ${list(s.writable)}`, "REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE … FROM authenticated."));
  if (s.private_usage) out.push(fail(area.security, "Le rôle anon peut utiliser le schéma alkao_private", "REVOKE ALL ON SCHEMA alkao_private FROM PUBLIC, anon."));
  if (!s.no_rls.length && !s.bad_policies.length && !s.anon.length && !s.writable.length && !s.private_usage) {
    out.push(ok(area.security, "RLS active partout, rien pour anon, lecture seule pour le personnel connecté"));
  }
  if (missing.length) return out;

  const { rows: setup } = await q.query<{ clients: number; brands: number; selling: number; members: number }>(
    `SELECT (SELECT count(*) FROM public.ticketing_clients WHERE status = 'active')::int AS clients,
            (SELECT count(*) FROM public.ticketing_brands WHERE status = 'active')::int AS brands,
            (SELECT count(*) FROM public.ticketing_entitlements WHERE status = 'active'
               AND (valid_from IS NULL OR valid_from <= $1) AND (valid_until IS NULL OR valid_until > $1))::int AS selling,
            (SELECT count(*) FROM public.ticketing_memberships WHERE status = 'active')::int AS members`,
    [now],
  );
  const u = setup[0]!;
  if (u.clients === 0) {
    out.push(warn(area.setup, "Aucun Client configuré", "npm run control:apply -- plan.json (docs/ALKAO_GO_LIVE.md, étape 3)."));
  } else {
    out.push(ok(area.setup, `${u.clients} Client(s), ${u.brands} Brand(s), ${u.members} membre(s) du personnel`));
    out.push(u.selling
      ? ok(area.setup, `Billetterie active pour ${u.selling} Brand(s)`)
      : warn(area.setup, "Aucune Brand n'a la billetterie active", "Dans le plan de control:apply : \"ticketing\": { \"status\": \"active\" }."));
    const { rows: unpaid } = await q.query<{ name: string }>(
      `SELECT c.name FROM public.ticketing_clients c
       WHERE c.status = 'active'
         AND EXISTS (SELECT 1 FROM public.ticketing_entitlements e WHERE e.client_id = c.id AND e.status = 'active')
         AND NOT EXISTS (SELECT 1 FROM public.ticketing_payment_accounts p WHERE p.client_id = c.id AND p.charges_enabled)
       ORDER BY c.name`,
    );
    if (unpaid.length) out.push(warn(area.setup, `Stripe pas encore terminé pour : ${unpaid.map((r) => r.name).join(", ")}`, "Un propriétaire du Client ouvre /ops → Paiements et termine la connexion Stripe."));
  }

  const { rows: lag } = await q.query<{ unswept: number; email_due: number | null; cancellations: number; refunds: number }>(
    `SELECT (SELECT count(*) FROM public.ticketing_holds WHERE status = 'active' AND expires_at < $1::timestamptz - interval '5 minutes')::int AS unswept,
            (SELECT extract(epoch FROM $1::timestamptz - min(next_attempt_at)) FROM public.ticketing_email_outbox
              WHERE status = 'pending' AND next_attempt_at <= $1)::float AS email_due,
            (SELECT count(*) FROM public.ticketing_session_cancellations WHERE status = 'running' AND created_at < $1::timestamptz - interval '30 minutes')::int AS cancellations,
            (SELECT count(*) FROM public.ticketing_refunds WHERE status = 'pending'
              AND (last_error IS NOT NULL OR created_at < $1::timestamptz - interval '15 minutes'))::int AS refunds`,
    [now],
  );
  const l = lag[0]!;
  const late: Check[] = [];
  if (l.unswept) late.push(warn(area.workers, `${l.unswept} réservation(s) expirée(s) non libérée(s) : npm run worker:sweeper ne tourne pas`));
  if ((l.email_due ?? 0) > 600) late.push(warn(area.workers, `Un courriel attend depuis ${Math.round(l.email_due! / 60)} min : npm run worker:email ne tourne pas ou échoue`));
  if (l.cancellations) late.push(warn(area.workers, `${l.cancellations} annulation(s) de séance en cours depuis plus de 30 min`, "npm run worker:cancellations doit tourner ; voir « À traiter » dans /ops."));
  if (l.refunds) late.push(warn(area.workers, `${l.refunds} remboursement(s) bloqué(s)`, "/ops → À traiter, puis docs/ALKAO_RUNBOOK.md."));
  out.push(...(late.length ? late : [ok(area.workers, "Rien en retard (réservations, courriels, annulations, remboursements)")]));
  return out;
}

// ── The running service ─────────────────────────────────────────────────────
export async function checkLive(
  base: string,
  opts: { clientId?: string | undefined; brandId?: string | undefined; fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<Check[]> {
  const out: Check[] = [];
  const area = { site: "Site en ligne", security: "En-têtes de sécurité", stripe: "Paiements Stripe", auth: "Connexion du personnel", shop: "Boutique" };
  const doFetch = opts.fetch ?? fetch;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return [fail(area.site, `Adresse invalide : ${base}`)];
  }
  const origin = url.origin;
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol === "https:") out.push(ok(area.site, `${origin} en HTTPS`));
  else if (local) out.push(ok(area.site, `${origin} (essai local, sans HTTPS)`));
  else out.push(fail(area.site, `${origin} n'est pas en HTTPS`, "Placez ALKAO derrière HTTPS : paiements, codes QR et connexion l'exigent."));

  // A network error mid-way reads as status 0, so the other checks still report.
  const get = (path: string, init: RequestInit = {}) =>
    doFetch(`${origin}${path}`, { redirect: "manual", signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000), ...init }).catch(() => Response.error());
  const json = async (r: Response) => (await r.json().catch(() => null)) as Record<string, unknown> | null;

  const health = await get("/health");
  if (health.status === 0) {
    out.push(fail(area.site, "Injoignable", "Vérifiez l'adresse, le DNS et que npm start tourne."));
    return out;
  }
  const h = await json(health);
  if (health.status !== 200 || h?.service !== "alkao") {
    out.push(fail(area.site, `/health répond ${health.status} : ce n'est pas ALKAO`));
    return out;
  }
  out.push(ok(area.site, `ALKAO répond (API ${String(h.api)}, contrat ${String(h.control)})`));
  const ready = await get("/health/ready");
  out.push(ready.status === 200 ? ok(area.site, "Base de données joignable (/health/ready)") : fail(area.site, `/health/ready répond ${ready.status} : la base ne répond pas`, "Vérifiez DATABASE_URL du serveur."));
  if (url.protocol === "https:") {
    out.push(health.headers.get("strict-transport-security")
      ? ok(area.security, "HSTS actif")
      : fail(area.security, "Pas d'en-tête HSTS", "ALKAO_PUBLIC_URL doit être l'adresse https:// du serveur."));
  }

  const shop = await json(await get("/shop/config.json"));
  if (!shop?.publicUrl) out.push(fail(area.shop, "ALKAO_PUBLIC_URL n'est pas définie sur le serveur"));
  else if (shop.publicUrl !== origin) out.push(warn(area.shop, `ALKAO_PUBLIC_URL (${String(shop.publicUrl)}) n'est pas l'adresse vérifiée (${origin})`, "Les liens des courriels et le retour de paiement mèneront à ALKAO_PUBLIC_URL."));
  else out.push(ok(area.shop, "ALKAO_PUBLIC_URL correspond à cette adresse"));
  if (shop?.paymentsMode === "live") out.push(ok(area.stripe, "Mode LIVE : les paiements sont réels"));
  else if (shop?.paymentsMode === "test") out.push(warn(area.stripe, "Mode TEST : aucun vrai paiement, bandeau affiché aux acheteurs", "Avant la première vraie vente : clé sk_live_ et secret du webhook live."));
  else out.push(fail(area.stripe, "Paiements non configurés sur le serveur"));

  // Unsigned, so Stripe's signature check refuses it before anything is read or written.
  const hook = await get("/v1/webhooks/stripe", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
  if (hook.status === 400) out.push(ok(area.stripe, "Webhook en place : les envois non signés sont refusés"));
  else if (hook.status === 503) out.push(fail(area.stripe, "Webhook coupé : paiements non configurés"));
  else out.push(fail(area.stripe, `Webhook répond ${hook.status} au lieu de 400`, "Vérifiez que /v1/webhooks/stripe arrive bien à ALKAO (proxy, chemin)."));

  const ops = await json(await get("/ops/config.json"));
  const embed = Array.isArray(ops?.embedOrigins) ? (ops.embedOrigins as string[]) : [];
  out.push(ops?.supabaseUrl && ops?.supabaseAnonKey
    ? ok(area.auth, `/ops prêt${embed.length ? `, affichable dans ${embed.join(", ")}` : ""}`)
    : fail(area.auth, "/ops ne peut pas afficher la connexion (SUPABASE_URL, SUPABASE_ANON_KEY)"));

  const billets = await get("/billets");
  const csp = billets.headers.get("content-security-policy") ?? "";
  out.push(billets.status === 200 && csp.includes("frame-ancestors 'none'") && /noindex/.test(billets.headers.get("x-robots-tag") ?? "")
    ? ok(area.security, "/billets : politique de sécurité stricte, jamais indexé")
    : fail(area.security, "/billets n'a pas ses en-têtes de sécurité", "Un proxy les retire peut-être : ils doivent passer tels quels."));
  const metrics = await get("/metrics");
  if (metrics.status === 401) out.push(ok(area.security, "/metrics protégé par jeton"));
  else if (metrics.status === 404) out.push(warn(area.security, "/metrics coupé : aucune alerte possible", "ALKAO_METRICS_TOKEN sur le serveur."));
  else out.push(fail(area.security, `/metrics répond ${metrics.status} sans jeton`));

  if (opts.clientId && opts.brandId) {
    const path = `/v1/public/clients/${encodeURIComponent(opts.clientId)}/brands/${encodeURIComponent(opts.brandId)}`;
    const events = await get(`${path}/events`);
    const list = (await json(events))?.events;
    if (events.status === 200 && Array.isArray(list)) {
      out.push(list.length
        ? ok(area.shop, `Billetterie active : ${list.length} événement(s) publié(s)`)
        : warn(area.shop, "Billetterie active, mais aucun événement publié", "Dans /ops : créer l'événement, ses séances et types de billets, puis publier."));
      const page = await get(`/acheter/${encodeURIComponent(opts.clientId)}/${encodeURIComponent(opts.brandId)}`);
      out.push(page.status === 200 ? ok(area.shop, `Boutique : ${origin}/acheter/${opts.clientId}/${opts.brandId}`) : fail(area.shop, `/acheter répond ${page.status}`));
    } else {
      out.push(fail(area.shop, "La billetterie n'est pas active pour cette Brand",
        "ALKAO_OPERATIONAL_API_ENABLED=true, puis control:apply avec ce Client, cette Brand et \"ticketing\": { \"status\": \"active\" }."));
    }
  }
  return out;
}
