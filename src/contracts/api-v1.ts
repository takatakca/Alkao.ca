import { z } from "zod";
import { BOOKING_CATEGORIES, CUSTOMER_SEGMENTS, CUSTOMER_STATUSES } from "../domain/customers.js";

/**
 * ALKAO API v1 request contracts. Unknown keys are stripped: a client can never send a
 * price, a status it is not allowed to set, or a tenant id in a body.
 */

const id = z.uuid();
const quantity = z.number().int().min(0).max(1000);
const slug = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(80);
const name = z.string().trim().min(1).max(200);
const text = z.string().max(5000);
const timestamp = z.iso.datetime({ offset: true });
const cents = z.number().int().min(0).max(10_000_000);

export const CartItems = z
  .array(z.object({ ticketTypeId: id, quantity }))
  .min(1)
  .max(50);

// ── Public (buyer-facing) ───────────────────────────────────────────────────
/** Run 36: an optional promo code, as the buyer typed it (case and spaces do not matter). */
const promoCode = z.string().trim().min(1).max(40).optional();

export const QuoteRequest = z.object({ items: CartItems, promoCode });

export const CreateHoldRequest = z.object({
  sessionId: id,
  items: CartItems,
  promoCode,
});

// ── Admin: catalog ──────────────────────────────────────────────────────────
export const CreateVenue = z.object({
  name,
  addressLine1: z.string().max(200).nullish(),
  city: z.string().max(100).nullish(),
  region: z.string().max(100).nullish(),
  postalCode: z.string().max(20).nullish(),
  country: z.string().regex(/^[A-Z]{2}$/).default("CA"),
  timezone: z.string().min(1).max(64).default("America/Toronto"),
  taxRegion: z.enum(["CA-QC"]).default("CA-QC"),
});
export const UpdateVenue = CreateVenue.partial().refine((o) => Object.keys(o).length > 0, "empty update");

const admissionMinutes = z.number().int().min(0).max(1440);

export const CreateEvent = z
  .object({
    venueId: id,
    slug,
    title: name,
    description: text.nullish(),
    salesOpenAt: timestamp.nullish(),
    salesCloseAt: timestamp.nullish(),
    /** Gates open this many minutes before each session starts (default 60). */
    admissionOpensBeforeMinutes: admissionMinutes.optional(),
    /** Gates close this many minutes after each session ends, or starts if it has no end (default 120). */
    admissionClosesAfterMinutes: admissionMinutes.optional(),
  })
  .refine((e) => !e.salesOpenAt || !e.salesCloseAt || Date.parse(e.salesOpenAt) < Date.parse(e.salesCloseAt), {
    message: "salesOpenAt must be before salesCloseAt",
  });
export const UpdateEvent = z
  .object({
    title: name,
    description: text.nullable(),
    status: z.enum(["draft", "published", "cancelled", "archived"]),
    salesOpenAt: timestamp.nullable(),
    salesCloseAt: timestamp.nullable(),
    admissionOpensBeforeMinutes: admissionMinutes,
    admissionClosesAfterMinutes: admissionMinutes,
  })
  .partial()
  .refine((o) => Object.keys(o).length > 0, "empty update");

export const CreateSession = z
  .object({
    startsAt: timestamp,
    endsAt: timestamp.nullish(),
    capacity: z.number().int().min(0).max(1_000_000),
  })
  .refine((s) => !s.endsAt || Date.parse(s.startsAt) < Date.parse(s.endsAt), { message: "endsAt must be after startsAt" });
export const UpdateSession = z
  .object({
    capacity: z.number().int().min(0).max(1_000_000),
    status: z.enum(["draft", "on_sale", "paused", "cancelled", "closed"]),
    endsAt: timestamp.nullable(),
  })
  .partial()
  .refine((o) => Object.keys(o).length > 0, "empty update");

const ticketTypeFields = {
  code: z.string().regex(/^[A-Z0-9_]{1,40}$/),
  name,
  description: text.nullish(),
  kind: z.enum(["admission", "add_on"]).default("admission"),
  priceCents: cents,
  minQuantity: z.number().int().min(0).max(1000).default(0),
  maxQuantity: z.number().int().min(1).max(1000),
  maxAdultsInOrder: z.number().int().min(0).max(1000).nullish(),
  countsAsAdult: z.boolean().default(false),
  /** Run 49: per_admission (one each), up_to_admissions (1 to the number of people), per_order (any quantity). */
  addOnScope: z.enum(["per_admission", "up_to_admissions", "per_order"]).nullish(),
  /** Run 49, add-ons only: how many can be sold per session (per evening); null = no limit. */
  stockPerSession: z.number().int().min(0).max(100_000).nullish(),
  active: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(10_000).default(0),
  /** Add-ons only: buying it allows one session change (a weather or flex option). */
  grantsSessionChange: z.boolean().default(false),
  /** Run 37, admissions only: "billet ouvert", its order can change session as often as needed. */
  openDate: z.boolean().default(false),
};
export const CreateTicketType = z
  .object(ticketTypeFields)
  .refine((t) => t.minQuantity <= t.maxQuantity, { message: "minQuantity must not exceed maxQuantity" })
  .refine((t) => (t.kind === "add_on") === Boolean(t.addOnScope), { message: "add-ons need addOnScope; admissions must not have one" })
  .refine((t) => !t.grantsSessionChange || t.kind === "add_on", { message: "only add-ons can grant a session change" })
  .refine((t) => !t.openDate || t.kind === "admission", { message: "only admissions can be open-date" })
  .refine((t) => t.stockPerSession == null || t.kind === "add_on", { message: "only add-ons have a stock" });
export const UpdateTicketType = z
  .object({
    name,
    description: text.nullable(),
    priceCents: cents,
    minQuantity: ticketTypeFields.minQuantity,
    maxQuantity: ticketTypeFields.maxQuantity,
    maxAdultsInOrder: z.number().int().min(0).max(1000).nullable(),
    active: z.boolean(),
    sortOrder: z.number().int().min(0).max(10_000),
    openDate: z.boolean(),
    stockPerSession: z.number().int().min(0).max(100_000).nullable(),
  })
  .partial()
  .refine((o) => Object.keys(o).length > 0, "empty update");

export const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: timestamp.optional(),
});

// ── Run 02: payments ────────────────────────────────────────────────────────
const httpsUrl = z.url({ protocol: /^https$/ }).max(2000);

export const CheckoutRequest = z.object({
  buyer: z.object({
    email: z.email().max(320),
    fullName: z.string().trim().min(1).max(200).nullish(),
    phone: z.string().trim().max(40).nullish(),
    /** Language of the buyer's emails (Run 16). */
    language: z.enum(["fr", "en"]).default("fr"),
  }),
  /** Must use an origin listed in the Brand's checkout settings. */
  successUrl: httpsUrl,
  cancelUrl: httpsUrl,
  /** Run 49: where the buyer came from (the website keeps the ad's UTM tags until checkout). */
  attribution: z.lazy(() => Attribution).nullish(),
});

const tag = z.string().trim().min(1).max(100).regex(/^[^<>\u0000-\u001f]*$/);
/** Run 49: UTM tags and the landing page path. Unknown keys are dropped, never stored. */
export const Attribution = z
  .object({
    source: tag.optional(),
    medium: tag.optional(),
    campaign: tag.optional(),
    content: tag.optional(),
    term: tag.optional(),
    landing: z.string().trim().min(1).max(200).regex(/^\/[^\s<>]*$/).optional(),
  })
  .strip()
  .transform((a) => (Object.keys(a).length ? a : null));

export const CheckoutSettings = z.object({
  checkoutReturnOrigins: z
    .array(z.string().regex(/^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:[0-9]{1,5})?$/))
    .max(10),
});

export const RefundRequest = z.object({
  /** Omitted: refund everything still refundable (and void every valid ticket). */
  amountCents: z.number().int().min(1).max(100_000_000).optional(),
  /** Tickets to void with a partial refund (their seats return to inventory). */
  ticketIds: z.array(z.uuid()).max(1000).optional(),
  reason: z.string().trim().max(500).nullish(),
});

// ── Run 03: credentials and scanning ────────────────────────────────────────
const payload = z.string().trim().min(1).max(400);
const deviceId = z.string().trim().min(1).max(100);

export const ScanRequest = z.object({
  sessionId: z.uuid(),
  payload,
  deviceId: deviceId.nullish(),
});

/** Run 22: find an order's tickets at the gate by its reference (e.g. "K7PM-2QXA"). */
export const GateLookupQuery = z.object({
  reference: z.string().trim().min(4).max(20),
});

/** Run 22: admit a ticket found by reference, without its QR code. */
export const ManualAdmitRequest = z.object({
  sessionId: z.uuid(),
  ticketId: z.uuid(),
  deviceId: deviceId.nullish(),
});

export const ScanBatchRequest = z.object({
  sessionId: z.uuid(),
  deviceId,
  scans: z
    .array(z.object({ payload, scannedAt: z.iso.datetime({ offset: true }) }))
    .min(1)
    .max(500),
});

// ── Run 04: operations ──────────────────────────────────────────────────────
export const ReportQuery = z
  .object({
    eventId: z.uuid().optional(),
    from: timestamp.optional(),
    to: timestamp.optional(),
  })
  .refine((q) => !q.from || !q.to || Date.parse(q.from) < Date.parse(q.to), { message: "from must be before to" });

export const AttendeesQuery = z.object({ sessionId: z.uuid() });

export const ExchangeRequest = z.object({ sessionId: z.uuid() });

// ── Run 10: session cancellation ────────────────────────────────────────────
export const CancelSessionRequest = z.object({ reason: z.string().trim().max(500).nullish() });

// ── Run 14: order search ────────────────────────────────────────────────────
export const OrdersQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.iso.datetime({ offset: true }).optional(),
  /** Reference prefix, email prefix or part of the buyer's name. */
  q: z.string().trim().min(2).max(120).optional(),
});

// ── Run 28: duplicate an event ─────────────────────────────────────────────
export const DuplicateEventRequest = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  /** Copy the sessions and the sales window, moved by this many days. Absent or null: neither is copied. */
  shiftDays: z.number().int().min(-3660).max(3660).nullish(),
});

// ── Run 30: the audit journal ───────────────────────────────────────────────
export const AuditQuery = ListQuery.extend({
  /**
   * The id of the last entry already shown: the next page starts right after it. Unlike
   * `before`, entries written in the same instant (one transaction) are never skipped.
   */
  beforeId: z.coerce.number().int().positive().optional(),
  /** An action ("order.paid") or a family of actions ("order", "refund"…). */
  action: z.string().regex(/^[a-z_]+(\.[a-z_]+)*$/).max(80).optional(),
  entityType: z.string().regex(/^[a-z_]+$/).max(40).optional(),
  entityId: z.string().min(1).max(100).optional(),
});

// ── Run 36: promo codes ─────────────────────────────────────────────────────
const promoWindow = {
  startsAt: timestamp.nullish(),
  endsAt: timestamp.nullish(),
  maxUses: z.number().int().min(1).max(1_000_000).nullish(),
};
export const CreatePromoCode = z
  .object({
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{3,32}$/),
    kind: z.enum(["percent", "amount"]),
    percent: z.number().int().min(1).max(100).nullish(),
    amountCents: z.number().int().min(1).max(10_000_000).nullish(),
    ...promoWindow,
  })
  .refine((p) => (p.kind === "percent" ? p.percent != null && p.amountCents == null : p.amountCents != null && p.percent == null), {
    message: "percent for kind percent, amountCents for kind amount", path: ["kind"],
  })
  .refine((p) => !p.startsAt || !p.endsAt || Date.parse(p.startsAt) < Date.parse(p.endsAt), { message: "endsAt must be after startsAt", path: ["endsAt"] });
export const UpdatePromoCode = z
  .object({ active: z.boolean(), ...promoWindow })
  .partial()
  .refine((o) => Object.keys(o).length > 0, "empty update");

// ── Run 29: sessions in bulk ────────────────────────────────────────────────
const localDate = z.iso.date();
const localTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const minutesOf = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
/**
 * Every day from `fromDate` to `toDate` (on `weekdays` only, ISO 1 = Monday … 7 = Sunday),
 * one session at `firstStart`, then every `everyMinutes` up to `lastStart`, in the venue's
 * time zone. Start times already taken for the event are skipped.
 */
export const SessionBatchRequest = z
  .object({
    fromDate: localDate,
    toDate: localDate,
    weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(),
    firstStart: localTime,
    lastStart: localTime.optional(),
    everyMinutes: z.number().int().min(5).max(720).optional(),
    durationMinutes: z.number().int().min(1).max(1440).nullish(),
    capacity: z.number().int().min(0).max(1_000_000),
    status: z.enum(["draft", "on_sale"]).default("draft"),
    /** Only list what would be created. */
    dryRun: z.boolean().default(false),
  })
  .refine((b) => b.fromDate <= b.toDate, { message: "toDate must not be before fromDate", path: ["toDate"] })
  .refine((b) => Date.parse(b.toDate) - Date.parse(b.fromDate) <= 366 * 86_400_000, { message: "at most 367 days", path: ["toDate"] })
  .refine((b) => !b.lastStart || minutesOf(b.lastStart) >= minutesOf(b.firstStart), { message: "lastStart must not be before firstStart", path: ["lastStart"] })
  .refine((b) => !b.lastStart || b.lastStart === b.firstStart || b.everyMinutes !== undefined, { message: "everyMinutes is required with lastStart", path: ["everyMinutes"] });

/** Put a whole event's upcoming sessions on sale, or pause them, at once. */
export const SessionStatusBatchRequest = z
  .object({
    from: z.enum(["draft", "on_sale", "paused"]),
    to: z.enum(["on_sale", "paused"]),
  })
  .refine((b) => b.from !== b.to, { message: "from and to must differ", path: ["to"] });

// ── Run 27: "Retrouver mes billets" ─────────────────────────────────────────
export const FindTicketsRequest = z.object({ email: z.string().trim().max(320).pipe(z.email()) });

// ── Run 23: reminder email before the session ──────────────────────────────
export const ReminderSettings = z.object({ enabled: z.boolean() });

// ── Run 21: cancel tickets without a refund ────────────────────────────────
export const VoidTicketsRequest = z.object({
  ticketIds: z.array(z.uuid()).min(1).max(1000),
  reason: z.string().trim().max(500).nullish(),
});

// ── Run 19: disputes ────────────────────────────────────────────────────────
export const DisputesQuery = z.object({
  /** "open" (default): disputes still waiting on the Client or the bank; "all": closed ones too. */
  status: z.enum(["open", "all"]).default("open"),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

// ── Run 41: the customer file (CRM) ─────────────────────────────────────────
const optionalText = (max: number) => z.string().max(max).nullish();
const isoDate = z.iso.date();
const source = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/).default("reservation_camping");
const headcount = z.number().int().min(0).max(500).default(0);
/**
 * One booking and the customer named on it. Only these fields exist: anything else a report
 * carries (comments, plates, payment details) is dropped before it is stored.
 */
export const CustomerImportRow = z
  .object({
    sourceRef: z.string().trim().min(1).max(80),
    item: optionalText(80),
    startsOn: isoDate,
    endsOn: isoDate,
    adults: headcount,
    children: headcount,
    pets: z.number().int().min(0).max(100).default(0),
    groupBooking: z.boolean().default(false),
    checkedIn: z.boolean().default(false),
    totalCents: z.number().int().min(0).max(100_000_000).default(0),
    firstName: optionalText(120),
    lastName: optionalText(120),
    companionName: optionalText(200),
    email: optionalText(320),
    mobilePhone: optionalText(40),
    homePhone: optionalText(40),
    workPhone: optionalText(40),
    addressLine: optionalText(200),
    addressUnit: optionalText(40),
    city: optionalText(120),
    region: optionalText(60),
    postalCode: optionalText(20),
    country: optionalText(60),
  })
  .refine((r) => r.startsOn <= r.endsOn, { message: "endsOn must not be before startsOn", path: ["endsOn"] });
export const CustomerImportRequest = z.object({
  source,
  /** The day the report was produced: a newer report's details win over an older one's. */
  reportDate: isoDate,
  rows: z.array(CustomerImportRow).min(1).max(400),
});
/** Every batch of the report is in: bookings it no longer lists are taken for cancelled. */
export const CustomerImportComplete = z.object({ source, reportDate: isoDate });
const customerFilters = {
  segment: z.enum(CUSTOMER_SEGMENTS).optional(),
  status: z.enum(CUSTOMER_STATUSES).optional(),
  q: z.string().trim().min(2).max(120).optional(),
  /** Only customers who may receive marketing e-mail (express or implied consent). */
  emailable: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
};
export const CustomersQuery = z.object({
  ...customerFilters,
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
export const CustomersExportQuery = z.object(customerFilters);
export const UpdateCustomer = z
  .object({ emailConsent: z.boolean(), emailOptOut: z.boolean(), smsOptOut: z.boolean() })
  .partial()
  .refine((o) => Object.keys(o).length > 0, "empty update");

// ── Run 42: e-mail campaigns ────────────────────────────────────────────────
const campaignUrl = z.url({ protocol: /^https$/ }).max(500);
export const CampaignAudience = z.object({
  segments: z.array(z.enum(CUSTOMER_SEGMENTS)).max(CUSTOMER_SEGMENTS.length).default([]),
  statuses: z.array(z.enum(CUSTOMER_STATUSES)).max(CUSTOMER_STATUSES.length).default([]),
  /** Run 45, automations only: the visits that start it (empty: all). */
  categories: z.array(z.enum(BOOKING_CATEGORIES)).max(BOOKING_CATEGORIES.length).default([]),
});
export const CampaignInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    language: z.enum(["fr", "en"]).default("fr"),
    /** Run 46: e-mail, or a text message (body only, at most 300 characters before the footer). */
    channel: z.enum(["email", "sms"]).default("email"),
    subject: z.string().trim().min(1).max(150).nullish(),
    preheader: z.string().trim().max(150).nullish(),
    heading: z.string().trim().min(1).max(150).nullish(),
    body: z.string().trim().min(1).max(10_000),
    imageUrl: campaignUrl.nullish(),
    ctaLabel: z.string().trim().min(1).max(60).nullish(),
    ctaUrl: campaignUrl.nullish(),
    audience: CampaignAudience,
    /** Run 45: sent once by staff, or automatic after each visit. */
    kind: z.enum(["one_time", "after_visit"]).default("one_time"),
    delayDays: z.number().int().min(0).max(60).nullish(),
  })
  .refine((c) => c.channel === "sms" || (c.ctaLabel == null) === (c.ctaUrl == null), { message: "ctaLabel and ctaUrl go together", path: ["ctaUrl"] })
  .refine((c) => c.kind === "one_time" || c.delayDays != null, { message: "delayDays is required after a visit", path: ["delayDays"] })
  .refine((c) => c.channel === "sms" || (c.subject != null && c.heading != null), { message: "an e-mail needs a subject and a heading", path: ["subject"] })
  .refine((c) => c.channel === "email" || (c.body.length <= 300 && c.kind === "one_time"), { message: "a text is one-time and at most 300 characters", path: ["body"] })
  .transform((c) => ({ ...c, subject: c.subject ?? c.name, heading: c.heading ?? c.name }));
export const CampaignAutomation = z.object({ active: z.boolean() });
/** A test to a staff e-mail address, or (Run 46, a text) to a staff mobile number. */
export const CampaignTest = z
  .object({ email: z.string().trim().max(320).pipe(z.email()).optional(), phone: z.string().trim().max(40).optional() })
  .refine((t) => Boolean(t.email) !== Boolean(t.phone), { message: "email or phone", path: ["email"] });
export const CampaignAudienceQuery = CampaignAudience.extend({ channel: z.enum(["email", "sms"]).default("email") });
/** The number of recipients staff were shown: sending is refused if it changed since. */
export const CampaignSend = z.object({ expectedRecipients: z.number().int().min(1).max(10_000_000) });
export const MarketingSettings = z.object({
  /** Canada's anti-spam law: a valid mailing address of the sender. */
  senderAddress: z.string().trim().min(5).max(300),
  /** And a way to reach them: an e-mail address, a phone number or a web page. */
  contact: z.string().trim().min(3).max(200),
});

// ── Run 44: newsletter sign-up (double opt-in) ──────────────────────────────
/** From a website's sign-up form: the person then confirms by e-mail. */
export const NewsletterSignup = z.object({
  email: z.string().trim().max(320).pipe(z.email()),
  firstName: z.string().trim().max(120).nullish(),
  language: z.enum(["fr", "en"]).default("fr"),
  /** Where it came from, e.g. the storefront's short name. */
  source: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_.-]{0,59}$/).nullish(),
});
export const NewsletterSettings = z.object({
  rewardCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{3,32}$/).nullable(),
  rewardText: z.string().trim().min(1).max(200).nullable(),
});
