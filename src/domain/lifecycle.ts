/** State machines. The database enforces the same transitions (see the commerce migration). */

export const ORDER_STATUSES = [
  "pending_payment",
  "paid",
  "partially_refunded",
  "refunded",
  "cancelled",
  "expired",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  pending_payment: ["paid", "cancelled", "expired"],
  paid: ["partially_refunded", "refunded"],
  partially_refunded: ["refunded"],
  refunded: [],
  cancelled: [],
  expired: [],
};

export function canTransitionOrder(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

/** Status of a paid order once `refundedAfterCents` of `totalPaidCents` has been refunded. */
export function orderStatusAfterRefund(totalPaidCents: number, refundedAfterCents: number): OrderStatus {
  return refundedAfterCents >= totalPaidCents ? "refunded" : "partially_refunded";
}

export const HOLD_STATUSES = ["active", "converted", "released", "expired"] as const;
export type HoldStatus = (typeof HOLD_STATUSES)[number];

export function canTransitionHold(from: HoldStatus, to: HoldStatus): boolean {
  return from === "active" && to !== "active";
}

/** Default hold lifetime: long enough to pay, short enough not to starve inventory. */
export const DEFAULT_HOLD_TTL_SECONDS = 10 * 60;
export const MAX_HOLD_TTL_SECONDS = 30 * 60;

export function isHoldExpired(hold: { status: HoldStatus; expiresAt: Date }, now: Date): boolean {
  return hold.status === "active" && hold.expiresAt.getTime() <= now.getTime();
}

export const SESSION_STATUSES = ["draft", "on_sale", "paused", "cancelled", "closed"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const EVENT_STATUSES = ["draft", "published", "cancelled", "archived"] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export interface Availability {
  capacity: number;
  reserved: number;
  sold: number;
  available: number;
}

export function availability(session: { capacity: number; reservedCount: number; soldCount: number }): Availability {
  return {
    capacity: session.capacity,
    reserved: session.reservedCount,
    sold: session.soldCount,
    available: Math.max(0, session.capacity - session.reservedCount - session.soldCount),
  };
}

/** Whether a session can be sold to the public right now. */
export function isSessionSellable(
  event: { status: EventStatus; salesOpenAt: Date | null; salesCloseAt: Date | null },
  session: { status: SessionStatus; startsAt: Date },
  now: Date,
): boolean {
  if (event.status !== "published" || session.status !== "on_sale") return false;
  if (event.salesOpenAt && now < event.salesOpenAt) return false;
  if (event.salesCloseAt && now >= event.salesCloseAt) return false;
  return now < session.startsAt;
}
