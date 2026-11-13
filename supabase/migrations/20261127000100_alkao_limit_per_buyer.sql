-- ALKAO Run 110 (2026-11-13): a limit per buyer ("2 bons par personne"), as Groupon, Tuango and
-- PromoRabais set on their offers. It counts every order of the same buyer (same e-mail) for the
-- ticket type: paid ones, and those still being paid. The check runs at checkout, once the
-- buyer is known, under the buyer's row lock (src/db/commerce.ts createOrderFromHold).
ALTER TABLE public.ticketing_ticket_types
  ADD COLUMN limit_per_buyer integer CHECK (limit_per_buyer BETWEEN 1 AND 1000);
