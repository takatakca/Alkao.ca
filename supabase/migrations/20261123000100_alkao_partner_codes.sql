-- ALKAO Run 103: promo codes for partner companies.
--
-- An organizer gives a company (a sponsor, an employer, a shop) a batch of unique codes,
-- each with its own use limit, to hand to its staff or customers. The codes carry the
-- company's name in `partner`, so the dashboard shows what each partner sold, and they are
-- never shown publicly as coupons: a partner code is given, not displayed.

ALTER TABLE public.ticketing_promo_codes
  ADD COLUMN partner text CHECK (partner IS NULL OR (length(partner) BETWEEN 1 AND 80 AND partner !~ '[<>]'));
ALTER TABLE public.ticketing_promo_codes
  ADD CONSTRAINT ticketing_promo_codes_partner_private_ck CHECK (partner IS NULL OR NOT public);
CREATE INDEX ticketing_promo_codes_partner_idx ON public.ticketing_promo_codes (event_id, partner) WHERE partner IS NOT NULL;
