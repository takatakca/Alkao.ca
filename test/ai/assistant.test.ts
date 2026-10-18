import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkText, formatPrice, formatWhen, loadFacts } from "../../src/ai/drafts.js";
import { WriterError, type Writer } from "../../src/ai/writer.js";
import { withTransaction } from "../../src/db/pool.js";
import { EventFile, importEvent } from "../../src/ops/events-import.js";
import { adm, call, testApp, tokenFor } from "../helpers/app.js";
import { createTestDatabase, type TestDatabase } from "../helpers/db.js";
import { seedTwoTenants, type SeedResult } from "../helpers/seed.js";
import { FakeWriter } from "../helpers/writer.js";

/**
 * Run 92: the writing assistant drafts from the catalog only, and the code refuses a draft
 * that names a price, a discount, a code or a link nobody gave it. A fake model stands in for
 * Claude: these tests never reach the network and cost nothing.
 */
let db: TestDatabase;
let seed: SeedResult;
let halloweenId: string;
const NOW = new Date("2026-10-01T12:00:00Z");
const havana = EventFile.parse(JSON.parse(readFileSync(new URL("../../catalogs/havana-halloween-2026.json", import.meta.url), "utf8")));

const GOOD_EMAIL = {
  subject: "Halloween Havana 2026 : les samedis d'octobre",
  preheader: "Adulte 25 $ + taxes, enfant 12 $ + taxes",
  heading: "Bonjour {prénom},",
  body: "Le train de l'Halloween revient chaque samedi d'octobre, de 14 h à 22 h, à Maricourt.\n\nL'entrée adulte est à 25 $ + taxes et l'entrée enfant à 12 $ + taxes.",
  ctaLabel: "Choisir ma date",
};

const scope = () => ({ clientId: seed.havana.clientId, brandId: seed.havana.brandId });
const base = () => adm(seed.havana.clientId, seed.havana.brandId);
const appWith = (writer: Writer | null, extra = {}) => testApp(db.pool, { now: () => NOW, writer, ...extra });
const owner = () => tokenFor(seed.users.havanaOwner);

beforeAll(async () => {
  db = await createTestDatabase();
  seed = await seedTwoTenants(db.pool);
  const r = await withTransaction(db.pool, (tx) => importEvent(tx, scope(), havana, { capacity: 300, publish: true, listOnAlkao: false, now: NOW }));
  halloweenId = r.eventId;
});
afterAll(async () => { await db?.drop(); });

describe("Run 92: the writing assistant", () => {
  it("is off without a writer, and /ops knows it", async () => {
    const app = appWith(null);
    const token = await owner();
    const r = await call(app, "POST", `${base()}/assistant/campaign`, { token, body: { channel: "email", brief: "Annoncer l'Halloween" } });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe("assistant_disabled");
    expect((await call(app, "GET", `${base()}/status`, { token })).body.assistant).toBe(false);
    expect((await call(appWith(new FakeWriter([GOOD_EMAIL])), "GET", `${base()}/status`, { token })).body.assistant).toBe(true);
  });

  it("gives the model the catalog only: titles, dates, places and prices, never a customer", async () => {
    const writer = new FakeWriter([GOOD_EMAIL]);
    const r = await call(appWith(writer), "POST", `${base()}/assistant/campaign`, {
      token: await owner(), body: { channel: "email", eventId: halloweenId, brief: "Annoncer les soirées d'Halloween aux familles" },
    });
    expect(r.status).toBe(200);
    expect(r.body.draft).toEqual(GOOD_EMAIL);
    const [asked] = writer.asked;
    expect(asked!.prompt).toContain("Halloween Havana 2026");
    expect(asked!.prompt).toContain("samedi 3 octobre 2026 à 14 h");
    expect(asked!.prompt).toContain("25 $");
    expect(asked!.prompt).toContain("Annoncer les soirées d'Halloween aux familles");
    expect(asked!.prompt).not.toMatch(/@example\.com/);
    expect(asked!.system).toMatch(/N'inventez jamais un prix/);
    // In the Journal, with what it cost in tokens; not the text itself.
    const { rows } = await db.pool.query(`SELECT data FROM public.ticketing_audit_log WHERE action = 'assistant.drafted' ORDER BY id DESC LIMIT 1`);
    expect(rows[0].data).toMatchObject({ kind: "campaign_email", outcome: "ok", inputTokens: 1800, outputTokens: 400, attempts: 1 });
  });

  it("sends back a draft with an invented price or a link, then takes the corrected one", async () => {
    const invented = { ...GOOD_EMAIL, body: "Profitez de l'entrée à 19 $ seulement. Détails sur www.exemple.com" };
    const writer = new FakeWriter([invented, GOOD_EMAIL]);
    const r = await call(appWith(writer), "POST", `${base()}/assistant/campaign`, { token: await owner(), body: { channel: "email", eventId: halloweenId, brief: "Relancer" } });
    expect(r.status).toBe(200);
    expect(writer.asked).toHaveLength(2);
    expect(writer.asked[1]!.prompt).toMatch(/19 \$/);
    expect(writer.asked[1]!.prompt).toMatch(/lien ou une adresse web/);
  });

  it("gives staff the reasons when the model keeps breaking a rule", async () => {
    const rebate = { ...GOOD_EMAIL, subject: "20 % de rabais avec le code HALLO20" };
    const r = await call(appWith(new FakeWriter([rebate])), "POST", `${base()}/assistant/campaign`, { token: await owner(), body: { channel: "email", brief: "Relancer les familles" } });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("assistant_draft_rejected");
    expect(r.body.error.details.join(" ")).toMatch(/20 %/);
    expect(r.body.error.details.join(" ")).toMatch(/HALLO20/);
  });

  it("allows an offer the organizer wrote in the brief", async () => {
    const offer = { ...GOOD_EMAIL, subject: "20 % de rabais avec le code HALLO20" };
    const r = await call(appWith(new FakeWriter([offer])), "POST", `${base()}/assistant/campaign`, {
      token: await owner(), body: { channel: "email", eventId: halloweenId, brief: "Offrir 20 % de rabais avec le code HALLO20 jusqu'au 10 octobre" },
    });
    expect(r.status).toBe(200);
  });

  it("says few seats are left only for the dates where it is true", async () => {
    await db.pool.query(
      `UPDATE public.ticketing_sessions SET sold_count = 290 WHERE event_id = $1 AND starts_at = '2026-10-24T18:00:00Z'`, [halloweenId]);
    const facts = await loadFacts(db.pool, scope(), { eventId: halloweenId, language: "fr", now: NOW });
    const dates = facts.evenements[0]!.dates;
    expect(dates.filter((d) => d.peuDePlaces).map((d) => d.quand)).toEqual(["samedi 24 octobre 2026 à 14 h"]);
    expect(dates.some((d) => d.complet)).toBe(false);
  });

  it("drafts a text message that fits, and refuses a long one", async () => {
    const ok = await call(appWith(new FakeWriter([{ body: "Halloween Havana : chaque samedi d'octobre, 14 h à 22 h. Adulte 25 $ + taxes." }])), "POST", `${base()}/assistant/campaign`, {
      token: await owner(), body: { channel: "sms", eventId: halloweenId, brief: "Rappel" },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.draft).toEqual({ body: "Halloween Havana : chaque samedi d'octobre, 14 h à 22 h. Adulte 25 $ + taxes." });
    const long = await call(appWith(new FakeWriter([{ body: "x".repeat(260) }])), "POST", `${base()}/assistant/campaign`, {
      token: await owner(), body: { channel: "sms", eventId: halloweenId, brief: "Rappel" },
    });
    expect(long.status).toBe(422);
    expect(long.body.error.details[0]).toMatch(/220 caractères/);
  });

  it("drafts an event description without dates or prices in what it is given", async () => {
    const writer = new FakeWriter([{ description: "Un parcours en train à travers le site décoré pour l'Halloween, pour toute la famille." }]);
    const r = await call(appWith(writer), "POST", `${base()}/events/${halloweenId}/assistant/description`, {
      token: await owner(), body: { notes: "Tour de train, maquillage pour enfants, chocolat chaud" },
    });
    expect(r.status).toBe(200);
    expect(r.body.draft.description).toMatch(/parcours en train/);
    expect(writer.asked[0]!.prompt).not.toContain("octobre 2026");
    expect(writer.asked[0]!.prompt).toContain("maquillage pour enfants");
  });

  it("drafts the event page's sections from its facts, and refuses an invented price there too (Run 93)", async () => {
    await db.pool.query(`UPDATE public.ticketing_events SET duration_minutes = 120, format = 'Parcours extérieur' WHERE id = $1`, [halloweenId]);
    await db.pool.query(`INSERT INTO public.ticketing_brand_settings (client_id, brand_id, refund_policy) VALUES ($1, $2, 'Échange de date sans frais jusqu''à 48 h avant.')
      ON CONFLICT (client_id, brand_id) DO UPDATE SET refund_policy = EXCLUDED.refund_policy`, [seed.havana.clientId, seed.havana.brandId]);
    const PAGE = {
      summary: "Train hanté, village décoré et spectacle pour enfants",
      highlights: [{ title: "Le train de l'Halloween", text: "Un tour du site à bord du petit train." }],
      steps: [{ title: "Arrivée", text: "Présentez votre billet à l'entrée." }, { title: "Le tour", text: "Environ deux heures sur le site." }],
      faq: [{ question: "Puis-je changer de date ?", answer: "Oui, sans frais jusqu'à 48 h avant." }, { question: "Combien coûte l'entrée enfant ?", answer: "12 $ + taxes." }],
    };
    const writer = new FakeWriter([PAGE]);
    const r = await call(appWith(writer), "POST", `${base()}/events/${halloweenId}/assistant/page`, { token: await owner(), body: { notes: "Train, village hanté, spectacle Robin des bois" } });
    expect(r.status).toBe(200);
    expect(r.body.draft).toEqual(PAGE);
    expect(writer.asked[0]!.prompt).toContain("Échange de date sans frais");
    expect(writer.asked[0]!.prompt).toContain("Parcours extérieur");
    expect(writer.asked[0]!.prompt).toContain("2 h");
    expect(writer.asked[0]!.prompt).not.toContain("octobre 2026");
    expect(writer.asked[0]!.system).toMatch(/que si les faits ou les notes en donnent la réponse/);

    const invented = { ...PAGE, faq: [{ question: "Combien coûte l'entrée ?", answer: "Seulement 9 $." }] };
    const bad = await call(appWith(new FakeWriter([invented])), "POST", `${base()}/events/${halloweenId}/assistant/page`, { token: await owner(), body: {} });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details.join(" ")).toMatch(/La réponse 1 cite un prix \(9 \$\)/);
    const tooMany = { ...PAGE, highlights: Array.from({ length: 8 }, (_, i) => ({ title: `Point ${i + 1}`, text: "Un détail." })) };
    const many = await call(appWith(new FakeWriter([tooMany])), "POST", `${base()}/events/${halloweenId}/assistant/page`, { token: await owner(), body: {} });
    expect(many.body.error.details[0]).toMatch(/Les points forts : 6 au plus/);
  });

  it("stops at the daily ceiling for the Brand", async () => {
    const before = (await db.pool.query(`SELECT count(*)::int AS n FROM public.ticketing_audit_log WHERE action = 'assistant.drafted'`)).rows[0].n;
    const app = appWith(new FakeWriter([GOOD_EMAIL]), { assistantDailyLimit: before + 1 });
    const token = await owner();
    const body = { channel: "email", eventId: halloweenId, brief: "Relancer" };
    expect((await call(app, "POST", `${base()}/assistant/campaign`, { token, body })).status).toBe(200);
    const r = await call(app, "POST", `${base()}/assistant/campaign`, { token, body });
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe("assistant_daily_limit");
  });

  it("reports a declined request, and keeps other Brands and roles out", async () => {
    const refused = await call(appWith(new FakeWriter([new WriterError("refused")])), "POST", `${base()}/assistant/campaign`, {
      token: await owner(), body: { channel: "email", eventId: halloweenId, brief: "Relancer" },
    });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe("assistant_refused");
    const app = appWith(new FakeWriter([GOOD_EMAIL]));
    // FESTI-ICE's owner, on Havana's event.
    const festi = await call(app, "POST", `${adm(seed.festi.clientId, seed.festi.brandId)}/assistant/campaign`, {
      token: await tokenFor(seed.users.festiOwner), body: { channel: "email", eventId: halloweenId, brief: "Relancer" },
    });
    expect(festi.status).toBe(404);
    const staff = await call(app, "POST", `${base()}/assistant/campaign`, { token: await tokenFor(seed.users.havanaStaff), body: { channel: "email", brief: "Relancer" } });
    expect(staff.status).toBe(403);
  });
});

describe("Run 92: the checks on a draft", () => {
  const facts = { marque: "Promo Havana", siteWeb: null, politique: null, evenements: [], priceCents: new Set([2500, 1250]), hasFree: false };
  const check = (text: string, brief = "") => checkText(text, facts, brief, 500, "Le texte");

  it("knows a price written the French or the English way", () => {
    expect(check("Adulte 25 $ + taxes, enfant 12,50 $ + taxes")).toEqual([]);
    expect(check("Adults $25 + tax, children $12.50 + tax")).toEqual([]);
    expect(check("Seulement 19,99 $")).toHaveLength(1);
    expect(check("Only 30 dollars")).toHaveLength(1);
  });

  it("does not take the brand's name for an offer, and refuses an unknown placeholder", () => {
    expect(check("Promo Havana vous attend, {prénom}.")).toEqual([]);
    expect(check("Bonjour {nom}")).toEqual(["Le texte utilise {nom}, qui ne sera pas remplacé"]);
    expect(check("Entrée gratuite pour les enfants")[0]).toMatch(/gratuit/);
    expect(check("Entrée gratuite pour les enfants", "les enfants entrent gratuitement")).toEqual([]);
  });

  it("writes prices and dates the way Québec reads them", () => {
    expect(formatPrice(2500, "fr")).toBe("25 $");
    expect(formatPrice(1250, "fr")).toBe("12,50 $");
    expect(formatPrice(1250, "en")).toBe("$12.50");
    expect(formatWhen(new Date("2026-10-03T18:00:00Z"), "America/Toronto", "fr")).toBe("samedi 3 octobre 2026 à 14 h");
    expect(formatWhen(new Date("2026-10-03T23:30:00Z"), "America/Toronto", "fr")).toBe("samedi 3 octobre 2026 à 19 h 30");
  });
});
