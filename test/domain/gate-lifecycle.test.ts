import { describe, expect, it } from "vitest";
import {
  availability,
  canTransitionHold,
  canTransitionOrder,
  evaluateTicketingGate,
  isHoldExpired,
  isSessionSellable,
  isUuid,
  newOrderReference,
  ORDER_REFERENCE_RE,
  orderStatusAfterRefund,
  roleHasPermission,
  type GateInput,
} from "../../src/domain/index.js";

const now = new Date("2026-12-20T18:00:00Z");
const open: GateInput = {
  operationalApiEnabled: true,
  client: { id: "c1", status: "active" },
  brand: { id: "b1", clientId: "c1", status: "active" },
  entitlement: { status: "active", validFrom: null, validUntil: null },
  now,
};

describe("evaluateTicketingGate — disabled by default", () => {
  it("is active only when every condition holds", () => {
    expect(evaluateTicketingGate(open)).toEqual({ active: true });
  });

  it.each([
    ["operational_api_disabled", { operationalApiEnabled: false }],
    ["unknown_client", { client: null }],
    ["unknown_brand", { brand: null }],
    ["brand_client_mismatch", { brand: { id: "b1", clientId: "other", status: "active" } }],
    ["client_inactive", { client: { id: "c1", status: "suspended" } }],
    ["brand_inactive", { brand: { id: "b1", clientId: "c1", status: "archived" } }],
    ["no_entitlement", { entitlement: null }],
    ["entitlement_inactive", { entitlement: { status: "inactive", validFrom: null, validUntil: null } }],
    ["entitlement_inactive", { entitlement: { status: "suspended", validFrom: null, validUntil: null } }],
    ["entitlement_not_yet_valid", { entitlement: { status: "active", validFrom: new Date("2027-01-01Z"), validUntil: null } }],
    ["entitlement_expired", { entitlement: { status: "active", validFrom: null, validUntil: now } }],
  ] as const)("denies with %s", (reason, patch) => {
    expect(evaluateTicketingGate({ ...open, ...patch } as GateInput)).toEqual({ active: false, reason });
  });
});

describe("state machines", () => {
  it("orders move forward only", () => {
    expect(canTransitionOrder("pending_payment", "paid")).toBe(true);
    expect(canTransitionOrder("paid", "partially_refunded")).toBe(true);
    expect(canTransitionOrder("partially_refunded", "refunded")).toBe(true);
    expect(canTransitionOrder("paid", "pending_payment")).toBe(false);
    expect(canTransitionOrder("refunded", "paid")).toBe(false);
    expect(canTransitionOrder("cancelled", "paid")).toBe(false);
    expect(orderStatusAfterRefund(100, 40)).toBe("partially_refunded");
    expect(orderStatusAfterRefund(100, 100)).toBe("refunded");
  });

  it("holds close once", () => {
    expect(canTransitionHold("active", "converted")).toBe(true);
    expect(canTransitionHold("expired", "active")).toBe(false);
    expect(canTransitionHold("released", "converted")).toBe(false);
    expect(isHoldExpired({ status: "active", expiresAt: now }, now)).toBe(true);
    expect(isHoldExpired({ status: "converted", expiresAt: now }, now)).toBe(false);
  });

  it("computes availability and sellability", () => {
    expect(availability({ capacity: 10, reservedCount: 3, soldCount: 5 }).available).toBe(2);
    const event = { status: "published" as const, salesOpenAt: null, salesCloseAt: null };
    const session = { status: "on_sale" as const, startsAt: new Date("2026-12-20T22:00:00Z") };
    expect(isSessionSellable(event, session, now)).toBe(true);
    expect(isSessionSellable({ ...event, status: "draft" }, session, now)).toBe(false);
    expect(isSessionSellable(event, { ...session, status: "paused" }, now)).toBe(false);
    expect(isSessionSellable(event, { ...session, startsAt: now }, now)).toBe(false);
    expect(isSessionSellable({ ...event, salesCloseAt: now }, session, now)).toBe(false);
  });
});

describe("permissions and ids", () => {
  it("limits buyer data to owner, admin, manager", () => {
    expect(roleHasPermission("manager", "ticketing.buyers.read")).toBe(true);
    expect(roleHasPermission("editor", "ticketing.buyers.read")).toBe(false);
    expect(roleHasPermission("staff", "ticketing.catalog.write")).toBe(false);
    expect(roleHasPermission("editor", "ticketing.catalog.write")).toBe(true);
    expect(roleHasPermission("manager", "ticketing.audit.read")).toBe(false);
  });

  it("validates master UUIDs and generates readable references", () => {
    expect(isUuid("0b7e3c1a-2f4d-4c8e-9a1b-3c5d7e9f1a2b")).toBe(true);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid(42)).toBe(false);
    for (let i = 0; i < 200; i++) expect(newOrderReference()).toMatch(ORDER_REFERENCE_RE);
  });
});
