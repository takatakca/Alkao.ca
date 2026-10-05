import { z } from "zod";

/**
 * alkao.control.v1 — TAKATAK (master control plane) → ALKAO.
 *
 * TAKATAK pushes the master records ALKAO needs, each carrying the master's monotonic
 * `version` for that subject. ALKAO applies an event only if its version is newer than the
 * stored one, so redelivery and reordering are harmless. Delivery is authenticated with
 * HMAC-SHA256 (see docs/ALKAO_CONTROL_CONTRACT_V1.md).
 */
export const CONTROL_CONTRACT_VERSION = "alkao.control.v1";

const masterId = z.uuid();
const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const masterStatus = z.enum(["active", "suspended", "archived"]);

export const ClientUpserted = z.object({
  type: z.literal("client.upserted"),
  data: z.object({
    clientId: masterId,
    name: z.string().trim().min(1).max(200),
    status: masterStatus,
    timezone: z.string().min(1).max(64).default("America/Toronto"),
    commission: z.object({
      rateBps: z.number().int().min(0).max(10_000),
      fixedCentsPerPaidAdmission: z.number().int().min(0).max(100_000),
    }),
    version,
  }),
});

export const BrandUpserted = z.object({
  type: z.literal("brand.upserted"),
  data: z.object({
    clientId: masterId,
    brandId: masterId,
    name: z.string().trim().min(1).max(200),
    status: masterStatus,
    version,
  }),
});

export const MembershipUpserted = z.object({
  type: z.literal("membership.upserted"),
  data: z.object({
    clientId: masterId,
    /** Supabase auth user id (auth.uid()). */
    userId: masterId,
    role: z.enum(["owner", "admin", "manager", "editor", "staff", "viewer"]),
    status: z.enum(["active", "suspended"]),
    version,
  }),
});

/** Removal is stored as a suspended membership, so an older upsert can never resurrect it. */
export const MembershipRemoved = z.object({
  type: z.literal("membership.removed"),
  data: z.object({ clientId: masterId, userId: masterId, version }),
});

export const EntitlementUpdated = z.object({
  type: z.literal("entitlement.updated"),
  data: z
    .object({
      clientId: masterId,
      brandId: masterId,
      status: z.enum(["active", "inactive", "suspended"]),
      validFrom: z.iso.datetime({ offset: true }).nullable().default(null),
      validUntil: z.iso.datetime({ offset: true }).nullable().default(null),
      version,
    })
    .refine((d) => !d.validFrom || !d.validUntil || Date.parse(d.validFrom) < Date.parse(d.validUntil), {
      message: "validFrom must be before validUntil",
    }),
});

export const ControlEvent = z
  .discriminatedUnion("type", [ClientUpserted, BrandUpserted, MembershipUpserted, MembershipRemoved, EntitlementUpdated])
  .and(
    z.object({
      contract: z.literal(CONTROL_CONTRACT_VERSION),
      eventId: z.uuid(),
      issuedAt: z.iso.datetime({ offset: true }),
    }),
  );

export type ControlEvent = z.infer<typeof ControlEvent>;
