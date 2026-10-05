import Stripe from "stripe";
import {
  PaymentProviderError,
  WebhookSignatureError,
  type CheckoutSession,
  type ConnectedAccountStatus,
  type CreateCheckoutInput,
  type PaymentGateway,
  type PaymentWebhookEvent,
} from "./gateway.js";

const accountStatus = (a: Stripe.Account): ConnectedAccountStatus => ({
  accountId: a.id,
  chargesEnabled: Boolean(a.charges_enabled),
  payoutsEnabled: Boolean(a.payouts_enabled),
  detailsSubmitted: Boolean(a.details_submitted),
});

const idOf = (v: string | { id: string } | null | undefined): string | null =>
  v == null ? null : typeof v === "string" ? v : v.id;

async function call<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw new PaymentProviderError(operation, error);
  }
}

/** Stripe Connect (Standard accounts, Canada) with direct charges and application fees. */
export class StripeGateway implements PaymentGateway {
  constructor(
    private readonly stripe: Stripe,
    private readonly webhookSecret: string,
  ) {}

  static fromSecretKey(secretKey: string, webhookSecret: string): StripeGateway {
    return new StripeGateway(new Stripe(secretKey, { appInfo: { name: "ALKAO" } }), webhookSecret);
  }

  createConnectedAccount(input: { clientId: string; email: string | null }) {
    return call("create_account", async () => {
      const account = await this.stripe.accounts.create(
        {
          type: "standard",
          country: "CA",
          ...(input.email ? { email: input.email } : {}),
          metadata: { alkao_client_id: input.clientId },
        },
        { idempotencyKey: `alkao-account:${input.clientId}` },
      );
      return { accountId: account.id };
    });
  }

  createOnboardingLink(input: { accountId: string; refreshUrl: string; returnUrl: string }) {
    return call("create_account_link", async () => {
      const link = await this.stripe.accountLinks.create({
        account: input.accountId,
        refresh_url: input.refreshUrl,
        return_url: input.returnUrl,
        type: "account_onboarding",
      });
      return { url: link.url, expiresAt: new Date(link.expires_at * 1000) };
    });
  }

  retrieveAccount(accountId: string) {
    return call("retrieve_account", async () => accountStatus(await this.stripe.accounts.retrieve(accountId)));
  }

  async createCheckoutSession(input: CreateCheckoutInput): Promise<CheckoutSession> {
    const sum = input.lineItems.reduce((n, l) => n + l.unitAmountCents * l.quantity, 0);
    if (sum !== input.amountTotalCents) throw new PaymentProviderError("create_checkout", new Error("line items do not add up to the order total"));
    return call("create_checkout", async () => {
      const session = await this.stripe.checkout.sessions.create(
        {
          mode: "payment",
          // Cards only: payment is confirmed synchronously, so completion = paid.
          allowed_payment_method_types: ["card"],
          customer_email: input.customerEmail,
          expires_at: Math.floor(input.expiresAt.getTime() / 1000),
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
          metadata: input.metadata,
          line_items: input.lineItems.map((l) => ({
            quantity: l.quantity,
            price_data: { currency: "cad", unit_amount: l.unitAmountCents, product_data: { name: l.name } },
          })),
          payment_intent_data: {
            metadata: input.metadata,
            ...(input.applicationFeeCents > 0 ? { application_fee_amount: input.applicationFeeCents } : {}),
          },
        },
        { stripeContext: input.accountId, idempotencyKey: input.idempotencyKey },
      );
      if (!session.url) throw new Error("checkout session has no url");
      return { id: session.id, url: session.url, expiresAt: new Date(session.expires_at * 1000) };
    });
  }

  refundPayment(input: { accountId: string; paymentIntentId: string; amountCents: number; idempotencyKey: string; metadata: Record<string, string> }) {
    return call("refund_payment", async () => {
      const refund = await this.stripe.refunds.create(
        { payment_intent: input.paymentIntentId, amount: input.amountCents, metadata: input.metadata },
        { stripeContext: input.accountId, idempotencyKey: input.idempotencyKey },
      );
      return { refundId: refund.id };
    });
  }

  refundApplicationFee(input: { accountId: string; paymentIntentId: string; amountCents: number; idempotencyKey: string }) {
    return call("refund_application_fee", async () => {
      const intent = await this.stripe.paymentIntents.retrieve(
        input.paymentIntentId,
        { expand: ["latest_charge"] },
        { stripeContext: input.accountId },
      );
      const charge = intent.latest_charge;
      const feeId = charge && typeof charge !== "string" ? idOf(charge.application_fee) : null;
      if (!feeId) throw new Error("charge has no application fee");
      // Application fees live on the platform account: no connected-account context here.
      const feeRefund = await this.stripe.applicationFees.createRefund(feeId, { amount: input.amountCents }, { idempotencyKey: input.idempotencyKey });
      return { feeRefundId: feeRefund.id };
    });
  }

  parseWebhook(rawBody: string, signature: string | undefined): PaymentWebhookEvent {
    if (!signature) throw new WebhookSignatureError();
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
    } catch {
      throw new WebhookSignatureError();
    }
    const accountId = event.account ?? null;
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const s = event.data.object;
        return {
          kind: "checkout.completed",
          eventId: event.id,
          accountId,
          sessionId: s.id,
          paymentIntentId: idOf(s.payment_intent),
          paymentStatus: s.payment_status,
          amountTotalCents: s.amount_total,
          currency: s.currency,
        };
      }
      case "checkout.session.expired":
      case "checkout.session.async_payment_failed":
        return { kind: "checkout.expired", eventId: event.id, accountId, sessionId: event.data.object.id };
      case "account.updated":
        return { kind: "account.updated", eventId: event.id, accountId: event.data.object.id, status: accountStatus(event.data.object) };
      default:
        return { kind: "ignored", eventId: event.id, accountId, type: event.type };
    }
  }
}
