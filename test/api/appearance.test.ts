import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EmailMessage, EmailSender } from "../../src/delivery/email.js";
import { refundEmail, ticketsEmail, type EmailLook } from "../../src/delivery/templates.js";
import { deliverTicketEmails } from "../../src/delivery/worker.js";
import { contrastRatio } from "../../src/domain/appearance.js";
import { adm, call, pub, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { seedTwoTenants, TEST_CREDENTIAL_SECRET, type SeedResult } from "../helpers/seed.js";

// Run 50: each Brand's look (logo, colour, contact) and each event's photo, on the tickets
// page, the shop and the buyer e-mails. Synthetic data only.

class FakeSender implements EmailSender {
  sent: EmailMessage[] = [];
  async send(m: EmailMessage) {
    this.sent.push(m);
    return `msg_${this.sent.length}`;
  }
}

let db: TestDatabase;
let seed: SeedResult;
let app: TestApp;
let owner: string;
let editor: string;
let staff: string;
let viewer: string;

const LOOK = {
  logoUrl: "https://cdn.example.com/brand/logo.png",
  accentColor: "#0F766E",
  onAccentColor: "#FFFFFF",
  websiteUrl: "https://www.example.com/",
  supportEmail: "Billets@Example.com",
  supportPhone: "+1 514 555-0100",
  addressLine: "100, rue Exemple, Ville (Québec)",
};

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  app = testApp(db.pool);
  owner = await tokenFor(seed.users.havanaOwner);
  staff = await tokenFor(seed.users.havanaStaff);
  viewer = await tokenFor(seed.users.both);
  const editorId = randomUUID();
  await db.pool.query(`INSERT INTO public.ticketing_memberships (client_id, user_id, role) VALUES ($1, $2, 'editor')`, [seed.havana.clientId, editorId]);
  editor = await tokenFor(editorId);
});

afterAll(async () => {
  await db?.drop();
});

const havana = () => adm(seed.havana.clientId, seed.havana.brandId);
const festi = () => adm(seed.festi.clientId, seed.festi.brandId);

describe("Brand appearance in /ops", () => {
  it("starts neutral, with the Brand's name for the preview", async () => {
    const res = await call(app, "GET", `${havana()}/appearance`, { token: owner });
    expect(res.status).toBe(200);
    expect(res.body.appearance).toMatchObject({
      logoUrl: null, accentColor: null, onAccentColor: null, websiteUrl: null, supportEmail: null, supportPhone: null, addressLine: null,
      updatedAt: null, brandName: "Havana Resort — Événements", showOnAlkao: false,
    });
  });

  it("is read by every role and written by those who edit the catalog", async () => {
    for (const token of [staff, viewer]) {
      expect((await call(app, "GET", `${havana()}/appearance`, { token })).status).toBe(200);
      const put = await call(app, "PUT", `${havana()}/appearance`, { token, body: LOOK });
      expect(put.status).toBe(403);
      expect(put.body.error.code).toBe("forbidden");
    }
    const saved = await call(app, "PUT", `${havana()}/appearance`, { token: editor, body: LOOK });
    expect(saved.status).toBe(200);
    // Colours and e-mail are stored in lower case.
    expect(saved.body.appearance).toMatchObject({ ...LOOK, accentColor: "#0f766e", onAccentColor: "#ffffff", supportEmail: "billets@example.com" });
    expect(saved.body.appearance.updatedAt).not.toBeNull();
    const { rows } = await db.pool.query(
      `SELECT action, data FROM public.ticketing_audit_log WHERE client_id = $1 AND brand_id = $2 AND action = 'brand.appearance_updated'`,
      [seed.havana.clientId, seed.havana.brandId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].data).toMatchObject({ logo: true, accentColor: "#0f766e", website: true });
  });

  it("stays inside its own Brand", async () => {
    const festiOwner = await tokenFor(seed.users.festiOwner);
    expect((await call(app, "GET", `${havana()}/appearance`, { token: festiOwner })).status).toBe(404);
    expect((await call(app, "PUT", `${havana()}/appearance`, { token: festiOwner, body: LOOK })).status).toBe(404);
    const other = await call(app, "GET", `${festi()}/appearance`, { token: festiOwner });
    expect(other.body.appearance.logoUrl).toBeNull();
    expect(other.body.appearance.brandName).toBe("FESTI-ICE");
  });

  it("refuses addresses that are not https, bad colours and a colour without its text colour", async () => {
    const bad = [
      { ...LOOK, logoUrl: "http://cdn.example.com/logo.png" },
      { ...LOOK, logoUrl: "javascript:alert(1)" },
      { ...LOOK, websiteUrl: "https://exa mple.com" },
      { ...LOOK, accentColor: "red" },
      { ...LOOK, accentColor: "#0f766e", onAccentColor: null },
      { ...LOOK, supportPhone: "<b>1</b>" },
      { ...LOOK, addressLine: "<script>" },
      { ...LOOK, supportEmail: "pas-un-courriel" },
    ];
    for (const body of bad) {
      const res = await call(app, "PUT", `${havana()}/appearance`, { token: owner, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe("invalid_request");
    }
  });

  it("refuses colours that are hard to read together (WCAG AA, 4.5 to 1)", async () => {
    const res = await call(app, "PUT", `${havana()}/appearance`, { token: owner, body: { ...LOOK, accentColor: "#ffd54f", onAccentColor: "#ffffff" } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("appearance_low_contrast");
    expect(res.body.error.details).toMatchObject({ minimum: 4.5 });
    expect(contrastRatio("#ffd54f", "#000000")).toBeGreaterThan(4.5);
    expect((await call(app, "PUT", `${havana()}/appearance`, { token: owner, body: { ...LOOK, accentColor: "#ffd54f", onAccentColor: "#000000" } })).status).toBe(200);
    // Back to the test look; the refused one changed nothing.
    expect((await call(app, "PUT", `${havana()}/appearance`, { token: owner, body: LOOK })).status).toBe(200);
  });

  it("goes back to the neutral look when every field is emptied", async () => {
    const cleared = await call(app, "PUT", `${festi()}/appearance`, { token: await tokenFor(seed.users.festiOwner), body: {} });
    expect(cleared.status).toBe(200);
    expect(cleared.body.appearance).toMatchObject({ logoUrl: null, accentColor: null, onAccentColor: null });
  });

  it("is guarded by the database too", async () => {
    await expect(db.pool.query(
      `UPDATE public.ticketing_brand_settings SET logo_url = 'http://example.com/x.png' WHERE client_id = $1 AND brand_id = $2`,
      [seed.havana.clientId, seed.havana.brandId],
    )).rejects.toThrow(/check constraint/);
    await expect(db.pool.query(
      `UPDATE public.ticketing_brand_settings SET on_accent_color = NULL WHERE client_id = $1 AND brand_id = $2`,
      [seed.havana.clientId, seed.havana.brandId],
    )).rejects.toThrow(/accent_pair/);
    await expect(db.pool.query(
      `UPDATE public.ticketing_events SET image_url = 'https://example.com/a"onerror=x' WHERE id = $1`, [seed.havana.eventId],
    )).rejects.toThrow(/check constraint/);
  });
});

describe("the event's photo", () => {
  const PHOTO = "https://cdn.example.com/events/night.jpg";

  it("is set, shown and removed from /ops", async () => {
    expect((await call(app, "PATCH", `${havana()}/events/${seed.havana.eventId}`, { token: owner, body: { imageUrl: "http://cdn.example.com/x.jpg" } })).status).toBe(400);
    const set = await call(app, "PATCH", `${havana()}/events/${seed.havana.eventId}`, { token: editor, body: { imageUrl: PHOTO } });
    expect(set.status).toBe(200);
    expect(set.body.event.imageUrl).toBe(PHOTO);
    const cleared = await call(app, "PATCH", `${havana()}/events/${seed.havana.eventId}`, { token: owner, body: { imageUrl: null } });
    expect(cleared.body.event.imageUrl).toBeNull();
    await call(app, "PATCH", `${havana()}/events/${seed.havana.eventId}`, { token: owner, body: { imageUrl: PHOTO } });
  });

  it("reaches the shop with the Brand's look, and not another Brand's", async () => {
    const list = await call(app, "GET", `${pub(seed.havana.clientId, seed.havana.brandId)}/events`);
    expect(list.body.events.find((e: { id: string }) => e.id === seed.havana.eventId).imageUrl).toBe(PHOTO);
    const detail = await call(app, "GET", `${pub(seed.havana.clientId, seed.havana.brandId)}/events/${seed.havana.eventId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.event.imageUrl).toBe(PHOTO);
    expect(detail.body.event.brand).toMatchObject({ name: "Havana Resort — Événements", logoUrl: LOOK.logoUrl, accentColor: "#0f766e", onAccentColor: "#ffffff" });
    const other = await call(app, "GET", `${pub(seed.festi.clientId, seed.festi.brandId)}/events/${seed.festi.eventId}`);
    expect(other.body.event.brand).toMatchObject({ name: "FESTI-ICE", logoUrl: null, accentColor: null });
    expect(other.body.event.imageUrl).toBeNull();
  });

  it("reaches the buyer's tickets page", async () => {
    const t = seed.havana;
    const res = await call(app, "GET", `${pub(t.clientId, t.brandId)}/orders/${t.orderId}`, { headers: { "x-alkao-order-token": `secret-${t.orderId}` } });
    expect(res.status).toBe(200);
    expect(res.body.order.brand).toMatchObject({ logoUrl: LOOK.logoUrl, accentColor: "#0f766e", websiteUrl: LOOK.websiteUrl, supportPhone: LOOK.supportPhone });
    expect(res.body.order.event.imageUrl).toBe(PHOTO);
  });
});

describe("buyer e-mails in the Brand's look", () => {
  const base = {
    kind: "order_tickets" as const, brandName: `Camp "Lune" <Nuit>`, buyerName: "Marie", reference: "ALK-TEST1",
    eventTitle: "Soirée", startsAt: new Date("2026-10-24T23:00:00Z"), venueName: "Site", city: null, timezone: "America/Toronto",
    validTickets: 2, link: "https://billets.alkao.test/billets/x",
  };
  const look: EmailLook = { ...LOOK, accentColor: "#0f766e", onAccentColor: "#ffffff", supportEmail: "billets@example.com", imageUrl: "https://cdn.example.com/p.jpg" };

  it("shows the logo, the photo, the colour and the contact, escaped", () => {
    const m = ticketsEmail({ ...base, look });
    expect(m.html).toContain(`<img src="https://cdn.example.com/brand/logo.png" alt="Camp &quot;Lune&quot; &lt;Nuit&gt;"`);
    expect(m.html).toContain(`src="https://cdn.example.com/p.jpg"`);
    expect(m.html).toContain(`bgcolor="#0f766e" style="background:#0f766e;padding:16px 28px"`);
    expect(m.html).toContain("background:#0f766e;color:#ffffff");
    expect(m.html).toContain("www.example.com · billets@example.com · +1 514 555-0100 · 100, rue Exemple, Ville (Québec)");
    expect(m.text).toContain("www.example.com · billets@example.com");
    expect(m.html).not.toContain(`<Nuit>`);
  });

  it("keeps the neutral look without one, and ignores values that are not safe", () => {
    const plain = ticketsEmail(base);
    expect(plain.html).not.toContain("<img");
    expect(plain.html).toContain(`bgcolor="#1c1917"`);
    const hostile = refundEmail({
      brandName: "B", buyerName: null, reference: "R", eventTitle: "E", amountCents: 100, reason: null, voidedTickets: 1, validTickets: 1,
      link: "https://billets.alkao.test/billets/x",
      look: { ...look, logoUrl: "javascript:alert(1)", imageUrl: "http://x/y.jpg", accentColor: "red;x:y", onAccentColor: "#fff\"" },
    });
    expect(hostile.html).not.toContain("javascript:");
    expect(hostile.html).not.toContain("http://x/y.jpg");
    expect(hostile.html).not.toContain("red;x:y");
    expect(hostile.html).toContain(`bgcolor="#1c1917"`);
  });

  it("are sent in each Brand's own look by the worker", async () => {
    await db.pool.query(`UPDATE public.ticketing_email_outbox SET status = 'skipped', last_error = 'seed' WHERE status = 'pending'`);
    await db.pool.query(
      `UPDATE public.ticketing_email_outbox SET status = 'pending', attempts = 0, next_attempt_at = now(), sent_at = NULL, last_error = NULL
       WHERE order_id = ANY($1::uuid[]) AND kind = 'order_tickets'`,
      [[seed.havana.orderId, seed.festi.orderId]],
    );
    const sender = new FakeSender();
    await deliverTicketEmails(db.pool, { sender, publicUrl: "https://billets.alkao.test", credentialMasterSecret: TEST_CREDENTIAL_SECRET }, new Date(Date.now() + 1000));
    expect(sender.sent).toHaveLength(2);
    const byBrand = (name: string) => sender.sent.find((m) => m.fromName === name)!;
    const h = byBrand("Havana Resort — Événements");
    expect(h.html).toContain(`src="${LOOK.logoUrl}"`);
    expect(h.html).toContain(`src="https://cdn.example.com/events/night.jpg"`);
    expect(h.html).toContain("background:#0f766e;color:#ffffff");
    const f = byBrand("FESTI-ICE");
    expect(f.html).not.toContain("cdn.example.com");
    expect(f.html).toContain("background:#1c1917;color:#ffffff");
  });
});
