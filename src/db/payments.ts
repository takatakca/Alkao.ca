import type { CommissionTerms } from "../domain/commission.js";
import { DomainError } from "../domain/errors.js";
import type { TicketKind } from "../domain/catalog.js";
import { isTaxRegion, type TaxRegion } from "../domain/tax.js";
import { toApi } from "./catalog.js";
import type { TenantScope } from "./commerce.js";
import type { Db, Tx } from "./pool.js";

type Queryable = Db | Tx;

// ── Connected accounts and brand settings ───────────────────────────────────
export interface PaymentAccountRow {
  stripeAccountId: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
}

export async function getPaymentAccount(q: Queryable, clientId: string): Promise<PaymentAccountRow | null> {
  const { rows } = await q.query<{ stripe_account_id: string; charges_enabled: boolean; payouts_enabled: boolean; details_submitted: boolean }>(
    `SELECT stripe_account_id, charges_enabled, payouts_enabled, details_submitted
     FROM public.ticketing_payment_accounts WHERE client_id = $1`,
    [clientId],
  );
  const r = rows[0];
  return r
    ? { stripeAccountId: r.stripe_account_id, chargesEnabled: r.charges_enabled, payoutsEnabled: r.payouts_enabled, detailsSubmitted: r.details_submitted }
    : null;
}

export async function insertPaymentAccount(q: Queryable, clientId: string, stripeAccountId: string): Promise<void> {
  await q.query(
    `INSERT INTO public.ticketing_payment_accounts (client_id, stripe_account_id) VALUES ($1, $2)
     ON CONFLICT (client_id) DO NOTHING`,
    [clientId, stripeAccountId],
  );
}

/** Update a connected account's capabilities. Returns the Client it belongs to, or null. */
export async function updatePaymentAccountStatus(
  q: Queryable,
  s: { accountId: string; chargesEnabled: boolean; payoutsEnabled: boolean; detailsSubmitted: boolean },
): Promise<string | null> {
  const { rows } = await q.query<{ client_id: string }>(
    `UPDATE public.ticketing_payment_accounts
     SET charges_enabled = $2, payouts_enabled = $3, details_submitted = $4
     WHERE stripe_account_id = $1 RETURNING client_id`,
    [s.accountId, s.chargesEnabled, s.payoutsEnabled, s.detailsSubmitted],
  );
  return rows[0]?.client_id ?? null;
}

export async function getCheckoutReturnOrigins(q: Queryable, s: TenantScope): Promise<string[]> {
  const { rows } = await q.query<{ origins: string[] }>(
    `SELECT checkout_return_origins AS origins FROM public.ticketing_brand_settings WHERE client_id = $1 AND brand_id = $2`,
    [s.clientId, s.brandId],
  );
  return rows[0]?.origins ?? [];
}

export async function setCheckoutReturnOrigins(q: Queryable, s: TenantScope, origins: string[]): Promise<string[]> {
  const { rows } = await q.query<{ origins: string[] }>(
    `INSERT INTO public.ticketing_brand_settings (client_id, brand_id, checkout_return_origins) VALUES ($1, $2, $3)
     ON CONFLICT (client_id, brand_id) DO UPDATE SET checkout_return_origins = EXCLUDED.checkout_return_origins
     RETURNING checkout_return_origins AS origins`,
    [s.clientId, s.brandId, origins],
  );
  return rows[0]!.origins;
}

export async function getCommissionTerms(q: Queryable, clientId: string): Promise<CommissionTerms> {
  const { rows } = await q.query<{ rate: number; fixed: number }>(
    `SELECT commission_rate_bps AS rate, commission_fixed_cents AS fixed FROM public.ticketing_clients WHERE id = $1`,
    [clientId],
  );
  const r = rows[0];
  if (!r) throw new DomainError("unknown_client");
  return { rateBps: r.rate, fixedCentsPerPaidAdmission: r.fixed };
}

// ── Holds entering checkout ─────────────────────────────────────────────────
export interface CheckoutHold {
  id: string;
  eventId: string;
  sessionId: string;
  status: string;
  expiresAt: Date;
  taxRegion: TaxRegion;
  items: { ticketTypeId: string; code: string; name: string; kind: TicketKind; quantity: number; unitPriceCents: number }[];
}

/** Lock a hold and load its priced items (prices captured at hold time) and tax region. */
export async function lockHoldForCheckout(tx: Tx, s: TenantScope, holdId: string): Promise<CheckoutHold | null> {
  const { rows } = await tx.query<{ id: string; event_id: string; session_id: string; status: string; expires_at: Date; tax_region: string }>(
    `SELECT h.id, h.event_id, h.session_id, h.status, h.expires_at, v.tax_region
     FROM public.ticketing_holds h
     JOIN public.ticketing_events e ON e.id = h.event_id AND e.client_id = h.client_id AND e.brand_id = h.brand_id
     JOIN public.ticketing_venues v ON v.id = e.venue_id AND v.client_id = e.client_id AND v.brand_id = e.brand_id
     WHERE h.id = $1 AND h.client_id = $2 AND h.brand_id = $3
     FOR UPDATE OF h`,
    [holdId, s.clientId, s.brandId],
  );
  const h = rows[0];
  if (!h) return null;
  if (!isTaxRegion(h.tax_region)) throw new DomainError("unsupported_tax_region");
  const { rows: items } = await tx.query<{ ticket_type_id: string; code: string; name: string; kind: TicketKind; quantity: number; unit_price_cents: number }>(
    `SELECT i.ticket_type_id, t.code, t.name, t.kind, i.quantity, i.unit_price_cents
     FROM public.ticketing_hold_items i
     JOIN public.ticketing_ticket_types t ON t.id = i.ticket_type_id AND t.client_id = i.client_id AND t.brand_id = i.brand_id
     WHERE i.hold_id = $1 AND i.client_id = $2 AND i.brand_id = $3
     ORDER BY t.sort_order, t.code`,
    [holdId, s.clientId, s.brandId],
  );
  return {
    id: h.id,
    eventId: h.event_id,
    sessionId: h.session_id,
    status: h.status,
    expiresAt: h.expires_at,
    taxRegion: h.tax_region,
    items: items.map((i) => ({
      ticketTypeId: i.ticket_type_id, code: i.code, name: i.name, kind: i.kind, quantity: i.quantity, unitPriceCents: i.unit_price_cents,
    })),
  };
}

export async function extendHold(tx: Tx, holdId: string, expiresAt: Date): Promise<void> {
  await tx.query(`UPDATE public.ticketing_holds SET expires_at = greatest(expires_at, $2) WHERE id = $1 AND status = 'active'`, [holdId, expiresAt]);
}

// ── Orders and payments ─────────────────────────────────────────────────────
export interface OrderForHold {
  id: string;
  reference: string;
  status: string;
  totalCents: number;
  payment: { id: string; status: string; checkoutUrl: string | null; checkoutSessionId: string | null; expiresAt: Date } | null;
}

export async function findOrderForHold(tx: Tx, s: TenantScope, holdId: string): Promise<OrderForHold | null> {
  const { rows } = await tx.query<{
    id: string; reference: string; status: string; total_cents: number;
    p_id: string | null; p_status: string | null; checkout_url: string | null; checkout_session_id: string | null; p_expires: Date | null;
  }>(
    `SELECT o.id, o.reference, o.status, o.total_cents,
            p.id AS p_id, p.status AS p_status, p.checkout_url, p.checkout_session_id, p.expires_at AS p_expires
     FROM public.ticketing_orders o
     LEFT JOIN public.ticketing_payments p ON p.order_id = o.id
     WHERE o.hold_id = $1 AND o.client_id = $2 AND o.brand_id = $3
     FOR UPDATE OF o`,
    [holdId, s.clientId, s.brandId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    reference: r.reference,
    status: r.status,
    totalCents: r.total_cents,
    payment: r.p_id
      ? { id: r.p_id, status: r.p_status!, checkoutUrl: r.checkout_url, checkoutSessionId: r.checkout_session_id, expiresAt: r.p_expires! }
      : null,
  };
}

export async function insertPayment(
  tx: Tx,
  p: TenantScope & { eventId: string; orderId: string; stripeAccountId: string; amountCents: number; applicationFeeCents: number; expiresAt: Date },
): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO public.ticketing_payments
       (client_id, brand_id, event_id, order_id, stripe_account_id, amount_cents, application_fee_cents, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [p.clientId, p.brandId, p.eventId, p.orderId, p.stripeAccountId, p.amountCents, p.applicationFeeCents, p.expiresAt],
  );
  return rows[0]!.id;
}

export async function setPaymentSession(q: Queryable, paymentId: string, sessionId: string, url: string): Promise<void> {
  await q.query(
    `UPDATE public.ticketing_payments SET checkout_session_id = $2, checkout_url = $3
     WHERE id = $1 AND (checkout_session_id IS NULL OR checkout_session_id = $2)`,
    [paymentId, sessionId, url],
  );
}

export interface PaymentRow {
  id: string;
  clientId: string;
  brandId: string;
  eventId: string;
  orderId: string;
  stripeAccountId: string;
  paymentIntentId: string | null;
  amountCents: number;
  applicationFeeCents: number;
  status: "open" | "paid" | "expired";
}

const PAYMENT_COLUMNS = `id, client_id, brand_id, event_id, order_id, stripe_account_id, payment_intent_id, amount_cents, application_fee_cents, status`;

function paymentRow(r: Record<string, unknown>): PaymentRow {
  return toApi(r) as unknown as PaymentRow;
}

export async function lockPaymentBySession(tx: Tx, sessionId: string): Promise<PaymentRow | null> {
  const { rows } = await tx.query(`SELECT ${PAYMENT_COLUMNS} FROM public.ticketing_payments WHERE checkout_session_id = $1 FOR UPDATE`, [sessionId]);
  return rows[0] ? paymentRow(rows[0]) : null;
}

export async function lockPaymentByIntent(tx: Tx, paymentIntentId: string): Promise<PaymentRow | null> {
  const { rows } = await tx.query(`SELECT ${PAYMENT_COLUMNS} FROM public.ticketing_payments WHERE payment_intent_id = $1 FOR UPDATE`, [paymentIntentId]);
  return rows[0] ? paymentRow(rows[0]) : null;
}

export async function getPaymentForOrder(q: Queryable, s: TenantScope, orderId: string): Promise<PaymentRow | null> {
  const { rows } = await q.query(
    `SELECT ${PAYMENT_COLUMNS} FROM public.ticketing_payments WHERE order_id = $1 AND client_id = $2 AND brand_id = $3`,
    [orderId, s.clientId, s.brandId],
  );
  return rows[0] ? paymentRow(rows[0]) : null;
}

export async function markPaymentPaid(tx: Tx, paymentId: string, paymentIntentId: string, paidAt: Date): Promise<void> {
  await tx.query(`UPDATE public.ticketing_payments SET status = 'paid', payment_intent_id = $2, paid_at = $3 WHERE id = $1`, [paymentId, paymentIntentId, paidAt]);
}

// ── Refunds ─────────────────────────────────────────────────────────────────
export interface RefundRow {
  id: string;
  clientId: string;
  brandId: string;
  orderId: string;
  amountCents: number;
  commissionRefundCents: number;
  voidTicketIds: string[];
  status: "pending" | "succeeded" | "canceled";
  stripeRefundId: string | null;
  stripeFeeRefundId: string | null;
  lastError: string | null;
  reason: string | null;
  requestedBy: string;
  createdAt: Date;
  completedAt: Date | null;
}

const REFUND_COLUMNS = `id, client_id, brand_id, order_id, amount_cents, commission_refund_cents, void_ticket_ids, status,
  stripe_refund_id, stripe_fee_refund_id, last_error, reason, requested_by, created_at, completed_at`;

export async function insertRefund(
  tx: Tx,
  r: TenantScope & { eventId: string; orderId: string; amountCents: number; commissionRefundCents: number; voidTicketIds: string[]; reason: string | null; requestedBy: string },
): Promise<RefundRow> {
  try {
    const { rows } = await tx.query(
      `INSERT INTO public.ticketing_refunds
         (client_id, brand_id, event_id, order_id, amount_cents, commission_refund_cents, void_ticket_ids, reason, requested_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${REFUND_COLUMNS}`,
      [r.clientId, r.brandId, r.eventId, r.orderId, r.amountCents, r.commissionRefundCents, r.voidTicketIds, r.reason, r.requestedBy],
    );
    return toApi(rows[0]) as unknown as RefundRow;
  } catch (error) {
    if ((error as { constraint?: string }).constraint === "ticketing_refunds_one_pending") throw new DomainError("refund_in_progress");
    throw error;
  }
}

export async function getRefund(q: Queryable, s: TenantScope, refundId: string, lock = false): Promise<RefundRow | null> {
  const { rows } = await q.query(
    `SELECT ${REFUND_COLUMNS} FROM public.ticketing_refunds WHERE id = $1 AND client_id = $2 AND brand_id = $3${lock ? " FOR UPDATE" : ""}`,
    [refundId, s.clientId, s.brandId],
  );
  return rows[0] ? (toApi(rows[0]) as unknown as RefundRow) : null;
}

export async function listRefunds(q: Queryable, s: TenantScope, orderId: string): Promise<RefundRow[]> {
  const { rows } = await q.query(
    `SELECT ${REFUND_COLUMNS} FROM public.ticketing_refunds WHERE order_id = $1 AND client_id = $2 AND brand_id = $3 ORDER BY created_at`,
    [orderId, s.clientId, s.brandId],
  );
  return rows.map((r) => toApi(r) as unknown as RefundRow);
}

export async function recordRefundProgress(q: Queryable, refundId: string, p: { stripeRefundId?: string; stripeFeeRefundId?: string; lastError?: string | null }): Promise<void> {
  await q.query(
    `UPDATE public.ticketing_refunds SET
       stripe_refund_id = coalesce($2, stripe_refund_id),
       stripe_fee_refund_id = coalesce($3, stripe_fee_refund_id),
       last_error = CASE WHEN $5 THEN $4 ELSE last_error END
     WHERE id = $1`,
    [refundId, p.stripeRefundId ?? null, p.stripeFeeRefundId ?? null, p.lastError ?? null, p.lastError !== undefined],
  );
}

// ── Provider webhook inbox ──────────────────────────────────────────────────
/** Record a provider event; false if it was already recorded (redelivery). */
export async function recordPaymentEvent(
  tx: Tx,
  e: { eventId: string; type: string; accountId: string | null; clientId: string | null; outcome: "processed" | "ignored" },
): Promise<boolean> {
  const r = await tx.query(
    `INSERT INTO public.ticketing_payment_events (event_id, type, stripe_account_id, client_id, outcome)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (event_id) DO NOTHING`,
    [e.eventId, e.type, e.accountId, e.clientId, e.outcome],
  );
  return (r.rowCount ?? 0) === 1;
}

// ── After the sale: disputes and refunds made outside ALKAO (Run 19) ────────
/** Stripe dispute statuses after which nothing is left to do. */
export const CLOSED_DISPUTE_STATUSES = ["won", "lost", "warning_closed", "prevented"];

export interface DisputeReport {
  stripeDisputeId: string;
  amountCents: number;
  currency: string;
  reason: string;
  status: string;
  evidenceDueBy: Date | null;
}

/**
 * Record a dispute as Stripe reports it. An event older than the last one applied changes
 * nothing. Returns whether the dispute is new, or null when the event was stale.
 */
export async function upsertDispute(
  tx: Tx,
  p: PaymentRow,
  d: DisputeReport & { occurredAt: Date },
): Promise<{ created: boolean } | null> {
  const { rows } = await tx.query<{ created: boolean }>(
    `INSERT INTO public.ticketing_payment_disputes
       (client_id, brand_id, event_id, order_id, stripe_dispute_id, amount_cents, currency, reason, status, evidence_due_by, provider_updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, left($8, 100), left($9, 100), $10, $11)
     ON CONFLICT (stripe_dispute_id) DO UPDATE SET
       amount_cents = EXCLUDED.amount_cents, currency = EXCLUDED.currency, reason = EXCLUDED.reason, status = EXCLUDED.status,
       evidence_due_by = EXCLUDED.evidence_due_by, provider_updated_at = EXCLUDED.provider_updated_at
     WHERE ticketing_payment_disputes.provider_updated_at <= EXCLUDED.provider_updated_at
       AND ticketing_payment_disputes.order_id = EXCLUDED.order_id
     RETURNING (xmax = 0) AS created`,
    [p.clientId, p.brandId, p.eventId, p.orderId, d.stripeDisputeId, d.amountCents, d.currency.toLowerCase(), d.reason, d.status, d.evidenceDueBy, d.occurredAt],
  );
  return rows[0] ?? null;
}

/** Keep Stripe's running refunded total for the order's charge; returns the total kept. */
export async function recordChargeRefundTotal(tx: Tx, p: PaymentRow, refundedCents: number, occurredAt: Date): Promise<number> {
  const { rows } = await tx.query<{ refunded_cents: number }>(
    `INSERT INTO public.ticketing_charge_refund_totals (order_id, client_id, brand_id, event_id, refunded_cents, provider_updated_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (order_id) DO UPDATE SET
       refunded_cents = GREATEST(ticketing_charge_refund_totals.refunded_cents, EXCLUDED.refunded_cents),
       provider_updated_at = GREATEST(ticketing_charge_refund_totals.provider_updated_at, EXCLUDED.provider_updated_at)
     RETURNING refunded_cents`,
    [p.orderId, p.clientId, p.brandId, p.eventId, refundedCents, occurredAt],
  );
  return rows[0]!.refunded_cents;
}

/**
 * What ALKAO refunded or is refunding on an order, and the part of Stripe's refunded total
 * that ALKAO did not issue. A refund ALKAO has started counts at once, so its own
 * charge.refunded event never looks like a refund made elsewhere.
 */
export async function outsideRefund(q: Queryable, s: TenantScope, orderId: string): Promise<{ stripeRefundedCents: number; alkaoRefundedCents: number; outsideCents: number }> {
  const { rows } = await q.query<{ stripe: number | null; alkao: number }>(
    `SELECT (SELECT refunded_cents FROM public.ticketing_charge_refund_totals WHERE order_id = $1 AND client_id = $2 AND brand_id = $3) AS stripe,
            (SELECT coalesce(sum(amount_cents), 0)::int FROM public.ticketing_refunds
              WHERE order_id = $1 AND client_id = $2 AND brand_id = $3 AND status IN ('pending', 'succeeded')) AS alkao`,
    [orderId, s.clientId, s.brandId],
  );
  const stripe = rows[0]?.stripe ?? 0;
  const alkao = rows[0]?.alkao ?? 0;
  return { stripeRefundedCents: stripe, alkaoRefundedCents: alkao, outsideCents: Math.max(0, stripe - alkao) };
}

const DISPUTE_COLUMNS = `d.id, d.order_id, d.stripe_dispute_id, d.amount_cents, d.currency, d.reason, d.status, d.evidence_due_by,
  NOT (d.status = ANY($4::text[])) AS open, d.created_at, d.updated_at`;

export async function orderDisputes(q: Queryable, s: TenantScope, orderId: string) {
  const { rows } = await q.query(
    `SELECT ${DISPUTE_COLUMNS} FROM public.ticketing_payment_disputes d
     WHERE d.order_id = $1 AND d.client_id = $2 AND d.brand_id = $3 ORDER BY d.created_at`,
    [orderId, s.clientId, s.brandId, CLOSED_DISPUTE_STATUSES],
  );
  return rows.map(toApi);
}

/** The Brand's disputes, open ones first (earliest deadline first), then the latest closed. */
export async function listDisputes(q: Queryable, s: TenantScope, openOnly: boolean, limit = 100) {
  const { rows } = await q.query(
    `SELECT ${DISPUTE_COLUMNS}, o.reference, b.email AS buyer_email, b.full_name AS buyer_name
     FROM public.ticketing_payment_disputes d
     JOIN public.ticketing_orders o ON o.id = d.order_id AND o.client_id = d.client_id AND o.brand_id = d.brand_id
     JOIN public.ticketing_buyers b ON b.id = o.buyer_id AND b.client_id = o.client_id AND b.brand_id = o.brand_id
     WHERE d.client_id = $1 AND d.brand_id = $2 AND (NOT $3::boolean OR NOT (d.status = ANY($4::text[])))
     ORDER BY (d.status = ANY($4::text[])), d.evidence_due_by NULLS LAST, d.created_at DESC
     LIMIT $5`,
    [s.clientId, s.brandId, openOnly, CLOSED_DISPUTE_STATUSES, limit],
  );
  return rows.map(toApi);
}
