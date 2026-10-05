/**
 * Payment provider boundary. ALKAO's payment logic talks to this interface only; the
 * Stripe implementation lives in stripe-gateway.ts and tests use an in-memory fake.
 *
 * Model (frozen): Stripe Connect direct charges. Each Client has its own connected
 * account; the buyer pays that account; TAKATAK's commission is the application fee.
 */

export interface ConnectedAccountStatus {
  accountId: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
}

export interface CheckoutLineItem {
  name: string;
  unitAmountCents: number;
  quantity: number;
}

export interface CreateCheckoutInput {
  accountId: string;
  lineItems: CheckoutLineItem[];
  /** Must equal the order total. */
  amountTotalCents: number;
  applicationFeeCents: number;
  customerEmail: string;
  expiresAt: Date;
  successUrl: string;
  cancelUrl: string;
  metadata: Record<string, string>;
  idempotencyKey: string;
}

export interface CheckoutSession {
  id: string;
  url: string;
  expiresAt: Date;
}

export type PaymentWebhookEvent =
  | {
      kind: "checkout.completed";
      eventId: string;
      accountId: string | null;
      sessionId: string;
      paymentIntentId: string | null;
      paymentStatus: string;
      amountTotalCents: number | null;
      currency: string | null;
    }
  | { kind: "checkout.expired"; eventId: string; accountId: string | null; sessionId: string }
  | { kind: "account.updated"; eventId: string; accountId: string | null; status: ConnectedAccountStatus }
  | { kind: "ignored"; eventId: string; accountId: string | null; type: string };

export class WebhookSignatureError extends Error {
  constructor() {
    super("invalid_webhook_signature");
  }
}

export class PaymentProviderError extends Error {
  constructor(
    readonly operation: string,
    cause: unknown,
  ) {
    super(`payment provider error during ${operation}`, { cause });
  }
}

export interface PaymentGateway {
  createConnectedAccount(input: { clientId: string; email: string | null }): Promise<{ accountId: string }>;
  createOnboardingLink(input: { accountId: string; refreshUrl: string; returnUrl: string }): Promise<{ url: string; expiresAt: Date }>;
  retrieveAccount(accountId: string): Promise<ConnectedAccountStatus>;
  createCheckoutSession(input: CreateCheckoutInput): Promise<CheckoutSession>;
  /** Refund the buyer on the Client's account. */
  refundPayment(input: { accountId: string; paymentIntentId: string; amountCents: number; idempotencyKey: string; metadata: Record<string, string> }): Promise<{ refundId: string }>;
  /** Return part or all of TAKATAK's application fee to the Client. */
  refundApplicationFee(input: { accountId: string; paymentIntentId: string; amountCents: number; idempotencyKey: string }): Promise<{ feeRefundId: string }>;
  /** Verify the signature and normalize the event. Throws WebhookSignatureError. */
  parseWebhook(rawBody: string, signature: string | undefined): PaymentWebhookEvent;
}
