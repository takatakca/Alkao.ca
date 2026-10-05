import { z } from "zod";

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
export const QuoteRequest = z.object({ items: CartItems });

export const CreateHoldRequest = z.object({
  sessionId: id,
  items: CartItems,
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
  addOnScope: z.enum(["per_admission"]).nullish(),
  active: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(10_000).default(0),
  /** Add-ons only: buying it allows one session change (FESTI-ICE Flex Météo). */
  grantsSessionChange: z.boolean().default(false),
};
export const CreateTicketType = z
  .object(ticketTypeFields)
  .refine((t) => t.minQuantity <= t.maxQuantity, { message: "minQuantity must not exceed maxQuantity" })
  .refine((t) => (t.kind === "add_on") === Boolean(t.addOnScope), { message: "add-ons need addOnScope; admissions must not have one" })
  .refine((t) => !t.grantsSessionChange || t.kind === "add_on", { message: "only add-ons can grant a session change" });
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
});

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
