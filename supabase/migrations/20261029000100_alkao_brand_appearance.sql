-- ALKAO Run 50: each Brand's look, so every business's buyers see its own ticketing.
--
-- 1. A Brand's appearance (in ticketing_brand_settings, already private to the Brand): its
--    logo, its colour and the text colour on it, its website, how to reach it and its
--    address. The tickets page, the shop and every buyer e-mail use them; without them they
--    keep ALKAO's neutral look. Addresses are https only; colours are #RRGGBB.
-- 2. An event's photo (https), shown at the top of the tickets page, the shop and the
--    tickets e-mail.
-- Nothing here is personal data. No new table: RLS and grants are those of the two tables.

CREATE OR REPLACE FUNCTION alkao_private.valid_https_url(u text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT u IS NULL OR (length(u) <= 500 AND u ~ '^https://[a-zA-Z0-9.-]+(:[0-9]{1,5})?(/[^[:space:]"''<>\\]*)?$')
$$;
REVOKE ALL ON FUNCTION alkao_private.valid_https_url(text) FROM PUBLIC;

ALTER TABLE public.ticketing_brand_settings
  ADD COLUMN logo_url text CHECK (alkao_private.valid_https_url(logo_url)),
  ADD COLUMN accent_color text CHECK (accent_color IS NULL OR accent_color ~ '^#[0-9a-f]{6}$'),
  ADD COLUMN on_accent_color text CHECK (on_accent_color IS NULL OR on_accent_color ~ '^#[0-9a-f]{6}$'),
  ADD COLUMN website_url text CHECK (alkao_private.valid_https_url(website_url)),
  ADD COLUMN support_email text CHECK (support_email IS NULL OR (length(support_email) <= 254 AND support_email ~ '^[^@[:space:]<>"]+@[^@[:space:]<>"]+\.[^@[:space:]<>"]+$')),
  ADD COLUMN support_phone text CHECK (support_phone IS NULL OR (length(support_phone) <= 40 AND support_phone ~ '^[0-9 +().-]+$')),
  ADD COLUMN address_line text CHECK (address_line IS NULL OR (length(address_line) BETWEEN 1 AND 200 AND address_line !~ '[<>]')),
  ADD COLUMN appearance_updated_at timestamptz;

-- A colour and the text on it come together, or neither.
ALTER TABLE public.ticketing_brand_settings
  ADD CONSTRAINT ticketing_brand_settings_accent_pair_ck CHECK ((accent_color IS NULL) = (on_accent_color IS NULL));

ALTER TABLE public.ticketing_events
  ADD COLUMN image_url text CHECK (alkao_private.valid_https_url(image_url));
