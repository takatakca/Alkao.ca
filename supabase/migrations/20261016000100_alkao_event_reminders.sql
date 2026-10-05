-- ALKAO Run 23: a reminder email before the session, with the buyer's tickets link.
-- On by default; each Brand can turn it off.
ALTER TABLE public.ticketing_email_outbox DROP CONSTRAINT ticketing_email_outbox_kind_check;
ALTER TABLE public.ticketing_email_outbox
  ADD CONSTRAINT ticketing_email_outbox_kind_check
  CHECK (kind IN ('order_tickets', 'exchange_tickets', 'session_cancelled', 'refund', 'reminder'));

ALTER TABLE public.ticketing_brand_settings
  ADD COLUMN reminder_emails boolean NOT NULL DEFAULT true;

-- The reminder job looks for sessions starting soon.
CREATE INDEX ticketing_sessions_starts_idx ON public.ticketing_sessions (starts_at) WHERE status IN ('on_sale', 'paused', 'closed');
