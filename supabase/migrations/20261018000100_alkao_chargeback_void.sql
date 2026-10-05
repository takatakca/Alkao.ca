-- ALKAO Run 34: tickets cancelled because the buyer won a Stripe dispute (chargeback).
-- One more reason a ticket can be void; nothing else changes.
ALTER TABLE public.ticketing_tickets DROP CONSTRAINT ticketing_tickets_void_reason_check;
ALTER TABLE public.ticketing_tickets
  ADD CONSTRAINT ticketing_tickets_void_reason_check
  CHECK (void_reason IN ('refunded', 'cancelled', 'reissued', 'admin', 'chargeback'));
