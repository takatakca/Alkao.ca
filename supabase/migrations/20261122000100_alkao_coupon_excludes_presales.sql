-- ALKAO Run 99: a promo code or coupon the organizer does not want on top of a presale.
--
-- With excludes_presales, the code takes its percentage or amount off the regular-price
-- tickets of the cart only; presale tickets keep their presale price. A cart of presale
-- tickets only is refused with the code (the server says why), never charged a hidden rule.

ALTER TABLE public.ticketing_promo_codes ADD COLUMN excludes_presales boolean NOT NULL DEFAULT false;
