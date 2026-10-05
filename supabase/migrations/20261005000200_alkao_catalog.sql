-- ALKAO catalog: venues, events, sessions (inventory), ticket types and add-ons.
--
-- Tenant integrity: every business-scoped row carries client_id AND brand_id, and every
-- parent reference is a composite foreign key that includes them, so a row can never
-- point at another Client's or another Brand's parent.

-- ── Venues ──────────────────────────────────────────────────────────────────
CREATE TABLE public.ticketing_venues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  address_line1 text,
  city text,
  region text,
  postal_code text,
  country text NOT NULL DEFAULT 'CA' CHECK (country ~ '^[A-Z]{2}$'),
  timezone text NOT NULL DEFAULT 'America/Toronto',
  -- Place-of-supply tax region. Extend together with src/domain/tax.ts.
  tax_region text NOT NULL DEFAULT 'CA-QC' CHECK (tax_region IN ('CA-QC')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticketing_venues_brand_fkey FOREIGN KEY (brand_id, client_id)
    REFERENCES public.ticketing_brands (id, client_id) ON DELETE RESTRICT,
  CONSTRAINT ticketing_venues_tenant_key UNIQUE (id, client_id, brand_id)
);
CREATE INDEX ticketing_venues_tenant_idx ON public.ticketing_venues (client_id, brand_id);
ALTER TABLE public.ticketing_venues ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER ticketing_venues_touch BEFORE UPDATE ON public.ticketing_venues
  FOR EACH ROW EXECUTE FUNCTION alkao_private.touch_updated_at();

-- ── Events ──────────────────────────────────────────────────────────────────
CREATE TABLE public.ticketing_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  venue_id uuid NOT NULL,
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 80),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  description text,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published', 'cancelled', 'archived')),
  sales_open_at timestamptz,
  sales_close_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticketing_events_brand_fkey FOREIGN KEY (brand_id, client_id)
    REFERENCES public.ticketing_brands (id, client_id) ON DELETE RESTRICT,
  CONSTRAINT ticketing_events_venue_fkey FOREIGN KEY (venue_id, client_id, brand_id)
    REFERENCES public.ticketing_venues (id, client_id, brand_id) ON DELETE RESTRICT,
  CONSTRAINT ticketing_events_slug_key UNIQUE (client_id, brand_id, slug),
  CONSTRAINT ticketing_events_tenant_key UNIQUE (id, client_id, brand_id),
  CONSTRAINT ticketing_events_sales_window_ck
    CHECK (sales_open_at IS NULL OR sales_close_at IS NULL OR sales_open_at < sales_close_at)
);
CREATE INDEX ticketing_events_tenant_idx ON public.ticketing_events (client_id, brand_id, status);
CREATE INDEX ticketing_events_venue_idx ON public.ticketing_events (venue_id, client_id, brand_id);
ALTER TABLE public.ticketing_events ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER ticketing_events_touch BEFORE UPDATE ON public.ticketing_events
  FOR EACH ROW EXECUTE FUNCTION alkao_private.touch_updated_at();

-- ── Sessions (time slots) with inventory counters ───────────────────────────
-- reserved_count is maintained by triggers on ticketing_holds; sold_count by triggers on
-- ticketing_tickets. The capacity CHECK makes overselling impossible, even under
-- concurrent writers (each counter update takes the session row lock).
CREATE TABLE public.ticketing_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  event_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  capacity integer NOT NULL CHECK (capacity BETWEEN 0 AND 1000000),
  reserved_count integer NOT NULL DEFAULT 0 CHECK (reserved_count >= 0),
  sold_count integer NOT NULL DEFAULT 0 CHECK (sold_count >= 0),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'on_sale', 'paused', 'cancelled', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticketing_sessions_event_fkey FOREIGN KEY (event_id, client_id, brand_id)
    REFERENCES public.ticketing_events (id, client_id, brand_id) ON DELETE RESTRICT,
  CONSTRAINT ticketing_sessions_capacity_ck CHECK (reserved_count + sold_count <= capacity),
  CONSTRAINT ticketing_sessions_time_ck CHECK (ends_at IS NULL OR ends_at > starts_at),
  CONSTRAINT ticketing_sessions_start_key UNIQUE (event_id, starts_at),
  CONSTRAINT ticketing_sessions_tenant_key UNIQUE (id, event_id, client_id, brand_id)
);
CREATE INDEX ticketing_sessions_tenant_idx ON public.ticketing_sessions (client_id, brand_id, starts_at);
ALTER TABLE public.ticketing_sessions ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER ticketing_sessions_touch BEFORE UPDATE ON public.ticketing_sessions
  FOR EACH ROW EXECUTE FUNCTION alkao_private.touch_updated_at();

-- ── Ticket types (admissions and add-ons) ───────────────────────────────────
-- min_quantity applies only when the type is selected (FAMILY: 3, GROUP: 15).
-- max_adults_in_order: when this type is selected, the order may hold at most N
-- counts_as_adult admissions (FESTI-ICE FAMILY: 2).
-- add_on_scope 'per_admission': quantity must equal the order's admission count
-- (FESTI-ICE FLEX_WEATHER).
CREATE TABLE public.ticketing_ticket_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  event_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[A-Z0-9_]{1,40}$'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  description text,
  kind text NOT NULL DEFAULT 'admission' CHECK (kind IN ('admission', 'add_on')),
  price_cents integer NOT NULL CHECK (price_cents BETWEEN 0 AND 10000000),
  min_quantity integer NOT NULL DEFAULT 0 CHECK (min_quantity >= 0),
  max_quantity integer NOT NULL CHECK (max_quantity BETWEEN 1 AND 1000),
  max_adults_in_order integer CHECK (max_adults_in_order >= 0),
  counts_as_adult boolean NOT NULL DEFAULT false,
  add_on_scope text CHECK (add_on_scope IN ('per_admission')),
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticketing_ticket_types_event_fkey FOREIGN KEY (event_id, client_id, brand_id)
    REFERENCES public.ticketing_events (id, client_id, brand_id) ON DELETE RESTRICT,
  CONSTRAINT ticketing_ticket_types_code_key UNIQUE (event_id, code),
  CONSTRAINT ticketing_ticket_types_tenant_key UNIQUE (id, event_id, client_id, brand_id),
  CONSTRAINT ticketing_ticket_types_quantity_ck CHECK (min_quantity <= max_quantity),
  CONSTRAINT ticketing_ticket_types_kind_ck CHECK (
    (kind = 'admission' AND add_on_scope IS NULL)
    OR (kind = 'add_on' AND add_on_scope IS NOT NULL AND NOT counts_as_adult
        AND max_adults_in_order IS NULL)
  )
);
CREATE INDEX ticketing_ticket_types_tenant_idx
  ON public.ticketing_ticket_types (client_id, brand_id, event_id);
ALTER TABLE public.ticketing_ticket_types ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER ticketing_ticket_types_touch BEFORE UPDATE ON public.ticketing_ticket_types
  FOR EACH ROW EXECUTE FUNCTION alkao_private.touch_updated_at();

-- ── Grants and policies ─────────────────────────────────────────────────────
REVOKE ALL ON TABLE
  public.ticketing_venues,
  public.ticketing_events,
  public.ticketing_sessions,
  public.ticketing_ticket_types
FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE
  public.ticketing_venues,
  public.ticketing_events,
  public.ticketing_sessions,
  public.ticketing_ticket_types
TO authenticated;

CREATE POLICY ticketing_venues_member_read ON public.ticketing_venues
  FOR SELECT TO authenticated
  USING (alkao_private.is_client_member(client_id));

CREATE POLICY ticketing_events_member_read ON public.ticketing_events
  FOR SELECT TO authenticated
  USING (alkao_private.is_client_member(client_id));

CREATE POLICY ticketing_sessions_member_read ON public.ticketing_sessions
  FOR SELECT TO authenticated
  USING (alkao_private.is_client_member(client_id));

CREATE POLICY ticketing_ticket_types_member_read ON public.ticketing_ticket_types
  FOR SELECT TO authenticated
  USING (alkao_private.is_client_member(client_id));
