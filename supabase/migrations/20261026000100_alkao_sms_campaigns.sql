-- ALKAO Run 46: campaigns by text message (SMS), through Twilio. Same rules as e-mail
-- (Canada's anti-spam law): only customers who may receive it (a booking in the last 2
-- years), the Brand named, and "STOP" to unsubscribe in every message (handled by Twilio and
-- recorded on the customer through Twilio's webhook).

ALTER TABLE public.ticketing_campaigns
  ADD COLUMN channel text NOT NULL DEFAULT 'email' CHECK (channel IN ('email', 'sms'));
ALTER TABLE public.ticketing_campaigns
  -- A text stays short (the footer is added when sent); automations are e-mail only for now.
  ADD CONSTRAINT ticketing_campaigns_sms_ck CHECK (channel = 'email' OR (char_length(body) <= 300 AND kind = 'one_time' AND cta_label IS NULL));
-- A text carries a link without a button label.
ALTER TABLE public.ticketing_campaigns DROP CONSTRAINT ticketing_campaigns_cta_ck;
ALTER TABLE public.ticketing_campaigns
  ADD CONSTRAINT ticketing_campaigns_cta_ck CHECK (channel = 'sms' OR (cta_label IS NULL) = (cta_url IS NULL));

-- A message goes to an e-mail address or to a mobile number (digits, North American: 10).
ALTER TABLE public.ticketing_campaign_messages ALTER COLUMN email DROP NOT NULL;
ALTER TABLE public.ticketing_campaign_messages
  ADD COLUMN phone text CHECK (phone ~ '^[0-9]{10,15}$'),
  ADD CONSTRAINT ticketing_campaign_messages_address_ck CHECK ((email IS NULL) <> (phone IS NULL));
CREATE INDEX ticketing_campaign_messages_sms_due_idx ON public.ticketing_campaign_messages (next_attempt_at)
  WHERE status = 'pending' AND phone IS NOT NULL;
