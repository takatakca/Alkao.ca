import { randomBytes } from "node:crypto";
import Stripe from "stripe";
import {
  PaymentProviderError,
  type CheckoutSession,
  type ConnectedAccountStatus,
  type CreateCheckoutInput,
  type PaymentGateway,
} from "../../src/payments/gateway.js";
import { StripeGateway } from "../../src/payments/stripe-gateway.js";

export const WEBHOOK_SECRET = "whsec_test_alkao_0123456789abcdef";
const stripe = new Stripe("sk_test_alkao_fake_key");

const id = (prefix: string) => `${prefix}_test${randomBytes(9).toString("hex")}`;

type Op = "createConnectedAccount" | "createOnboardingLink" | "retrieveAccount" | "createCheckoutSession" | "refundPayment" | "refundApplicationFee";

/**
 * In-memory Stripe stand-in. Provider calls are recorded and idempotent by key; failures
 * can be injected per operation. Webhook parsing is the real StripeGateway code, so tests
 * exercise genuine Stripe signatures and event mapping.
 */
export class FakeGateway implements PaymentGateway {
  readonly calls: { op: Op; input: unknown }[] = [];
  readonly accounts = new Map<string, ConnectedAccountStatus>();
  private readonly byKey = new Map<string, unknown>();
  private readonly failures = new Map<Op, number>();
  private readonly parser = new StripeGateway(stripe, WEBHOOK_SECRET);

  failNext(op: Op, times = 1) {
    this.failures.set(op, times);
  }

  callsOf(op: Op) {
    return this.calls.filter((c) => c.op === op).map((c) => c.input);
  }

  private record(op: Op, input: unknown) {
    this.calls.push({ op, input });
    const left = this.failures.get(op) ?? 0;
    if (left > 0) {
      this.failures.set(op, left - 1);
      throw new PaymentProviderError(op, new Error("injected failure"));
    }
  }

  private once<T>(key: string, make: () => T): T {
    if (!this.byKey.has(key)) this.byKey.set(key, make());
    return this.byKey.get(key) as T;
  }

  async createConnectedAccount(input: { clientId: string; email: string | null }) {
    this.record("createConnectedAccount", input);
    return this.once(`account:${input.clientId}`, () => {
      const accountId = id("acct");
      this.accounts.set(accountId, { accountId, chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false });
      return { accountId };
    });
  }

  async createOnboardingLink(input: { accountId: string; refreshUrl: string; returnUrl: string }) {
    this.record("createOnboardingLink", input);
    return { url: `https://connect.stripe.com/setup/s/${id("link")}`, expiresAt: new Date(Date.now() + 300_000) };
  }

  async retrieveAccount(accountId: string) {
    this.record("retrieveAccount", accountId);
    return this.accounts.get(accountId) ?? { accountId, chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false };
  }

  async createCheckoutSession(input: CreateCheckoutInput): Promise<CheckoutSession> {
    this.record("createCheckoutSession", input);
    return this.once(input.idempotencyKey, () => {
      const sessionId = id("cs");
      return { id: sessionId, url: `https://checkout.stripe.com/c/pay/${sessionId}`, expiresAt: input.expiresAt };
    });
  }

  async refundPayment(input: { accountId: string; paymentIntentId: string; amountCents: number; idempotencyKey: string; metadata: Record<string, string> }) {
    this.record("refundPayment", input);
    return this.once(input.idempotencyKey, () => ({ refundId: id("re") }));
  }

  async refundApplicationFee(input: { accountId: string; paymentIntentId: string; amountCents: number; idempotencyKey: string }) {
    this.record("refundApplicationFee", input);
    return this.once(input.idempotencyKey, () => ({ feeRefundId: id("fr") }));
  }

  parseWebhook(rawBody: string, signature: string | undefined) {
    return this.parser.parseWebhook(rawBody, signature);
  }
}

/** A Stripe event payload and its valid signature header. */
export function signedStripeEvent(
  type: string,
  object: Record<string, unknown>,
  account: string | null,
  secret = WEBHOOK_SECRET,
  created = new Date(),
) {
  const body = JSON.stringify({
    id: id("evt"),
    object: "event",
    api_version: "2026-09-30",
    created: Math.floor(created.getTime() / 1000),
    type,
    account,
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    data: { object },
  });
  return { body, signature: stripe.webhooks.generateTestHeaderString({ payload: body, secret }) };
}

export function completedSession(sessionId: string, amountTotal: number, paymentIntentId = id("pi"), extra: Record<string, unknown> = {}) {
  return {
    id: sessionId,
    object: "checkout.session",
    payment_status: "paid",
    status: "complete",
    amount_total: amountTotal,
    currency: "cad",
    payment_intent: paymentIntentId,
    ...extra,
  };
}

/** A Stripe dispute (chargeback) on a payment. */
export function dispute(disputeId: string, paymentIntentId: string, amount: number, status = "needs_response", extra: Record<string, unknown> = {}) {
  return {
    id: disputeId,
    object: "dispute",
    amount,
    currency: "cad",
    reason: "fraudulent",
    status,
    payment_intent: paymentIntentId,
    charge: id("ch"),
    evidence_details: { due_by: Math.floor(Date.now() / 1000) + 7 * 86400, has_evidence: false, past_due: false, submission_count: 0 },
    ...extra,
  };
}

/** A charge as Stripe sends it in charge.refunded: amount_refunded is the running total. */
export function refundedCharge(paymentIntentId: string, amount: number, amountRefunded: number) {
  return { id: id("ch"), object: "charge", amount, amount_refunded: amountRefunded, currency: "cad", payment_intent: paymentIntentId, refunded: amountRefunded >= amount };
}
