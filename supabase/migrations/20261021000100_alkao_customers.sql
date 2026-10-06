-- ALKAO Run 41: the customer file (CRM) — who comes, how often, and how to reach them.
-- A customer belongs to one Client and Brand. Their bookings come from an outside system
-- (first: the Réservation camping.ca daily reports) and are deduplicated by the source's own
-- reference. A booking is never a payment record: no card, payment or tax detail is kept.
-- Both tables are server-only: RLS on, no grant, no policy for anon or authenticated.

CREATE TABLE public.ticketing_customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  first_name text CHECK (char_length(first_name) <= 120),
  last_name text CHECK (char_length(last_name) <= 120),
  -- Lower case, so the same address always finds the same customer.
  email text CHECK (email IS NULL OR (email = lower(email) AND char_length(email) <= 320 AND email LIKE '%_@_%')),
  -- Digits only (10 for North America).
  mobile_phone text CHECK (mobile_phone ~ '^[0-9]{10,15}$'),
  home_phone text CHECK (home_phone ~ '^[0-9]{10,15}$'),
  work_phone text CHECK (work_phone ~ '^[0-9]{10,15}$'),
  address_line text CHECK (char_length(address_line) <= 200),
  address_unit text CHECK (char_length(address_unit) <= 40),
  city text CHECK (char_length(city) <= 120),
  region text CHECK (char_length(region) <= 60),
  postal_code text CHECK (char_length(postal_code) <= 20),
  country text CHECK (country ~ '^[A-Z]{2}$'),
  -- The second person named on the booking.
  companion_name text CHECK (char_length(companion_name) <= 200),
  -- The date of the report the contact details come from: an older report never overwrites them.
  contact_as_of date,
  -- Marketing: express consent (e.g. a newsletter sign-up) and opt-outs. Implied consent
  -- (Canada's anti-spam law) is derived from the bookings, never stored.
  email_consent_at timestamptz,
  email_opt_out_at timestamptz,
  sms_opt_out_at timestamptz,
  -- Québec Law 25: personal fields wiped on request (city, region and country stay, for
  -- statistics); bookings stay, without anyone in them.
  anonymized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticketing_customers_brand_fkey FOREIGN KEY (brand_id, client_id)
    REFERENCES public.ticketing_brands (id, client_id) ON DELETE RESTRICT,
  CONSTRAINT ticketing_customers_tenant_key UNIQUE (id, client_id, brand_id),
  CONSTRAINT ticketing_customers_anonymized_ck CHECK (
    anonymized_at IS NULL OR (first_name IS NULL AND last_name IS NULL AND email IS NULL AND mobile_phone IS NULL
      AND home_phone IS NULL AND work_phone IS NULL AND address_line IS NULL AND address_unit IS NULL
      AND postal_code IS NULL AND companion_name IS NULL)
  )
);
ALTER TABLE public.ticketing_customers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ticketing_customers FROM PUBLIC, anon, authenticated;
CREATE TRIGGER ticketing_customers_touch BEFORE UPDATE ON public.ticketing_customers
  FOR EACH ROW EXECUTE FUNCTION alkao_private.touch_updated_at();
-- An import finds a returning customer by e-mail, phone, or postal code (then by name).
CREATE INDEX ticketing_customers_email_idx ON public.ticketing_customers (client_id, brand_id, email) WHERE email IS NOT NULL;
CREATE INDEX ticketing_customers_mobile_idx ON public.ticketing_customers (client_id, brand_id, mobile_phone) WHERE mobile_phone IS NOT NULL;
CREATE INDEX ticketing_customers_home_idx ON public.ticketing_customers (client_id, brand_id, home_phone) WHERE home_phone IS NOT NULL;
CREATE INDEX ticketing_customers_postal_idx ON public.ticketing_customers (client_id, brand_id, postal_code) WHERE postal_code IS NOT NULL;

CREATE TABLE public.ticketing_customer_bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  -- The system the booking comes from, and its own reference there (the reservation number).
  source text NOT NULL CHECK (source ~ '^[a-z][a-z0-9_]{1,39}$'),
  source_ref text NOT NULL CHECK (char_length(source_ref) BETWEEN 1 AND 80),
  -- What was booked: a lodging family (camping, chalet…) and the site or unit itself.
  category text NOT NULL CHECK (category IN ('camping', 'cabana', 'chalet', 'condo', 'villa', 'tent', 'coolbox', 'other')),
  item text CHECK (char_length(item) <= 80),
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  adults smallint NOT NULL DEFAULT 0 CHECK (adults BETWEEN 0 AND 500),
  children smallint NOT NULL DEFAULT 0 CHECK (children BETWEEN 0 AND 500),
  pets smallint NOT NULL DEFAULT 0 CHECK (pets BETWEEN 0 AND 100),
  group_booking boolean NOT NULL DEFAULT false,
  -- Taxes included, as the source reports it. Not a payment: nothing about how it was paid.
  total_cents integer NOT NULL DEFAULT 0 CHECK (total_cents BETWEEN 0 AND 100000000),
  -- First and last report that listed the booking. The first approximates the booking date.
  first_report_on date NOT NULL,
  last_report_on date NOT NULL,
  -- The guest checked in ("Arrivé"): such a booking is never taken for a cancelled one.
  checked_in boolean NOT NULL DEFAULT false,
  -- Set when a complete report no longer lists the booking while its arrival was still ahead.
  cancelled_on date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticketing_customer_bookings_customer_fkey FOREIGN KEY (customer_id, client_id, brand_id)
    REFERENCES public.ticketing_customers (id, client_id, brand_id) ON DELETE RESTRICT,
  CONSTRAINT ticketing_customer_bookings_source_key UNIQUE (client_id, brand_id, source, source_ref),
  CONSTRAINT ticketing_customer_bookings_dates_ck CHECK (starts_on <= ends_on AND first_report_on <= last_report_on)
);
ALTER TABLE public.ticketing_customer_bookings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ticketing_customer_bookings FROM PUBLIC, anon, authenticated;
CREATE TRIGGER ticketing_customer_bookings_touch BEFORE UPDATE ON public.ticketing_customer_bookings
  FOR EACH ROW EXECUTE FUNCTION alkao_private.touch_updated_at();
CREATE INDEX ticketing_customer_bookings_customer_idx ON public.ticketing_customer_bookings (customer_id, starts_on);
CREATE INDEX ticketing_customer_bookings_upcoming_idx ON public.ticketing_customer_bookings (client_id, brand_id, source, starts_on)
  WHERE cancelled_on IS NULL;
