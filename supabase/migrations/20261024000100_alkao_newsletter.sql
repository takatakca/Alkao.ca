-- ALKAO Run 44: newsletter sign-up with a confirmation e-mail (double opt-in). A website
-- (Promo Havana) sends the address; ALKAO e-mails a link; the person confirms on ALKAO's
-- page, which records their express consent on the customer file (Canada's anti-spam law)
-- and shows the Brand's welcome code. Server-only table: RLS on, no grant, no policy.

ALTER TABLE public.ticketing_brand_settings
  -- The welcome offer shown once the sign-up is confirmed, e.g. HAVANA5, "5 % sur vos billets".
  ADD COLUMN newsletter_reward_code text CHECK (newsletter_reward_code ~ '^[A-Z0-9-]{3,32}$'),
  ADD COLUMN newsletter_reward_text text CHECK (char_length(newsletter_reward_text) BETWEEN 1 AND 200);

CREATE TABLE public.ticketing_newsletter_signups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  email text NOT NULL CHECK (email = lower(email) AND char_length(email) <= 320),
  first_name text CHECK (char_length(first_name) <= 120),
  language text NOT NULL DEFAULT 'fr' CHECK (language IN ('fr', 'en')),
  -- Where the sign-up came from (a website, a contest), for staff.
  source text CHECK (source ~ '^[a-z0-9][a-z0-9_.-]{0,59}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed')),
  confirmed_at timestamptz,
  customer_id uuid,
  -- Delivery of the confirmation e-mail.
  email_status text NOT NULL DEFAULT 'pending' CHECK (email_status IN ('pending', 'sent', 'skipped', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 100),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text CHECK (char_length(last_error) <= 500),
  provider_message_id text CHECK (char_length(provider_message_id) <= 200),
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticketing_newsletter_signups_brand_fkey FOREIGN KEY (brand_id, client_id)
    REFERENCES public.ticketing_brands (id, client_id) ON DELETE RESTRICT,
  CONSTRAINT ticketing_newsletter_signups_customer_fkey FOREIGN KEY (customer_id, client_id, brand_id)
    REFERENCES public.ticketing_customers (id, client_id, brand_id) ON DELETE RESTRICT,
  CONSTRAINT ticketing_newsletter_signups_confirmed_ck CHECK ((status = 'confirmed') = (confirmed_at IS NOT NULL)),
  CONSTRAINT ticketing_newsletter_signups_sent_ck CHECK ((email_status = 'sent') = (sent_at IS NOT NULL))
);
CREATE INDEX ticketing_newsletter_signups_due_idx ON public.ticketing_newsletter_signups (next_attempt_at) WHERE email_status = 'pending';
CREATE INDEX ticketing_newsletter_signups_email_idx ON public.ticketing_newsletter_signups (client_id, brand_id, email, created_at DESC);
ALTER TABLE public.ticketing_newsletter_signups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ticketing_newsletter_signups FROM PUBLIC, anon, authenticated;
CREATE TRIGGER ticketing_newsletter_signups_touch BEFORE UPDATE ON public.ticketing_newsletter_signups
  FOR EACH ROW EXECUTE FUNCTION alkao_private.touch_updated_at();
