-- ALKAO Run 48: e-mails that do not arrive. Resend tells ALKAO (signed webhook) when an
-- address refuses a message for good (hard bounce, or already on Resend's suppression list)
-- and when someone marks a message as spam. Marketing then stops writing to that address,
-- and a ticket e-mail that never arrived shows in "À traiter". A campaign that bounces too
-- much is held until staff look at it: a poor list must not get the sender blocked.

-- The address refused a message: no more marketing to it until it changes.
ALTER TABLE public.ticketing_customers ADD COLUMN email_bounced_at timestamptz;
-- Resend reports an address, not a Brand: the same address is looked up in every file.
CREATE INDEX ticketing_customers_any_email_idx ON public.ticketing_customers (email) WHERE email IS NOT NULL;

-- A new address is a new chance, whichever path changes it (import, ticket purchase, staff).
CREATE OR REPLACE FUNCTION alkao_private.ticketing_customers_email_changed()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.email IS DISTINCT FROM OLD.email THEN
    NEW.email_bounced_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION alkao_private.ticketing_customers_email_changed() FROM PUBLIC;
CREATE TRIGGER ticketing_customers_email_changed BEFORE UPDATE OF email ON public.ticketing_customers
  FOR EACH ROW EXECUTE FUNCTION alkao_private.ticketing_customers_email_changed();

-- What happened to each message after it was sent.
ALTER TABLE public.ticketing_campaign_messages
  ADD COLUMN bounced_at timestamptz,
  ADD COLUMN complained_at timestamptz;
CREATE INDEX ticketing_campaign_messages_provider_idx ON public.ticketing_campaign_messages (provider_message_id)
  WHERE provider_message_id IS NOT NULL;
-- The hourly pace counts the campaign e-mails sent in the last hour, on every worker pass.
CREATE INDEX ticketing_campaign_messages_paced_idx ON public.ticketing_campaign_messages (sent_at)
  WHERE status = 'sent' AND customer_id IS NOT NULL AND email IS NOT NULL;

ALTER TABLE public.ticketing_email_outbox ADD COLUMN bounced_at timestamptz;
CREATE INDEX ticketing_email_outbox_provider_idx ON public.ticketing_email_outbox (provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- Held: the worker sends nothing more for this campaign until staff resume it. After a
-- resume, only what is sent from then on counts toward holding it again.
ALTER TABLE public.ticketing_campaigns
  ADD COLUMN held_at timestamptz,
  ADD COLUMN resumed_at timestamptz,
  ADD COLUMN held_reason text CHECK (held_reason IN ('bounces', 'complaints')),
  ADD CONSTRAINT ticketing_campaigns_held_ck CHECK ((held_at IS NULL) = (held_reason IS NULL));
