import { randomUUID } from "node:crypto";
import { createHold, createOrderFromHold, recordOrderPaid } from "../../src/db/commerce.js";
import { withTransaction, type Db } from "../../src/db/pool.js";
import { buildQuote, computeCommission } from "../../src/domain/index.js";
import type { TicketTypeRule } from "../../src/domain/catalog.js";
import { FESTI_ICE_TYPES } from "../fixtures/festi-ice.js";

export interface TenantFixture {
  clientId: string;
  brandId: string;
  venueId: string;
  eventId: string;
  sessionId: string;
  types: TicketTypeRule[];
  holdId: string;
  orderId: string;
  buyerId: string;
  ticketIds: string[];
}

export interface SeedResult {
  havana: TenantFixture;
  festi: TenantFixture;
  users: {
    havanaOwner: string;
    havanaStaff: string;
    festiOwner: string;
    /** Manager at FESTI-ICE and viewer at Havana: two memberships, one person. */
    both: string;
    suspended: string;
    stranger: string;
  };
}

/** Two separate TAKATAK Clients with a full paid order each, plus a cast of users. */
export async function seedTwoTenants(db: Db): Promise<SeedResult> {
  const users = {
    havanaOwner: randomUUID(),
    havanaStaff: randomUUID(),
    festiOwner: randomUUID(),
    both: randomUUID(),
    suspended: randomUUID(),
    stranger: randomUUID(),
  };
  const havana = await seedTenant(db, "Havana Resort", "Havana Resort — Événements", 1500);
  const festi = await seedTenant(db, "FESTI-ICE", "FESTI-ICE", 300);

  await db.query(
    `INSERT INTO public.ticketing_memberships (client_id, user_id, role, status) VALUES
       ($1, $3, 'owner', 'active'),
       ($1, $4, 'staff', 'active'),
       ($2, $5, 'owner', 'active'),
       ($2, $6, 'manager', 'active'),
       ($1, $6, 'viewer', 'active'),
       ($1, $7, 'owner', 'suspended')`,
    [havana.clientId, festi.clientId, users.havanaOwner, users.havanaStaff, users.festiOwner, users.both, users.suspended],
  );
  return { havana, festi, users };
}

export async function seedTenant(db: Db, clientName: string, brandName: string, capacity: number): Promise<TenantFixture> {
  const clientId = randomUUID();
  const brandId = randomUUID();
  return withTransaction(db, async (tx) => {
    await tx.query(
      `INSERT INTO public.ticketing_clients (id, name, commission_rate_bps, commission_fixed_cents) VALUES ($1, $2, 500, 50)`,
      [clientId, clientName],
    );
    await tx.query(`INSERT INTO public.ticketing_brands (id, client_id, name) VALUES ($1, $2, $3)`, [brandId, clientId, brandName]);
    await tx.query(
      `INSERT INTO public.ticketing_entitlements (client_id, brand_id, status, contract_version) VALUES ($1, $2, 'active', 'alkao.control.v1')`,
      [clientId, brandId],
    );
    const { rows: venue } = await tx.query<{ id: string }>(
      `INSERT INTO public.ticketing_venues (client_id, brand_id, name, city) VALUES ($1, $2, 'Havana Resort', 'Maricourt') RETURNING id`,
      [clientId, brandId],
    );
    const venueId = venue[0]!.id;
    const { rows: event } = await tx.query<{ id: string }>(
      `INSERT INTO public.ticketing_events (client_id, brand_id, venue_id, slug, title, status)
       VALUES ($1, $2, $3, 'saison-2026-2027', $4, 'published') RETURNING id`,
      [clientId, brandId, venueId, `${brandName} 2026-2027`],
    );
    const eventId = event[0]!.id;
    const { rows: session } = await tx.query<{ id: string }>(
      `INSERT INTO public.ticketing_sessions (client_id, brand_id, event_id, starts_at, capacity, status)
       VALUES ($1, $2, $3, now() + interval '30 days', $4, 'on_sale') RETURNING id`,
      [clientId, brandId, eventId, capacity],
    );
    const sessionId = session[0]!.id;

    const types: TicketTypeRule[] = [];
    for (const [i, t] of FESTI_ICE_TYPES.entries()) {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO public.ticketing_ticket_types
           (client_id, brand_id, event_id, code, name, kind, price_cents, min_quantity, max_quantity,
            max_adults_in_order, counts_as_adult, add_on_scope, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
        [
          clientId, brandId, eventId, t.code, t.name, t.kind, t.priceCents, t.minQuantity, t.maxQuantity,
          t.maxAdultsInOrder, t.countsAsAdult, t.addOnScope, i,
        ],
      );
      types.push({ ...t, id: rows[0]!.id });
    }
    return { clientId, brandId, venueId, eventId, sessionId, types, holdId: "", orderId: "", buyerId: "", ticketIds: [] };
  }).then(async (base) => ({ ...base, ...(await seedPaidOrder(db, base)) }));
}

/** GENERAL ×2 + CHILD ×2 + FLEX ×4, held, ordered and paid. */
export async function seedPaidOrder(
  db: Db,
  t: Pick<TenantFixture, "clientId" | "brandId" | "eventId" | "sessionId" | "types">,
  email = `buyer-${randomUUID().slice(0, 8)}@example.com`,
) {
  const id = (code: string) => t.types.find((x) => x.code === code)!.id;
  const result = buildQuote(
    t.types,
    [
      { ticketTypeId: id("GENERAL"), quantity: 2 },
      { ticketTypeId: id("CHILD"), quantity: 2 },
      { ticketTypeId: id("FLEX_WEATHER"), quantity: 4 },
    ],
    "CA-QC",
  );
  if (!result.ok) throw new Error("seed quote invalid");
  const quote = result.quote;
  const scope = { clientId: t.clientId, brandId: t.brandId };
  return withTransaction(db, async (tx) => {
    const hold = await createHold(tx, {
      ...scope,
      eventId: t.eventId,
      sessionId: t.sessionId,
      admissions: quote.admissions,
      items: quote.lines.map((l) => ({ ticketTypeId: l.ticketTypeId, quantity: l.quantity, unitPriceCents: l.unitPriceCents })),
      expiresAt: new Date(Date.now() + 600_000),
    });
    const commission = computeCommission({ rateBps: 500, fixedCentsPerPaidAdmission: 50 }, quote);
    const order = await createOrderFromHold(tx, { ...scope, holdId: hold.id, buyer: { email, fullName: "Test Buyer" }, quote, commissionCents: commission });
    const ticketIds = await recordOrderPaid(tx, scope, order.id, new Date());
    await tx.query(
      `INSERT INTO public.ticketing_access_tokens (token_hash, client_id, brand_id, subject_type, subject_id)
       VALUES (sha256(convert_to($1, 'UTF8')), $2, $3, 'order', $4)`,
      [`secret-${order.id}`, t.clientId, t.brandId, order.id],
    );
    await tx.query(
      `INSERT INTO public.ticketing_audit_log (client_id, brand_id, actor_type, action, entity_type, entity_id)
       VALUES ($1, $2, 'system', 'order.paid', 'order', $3)`,
      [t.clientId, t.brandId, order.id],
    );
    await tx.query(
      `INSERT INTO public.ticketing_control_events (event_id, contract_version, type, client_id, issued_at, outcome)
       VALUES (gen_random_uuid(), 'alkao.control.v1', 'client.upserted', $1, now(), 'applied')`,
      [t.clientId],
    );
    return { holdId: hold.id, orderId: order.id, buyerId: order.buyerId, ticketIds };
  });
}
