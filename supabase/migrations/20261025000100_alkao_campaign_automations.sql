-- ALKAO Run 45: an automatic campaign, "after the visit": N days after a stay or a ticket
-- ends, the customer gets a thank-you (a review link, an offer to come back). Same consent,
-- footer and unsubscribe rules as every campaign (Run 42).

ALTER TABLE public.ticketing_campaigns
  ADD COLUMN kind text NOT NULL DEFAULT 'one_time' CHECK (kind IN ('one_time', 'after_visit')),
  -- Days after the visit ends (the departure day), for kind after_visit.
  ADD COLUMN delay_days smallint CHECK (delay_days BETWEEN 0 AND 60),
  -- Which visits start it: lodging families or tickets (empty: all).
  ADD COLUMN audience_categories text[] NOT NULL DEFAULT '{}'
    CHECK (audience_categories <@ ARRAY['camping', 'cabana', 'chalet', 'condo', 'villa', 'tent', 'coolbox', 'ticket', 'other']),
  -- An automation runs while active; it only ever writes about visits that end after it was
  -- first turned on, never about past ones.
  ADD COLUMN active boolean NOT NULL DEFAULT false,
  ADD COLUMN activated_at timestamptz;
ALTER TABLE public.ticketing_campaigns
  ADD CONSTRAINT ticketing_campaigns_kind_ck CHECK ((kind = 'after_visit') = (delay_days IS NOT NULL)),
  ADD CONSTRAINT ticketing_campaigns_active_ck CHECK (NOT active OR (kind = 'after_visit' AND activated_at IS NOT NULL AND status = 'draft'));

-- The visit (booking) an automatic message is about. One message per booking.
ALTER TABLE public.ticketing_customer_bookings
  ADD CONSTRAINT ticketing_customer_bookings_tenant_key UNIQUE (id, client_id, brand_id);
ALTER TABLE public.ticketing_campaign_messages ADD COLUMN booking_id uuid;
ALTER TABLE public.ticketing_campaign_messages
  ADD CONSTRAINT ticketing_campaign_messages_booking_fkey FOREIGN KEY (booking_id, client_id, brand_id)
    REFERENCES public.ticketing_customer_bookings (id, client_id, brand_id) ON DELETE RESTRICT;
-- A one-time campaign reaches a customer once; an automation once per visit.
DROP INDEX public.ticketing_campaign_messages_once_idx;
CREATE UNIQUE INDEX ticketing_campaign_messages_once_idx ON public.ticketing_campaign_messages (campaign_id, customer_id)
  WHERE customer_id IS NOT NULL AND booking_id IS NULL;
CREATE UNIQUE INDEX ticketing_campaign_messages_booking_idx ON public.ticketing_campaign_messages (campaign_id, booking_id)
  WHERE booking_id IS NOT NULL;
CREATE INDEX ticketing_campaign_messages_recent_idx ON public.ticketing_campaign_messages (campaign_id, email, created_at);
CREATE INDEX ticketing_customer_bookings_ends_idx ON public.ticketing_customer_bookings (client_id, brand_id, ends_on)
  WHERE cancelled_on IS NULL;
