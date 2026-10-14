import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EmailMessage, EmailSender } from "../../src/delivery/email.js";
import { notifyWaitlists } from "../../src/delivery/waitlist.js";
import { adm, call, pub, testApp, tokenFor, type TestApp } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { seedTwoTenants, type SeedResult } from "../helpers/seed.js";

/**
 * Run 71: a sold-out session's waitlist. One e-mail per sign-up when seats come back, oldest
 * first; nothing kept 30 days after the session.
 */
class Outbox implements EmailSender {
  sent: EmailMessage[] = [];
  async send(m: EmailMessage) { this.sent.push(m); return `msg_${this.sent.length}`; }
}

let db: TestDatabase;
let seed: SeedResult;
let app: TestApp;
let outbox: Outbox;
const notify = (at = new Date()) => notifyWaitlists(db.pool, { sender: outbox, publicUrl: "https://billets.alkao.test" }, at);
const join = (sessionId: string, email: string, language = "fr") =>
  call(app, "POST", `${pub(seed.havana.clientId, seed.havana.brandId)}/sessions/${sessionId}/waitlist`, { body: { email, language } });
const entries = async (sessionId: string) =>
  (await db.pool.query<{ email: string; status: string; language: string }>(
    `SELECT email, status, language FROM public.ticketing_waitlist WHERE session_id = $1 ORDER BY created_at, id`, [sessionId])).rows;
// Full: no seat left once what is sold and held is counted.
const fill = (sessionId: string) => db.pool.query(`UPDATE public.ticketing_sessions SET capacity = sold_count + reserved_count WHERE id = $1`, [sessionId]);
const open = (sessionId: string, seats: number) => db.pool.query(`UPDATE public.ticketing_sessions SET capacity = sold_count + reserved_count + $2 WHERE id = $1`, [sessionId, seats]);

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  app = testApp(db.pool, { publicUrl: "https://billets.alkao.test" });
});

beforeEach(() => {
  outbox = new Outbox();
});

afterAll(async () => {
  await db?.drop();
});

describe("waitlist of a sold-out session", () => {
  it("takes an address only for a full, upcoming session on sale, once per person", async () => {
    const s = seed.havana.sessionId;
    expect((await join(s, "lea@example.test")).status).toBe(409);
    expect((await join(s, "lea@example.test")).body.error.code).toBe("session_not_full");
    await fill(s);
    expect((await join(s, "  Lea@Example.test ")).status).toBe(202);
    expect((await join(s, "lea@example.test")).status).toBe(202);
    expect((await join(s, "max@example.test", "en")).status).toBe(202);
    expect(await entries(s)).toEqual([
      { email: "lea@example.test", status: "waiting", language: "fr" },
      { email: "max@example.test", status: "waiting", language: "en" },
    ]);
    expect((await join(s, "pas-une-adresse")).status).toBe(400);
    expect((await join("00000000-0000-4000-8000-000000000000", "zoe@example.test")).status).toBe(404);
    // Another tenant's session is not found through this Brand.
    expect((await join(seed.festi.sessionId, "zoe@example.test")).status).toBe(404);

    // The organizer sees who waits, as a count.
    const owner = await tokenFor(seed.users.havanaOwner);
    const list = await call(app, "GET", `${adm(seed.havana.clientId, seed.havana.brandId)}/events/${seed.havana.eventId}/sessions`, { token: owner });
    expect(list.body.sessions.find((x: { id: string }) => x.id === s).waitlistCount).toBe(2);
  });

  it("writes to the people waiting, oldest first and once, when seats come back", async () => {
    const s = seed.havana.sessionId;
    // Still full: nobody is told.
    expect(await notify()).toMatchObject({ sent: 0 });
    await open(s, 2);
    expect(await notify()).toMatchObject({ sent: 2 });
    expect(outbox.sent.map((m) => m.to)).toEqual(["lea@example.test", "max@example.test"]);
    const fr = outbox.sent[0]!;
    expect(fr.subject).toBe("Des places sont de retour — Havana Resort — Événements 2026-2027");
    expect(fr.text).toContain("Elles vont au premier qui achète");
    expect(fr.text).toContain(`Voir les billets : https://billets.alkao.test/acheter/${seed.havana.clientId}/${seed.havana.brandId}/${seed.havana.eventId}`);
    expect(outbox.sent[1]!.subject).toMatch(/^Seats are back — /);
    expect(outbox.sent[1]!.text).toContain("?lang=en");
    expect((await entries(s)).map((e) => e.status)).toEqual(["notified", "notified"]);
    // Once: a second pass sends nothing.
    outbox = new Outbox();
    expect(await notify()).toMatchObject({ sent: 0 });
    // Someone who still wants in signs up again (the session is full again).
    await fill(s);
    expect((await join(s, "lea@example.test")).status).toBe(202);
    expect((await entries(s)).filter((e) => e.status === "waiting")).toHaveLength(1);
  });

  it("expires entries of a session that started or was cancelled, and forgets them after 30 days", async () => {
    const s = seed.havana.sessionId;
    const { rows } = await db.pool.query<{ starts_at: Date }>(`SELECT starts_at FROM public.ticketing_sessions WHERE id = $1`, [s]);
    const after = new Date(rows[0]!.starts_at.getTime() + 3600_000);
    await open(s, 5);
    expect(await notify(after)).toMatchObject({ sent: 0, expired: 1 });
    expect((await entries(s)).map((e) => e.status)).toEqual(["notified", "notified", "expired"]);
    expect(await notify(new Date(rows[0]!.starts_at.getTime() + 31 * 86_400_000))).toMatchObject({ purged: 3 });
    expect(await entries(s)).toEqual([]);
  });
});
