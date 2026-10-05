/**
 * The Ticketing gate. ALKAO is disabled by default: an operational route may act for a
 * (Client, Brand) only when every condition below holds. Hiding a menu is never a control.
 *
 *   1. The deployment switch ALKAO_OPERATIONAL_API_ENABLED is on.
 *   2. The Client and Brand exist locally (projected from the TAKATAK control contract),
 *      the Brand belongs to the Client, and both are active.
 *   3. An entitlement from the TAKATAK control contract exists for that exact pair, is
 *      active, and is inside its validity window.
 */

export type MasterStatus = "active" | "suspended" | "archived";
export type EntitlementStatus = "active" | "inactive" | "suspended";

export interface GateInput {
  operationalApiEnabled: boolean;
  client: { id: string; status: MasterStatus } | null;
  brand: { id: string; clientId: string; status: MasterStatus } | null;
  entitlement: { status: EntitlementStatus; validFrom: Date | null; validUntil: Date | null } | null;
  now: Date;
}

export type GateDenialReason =
  | "operational_api_disabled"
  | "unknown_client"
  | "unknown_brand"
  | "brand_client_mismatch"
  | "client_inactive"
  | "brand_inactive"
  | "no_entitlement"
  | "entitlement_inactive"
  | "entitlement_not_yet_valid"
  | "entitlement_expired";

export type GateDecision = { active: true } | { active: false; reason: GateDenialReason };

export function evaluateTicketingGate(input: GateInput): GateDecision {
  const deny = (reason: GateDenialReason): GateDecision => ({ active: false, reason });
  if (!input.operationalApiEnabled) return deny("operational_api_disabled");
  if (!input.client) return deny("unknown_client");
  if (!input.brand) return deny("unknown_brand");
  if (input.brand.clientId !== input.client.id) return deny("brand_client_mismatch");
  if (input.client.status !== "active") return deny("client_inactive");
  if (input.brand.status !== "active") return deny("brand_inactive");
  const e = input.entitlement;
  if (!e) return deny("no_entitlement");
  if (e.status !== "active") return deny("entitlement_inactive");
  if (e.validFrom && input.now < e.validFrom) return deny("entitlement_not_yet_valid");
  if (e.validUntil && input.now >= e.validUntil) return deny("entitlement_expired");
  return { active: true };
}
