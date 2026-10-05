import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { PaymentProviderError, WebhookSignatureError } from "../../src/payments/gateway.js";
import { StripeGateway } from "../../src/payments/stripe-gateway.js";
import { completedSession, dispute, refundedCharge, signedStripeEvent, WEBHOOK_SECRET } from "../helpers/fake-gateway.js";

/** Records every Stripe SDK call made by StripeGateway, with its request options. */
function stubStripe(overrides: Record<string, unknown> = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const rec = (method: string, result: unknown) => async (...args: unknown[]) => {
    calls.push({ method, args });
    if (result instanceof Error) throw result;
    return result;
  };
  const stub = {
    accounts: {
      create: rec("accounts.create", { id: "acct_123" }),
      retrieve: rec("accounts.retrieve", { id: "acct_123", charges_enabled: true, payouts_enabled: false, details_submitted: true }),
    },
    accountLinks: { create: rec("accountLinks.create", { url: "https://connect.stripe.com/setup/x", expires_at: 1_900_000_000 }) },
    checkout: {
      sessions: { create: rec("checkout.sessions.create", { id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1", expires_at: 1_900_000_000 }) },
    },
    refunds: { create: rec("refunds.create", { id: "re_1" }) },
    paymentIntents: { retrieve: rec("paymentIntents.retrieve", { id: "pi_1", latest_charge: { id: "ch_1", application_fee: "fee_1" } }) },
    applicationFees: { createRefund: rec("applicationFees.createRefund", { id: "fr_1" }) },
    webhooks: new Stripe("sk_test_x").webhooks,
    ...overrides,
  };
  return { gateway: new StripeGateway(stub as unknown as Stripe, WEBHOOK_SECRET), calls };
}

const checkoutInput = {
  accountId: "acct_123",
  lineItems: [
    { name: "Admission générale", unitAmountCents: 2995, quantity: 2 },
    { name: "TPS (5 %)", unitAmountCents: 300, quantity: 1 },
  ],
  amountTotalCents: 6290,
  applicationFeeCents: 399,
  customerEmail: "buyer@example.com",
  expiresAt: new Date("2026-12-01T18:31:00Z"),
  successUrl: "https://festi-ice.ca/merci",
  cancelUrl: "https://festi-ice.ca/billets",
  metadata: { alkao_order_id: "o1" },
  idempotencyKey: "alkao-checkout:p1",
};

describe("StripeGateway request shaping", () => {
  it("creates a direct charge on the Client's account with TAKATAK's application fee", async () => {
    const { gateway, calls } = stubStripe();
    const session = await gateway.createCheckoutSession(checkoutInput);
    expect(session).toEqual({ id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1", expiresAt: new Date(1_900_000_000_000) });
    const [params, options] = calls[0]!.args as [Record<string, any>, Record<string, unknown>];
    expect(options).toEqual({ stripeContext: "acct_123", idempotencyKey: "alkao-checkout:p1" });
    expect(params).toMatchObject({
      mode: "payment",
      allowed_payment_method_types: ["card"],
      customer_email: "buyer@example.com",
      expires_at: Math.floor(checkoutInput.expiresAt.getTime() / 1000),
      payment_intent_data: { application_fee_amount: 399, metadata: { alkao_order_id: "o1" } },
    });
    expect(params.line_items).toEqual([
      { quantity: 2, price_data: { currency: "cad", unit_amount: 2995, product_data: { name: "Admission générale" } } },
      { quantity: 1, price_data: { currency: "cad", unit_amount: 300, product_data: { name: "TPS (5 %)" } } },
    ]);
  });

  it("omits a zero application fee and refuses line items that do not add up", async () => {
    const { gateway, calls } = stubStripe();
    await gateway.createCheckoutSession({ ...checkoutInput, applicationFeeCents: 0 });
    expect((calls[0]!.args[0] as any).payment_intent_data).not.toHaveProperty("application_fee_amount");
    await expect(gateway.createCheckoutSession({ ...checkoutInput, amountTotalCents: 6291 })).rejects.toBeInstanceOf(PaymentProviderError);
  });

  it("refunds the buyer on the connected account and the fee on the platform", async () => {
    const { gateway, calls } = stubStripe();
    await gateway.refundPayment({ accountId: "acct_123", paymentIntentId: "pi_1", amountCents: 1000, idempotencyKey: "alkao-refund:r1", metadata: {} });
    await gateway.refundApplicationFee({ accountId: "acct_123", paymentIntentId: "pi_1", amountCents: 64, idempotencyKey: "alkao-fee-refund:r1" });
    expect(calls.map((c) => c.method)).toEqual(["refunds.create", "paymentIntents.retrieve", "applicationFees.createRefund"]);
    expect(calls[0]!.args).toEqual([{ payment_intent: "pi_1", amount: 1000, metadata: {} }, { stripeContext: "acct_123", idempotencyKey: "alkao-refund:r1" }]);
    expect(calls[1]!.args).toEqual(["pi_1", { expand: ["latest_charge"] }, { stripeContext: "acct_123" }]);
    expect(calls[2]!.args).toEqual(["fee_1", { amount: 64 }, { idempotencyKey: "alkao-fee-refund:r1" }]);
  });

  it("creates Standard accounts in Canada, idempotently per Client", async () => {
    const { gateway, calls } = stubStripe();
    await gateway.createConnectedAccount({ clientId: "c1", email: null });
    expect(calls[0]!.args).toEqual([{ type: "standard", country: "CA", metadata: { alkao_client_id: "c1" } }, { idempotencyKey: "alkao-account:c1" }]);
  });

  it("wraps SDK failures", async () => {
    const { gateway } = stubStripe({ refunds: { create: async () => { throw new Error("boom"); } } });
    await expect(
      gateway.refundPayment({ accountId: "acct_123", paymentIntentId: "pi_1", amountCents: 1, idempotencyKey: "k", metadata: {} }),
    ).rejects.toMatchObject({ operation: "refund_payment" });
  });
});

describe("StripeGateway webhook verification (real Stripe signatures)", () => {
  const { gateway } = stubStripe();

  it("accepts a correctly signed event and maps it", () => {
    const e = signedStripeEvent("checkout.session.completed", completedSession("cs_test_9", 6290, "pi_test_9"), "acct_123");
    expect(gateway.parseWebhook(e.body, e.signature)).toMatchObject({
      kind: "checkout.completed",
      accountId: "acct_123",
      sessionId: "cs_test_9",
      paymentIntentId: "pi_test_9",
      paymentStatus: "paid",
      amountTotalCents: 6290,
      currency: "cad",
    });
  });

  it("maps disputes and refunded charges, with the event time (Run 19)", () => {
    const at = new Date("2026-10-05T12:00:00Z");
    const d = signedStripeEvent("charge.dispute.closed", dispute("dp_test_1", "pi_test_9", 6290, "won", { evidence_details: { due_by: null } }), "acct_123", WEBHOOK_SECRET, at);
    expect(gateway.parseWebhook(d.body, d.signature)).toEqual({
      kind: "dispute", eventId: expect.stringMatching(/^evt_/), accountId: "acct_123", occurredAt: at,
      disputeId: "dp_test_1", paymentIntentId: "pi_test_9", amountCents: 6290, currency: "cad", reason: "fraudulent", status: "won", evidenceDueBy: null,
    });
    const r = signedStripeEvent("charge.refunded", refundedCharge("pi_test_9", 6290, 1000), "acct_123", WEBHOOK_SECRET, at);
    expect(gateway.parseWebhook(r.body, r.signature)).toMatchObject({ kind: "charge.refunded", paymentIntentId: "pi_test_9", refundedCents: 1000, occurredAt: at });
  });

  it("rejects missing, wrong-secret and tampered signatures", () => {
    const e = signedStripeEvent("checkout.session.completed", completedSession("cs_test_9", 6290), "acct_123");
    expect(() => gateway.parseWebhook(e.body, undefined)).toThrow(WebhookSignatureError);
    const forged = signedStripeEvent("checkout.session.completed", completedSession("cs_test_9", 6290), "acct_123", "whsec_attacker");
    expect(() => gateway.parseWebhook(forged.body, forged.signature)).toThrow(WebhookSignatureError);
    expect(() => gateway.parseWebhook(e.body.replace("6290", "1"), e.signature)).toThrow(WebhookSignatureError);
  });

  it("maps expiry, async outcomes, account updates and ignores the rest", () => {
    const parse = (type: string, obj: Record<string, unknown>) => {
      const e = signedStripeEvent(type, obj, "acct_123");
      return gateway.parseWebhook(e.body, e.signature);
    };
    expect(parse("checkout.session.expired", { id: "cs_1", object: "checkout.session" }).kind).toBe("checkout.expired");
    expect(parse("checkout.session.async_payment_failed", { id: "cs_1", object: "checkout.session" }).kind).toBe("checkout.expired");
    expect(parse("checkout.session.async_payment_succeeded", completedSession("cs_1", 10)).kind).toBe("checkout.completed");
    expect(parse("account.updated", { id: "acct_123", object: "account", charges_enabled: true, payouts_enabled: true, details_submitted: true })).toMatchObject({
      kind: "account.updated",
      status: { accountId: "acct_123", chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true },
    });
    expect(parse("payment_intent.created", { id: "pi_1", object: "payment_intent" })).toMatchObject({ kind: "ignored", type: "payment_intent.created" });
  });
});
