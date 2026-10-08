import type { TenantScope } from "./commerce.js";
import type { Db, Tx } from "./pool.js";

type Queryable = Db | Tx;

/**
 * Run 50: a Brand's look (ticketing_brand_settings). Read with the order, the event and the
 * e-mails through APPEARANCE_COLUMNS on a LEFT JOIN, so a Brand without settings keeps
 * ALKAO's neutral look.
 */
export interface BrandAppearance {
  logoUrl: string | null;
  accentColor: string | null;
  onAccentColor: string | null;
  websiteUrl: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
  addressLine: string | null;
}

export const NO_APPEARANCE: BrandAppearance = {
  logoUrl: null, accentColor: null, onAccentColor: null, websiteUrl: null, supportEmail: null, supportPhone: null, addressLine: null,
};

/** The settings' columns, for a query that has `LEFT JOIN public.ticketing_brand_settings bs`. */
export const APPEARANCE_COLUMNS =
  "bs.logo_url AS look_logo_url, bs.accent_color AS look_accent_color, bs.on_accent_color AS look_on_accent_color, " +
  "bs.website_url AS look_website_url, bs.support_email AS look_support_email, bs.support_phone AS look_support_phone, " +
  "bs.address_line AS look_address_line";

/** `LEFT JOIN` of a Brand's settings, for the row aliased `alias` (with client_id and brand_id). */
export const appearanceJoin = (alias: string) =>
  `LEFT JOIN public.ticketing_brand_settings bs ON bs.client_id = ${alias}.client_id AND bs.brand_id = ${alias}.brand_id`;

export type LookRow = Partial<Record<`look_${"logo_url" | "accent_color" | "on_accent_color" | "website_url" | "support_email" | "support_phone" | "address_line"}`, string | null>>;

export function appearanceOf(r: LookRow): BrandAppearance {
  return {
    logoUrl: r.look_logo_url ?? null,
    accentColor: r.look_accent_color ?? null,
    onAccentColor: r.look_on_accent_color ?? null,
    websiteUrl: r.look_website_url ?? null,
    supportEmail: r.look_support_email ?? null,
    supportPhone: r.look_support_phone ?? null,
    addressLine: r.look_address_line ?? null,
  };
}

/** The look as /ops edits it, with the Brand's name for the preview. */
export type StoredAppearance = BrandAppearance & { updatedAt: Date | null; brandName: string | null };

export async function getAppearance(q: Queryable, s: TenantScope): Promise<StoredAppearance> {
  const { rows } = await q.query(
    `SELECT ${APPEARANCE_COLUMNS}, bs.appearance_updated_at, br.name AS brand_name
     FROM public.ticketing_brands br
     LEFT JOIN public.ticketing_brand_settings bs ON bs.client_id = br.client_id AND bs.brand_id = br.id
     WHERE br.id = $2 AND br.client_id = $1`,
    [s.clientId, s.brandId],
  );
  const r = rows[0];
  return r
    ? { ...appearanceOf(r), updatedAt: r.appearance_updated_at ?? null, brandName: r.brand_name ?? null }
    : { ...NO_APPEARANCE, updatedAt: null, brandName: null };
}

export async function setAppearance(q: Queryable, s: TenantScope, a: BrandAppearance): Promise<StoredAppearance> {
  await q.query(
    `INSERT INTO public.ticketing_brand_settings
       (client_id, brand_id, logo_url, accent_color, on_accent_color, website_url, support_email, support_phone, address_line, appearance_updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     ON CONFLICT (client_id, brand_id) DO UPDATE SET
       logo_url = EXCLUDED.logo_url, accent_color = EXCLUDED.accent_color, on_accent_color = EXCLUDED.on_accent_color,
       website_url = EXCLUDED.website_url, support_email = EXCLUDED.support_email, support_phone = EXCLUDED.support_phone,
       address_line = EXCLUDED.address_line, appearance_updated_at = now()`,
    [s.clientId, s.brandId, a.logoUrl, a.accentColor, a.onAccentColor, a.websiteUrl, a.supportEmail, a.supportPhone, a.addressLine],
  );
  return getAppearance(q, s);
}
