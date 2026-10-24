-- ALKAO Run 105: the return offer. An event's buyers see a coupon for the organizer's next
-- event (or another date of the same one) on their tickets page and in their tickets e-mail:
-- "Merci ! −15 % sur Festival d'hiver avec le code RETOUR15". It is an existing promo code of
-- the same Brand; it shows only while that code is usable and its event has a date on sale.

ALTER TABLE public.ticketing_events ADD COLUMN return_offer_promo_id uuid;
ALTER TABLE public.ticketing_events
  ADD CONSTRAINT ticketing_events_return_offer_fkey FOREIGN KEY (return_offer_promo_id, client_id, brand_id)
    REFERENCES public.ticketing_promo_codes (id, client_id, brand_id);
CREATE INDEX ticketing_events_return_offer_idx ON public.ticketing_events (return_offer_promo_id) WHERE return_offer_promo_id IS NOT NULL;
