import { CUSTOMER_STATS } from "./customers.js";
import { toApi, writeAudit } from "./catalog.js";
import type { TenantScope } from "./commerce.js";
import { mapDbErrors } from "./errors.js";
import type { Db, Tx } from "./pool.js";
import { DomainError } from "../domain/errors.js";
import { IMPLIED_CONSENT_DAYS, normalizePhone, type BookingCategory, type CustomerSegment, type CustomerStatus } from "../domain/customers.js";

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
  /** Run 45, automations: the visits that start it (empty: all). */
  categories?: BookingCategory[] | undefined;
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
  /** Run 45: "one_time" (sent once, by staff) or "after_visit" (automatic, delayDays after each visit). */
  kind?: "one_time" | "after_visit" | undefined;
  delayDays?: number | null | undefined;
  /** Run 46: e-mail (default) or text message. A text has no subject or heading of its own. */
  channel?: Channel | undefined;
}

const COLUMNS = `id, name, language, subject, preheader, heading, body, image_url, cta_label, cta_url, audience_segments, audience_statuses,
  status, recipients, queued_at, finished_at, created_at, updated_at, kind, delay_days, audience_categories, active, activated_at, channel`;
const C_COLUMNS = COLUMNS.split(/,\s*/).map((col) => `c.${col}`).join(", ");

/** At most this many tests per campaign: a test goes to whatever address staff type. */
export const TESTS_PER_CAMPAIGN = 20;

/** Who the audience is right now: one customer per address, the most frequent first. */
export type Channel = "email" | "sms";

/**
 * Who the audience is right now, one per address (`address`: the e-mail, or the mobile
 * number for a text), the most frequent customer first. Run 46: a text needs a mobile
 * number, no STOP, and implied consent (a booking in the last 2 years): an e-mail sign-up
 * is consent to e-mail, not to texts.
 */
function audienceSql(channel: Channel = "email") {
  const reach = channel === "sms"
    ? `mobile_phone IS NOT NULL AND sms_opt_out_at IS NULL AND implied_consent_until >= $3::date`
    : `email IS NOT NULL AND email_permission IN ('express', 'implied')`;
  const address = channel === "sms" ? "mobile_phone" : "email";
  return `WITH ${CUSTOMER_STATS}
    SELECT DISTINCT ON (${address}) id, ${address} AS address FROM stats
    WHERE anonymized_at IS NULL AND ${reach}
      AND (cardinality($4::text[]) = 0 OR segment = ANY($4::text[]))
      AND (cardinality($5::text[]) = 0 OR status = ANY($5::text[]))
    ORDER BY ${address}, visits DESC, created_at`;
}

export async function audienceCount(q: Queryable, s: TenantScope, today: string, a: Audience, channel: Channel = "email"): Promise<number> {
  const { rows } = await q.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM (${audienceSql(channel)}) a`,
    [s.clientId, s.brandId, today, a.segments, a.statuses],
  );
  return rows[0]?.n ?? 0;
}

const values = (c: CampaignInput) => {
  const sms = c.channel === "sms";
  return [c.name, c.language, sms ? c.name.slice(0, 150) : c.subject, sms ? null : c.preheader ?? null, sms ? c.name.slice(0, 150) : c.heading, c.body,
    sms ? null : c.imageUrl ?? null, sms ? null : c.ctaLabel ?? null, c.ctaUrl ?? null, c.audience.segments, c.audience.statuses, c.kind ?? "one_time",
    (c.kind ?? "one_time") === "after_visit" ? c.delayDays ?? 3 : null, c.audience.categories ?? [], c.channel ?? "email"];
};

export async function createCampaign(tx: Tx, s: TenantScope, c: CampaignInput, actor: Actor) {
  return mapDbErrors(async () => {
    const { rows } = await tx.query(
      `INSERT INTO public.ticketing_campaigns (client_id, brand_id, name, language, subject, preheader, heading, body, image_url, cta_label, cta_url,
         audience_segments, audience_statuses, kind, delay_days, audience_categories, channel, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING ${COLUMNS}`,
      [s.clientId, s.brandId, ...values(c), actor.id],
    );
    await writeAudit(tx, s, actor, "campaign.created", { type: "campaign", id: rows[0].id });
    return toApi(rows[0]);
  });
}

/**
 * Drafts only: once sent, a campaign is what its recipients received. An automation stays a
 * draft while it runs, so its wording can be improved; it cannot change kind while on.
 */
export async function updateCampaign(tx: Tx, s: TenantScope, id: string, c: CampaignInput, actor: Actor) {
  return mapDbErrors(async () => {
    const status = await lockedStatus(tx, s, id);
    if (status !== "draft") throw new DomainError("campaign_not_draft");
    const { rows: on } = await tx.query<{ active: boolean }>(`SELECT active FROM public.ticketing_campaigns WHERE id = $1`, [id]);
    if (on[0]?.active && (c.kind ?? "one_time") !== "after_visit") throw new DomainError("automation_active");
    const { rows } = await tx.query(
      `UPDATE public.ticketing_campaigns SET name = $4, language = $5, subject = $6, preheader = $7, heading = $8, body = $9, image_url = $10,
         cta_label = $11, cta_url = $12, audience_segments = $13, audience_statuses = $14, kind = $15, delay_days = $16, audience_categories = $17,
         channel = $18
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
    `SELECT ${C_COLUMNS}, ${STATS}, (SELECT br.name FROM public.ticketing_brands br WHERE br.id = c.brand_id) AS brand_name
     FROM public.ticketing_campaigns c
     LEFT JOIN public.ticketing_campaign_messages m ON m.campaign_id = c.id AND m.client_id = c.client_id AND m.brand_id = c.brand_id
     WHERE c.id = $1 AND c.client_id = $2 AND c.brand_id = $3 GROUP BY c.id`,
    [id, s.clientId, s.brandId],
  );
  if (!rows[0]) throw new DomainError("campaign_not_found");
  const campaign = toApi(rows[0]) as Record<string, unknown>;
  // A one-time draft shows who would get it if sent now.
  if (campaign.status === "draft" && campaign.kind === "one_time") {
    campaign.audienceNow = await audienceCount(q, s, today, { segments: rows[0].audience_segments, statuses: rows[0].audience_statuses }, rows[0].channel);
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
export async function queueTest(tx: Tx, s: TenantScope, id: string, to: { email?: string | null | undefined; phone?: string | null | undefined }, actor: Actor, now: Date) {
  const status = await lockedStatus(tx, s, id);
  if (status === "cancelled" || status === "sent") throw new DomainError("campaign_closed");
  const { rows: c } = await tx.query<{ channel: Channel }>(`SELECT channel FROM public.ticketing_campaigns WHERE id = $1`, [id]);
  const sms = c[0]?.channel === "sms";
  const email = sms ? null : to.email?.trim().toLowerCase() || null;
  const phone = sms ? normalizePhone(to.phone) : null;
  if (!email && !phone) throw new DomainError("campaign_test_address");
  const { rows } = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM public.ticketing_campaign_messages WHERE campaign_id = $1 AND customer_id IS NULL`,
    [id],
  );
  if ((rows[0]?.n ?? 0) >= TESTS_PER_CAMPAIGN) throw new DomainError("campaign_test_limit");
  await tx.query(
    `INSERT INTO public.ticketing_campaign_messages (client_id, brand_id, campaign_id, email, phone, created_at, next_attempt_at) VALUES ($1, $2, $3, $4, $5, $6, $6)`,
    [s.clientId, s.brandId, id, email, phone, now],
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
  const { rows: kind } = await tx.query<{ kind: string }>(`SELECT kind FROM public.ticketing_campaigns WHERE id = $1`, [id]);
  if (kind[0]?.kind !== "one_time") throw new DomainError("campaign_is_automation");
  const sender = await getMarketingSettings(tx, s);
  if (!sender.senderAddress || !sender.contact) throw new DomainError("marketing_settings_missing");
  const { rows: c } = await tx.query<{ audience_segments: CustomerSegment[]; audience_statuses: CustomerStatus[]; channel: Channel }>(
    `SELECT audience_segments, audience_statuses, channel FROM public.ticketing_campaigns WHERE id = $1`,
    [id],
  );
  const audience = { segments: c[0]!.audience_segments, statuses: c[0]!.audience_statuses };
  const channel = c[0]!.channel;
  const { rowCount } = await tx.query(
    `INSERT INTO public.ticketing_campaign_messages (client_id, brand_id, campaign_id, customer_id, ${channel === "sms" ? "phone" : "email"}, created_at, next_attempt_at)
     SELECT $1, $2, $6::uuid, a.id, a.address, $7, $7 FROM (${audienceSql(channel)}) a`,
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
  await tx.query(`UPDATE public.ticketing_campaigns SET status = 'cancelled', active = false, finished_at = $2 WHERE id = $1`, [id, now]);
  await writeAudit(tx, s, actor, "campaign.cancelled", { type: "campaign", id }, { notSent: rowCount ?? 0 });
  return { notSent: rowCount ?? 0 };
}


// ── Run 45: automations ─────────────────────────────────────────────────────
/** On or off. Turning it on needs the sender's footer; it then writes about visits ending from now on. */
export async function setAutomation(tx: Tx, s: TenantScope, id: string, active: boolean, actor: Actor, now: Date) {
  const status = await lockedStatus(tx, s, id);
  if (status !== "draft") throw new DomainError("campaign_closed");
  const { rows } = await tx.query<{ kind: string }>(`SELECT kind FROM public.ticketing_campaigns WHERE id = $1`, [id]);
  if (rows[0]?.kind !== "after_visit") throw new DomainError("campaign_not_automation");
  if (active) {
    const sender = await getMarketingSettings(tx, s);
    if (!sender.senderAddress || !sender.contact) throw new DomainError("marketing_settings_missing");
  }
  await tx.query(
    `UPDATE public.ticketing_campaigns SET active = $2, activated_at = CASE WHEN $2 THEN coalesce(activated_at, $3) ELSE activated_at END WHERE id = $1`,
    [id, active, now],
  );
  await writeAudit(tx, s, actor, active ? "campaign.automation_started" : "campaign.automation_paused", { type: "campaign", id });
}

/**
 * Queue today's automatic messages: for each active automation, the visits (bookings not
 * cancelled) that ended `delay_days` ago (up to 3 days late if a pass was missed), of the
 * chosen kinds, never before the automation was turned on; to customers who may receive
 * e-mail; one per visit, and never twice in 7 days to the same address.
 */
export async function queueAfterVisitMessages(db: Db, now: Date, today: string): Promise<number> {
  const { rowCount } = await db.query(
    `INSERT INTO public.ticketing_campaign_messages (client_id, brand_id, campaign_id, customer_id, booking_id, email, created_at, next_attempt_at)
     SELECT DISTINCT ON (c.id, cu.email) c.client_id, c.brand_id, c.id, cu.id, b.id, cu.email, $1, $1
     FROM public.ticketing_campaigns c
     JOIN public.ticketing_customer_bookings b ON b.client_id = c.client_id AND b.brand_id = c.brand_id AND b.cancelled_on IS NULL
     JOIN public.ticketing_customers cu ON cu.id = b.customer_id AND cu.client_id = b.client_id AND cu.brand_id = b.brand_id
     WHERE c.kind = 'after_visit' AND c.active AND c.status = 'draft'
       AND b.ends_on BETWEEN $2::date - c.delay_days - 3 AND $2::date - c.delay_days
       AND b.ends_on + c.delay_days >= (c.activated_at AT TIME ZONE 'America/Toronto')::date
       AND (cardinality(c.audience_categories) = 0 OR b.category = ANY(c.audience_categories))
       AND cu.anonymized_at IS NULL AND cu.email IS NOT NULL
       AND NOT (cu.email_opt_out_at IS NOT NULL AND (cu.email_consent_at IS NULL OR cu.email_opt_out_at >= cu.email_consent_at))
       AND (cu.email_consent_at IS NOT NULL OR b.first_report_on + ${IMPLIED_CONSENT_DAYS} >= $2::date)
       AND NOT EXISTS (SELECT 1 FROM public.ticketing_campaign_messages m WHERE m.campaign_id = c.id AND m.booking_id = b.id)
       AND NOT EXISTS (SELECT 1 FROM public.ticketing_campaign_messages m
                       WHERE m.campaign_id = c.id AND m.email = cu.email AND m.created_at > $1::timestamptz - interval '7 days')
     ORDER BY c.id, cu.email, b.ends_on DESC, b.id
     ON CONFLICT DO NOTHING`,
    [now, today],
  );
  return rowCount ?? 0;
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

// ── Run 46: replies to texts (Twilio's webhook) ─────────────────────────────
/**
 * STOP: no more texts to this number, for every Brand that has it (the sending number is
 * shared, and an opt-out must never be missed). START: texts again, as the person asked.
 */
export async function recordSmsReply(tx: Tx, phone: string, intent: "stop" | "start", now: Date) {
  const { rows } = await tx.query<{ id: string; client_id: string; brand_id: string }>(
    intent === "stop"
      ? `UPDATE public.ticketing_customers SET sms_opt_out_at = $2 WHERE mobile_phone = $1 AND sms_opt_out_at IS NULL RETURNING id, client_id, brand_id`
      : `UPDATE public.ticketing_customers SET sms_opt_out_at = NULL WHERE mobile_phone = $1 AND sms_opt_out_at IS NOT NULL RETURNING id, client_id, brand_id`,
    intent === "stop" ? [phone, now] : [phone],
  );
  for (const r of rows) {
    await writeAudit(tx, { clientId: r.client_id, brandId: r.brand_id }, { type: "public", id: null }, intent === "stop" ? "customer.sms_stopped" : "customer.sms_restarted", { type: "customer", id: r.id });
  }
  return rows.length;
}
