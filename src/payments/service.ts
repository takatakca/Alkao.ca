import { createHash, randomBytes } from "node:crypto";
import { writeAudit } from "../db/catalog.js";
import { createOrderFromHold, recordOrderPaid, type BuyerInput, type TenantScope } from "../db/commerce.js";
import { mapDbErrors } from "../db/errors.js";
import * as payments from "../db/payments.js";
import { withTransaction, type Db, type Tx } from "../db/pool.js";
import { applyRefund, computeCommission } from "../domain/commission.js";
import { DomainError } from "../domain/errors.js";
import { CHECKOUT_HOLD_GRACE_SECONDS, CHECKOUT_SESSION_SECONDS, orderStatusAfterRefund } from "../domain/lifecycle.js";
import { quoteFromLines, type Quote } from "../domain/pricing.js";
import { PaymentProviderError, type CheckoutLineItem, type PaymentGateway, type PaymentWebhookEvent } from "./gateway.js";

export interface PaymentsDeps {
  db: Db;
  gateway: PaymentGateway | null;
  now: () => Date;
  onboarding: { refreshUrl: string; returnUrl: string } | null;
  /** ALKAO's own public origin (the hosted shop): always allowed as a Checkout return URL. */
  shopOrigin?: string | null;
}

export type Actor = { type: "user" | "system" | "public"; id: string | null };

export type CheckoutResult =
  | { kind: "free"; orderId: string; reference: string; orderToken: string }
  | { kind: "redirect"; orderId: string; reference: string; orderToken: string; checkoutUrl: string };

const sha256 = (value: string) => createHash("sha256").update(value).digest();

async function issueOrderToken(tx: Tx, s: TenantScope, orderId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await tx.query(
    `INSERT INTO public.ticketing_access_tokens (token_hash, client_id, brand_id, subject_type, subject_id)
     VALUES ($1, $2, $3, 'order', $4)
     ON CONFLICT (subject_type, subject_id, purpose) DO UPDATE SET token_hash = EXCLUDED.token_hash, created_at = now()`,
    [sha256(token), s.clientId, s.brandId, orderId],
  );
  return token;
}

/** Stripe line items for an order: paid lines plus one line per tax, summing to the total. */
function checkoutLineItems(quote: Quote): CheckoutLineItem[] {
  const items: CheckoutLineItem[] = quote.lines
    .filter((l) => l.unitPriceCents > 0)
    .map((l) => ({ name: l.name, unitAmountCents: l.unitPriceCents, quantity: l.quantity }));
  for (const t of quote.taxes) {
    if (t.amountCents > 0) {
      const pct = (t.ratePpm / 10_000).toLocaleString("fr-CA", { maximumFractionDigits: 3 });
      items.push({ name: `${t.labelFr} (${pct} %)`, unitAmountCents: t.amountCents, quantity: 1 });
    }
  }
  return items;
}

function isOriginAllowed(url: string, origins: readonly string[]): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && origins.includes(u.origin);
  } catch {
    return false;
  }
}

export class PaymentsService {
  constructor(private readonly deps: PaymentsDeps) {}

  private gateway(): PaymentGateway {
    if (!this.deps.gateway) throw new DomainError("payments_not_configured");
    return this.deps.gateway;
  }

  private async provider<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof PaymentProviderError) {
        console.error("alkao: payment provider error", error.operation, error.cause);
        throw new DomainError("payment_provider_error");
      }
      throw error;
    }
  }

  // ── Connected account onboarding (owner/admin) ──────────────────────────
  async startOnboarding(scope: TenantScope, actor: Actor): Promise<{ url: string; expiresAt: Date }> {
    const gateway = this.gateway();
    if (!this.deps.onboarding) throw new DomainError("payments_not_configured");
    let account = await payments.getPaymentAccount(this.deps.db, scope.clientId);
    if (!account) {
      const created = await this.provider(() => gateway.createConnectedAccount({ clientId: scope.clientId, email: null }));
      await withTransaction(this.deps.db, async (tx) => {
        await payments.insertPaymentAccount(tx, scope.clientId, created.accountId);
        await writeAudit(tx, scope, actor, "payments.account_created", { type: "payment_account", id: created.accountId });
      });
      account = await payments.getPaymentAccount(this.deps.db, scope.clientId);
    }
    const { refreshUrl, returnUrl } = this.deps.onboarding;
    return this.provider(() => gateway.createOnboardingLink({ accountId: account!.stripeAccountId, refreshUrl, returnUrl }));
  }

  async accountStatus(scope: TenantScope) {
    const account = await payments.getPaymentAccount(this.deps.db, scope.clientId);
    if (!account) return { connected: false as const };
    if (this.deps.gateway) {
      const status = await this.provider(() => this.gateway().retrieveAccount(account.stripeAccountId));
      await payments.updatePaymentAccountStatus(this.deps.db, status);
      return { connected: true as const, ...status };
    }
    return { connected: true as const, accountId: account.stripeAccountId, ...account };
  }

  // ── Checkout (public, behind the Ticketing gate and the hold token) ─────
  async startCheckout(
    scope: TenantScope,
    holdId: string,
    input: { buyer: BuyerInput; successUrl: string; cancelUrl: string },
  ): Promise<CheckoutResult> {
    const now = this.deps.now();
    const prepared = await withTransaction(this.deps.db, (tx) =>
      mapDbErrors(async () => {
        const hold = await payments.lockHoldForCheckout(tx, scope, holdId);
        if (!hold) throw new DomainError("hold_not_found");
        const quote = quoteFromLines(hold.items, hold.taxRegion);

        const existing = await payments.findOrderForHold(tx, scope, holdId);
        if (existing) {
          if (existing.status !== "pending_payment") throw new DomainError("hold_not_active");
          const orderToken = await issueOrderToken(tx, scope, existing.id);
          const p = existing.payment;
          if (!p || p.status !== "open" || p.expiresAt <= now) throw new DomainError("hold_not_active");
          if (p.checkoutUrl) {
            return { kind: "redirect" as const, orderId: existing.id, reference: existing.reference, orderToken, checkoutUrl: p.checkoutUrl };
          }
          // An earlier attempt created the order but not the Stripe session: retry it.
          return { kind: "session" as const, paymentId: p.id, orderId: existing.id, reference: existing.reference, orderToken, quote, expiresAt: p.expiresAt };
        }

        if (hold.status !== "active" || hold.expiresAt <= now) throw new DomainError("hold_not_active");
        const commission = computeCommission(await payments.getCommissionTerms(tx, scope.clientId), quote);

        let account: payments.PaymentAccountRow | null = null;
        if (quote.totalCents > 0) {
          account = await payments.getPaymentAccount(tx, scope.clientId);
          if (!account?.chargesEnabled || !this.deps.gateway) throw new DomainError("payments_unavailable");
          const origins = [...(await payments.getCheckoutReturnOrigins(tx, scope)), ...(this.deps.shopOrigin ? [this.deps.shopOrigin] : [])];
          if (!isOriginAllowed(input.successUrl, origins) || !isOriginAllowed(input.cancelUrl, origins)) {
            throw new DomainError("return_url_not_allowed");
          }
        }

        const order = await createOrderFromHold(tx, { ...scope, holdId, buyer: input.buyer, quote, commissionCents: commission }, now);
        const orderToken = await issueOrderToken(tx, scope, order.id);

        if (quote.totalCents === 0) {
          await recordOrderPaid(tx, scope, order.id, now);
          await writeAudit(tx, scope, { type: "public", id: null }, "order.paid", { type: "order", id: order.id }, { free: true });
          return { kind: "free" as const, orderId: order.id, reference: order.reference, orderToken };
        }

        const expiresAt = new Date(now.getTime() + CHECKOUT_SESSION_SECONDS * 1000);
        await payments.extendHold(tx, holdId, new Date(expiresAt.getTime() + CHECKOUT_HOLD_GRACE_SECONDS * 1000));
        const paymentId = await payments.insertPayment(tx, {
          ...scope,
          eventId: hold.eventId,
          orderId: order.id,
          stripeAccountId: account!.stripeAccountId,
          amountCents: quote.totalCents,
          applicationFeeCents: commission,
          expiresAt,
        });
        return { kind: "session" as const, paymentId, orderId: order.id, reference: order.reference, orderToken, quote, expiresAt };
      }),
    );

    if (prepared.kind !== "session") return prepared;

    const { rows } = await this.deps.db.query<{ email: string; account: string; fee: number }>(
      `SELECT b.email, p.stripe_account_id AS account, p.application_fee_cents AS fee
       FROM public.ticketing_payments p
       JOIN public.ticketing_orders o ON o.id = p.order_id
       JOIN public.ticketing_buyers b ON b.id = o.buyer_id
       WHERE p.id = $1`,
      [prepared.paymentId],
    );
    const meta = rows[0]!;
    const session = await this.provider(() =>
      this.gateway().createCheckoutSession({
        accountId: meta.account,
        lineItems: checkoutLineItems(prepared.quote),
        amountTotalCents: prepared.quote.totalCents,
        applicationFeeCents: meta.fee,
        customerEmail: meta.email,
        expiresAt: prepared.expiresAt,
        successUrl: input.successUrl,
        cancelUrl: input.cancelUrl,
        metadata: {
          alkao_client_id: scope.clientId,
          alkao_brand_id: scope.brandId,
          alkao_order_id: prepared.orderId,
          alkao_payment_id: prepared.paymentId,
        },
        idempotencyKey: `alkao-checkout:${prepared.paymentId}`,
      }),
    );
    await payments.setPaymentSession(this.deps.db, prepared.paymentId, session.id, session.url);
    return { kind: "redirect", orderId: prepared.orderId, reference: prepared.reference, orderToken: prepared.orderToken, checkoutUrl: session.url };
  }

  // ── Provider webhooks (signature-verified, idempotent) ──────────────────
  async handleWebhook(rawBody: string, signature: string | undefined): Promise<{ outcome: "processed" | "ignored" | "duplicate" }> {
    const event = this.gateway().parseWebhook(rawBody, signature);
    const result = await withTransaction(this.deps.db, async (tx) => {
      const fresh = await payments.recordPaymentEvent(tx, {
        eventId: event.eventId,
        type: event.kind === "ignored" ? event.type : event.kind,
        accountId: event.accountId,
        clientId: null,
        outcome: "processed",
      });
      if (!fresh) return { outcome: "duplicate" as const, refund: null };
      const handled = await this.applyWebhookEvent(tx, event);
      await tx.query(`UPDATE public.ticketing_payment_events SET outcome = $2, client_id = $3 WHERE event_id = $1`, [
        event.eventId,
        handled.outcome,
        handled.clientId,
      ]);
      return { outcome: handled.outcome, refund: handled.refund };
    });
    if (result.refund) {
      // Paid after its seats were gone: refund in full, automatically. A provider failure
      // leaves the refund pending (visible to admins, retryable); Stripe gets a 200 anyway.
      await this.executeRefund(result.refund.scope, result.refund.refundId).catch((error) =>
        console.error("alkao: automatic refund failed", result.refund?.refundId, error),
      );
    }
    return { outcome: result.outcome };
  }

  private async applyWebhookEvent(
    tx: Tx,
    event: PaymentWebhookEvent,
  ): Promise<{ outcome: "processed" | "ignored"; clientId: string | null; refund: { scope: TenantScope; refundId: string } | null }> {
    const ignored = (clientId: string | null = null) => ({ outcome: "ignored" as const, clientId, refund: null });
    const now = this.deps.now();

    if (event.kind === "account.updated") {
      const clientId = await payments.updatePaymentAccountStatus(tx, event.status);
      return clientId ? { outcome: "processed", clientId, refund: null } : ignored();
    }
    if (event.kind === "ignored") return ignored();
    if (event.kind === "dispute" || event.kind === "charge.refunded") return this.applyAfterSaleEvent(tx, event);

    const payment = await payments.lockPaymentBySession(tx, event.sessionId);
    if (!payment) return ignored();
    const scope = { clientId: payment.clientId, brandId: payment.brandId };
    const system: Actor = { type: "system", id: event.eventId };

    if (event.accountId !== payment.stripeAccountId) {
      await writeAudit(tx, scope, system, "payment.account_mismatch", { type: "payment", id: payment.id }, { account: event.accountId });
      return ignored(scope.clientId);
    }

    if (event.kind === "checkout.expired") {
      if (payment.status !== "open") return ignored(scope.clientId);
      await tx.query(`UPDATE public.ticketing_payments SET status = 'expired' WHERE id = $1`, [payment.id]);
      await tx.query(`UPDATE public.ticketing_orders SET status = 'expired' WHERE id = $1 AND status = 'pending_payment'`, [payment.orderId]);
      await tx.query(
        `UPDATE public.ticketing_holds SET status = 'expired'
         WHERE status = 'active' AND id = (SELECT hold_id FROM public.ticketing_orders WHERE id = $1)`,
        [payment.orderId],
      );
      await writeAudit(tx, scope, system, "order.expired", { type: "order", id: payment.orderId });
      return { outcome: "processed", clientId: scope.clientId, refund: null };
    }

    // checkout.completed
    if (event.paymentStatus !== "paid" || payment.status === "paid") return ignored(scope.clientId);
    if (payment.status !== "open") {
      await writeAudit(tx, scope, system, "payment.unexpected_completion", { type: "payment", id: payment.id }, { paymentStatus: payment.status });
      return ignored(scope.clientId);
    }
    if (
      !event.paymentIntentId ||
      event.amountTotalCents !== payment.amountCents ||
      event.currency?.toLowerCase() !== "cad"
    ) {
      await writeAudit(tx, scope, system, "payment.amount_mismatch", { type: "payment", id: payment.id }, {
        expected: payment.amountCents,
        received: event.amountTotalCents,
        currency: event.currency,
      });
      return ignored(scope.clientId);
    }

    await payments.markPaymentPaid(tx, payment.id, event.paymentIntentId, now);
    let unfulfillable = "capacity_unavailable";
    await tx.query("SAVEPOINT fulfil");
    try {
      const tickets = await recordOrderPaid(tx, scope, payment.orderId, now);
      await tx.query("RELEASE SAVEPOINT fulfil");
      await writeAudit(tx, scope, system, "order.paid", { type: "order", id: payment.orderId }, { tickets: tickets.length });
      return { outcome: "processed", clientId: scope.clientId, refund: null };
    } catch (error) {
      await tx.query("ROLLBACK TO SAVEPOINT fulfil");
      if (!(error instanceof DomainError && (error.code === "sold_out" || error.code === "session_cancelled"))) throw error;
      unfulfillable = error.code === "sold_out" ? "capacity_unavailable" : "session_cancelled";
    }

    // The hold lapsed and the seats were sold meanwhile, or the organizer cancelled the
    // session: take the money, then give it all back.
    await tx.query(`UPDATE public.ticketing_orders SET status = 'paid', paid_at = $2 WHERE id = $1`, [payment.orderId, now]);
    const refund = await payments.insertRefund(tx, {
      ...scope,
      eventId: payment.eventId,
      orderId: payment.orderId,
      amountCents: payment.amountCents,
      commissionRefundCents: payment.applicationFeeCents,
      voidTicketIds: [],
      reason: unfulfillable,
      requestedBy: "system",
    });
    await writeAudit(tx, scope, system, "order.paid_unfulfillable", { type: "order", id: payment.orderId }, { refundId: refund.id });
    return { outcome: "processed", clientId: scope.clientId, refund: { scope, refundId: refund.id } };
  }

  /**
   * Run 19: what Stripe reports after the sale: a dispute (chargeback), or a refund made in
   * the Client's Stripe dashboard. Recorded, audited and shown to staff; no money moves and
   * no ticket changes here.
   */
  private async applyAfterSaleEvent(
    tx: Tx,
    event: Extract<PaymentWebhookEvent, { kind: "dispute" | "charge.refunded" }>,
  ): Promise<{ outcome: "processed" | "ignored"; clientId: string | null; refund: null }> {
    const ignored = (clientId: string | null = null) => ({ outcome: "ignored" as const, clientId, refund: null });
    const payment = event.paymentIntentId ? await payments.lockPaymentByIntent(tx, event.paymentIntentId) : null;
    if (!payment) return ignored();
    const scope = { clientId: payment.clientId, brandId: payment.brandId };
    const system: Actor = { type: "system", id: event.eventId };
    if (event.accountId !== payment.stripeAccountId) {
      await writeAudit(tx, scope, system, "payment.account_mismatch", { type: "payment", id: payment.id }, { account: event.accountId });
      return ignored(scope.clientId);
    }
    const order = { type: "order", id: payment.orderId };

    if (event.kind === "dispute") {
      const applied = await payments.upsertDispute(tx, payment, {
        stripeDisputeId: event.disputeId,
        amountCents: event.amountCents,
        currency: event.currency,
        reason: event.reason,
        status: event.status,
        evidenceDueBy: event.evidenceDueBy,
        occurredAt: event.occurredAt,
      });
      if (!applied) return ignored(scope.clientId); // an older event, delivered late
      const action = applied.created
        ? "payment.dispute_opened"
        : payments.CLOSED_DISPUTE_STATUSES.includes(event.status) ? "payment.dispute_closed" : "payment.dispute_updated";
      await writeAudit(tx, scope, system, action, order, {
        disputeId: event.disputeId, status: event.status, amountCents: event.amountCents, reason: event.reason,
      });
      return { outcome: "processed", clientId: scope.clientId, refund: null };
    }

    const before = await payments.outsideRefund(tx, scope, payment.orderId);
    await payments.recordChargeRefundTotal(tx, payment, event.refundedCents, event.occurredAt);
    const after = await payments.outsideRefund(tx, scope, payment.orderId);
    if (after.outsideCents > before.outsideCents) await writeAudit(tx, scope, system, "payment.outside_refund", order, after);
    return { outcome: "processed", clientId: scope.clientId, refund: null };
  }

  // ── Refunds (owner/admin/manager) ───────────────────────────────────────
  async requestRefund(
    scope: TenantScope,
    orderId: string,
    input: { amountCents?: number | undefined; ticketIds?: string[] | undefined; reason?: string | null | undefined },
    actor: Actor,
  ): Promise<payments.RefundRow> {
    this.gateway();
    const refund = await withTransaction(this.deps.db, async (tx) => {
      const { rows } = await tx.query<{ status: string; event_id: string; total_cents: number; commission_cents: number; refunded_cents: number; commission_refunded_cents: number }>(
        `SELECT status, event_id, total_cents, commission_cents, refunded_cents, commission_refunded_cents
         FROM public.ticketing_orders WHERE id = $1 AND client_id = $2 AND brand_id = $3 FOR UPDATE`,
        [orderId, scope.clientId, scope.brandId],
      );
      const order = rows[0];
      if (!order) throw new DomainError("order_not_found");
      const payment = await payments.getPaymentForOrder(tx, scope, orderId);
      if (!["paid", "partially_refunded"].includes(order.status) || payment?.status !== "paid") {
        throw new DomainError("order_not_refundable");
      }
      const amount = input.amountCents ?? order.total_cents - order.refunded_cents;
      const outcome = applyRefund(
        {
          totalPaidCents: order.total_cents,
          commissionCents: order.commission_cents,
          refundedCents: order.refunded_cents,
          commissionRefundedCents: order.commission_refunded_cents,
        },
        amount,
      );
      const { rows: valid } = await tx.query<{ id: string }>(
        // Tickets moved by a Flex exchange still belong to the paid order for refunds.
        `SELECT id FROM public.ticketing_tickets
         WHERE (order_id = $1 OR order_id IN (SELECT id FROM public.ticketing_orders WHERE exchange_of_order_id = $1))
           AND client_id = $2 AND brand_id = $3 AND status = 'valid'`,
        [orderId, scope.clientId, scope.brandId],
      );
      const validIds = new Set(valid.map((t) => t.id));
      const requested = [...new Set(input.ticketIds ?? [])];
      if (requested.some((id) => !validIds.has(id))) throw new DomainError("invalid_ticket");
      const voidTicketIds = outcome.fullyRefunded ? [...validIds] : requested;

      const created = await payments.insertRefund(tx, {
        ...scope,
        eventId: order.event_id,
        orderId,
        amountCents: amount,
        commissionRefundCents: outcome.commissionRefundCents,
        voidTicketIds,
        reason: input.reason ?? null,
        requestedBy: actor.id ?? actor.type,
      });
      await writeAudit(tx, scope, actor, "refund.requested", { type: "refund", id: created.id }, {
        orderId,
        amountCents: amount,
        commissionRefundCents: outcome.commissionRefundCents,
        tickets: voidTicketIds.length,
      });
      return created;
    });
    return this.executeRefund(scope, refund.id);
  }

  async retryRefund(scope: TenantScope, refundId: string): Promise<payments.RefundRow> {
    this.gateway();
    const refund = await payments.getRefund(this.deps.db, scope, refundId);
    if (!refund) throw new DomainError("refund_not_found");
    return this.executeRefund(scope, refundId);
  }

  /**
   * Phase 2 and 3 of a refund. Provider calls use idempotency keys derived from the refund
   * id, so running this again after a failure never refunds twice.
   */
  private async executeRefund(scope: TenantScope, refundId: string): Promise<payments.RefundRow> {
    const gateway = this.gateway();
    const refund = await payments.getRefund(this.deps.db, scope, refundId);
    if (!refund) throw new DomainError("refund_not_found");
    if (refund.status !== "pending") return refund;
    const payment = await payments.getPaymentForOrder(this.deps.db, scope, refund.orderId);
    if (!payment?.paymentIntentId) throw new DomainError("order_not_refundable");
    const ref = { accountId: payment.stripeAccountId, paymentIntentId: payment.paymentIntentId };

    try {
      if (!refund.stripeRefundId) {
        const r = await gateway.refundPayment({
          ...ref,
          amountCents: refund.amountCents,
          idempotencyKey: `alkao-refund:${refund.id}`,
          metadata: { alkao_refund_id: refund.id, alkao_order_id: refund.orderId },
        });
        await payments.recordRefundProgress(this.deps.db, refund.id, { stripeRefundId: r.refundId });
      }
      if (refund.commissionRefundCents > 0 && !refund.stripeFeeRefundId) {
        const f = await gateway.refundApplicationFee({
          ...ref,
          amountCents: refund.commissionRefundCents,
          idempotencyKey: `alkao-fee-refund:${refund.id}`,
        });
        await payments.recordRefundProgress(this.deps.db, refund.id, { stripeFeeRefundId: f.feeRefundId });
      }
    } catch (error) {
      const message = error instanceof PaymentProviderError ? error.operation : "unexpected";
      await payments.recordRefundProgress(this.deps.db, refund.id, { lastError: message });
      console.error("alkao: refund provider error", refund.id, error);
      throw new DomainError("refund_provider_error", { refundId: refund.id });
    }

    return withTransaction(this.deps.db, async (tx) => {
      const current = await payments.getRefund(tx, scope, refundId, true);
      if (!current || current.status !== "pending") return current!;
      const { rows } = await tx.query<{ total_cents: number; commission_cents: number; refunded_cents: number; commission_refunded_cents: number }>(
        `SELECT total_cents, commission_cents, refunded_cents, commission_refunded_cents
         FROM public.ticketing_orders WHERE id = $1 FOR UPDATE`,
        [current.orderId],
      );
      const o = rows[0]!;
      const outcome = applyRefund(
        { totalPaidCents: o.total_cents, commissionCents: o.commission_cents, refundedCents: o.refunded_cents, commissionRefundedCents: o.commission_refunded_cents },
        current.amountCents,
      );
      if (outcome.commissionRefundCents !== current.commissionRefundCents) throw new DomainError("refund_state_changed");
      await tx.query(
        `UPDATE public.ticketing_orders SET refunded_cents = $2, commission_refunded_cents = $3, status = $4 WHERE id = $1`,
        [current.orderId, outcome.refundedAfterCents, outcome.commissionRefundedAfterCents, orderStatusAfterRefund(o.total_cents, outcome.refundedAfterCents)],
      );
      await tx.query(`UPDATE public.ticketing_refunds SET status = 'succeeded', last_error = NULL WHERE id = $1`, [current.id]);
      if (current.voidTicketIds.length > 0) {
        await tx.query(
          `UPDATE public.ticketing_tickets SET status = 'void', void_reason = 'refunded', voided_at = now()
           WHERE id = ANY($1::uuid[]) AND status = 'valid'
             AND (order_id = $2 OR order_id IN (SELECT id FROM public.ticketing_orders WHERE exchange_of_order_id = $2))`,
          [current.voidTicketIds, current.orderId],
        );
      }
      await writeAudit(tx, scope, { type: "system", id: null }, "refund.succeeded", { type: "refund", id: current.id }, {
        orderId: current.orderId,
        amountCents: current.amountCents,
        commissionRefundCents: current.commissionRefundCents,
      });
      return (await payments.getRefund(tx, scope, refundId))!;
    });
  }
}
