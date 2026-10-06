import { CUSTOMER_STATS } from "./customers.js";
import { toApi, writeAudit } from "./catalog.js";
import type { TenantScope } from "./commerce.js";
import { mapDbErrors } from "./errors.js";
import type { Db, Tx } from "./pool.js";
import { DomainError } from "../domain/errors.js";
import type { CustomerSegment, CustomerStatus } from "../domain/customers.js";

/**
 * Run 42: e-mail campaigns to the customer file. A campaign is written as a draft, tried on a
 * staff address, then sent: its recipients are taken at that moment (one message each) and
 * the e-mail worker sends them. Only customers who may receive marketing e-mail are taken
 * (express consent, or implied for 2 years after a booking), once per address.
 */
type Queryable = Db | Tx;
type Actor = { type: "user"; id: string | null };

export interface Audience {
  segments: CustomerSegment[];
  statuses: CustomerStatus[];
}

export interface CampaignInput {
  name: string;
  language: "fr" | "en";
  subject: string;
  preheader?: string | null | undefined;
  heading: string;
  body: string;
  imageUrl?: string | null | undefined;
  ctaLabel?: string | null | undefined;
  ctaUrl?: string | null | undefined;
  audience: Audience;
}

const COLUMNS = `id, name, language, subject, preheader, heading, body, image_url, cta_label, cta_url, audience_segments, audience_statuses,
  status, recipients, queued_at, finished_at, created_at, updated_at`;
const C_COLUMNS = COLUMNS.split(/,\s*/).map((col) => `c.${col}`).join(", ");

/** At most this many tests per campaign: a test goes to whatever address staff type. */
export const TESTS_PER_CAMPAIGN = 20;

/** Who the audience is right now: one customer per address, the most frequent first. */
function audienceSql() {
  return `WITH ${CUSTOMER_STATS}
    SELECT DISTINCT ON (email) id, email FROM stats
    WHERE anonymized_at IS NULL AND email IS NOT NULL AND email_permission IN ('express', 'implied')
      AND (cardinality($4::text[]) = 0 OR segment = ANY($4::text[]))
      AND (cardinality($5::text[]) = 0 OR status = ANY($5::text[]))
    ORDER BY email, visits DESC, created_at`;
}

export async function audienceCount(q: Queryable, s: TenantScope, today: string, a: Audience): Promise<number> {
  const { rows } = await q.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM (${audienceSql()}) a`,
    [s.clientId, s.brandId, today, a.segments, a.statuses],
  );
  return rows[0]?.n ?? 0;
}

const values = (c: CampaignInput) => [c.name, c.language, c.subject, c.preheader ?? null, c.heading, c.body, c.imageUrl ?? null,
  c.ctaLabel ?? null, c.ctaUrl ?? null, c.audience.segments, c.audience.statuses];

export async function createCampaign(tx: Tx, s: TenantScope, c: CampaignInput, actor: Actor) {
  return mapDbErrors(async () => {
    const { rows } = await tx.query(
      `INSERT INTO public.ticketing_campaigns (client_id, brand_id, name, language, subject, preheader, heading, body, image_url, cta_label, cta_url,
         audience_segments, audience_statuses, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING ${COLUMNS}`,
      [s.clientId, s.brandId, ...values(c), actor.id],
    );
    await writeAudit(tx, s, actor, "campaign.created", { type: "campaign", id: rows[0].id });
    return toApi(rows[0]);
  });
}

/** Drafts only: once sent, a campaign is what its recipients received. */
export async function updateCampaign(tx: Tx, s: TenantScope, id: string, c: CampaignInput, actor: Actor) {
  return mapDbErrors(async () => {
    const status = await lockedStatus(tx, s, id);
    if (status !== "draft") throw new DomainError("campaign_not_draft");
    const { rows } = await tx.query(
      `UPDATE public.ticketing_campaigns SET name = $4, language = $5, subject = $6, preheader = $7, heading = $8, body = $9, image_url = $10,
         cta_label = $11, cta_url = $12, audience_segments = $13, audience_statuses = $14
       WHERE id = $1 AND client_id = $2 AND brand_id = $3 RETURNING ${COLUMNS}`,
      [id, s.clientId, s.brandId, ...values(c)],
    );
    await writeAudit(tx, s, actor, "campaign.updated", { type: "campaign", id });
    return toApi(rows[0]);
  });
}

async function lockedStatus(tx: Tx, s: TenantScope, id: string): Promise<string> {
  const { rows } = await tx.query<{ status: string }>(
    `SELECT status FROM public.ticketing_campaigns WHERE id = $1 AND client_id = $2 AND brand_id = $3 FOR UPDATE`,
    [id, s.clientId, s.brandId],
  );
  if (!rows[0]) throw new DomainError("campaign_not_found");
  return rows[0].status;
}

const STATS = `count(*) FILTER (WHERE m.customer_id IS NOT NULL AND m.status = 'pending')::int AS pending,
  count(*) FILTER (WHERE m.customer_id IS NOT NULL AND m.status = 'sent')::int AS sent,
  count(*) FILTER (WHERE m.customer_id IS NOT NULL AND m.status = 'skipped')::int AS skipped,
  count(*) FILTER (WHERE m.customer_id IS NOT NULL AND m.status = 'failed')::int AS failed,
  count(*) FILTER (WHERE m.customer_id IS NOT NULL AND m.unsubscribed_at IS NOT NULL)::int AS unsubscribed,
  count(*) FILTER (WHERE m.customer_id IS NULL)::int AS tests`;

export async function listCampaigns(q: Queryable, s: TenantScope) {
  const { rows } = await q.query(
    `SELECT ${C_COLUMNS}, ${STATS}
     FROM public.ticketing_campaigns c
     LEFT JOIN public.ticketing_campaign_messages m ON m.campaign_id = c.id AND m.client_id = c.client_id AND m.brand_id = c.brand_id
     WHERE c.client_id = $1 AND c.brand_id = $2
     GROUP BY c.id ORDER BY c.created_at DESC LIMIT 200`,
    [s.clientId, s.brandId],
  );
  return rows.map(toApi);
}

export async function getCampaign(q: Queryable, s: TenantScope, id: string, today: string) {
  const { rows } = await q.query(
    `SELECT ${C_COLUMNS}, ${STATS}
     FROM public.ticketing_campaigns c
     LEFT JOIN public.ticketing_campaign_messages m ON m.campaign_id = c.id AND m.client_id = c.client_id AND m.brand_id = c.brand_id
     WHERE c.id = $1 AND c.client_id = $2 AND c.brand_id = $3 GROUP BY c.id`,
    [id, s.clientId, s.brandId],
  );
  if (!rows[0]) throw new DomainError("campaign_not_found");
  const campaign = toApi(rows[0]) as Record<string, unknown>;
  // A draft shows who would get it if sent now.
  if (campaign.status === "draft") {
    campaign.audienceNow = await audienceCount(q, s, today, { segments: rows[0].audience_segments, statuses: rows[0].audience_statuses });
  }
  return campaign;
}

// ── Sender (the law's footer) ───────────────────────────────────────────────
export async function getMarketingSettings(q: Queryable, s: TenantScope) {
  const { rows } = await q.query<{ sender_address: string | null; contact: string | null }>(
    `SELECT marketing_sender_address AS sender_address, marketing_contact AS contact FROM public.ticketing_brand_settings WHERE client_id = $1 AND brand_id = $2`,
    [s.clientId, s.brandId],
  );
  return { senderAddress: rows[0]?.sender_address ?? null, contact: rows[0]?.contact ?? null };
}

export async function setMarketingSettings(tx: Tx, s: TenantScope, p: { senderAddress: string; contact: string }, actor: Actor) {
  await tx.query(
    `INSERT INTO public.ticketing_brand_settings (client_id, brand_id, marketing_sender_address, marketing_contact) VALUES ($1, $2, $3, $4)
     ON CONFLICT (client_id, brand_id) DO UPDATE SET marketing_sender_address = EXCLUDED.marketing_sender_address, marketing_contact = EXCLUDED.marketing_contact`,
    [s.clientId, s.brandId, p.senderAddress, p.contact],
  );
  await writeAudit(tx, s, actor, "settings.marketing_updated", { type: "brand_settings", id: null });
  return p;
}

// ── Sending ─────────────────────────────────────────────────────────────────
/** One test message to a staff address, sent by the worker like the others. */
export async function queueTest(tx: Tx, s: TenantScope, id: string, email: string, actor: Actor, now: Date) {
  const status = await lockedStatus(tx, s, id);
  if (status === "cancelled" || status === "sent") throw new DomainError("campaign_closed");
  const { rows } = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM public.ticketing_campaign_messages WHERE campaign_id = $1 AND customer_id IS NULL`,
    [id],
  );
  if ((rows[0]?.n ?? 0) >= TESTS_PER_CAMPAIGN) throw new DomainError("campaign_test_limit");
  await tx.query(
    `INSERT INTO public.ticketing_campaign_messages (client_id, brand_id, campaign_id, email, created_at, next_attempt_at) VALUES ($1, $2, $3, $4, $5, $5)`,
    [s.clientId, s.brandId, id, email.trim().toLowerCase(), now],
  );
  await writeAudit(tx, s, actor, "campaign.test_queued", { type: "campaign", id });
  return { queued: true };
}

/**
 * Send: the recipients are taken now. The number staff saw must still be right
 * (`expectedRecipients`), so nobody sends to an audience that changed under them.
 */
export async function sendCampaign(tx: Tx, s: TenantScope, id: string, expectedRecipients: number, today: string, actor: Actor, now: Date) {
  const status = await lockedStatus(tx, s, id);
  if (status !== "draft") throw new DomainError("campaign_not_draft");
  const sender = await getMarketingSettings(tx, s);
  if (!sender.senderAddress || !sender.contact) throw new DomainError("marketing_settings_missing");
  const { rows: c } = await tx.query<{ audience_segments: CustomerSegment[]; audience_statuses: CustomerStatus[] }>(
    `SELECT audience_segments, audience_statuses FROM public.ticketing_campaigns WHERE id = $1`,
    [id],
  );
  const audience = { segments: c[0]!.audience_segments, statuses: c[0]!.audience_statuses };
  const { rowCount } = await tx.query(
    `INSERT INTO public.ticketing_campaign_messages (client_id, brand_id, campaign_id, customer_id, email, created_at, next_attempt_at)
     SELECT $1, $2, $6::uuid, a.id, a.email, $7, $7 FROM (${audienceSql()}) a`,
    [s.clientId, s.brandId, today, audience.segments, audience.statuses, id, now],
  );
  const recipients = rowCount ?? 0;
  if (recipients === 0) throw new DomainError("audience_empty");
  if (recipients !== expectedRecipients) throw new DomainError("audience_changed", { recipients });
  await tx.query(
    `UPDATE public.ticketing_campaigns SET status = 'sending', recipients = $4, queued_at = $5 WHERE id = $1 AND client_id = $2 AND brand_id = $3`,
    [id, s.clientId, s.brandId, recipients, now],
  );
  await writeAudit(tx, s, actor, "campaign.sent", { type: "campaign", id }, { recipients });
  return { recipients };
}

/** Stops a campaign: what is not sent yet never will be. */
export async function cancelCampaign(tx: Tx, s: TenantScope, id: string, actor: Actor, now: Date) {
  const status = await lockedStatus(tx, s, id);
  if (status === "sent" || status === "cancelled") throw new DomainError("campaign_closed");
  const { rowCount } = await tx.query(
    `UPDATE public.ticketing_campaign_messages SET status = 'skipped', last_error = 'cancelled' WHERE campaign_id = $1 AND status = 'pending'`,
    [id],
  );
  await tx.query(`UPDATE public.ticketing_campaigns SET status = 'cancelled', finished_at = $2 WHERE id = $1`, [id, now]);
  await writeAudit(tx, s, actor, "campaign.cancelled", { type: "campaign", id }, { notSent: rowCount ?? 0 });
  return { notSent: rowCount ?? 0 };
}

// ── Unsubscribe (public, through the link in each e-mail) ───────────────────
export async function unsubscribeContext(q: Queryable, messageId: string) {
  const { rows } = await q.query<{ client_id: string; brand_id: string; customer_id: string | null; unsubscribed_at: Date | null; language: "fr" | "en"; brand_name: string }>(
    `SELECT m.client_id, m.brand_id, m.customer_id, m.unsubscribed_at, c.language, br.name AS brand_name
     FROM public.ticketing_campaign_messages m
     JOIN public.ticketing_campaigns c ON c.id = m.campaign_id AND c.client_id = m.client_id AND c.brand_id = m.brand_id
     JOIN public.ticketing_brands br ON br.id = m.brand_id AND br.client_id = m.client_id
     WHERE m.id = $1`,
    [messageId],
  );
  return rows[0] ?? null;
}

/** The customer gets no more marketing e-mail from this Brand, whatever consent they gave. */
export async function unsubscribe(tx: Tx, messageId: string, now: Date) {
  const ctx = await unsubscribeContext(tx, messageId);
  if (!ctx) throw new DomainError("message_not_found");
  if (!ctx.customer_id) return { ...ctx, test: true };
  await tx.query(`UPDATE public.ticketing_campaign_messages SET unsubscribed_at = coalesce(unsubscribed_at, $2) WHERE id = $1`, [messageId, now]);
  const { rowCount } = await tx.query(
    `UPDATE public.ticketing_customers SET email_opt_out_at = $2
     WHERE id = $1 AND (email_opt_out_at IS NULL OR email_opt_out_at < email_consent_at)`,
    [ctx.customer_id, now],
  );
  if (rowCount) {
    await writeAudit(tx, { clientId: ctx.client_id, brandId: ctx.brand_id }, { type: "public", id: null }, "customer.unsubscribed", { type: "customer", id: ctx.customer_id }, { messageId });
  }
  return { ...ctx, test: false };
}
