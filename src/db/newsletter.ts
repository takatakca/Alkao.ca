import { normalizeEmail, tidyText } from "../domain/customers.js";
import { DomainError } from "../domain/errors.js";
import { writeAudit } from "./catalog.js";
import type { TenantScope } from "./commerce.js";
import type { Db, Tx } from "./pool.js";

/**
 * Run 44: newsletter sign-up with a confirmation e-mail (double opt-in). The sign-up itself
 * changes nothing on the customer file; only the person's own click on the confirmation
 * page records their express consent (Canada's anti-spam law), so nobody can subscribe
 * someone else.
 */
type Queryable = Db | Tx;

/** A confirmation link works this long. */
export const SIGNUP_VALID_DAYS = 7;
/** The same address asking again within this time gets no second e-mail. */
const RESEND_AFTER_MINUTES = 10;

export async function requestSignup(
  tx: Tx, s: TenantScope, p: { email: string; firstName?: string | null | undefined; language: "fr" | "en"; source?: string | null | undefined }, now: Date,
): Promise<{ queued: boolean }> {
  const email = normalizeEmail(p.email);
  if (!email) return { queued: false };
  const { rowCount: recent } = await tx.query(
    `SELECT 1 FROM public.ticketing_newsletter_signups
     WHERE client_id = $1 AND brand_id = $2 AND email = $3 AND status = 'pending' AND created_at > $4::timestamptz - make_interval(mins => ${RESEND_AFTER_MINUTES})`,
    [s.clientId, s.brandId, email, now],
  );
  if (recent) return { queued: false };
  await tx.query(
    `INSERT INTO public.ticketing_newsletter_signups (client_id, brand_id, email, first_name, language, source, created_at, next_attempt_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
    [s.clientId, s.brandId, email, tidyText(p.firstName, 120), p.language, p.source ?? null, now],
  );
  return { queued: true };
}

export interface SignupContext {
  id: string;
  client_id: string;
  brand_id: string;
  email: string;
  first_name: string | null;
  language: "fr" | "en";
  status: "pending" | "confirmed";
  created_at: Date;
  brand_name: string;
  reward_code: string | null;
  reward_text: string | null;
}

export async function signupContext(q: Queryable, id: string): Promise<SignupContext | null> {
  const { rows } = await q.query<SignupContext>(
    `SELECT n.id, n.client_id, n.brand_id, n.email, n.first_name, n.language, n.status, n.created_at, br.name AS brand_name,
            bs.newsletter_reward_code AS reward_code, bs.newsletter_reward_text AS reward_text
     FROM public.ticketing_newsletter_signups n
     JOIN public.ticketing_brands br ON br.id = n.brand_id AND br.client_id = n.client_id
     LEFT JOIN public.ticketing_brand_settings bs ON bs.client_id = n.client_id AND bs.brand_id = n.brand_id
     WHERE n.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * The person confirmed: their customer (the oldest one with this address, or a new contact)
 * gets express consent now, which also lifts an earlier unsubscribe. Confirming twice is
 * harmless; a link older than SIGNUP_VALID_DAYS is refused.
 */
export async function confirmSignup(tx: Tx, id: string, now: Date): Promise<SignupContext> {
  const ctx = await signupContext(tx, id);
  if (!ctx) throw new DomainError("signup_not_found");
  if (ctx.status === "confirmed") return ctx;
  if (now.getTime() - ctx.created_at.getTime() > SIGNUP_VALID_DAYS * 86_400_000) throw new DomainError("signup_expired");
  const scope = { clientId: ctx.client_id, brandId: ctx.brand_id };
  const { rows: found } = await tx.query<{ id: string }>(
    `SELECT id FROM public.ticketing_customers
     WHERE client_id = $1 AND brand_id = $2 AND email = $3 AND anonymized_at IS NULL ORDER BY created_at, id LIMIT 1 FOR UPDATE`,
    [scope.clientId, scope.brandId, ctx.email],
  );
  let customerId = found[0]?.id;
  if (customerId) {
    // Run 48: the link was opened from that mailbox, so the address works again.
    await tx.query(
      `UPDATE public.ticketing_customers SET email_consent_at = $2, email_bounced_at = NULL, first_name = COALESCE(first_name, $3) WHERE id = $1`,
      [customerId, now, ctx.first_name],
    );
  } else {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO public.ticketing_customers (client_id, brand_id, email, first_name, email_consent_at) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [scope.clientId, scope.brandId, ctx.email, ctx.first_name, now],
    );
    customerId = rows[0]!.id;
  }
  await tx.query(
    `UPDATE public.ticketing_newsletter_signups SET status = 'confirmed', confirmed_at = $2, customer_id = $3 WHERE id = $1`,
    [id, now, customerId],
  );
  await writeAudit(tx, scope, { type: "public", id: null }, "customer.subscribed", { type: "customer", id: customerId }, { signupId: id });
  return { ...ctx, status: "confirmed" };
}

// ── Staff ───────────────────────────────────────────────────────────────────
export async function getNewsletterSettings(q: Queryable, s: TenantScope) {
  const [{ rows: settings }, { rows: counts }] = await Promise.all([
    q.query<{ code: string | null; text: string | null }>(
      `SELECT newsletter_reward_code AS code, newsletter_reward_text AS text FROM public.ticketing_brand_settings WHERE client_id = $1 AND brand_id = $2`,
      [s.clientId, s.brandId],
    ),
    q.query<{ pending: number; confirmed: number; confirmed30: number }>(
      `SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending, count(*) FILTER (WHERE status = 'confirmed')::int AS confirmed,
              count(*) FILTER (WHERE status = 'confirmed' AND confirmed_at > now() - interval '30 days')::int AS confirmed30
       FROM public.ticketing_newsletter_signups WHERE client_id = $1 AND brand_id = $2`,
      [s.clientId, s.brandId],
    ),
  ]);
  return {
    rewardCode: settings[0]?.code ?? null, rewardText: settings[0]?.text ?? null,
    signups: { pending: counts[0]?.pending ?? 0, confirmed: counts[0]?.confirmed ?? 0, confirmedLast30Days: counts[0]?.confirmed30 ?? 0 },
  };
}

export async function setNewsletterSettings(tx: Tx, s: TenantScope, p: { rewardCode: string | null; rewardText: string | null }, actor: { type: "user"; id: string | null }) {
  await tx.query(
    `INSERT INTO public.ticketing_brand_settings (client_id, brand_id, newsletter_reward_code, newsletter_reward_text) VALUES ($1, $2, $3, $4)
     ON CONFLICT (client_id, brand_id) DO UPDATE SET newsletter_reward_code = EXCLUDED.newsletter_reward_code, newsletter_reward_text = EXCLUDED.newsletter_reward_text`,
    [s.clientId, s.brandId, p.rewardCode, p.rewardText],
  );
  await writeAudit(tx, s, actor, "settings.newsletter_updated", { type: "brand_settings", id: null });
}
