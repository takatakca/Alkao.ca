-- ALKAO Run 112 (2026-11-13): a reminder before a merchant voucher expires ("Il vous reste 2 bons,
-- valides jusqu'au 31 décembre"), once per order, 7 days before its validity window ends, while
-- at least one of its vouchers has not been redeemed (src/delivery/reminders.ts).
ALTER TABLE public.ticketing_email_outbox DROP CONSTRAINT ticketing_email_outbox_kind_check;
ALTER TABLE public.ticketing_email_outbox
  ADD CONSTRAINT ticketing_email_outbox_kind_check
    CHECK (kind IN ('order_tickets', 'exchange_tickets', 'session_cancelled', 'refund', 'reminder', 'session_changed', 'voucher_expiry'));
