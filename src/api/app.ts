import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
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
import { roleHasPermission, type TicketingPermission, type WorkspaceRole } from "../domain/permissions.js";
import { buildQuote } from "../domain/pricing.js";
import { AuthError, type AuthVerifier } from "./auth.js";
import { verifyControlSignature } from "./control-signature.js";
import { errorResponse, fail, readJson } from "./http.js";
import { FixedWindowLimiter } from "./rate-limit.js";
import { WebhookSignatureError, type PaymentGateway } from "../payments/gateway.js";
import { PaymentsService } from "../payments/service.js";
import * as paymentsDb from "../db/payments.js";
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
import { localDate } from "../domain/customers.js";
import * as journal from "../ops/journal.js";
import * as sessionBatch from "../ops/session-batch.js";
import { exchangeOrder } from "../ops/exchange.js";
import { mountOpsUi, type OpsUiConfig } from "./ops-ui.js";
import { mountBuyerUi } from "./buyer-ui.js";
import { mountShopUi } from "./shop-ui.js";
import { clientIp, ipKind } from "./client-ip.js";
import * as delivery from "../delivery/db.js";
import { orderEmailToken } from "../delivery/links.js";
import * as cancellation from "../ops/cancellation.js";

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
  /** Standalone Operations web app served under /ops. */
  opsUi?: OpsUiConfig;
  /** Public HTTPS URL of this ALKAO deployment (hosted shop, ticket links). */
  publicUrl?: string | null;
  /** Reverse proxies in front of ALKAO whose X-Forwarded-For entry is trusted (default 1). */
  trustedProxyHops?: number;
  /** Log one line per request (route pattern, status, duration). */
  logRequests?: boolean;
  /** Bearer token for GET /metrics (Run 24); without it the route answers 404. */
  metricsToken?: string | null;
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
  app.get("/health", (c) => c.json({ ok: true, service: "alkao", api: API_VERSION, control: CONTROL_CONTRACT_VERSION }));
  // Run 14: readiness for the load balancer — the database answers within 2 s.
  app.get("/health/ready", async (c) => {
    try {
      await Promise.race([deps.db.query("SELECT 1"), new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 2000))]);
      return c.json({ ok: true, database: "up" });
    } catch {
      return c.json({ ok: false, database: "down" }, 503);
    }
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
    return c.json({ events: await catalog.listPublicEvents(deps.db, c.get("scope")) });
  });

  app.get(`${PUBLIC}/events/:eventId`, publicGate, async (c) => {
    const scope = c.get("scope");
    const eventId = param(c, "eventId");
    const event = eventId ? await catalog.loadPublicEvent(deps.db, scope, eventId) : null;
    if (!eventId || !event) return fail(c, 404, "event_not_found");
    const [details, types, sessions] = await Promise.all([
      catalog.getEvent(deps.db, scope, eventId),
      catalog.loadTicketTypeRules(deps.db, scope, eventId),
      catalog.listPublicSessions(deps.db, scope, eventId, now()),
    ]);
    const { status: _status, createdAt: _c, updatedAt: _u, ...publicDetails } = details;
    // Run 08: what the hosted shop shows (Brand and venue names).
    const place = await catalog.loadPublicEventPlace(deps.db, scope, eventId);
    return c.json({
      event: { ...publicDetails, taxRegion: event.taxRegion, ...place },
      ticketTypes: types
        .filter((t) => t.active)
        .map(({ active: _a, ...t }) => t),
      sessions,
    });
  });

  app.post(`${PUBLIC}/events/:eventId/quote`, publicGate, async (c) => {
    const scope = c.get("scope");
    const eventId = param(c, "eventId");
    const event = eventId ? await catalog.loadPublicEvent(deps.db, scope, eventId) : null;
    if (!eventId || !event) return fail(c, 404, "event_not_found");
    const body = api.QuoteRequest.parse(await readJson(c));
    const rules = await catalog.loadTicketTypeRules(deps.db, scope, eventId);
    // Run 36: a promo code the buyer can use now, or promo_code_invalid with the reason.
    const promo = body.promoCode ? await promoDb.usablePromo(deps.db, scope, eventId, body.promoCode, now()) : null;
    const result = buildQuote(rules, body.items, event.taxRegion, undefined, promo);
    if (!result.ok) return fail(c, 422, "cart_invalid", result.violations);
    return c.json({ quote: result.quote });
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
    if (!isSessionSellable(event, session, now())) return fail(c, 409, "session_not_available");

    const rules = await catalog.loadTicketTypeRules(deps.db, scope, session.eventId);
    const promo = body.promoCode ? await promoDb.usablePromo(deps.db, scope, session.eventId, body.promoCode, now()) : null;
    const result = buildQuote(rules, body.items, event.taxRegion, undefined, promo);
    if (!result.ok) return fail(c, 422, "cart_invalid", result.violations);
    const quote = result.quote;

    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now().getTime() + deps.holdTtlSeconds * 1000);
    const hold = await withTransaction(deps.db, async (tx) => {
      const created = await createHold(
        tx,
        {
          ...scope,
          eventId: session.eventId,
          sessionId: session.id,
          admissions: quote.admissions,
          items: quote.lines.map((l) => ({ ticketTypeId: l.ticketTypeId, quantity: l.quantity, unitPriceCents: l.unitPriceCents })),
          expiresAt,
          promoCodeId: promo?.id ?? null,
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
    return c.json({ hold: { id: hold.id, token, expiresAt: hold.expiresAt, sessionId: session.id, quote } }, 201);
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
    return c.json({ role: c.get("role"), ticketing: decision });
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
    const venue = await withTransaction(deps.db, async (tx) => {
      const v = await catalog.updateVenue(tx, c.get("scope"), venueId, body);
      await catalog.writeAudit(tx, c.get("scope"), actor(c), "venue.updated", { type: "venue", id: venueId }, { fields: Object.keys(body) });
      return v;
    });
    return c.json({ venue });
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
    return c.json({ sessions: await catalog.listSessions(deps.db, c.get("scope"), eventId) });
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
    const session = await withTransaction(deps.db, async (tx) => {
      if (body.status === "cancelled") {
        // Run 10: a session with buyers is cancelled through POST …/cancel, which refunds them.
        const { rows } = await tx.query<{ n: number }>(
          `SELECT (sold_count + reserved_count)::int AS n FROM public.ticketing_sessions WHERE id = $1 AND client_id = $2 AND brand_id = $3 FOR UPDATE`,
          [sessionId, c.get("scope").clientId, c.get("scope").brandId],
        );
        if ((rows[0]?.n ?? 0) > 0) throw new DomainError("use_session_cancellation");
      }
      const s = await catalog.updateSession(tx, c.get("scope"), sessionId, body);
      await catalog.writeAudit(tx, c.get("scope"), actor(c), "session.updated", { type: "session", id: sessionId }, body);
      return s;
    });
    return c.json({ session });
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
    if (!orderId || !token || token.length > 100) return fail(c, 404, "order_not_found");
    const { rowCount } = await deps.db.query(
      `SELECT 1 FROM public.ticketing_access_tokens
       WHERE token_hash = $1 AND subject_type = 'order' AND subject_id = $2 AND client_id = $3 AND brand_id = $4`,
      [sha256(token), orderId, scope.clientId, scope.brandId],
    );
    if (!rowCount) return fail(c, 404, "order_not_found");
    const order = await catalog.getOrder(deps.db, scope, orderId);
    const { commissionCents: _c, commissionRefundedCents: _cr, buyerPhone: _p, ...publicOrder } = order;
    // QR payload per valid ticket (null for void tickets, or until credentials are configured).
    const payloads = await credentials.payloadsForOrder(scope, orderId);
    const tickets = (order.tickets as { id: string }[]).map((t) => ({ ...t, credential: payloads.get(t.id) ?? null }));
    // Run 06: what the buyer's ticket page shows (brand, event, session, venue, Flex option).
    const context = await delivery.publicOrderContext(deps.db, scope, orderId);
    return c.json({ order: { ...publicOrder, tickets, ...context } });
  });

  // ── Run 02: Stripe webhooks ──────────────────────────────────────────────
  // Authenticated by the Stripe signature, not by the Ticketing gate: a checkout opened
  // while Ticketing was active must still be fulfilled (or refunded) if it is revoked
  // before the buyer pays.
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
        ["order_reference", "status", "paid_at", "buyer_email", "subtotal_cents", "tax_cents", "total_cents", "refunded_cents", "commission_cents", "commission_refunded_cents", "discount_cents", "promo_code"],
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
    const body = api.CampaignAudience.parse(await readJson(c));
    return c.json({ recipients: await campaignsDb.audienceCount(deps.db, c.get("scope"), today(), body) });
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
    return c.json(await withTransaction(deps.db, (tx) => campaignsDb.queueTest(tx, c.get("scope"), id, body.email, actor(c), now())), 202);
  });

  app.post(`${ADMIN}/campaigns/:campaignId/send`, ...admin, manageCampaigns, async (c) => {
    const id = param(c, "campaignId");
    if (!id) return fail(c, 404, "campaign_not_found");
    const body = api.CampaignSend.parse(await readJson(c));
    await withTransaction(deps.db, (tx) => campaignsDb.sendCampaign(tx, c.get("scope"), id, body.expectedRecipients, today(), actor(c), now()));
    return c.json({ campaign: await campaignsDb.getCampaign(deps.db, c.get("scope"), id, today()) }, 202);
  });

  // Run 45: an automation on or off.
  app.post(`${ADMIN}/campaigns/:campaignId/automation`, ...admin, manageCampaigns, async (c) => {
    const id = param(c, "campaignId");
    if (!id) return fail(c, 404, "campaign_not_found");
    const body = api.CampaignAutomation.parse(await readJson(c));
    await withTransaction(deps.db, (tx) => campaignsDb.setAutomation(tx, c.get("scope"), id, body.active, actor(c), now()));
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
    if (!orderId || !token || token.length > 100) return fail(c, 404, "order_not_found");
    const { rowCount } = await deps.db.query(
      `SELECT 1 FROM public.ticketing_access_tokens
       WHERE token_hash = $1 AND subject_type = 'order' AND subject_id = $2 AND client_id = $3 AND brand_id = $4`,
      [sha256(token), orderId, scope.clientId, scope.brandId],
    );
    if (!rowCount) return fail(c, 404, "order_not_found");
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

  mountOpsUi(app, { ...(deps.opsUi ?? { supabaseUrl: null, supabaseAnonKey: null, frameAncestors: [] }), paymentsMode: deps.paymentsMode ?? null });
  mountBuyerUi(app);
  mountUnsubscribe(app, { db: deps.db, masterSecret: deps.credentialMasterSecret ?? null, now });
  mountNewsletterPage(app, { db: deps.db, masterSecret: deps.credentialMasterSecret ?? null, now });
  mountShopUi(app, { publicUrl: deps.publicUrl ?? null, paymentsMode: deps.paymentsMode ?? null });

  return app;
}
