-- ALKAO Run 72: presale codes.
--
-- An event's public sale opens at sales_open_at. A presale code lets the people who have it
-- (a fan club, members, a partner's clients) buy from an earlier time, opens_at. It changes
-- nothing else: same prices, same seats, same end of sales. The organizer turns a code off at
-- any time. No personal data.

CREATE TABLE public.ticketing_presale_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  event_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[A-Z0-9-]{3,32}$'),
  -- For the organizer: who the code is for ("Membres", "Fan club").
  label text CHECK (label IS NULL OR length(btrim(label)) BETWEEN 1 AND 80),
  opens_at timestamptz NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticketing_presale_codes_event_fkey FOREIGN KEY (event_id, client_id, brand_id)
    REFERENCES public.ticketing_events (id, client_id, brand_id) ON DELETE RESTRICT,
  CONSTRAINT ticketing_presale_codes_code_key UNIQUE (event_id, code),
  CONSTRAINT ticketing_presale_codes_tenant_key UNIQUE (id, client_id, brand_id)
);
CREATE INDEX ticketing_presale_codes_tenant_idx ON public.ticketing_presale_codes (client_id, brand_id, event_id);
-- Written and read by the server only.
ALTER TABLE public.ticketing_presale_codes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ticketing_presale_codes FROM PUBLIC, anon, authenticated;
