import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import * as api from "../contracts/api-v1.js";
import { CONTROL_CONTRACT_VERSION, ControlEvent, ControlStateRequest } from "../contracts/control-v1.js";
import * as catalog from "../db/catalog.js";
import { createHold, releaseHold, type TenantScope } from "../db/commerce.js";
import { loadGateRecords, loadMembershipRole } from "../db/gate.js";
import { withTransaction, type Db } from "../db/pool.js";
import { applyControlEvent, readControlState } from "../db/projections.js";
import { evaluateTicketingGate, type GateDecision } from "../domain/entitlement.js";
import { DomainError } from "../domain/errors.js";
import { isUuid } from "../domain/ids.js";
import { isSessionSellable } from "../domain/lifecycle.js";
import { rulesOnSale } from "../domain/catalog.js";
import { roleHasPermission, type TicketingPermission, type WorkspaceRole } from "../domain/permissions.js";
import { buildQuote, promoApplies } from "../domain/pricing.js";
import { AuthError, type AuthVerifier } from "./auth.js";
import { verifyControlSignature } from "./control-signature.js";
import { errorResponse, fail, readJson } from "./http.js";
import { FixedWindowLimiter } from "./rate-limit.js";
import { WebhookSignatureError, type PaymentGateway } from "../payments/gateway.js";
import { PaymentsService } from "../payments/service.js";
import * as paymentsDb from "../db/payments.js";
import * as appearanceDb from "../db/appearance.js";
import { orderOptions, sessionOptions } from "../db/options.js";
import { assertReadableColours } from "../domain/appearance.js";
import * as credentialsDb from "../db/credentials.js";
import { CredentialsService } from "../scanner/service.js";
import { toCsv } from "../ops/csv.js";
import * as findTickets from "../delivery/find-tickets.js";
import * as attention from "../ops/attention.js";
import * as duplicate from "../ops/duplicate.js";
import * as metrics from "../ops/metrics.js";
import * as reminders from "../delivery/reminders.js";
import * as privacy from "../ops/privacy.js";
import * as reports from "../ops/reports.js";
import * as promoDb from "../db/promo.js";
import * as customersDb from "../db/customers.js";
import * as campaignsDb from "../db/campaigns.js";
import { mountUnsubscribe } from "./unsubscribe.js";
import * as newsletterDb from "../db/newsletter.js";
import { mountNewsletterPage } from "./newsletter-page.js";
import { replyIntent, twilioSignatureValid } from "../delivery/sms.js";
import { emailEventOf, resendSignatureValid } from "../delivery/bounces.js";
import { normalizePhone } from "../domain/customers.js";
import { localDate } from "../domain/customers.js";
import * as journal from "../ops/journal.js";
import * as sessionBatch from "../ops/session-batch.js";
import { exchangeOrder } from "../ops/exchange.js";
import { mountOpsUi, type OpsUiConfig } from "./ops-ui.js";
import { mountBuyerUi } from "./buyer-ui.js";
import { mountShopUi } from "./shop-ui.js";
import { mountHome, type HomeBrand } from "./home.js";
import { migrationNames, schemaState } from "../db/migrate.js";
import * as waitlist from "../delivery/waitlist.js";
import * as presaleDb from "../db/presale.js";
import { clientIp, ipKind } from "./client-ip.js";
import * as delivery from "../delivery/db.js";
import { orderEmailToken } from "../delivery/links.js";
import { validOrderAccessToken } from "./order-token.js";
import { prepareTransferInvitation, cancelTransferInvitation } from "../ops/transfer-request.js";
import { acceptTransferInvitation, transferredCredentialForRecipient } from "../ops/transfer-acceptance.js";
import * as cancellation from "../ops/cancellation.js";
import * as changeNotice from "../ops/change-notice.js";
import * as drafts from "../ai/drafts.js";
import { WriterError, type Writer } from "../ai/writer.js";

export const API_VERSION = "alkao.api.v1";

export interface AppDeps {
  db: Db;
  auth: AuthVerifier;
  operationalApiEnabled: boolean;
  controlKeys: ReadonlyMap<string, string>;
  holdTtlSeconds: number;
  publicHoldsPerMinute: number;
  /** Stripe Connect gateway; null until payments are configured. */
  paymentGateway?: PaymentGateway | null;
  /** Run 32: Stripe test or live mode, shown to staff and buyers when it is test. */
  paymentsMode?: "test" | "live" | null;
  /** Where Stripe sends a Client admin during and after account onboarding. */
  onboarding?: { refreshUrl: string; returnUrl: string } | null;
  /** Secret from which Client credential (QR) signing keys are derived; null until configured. */
  credentialMasterSecret?: string | null;
  /** Run 80: explicit global release gate for transfer API, OFF by default. */
  transferApiEnabled?: boolean;
  /** Standalone Operations web app served under /ops. */
  opsUi?: OpsUiConfig;
  /** Public HTTPS URL of this ALKAO deployment (hosted shop, ticket links). */
  publicUrl?: string | null;
  /** Optional white-label homepage redirect. Operational APIs remain on this deployment. */
  homeUrl?: string | null;
  /** Reverse proxies in front of ALKAO whose X-Forwarded-For entry is trusted (default 1). */
  trustedProxyHops?: number;
  /** Log one line per request (route pattern, status, duration). */
  logRequests?: boolean;
  /** Bearer token for GET /metrics (Run 24); without it the route answers 404. */
  metricsToken?: string | null;
  /** Run 46: Twilio's auth token, to check its webhook's signature; null until texts are configured. */
  twilioAuthToken?: string | null;
  /** Run 48: Resend's webhook signing secret (bounces, spam complaints); null until it is set up. */
  resendWebhookSecret?: string | null;
  /** Run 62: the release answering, shown by /health; null when unknown. */
  buildId?: string | null;
  /** Run 92: the writing assistant in /ops (a paid language model); null: off, the default. */
  writer?: Writer | null;
  /** Run 92: drafts per Brand per 24 hours, a ceiling on what the assistant can cost. */
  assistantDailyLimit?: number;
  now?: () => Date;
}

type Env = {
  Variables: {
    scope: TenantScope;
    userId: string;
    role: WorkspaceRole;
  };
};

const PUBLIC = "/v1/public/clients/:clientId/brands/:brandId";
const ADMIN = "/v1/admin/clients/:clientId/brands/:brandId";

const sha256 = (value: string) => createHash("sha256").update(value).digest();

export function createApp(deps: AppDeps) {
  const now = deps.now ?? (() => new Date());
  const holdLimiter = new FixedWindowLimiter(deps.publicHoldsPerMinute, 60_000);
  // Run 27: "Retrouver mes billets", per caller and per address, so it cannot flood an inbox.
  const findTicketsByIp = new FixedWindowLimiter(5, 10 * 60_000);
  const findTicketsByEmail = new FixedWindowLimiter(3, 60 * 60_000);
  // Run 44: newsletter sign-ups usually come from a website's server (one address for all its
  // visitors), so the limits are per e-mail and per Brand, with a looser one per caller.
  const signupByEmail = new FixedWindowLimiter(3, 60 * 60_000);
  const signupByBrand = new FixedWindowLimiter(600, 60 * 60_000);
  const signupByIp = new FixedWindowLimiter(120, 10 * 60_000);
  // Run 71: the waitlist of a sold-out session, per caller and per address.
  const waitlistByIp = new FixedWindowLimiter(20, 10 * 60_000);
  const waitlistByEmail = new FixedWindowLimiter(5, 60 * 60_000);
  // Run 72: presale codes are guessed one try at a time at most.
  const presaleByIp = new FixedWindowLimiter(10, 10 * 60_000);
  const transferByIp = new FixedWindowLimiter(8, 10 * 60_000);
  const claimByIp = new FixedWindowLimiter(5, 10 * 60_000);
  const paymentsService = new PaymentsService({
    db: deps.db,
    gateway: deps.paymentGateway ?? null,
    now,
    onboarding: deps.onboarding ?? null,
    shopOrigin: deps.publicUrl ? new URL(deps.publicUrl).origin : null,
  });
  const credentials = new CredentialsService({ db: deps.db, masterSecret: deps.credentialMasterSecret ?? null, now });
  const app = new Hono<Env>();

  // Run 14: one JSON line per request, with the route pattern only (no ids, query or headers).
  if (deps.logRequests) {
    app.use("*", async (c, next) => {
      const started = Date.now();
      await next();
      console.log(JSON.stringify({ t: new Date().toISOString(), method: c.req.method, route: c.req.routePath, status: c.res.status, ms: Date.now() - started }));
    });
  }
  app.onError((error, c) => errorResponse(c, error));
  app.notFound((c) => fail(c, 404, "not_found"));

  // Run 13 hardening: bounded request bodies, and API responses that are never cached,
  // sniffed or framed. Stripe events can be larger than our own requests.
  const smallBodies = bodyLimit({ maxSize: 256 * 1024, onError: (c) => fail(c, 413, "payload_too_large") });
  const webhookBodies = bodyLimit({ maxSize: 1024 * 1024, onError: (c) => fail(c, 413, "payload_too_large") });
  app.use("*", (c, next) => (c.req.path === "/v1/webhooks/stripe" ? webhookBodies : smallBodies)(c, next));
  const hsts = deps.publicUrl?.startsWith("https://") ?? false;
  app.use("*", async (c, next) => {
    await next();
    if (hsts) c.header("strict-transport-security", "max-age=31536000; includeSubDomains");
    if (!c.req.path.startsWith("/v1/") && c.req.path !== "/health") return;
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "no-referrer");
    c.header("x-frame-options", "DENY");
    if (!c.res.headers.has("cache-control")) c.header("cache-control", "no-store");
  });

  // Run 49: a Brand's own website (its sales funnel) calls the public API from the buyer's
  // browser, so each buyer keeps their own address for the rate limits. Only the origins the
  // Brand lists for checkout returns get CORS; no cookies are ever involved.
  const corsCache = new Map<string, { origins: string[]; at: number }>();
  const corsOrigins = async (clientId: string, brandId: string) => {
    const key = `${clientId}:${brandId}`;
    const hit = corsCache.get(key);
    if (hit && now().getTime() - hit.at < 60_000) return hit.origins;
    const origins = await paymentsDb.getCheckoutReturnOrigins(deps.db, { clientId, brandId });
    corsCache.set(key, { origins, at: now().getTime() });
    return origins;
  };
  app.use(`${PUBLIC}/*`, async (c, next) => {
    const origin = c.req.header("origin");
    const clientId = c.req.param("clientId");
    const brandId = c.req.param("brandId");
    const allowed = Boolean(origin && clientId && brandId && isUuid(clientId) && isUuid(brandId)
      && (await corsOrigins(clientId, brandId)).includes(origin));
    if (c.req.method === "OPTIONS") {
      return c.body(null, 204, allowed ? {
        "access-control-allow-origin": origin!, "access-control-allow-methods": "GET, POST, DELETE",
        "access-control-allow-headers": "content-type, x-alkao-hold-token, x-alkao-order-token, x-alkao-transfer-token",
        "access-control-max-age": "600", vary: "Origin",
      } : { vary: "Origin" });
    }
    await next();
    c.header("vary", "Origin");
    if (allowed) c.header("access-control-allow-origin", origin!);
  });

  /** A parent record from the URL exists in this exact Client and Brand (lists answer 404 otherwise). */
  async function inScope(table: "ticketing_events" | "ticketing_sessions" | "ticketing_orders", id: string, s: TenantScope): Promise<boolean> {
    const { rowCount } = await deps.db.query(`SELECT 1 FROM public.${table} WHERE id = $1 AND client_id = $2 AND brand_id = $3`, [id, s.clientId, s.brandId]);
    return Boolean(rowCount);
  }

  async function decide(clientId: string, brandId: string): Promise<GateDecision> {
    const records = await loadGateRecords(deps.db, clientId, brandId);
    return evaluateTicketingGate({ operationalApiEnabled: deps.operationalApiEnabled, ...records, now: now() });
  }

  // ── Gates ────────────────────────────────────────────────────────────────
  /**
   * Public routes: Ticketing must be active for this exact (Client, Brand). Any denial is a
   * plain 404 so the public cannot probe which tenants exist or why they are off.
   */
  const publicGate: MiddlewareHandler<Env> = async (c, next) => {
    const clientId = c.req.param("clientId");
    const brandId = c.req.param("brandId");
    if (!isUuid(clientId) || !isUuid(brandId)) return fail(c, 404, "ticketing_unavailable");
    const decision = await decide(clientId, brandId);
    if (!decision.active) return fail(c, 404, "ticketing_unavailable");
    c.set("scope", { clientId, brandId });
    await next();
  };

  /** Admin routes, step 1: a valid Supabase access token. */
  const requireUser: MiddlewareHandler<Env> = async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const token = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
    if (!token) return fail(c, 401, "unauthenticated");
    try {
      const { userId } = await deps.auth.verify(token);
      c.set("userId", userId);
    } catch (error) {
      if (error instanceof AuthError && error.code === "auth_not_configured") return fail(c, 503, "auth_not_configured");
      return fail(c, 401, "unauthenticated");
    }
    await next();
  };

  /** Admin routes, step 2: an active membership in this Client (404 otherwise: no probing). */
  const requireMember: MiddlewareHandler<Env> = async (c, next) => {
    const clientId = c.req.param("clientId");
    const brandId = c.req.param("brandId");
    if (!isUuid(clientId) || !isUuid(brandId)) return fail(c, 404, "not_found");
    const role = await loadMembershipRole(deps.db, clientId, c.get("userId"));
    if (!role) return fail(c, 404, "not_found");
    c.set("role", role);
    c.set("scope", { clientId, brandId });
    await next();
  };

  /** Admin routes, step 3: Ticketing active for this (Client, Brand). Members learn why not. */
  const adminGate: MiddlewareHandler<Env> = async (c, next) => {
    const { clientId, brandId } = c.get("scope");
    const decision = await decide(clientId, brandId);
    if (!decision.active) return fail(c, 403, "ticketing_disabled", { reason: decision.reason });
    await next();
  };

  /** Admin routes, step 4: the role grants the permission. */
  const can =
    (permission: TicketingPermission): MiddlewareHandler<Env> =>
    async (c, next) => {
      if (!roleHasPermission(c.get("role"), permission)) return fail(c, 403, "forbidden", { permission });
      await next();
    };

  const admin = [requireUser, requireMember, adminGate] as const;
  const actor = (c: Context<Env>) => ({ type: "user" as const, id: c.get("userId") });
  const param = (c: Context<Env>, name: string) => {
    const value = c.req.param(name);
    return isUuid(value) ? value : null;
  };

  // ── Health ───────────────────────────────────────────────────────────────
  app.get("/health", (c) => c.json({ ok: true, service: "alkao", api: API_VERSION, control: CONTROL_CONTRACT_VERSION, ...(deps.buildId ? { build: deps.buildId } : {}) }));
  // Run 14: readiness for the load balancer — the database answers within 2 s.
  // Run 70: and holds this build's tables. A build whose migrations are not applied is not ready,
  // so the host keeps the previous one; the migration names stay private.
  const shipped = (() => { try { return migrationNames(); } catch { return null; } })();
  app.get("/health/ready", async (c) => {
    try {
      await Promise.race([deps.db.query("SELECT 1"), new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 2000))]);
    } catch {
      return c.json({ ok: false, database: "down" }, 503);
    }
    const schema = shipped ? await schemaState(deps.db, shipped) : "unknown";
    return schema === "behind" ? c.json({ ok: false, database: "up", schema }, 503) : c.json({ ok: true, database: "up", schema });
  });

  // Run 39: whether ALKAO sees the caller's public address behind the host's proxies (per-buyer
  // rate limits depend on it). Only the kind of address, never the address itself.
  app.get("/health/client", (c) => c.json({ ok: true, client: ipKind(clientIp(c, deps.trustedProxyHops ?? 1)) }));

  // Run 24: platform health for monitoring (Prometheus text). Platform-wide counts only.
  app.get("/metrics", async (c) => {
    if (!deps.metricsToken) return fail(c, 404, "not_found");
    const given = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1] ?? "";
    const digest = (v: string) => createHash("sha256").update(v).digest();
    if (!timingSafeEqual(digest(given), digest(deps.metricsToken))) return fail(c, 401, "unauthorized");
    return c.body(await metrics.collectMetrics(deps.db, now()), 200, {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
      "cache-control": "no-store",
    });
  });

  // ── Control contract (TAKATAK → ALKAO) ───────────────────────────────────
  /** HMAC-signed control request: the parsed JSON body and the key id, or an error response. */
  async function signedControlBody(c: Context<Env>): Promise<{ json: unknown; keyId: string } | Response> {
    if (deps.controlKeys.size === 0) return fail(c, 503, "control_not_configured");
    const rawBody = await c.req.text();
    const keyId = c.req.header("x-alkao-key-id");
    const check = verifyControlSignature({
      keys: deps.controlKeys,
      keyId,
      timestamp: c.req.header("x-alkao-timestamp"),
      signature: c.req.header("x-alkao-signature"),
      rawBody,
      now: now(),
    });
    if (!check.ok) return fail(c, 401, "invalid_signature", { reason: check.reason });
    try {
      return { json: JSON.parse(rawBody), keyId: keyId! };
    } catch {
      return fail(c, 400, "invalid_json");
    }
  }

  app.post("/v1/control/events", async (c) => {
    const signed = await signedControlBody(c);
    if (signed instanceof Response) return signed;
    const event = ControlEvent.parse(signed.json);
    const outcome = await withTransaction(deps.db, (tx) => applyControlEvent(tx, event, signed.keyId));
    return c.json({ eventId: event.eventId, outcome });
  });

  // Run 11: reconciliation. TAKATAK reads what ALKAO holds and sends only the differences.
  app.post("/v1/control/state", async (c) => {
    const signed = await signedControlBody(c);
    if (signed instanceof Response) return signed;
    const request = ControlStateRequest.parse(signed.json);
    return c.json({ contract: CONTROL_CONTRACT_VERSION, clients: await readControlState(deps.db, request.clientIds) });
  });

  // ── Public (buyer-facing) ────────────────────────────────────────────────
  app.get(`${PUBLIC}/events`, publicGate, async (c) => {
    const scope = c.get("scope");
    const [events, look] = await Promise.all([catalog.listPublicEvents(deps.db, scope), appearanceDb.getAppearance(deps.db, scope)]);
    // Run 50: the Brand's look, for the shop's list of events.
    const { brandName, updatedAt: _u, showOnAlkao: _directory, ...appearance } = look;
    return c.json({ events, brand: { name: brandName, ...appearance } });
  });

  app.get(`${PUBLIC}/events/:eventId`, publicGate, async (c) => {
    const scope = c.get("scope");
    const eventId = param(c, "eventId");
    const event = eventId ? await catalog.loadPublicEvent(deps.db, scope, eventId) : null;
    if (!eventId || !event) return fail(c, 404, "event_not_found");
    const [details, types, sessions, described, remaining, coupons] = await Promise.all([
      catalog.getEvent(deps.db, scope, eventId),
      catalog.loadTicketTypeRules(deps.db, scope, eventId),
      catalog.listPublicSessions(deps.db, scope, eventId, now()),
      // Run 93: what each ticket includes, under "Plus d'infos".
      catalog.listTicketTypes(deps.db, scope, eventId),
      // Run 97: what is left of each limited ticket, and the coupons shown to every buyer.
      catalog.ticketTypesRemaining(deps.db, scope, eventId, now()),
      promoDb.publicCoupons(deps.db, scope, eventId, now()),
    ]);
    const descriptionOf = new Map(described.map((t) => [t.id as string, (t.description as string | null) ?? null]));
    const { status: _status, createdAt: _c, updatedAt: _u, ...publicDetails } = details;
    // Run 08: what the hosted shop shows (Brand and venue names).
    const place = await catalog.loadPublicEventPlace(deps.db, scope, eventId);
    return c.json({
      event: { ...publicDetails, taxRegion: event.taxRegion, ...place },
      ticketTypes: rulesOnSale(types, now())
        .filter((t) => t.active)
        .map(({ active: _a, ...t }) => ({ ...t, description: descriptionOf.get(t.id) ?? null, remaining: remaining.get(t.id) ?? null })),
      // Run 104: the next price phases, announced with their date (never sold before it).
      upcoming: types
        .filter((t) => t.active && t.salesStartAt && t.salesStartAt.getTime() > now().getTime() && (!t.salesEndAt || t.salesEndAt > t.salesStartAt))
        .map((t) => ({ id: t.id, name: t.name, presaleOf: t.presaleOf ?? null, priceCents: t.priceCents, salesStartAt: t.salesStartAt, salesEndAt: t.salesEndAt ?? null })),
      sessions,
      coupons,
    });
  });

  app.post(`${PUBLIC}/events/:eventId/quote`, publicGate, async (c) => {
    const scope = c.get("scope");
    const eventId = param(c, "eventId");
    const event = eventId ? await catalog.loadPublicEvent(deps.db, scope, eventId) : null;
    if (!eventId || !event) return fail(c, 404, "event_not_found");
    const body = api.QuoteRequest.parse(await readJson(c));
    const rules = rulesOnSale(await catalog.loadTicketTypeRules(deps.db, scope, eventId), now());
    // Run 36: a promo code the buyer can use now, or promo_code_invalid with the reason.
    const promo = body.promoCode ? await promoDb.usablePromo(deps.db, scope, eventId, body.promoCode, now()) : null;
    const result = buildQuote(rules, body.items, event.taxRegion, undefined, promo);
    if (!result.ok) return fail(c, 422, "cart_invalid", result.violations);
    if (!promoApplies(result.quote.lines, promo)) throw new DomainError("promo_code_invalid", { reason: "presale_only" });
    // Run 103: a partner company's code says whose offer it is.
    return c.json({ quote: result.quote, ...(promo?.partner ? { offer: promo.partner } : {}) });
  });

  // Run 44: a website's newsletter form. The answer is the same whatever the address, and
  // nothing changes on the customer file until the person confirms by e-mail.
  app.post(`${PUBLIC}/newsletter`, publicGate, async (c) => {
    const scope = c.get("scope");
    const at = now().getTime();
    if (!signupByIp.take(`${scope.clientId}:${clientIp(c, deps.trustedProxyHops ?? 1)}`, at)) return fail(c, 429, "rate_limited");
    const body = api.NewsletterSignup.parse(await readJson(c));
    if (!signupByBrand.take(`${scope.clientId}:${scope.brandId}`, at)) return fail(c, 429, "rate_limited");
    if (signupByEmail.take(`${scope.clientId}:${scope.brandId}:${body.email.toLowerCase()}`, at)) {
      await withTransaction(deps.db, (tx) => newsletterDb.requestSignup(tx, scope, body, now()));
    }
    return c.json({ ok: true }, 202);
  });

  // Run 72: a presale code opens the event's sale before its public opening, from its own time.
  app.post(`${PUBLIC}/events/:eventId/presale`, publicGate, async (c) => {
    const scope = c.get("scope");
    const eventId = param(c, "eventId");
    if (!presaleByIp.take(`${scope.clientId}:${clientIp(c, deps.trustedProxyHops ?? 1)}`, now().getTime())) return fail(c, 429, "rate_limited");
    const event = eventId ? await catalog.loadPublicEvent(deps.db, scope, eventId) : null;
    if (!eventId || !event) return fail(c, 404, "event_not_found");
    const { code } = api.PresaleCheck.parse(await readJson(c));
    const opensAt = await presaleDb.presaleOpening(deps.db, scope, eventId, code);
    if (!opensAt) return fail(c, 404, "presale_code_invalid");
    return c.json({ presale: { opensAt } });
  });

  // Run 71: a sold-out session's waitlist. The address gets one e-mail when seats come back.
  app.post(`${PUBLIC}/sessions/:sessionId/waitlist`, publicGate, async (c) => {
    const scope = c.get("scope");
    const at = now().getTime();
    const sessionId = param(c, "sessionId");
    if (!sessionId) return fail(c, 404, "session_not_found");
    if (!waitlistByIp.take(`${scope.clientId}:${clientIp(c, deps.trustedProxyHops ?? 1)}`, at)) return fail(c, 429, "rate_limited");
    const body = api.WaitlistJoin.parse(await readJson(c));
    if (!waitlistByEmail.take(`${scope.clientId}:${scope.brandId}:${body.email.toLowerCase()}`, at)) return fail(c, 429, "rate_limited");
    const result = await waitlist.joinWaitlist(deps.db, scope, sessionId, body, now());
    if (result === "session_not_found") return fail(c, 404, "session_not_found");
    // Seats are there: buy them instead (availability is public).
    if (result === "session_not_full") return fail(c, 409, "session_not_full");
    return c.json({ ok: true }, 202);
  });

  // Run 27: a buyer who lost the email asks for their tickets again. The answer is the same
  // whether or not the address has orders, so it reveals nothing about who bought.
  app.post(`${PUBLIC}/tickets/resend`, publicGate, async (c) => {
    const scope = c.get("scope");
    const at = now().getTime();
    if (!findTicketsByIp.take(`${scope.clientId}:${clientIp(c, deps.trustedProxyHops ?? 1)}`, at)) return fail(c, 429, "rate_limited");
    const { email } = api.FindTicketsRequest.parse(await readJson(c));
    if (findTicketsByEmail.take(`${scope.clientId}:${scope.brandId}:${email.trim().toLowerCase()}`, at)) {
      await findTickets.resendTicketsToBuyer(deps.db, scope, email, now());
    }
    return c.json({ ok: true }, 202);
  });

  app.post(`${PUBLIC}/holds`, publicGate, async (c) => {
    const scope = c.get("scope");
    const ip = clientIp(c, deps.trustedProxyHops ?? 1);
    if (!holdLimiter.take(`${scope.clientId}:${ip}`, now().getTime())) return fail(c, 429, "rate_limited");

    const body = api.CreateHoldRequest.parse(await readJson(c));
    const session = await catalog.loadSession(deps.db, scope, body.sessionId);
    const event = session ? await catalog.loadPublicEvent(deps.db, scope, session.eventId) : null;
    if (!session || !event) return fail(c, 404, "session_not_found");
    // Run 72: a presale code opens the sale from its own time, before the public opening.
    const presaleFrom = body.presaleCode ? await presaleDb.presaleOpening(deps.db, scope, session.eventId, body.presaleCode) : null;
    if (!isSessionSellable(event, session, now(), presaleFrom)) {
      const early = event.salesOpenAt && now() < new Date(event.salesOpenAt) && session.status === "on_sale" && now() < session.startsAt;
      return fail(c, 409, early ? "sales_not_open" : "session_not_available");
    }

    // Run 97: a presale past its end date is sold no more.
    const rules = rulesOnSale(await catalog.loadTicketTypeRules(deps.db, scope, session.eventId), now());
    const promo = body.promoCode ? await promoDb.usablePromo(deps.db, scope, session.eventId, body.promoCode, now()) : null;
    const result = buildQuote(rules, body.items, event.taxRegion, undefined, promo);
    if (!result.ok) return fail(c, 422, "cart_invalid", result.violations);
    const quote = result.quote;
    // Run 99: a code kept off presale prices, on presale tickets only, is refused with its reason.
    if (!promoApplies(quote.lines, promo)) throw new DomainError("promo_code_invalid", { reason: "presale_only" });

    // Run 98: a pass is bought on its own. Its cart belongs to the first session on sale; each
    // later one holds a seat for it too.
    let holdSession = session;
    let passSessionIds: string[] = [];
    const passTypes = new Set(rules.filter((r) => r.pass).map((r) => r.id));
    const passItems = body.items.filter((i) => passTypes.has(i.ticketTypeId));
    if (passItems.length > 0) {
      if (passItems.length !== body.items.length) return fail(c, 422, "pass_cart_mixed");
      const covered = (await catalog.passSessions(deps.db, scope, session.eventId, now())).filter((x) => isSessionSellable(event, x, now(), presaleFrom));
      if (covered.length === 0) return fail(c, 409, "pass_no_session");
      holdSession = covered[0]!;
      passSessionIds = covered.slice(1).map((x) => x.id);
    }

    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now().getTime() + deps.holdTtlSeconds * 1000);
    const hold = await withTransaction(deps.db, async (tx) => {
      const created = await createHold(
        tx,
        {
          ...scope,
          eventId: session.eventId,
          sessionId: holdSession.id,
          admissions: quote.admissions,
          items: quote.lines.map((l) => ({ ticketTypeId: l.ticketTypeId, quantity: l.quantity, unitPriceCents: l.unitPriceCents })),
          expiresAt,
          promoCodeId: promo?.id ?? null,
          passSessionIds,
        },
        now(),
      );
      await tx.query(
        `INSERT INTO public.ticketing_access_tokens (token_hash, client_id, brand_id, subject_type, subject_id, expires_at)
         VALUES ($1, $2, $3, 'hold', $4, $5)`,
        [sha256(token), scope.clientId, scope.brandId, created.id, created.expiresAt],
      );
      return created;
    });
    return c.json({ hold: { id: hold.id, token, expiresAt: hold.expiresAt, sessionId: holdSession.id, ...(passSessionIds.length ? { passSessionIds } : {}), quote } }, 201);
  });

  /** Resolve a hold from its id + buyer token, within this tenant only. */
  async function holdForToken(c: Context<Env>): Promise<string | null> {
    const holdId = param(c, "holdId");
    const token = c.req.header("x-alkao-hold-token");
    if (!holdId || !token || token.length > 100) return null;
    const scope = c.get("scope");
    const { rowCount } = await deps.db.query(
      `SELECT 1 FROM public.ticketing_access_tokens
       WHERE token_hash = $1 AND subject_type = 'hold' AND subject_id = $2 AND client_id = $3 AND brand_id = $4`,
      [sha256(token), holdId, scope.clientId, scope.brandId],
    );
    return rowCount ? holdId : null;
  }

  app.get(`${PUBLIC}/holds/:holdId`, publicGate, async (c) => {
    const holdId = await holdForToken(c);
    if (!holdId) return fail(c, 404, "hold_not_found");
    const scope = c.get("scope");
    const { rows } = await deps.db.query<{ status: string; expires_at: Date; session_id: string }>(
      `SELECT status, expires_at, session_id FROM public.ticketing_holds WHERE id = $1 AND client_id = $2 AND brand_id = $3`,
      [holdId, scope.clientId, scope.brandId],
    );
    const hold = rows[0]!;
    const { rows: items } = await deps.db.query(
      `SELECT i.ticket_type_id AS "ticketTypeId", t.code, t.name, t.kind, i.quantity, i.unit_price_cents AS "unitPriceCents"
       FROM public.ticketing_hold_items i
       JOIN public.ticketing_ticket_types t ON t.id = i.ticket_type_id AND t.client_id = i.client_id AND t.brand_id = i.brand_id
       WHERE i.hold_id = $1 AND i.client_id = $2 AND i.brand_id = $3 ORDER BY t.sort_order, t.code`,
      [holdId, scope.clientId, scope.brandId],
    );
    const status = hold.status === "active" && hold.expires_at <= now() ? "expired" : hold.status;
    return c.json({ hold: { id: holdId, status, expiresAt: hold.expires_at, sessionId: hold.session_id, items } });
  });

  app.delete(`${PUBLIC}/holds/:holdId`, publicGate, async (c) => {
    const holdId = await holdForToken(c);
    if (!holdId) return fail(c, 404, "hold_not_found");
    const released = await withTransaction(deps.db, (tx) => releaseHold(tx, c.get("scope"), holdId));
    if (!released) return fail(c, 409, "hold_not_active");
    return c.body(null, 204);
  });

  // ── Admin (TAKATAK dashboard / Client staff) ─────────────────────────────
  // Gate status is readable by any member, even while Ticketing is off.
  app.get(`${ADMIN}/status`, requireUser, requireMember, async (c) => {
    const { clientId, brandId } = c.get("scope");
    const decision = await decide(clientId, brandId);
    return c.json({ role: c.get("role"), ticketing: decision, assistant: Boolean(deps.writer) });
  });

  app.get(`${ADMIN}/venues`, ...admin, can("ticketing.catalog.read"), async (c) =>
    c.json({ venues: await catalog.listVenues(deps.db, c.get("scope")) }),
  );

  app.post(`${ADMIN}/venues`, ...admin, can("ticketing.catalog.write"), async (c) => {
    const body = api.CreateVenue.parse(await readJson(c));
    const venue = await withTransaction(deps.db, async (tx) => {
      const v = await catalog.createVenue(tx, c.get("scope"), body);
      await catalog.writeAudit(tx, c.get("scope"), actor(c), "venue.created", { type: "venue", id: v.id as string });
      return v;
    });
    return c.json({ venue }, 201);
  });

  app.patch(`${ADMIN}/venues/:venueId`, ...admin, can("ticketing.catalog.write"), async (c) => {
    const venueId = param(c, "venueId");
    if (!venueId) return fail(c, 404, "venue_not_found");
    const body = api.UpdateVenue.parse(await readJson(c));
    const { venue, buyersNotified } = await withTransaction(deps.db, async (tx) => {
      // Run 65: a new name or address is a change of place for every sold session there (OPC).
      const before = await changeNotice.soldSessions(tx, c.get("scope"), { venueId }, now());
      const v = await catalog.updateVenue(tx, c.get("scope"), venueId, body);
      const notified = await changeNotice.noticeChanges(tx, c.get("scope"), before, await changeNotice.soldSessions(tx, c.get("scope"), { venueId }, now()));
      await catalog.writeAudit(tx, c.get("scope"), actor(c), "venue.updated", { type: "venue", id: venueId }, { fields: Object.keys(body), buyersNotified: notified });
      return { venue: v, buyersNotified: notified };
    });
    return c.json({ venue, buyersNotified });
  });

  app.get(`${ADMIN}/events`, ...admin, can("ticketing.catalog.read"), async (c) =>
    c.json({ events: await catalog.listEvents(deps.db, c.get("scope")) }),
  );

  app.post(`${ADMIN}/events`, ...admin, can("ticketing.catalog.write"), async (c) => {
    const body = api.CreateEvent.parse(await readJson(c));
    const event = await withTransaction(deps.db, async (tx) => {
      const e = await catalog.createEvent(tx, c.get("scope"), body);
      await catalog.writeAudit(tx, c.get("scope"), actor(c), "event.created", { type: "event", id: e.id as string });
      return e;
    });
    return c.json({ event }, 201);
  });

  app.get(`${ADMIN}/events/:eventId`, ...admin, can("ticketing.catalog.read"), async (c) => {
    const eventId = param(c, "eventId");
    if (!eventId) return fail(c, 404, "event_not_found");
    return c.json({ event: await catalog.getEvent(deps.db, c.get("scope"), eventId) });
  });

  // Run 28: a new draft event from this one (same ticket types; sessions moved if asked).
  app.post(`${ADMIN}/events/:eventId/duplicate`, ...admin, can("ticketing.catalog.write"), async (c) => {
    const eventId = param(c, "eventId");
    if (!eventId) return fail(c, 404, "event_not_found");
    const body = api.DuplicateEventRequest.parse(await readJson(c));
    return c.json(await duplicate.duplicateEvent(deps.db, c.get("scope"), eventId, body, actor(c)), 201);
  });

  app.patch(`${ADMIN}/events/:eventId`, ...admin, can("ticketing.catalog.write"), async (c) => {
    const eventId = param(c, "eventId");
    if (!eventId) return fail(c, 404, "event_not_found");
    const body = api.UpdateEvent.parse(await readJson(c));
    const event = await withTransaction(deps.db, async (tx) => {
      const e = await catalog.updateEvent(tx, c.get("scope"), eventId, body);
      await catalog.writeAudit(tx, c.get("scope"), actor(c), "event.updated", { type: "event", id: eventId }, { fields: Object.keys(body) });
      return e;
    });
    return c.json({ event });
  });

  app.get(`${ADMIN}/events/:eventId/sessions`, ...admin, can("ticketing.inventory.read"), async (c) => {
    const eventId = param(c, "eventId");
    if (!eventId || !(await inScope("ticketing_events", eventId, c.get("scope")))) return fail(c, 404, "event_not_found");
    const [sessions, waiting] = await Promise.all([catalog.listSessions(deps.db, c.get("scope"), eventId), waitlist.waitingCounts(deps.db, c.get("scope"), eventId)]);
    // Run 71: how many people wait for each sold-out session.
    return c.json({ sessions: sessions.map((s) => ({ ...s, waitlistCount: waiting.get(String(s.id)) ?? 0 })) });
  });

  app.post(`${ADMIN}/events/:eventId/sessions`, ...admin, can("ticketing.catalog.write"), async (c) => {
    const eventId = param(c, "eventId");
    if (!eventId) return fail(c, 404, "event_not_found");
    const body = api.CreateSession.parse(await readJson(c));
    const session = await withTransaction(deps.db, async (tx) => {
      const s = await catalog.createSession(tx, c.get("scope"), eventId, body);
      await catalog.writeAudit(tx, c.get("scope"), actor(c), "session.created", { type: "session", id: s.id as string });
      return s;
    });
    return c.json({ session }, 201);
  });

  // Run 36: promo codes, per event.
  app.get(`${ADMIN}/events/:eventId/promo-codes`, ...admin, can("ticketing.catalog.read"), async (c) => {
    const eventId = param(c, "eventId");
    if (!eventId || !(await inScope("ticketing_events", eventId, c.get("scope")))) return fail(c, 404, "event_not_found");
    return c.json({ promoCodes: await promoDb.listPromoCodes(deps.db, c.get("scope"), eventId) });
  });

  app.post(`${ADMIN}/events/:eventId/promo-codes`, ...admin, can("ticketing.catalog.write"), async (c) => {
    const eventId = param(c, "eventId");
    if (!eventId) return fail(c, 404, "event_not_found");
    const body = api.CreatePromoCode.parse(await readJson(c));
    const promoCode = await withTransaction(deps.db, (tx) => promoDb.createPromoCode(tx, c.get("scope"), eventId, body, actor(c)));
    return c.json({ promoCode }, 201);
  });

  app.patch(`${ADMIN}/promo-codes/:promoCodeId`, ...admin, can("ticketing.catalog.write"), async (c) => {
    const id = param(c, "promoCodeId");
    if (!id) return fail(c, 404, "promo_code_not_found");
    const body = api.UpdatePromoCode.parse(await readJson(c));
    const promoCode = await withTransaction(deps.db, (tx) => promoDb.updatePromoCode(tx, c.get("scope"), id, body, actor(c)));
    return c.json({ promoCode });
  });

  // Run 105: the return offer, chosen among the Brand's codes.
  app.get(`${ADMIN}/events/:eventId/return-offer`, ...admin, can("ticketing.catalog.read"), async (c) => {
    const eventId = param(c, "eventId");
    if (!eventId || !(await inScope("ticketing_events", eventId, c.get("scope")))) return fail(c, 404, "event_not_found");
    const scope = c.get("scope");
    const [choice, live] = await Promise.all([promoDb.returnOfferChoices(deps.db, scope, eventId, now()), promoDb.returnOfferFor(deps.db, scope, eventId, now())]);
    return c.json({ returnOffer: { ...choice, live } });
  });

  app.put(`${ADMIN}/events/:eventId/return-offer`, ...admin, can("ticketing.catalog.write"), async (c) => {
    const eventId = param(c, "eventId");
    if (!eventId) return fail(c, 404, "event_not_found");
    const body = api.SetReturnOffer.parse(await readJson(c));
    const scope = c.get("scope");
    await withTransaction(deps.db, (tx) => promoDb.setReturnOffer(tx, scope, eventId, body.promoCodeId, actor(c)));
    return c.json({ returnOffer: { promoCodeId: body.promoCodeId, live: await promoDb.returnOfferFor(deps.db, scope, eventId, now()) } });
  });

  // Run 103: codes for partner companies, made, listed, sent and switched off as one batch.
  app.get(`${ADMIN}/events/:eventId/partner-codes`, ...admin, can("ticketing.catalog.read"), async (c) => {
    const eventId = param(c, "eventId");
    if (!eventId || !(await inScope("ticketing_events", eventId, c.get("scope")))) return fail(c, 404, "event_not_found");
    return c.json({ partners: await promoDb.partnerBatches(deps.db, c.get("scope"), eventId) });
  });

  app.post(`${ADMIN}/events/:eventId/partner-codes`, ...admin, can("ticketing.catalog.write"), async (c) => {
    const eventId = param(c, "eventId");
    if (!eventId) return fail(c, 404, "event_not_found");
    const body = api.CreatePartnerCodes.parse(await readJson(c));
    const codes = await withTransaction(deps.db, (tx) => promoDb.createPartnerCodes(tx, c.get("scope"), eventId, body, actor(c)));
    return c.json({ partner: body.partner, count: codes.length }, 201);
  });

  app.patch(`${ADMIN}/events/:eventId/partner-codes`, ...admin, can("ticketing.catalog.write"), async (c) => {
    const eventId = param(c, "eventId");
    if (!eventId) return fail(c, 404, "event_not_found");
    const body = api.UpdatePartnerCodes.parse(await readJson(c));
    const count = await withTransaction(deps.db, (tx) => promoDb.setPartnerActive(tx, c.get("scope"), eventId, body.partner, body.active, actor(c)));
    return c.json({ partner: body.partner, active: body.active, count });
  });

  // The file for the company: each code, what it takes off, and its own link to the shop,
  // which applies the code on arrival (Run 97).
  app.get(`${ADMIN}/events/:eventId/partner-codes.csv`, ...admin, can("ticketing.catalog.write"), async (c) => {
    const scope = c.get("scope");
    const eventId = param(c, "eventId");
    if (!eventId || !(await inScope("ticketing_events", eventId, scope))) return fail(c, 404, "event_not_found");
    const { partner } = api.PartnerQuery.parse(c.req.query());
    const rows = await promoDb.partnerCodes(deps.db, scope, eventId, partner);
    if (rows.length === 0) return fail(c, 404, "promo_code_not_found");
    const shop = `${(deps.publicUrl ?? new URL(c.req.url).origin).replace(/\/+$/, "")}/acheter/${scope.clientId}/${scope.brandId}/${eventId}`;
    await catalog.writeAudit(deps.db, scope, actor(c), "promo_code.partner_exported", { type: "event", id: eventId }, { partner, rows: rows.length });
    const value = (r: (typeof rows)[number]) => (r.kind === "percent" ? `${r.percent} %` : `${((r.amount_cents ?? 0) / 100).toFixed(2).replace(".", ",")} $`);
    return csv(
      c,
      `alkao-codes-${promoDb.partnerPrefix(partner).toLowerCase()}.csv`,
      toCsv(
        ["code", "rabais", "utilisations", "utilise", "fin", "actif", "lien"],
        rows.map((r) => [r.code, value(r), r.max_uses ?? "", r.used_count, r.ends_at ?? "", r.active ? "oui" : "non", `${shop}?coupon=${encodeURIComponent(r.code)}`]),
      ),
    );
  });

  // Run 72: presale codes, per event.
  app.get(`${ADMIN}/events/:eventId/presale-codes`, ...admin, can("ticketing.catalog.read"), async (c) => {
    const eventId = param(c, "eventId");
    if (!eventId || !(await inScope("ticketing_events", eventId, c.get("scope")))) return fail(c, 404, "event_not_found");
    return c.json({ presaleCodes: await presaleDb.listPresaleCodes(deps.db, c.get("scope"), eventId) });
  });

  app.post(`${ADMIN}/events/:eventId/presale-codes`, ...admin, can("ticketing.catalog.write"), async (c) => {
    const eventId = param(c, "eventId");
    if (!eventId) return fail(c, 404, "event_not_found");
    const body = api.CreatePresaleCode.parse(await readJson(c));
    const presaleCode = await withTransaction(deps.db, (tx) => presaleDb.createPresaleCode(tx, c.get("scope"), eventId, body, actor(c)));
    return c.json({ presaleCode }, 201);
  });

  app.patch(`${ADMIN}/presale-codes/:presaleCodeId`, ...admin, can("ticketing.catalog.write"), async (c) => {
    const id = param(c, "presaleCodeId");
    if (!id) return fail(c, 404, "presale_code_not_found");
    const body = api.UpdatePresaleCode.parse(await readJson(c));
    const presaleCode = await withTransaction(deps.db, (tx) => presaleDb.updatePresaleCode(tx, c.get("scope"), id, body, actor(c)));
    return c.json({ presaleCode });
  });

  // Run 29: a season of sessions at once (every N minutes, on chosen weekdays, venue time).
  app.post(`${ADMIN}/events/:eventId/sessions/batch`, ...admin, can("ticketing.catalog.write"), async (c) => {
    const eventId = param(c, "eventId");
    if (!eventId) return fail(c, 404, "event_not_found");
    const body = api.SessionBatchRequest.parse(await readJson(c));
    const result = await sessionBatch.createSessionBatch(deps.db, c.get("scope"), eventId, body, actor(c));
    return c.json(result, body.dryRun ? 200 : 201);
  });

  app.post(`${ADMIN}/events/:eventId/sessions/status`, ...admin, can("ticketing.catalog.write"), async (c) => {
    const eventId = param(c, "eventId");
    if (!eventId) return fail(c, 404, "event_not_found");
    const body = api.SessionStatusBatchRequest.parse(await readJson(c));
    return c.json(await sessionBatch.setUpcomingSessionsStatus(deps.db, c.get("scope"), eventId, body, actor(c), now()));
  });

  app.patch(`${ADMIN}/sessions/:sessionId`, ...admin, can("ticketing.catalog.write"), async (c) => {
    const sessionId = param(c, "sessionId");
    if (!sessionId) return fail(c, 404, "session_not_found");
    const body = api.UpdateSession.parse(await readJson(c));
    const updated = await withTransaction(deps.db, async (tx) => {
      if (body.status === "cancelled") {
        // Run 10: a session with buyers is cancelled through POST …/cancel, which refunds them.
        const { rows } = await tx.query<{ n: number }>(
          `SELECT (sold_count + reserved_count)::int AS n FROM public.ticketing_sessions WHERE id = $1 AND client_id = $2 AND brand_id = $3 FOR UPDATE`,
          [sessionId, c.get("scope").clientId, c.get("scope").brandId],
        );
        if ((rows[0]?.n ?? 0) > 0) throw new DomainError("use_session_cancellation");
      }
      // Run 65: a new end time is a change of schedule for its buyers (OPC).
      const before = await changeNotice.soldSessions(tx, c.get("scope"), { sessionId }, now());
      const s = await catalog.updateSession(tx, c.get("scope"), sessionId, body);
      const notified = await changeNotice.noticeChanges(tx, c.get("scope"), before, await changeNotice.soldSessions(tx, c.get("scope"), { sessionId }, now()));
      await catalog.writeAudit(tx, c.get("scope"), actor(c), "session.updated", { type: "session", id: sessionId }, { ...body, ...(notified ? { buyersNotified: notified } : {}) });
      return { session: s, buyersNotified: notified };
    });
    return c.json(updated);
  });

  app.get(`${ADMIN}/events/:eventId/ticket-types`, ...admin, can("ticketing.catalog.read"), async (c) => {
    const eventId = param(c, "eventId");
    if (!eventId || !(await inScope("ticketing_events", eventId, c.get("scope")))) return fail(c, 404, "event_not_found");
    return c.json({ ticketTypes: await catalog.listTicketTypes(deps.db, c.get("scope"), eventId) });
  });

  app.post(`${ADMIN}/events/:eventId/ticket-types`, ...admin, can("ticketing.catalog.write"), async (c) => {
    const eventId = param(c, "eventId");
    if (!eventId) return fail(c, 404, "event_not_found");
    const body = api.CreateTicketType.parse(await readJson(c));
    const ticketType = await withTransaction(deps.db, async (tx) => {
      const t = await catalog.createTicketType(tx, c.get("scope"), eventId, body);
      await catalog.writeAudit(tx, c.get("scope"), actor(c), "ticket_type.created", { type: "ticket_type", id: t.id as string });
      return t;
    });
    return c.json({ ticketType }, 201);
  });

  app.patch(`${ADMIN}/ticket-types/:ticketTypeId`, ...admin, can("ticketing.catalog.write"), async (c) => {
    const ticketTypeId = param(c, "ticketTypeId");
    if (!ticketTypeId) return fail(c, 404, "ticket_type_not_found");
    const body = api.UpdateTicketType.parse(await readJson(c));
    const ticketType = await withTransaction(deps.db, async (tx) => {
      const t = await catalog.updateTicketType(tx, c.get("scope"), ticketTypeId, body);
      await catalog.writeAudit(tx, c.get("scope"), actor(c), "ticket_type.updated", { type: "ticket_type", id: ticketTypeId }, body);
      return t;
    });
    return c.json({ ticketType });
  });

  app.get(`${ADMIN}/orders`, ...admin, can("ticketing.orders.read"), async (c) => {
    const q = api.OrdersQuery.parse(c.req.query());
    return c.json({ orders: await catalog.listOrders(deps.db, c.get("scope"), q.limit, q.before, q.q) });
  });

  app.get(`${ADMIN}/orders/:orderId`, ...admin, can("ticketing.orders.read"), async (c) => {
    const orderId = param(c, "orderId");
    if (!orderId) return fail(c, 404, "order_not_found");
    const scope = c.get("scope");
    const [order, emails, disputes, outsideRefund, admissions, buyerAnonymizedAt] = await Promise.all([
      catalog.getOrder(deps.db, scope, orderId),
      delivery.listOrderEmails(deps.db, scope, orderId),
      paymentsDb.orderDisputes(deps.db, scope, orderId),
      paymentsDb.outsideRefund(deps.db, scope, orderId),
      credentialsDb.admissionsForOrder(deps.db, scope, orderId),
      privacy.buyerAnonymizedAt(deps.db, scope, orderId),
    ]);
    // Run 19: when each ticket entered (evidence for a dispute), chargebacks, and refunds
    // made directly in Stripe. Run 20: whether the buyer was anonymized.
    const tickets = (order.tickets as { id: string }[]).map((t) => ({ ...t, admittedAt: admissions.get(t.id) ?? null }));
    return c.json({ order: { ...order, tickets, emails, disputes, outsideRefundCents: outsideRefund.outsideCents, buyerAnonymizedAt } });
  });

  // ── Run 23: the reminder email before the session, on or off per Brand ────────
  app.get(`${ADMIN}/settings/reminders`, ...admin, can("ticketing.credentials.manage"), async (c) =>
    c.json({ reminders: { enabled: await reminders.getReminderSetting(deps.db, c.get("scope")) } }),
  );

  app.put(`${ADMIN}/settings/reminders`, ...admin, can("ticketing.credentials.manage"), async (c) => {
    const body = api.ReminderSettings.parse(await readJson(c));
    const enabled = await withTransaction(deps.db, async (tx) => {
      const saved = await reminders.setReminderSetting(tx, c.get("scope"), body.enabled);
      await catalog.writeAudit(tx, c.get("scope"), actor(c), "settings.reminders_updated", { type: "brand_settings", id: null }, { enabled: saved });
      return saved;
    });
    return c.json({ reminders: { enabled } });
  });

  // Run 80: only the organizer's owner/admin may opt the Brand into transfers.
  // Enabling requires the separate platform release switch and signing key.
  app.get(`${ADMIN}/settings/transfers`, ...admin, can("ticketing.keys.manage"), async (c) => {
    const scope = c.get("scope");
    const { rows } = await deps.db.query<{ ticket_transfers_enabled: boolean }>(
      `SELECT ticket_transfers_enabled FROM public.ticketing_brand_settings
       WHERE client_id = $1 AND brand_id = $2`, [scope.clientId, scope.brandId],
    );
    return c.json({ transfers: {
      enabled: rows[0]?.ticket_transfers_enabled === true,
      available: Boolean(deps.transferApiEnabled && deps.credentialMasterSecret),
    } });
  });

  app.put(`${ADMIN}/settings/transfers`, ...admin, can("ticketing.keys.manage"), async (c) => {
    const input = z.object({ enabled: z.boolean() }).strict().parse(await readJson(c));
    if (input.enabled && (!deps.transferApiEnabled || !deps.credentialMasterSecret))
      return fail(c, 409, "transfer_release_disabled");
    const scope = c.get("scope");
    const enabled = await withTransaction(deps.db, async (tx) => {
      const { rows } = await tx.query<{ ticket_transfers_enabled: boolean }>(
        `UPDATE public.ticketing_brand_settings SET ticket_transfers_enabled = $3
         WHERE client_id = $1 AND brand_id = $2 RETURNING ticket_transfers_enabled`,
        [scope.clientId, scope.brandId, input.enabled],
      );
      if (!rows[0]) throw new DomainError("brand_not_found");
      await catalog.writeAudit(tx, scope, actor(c), "settings.transfers_updated",
        { type: "brand_settings", id: null }, { enabled: input.enabled });
      return rows[0].ticket_transfers_enabled;
    });
    return c.json({ transfers: { enabled, available: Boolean(deps.transferApiEnabled && deps.credentialMasterSecret) } });
  });

  // ── Run 21: what waits on staff, and tickets cancelled without a refund ───────
  app.get(`${ADMIN}/attention`, ...admin, can("ticketing.orders.read"), async (c) =>
    c.json({ attention: await attention.attentionList(deps.db, c.get("scope"), now()) }),
  );

  app.post(`${ADMIN}/orders/:orderId/tickets/void`, ...admin, can("ticketing.refunds.create"), async (c) => {
    const orderId = param(c, "orderId");
    if (!orderId) return fail(c, 404, "order_not_found");
    const body = api.VoidTicketsRequest.parse(await readJson(c));
    return c.json(await attention.voidTickets(deps.db, c.get("scope"), orderId, { ticketIds: body.ticketIds, reason: body.reason ?? null }, actor(c)));
  });

  // ── Run 20: the buyer's personal data on request (Québec Law 25) ──────────────
  app.get(`${ADMIN}/orders/:orderId/buyer/export`, ...admin, can("ticketing.buyers.read"), async (c) => {
    const orderId = param(c, "orderId");
    if (!orderId) return fail(c, 404, "order_not_found");
    const scope = c.get("scope");
    const data = await privacy.exportBuyerData(deps.db, scope, orderId, now());
    await catalog.writeAudit(deps.db, scope, actor(c), "buyer.exported", { type: "order", id: orderId }, { orders: data.orders.length });
    return c.body(JSON.stringify(data, null, 2), 200, {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="alkao-donnees-acheteur-${data.exportedAt.slice(0, 10)}.json"`,
      "cache-control": "no-store",
    });
  });

  app.post(`${ADMIN}/orders/:orderId/buyer/anonymize`, ...admin, can("ticketing.buyers.erase"), async (c) => {
    const orderId = param(c, "orderId");
    if (!orderId) return fail(c, 404, "order_not_found");
    return c.json(await privacy.anonymizeBuyer(deps.db, c.get("scope"), orderId, actor(c), now()));
  });

  app.get(`${ADMIN}/disputes`, ...admin, can("ticketing.orders.read"), async (c) => {
    const q = api.DisputesQuery.parse(c.req.query());
    return c.json({ disputes: await paymentsDb.listDisputes(deps.db, c.get("scope"), q.status === "open", q.limit) });
  });

  // ── Run 10: the organizer cancels a session and every buyer is refunded ──────────
  app.post(`${ADMIN}/sessions/:sessionId/cancel`, ...admin, can("ticketing.payments.manage"), async (c) => {
    const sessionId = param(c, "sessionId");
    if (!sessionId) return fail(c, 404, "session_not_found");
    const body = api.CancelSessionRequest.parse(await readJson(c));
    const scope = c.get("scope");
    await cancellation.cancelSession(deps.db, scope, sessionId, body.reason ?? null, actor(c));
    return c.json({ cancellation: await cancellation.runCancellationBatch(deps.db, paymentsService, scope, sessionId) }, 202);
  });

  app.post(`${ADMIN}/sessions/:sessionId/cancellation/continue`, ...admin, can("ticketing.payments.manage"), async (c) => {
    const sessionId = param(c, "sessionId");
    if (!sessionId) return fail(c, 404, "session_not_found");
    return c.json({ cancellation: await cancellation.runCancellationBatch(deps.db, paymentsService, c.get("scope"), sessionId) });
  });

  app.get(`${ADMIN}/sessions/:sessionId/cancellation`, ...admin, can("ticketing.orders.read"), async (c) => {
    const sessionId = param(c, "sessionId");
    const progress = sessionId ? await cancellation.getCancellation(deps.db, c.get("scope"), sessionId) : null;
    if (!progress) return fail(c, 404, "cancellation_not_found");
    return c.json({ cancellation: progress });
  });

  // ── Run 12: kill a personal link that leaked, and send the buyer a new one ──────
  app.post(`${ADMIN}/orders/:orderId/tickets-link/rotate`, ...admin, can("ticketing.credentials.manage"), async (c) => {
    const orderId = param(c, "orderId");
    if (!orderId) return fail(c, 404, "order_not_found");
    if (!deps.credentialMasterSecret) return fail(c, 503, "credentials_not_configured");
    const scope = c.get("scope");
    const email = await withTransaction(deps.db, async (tx) => {
      const queued = await delivery.requestTicketsEmail(tx, scope, orderId, actor(c));
      await orderEmailToken(tx, deps.credentialMasterSecret!, scope, orderId, true);
      await catalog.writeAudit(tx, scope, actor(c), "order.tickets_link_rotated", { type: "order", id: orderId });
      return queued;
    });
    return c.json({ email }, 202);
  });

  // ── Run 06: send the buyer's tickets email again (same personal link) ──────────
  app.post(`${ADMIN}/orders/:orderId/tickets-email`, ...admin, can("ticketing.credentials.manage"), async (c) => {
    const orderId = param(c, "orderId");
    if (!orderId) return fail(c, 404, "order_not_found");
    const email = await withTransaction(deps.db, (tx) => delivery.requestTicketsEmail(tx, c.get("scope"), orderId, actor(c)));
    return c.json({ email }, 202);
  });

  // Run 30: filters (action family, entity) and paging that never skips same-instant entries.
  app.get(`${ADMIN}/audit`, ...admin, can("ticketing.audit.read"), async (c) => {
    const q = api.AuditQuery.parse(c.req.query());
    return c.json({ entries: await journal.listJournal(deps.db, c.get("scope"), q) });
  });

  app.get(`${ADMIN}/orders/:orderId/history`, ...admin, can("ticketing.audit.read"), async (c) => {
    const orderId = param(c, "orderId");
    if (!orderId) return fail(c, 404, "order_not_found");
    return c.json({ entries: await journal.orderHistory(deps.db, c.get("scope"), orderId) });
  });

  // ── Run 02: checkout and order status (public) ───────────────────────────
  app.post(`${PUBLIC}/holds/:holdId/checkout`, publicGate, async (c) => {
    const holdId = await holdForToken(c);
    if (!holdId) return fail(c, 404, "hold_not_found");
    const body = api.CheckoutRequest.parse(await readJson(c));
    const result = await paymentsService.startCheckout(c.get("scope"), holdId, body);
    return c.json(
      {
        order: { id: result.orderId, reference: result.reference, token: result.orderToken, status: result.kind === "free" ? "paid" : "pending_payment" },
        checkoutUrl: result.kind === "redirect" ? result.checkoutUrl : null,
      },
      201,
    );
  });

  app.get(`${PUBLIC}/orders/:orderId`, publicGate, async (c) => {
    const orderId = param(c, "orderId");
    const token = c.req.header("x-alkao-order-token");
    const scope = c.get("scope");
    if (!orderId || !(await validOrderAccessToken(deps.db, scope, orderId, token, now())))
      return fail(c, 404, "order_not_found");
    const order = await catalog.getOrder(deps.db, scope, orderId);
    const { commissionCents: _c, commissionRefundedCents: _cr, buyerPhone: _p, attribution: _a, ...publicOrder } = order;
    // QR payload per valid ticket (null for void tickets, or until credentials are configured).
    const payloads = await credentials.payloadsForOrder(scope, orderId);
    // A transferred ticket is still valid for admission but belongs to the
    // recipient. The original order view must never suggest that it is theirs.
    const { rows: transferredRows } = await deps.db.query<{ ticket_id: string }>(
      `SELECT a.ticket_id FROM public.ticketing_transfer_acceptances a
       JOIN public.ticketing_tickets t ON t.id = a.ticket_id
         AND t.client_id = a.client_id AND t.brand_id = a.brand_id
       WHERE t.order_id = $1 AND a.client_id = $2 AND a.brand_id = $3`,
      [orderId, scope.clientId, scope.brandId],
    );
    const transferred = new Set(transferredRows.map(r => r.ticket_id));
    // Run 98: the other dates a festival pass is valid for, in time order.
    const { rows: passRows } = await deps.db.query<{ ticket_id: string; starts_at: Date; ends_at: Date | null }>(
      `SELECT p.ticket_id, s.starts_at, s.ends_at FROM public.ticketing_ticket_pass_seats p
       JOIN public.ticketing_tickets t ON t.id = p.ticket_id AND t.client_id = p.client_id AND t.brand_id = p.brand_id
       JOIN public.ticketing_sessions s ON s.id = p.session_id
       WHERE t.order_id = $1 AND p.client_id = $2 AND p.brand_id = $3
       ORDER BY s.starts_at, s.id`,
      [orderId, scope.clientId, scope.brandId],
    );
    const passDates = new Map<string, { startsAt: Date; endsAt: Date | null }[]>();
    for (const r of passRows) passDates.set(r.ticket_id, [...(passDates.get(r.ticket_id) ?? []), { startsAt: r.starts_at, endsAt: r.ends_at }]);
    const tickets = (order.tickets as { id: string }[]).map((t) => ({
      ...t, transferred: transferred.has(t.id), credential: transferred.has(t.id) ? null : (payloads.get(t.id) ?? null),
      ...(passDates.has(t.id) ? { passDates: passDates.get(t.id) } : {}),
    }));
    // Run 06: what the buyer's ticket page shows (brand, event, session, venue, Flex option).
    const context = await delivery.publicOrderContext(deps.db, scope, orderId);
    // Run 55: the options bought, kept across session changes.
    const options = await orderOptions(deps.db, scope, orderId);
    // Run 105: the organizer's offer for next time, to a buyer whose order holds.
    const returnOffer = ["paid", "partially_refunded"].includes(String(order.status))
      ? await promoDb.returnOfferFor(deps.db, scope, String(order.eventId), now()) : null;
    return c.json({ order: { ...publicOrder, tickets, ...context, options, ...(returnOffer ? { returnOffer } : {}) } });
  });

  // ── Run 80: transfer APIs; explicit global switch AND normal Client/Brand gate. ──────
  // No route reveals the recipient claim secret to the original order holder.
  // Activation stays OFF until verified mail delivery and recipient UI are released.
  const transferReleaseGate: MiddlewareHandler<Env> = async (c, next) => {
    if (!deps.transferApiEnabled || !deps.credentialMasterSecret || deps.credentialMasterSecret.length < 32)
      return fail(c, 404, "not_found");
    await next();
  };
  const transferCreation = z.object({
    ticketId: z.uuid(),
    recipientEmail: z.email().max(320),
  }).strict();
  const claimInput = z.object({ secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();

  app.get(`${PUBLIC}/orders/:orderId/transfers`, publicGate, transferReleaseGate, async (c) => {
    const orderId = param(c, "orderId");
    const scope = c.get("scope");
    if (!orderId || !(await validOrderAccessToken(deps.db, scope, orderId, c.req.header("x-alkao-order-token"), now())))
      return fail(c, 404, "order_not_found");
    const { rows } = await deps.db.query<{
      id: string; ticket_id: string; status: string; expires_at: Date;
    }>(
      `SELECT r.id, r.ticket_id, r.status, r.expires_at
       FROM public.ticketing_transfer_requests r
       JOIN public.ticketing_tickets t ON t.id = r.ticket_id
         AND t.client_id = r.client_id AND t.brand_id = r.brand_id
       WHERE t.order_id = $1 AND r.client_id = $2 AND r.brand_id = $3
       ORDER BY r.created_at DESC LIMIT 100`,
      [orderId, scope.clientId, scope.brandId],
    );
    // Keep the recipient email, hash, access key and all provider identifiers private.
    const { rows: settings } = await deps.db.query<{ ticket_transfers_enabled: boolean }>(
      `SELECT ticket_transfers_enabled FROM public.ticketing_brand_settings
       WHERE client_id = $1 AND brand_id = $2`,
      [scope.clientId, scope.brandId],
    );
    return c.json({
      enabled: settings[0]?.ticket_transfers_enabled === true,
      transfers: rows.map(r => ({
        id: r.id, ticketId: r.ticket_id, status: r.status, expiresAt: r.expires_at,
      })),
    });
  });

  app.post(`${PUBLIC}/orders/:orderId/transfers`, publicGate, transferReleaseGate, async (c) => {
    const orderId = param(c, "orderId");
    if (!orderId) return fail(c, 404, "order_not_found");
    const scope = c.get("scope");
    if (!transferByIp.take(`${scope.clientId}:${clientIp(c, deps.trustedProxyHops ?? 1)}`, now().getTime()))
      return fail(c, 429, "rate_limited");
    const input = transferCreation.parse(await readJson(c));
    const result = await prepareTransferInvitation(
      deps.db, scope, orderId, input.ticketId, c.req.header("x-alkao-order-token") ?? "",
      input.recipientEmail, deps.credentialMasterSecret!, now(),
    );
    return c.json({ transfer: {
      id: result.id, ticketId: result.ticketId, status: "pending", expiresAt: result.expiresAt,
    } }, 202);
  });

  app.delete(`${PUBLIC}/orders/:orderId/transfers/:requestId`, publicGate, transferReleaseGate, async (c) => {
    const orderId = param(c, "orderId");
    const requestId = param(c, "requestId");
    if (!orderId || !requestId) return fail(c, 404, "not_found");
    const scope = c.get("scope");
    const cancelled = await cancelTransferInvitation(
      deps.db, scope, orderId, requestId,
      c.req.header("x-alkao-order-token") ?? "", now(),
    );
    return c.json({ cancelled });
  });

  app.post(`${PUBLIC}/transfers/:requestId/claim`, publicGate, transferReleaseGate, async (c) => {
    const requestId = param(c, "requestId");
    if (!requestId) return fail(c, 404, "transfer_unavailable");
    const scope = c.get("scope");
    if (!claimByIp.take(`${scope.clientId}:${clientIp(c, deps.trustedProxyHops ?? 1)}`, now().getTime()))
      return fail(c, 429, "rate_limited");
    const input = claimInput.parse(await readJson(c));
    const result = await acceptTransferInvitation(
      deps.db, scope, requestId, input.secret, deps.credentialMasterSecret!, now(),
    );
    return c.json({ transfer: {
      id: result.requestId, ticketId: result.ticketId, accessToken: result.recipientAccessToken,
    } });
  });

  app.get(`${PUBLIC}/transfers/:requestId/ticket`, publicGate, transferReleaseGate, async (c) => {
    const requestId = param(c, "requestId");
    if (!requestId) return fail(c, 404, "transfer_unavailable");
    const scope = c.get("scope");
    const recipient = await transferredCredentialForRecipient(
      deps.db, scope, requestId, c.req.header("x-alkao-transfer-token") ?? "",
    );
    return c.json({ ticket: {
      id: recipient.ticketId,
      credential: await credentials.payloadFor(scope.clientId, recipient.credentialId),
    } });
  });

  // ── Run 02: Stripe webhooks ──────────────────────────────────────────────
  // Authenticated by the Stripe signature, not by the Ticketing gate: a checkout opened
  // while Ticketing was active must still be fulfilled (or refunded) if it is revoked
  // before the buyer pays.
  // ── Run 46: Twilio's webhook for replies to texts (STOP, START) ────────────
  // Authenticated by Twilio's signature over the public URL; 404 until texts are configured.
  app.post("/v1/webhooks/twilio/sms", async (c) => {
    if (!deps.twilioAuthToken || !deps.publicUrl) return fail(c, 404, "not_found");
    const form = await c.req.parseBody();
    const params = Object.fromEntries(Object.entries(form).filter(([, v]) => typeof v === "string")) as Record<string, string>;
    const url = `${deps.publicUrl.replace(/\/+$/, "")}/v1/webhooks/twilio/sms`;
    if (!twilioSignatureValid(deps.twilioAuthToken, url, params, c.req.header("x-twilio-signature") ?? "")) return fail(c, 403, "invalid_signature");
    const phone = normalizePhone(params.From);
    const intent = replyIntent(params.Body ?? "");
    if (phone && intent) await withTransaction(deps.db, (tx) => campaignsDb.recordSmsReply(tx, phone, intent, now()));
    // Twilio sends its own STOP/START confirmation; ALKAO answers nothing more.
    return c.body('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', 200, { "content-type": "text/xml; charset=utf-8" });
  });

  // ── Run 48: Resend's webhook: e-mails that bounced or were marked as spam ───
  // Authenticated by Resend's (Svix) signature; 404 until the secret is configured.
  app.post("/v1/webhooks/resend", async (c) => {
    if (!deps.resendWebhookSecret) return fail(c, 404, "not_found");
    const raw = await c.req.text();
    const headers = { id: c.req.header("svix-id"), timestamp: c.req.header("svix-timestamp"), signature: c.req.header("svix-signature") };
    if (!resendSignatureValid(deps.resendWebhookSecret, headers, raw, now())) return fail(c, 403, "invalid_signature");
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return fail(c, 400, "invalid_json");
    }
    const event = emailEventOf(payload);
    if (event) await withTransaction(deps.db, (tx) => campaignsDb.recordEmailEvent(tx, event, now()));
    return c.json({ received: true });
  });

  app.post("/v1/webhooks/stripe", async (c) => {
    if (!deps.paymentGateway) return fail(c, 503, "payments_not_configured");
    const rawBody = await c.req.text();
    try {
      const result = await paymentsService.handleWebhook(rawBody, c.req.header("stripe-signature"));
      return c.json(result);
    } catch (error) {
      if (error instanceof WebhookSignatureError) return fail(c, 400, "invalid_signature");
      throw error;
    }
  });

  // ── Run 02: payments administration ──────────────────────────────────────
  app.post(`${ADMIN}/payments/onboarding`, ...admin, can("ticketing.payments.manage"), async (c) => {
    const link = await paymentsService.startOnboarding(c.get("scope"), actor(c));
    return c.json({ onboarding: link }, 201);
  });

  app.get(`${ADMIN}/payments/account`, ...admin, can("ticketing.payments.manage"), async (c) =>
    c.json({ account: await paymentsService.accountStatus(c.get("scope")) }),
  );

  app.get(`${ADMIN}/payments/settings`, ...admin, can("ticketing.payments.manage"), async (c) =>
    c.json({ settings: { checkoutReturnOrigins: await paymentsDb.getCheckoutReturnOrigins(deps.db, c.get("scope")) } }),
  );

  app.put(`${ADMIN}/payments/settings`, ...admin, can("ticketing.payments.manage"), async (c) => {
    const body = api.CheckoutSettings.parse(await readJson(c));
    const origins = await withTransaction(deps.db, async (tx) => {
      const saved = await paymentsDb.setCheckoutReturnOrigins(tx, c.get("scope"), [...new Set(body.checkoutReturnOrigins)]);
      await catalog.writeAudit(tx, c.get("scope"), actor(c), "payments.settings_updated", { type: "brand_settings", id: null }, { origins: saved });
      return saved;
    });
    return c.json({ settings: { checkoutReturnOrigins: origins } });
  });

  // ── Run 50: the Brand's look on the tickets page, the shop and the e-mails ──
  app.get(`${ADMIN}/appearance`, ...admin, can("ticketing.catalog.read"), async (c) =>
    c.json({ appearance: await appearanceDb.getAppearance(deps.db, c.get("scope")) }),
  );

  app.put(`${ADMIN}/appearance`, ...admin, can("ticketing.catalog.write"), async (c) => {
    const body = api.BrandAppearance.parse(await readJson(c));
    assertReadableColours(body.accentColor, body.onAccentColor);
    const appearance = await withTransaction(deps.db, async (tx) => {
      const saved = await appearanceDb.setAppearance(tx, c.get("scope"), body);
      await catalog.writeAudit(tx, c.get("scope"), actor(c), "brand.appearance_updated", { type: "brand_settings", id: null }, {
        logo: Boolean(saved.logoUrl), accentColor: saved.accentColor, website: Boolean(saved.websiteUrl), showOnAlkao: saved.showOnAlkao,
      });
      return saved;
    });
    return c.json({ appearance });
  });

  app.get(`${ADMIN}/orders/:orderId/refunds`, ...admin, can("ticketing.orders.read"), async (c) => {
    const orderId = param(c, "orderId");
    if (!orderId || !(await inScope("ticketing_orders", orderId, c.get("scope")))) return fail(c, 404, "order_not_found");
    return c.json({ refunds: await paymentsDb.listRefunds(deps.db, c.get("scope"), orderId) });
  });

  app.post(`${ADMIN}/orders/:orderId/refunds`, ...admin, can("ticketing.refunds.create"), async (c) => {
    const orderId = param(c, "orderId");
    if (!orderId) return fail(c, 404, "order_not_found");
    const body = api.RefundRequest.parse(await readJson(c));
    const refund = await paymentsService.requestRefund(c.get("scope"), orderId, body, actor(c));
    return c.json({ refund }, 201);
  });

  app.post(`${ADMIN}/refunds/:refundId/retry`, ...admin, can("ticketing.refunds.create"), async (c) => {
    const refundId = param(c, "refundId");
    if (!refundId) return fail(c, 404, "refund_not_found");
    return c.json({ refund: await paymentsService.retryRefund(c.get("scope"), refundId) });
  });

  // ── Run 03: credentials and gates ────────────────────────────────────────
  app.get(`${ADMIN}/sessions/:sessionId/scanner-manifest`, ...admin, can("ticketing.scan"), async (c) => {
    const sessionId = param(c, "sessionId");
    if (!sessionId) return fail(c, 404, "session_not_found");
    return c.json({ manifest: await credentials.manifest(c.get("scope"), sessionId) });
  });

  app.post(`${ADMIN}/scanner/scans`, ...admin, can("ticketing.scan"), async (c) => {
    const body = api.ScanRequest.parse(await readJson(c));
    const outcome = await credentials.scan(
      c.get("scope"),
      { sessionId: body.sessionId, payload: body.payload, deviceId: body.deviceId ?? null, offline: false },
      c.get("userId"),
    );
    return c.json({ scan: outcome });
  });

  // ── Run 22: at the gate without a QR code (phone dead, code unreadable) ──────
  app.get(`${ADMIN}/sessions/:sessionId/lookup`, ...admin, can("ticketing.scan"), async (c) => {
    const sessionId = param(c, "sessionId");
    if (!sessionId) return fail(c, 404, "session_not_found");
    const { reference } = api.GateLookupQuery.parse(c.req.query());
    const withBuyer = roleHasPermission(c.get("role"), "ticketing.buyers.read");
    return c.json({ order: await credentials.lookupByReference(c.get("scope"), sessionId, reference, withBuyer) });
  });

  app.post(`${ADMIN}/scanner/admit`, ...admin, can("ticketing.scan"), async (c) => {
    const body = api.ManualAdmitRequest.parse(await readJson(c));
    const outcome = await credentials.admitManually(
      c.get("scope"),
      { sessionId: body.sessionId, ticketId: body.ticketId, deviceId: body.deviceId ?? null },
      c.get("userId"),
    );
    return c.json({ scan: outcome });
  });

  app.post(`${ADMIN}/scanner/scans/batch`, ...admin, can("ticketing.scan"), async (c) => {
    const body = api.ScanBatchRequest.parse(await readJson(c));
    const results = await credentials.scanBatch(
      c.get("scope"),
      { sessionId: body.sessionId, deviceId: body.deviceId, scans: body.scans.map((s) => ({ payload: s.payload, scannedAt: new Date(s.scannedAt) })) },
      c.get("userId"),
    );
    return c.json({ scans: results });
  });

  // Run 14: the gate's live counter (cheap: counts only).
  app.get(`${ADMIN}/sessions/:sessionId/attendance`, ...admin, can("ticketing.scan"), async (c) => {
    const sessionId = param(c, "sessionId");
    const scope = c.get("scope");
    if (!sessionId || !(await inScope("ticketing_sessions", sessionId, scope))) return fail(c, 404, "session_not_found");
    const { rows } = await deps.db.query<{ capacity: number; valid: number; admitted: number }>(
      `SELECT s.capacity,
              (SELECT count(*)::int FROM public.ticketing_tickets t WHERE t.session_id = s.id AND t.client_id = s.client_id AND t.brand_id = s.brand_id AND t.status = 'valid') AS valid,
              (SELECT count(DISTINCT x.ticket_id)::int FROM public.ticketing_scans x
                 WHERE x.session_id = s.id AND x.client_id = s.client_id AND x.brand_id = s.brand_id AND x.result = 'admitted') AS admitted
       FROM public.ticketing_sessions s WHERE s.id = $1 AND s.client_id = $2 AND s.brand_id = $3`,
      [sessionId, scope.clientId, scope.brandId],
    );
    return c.json({ attendance: rows[0] });
  });

  // Run 57: the session's options to prepare and how many were handed over at the gate.
  app.get(`${ADMIN}/sessions/:sessionId/options`, ...admin, can("ticketing.scan"), async (c) => {
    const sessionId = param(c, "sessionId");
    const scope = c.get("scope");
    if (!sessionId || !(await inScope("ticketing_sessions", sessionId, scope))) return fail(c, 404, "session_not_found");
    return c.json({ options: await sessionOptions(deps.db, scope, sessionId) });
  });

  app.get(`${ADMIN}/sessions/:sessionId/scans`, ...admin, can("ticketing.scan"), async (c) => {
    const sessionId = param(c, "sessionId");
    if (!sessionId || !(await inScope("ticketing_sessions", sessionId, c.get("scope")))) return fail(c, 404, "session_not_found");
    const q = api.ListQuery.parse(c.req.query());
    return c.json({ scans: await credentialsDb.listScans(deps.db, c.get("scope"), sessionId, q.limit) });
  });

  app.post(`${ADMIN}/tickets/:ticketId/credential/reissue`, ...admin, can("ticketing.credentials.manage"), async (c) => {
    const ticketId = param(c, "ticketId");
    if (!ticketId) return fail(c, 404, "ticket_not_found");
    const reissued = await credentials.reissue(c.get("scope"), ticketId, actor(c));
    return c.json({ credential: reissued }, 201);
  });

  app.post(`${ADMIN}/credential-keys/rotate`, ...admin, can("ticketing.keys.manage"), async (c) => {
    const key = await credentials.rotateKey(c.get("scope"), actor(c));
    return c.json({ key: { kid: key.kid, version: key.version, algorithm: "Ed25519", publicKey: key.publicKey } }, 201);
  });

  // ── Run 04: operations reports and exports ───────────────────────────────
  app.get(`${ADMIN}/reports/sales`, ...admin, can("ticketing.orders.read"), async (c) => {
    const q = api.ReportQuery.parse(c.req.query());
    return c.json({ report: await reports.salesReport(deps.db, c.get("scope"), q) });
  });

  const csv = (c: Context<Env>, filename: string, body: string) =>
    c.body(body, 200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    });

  // Run 26: day by day for the accountant (no buyer data, so orders.read is enough).
  app.get(`${ADMIN}/reports/daily`, ...admin, can("ticketing.orders.read"), async (c) => {
    const q = api.ReportQuery.parse(c.req.query());
    return c.json({ report: await reports.dailyReport(deps.db, c.get("scope"), q) });
  });

  app.get(`${ADMIN}/reports/daily.csv`, ...admin, can("ticketing.orders.read"), async (c) => {
    const q = api.ReportQuery.parse(c.req.query());
    const report = await reports.dailyReport(deps.db, c.get("scope"), q);
    await catalog.writeAudit(deps.db, c.get("scope"), actor(c), "reports.daily_exported", { type: "brand", id: c.get("scope").brandId }, { days: report.days.length, ...q });
    return csv(
      c,
      "alkao-ventes-par-jour.csv",
      toCsv(
        // Run 36: discount_cents last, so earlier columns keep their place.
        ["day", "orders", "subtotal_cents", "tax_cents", "gst_cents", "qst_cents", "gross_cents", "refunds", "refunded_cents", "commission_cents", "commission_refunded_cents", "net_to_client_cents", "discount_cents"],
        report.days.map((d) => [d.day, d.orders, d.subtotalCents, d.taxCents, d.gstCents, d.qstCents, d.grossCents, d.refunds, d.refundedCents, d.commissionCents, d.commissionRefundedCents, d.netToClientCents, d.discountCents]),
      ),
    );
  });

  // Run 49: sales by campaign (UTM tags the website passed at checkout), to see which ad sells.
  app.get(`${ADMIN}/reports/campaigns`, ...admin, can("ticketing.orders.read"), async (c) => {
    const q = api.ReportQuery.parse(c.req.query());
    return c.json({ report: await reports.campaignReport(deps.db, c.get("scope"), q) });
  });

  app.get(`${ADMIN}/reports/attendees.csv`, ...admin, can("ticketing.buyers.read"), async (c) => {
    const { sessionId } = api.AttendeesQuery.parse(c.req.query());
    const rows = await reports.attendeesRows(deps.db, c.get("scope"), sessionId);
    await catalog.writeAudit(deps.db, c.get("scope"), actor(c), "reports.attendees_exported", { type: "session", id: sessionId }, { rows: rows.length });
    return csv(
      c,
      `alkao-attendees-${sessionId}.csv`,
      toCsv(["order_reference", "ticket_id", "ticket_type", "ticket_type_name", "buyer_name", "buyer_email", "ticket_status", "admitted_at"], rows),
    );
  });

  app.get(`${ADMIN}/reports/orders.csv`, ...admin, can("ticketing.buyers.read"), async (c) => {
    const q = api.ReportQuery.parse(c.req.query());
    const rows = await reports.ordersRows(deps.db, c.get("scope"), q);
    await catalog.writeAudit(deps.db, c.get("scope"), actor(c), "reports.orders_exported", { type: "brand", id: c.get("scope").brandId }, { rows: rows.length, ...q });
    return csv(
      c,
      "alkao-orders.csv",
      toCsv(
        // Run 49: where each order came from, last, so earlier columns keep their place.
        ["order_reference", "status", "paid_at", "buyer_email", "subtotal_cents", "tax_cents", "total_cents", "refunded_cents", "commission_cents", "commission_refunded_cents", "discount_cents", "promo_code",
          "utm_source", "utm_medium", "utm_campaign", "utm_content", "landing"],
        rows,
      ),
    );
  });

  // ── Run 41: the customer file (CRM) ───────────────────────────────────────
  // Visits, segments and e-mail permission are computed for "today" in Québec.
  const today = () => localDate(now());

  app.get(`${ADMIN}/customers`, ...admin, can("ticketing.customers.read"), async (c) => {
    const q = api.CustomersQuery.parse(c.req.query());
    return c.json(await customersDb.listCustomers(deps.db, c.get("scope"), today(), q));
  });

  app.get(`${ADMIN}/customers.csv`, ...admin, can("ticketing.customers.export"), async (c) => {
    const q = api.CustomersExportQuery.parse(c.req.query());
    const scope = c.get("scope");
    const rows = await customersDb.exportCustomers(deps.db, scope, today(), q);
    await catalog.writeAudit(deps.db, scope, actor(c), "customers.exported", { type: "brand", id: scope.brandId }, { rows: rows.length, ...q });
    const columns = ["id", "segment", "status", "visits", "stays", "upcoming", "cancelled", "first_visit_on", "last_visit_on", "next_arrival_on",
      "favorite_category", "spent_cents", "first_name", "last_name", "email", "email_permission", "implied_consent_until", "mobile_phone",
      "home_phone", "work_phone", "address_line", "address_unit", "city", "region", "postal_code", "country", "companion_name"];
    // A byte-order mark, so a spreadsheet reads the accents in names as UTF-8.
    return csv(c, `alkao-clients-${today()}.csv`, `\uFEFF${toCsv(columns, rows.map((r) => columns.map((k) => r[k])))}`);
  });

  app.get(`${ADMIN}/customers/:customerId`, ...admin, can("ticketing.customers.read"), async (c) => {
    const id = param(c, "customerId");
    if (!id) return fail(c, 404, "customer_not_found");
    return c.json({ customer: await customersDb.getCustomer(deps.db, c.get("scope"), id, today()) });
  });

  app.patch(`${ADMIN}/customers/:customerId`, ...admin, can("ticketing.customers.write"), async (c) => {
    const id = param(c, "customerId");
    if (!id) return fail(c, 404, "customer_not_found");
    const body = api.UpdateCustomer.parse(await readJson(c));
    await withTransaction(deps.db, (tx) => customersDb.updateCustomer(tx, c.get("scope"), id, body, actor(c), now()));
    return c.json({ customer: await customersDb.getCustomer(deps.db, c.get("scope"), id, today()) });
  });

  app.post(`${ADMIN}/customers/:customerId/anonymize`, ...admin, can("ticketing.buyers.erase"), async (c) => {
    const id = param(c, "customerId");
    if (!id) return fail(c, 404, "customer_not_found");
    return c.json(await withTransaction(deps.db, (tx) => customersDb.anonymizeCustomer(tx, c.get("scope"), id, actor(c), now())));
  });

  // A report goes in by batches (each one transaction), then …/import/complete once.
  app.post(`${ADMIN}/customers/import`, ...admin, can("ticketing.customers.import"), async (c) => {
    const body = api.CustomerImportRequest.parse(await readJson(c));
    if (body.reportDate > today()) throw new DomainError("report_date_in_future");
    return c.json({ import: await withTransaction(deps.db, (tx) => customersDb.importRows(tx, c.get("scope"), body, actor(c))) });
  });

  app.post(`${ADMIN}/customers/import/complete`, ...admin, can("ticketing.customers.import"), async (c) => {
    const body = api.CustomerImportComplete.parse(await readJson(c));
    if (body.reportDate > today()) throw new DomainError("report_date_in_future");
    return c.json({ import: await withTransaction(deps.db, (tx) => customersDb.completeImport(tx, c.get("scope"), body, actor(c))) });
  });

  // ── Run 42: e-mail campaigns ──────────────────────────────────────────────
  const manageCampaigns = can("ticketing.campaigns.manage");

  app.get(`${ADMIN}/settings/marketing`, ...admin, manageCampaigns, async (c) =>
    c.json({ marketing: await campaignsDb.getMarketingSettings(deps.db, c.get("scope")) }),
  );

  app.put(`${ADMIN}/settings/marketing`, ...admin, manageCampaigns, async (c) => {
    const body = api.MarketingSettings.parse(await readJson(c));
    return c.json({ marketing: await withTransaction(deps.db, (tx) => campaignsDb.setMarketingSettings(tx, c.get("scope"), body, actor(c))) });
  });

  // Run 44: the welcome code shown once a newsletter sign-up is confirmed, and the counts.
  app.get(`${ADMIN}/settings/newsletter`, ...admin, manageCampaigns, async (c) =>
    c.json({ newsletter: await newsletterDb.getNewsletterSettings(deps.db, c.get("scope")) }),
  );

  app.put(`${ADMIN}/settings/newsletter`, ...admin, manageCampaigns, async (c) => {
    const body = api.NewsletterSettings.parse(await readJson(c));
    await withTransaction(deps.db, (tx) => newsletterDb.setNewsletterSettings(tx, c.get("scope"), body, actor(c)));
    return c.json({ newsletter: await newsletterDb.getNewsletterSettings(deps.db, c.get("scope")) });
  });

  app.get(`${ADMIN}/campaigns`, ...admin, manageCampaigns, async (c) =>
    c.json({ campaigns: await campaignsDb.listCampaigns(deps.db, c.get("scope")) }),
  );

  // How many customers an audience reaches right now (may receive e-mail, once per address).
  app.post(`${ADMIN}/campaigns/audience`, ...admin, manageCampaigns, async (c) => {
    const body = api.CampaignAudienceQuery.parse(await readJson(c));
    return c.json({ recipients: await campaignsDb.audienceCount(deps.db, c.get("scope"), today(), body, body.channel) });
  });

  app.post(`${ADMIN}/campaigns`, ...admin, manageCampaigns, async (c) => {
    const body = api.CampaignInput.parse(await readJson(c));
    return c.json({ campaign: await withTransaction(deps.db, (tx) => campaignsDb.createCampaign(tx, c.get("scope"), body, actor(c))) }, 201);
  });

  app.get(`${ADMIN}/campaigns/:campaignId`, ...admin, manageCampaigns, async (c) => {
    const id = param(c, "campaignId");
    if (!id) return fail(c, 404, "campaign_not_found");
    return c.json({ campaign: await campaignsDb.getCampaign(deps.db, c.get("scope"), id, today()) });
  });

  app.put(`${ADMIN}/campaigns/:campaignId`, ...admin, manageCampaigns, async (c) => {
    const id = param(c, "campaignId");
    if (!id) return fail(c, 404, "campaign_not_found");
    const body = api.CampaignInput.parse(await readJson(c));
    await withTransaction(deps.db, (tx) => campaignsDb.updateCampaign(tx, c.get("scope"), id, body, actor(c)));
    return c.json({ campaign: await campaignsDb.getCampaign(deps.db, c.get("scope"), id, today()) });
  });

  app.post(`${ADMIN}/campaigns/:campaignId/test`, ...admin, manageCampaigns, async (c) => {
    const id = param(c, "campaignId");
    if (!id) return fail(c, 404, "campaign_not_found");
    const body = api.CampaignTest.parse(await readJson(c));
    return c.json(await withTransaction(deps.db, (tx) => campaignsDb.queueTest(tx, c.get("scope"), id, body, actor(c), now())), 202);
  });

  app.post(`${ADMIN}/campaigns/:campaignId/send`, ...admin, manageCampaigns, async (c) => {
    const id = param(c, "campaignId");
    if (!id) return fail(c, 404, "campaign_not_found");
    const body = api.CampaignSend.parse(await readJson(c));
    await withTransaction(deps.db, (tx) => campaignsDb.sendCampaign(tx, c.get("scope"), id, body.expectedRecipients, today(), actor(c), now()));
    return c.json({ campaign: await campaignsDb.getCampaign(deps.db, c.get("scope"), id, today()) }, 202);
  });

  // ── Run 92: the writing assistant (drafts only: staff read, change and save) ──
  const assistantLimit = deps.assistantDailyLimit ?? 30;
  /** Runs one draft: off without a writer, at most N per Brand per day, each one in the Journal. */
  const assist = async (c: Context<Env>, entity: { type: string; id: string | null }, kind: string, run: (w: Writer) => Promise<{ draft: drafts.Draft; usage: drafts.DraftUsage }>) => {
    const writer = deps.writer;
    if (!writer) return fail(c, 503, "assistant_disabled");
    const scope = c.get("scope");
    const { rows: [used] } = await deps.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.ticketing_audit_log
       WHERE client_id = $1 AND brand_id = $2 AND action = 'assistant.drafted' AND created_at > $3::timestamptz - interval '24 hours'`,
      [scope.clientId, scope.brandId, now()]);
    if (used!.n >= assistantLimit) return fail(c, 429, "assistant_daily_limit");
    const record = (usage: drafts.DraftUsage | null, outcome: string) =>
      catalog.writeAudit(deps.db, scope, actor(c), "assistant.drafted", entity, { kind, outcome, ...(usage ?? {}) });
    try {
      const { draft, usage } = await run(writer);
      await record(usage, "ok");
      return c.json({ draft, model: usage.model });
    } catch (err) {
      if (err instanceof drafts.DraftRejected) {
        if (err.usage) await record(err.usage, "rejected");
        return fail(c, 422, "assistant_draft_rejected", err.problems);
      }
      if (err instanceof WriterError) {
        await record(null, err.reason);
        return fail(c, err.reason === "refused" || err.reason === "unparsed" ? 422 : 503, `assistant_${err.reason}`);
      }
      throw err;
    }
  };

  app.post(`${ADMIN}/assistant/campaign`, ...admin, manageCampaigns, async (c) => {
    const body = drafts.CampaignDraftRequest.parse(await readJson(c));
    // The event first: another Client's event is not found, whether the assistant is on or off.
    if (body.eventId) await catalog.getEvent(deps.db, c.get("scope"), body.eventId);
    return assist(c, { type: body.eventId ? "event" : "brand", id: body.eventId ?? c.get("scope").brandId }, `campaign_${body.channel}`,
      (w) => drafts.draftCampaign(deps.db, w, c.get("scope"), body, now()));
  });

  // Run 93: the event page's sections (summary, highlights, "Le jour J", FAQ).
  app.post(`${ADMIN}/events/:eventId/assistant/page`, ...admin, can("ticketing.catalog.write"), async (c) => {
    const eventId = param(c, "eventId");
    if (!eventId) return fail(c, 404, "event_not_found");
    const body = drafts.DescriptionDraftRequest.parse(await readJson(c));
    await catalog.getEvent(deps.db, c.get("scope"), eventId);
    return assist(c, { type: "event", id: eventId }, "event_page", (w) => drafts.draftEventPage(deps.db, w, c.get("scope"), eventId, body, now()));
  });

  app.post(`${ADMIN}/events/:eventId/assistant/description`, ...admin, can("ticketing.catalog.write"), async (c) => {
    const eventId = param(c, "eventId");
    if (!eventId) return fail(c, 404, "event_not_found");
    const body = drafts.DescriptionDraftRequest.parse(await readJson(c));
    await catalog.getEvent(deps.db, c.get("scope"), eventId);
    return assist(c, { type: "event", id: eventId }, "event_description", (w) => drafts.draftEventDescription(deps.db, w, c.get("scope"), eventId, body, now()));
  });

  // Run 45: an automation on or off.
  app.post(`${ADMIN}/campaigns/:campaignId/automation`, ...admin, manageCampaigns, async (c) => {
    const id = param(c, "campaignId");
    if (!id) return fail(c, 404, "campaign_not_found");
    const body = api.CampaignAutomation.parse(await readJson(c));
    await withTransaction(deps.db, (tx) => campaignsDb.setAutomation(tx, c.get("scope"), id, body.active, actor(c), now()));
    return c.json({ campaign: await campaignsDb.getCampaign(deps.db, c.get("scope"), id, today()) });
  });

  // Run 48: a campaign held for its bounces or complaints sends the rest.
  app.post(`${ADMIN}/campaigns/:campaignId/resume`, ...admin, manageCampaigns, async (c) => {
    const id = param(c, "campaignId");
    if (!id) return fail(c, 404, "campaign_not_found");
    await withTransaction(deps.db, (tx) => campaignsDb.resumeCampaign(tx, c.get("scope"), id, actor(c), now()));
    return c.json({ campaign: await campaignsDb.getCampaign(deps.db, c.get("scope"), id, today()) });
  });

  app.post(`${ADMIN}/campaigns/:campaignId/cancel`, ...admin, manageCampaigns, async (c) => {
    const id = param(c, "campaignId");
    if (!id) return fail(c, 404, "campaign_not_found");
    await withTransaction(deps.db, (tx) => campaignsDb.cancelCampaign(tx, c.get("scope"), id, actor(c), now()));
    return c.json({ campaign: await campaignsDb.getCampaign(deps.db, c.get("scope"), id, today()) });
  });

  // ── Run 04: Flex Météo session change ────────────────────────────────────
  app.post(`${PUBLIC}/orders/:orderId/exchange`, publicGate, async (c) => {
    const orderId = param(c, "orderId");
    const token = c.req.header("x-alkao-order-token");
    const scope = c.get("scope");
    if (!orderId || !(await validOrderAccessToken(deps.db, scope, orderId, token, now())))
      return fail(c, 404, "order_not_found");
    const body = api.ExchangeRequest.parse(await readJson(c));
    const result = await exchangeOrder(deps.db, scope, orderId, body.sessionId, { type: "public", id: null }, now());
    return c.json({ exchange: { orderId: result.exchangeOrderId, reference: result.reference, token: result.orderToken, tickets: result.ticketIds.length } }, 201);
  });

  app.post(`${ADMIN}/orders/:orderId/exchange`, ...admin, can("ticketing.credentials.manage"), async (c) => {
    const orderId = param(c, "orderId");
    if (!orderId) return fail(c, 404, "order_not_found");
    const body = api.ExchangeRequest.parse(await readJson(c));
    const result = await exchangeOrder(deps.db, c.get("scope"), orderId, body.sessionId, actor(c), now());
    return c.json({ exchange: { orderId: result.exchangeOrderId, reference: result.reference, token: result.orderToken, tickets: result.ticketIds.length } }, 201);
  });

  // ── Run 04: the caller's own workspaces (for the Operations app) ─────────
  // Lists only the caller's memberships: no tenant id comes from the request.
  app.get("/v1/admin/me", requireUser, async (c) => {
    const userId = c.get("userId");
    const { rows } = await deps.db.query<{ client_id: string; client_name: string; client_status: string; role: WorkspaceRole }>(
      `SELECT m.client_id, cl.name AS client_name, cl.status AS client_status, m.role
       FROM public.ticketing_memberships m JOIN public.ticketing_clients cl ON cl.id = m.client_id
       WHERE m.user_id = $1 AND m.status = 'active' ORDER BY cl.name`,
      [userId],
    );
    const memberships = [];
    for (const r of rows) {
      const { rows: brands } = await deps.db.query<{ id: string; name: string; status: string }>(
        `SELECT id, name, status FROM public.ticketing_brands WHERE client_id = $1 ORDER BY name`,
        [r.client_id],
      );
      memberships.push({
        clientId: r.client_id,
        clientName: r.client_name,
        clientStatus: r.client_status,
        role: r.role,
        brands: await Promise.all(
          brands.map(async (b) => ({ brandId: b.id, name: b.name, status: b.status, ticketing: await decide(r.client_id, b.id) })),
        ),
      });
    }
    return c.json({ userId, memberships });
  });

  mountHome(app, {
    publicUrl: deps.publicUrl ?? null,
    homeUrl: deps.homeUrl ?? null,
    now,
    load: async (): Promise<HomeBrand[]> => {
      if (!deps.operationalApiEnabled) return [];
      const at = now();
      const { rows: opted } = await deps.db.query<{ client_id: string; brand_id: string; name: string }>(
        `SELECT bs.client_id, bs.brand_id, b.name
         FROM public.ticketing_brand_settings bs
         JOIN public.ticketing_brands b ON b.id = bs.brand_id AND b.client_id = bs.client_id
         WHERE bs.show_on_alkao = true
         ORDER BY b.name, b.id`,
      );
      const brands: HomeBrand[] = [];
      for (const b of opted) {
        if (!(await decide(b.client_id, b.brand_id)).active) continue;
        const scope = { clientId: b.client_id, brandId: b.brand_id };
        const [look, listed, floors, deals] = await Promise.all([
          appearanceDb.getAppearance(deps.db, scope),
          catalog.listPublicEvents(deps.db, scope),
          catalog.admissionPriceFloors(deps.db, scope, at),
          // Run 97: presales and coupons on now.
          catalog.eventDeals(deps.db, scope, at),
        ]);
        const events: HomeBrand["events"] = [];
        for (const event of listed) {
          const eventId = String(event.id);
          const state = await catalog.loadPublicEvent(deps.db, scope, eventId);
          if (!state) continue;
          if (state.salesOpenAt && at < new Date(state.salesOpenAt)) continue;
          if (state.salesCloseAt && at >= new Date(state.salesCloseAt)) continue;
          const sessions = await catalog.listPublicSessions(deps.db, scope, eventId, at);
          const open = sessions.filter((session) => Number(session.available) > 0);
          const first = open[0];
          if (!first) continue;
          events.push({
            id: eventId,
            title: String(event.title),
            description: event.description == null ? null : String(event.description),
            imageUrl: event.imageUrl == null ? null : String(event.imageUrl),
            venueId: String(event.venueId),
            venueName: event.venueName == null ? null : String(event.venueName),
            venueCity: event.venueCity == null ? null : String(event.venueCity),
            venueAddress: event.venueAddress == null ? null : String(event.venueAddress),
            // Run 69: what the organizer says about the event.
            category: event.category == null ? null : String(event.category),
            minAge: event.minAge == null ? null : Number(event.minAge),
            doorsOpenMinutes: event.doorsOpenMinutes == null ? null : Number(event.doorsOpenMinutes),
            language: event.language == null ? null : String(event.language),
            accessibility: event.accessibility == null ? null : String(event.accessibility),
            startsAt: first.startsAt as Date | string,
            // Run 64: every date with seats left, the venue's time zone and the lowest price.
            sessions: open.slice(0, 60).map((session) => session.startsAt as Date | string),
            // Run 66: when each of those dates ends, if the organizer set it (for the calendar).
            ends: open.slice(0, 60).map((session) => (session.endsAt ?? null) as Date | string | null),
            timezone: event.venueTimezone == null ? null : String(event.venueTimezone),
            ...(floors.has(eventId) ? { fromCents: floors.get(eventId)! } : {}),
            ...(deals.has(eventId) ? { presale: deals.get(eventId)!.presale, coupon: deals.get(eventId)!.coupon, pass: deals.get(eventId)!.pass ?? null } : {}),
            shopPath: `/acheter/${b.client_id}/${b.brand_id}/${eventId}`,
          });
        }
        if (events.length) {
          brands.push({
            clientId: b.client_id,
            brandId: b.brand_id,
            name: b.name ?? look.brandName ?? "ALKAO",
            logoUrl: look.logoUrl,
            events,
          });
        }
      }
      return brands;
    },
  });
  mountOpsUi(app, { ...(deps.opsUi ?? { supabaseUrl: null, supabaseAnonKey: null, frameAncestors: [] }), paymentsMode: deps.paymentsMode ?? null });
  mountBuyerUi(app);
  mountUnsubscribe(app, { db: deps.db, masterSecret: deps.credentialMasterSecret ?? null, now });
  mountNewsletterPage(app, { db: deps.db, masterSecret: deps.credentialMasterSecret ?? null, now });
  mountShopUi(app, {
    publicUrl: deps.publicUrl ?? null,
    paymentsMode: deps.paymentsMode ?? null,
    // Run 53: a shared link's preview, under the same gate as the public API.
    preview: async (clientId, brandId, eventId) => {
      if (!(await decide(clientId, brandId)).active) return null;
      const scope = { clientId, brandId };
      if (!eventId) {
        const look = await appearanceDb.getAppearance(deps.db, scope);
        return { title: null, description: null, imageUrl: look.logoUrl, brandName: look.brandName, place: null };
      }
      if (!(await catalog.loadPublicEvent(deps.db, scope, eventId))) return null;
      const [details, place] = await Promise.all([catalog.getEvent(deps.db, scope, eventId), catalog.loadPublicEventPlace(deps.db, scope, eventId)]);
      const venue = place.venue ? [place.venue.name, place.venue.city].filter(Boolean).join(", ") : null;
      return {
        title: details.title as string,
        description: (details.description as string | null) ?? null,
        imageUrl: (details.imageUrl as string | null) ?? place.brand?.logoUrl ?? null,
        brandName: place.brand?.name ?? null,
        place: venue,
      };
    },
  });

  return app;
}
