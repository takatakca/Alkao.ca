-- ALKAO Run 43: ticket buyers join the customer file. Each paid ALKAO order becomes a booking
-- of source 'alkao_order' (its reference: the order id) in the new category 'ticket', so a
-- day pass or an evening counts as a visit next to the stays.
ALTER TABLE public.ticketing_customer_bookings DROP CONSTRAINT ticketing_customer_bookings_category_check;
ALTER TABLE public.ticketing_customer_bookings ADD CONSTRAINT ticketing_customer_bookings_category_check
  CHECK (category IN ('camping', 'cabana', 'chalet', 'condo', 'villa', 'tent', 'coolbox', 'ticket', 'other'));
