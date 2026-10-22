import { z } from "zod";
import * as catalog from "../db/catalog.js";
import { getAppearance } from "../db/appearance.js";
import type { TenantScope } from "../db/commerce.js";
import type { Db } from "../db/pool.js";
import { WriterError, type Writer } from "./writer.js";

/**
 * Run 92: the writing assistant in /ops. It drafts a campaign or an event description from the
 * Brand's own catalog (titles, dates, places, prices); staff read, change and save it like any
 * text they typed. It never sends, saves or publishes anything. Nothing about buyers or
 * customers is sent to the model: only the catalog and the brief staff typed.
 *
 * The model is told the rules; the code checks them again on the answer: a price, a discount
 * or a code that is not in the catalog or in the brief, a link or an unknown placeholder, and
 * the draft is refused (one new try, then staff get the reasons).
 */

export const CampaignDraftRequest = z.object({
  channel: z.enum(["email", "sms"]),
  language: z.enum(["fr", "en"]).default("fr"),
  /** The event the campaign is about; none: everything the Brand has on sale. */
  eventId: z.uuid().nullish(),
  brief: z.string().trim().min(3).max(600),
});
export type CampaignDraftRequest = z.infer<typeof CampaignDraftRequest>;

export const DescriptionDraftRequest = z.object({
  language: z.enum(["fr", "en"]).default("fr"),
  notes: z.string().trim().max(1000).default(""),
});
export type DescriptionDraftRequest = z.infer<typeof DescriptionDraftRequest>;

// The answer's shape. Lengths are checked below rather than in the schema, so a draft one
// word too long is sent back for a shorter one instead of failing to parse.
const EmailDraft = z.object({
  subject: z.string().describe("Objet du courriel, 70 caractères au plus"),
  preheader: z.string().describe("Aperçu dans la boîte de réception, 110 caractères au plus"),
  heading: z.string().describe("Titre en haut du courriel, 80 caractères au plus"),
  body: z.string().describe("Texte : 2 à 4 courts paragraphes séparés par une ligne vide, 1200 caractères au plus"),
  ctaLabel: z.string().describe("Texte du bouton, 30 caractères au plus"),
});
const SmsDraft = z.object({ body: z.string().describe("Texte du texto, 200 caractères au plus") });
const DescriptionDraft = z.object({ description: z.string().describe("Description de l'événement, 1500 caractères au plus") });
// Run 93: the event page's sections (photos stay the organizer's).
const PageDraft = z.object({
  summary: z.string().describe("Une ligne sous le titre : ce qu'on y trouve, 120 caractères au plus"),
  highlights: z.array(z.object({ title: z.string(), text: z.string() })).describe("3 à 6 points forts : un titre de 60 caractères au plus et une phrase de 200 caractères au plus"),
  steps: z.array(z.object({ title: z.string(), text: z.string() })).describe("Le jour J : 3 à 5 étapes dans l'ordre de la visite, un titre court et une phrase"),
  faq: z.array(z.object({ question: z.string(), answer: z.string() })).describe("3 à 8 questions d'acheteur, chacune avec sa réponse tirée des faits ou des notes"),
});
export type PageDraft = z.infer<typeof PageDraft>;

export type EmailDraft = z.infer<typeof EmailDraft>;
export type SmsDraft = z.infer<typeof SmsDraft>;

const LIMITS = {
  subject: 90, preheader: 140, heading: 100, body: 1500, ctaLabel: 40, sms: 220, description: 2000,
} as const;

/** What the model may say about one event, from the catalog only. */
interface EventFacts {
  titre: string;
  categorie: string | null;
  lieu: string | null;
  ville: string | null;
  ageMinimum: number | null;
  langue: string | null;
  accessibilite: string | null;
  descriptionActuelle: string | null;
  duree: string | null;
  format: string | null;
  ventesOuvrentLe: string | null;
  dates: { quand: string; complet: boolean; peuDePlaces: boolean }[];
  autresDates: number;
  tarifs: { nom: string; prix: string; option: boolean }[];
}

interface Facts {
  marque: string;
  siteWeb: string | null;
  /** The Brand's exchange and refund policy, as written in /ops. */
  politique: string | null;
  evenements: EventFacts[];
  /** Every price above, in cents: the only amounts a draft may name (with the brief's). */
  priceCents: Set<number>;
  hasFree: boolean;
}

const MAX_DATES = 12;
const minutesText = (m: number) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${String(m % 60).padStart(2, "0")}` : ""}`);
const MAX_EVENTS = 6;

export function formatPrice(cents: number, language: "fr" | "en"): string {
  const whole = cents % 100 === 0;
  if (language === "en") return `$${whole ? cents / 100 : (cents / 100).toFixed(2)}`;
  return `${whole ? cents / 100 : (cents / 100).toFixed(2).replace(".", ",")} $`;
}

export function formatWhen(at: Date, timeZone: string, language: "fr" | "en"): string {
  if (language === "en") {
    return new Intl.DateTimeFormat("en-CA", { timeZone, weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(at);
  }
  const date = new Intl.DateTimeFormat("fr-CA", { timeZone, weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(at);
  const parts = new Intl.DateTimeFormat("fr-CA", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const h = Number(parts.find((p) => p.type === "hour")?.value);
  const m = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${date} à ${h} h${m === "00" ? "" : ` ${m}`}`;
}

const CATEGORY: Record<string, string> = {
  concerts: "concert", festivals: "festival", sports: "sport", famille: "sortie en famille", "plein-air": "plein air",
  spectacles: "spectacle", soirees: "soirée", experiences: "expérience",
  gastronomie: "gastronomie", mode: "mode", marches: "marché ou salon",
};

async function eventFacts(db: Db, s: TenantScope, event: Record<string, unknown>, venues: Map<string, Record<string, unknown>>, language: "fr" | "en", now: Date) {
  const venue = venues.get(event.venueId as string);
  const timeZone = (venue?.timezone as string) || "America/Toronto";
  const sessions = (await catalog.listSessions(db, s, event.id as string))
    .filter((x) => x.status === "on_sale" && new Date(x.startsAt as string) > now);
  const types = (await catalog.listTicketTypes(db, s, event.id as string)).filter((t) => t.active);
  const salesOpen = event.salesOpenAt ? new Date(event.salesOpenAt as string) : null;
  const facts: EventFacts = {
    titre: event.title as string,
    categorie: event.category ? (CATEGORY[event.category as string] ?? (event.category as string)) : null,
    lieu: (venue?.name as string) ?? null,
    ville: (venue?.city as string) || null,
    ageMinimum: (event.minAge as number | null) ?? null,
    langue: (event.language as string | null) ?? null,
    accessibilite: (event.accessibility as string | null) ?? null,
    descriptionActuelle: (event.description as string | null) || null,
    duree: Number.isInteger(event.durationMinutes) ? minutesText(event.durationMinutes as number) : null,
    format: (event.format as string | null) ?? null,
    ventesOuvrentLe: salesOpen && salesOpen > now ? formatWhen(salesOpen, timeZone, language) : null,
    dates: sessions.slice(0, MAX_DATES).map((x) => {
      const capacity = x.capacity as number;
      const left = capacity - (x.soldCount as number) - (x.reservedCount as number);
      // "Peu de places" only when it is true: a tenth of the room or 5 seats at most.
      return { quand: formatWhen(new Date(x.startsAt as string), timeZone, language), complet: left <= 0, peuDePlaces: left > 0 && left <= Math.max(5, Math.ceil(capacity * 0.1)) };
    }),
    autresDates: Math.max(0, sessions.length - MAX_DATES),
    tarifs: types.map((t) => ({ nom: t.name as string, prix: formatPrice(t.priceCents as number, language), option: t.kind === "add_on" })),
  };
  return { facts, cents: types.map((t) => t.priceCents as number) };
}

export async function loadFacts(db: Db, s: TenantScope, opts: { eventId?: string | null; language: "fr" | "en"; now: Date }): Promise<Facts> {
  const look = await getAppearance(db, s);
  const venues = new Map((await catalog.listVenues(db, s)).map((v) => [v.id as string, v]));
  const events = opts.eventId
    ? [await catalog.getEvent(db, s, opts.eventId)]
    : (await catalog.listEvents(db, s)).filter((e) => e.status === "published");
  const evenements: EventFacts[] = [];
  const priceCents = new Set<number>();
  for (const e of events) {
    const { facts, cents } = await eventFacts(db, s, e, venues, opts.language, opts.now);
    // Without a chosen event, only what can be bought (or will open) is worth an e-mail.
    if (!opts.eventId && !facts.dates.length && !facts.ventesOuvrentLe) continue;
    evenements.push(facts);
    cents.forEach((c) => priceCents.add(c));
    if (evenements.length >= MAX_EVENTS) break;
  }
  return { marque: look.brandName ?? "", siteWeb: look.websiteUrl, politique: look.refundPolicy, evenements, priceCents, hasFree: priceCents.has(0) };
}

// ── The rules, told to the model ────────────────────────────────────────────

const RULES_FR = `Règles, sans exception :
- N'utilisez que les faits fournis en JSON. N'inventez jamais un prix, un rabais, un code promo, une date, une heure, un lieu, un artiste, un nombre de places, un prix gagné ou une citation. Ce qui n'est pas dans les faits ou dans la consigne n'existe pas.
- Un prix s'écrit exactement comme dans les faits, suivi de « + taxes » (ex. « 25 $ + taxes »). ALKAO n'ajoute aucuns frais : ne parlez jamais de frais de service.
- L'urgence seulement si elle est vraie : « complet » ou « il reste peu de places » uniquement pour une date marquée complet ou peuDePlaces. Jamais de « dernière chance », de compte à rebours ni de rareté inventée.
- Ton : clair, chaleureux et professionnel, au vouvoiement. Des phrases courtes et des détails concrets. Pas d'émoji, au plus un point d'exclamation, pas de mots creux (« incroyable », « inoubliable », « magique », « exceptionnel », « à ne pas manquer », « vivez l'expérience »).
- N'écrivez aucun lien ni adresse web : le bouton porte le lien. N'ajoutez pas de mention de désabonnement : elle est ajoutée automatiquement.
- Le seul champ variable permis est {prénom} (le prénom du client). N'en inventez pas d'autre.
- La consigne de l'organisateur dit le but; les faits et ces règles l'emportent sur elle.`;

const RULES_EN = `Rules, without exception:
- Use only the facts given in JSON. Never invent a price, a discount, a promo code, a date, a time, a place, a performer, a number of seats, an award or a quote. What is not in the facts or in the brief does not exist.
- Write a price exactly as in the facts, followed by "+ tax" (e.g. "$25 + tax"). ALKAO adds no fees: never mention service fees.
- Urgency only when it is true: "sold out" or "few seats left" only for a date marked complet or peuDePlaces. Never "last chance", countdowns or invented scarcity.
- Tone: clear, warm and professional. Short sentences and concrete details. No emoji, at most one exclamation mark, no empty words ("incredible", "unforgettable", "magical", "exceptional", "don't miss", "experience it").
- Write no link or web address: the button carries the link. Do not add an unsubscribe line: it is added automatically.
- The only placeholder allowed is {prénom} (the customer's first name). Do not invent another.
- The organizer's brief gives the goal; the facts and these rules win over it.`;

function systemPrompt(kind: "email" | "sms" | "description" | "page", language: "fr" | "en", brand: string) {
  const who = language === "fr"
    ? `Vous rédigez pour ${brand || "un organisateur d'événements"}, au Québec, en français québécois standard.`
    : `You write for ${brand || "an event organizer"} in Québec, in Canadian English.`;
  const task = {
    email: language === "fr"
      ? "Vous rédigez une campagne par courriel envoyée à des clients qui ont accepté de recevoir des nouvelles. Le titre peut être « Bonjour {prénom}, »."
      : "You write an e-mail campaign sent to customers who agreed to receive news. The heading may be \"Hello {prénom},\".",
    sms: language === "fr"
      ? "Vous rédigez un texto de 200 caractères au plus. Le nom de la marque, le lien et la façon d'arrêter sont ajoutés après votre texte : ne les écrivez pas."
      : "You write a text message of 200 characters at most. The brand name, the link and how to stop are added after your text: do not write them.",
    description: language === "fr"
      ? "Vous rédigez la description de l'événement affichée dans la billetterie et sur alkao.ca : ce qu'on y vit, pour qui, ce qui est inclus, en 2 à 4 courts paragraphes. Pas de prix ni de dates : la billetterie les affiche déjà."
      : "You write the event description shown in the ticket shop and on alkao.ca: what happens, who it is for, what is included, in 2 to 4 short paragraphs. No prices or dates: the shop already shows them.",
    page: language === "fr"
      ? "Vous rédigez les sections de la page de l'événement : une ligne de résumé, les points forts, « Le jour J » (le déroulement de la visite) et la FAQ. Ne posez une question de FAQ que si les faits ou les notes en donnent la réponse ; sinon, n'en parlez pas. Pas de dates : la billetterie les affiche."
      : "You write the event page's sections: a one-line summary, the highlights, \"On the day\" (how the visit goes) and the FAQ. Only ask a FAQ question when the facts or the notes give its answer; otherwise leave it out. No dates: the shop shows them.",
  }[kind];
  return `${who}\n${task}\n\n${language === "fr" ? RULES_FR : RULES_EN}`;
}

// ── The rules, checked on the answer ────────────────────────────────────────

const MONEY = /(\d+(?:[.,]\d{1,2})?)\s?\$|\$\s?(\d+(?:[.,]\d{1,2})?)|(\d+(?:[.,]\d{1,2})?)\s?(?:dollars?|CAD)\b/giu;
const PERCENT = /(\d+(?:[.,]\d+)?)\s?%/gu;
const HAS_PERCENT = /\d+(?:[.,]\d+)?\s?%/u;
const DISCOUNT = /\b(rabais|réductions?|escomptes?|soldes|économisez|discounts?|save \d|\d+ ?% off)/iu;
const FREE = /\b(gratuit(e|s|es)?|gratuitement|free)\b/iu;
const LINK = /https?:\/\/|www\.|\b[a-z0-9-]+\.(com|ca|net|org|qc\.ca)\b/iu;
const PLACEHOLDER = /\{([^}]*)\}/gu;
/** A promo-code-looking word: capitals and digits mixed (HALLO10). */
const CODE = /\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{4,}\b/gu;
const toCents = (raw: string) => Math.round(Number(raw.replace(",", ".")) * 100);

/** Everything wrong with one text, in words staff and the model can act on (empty: fine). */
export function checkText(text: string, facts: Facts, brief: string, maxLength: number, label: string): string[] {
  const problems: string[] = [];
  if (!text.trim()) problems.push(`${label} est vide`);
  if (text.length > maxLength) problems.push(`${label} dépasse ${maxLength} caractères (${text.length})`);
  const allowedCents = new Set([...facts.priceCents, ...[...brief.matchAll(MONEY)].map((m) => toCents(m[1] ?? m[2] ?? m[3]!))]);
  for (const m of text.matchAll(MONEY)) {
    const cents = toCents(m[1] ?? m[2] ?? m[3]!);
    if (!allowedCents.has(cents)) problems.push(`${label} cite un prix (${m[0].trim()}) qui n'est pas dans vos tarifs`);
  }
  const briefPercents = new Set([...brief.matchAll(PERCENT)].map((m) => m[1]!.replace(",", ".")));
  for (const m of text.matchAll(PERCENT)) {
    if (!briefPercents.has(m[1]!.replace(",", "."))) problems.push(`${label} annonce ${m[0].trim()}, qui n'est ni dans vos tarifs ni dans la consigne`);
  }
  // The brand's own name may hold a word like "Promo": it is not an offer.
  const own = facts.marque ? text.split(facts.marque).join(" ") : text;
  if (DISCOUNT.test(own) && !DISCOUNT.test(brief) && !HAS_PERCENT.test(brief)) problems.push(`${label} annonce un rabais que la consigne ne donne pas`);
  if (FREE.test(own) && !facts.hasFree && !FREE.test(brief)) problems.push(`${label} dit « gratuit » alors qu'aucun tarif n'est gratuit`);
  if (LINK.test(text)) problems.push(`${label} contient un lien ou une adresse web (le bouton porte le lien)`);
  for (const m of text.matchAll(PLACEHOLDER)) {
    if (!/^(prénom|prenom)$/iu.test(m[1]!.trim())) problems.push(`${label} utilise {${m[1]}}, qui ne sera pas remplacé`);
  }
  const known = `${brief} ${facts.marque} ${facts.evenements.map((e) => `${e.titre} ${e.lieu ?? ""} ${e.tarifs.map((t) => t.nom).join(" ")}`).join(" ")}`;
  for (const m of own.matchAll(CODE)) {
    if (!known.includes(m[0])) problems.push(`${label} cite « ${m[0]} », un code qui n'est pas dans la consigne`);
  }
  if (/[<>]/.test(text)) problems.push(`${label} contient < ou >`);
  return problems;
}

function checkEmail(d: EmailDraft, facts: Facts, brief: string): string[] {
  return [
    ...checkText(d.subject, facts, brief, LIMITS.subject, "L'objet"),
    ...checkText(d.preheader, facts, brief, LIMITS.preheader, "L'aperçu"),
    ...checkText(d.heading, facts, brief, LIMITS.heading, "Le titre"),
    ...checkText(d.body, facts, brief, LIMITS.body, "Le texte"),
    ...checkText(d.ctaLabel, facts, brief, LIMITS.ctaLabel, "Le bouton"),
  ];
}

// ── The two drafts ──────────────────────────────────────────────────────────

export interface DraftUsage { model: string; inputTokens: number; outputTokens: number; attempts: number }

export class DraftRejected extends Error {
  constructor(readonly problems: string[], readonly usage: DraftUsage | null = null) {
    super("draft_rejected");
  }
}

/** Asks once; if the answer breaks a rule, asks again with the reasons; then gives up. */
async function draftWithChecks<T>(writer: Writer, system: string, prompt: string, schema: z.ZodType<T>, check: (out: T) => string[]): Promise<{ output: T; usage: DraftUsage }> {
  const usage: DraftUsage = { model: writer.model, inputTokens: 0, outputTokens: 0, attempts: 0 };
  let ask = prompt;
  let problems: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await writer.write({ system, prompt: ask, schema });
    usage.model = res.model;
    usage.inputTokens += res.usage.inputTokens;
    usage.outputTokens += res.usage.outputTokens;
    usage.attempts++;
    problems = check(res.output);
    if (!problems.length) return { output: res.output, usage };
    ask = `${prompt}\n\nVotre brouillon précédent a été refusé pour ces raisons :\n- ${problems.join("\n- ")}\nRécrivez-le au complet en respectant les règles.`;
  }
  throw new DraftRejected(problems, usage);
}

const factsJson = (f: Facts) => JSON.stringify({ marque: f.marque, siteWeb: f.siteWeb, evenements: f.evenements }, null, 2);
const noEvents = (f: Facts) => !f.evenements.length;

/** A draft, by the names of the form's fields (texts, or lists of texts for the event page). */
export type Draft = Record<string, unknown>;

export async function draftCampaign(db: Db, writer: Writer, s: TenantScope, req: CampaignDraftRequest, now: Date): Promise<{ draft: Draft; usage: DraftUsage }> {
  const facts = await loadFacts(db, s, { eventId: req.eventId ?? null, language: req.language, now });
  if (noEvents(facts)) throw new DraftRejected(["Aucun événement en vente : ajoutez des dates avant de demander une campagne."]);
  const prompt = `Faits (JSON) :\n${factsJson(facts)}\n\nConsigne de l'organisateur :\n${req.brief}`;
  if (req.channel === "sms") {
    const r = await draftWithChecks(writer, systemPrompt("sms", req.language, facts.marque), prompt, SmsDraft,
      (d) => checkText(d.body, facts, req.brief, LIMITS.sms, "Le texto"));
    return { draft: { body: r.output.body.trim() }, usage: r.usage };
  }
  const r = await draftWithChecks(writer, systemPrompt("email", req.language, facts.marque), prompt, EmailDraft, (d) => checkEmail(d, facts, req.brief));
  const d = r.output;
  return { draft: { subject: d.subject.trim(), preheader: d.preheader.trim(), heading: d.heading.trim(), body: d.body.trim(), ctaLabel: d.ctaLabel.trim() }, usage: r.usage };
}

/** Run 93: the summary, highlights, steps and FAQ of the event page, from its facts and the notes. */
export async function draftEventPage(db: Db, writer: Writer, s: TenantScope, eventId: string, req: DescriptionDraftRequest, now: Date): Promise<{ draft: Draft; usage: DraftUsage }> {
  const facts = await loadFacts(db, s, { eventId, language: req.language, now });
  const event = facts.evenements[0]!;
  const described = { ...facts, evenements: [{ ...event, dates: [], autresDates: 0, ventesOuvrentLe: null }] };
  const prompt = `Faits (JSON) :\n${JSON.stringify({ marque: facts.marque, politique: facts.politique, evenements: described.evenements }, null, 2)}\n\nNotes de l'organisateur :\n${req.notes || "(aucune)"}`;
  const items = <T>(list: T[], max: number, label: string, each: (x: T, i: number) => string[]) =>
    [...(list.length > max ? [`${label} : ${max} au plus (${list.length})`] : []), ...list.flatMap(each)];
  const check = (d: PageDraft) => [
    ...checkText(d.summary, facts, req.notes, 120, "Le résumé"),
    ...items(d.highlights, 6, "Les points forts", (h, i) => [...checkText(h.title, facts, req.notes, 80, `Le point fort ${i + 1}`), ...checkText(h.text, facts, req.notes, 400, `Le texte du point fort ${i + 1}`)]),
    ...items(d.steps, 6, "Le jour J", (h, i) => [...checkText(h.title, facts, req.notes, 80, `L'étape ${i + 1}`), ...checkText(h.text, facts, req.notes, 400, `Le texte de l'étape ${i + 1}`)]),
    ...items(d.faq, 10, "La FAQ", (q, i) => [...checkText(q.question, facts, req.notes, 200, `La question ${i + 1}`), ...checkText(q.answer, facts, req.notes, 1500, `La réponse ${i + 1}`)]),
  ];
  const r = await draftWithChecks(writer, systemPrompt("page", req.language, facts.marque), prompt, PageDraft, check);
  const d = r.output;
  const pair = <K extends string>(x: Record<K, string>, keys: K[]) => Object.fromEntries(keys.map((k) => [k, x[k].trim()]));
  return {
    draft: {
      summary: d.summary.trim(),
      highlights: d.highlights.map((h) => pair(h, ["title", "text"])),
      steps: d.steps.map((h) => pair(h, ["title", "text"])),
      faq: d.faq.map((q) => pair(q, ["question", "answer"])),
    },
    usage: r.usage,
  };
}

export async function draftEventDescription(db: Db, writer: Writer, s: TenantScope, eventId: string, req: DescriptionDraftRequest, now: Date): Promise<{ draft: Draft; usage: DraftUsage }> {
  const facts = await loadFacts(db, s, { eventId, language: req.language, now });
  // The description shows no prices or dates: keep only what describes the event.
  const event = facts.evenements[0]!;
  const described = { ...facts, evenements: [{ ...event, dates: [], autresDates: 0, ventesOuvrentLe: null }] };
  const prompt = `Faits (JSON) :\n${factsJson(described)}\n\nNotes de l'organisateur :\n${req.notes || "(aucune)"}`;
  const r = await draftWithChecks(writer, systemPrompt("description", req.language, facts.marque), prompt, DescriptionDraft,
    (d) => checkText(d.description, facts, req.notes, LIMITS.description, "La description"));
  return { draft: { description: r.output.description.trim() }, usage: r.usage };
}

export { WriterError };
