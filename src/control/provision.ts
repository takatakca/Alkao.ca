import { randomUUID } from "node:crypto";
import { z } from "zod";
import { signControlPayload } from "../api/control-signature.js";
import { CONTROL_CONTRACT_VERSION, ControlEvent } from "../contracts/control-v1.js";

/**
 * Provisioning plan: the Clients, Brands, staff and Ticketing activations ALKAO should hold.
 * `npm run control:apply` turns it into signed alkao.control.v1 events, exactly as the
 * TAKATAK publisher will, so ALKAO can be set up before (or without) that integration.
 */
const id = z.uuid();
const status = z.enum(["active", "suspended", "archived"]);
export const ProvisioningPlan = z.object({
  clients: z
    .array(
      z.object({
        clientId: id,
        name: z.string().trim().min(1).max(200),
        status: status.default("active"),
        timezone: z.string().min(1).max(64).default("America/Toronto"),
        commission: z.object({
          rateBps: z.number().int().min(0).max(10_000),
          fixedCentsPerPaidAdmission: z.number().int().min(0).max(100_000),
        }),
        brands: z
          .array(
            z.object({
              brandId: id,
              name: z.string().trim().min(1).max(200),
              status: status.default("active"),
              /** Omitted: the Brand exists in ALKAO but Ticketing stays off. */
              ticketing: z
                .object({
                  status: z.enum(["active", "inactive", "suspended"]),
                  validFrom: z.iso.datetime({ offset: true }).nullable().default(null),
                  validUntil: z.iso.datetime({ offset: true }).nullable().default(null),
                })
                .optional(),
            }),
          )
          .max(100)
          .default([]),
        members: z
          .array(
            z.object({
              /** Supabase auth user id of the staff member (same accounts as TAKATAK). */
              userId: id,
              role: z.enum(["owner", "admin", "manager", "editor", "staff", "viewer"]),
              status: z.enum(["active", "suspended", "removed"]).default("active"),
            }),
          )
          .max(1000)
          .default([]),
      }),
    )
    .min(1)
    .max(100),
});
export type ProvisioningPlan = z.infer<typeof ProvisioningPlan>;

export interface PlannedEvent {
  label: string;
  body: string;
}

/**
 * Events in dependency order: Client, its Brands, its members, then the Ticketing
 * entitlements. `version` must exceed what ALKAO holds; the CLI uses the current time in
 * ms, the same scale as a TAKATAK `updatedAt`, so a later master update always wins.
 */
export function buildProvisioningEvents(plan: ProvisioningPlan, version: number, now = new Date()): PlannedEvent[] {
  const events: PlannedEvent[] = [];
  const add = (label: string, type: string, data: Record<string, unknown>) => {
    const event = { contract: CONTROL_CONTRACT_VERSION, eventId: randomUUID(), issuedAt: now.toISOString(), type, data: { ...data, version } };
    ControlEvent.parse(event); // never send what ALKAO would refuse
    events.push({ label, body: JSON.stringify(event) });
  };
  for (const c of plan.clients) {
    add(`client ${c.name}`, "client.upserted", { clientId: c.clientId, name: c.name, status: c.status, timezone: c.timezone, commission: c.commission });
    for (const b of c.brands) {
      add(`brand ${c.name} / ${b.name}`, "brand.upserted", { clientId: c.clientId, brandId: b.brandId, name: b.name, status: b.status });
    }
    for (const m of c.members) {
      if (m.status === "removed") add(`member ${m.userId} removed`, "membership.removed", { clientId: c.clientId, userId: m.userId });
      else add(`member ${m.userId} ${m.role}`, "membership.upserted", { clientId: c.clientId, userId: m.userId, role: m.role, status: m.status });
    }
    for (const b of c.brands) {
      if (!b.ticketing) continue;
      add(`ticketing ${c.name} / ${b.name}: ${b.ticketing.status}`, "entitlement.updated", {
        clientId: c.clientId,
        brandId: b.brandId,
        status: b.ticketing.status,
        validFrom: b.ticketing.validFrom,
        validUntil: b.ticketing.validUntil,
      });
    }
  }
  return events;
}

export interface SendResult {
  label: string;
  status: number;
  outcome: string;
}

/**
 * Sign and POST one event. Network errors and 5xx are retried with the same event (same
 * eventId: ALKAO answers "duplicate" if an earlier try got through).
 */
export async function sendControlEvent(
  target: { url: string; keyId: string; secret: string },
  event: PlannedEvent,
  fetchImpl: typeof fetch = fetch,
  attempts = 4,
): Promise<SendResult> {
  let last: SendResult = { label: event.label, status: 0, outcome: "not_sent" };
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    const timestamp = Math.floor(Date.now() / 1000);
    try {
      const res = await fetchImpl(`${target.url.replace(/\/+$/, "")}/v1/control/events`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-alkao-key-id": target.keyId,
          "x-alkao-timestamp": String(timestamp),
          "x-alkao-signature": signControlPayload(target.secret, timestamp, event.body),
        },
        body: event.body,
      });
      const data = (await res.json().catch(() => ({}))) as { outcome?: string; error?: { code?: string } };
      last = { label: event.label, status: res.status, outcome: data.outcome ?? data.error?.code ?? "error" };
      if (res.status < 500) return last;
    } catch (error) {
      last = { label: event.label, status: 0, outcome: `network: ${(error as Error).message}` };
    }
  }
  return last;
}

/** Send every event in order, stopping at the first refusal (a child needs its parent). */
export async function applyProvisioning(
  target: { url: string; keyId: string; secret: string },
  events: PlannedEvent[],
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; results: SendResult[] }> {
  const results: SendResult[] = [];
  for (const event of events) {
    const r = await sendControlEvent(target, event, fetchImpl);
    results.push(r);
    if (r.status !== 200) return { ok: false, results };
  }
  return { ok: true, results };
}
