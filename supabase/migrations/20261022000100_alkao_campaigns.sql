-- ALKAO Run 42: e-mail campaigns to the customer file (Run 41), under Canada's anti-spam
-- law (CASL): only customers who may receive it (express consent, or implied for 2 years
-- after a booking), the sender identified with a mailing address and a way to reach them,
-- and an unsubscribe that works in one click. Both tables are server-only: RLS on, no
-- grant, no policy.

-- Who sends, as every campaign's footer says it (required before a campaign can go out).
ALTER TABLE public.ticketing_brand_settings
  ADD COLUMN marketing_sender_address text CHECK (char_length(marketing_sender_address) BETWEEN 5 AND 300),
  ADD COLUMN marketing_contact text CHECK (char_length(marketing_contact) BETWEEN 3 AND 200);

CREATE TABLE public.ticketing_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  -- For staff only; customers see the subject.
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  language text NOT NULL DEFAULT 'fr' CHECK (language IN ('fr', 'en')),
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 150),
  preheader text CHECK (char_length(preheader) <= 150),
  heading text NOT NULL CHECK (char_length(heading) BETWEEN 1 AND 150),
  -- Plain text written by staff: paragraphs split by blank lines, escaped when sent.
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 10000),
  image_url text CHECK (image_url ~ '^https://' AND char_length(image_url) <= 500),
  cta_label text CHECK (char_length(cta_label) BETWEEN 1 AND 60),
  cta_url text CHECK (cta_url ~ '^https://' AND char_length(cta_url) <= 500),
  -- Who gets it: customer segments and season statuses (Run 41); empty means all.
  audience_segments text[] NOT NULL DEFAULT '{}'
    CHECK (audience_segments <@ ARRAY['loyal', 'regular', 'occasional', 'one_time', 'upcoming', 'cancelled', 'prospect']),
  audience_statuses text[] NOT NULL DEFAULT '{}' CHECK (audience_statuses <@ ARRAY['active', 'lapsed', 'inactive']),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sending', 'sent', 'cancelled')),
  recipients integer NOT NULL DEFAULT 0 CHECK (recipients >= 0),
  queued_at timestamptz,
  finished_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticketing_campaigns_brand_fkey FOREIGN KEY (brand_id, client_id)
    REFERENCES public.ticketing_brands (id, client_id) ON DELETE RESTRICT,
  CONSTRAINT ticketing_campaigns_tenant_key UNIQUE (id, client_id, brand_id),
  CONSTRAINT ticketing_campaigns_cta_ck CHECK ((cta_label IS NULL) = (cta_url IS NULL)),
  CONSTRAINT ticketing_campaigns_queued_ck CHECK ((status = 'draft') = (queued_at IS NULL) OR status = 'cancelled')
);
ALTER TABLE public.ticketing_campaigns ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ticketing_campaigns FROM PUBLIC, anon, authenticated;
CREATE TRIGGER ticketing_campaigns_touch BEFORE UPDATE ON public.ticketing_campaigns
  FOR EACH ROW EXECUTE FUNCTION alkao_private.touch_updated_at();
CREATE INDEX ticketing_campaigns_tenant_idx ON public.ticketing_campaigns (client_id, brand_id, created_at DESC);

-- One row per recipient, taken when the campaign is sent (or a test, to a staff address).
CREATE TABLE public.ticketing_campaign_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  -- NULL for a test sent to staff.
  customer_id uuid,
  email text NOT NULL CHECK (email = lower(email) AND char_length(email) <= 320),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'skipped', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 100),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text CHECK (char_length(last_error) <= 500),
  provider_message_id text CHECK (char_length(provider_message_id) <= 200),
  sent_at timestamptz,
  unsubscribed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticketing_campaign_messages_campaign_fkey FOREIGN KEY (campaign_id, client_id, brand_id)
    REFERENCES public.ticketing_campaigns (id, client_id, brand_id) ON DELETE RESTRICT,
  CONSTRAINT ticketing_campaign_messages_customer_fkey FOREIGN KEY (customer_id, client_id, brand_id)
    REFERENCES public.ticketing_customers (id, client_id, brand_id) ON DELETE RESTRICT,
  CONSTRAINT ticketing_campaign_messages_sent_ck CHECK ((status = 'sent') = (sent_at IS NOT NULL))
);
-- A customer gets a campaign once.
CREATE UNIQUE INDEX ticketing_campaign_messages_once_idx ON public.ticketing_campaign_messages (campaign_id, customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX ticketing_campaign_messages_due_idx ON public.ticketing_campaign_messages (next_attempt_at) WHERE status = 'pending';
CREATE INDEX ticketing_campaign_messages_campaign_idx ON public.ticketing_campaign_messages (campaign_id, status);
ALTER TABLE public.ticketing_campaign_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ticketing_campaign_messages FROM PUBLIC, anon, authenticated;
CREATE TRIGGER ticketing_campaign_messages_touch BEFORE UPDATE ON public.ticketing_campaign_messages
  FOR EACH ROW EXECUTE FUNCTION alkao_private.touch_updated_at();
