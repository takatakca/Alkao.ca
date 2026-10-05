import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EmailSendError, ResendEmailSender, type EmailMessage, type EmailSender } from "../../src/delivery/email.js";
import { emailLinkToken } from "../../src/delivery/links.js";
import { refundEmail, ticketsEmail } from "../../src/delivery/templates.js";
import { deliverTicketEmails } from "../../src/delivery/worker.js";
import { adm, call, pub, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { completedSession, FakeGateway, signedStripeEvent } from "../helpers/fake-gateway.js";
import { seedTwoTenants, TEST_CREDENTIAL_SECRET, type SeedResult, type TenantFixture } from "../helpers/seed.js";

const PUBLIC_URL = "https://billets.alkao.test";

class FakeSender implements EmailSender {
  sent: EmailMessage[] = [];
  failWith: EmailSendError | null = null;
  delayMs = 0;
  async send(m: EmailMessage) {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failWith) throw this.failWith;
    this.sent.push(m);
    return `msg_${this.sent.length}`;
  }
}

let db: TestDatabase;
let seed: SeedResult;
let app: TestApp;
let sender: FakeSender;
const deliver = (now = new Date()) =>
  deliverTicketEmails(db.pool, { sender, publicUrl: PUBLIC_URL, credentialMasterSecret: TEST_CREDENTIAL_SECRET }, now);

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  // The seeded orders queued their own emails; keep the tests about the orders they create.
  await db.pool.query(`UPDATE public.ticketing_email_outbox SET status = 'skipped', last_error = 'seed'`);
});

beforeEach(() => {
  sender = new FakeSender();
  app = testApp(db.pool, { paymentGateway: new FakeGateway(), credentialMasterSecret: TEST_CREDENTIAL_SECRET });
});

afterAll(async () => {
  await db?.drop();
});

const typeId = (t: TenantFixture, code: string) => t.types.find((x) => x.code === code)!.id;

async function session(t: TenantFixture) {
  const { rows } = await db.pool.query<{ id: string }>(
    `INSERT INTO public.ticketing_sessions (client_id, brand_id, event_id, starts_at, capacity, status)
     VALUES ($1, $2, $3, now() + interval '10 days' + (random() * interval '1 hour'), 50, 'on_sale') RETURNING id`,
    [t.clientId, t.brandId, t.eventId],
  );
  return rows[0]!.id;
}

async function buy(t: TenantFixture, items: Record<string, number>, buyer: { email: string; fullName?: string; language?: "fr" | "en" } = { email: "acheteur@example.com", fullName: "Marie Tremblay" }) {
  const sessionId = await session(t);
  const h = await call(app, "POST", `${pub(t.clientId, t.brandId)}/holds`, {
    body: { sessionId, items: Object.entries(items).map(([code, quantity]) => ({ ticketTypeId: typeId(t, code), quantity })) },
  });
  expect(h.status).toBe(201);
  const co = await call(app, "POST", `${pub(t.clientId, t.brandId)}/holds/${h.body.hold.id}/checkout`, {
    headers: { "x-alkao-hold-token": h.body.hold.token },
    body: { buyer, successUrl: `${t.returnOrigin}/ok`, cancelUrl: `${t.returnOrigin}/ko` },
  });
  expect(co.status).toBe(201);
  if (co.body.checkoutUrl) {
    const e = signedStripeEvent("checkout.session.completed", completedSession(co.body.checkoutUrl.split("/").pop(), h.body.hold.quote.totalCents, `pi_${randomUUID().slice(0, 8)}`), t.stripeAccountId);
    expect((await call(app, "POST", "/v1/webhooks/stripe", { body: e.body, headers: { "stripe-signature": e.signature } })).body.outcome).toBe("processed");
  }
  return { sessionId, orderId: co.body.order.id as string, token: co.body.order.token as string };
}

const outbox = async (orderId: string) =>
  (await db.pool.query(`SELECT id, kind, status, attempts, last_error FROM public.ticketing_email_outbox WHERE order_id = $1 ORDER BY created_at`, [orderId])).rows;

function linkOf(m: EmailMessage) {
  const url = new URL(/https:\/\/\S+\/billets#\S+/.exec(m.text)![0]);
  const p = new URLSearchParams(url.hash.slice(1));
  return { url, c: p.get("c")!, b: p.get("b")!, o: p.get("o")!, k: p.get("k")! };
}

describe("tickets email", () => {
  it("is queued once when an order is paid, and sent with a personal link that opens the order", async () => {
    const f = seed.festi;
    const o = await buy(f, { GENERAL: 2 });
    expect(await outbox(o.orderId)).toMatchObject([{ kind: "order_tickets", status: "pending", attempts: 0 }]);

    expect(await deliver()).toEqual({ sent: 1, skipped: 0, retried: 0, failed: 0 });
    expect(sender.sent).toHaveLength(1);
    const m = sender.sent[0]!;
    expect(m.to).toBe("acheteur@example.com");
    expect(m.fromName).toBe("FESTI-ICE");
    expect(m.subject).toMatch(/^Vos billets — .+ \(.+\)$/);
    expect(m.text).toContain("Bonjour Marie Tremblay,");
    expect(m.text).toContain("2 billets");

    const l = linkOf(m);
    expect(l.url.origin + l.url.pathname).toBe(`${PUBLIC_URL}/billets`);
    expect({ c: l.c, b: l.b, o: l.o }).toEqual({ c: f.clientId, b: f.brandId, o: o.orderId });
    expect(l.url.search).toBe(""); // the token is only in the fragment

    const viaEmail = await call(app, "GET", `${pub(f.clientId, f.brandId)}/orders/${o.orderId}`, { headers: { "x-alkao-order-token": l.k } });
    expect(viaEmail.status).toBe(200);
    expect(viaEmail.body.order).toMatchObject({ brand: { name: "FESTI-ICE" }, event: { id: f.eventId }, canChangeSession: false, exchanged: false });
    expect(viaEmail.body.order.tickets.filter((t: { credential: string | null }) => t.credential?.startsWith("ALK1."))).toHaveLength(2);
    // The checkout token still works: the two links never invalidate each other.
    const viaCheckout = await call(app, "GET", `${pub(f.clientId, f.brandId)}/orders/${o.orderId}`, { headers: { "x-alkao-order-token": o.token } });
    expect(viaCheckout.status).toBe(200);
    // Never readable from another Client's URL.
    const crossTenant = await call(app, "GET", `${pub(seed.havana.clientId, seed.havana.brandId)}/orders/${o.orderId}`, { headers: { "x-alkao-order-token": l.k } });
    expect(crossTenant.status).toBe(404);

    expect(await outbox(o.orderId)).toMatchObject([{ status: "sent", attempts: 1 }]);
    expect(await deliver()).toEqual({ sent: 0, skipped: 0, retried: 0, failed: 0 });
  });

  it("free orders get their tickets email too", async () => {
    const o = await buy(seed.havana, { TODDLER: 1 });
    expect(await outbox(o.orderId)).toMatchObject([{ kind: "order_tickets", status: "pending" }]);
    await deliver();
    expect(sender.sent.map((m) => m.text.includes("1 billet"))).toEqual([true]);
  });

  it("retries a temporary failure with backoff, gives up on a permanent one", async () => {
    const a = await buy(seed.festi, { GENERAL: 1 });
    sender.failWith = new EmailSendError("resend 503", true);
    expect(await deliver()).toMatchObject({ retried: 1 });
    const [row] = await outbox(a.orderId);
    expect(row).toMatchObject({ status: "pending", attempts: 1, last_error: "resend 503" });
    expect(await deliver()).toMatchObject({ retried: 0 }); // not due yet

    sender.failWith = null;
    expect(await deliver(new Date(Date.now() + 3 * 60_000))).toMatchObject({ sent: 1 });
    // The retry carries the same link and the same idempotency key as the failed attempt.
    expect(sender.sent[0]!.idempotencyKey).toBe(`alkao-email-${row.id}-1`);

    const b = await buy(seed.festi, { GENERAL: 1 }, { email: "nobody@invalid.example" });
    sender.failWith = new EmailSendError("resend 422: validation_error", false);
    expect(await deliver()).toMatchObject({ failed: 1 });
    expect(await outbox(b.orderId)).toMatchObject([{ status: "failed", attempts: 1 }]);
  });

  it("is never sent twice by two workers", async () => {
    const o = await buy(seed.festi, { GENERAL: 1 });
    sender.delayMs = 150;
    const [r1, r2] = await Promise.all([deliver(), deliver()]);
    expect(r1.sent + r2.sent).toBe(1);
    expect(sender.sent.filter((m) => linkOf(m).o === o.orderId)).toHaveLength(1);
  });

  it("is skipped when the order was refunded meanwhile, or when it waited too long", async () => {
    const f = seed.festi;
    const refunded = await buy(f, { GENERAL: 1 });
    await db.pool.query(
      `UPDATE public.ticketing_tickets SET status = 'void', void_reason = 'refunded', voided_at = now() WHERE order_id = $1`,
      [refunded.orderId],
    );
    const late = await buy(f, { GENERAL: 1 });
    await db.pool.query(`UPDATE public.ticketing_email_outbox SET status = 'skipped' WHERE order_id <> ALL($1::uuid[]) AND status = 'pending'`, [[refunded.orderId, late.orderId]]);
    expect(await deliver(new Date(Date.now() + 73 * 3600_000))).toEqual({ sent: 0, skipped: 2, retried: 0, failed: 0 });
    expect((await outbox(refunded.orderId))[0]).toMatchObject({ status: "skipped" });
    expect(sender.sent).toHaveLength(0);
  });

  it("escapes buyer and event data in the HTML part", () => {
    const m = ticketsEmail({
      kind: "order_tickets", brandName: "Havana <Resort>", buyerName: `<img src=x onerror=alert(1)>`, reference: "R-1",
      eventTitle: `"Bal" & <b>neige</b>`, startsAt: new Date("2027-01-15T23:30:00Z"), venueName: "Sentier", city: null,
      timezone: "America/Toronto", validTickets: 1, link: `${PUBLIC_URL}/billets#k="x"`,
    });
    expect(m.html).not.toMatch(/<img src=x|<b>neige|<Resort>/);
    expect(m.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(m.html).toContain('href="https://billets.alkao.test/billets#k=&quot;x&quot;"');
    expect(m.text).toContain("vendredi 15 janvier 2027");
  });

  it("derives one link token per order and nonce, unrelated to the QR keys", () => {
    const order = randomUUID();
    const nonce = Buffer.alloc(16, 7);
    expect(emailLinkToken(TEST_CREDENTIAL_SECRET, order, nonce)).toBe(emailLinkToken(TEST_CREDENTIAL_SECRET, order, Buffer.alloc(16, 7)));
    expect(emailLinkToken(TEST_CREDENTIAL_SECRET, order, nonce)).not.toBe(emailLinkToken(TEST_CREDENTIAL_SECRET, order, Buffer.alloc(16, 8)));
    expect(emailLinkToken(TEST_CREDENTIAL_SECRET, order, nonce)).not.toBe(emailLinkToken(TEST_CREDENTIAL_SECRET, randomUUID(), nonce));
    expect(emailLinkToken(TEST_CREDENTIAL_SECRET, order, nonce)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("is queued for the new tickets after a Flex Météo change", async () => {
    const f = seed.festi;
    const o = await buy(f, { GENERAL: 1, FLEX_WEATHER: 1 });
    const viaCheckout = await call(app, "GET", `${pub(f.clientId, f.brandId)}/orders/${o.orderId}`, { headers: { "x-alkao-order-token": o.token } });
    expect(viaCheckout.body.order.canChangeSession).toBe(true);
    const to = await session(f);
    const ex = await call(app, "POST", `${pub(f.clientId, f.brandId)}/orders/${o.orderId}/exchange`, { headers: { "x-alkao-order-token": o.token }, body: { sessionId: to } });
    expect(ex.status).toBe(201);
    expect(await outbox(ex.body.exchange.orderId)).toMatchObject([{ kind: "exchange_tickets", status: "pending" }]);
    const after = await call(app, "GET", `${pub(f.clientId, f.brandId)}/orders/${o.orderId}`, { headers: { "x-alkao-order-token": o.token } });
    expect(after.body.order).toMatchObject({ canChangeSession: false, exchanged: true });

    await db.pool.query(`UPDATE public.ticketing_email_outbox SET status = 'skipped' WHERE order_id = $1`, [o.orderId]);
    await deliver();
    expect(sender.sent.map((m) => m.subject.startsWith("Vos nouveaux billets"))).toEqual([true]);
  });
});

describe("staff: tickets email status and resend", () => {
  it("shows delivery state and sends the same link again", async () => {
    const f = seed.festi;
    const o = await buy(f, { GENERAL: 1 });
    await deliver();
    const first = linkOf(sender.sent[0]!);
    const owner = await tokenFor(seed.users.festiOwner);

    const detail = await call(app, "GET", `${adm(f.clientId, f.brandId)}/orders/${o.orderId}`, { token: owner });
    expect(detail.body.order.emails).toMatchObject([{ kind: "order_tickets", status: "sent", attempts: 1 }]);
    expect(JSON.stringify(detail.body)).not.toContain(first.k);

    const resend = await call(app, "POST", `${adm(f.clientId, f.brandId)}/orders/${o.orderId}/tickets-email`, { token: owner });
    expect(resend.status).toBe(202);
    expect(await deliver()).toMatchObject({ sent: 1 });
    const second = linkOf(sender.sent[1]!);
    expect(second.k).toBe(first.k);
    expect(sender.sent[1]!.idempotencyKey).not.toBe(sender.sent[0]!.idempotencyKey);

    const { rows } = await db.pool.query(`SELECT action FROM public.ticketing_audit_log WHERE entity_id = $1 AND action = 'order.tickets_email_requested'`, [o.orderId]);
    expect(rows).toHaveLength(1);
  });

  it("is limited to staff who manage tickets, inside their own Client", async () => {
    const h = seed.havana;
    const staff = await tokenFor(seed.users.havanaStaff);
    expect((await call(app, "POST", `${adm(h.clientId, h.brandId)}/orders/${h.orderId}/tickets-email`, { token: staff })).status).toBe(403);
    const festiOwner = await tokenFor(seed.users.festiOwner);
    expect((await call(app, "POST", `${adm(h.clientId, h.brandId)}/orders/${h.orderId}/tickets-email`, { token: festiOwner })).status).toBe(404);
    const f = seed.festi;
    expect((await call(app, "POST", `${adm(f.clientId, f.brandId)}/orders/${h.orderId}/tickets-email`, { token: festiOwner })).status).toBe(404);
  });
});

describe("Resend sender", () => {
  const message: EmailMessage = { to: "a@example.com", fromName: 'FESTI-ICE "Québec"\r\nBcc: x', subject: "S", text: "T", html: "<p>H</p>", idempotencyKey: "k-1" };
  const fakeFetch = (status: number, body: unknown, seen: Request[] = []) =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push(new Request(input, init));
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;

  it("posts one message with the idempotency key and a safe display name", async () => {
    const seen: Request[] = [];
    const id = await new ResendEmailSender("re_test_key", "billets@alkao.ca", fakeFetch(200, { id: "em_1" }, seen)).send(message);
    expect(id).toBe("em_1");
    const req = seen[0]!;
    expect(req.url).toBe("https://api.resend.com/emails");
    expect(req.headers.get("authorization")).toBe("Bearer re_test_key");
    expect(req.headers.get("idempotency-key")).toBe("k-1");
    const body = (await req.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ to: ["a@example.com"], subject: "S", text: "T", html: "<p>H</p>" });
    expect(body.from).toBe('"FESTI-ICE Québec Bcc: x" <billets@alkao.ca>');
  });

  it("retries on 429 and 5xx and on network errors, not on 4xx", async () => {
    const err = async (f: typeof fetch): Promise<EmailSendError> => {
      try {
        await new ResendEmailSender("re_test_key", "billets@alkao.ca", f).send(message);
      } catch (e) {
        return e as EmailSendError;
      }
      throw new Error("expected a failure");
    };
    expect((await err(fakeFetch(500, {}))).retryable).toBe(true);
    expect((await err(fakeFetch(429, {}))).retryable).toBe(true);
    expect((await err(fakeFetch(422, { name: "validation_error" }))).retryable).toBe(false);
    expect((await err((async () => { throw new TypeError("fetch failed"); }) as typeof fetch)).retryable).toBe(true);
  });
});

describe("refund emails and personal links (Run 12)", () => {
  it("tells the buyer about each refund and keeps the same personal link", async () => {
    const f = seed.festi;
    const o = await buy(f, { GENERAL: 2 });
    await deliver();
    const first = linkOf(sender.sent.at(-1)!);
    const owner = await tokenFor(seed.users.festiOwner);
    const detail = await call(app, "GET", `${adm(f.clientId, f.brandId)}/orders/${o.orderId}`, { token: owner });
    const ticket = detail.body.order.tickets[0].id;
    const refund = await call(app, "POST", `${adm(f.clientId, f.brandId)}/orders/${o.orderId}/refunds`, { token: owner, body: { amountCents: 1500, ticketIds: [ticket] } });
    expect(refund.status).toBe(201);

    expect(await deliver()).toMatchObject({ sent: 1 });
    const m = sender.sent.at(-1)!;
    expect(m.subject).toMatch(/^Remboursement de 15,00\s\$ — /);
    expect(m.text).toContain("1 billet annulé.");
    expect(m.text).toContain("Vos 1 autre billet reste valide");
    expect(linkOf(m).k).toBe(first.k); // one link per order: the first email still works
    const viaFirst = await call(app, "GET", `${pub(f.clientId, f.brandId)}/orders/${o.orderId}`, { headers: { "x-alkao-order-token": first.k } });
    expect(viaFirst.status).toBe(200);
  });

  it("explains a payment that arrived after the seats were gone", () => {
    const m = refundEmail({
      brandName: "FESTI-ICE", buyerName: null, reference: "R-9", eventTitle: "Patin de nuit", amountCents: 4599,
      reason: "capacity_unavailable", voidedTickets: 0, validTickets: 0, link: null,
    });
    expect(m.text).toContain("Les places n'étaient plus disponibles");
    expect(m.text).toContain("45,99");
    expect(m.html).not.toContain("Afficher mes billets");
  });

  it("does not send a refund email for a session cancellation (it has its own)", async () => {
    const f = seed.festi;
    const o = await buy(f, { GENERAL: 1 });
    await deliver();
    const { rows } = await db.pool.query(`SELECT id FROM public.ticketing_refunds WHERE order_id = $1`, [o.orderId]);
    expect(rows).toEqual([]);
    const owner = await tokenFor(seed.users.festiOwner);
    const { rows: s } = await db.pool.query(`SELECT session_id FROM public.ticketing_orders WHERE id = $1`, [o.orderId]);
    await call(app, "POST", `${adm(f.clientId, f.brandId)}/sessions/${s[0].session_id}/cancel`, { token: owner, body: {} });
    expect((await outbox(o.orderId)).map((r: { kind: string }) => r.kind).sort()).toEqual(["order_tickets", "session_cancelled"]);
  });

  it("lets staff kill a leaked link and send a new one", async () => {
    const f = seed.festi;
    const o = await buy(f, { GENERAL: 1 });
    await deliver();
    const leaked = linkOf(sender.sent.at(-1)!);
    const owner = await tokenFor(seed.users.festiOwner);
    const rotated = await call(app, "POST", `${adm(f.clientId, f.brandId)}/orders/${o.orderId}/tickets-link/rotate`, { token: owner });
    expect(rotated.status).toBe(202);
    const dead = await call(app, "GET", `${pub(f.clientId, f.brandId)}/orders/${o.orderId}`, { headers: { "x-alkao-order-token": leaked.k } });
    expect(dead.status).toBe(404);
    expect(await deliver()).toMatchObject({ sent: 1 });
    const fresh = linkOf(sender.sent.at(-1)!);
    expect(fresh.k).not.toBe(leaked.k);
    expect((await call(app, "GET", `${pub(f.clientId, f.brandId)}/orders/${o.orderId}`, { headers: { "x-alkao-order-token": fresh.k } })).status).toBe(200);
    // The checkout token is a separate link and keeps working.
    expect((await call(app, "GET", `${pub(f.clientId, f.brandId)}/orders/${o.orderId}`, { headers: { "x-alkao-order-token": o.token } })).status).toBe(200);
    const staff = await tokenFor(seed.users.havanaStaff);
    expect((await call(app, "POST", `${adm(f.clientId, f.brandId)}/orders/${o.orderId}/tickets-link/rotate`, { token: staff })).status).toBe(404);
  });
});

describe("English emails (Run 16)", () => {
  it("sends the tickets, refund and cancellation emails in the buyer's language", async () => {
    const f = seed.festi;
    const o = await buy(f, { GENERAL: 1 }, { email: "visitor@example.com", fullName: "Alex Visitor", language: "en" });
    await deliver();
    const tickets = sender.sent.at(-1)!;
    expect(tickets.subject).toMatch(/^Your tickets — /);
    expect(tickets.text).toContain("Hello Alex Visitor,");
    expect(tickets.text).toContain("1 ticket");
    expect(tickets.html).toContain('<html lang="en">');
    expect(tickets.html).toContain("Show my tickets");
    expect(tickets.text).toMatch(/(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/);

    const refund = refundEmail({ language: "en", brandName: "FESTI-ICE", buyerName: null, reference: "R-1", eventTitle: "Night skate", amountCents: 1500, reason: null, voidedTickets: 1, validTickets: 0, link: null });
    expect(refund.subject).toBe("Refund of $15.00 — Night skate (R-1)");
    expect(refund.text).toContain("1 ticket cancelled.");
    const late = refundEmail({ language: "en", brandName: "FESTI-ICE", buyerName: null, reference: "R-2", eventTitle: "Night skate", amountCents: 4599, reason: "capacity_unavailable", voidedTickets: 0, validTickets: 0, link: null });
    expect(late.text).toContain("The seats were no longer available");

    const owner = await tokenFor(seed.users.festiOwner);
    const { rows } = await db.pool.query(`SELECT session_id FROM public.ticketing_orders WHERE id = $1`, [o.orderId]);
    await call(app, "POST", `${adm(f.clientId, f.brandId)}/sessions/${rows[0].session_id}/cancel`, { token: owner, body: {} });
    await deliver();
    const cancelled = sender.sent.at(-1)!;
    expect(cancelled.subject).toMatch(/^Session cancelled — /);
    expect(cancelled.text).toMatch(/You are refunded \$\d/);
  });
});
