-- ALKAO commerce: holds, buyers, orders, order lines and taxes, tickets, access tokens.
--
-- No payment-provider columns or tables here: Stripe Connect is Run 02.
-- No credential/QR or scan tables here: signed credentials and the scanner are Run 03.
--
-- Invariants enforced by the database (not only by the application):
--   * Inventory counters follow holds and tickets through triggers; the session capacity
--     CHECK rejects any write that would oversell.
--   * Holds, orders and tickets follow fixed state machines; history is never deleted.
--   * Order money is immutable after creation and must equal the sum of its lines/taxes.
--   * Refund totals never exceed the order total; commission refunds never exceed the
--     commission; both only grow.
--   * Tickets are issued only for paid orders, never beyond the purchased quantity.

-- ── Holds ───────────────────────────────────────────────────────────────────
CREATE TABLE public.ticketing_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  event_id uuid NOT NULL,
  session_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'converted', 'released', 'expired')),
  -- Capacity units reserved: the hold's admission count.
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 1000),
  expires_at timestamptz NOT NULL,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticketing_holds_session_fkey FOREIGN KEY (session_id, event_id, client_id, brand_id)
    REFERENCES public.ticketing_sessions (id, event_id, client_id, brand_id) ON DELETE RESTRICT,
  CONSTRAINT ticketing_holds_tenant_key UNIQUE (id, event_id, client_id, brand_id),
  CONSTRAINT ticketing_holds_session_key UNIQUE (id, session_id, client_id, brand_id),
  CONSTRAINT ticketing_holds_closed_ck CHECK ((status = 'active') = (closed_at IS NULL)),
  CONSTRAINT ticketing_holds_expiry_ck CHECK (expires_at > created_at)
);
CREATE INDEX ticketing_holds_active_idx ON public.ticketing_holds (session_id, expires_at)
  WHERE status = 'active';
CREATE INDEX ticketing_holds_tenant_idx ON public.ticketing_holds (client_id, brand_id, created_at);
ALTER TABLE public.ticketing_holds ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.ticketing_hold_items (
  hold_id uuid NOT NULL,
  client_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  event_id uuid NOT NULL,
  ticket_type_id uuid NOT NULL,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 1000),
  unit_price_cents integer NOT NULL CHECK (unit_price_cents >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (hold_id, ticket_type_id),
  CONSTRAINT ticketing_hold_items_hold_fkey FOREIGN KEY (hold_id, event_id, client_id, brand_id)
    REFERENCES public.ticketing_holds (id, event_id, client_id, brand_id) ON DELETE RESTRICT,
  CONSTRAINT ticketing_hold_items_type_fkey FOREIGN KEY (ticket_type_id, event_id, client_id, brand_id)
    REFERENCES public.ticketing_ticket_types (id, event_id, client_id, brand_id) ON DELETE RESTRICT
);
CREATE INDEX ticketing_hold_items_type_idx
  ON public.ticketing_hold_items (ticket_type_id, event_id, client_id, brand_id);
ALTER TABLE public.ticketing_hold_items ENABLE ROW LEVEL SECURITY;

-- ── Buyers (per Client and Brand: never shared across tenants) ──────────────
CREATE TABLE public.ticketing_buyers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  email text NOT NULL CHECK (length(email) <= 320 AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  email_normalized text GENERATED ALWAYS AS (lower(btrim(email))) STORED,
  full_name text CHECK (full_name IS NULL OR length(full_name) <= 200),
  phone text CHECK (phone IS NULL OR length(phone) <= 40),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticketing_buyers_brand_fkey FOREIGN KEY (brand_id, client_id)
    REFERENCES public.ticketing_brands (id, client_id) ON DELETE RESTRICT,
  CONSTRAINT ticketing_buyers_email_key UNIQUE (client_id, brand_id, email_normalized),
  CONSTRAINT ticketing_buyers_tenant_key UNIQUE (id, client_id, brand_id)
);
ALTER TABLE public.ticketing_buyers ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER ticketing_buyers_touch BEFORE UPDATE ON public.ticketing_buyers
  FOR EACH ROW EXECUTE FUNCTION alkao_private.touch_updated_at();

-- ── Orders ──────────────────────────────────────────────────────────────────
CREATE TABLE public.ticketing_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  event_id uuid NOT NULL,
  session_id uuid NOT NULL,
  hold_id uuid UNIQUE,
  buyer_id uuid NOT NULL,
  reference text NOT NULL UNIQUE CHECK (reference ~ '^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$'),
  status text NOT NULL DEFAULT 'pending_payment' CHECK (status IN (
    'pending_payment', 'paid', 'partially_refunded', 'refunded', 'cancelled', 'expired'
  )),
  currency text NOT NULL DEFAULT 'CAD' CHECK (currency = 'CAD'),
  subtotal_cents integer NOT NULL CHECK (subtotal_cents >= 0),
  tax_cents integer NOT NULL CHECK (tax_cents >= 0),
  total_cents integer NOT NULL CHECK (total_cents >= 0),
  commission_cents integer NOT NULL DEFAULT 0 CHECK (commission_cents >= 0),
  refunded_cents integer NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0),
  commission_refunded_cents integer NOT NULL DEFAULT 0 CHECK (commission_refunded_cents >= 0),
  paid_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticketing_orders_session_fkey FOREIGN KEY (session_id, event_id, client_id, brand_id)
    REFERENCES public.ticketing_sessions (id, event_id, client_id, brand_id) ON DELETE RESTRICT,
  CONSTRAINT ticketing_orders_hold_fkey FOREIGN KEY (hold_id, session_id, client_id, brand_id)
    REFERENCES public.ticketing_holds (id, session_id, client_id, brand_id) ON DELETE RESTRICT,
  CONSTRAINT ticketing_orders_buyer_fkey FOREIGN KEY (buyer_id, client_id, brand_id)
    REFERENCES public.ticketing_buyers (id, client_id, brand_id) ON DELETE RESTRICT,
  CONSTRAINT ticketing_orders_tenant_key UNIQUE (id, event_id, client_id, brand_id),
  CONSTRAINT ticketing_orders_session_key UNIQUE (id, session_id, event_id, client_id, brand_id),
  CONSTRAINT ticketing_orders_total_ck CHECK (total_cents = subtotal_cents + tax_cents),
  CONSTRAINT ticketing_orders_commission_ck CHECK (commission_cents <= total_cents),
  CONSTRAINT ticketing_orders_refund_ck CHECK (refunded_cents <= total_cents),
  CONSTRAINT ticketing_orders_commission_refund_ck CHECK (commission_refunded_cents <= commission_cents),
  CONSTRAINT ticketing_orders_paid_at_ck CHECK (
    (status IN ('paid', 'partially_refunded', 'refunded')) = (paid_at IS NOT NULL)
  ),
  CONSTRAINT ticketing_orders_refund_status_ck CHECK (
    CASE status
      WHEN 'refunded' THEN refunded_cents = total_cents AND commission_refunded_cents = commission_cents
      WHEN 'partially_refunded' THEN refunded_cents > 0 AND refunded_cents < total_cents
      ELSE refunded_cents = 0 AND commission_refunded_cents = 0
    END
  )
);
CREATE INDEX ticketing_orders_tenant_idx ON public.ticketing_orders (client_id, brand_id, created_at);
CREATE INDEX ticketing_orders_session_idx ON public.ticketing_orders (session_id, status);
CREATE INDEX ticketing_orders_buyer_idx ON public.ticketing_orders (buyer_id, client_id, brand_id);
ALTER TABLE public.ticketing_orders ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.ticketing_order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL,
  client_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  event_id uuid NOT NULL,
  ticket_type_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('admission', 'add_on')),
  code_snapshot text NOT NULL,
  name_snapshot text NOT NULL,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 1000),
  unit_price_cents integer NOT NULL CHECK (unit_price_cents >= 0),
  line_total_cents integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticketing_order_lines_order_fkey FOREIGN KEY (order_id, event_id, client_id, brand_id)
    REFERENCES public.ticketing_orders (id, event_id, client_id, brand_id) ON DELETE RESTRICT,
  CONSTRAINT ticketing_order_lines_type_fkey FOREIGN KEY (ticket_type_id, event_id, client_id, brand_id)
    REFERENCES public.ticketing_ticket_types (id, event_id, client_id, brand_id) ON DELETE RESTRICT,
  CONSTRAINT ticketing_order_lines_type_key UNIQUE (order_id, ticket_type_id),
  CONSTRAINT ticketing_order_lines_ticket_key UNIQUE (id, order_id, ticket_type_id, client_id, brand_id),
  CONSTRAINT ticketing_order_lines_total_ck CHECK (line_total_cents = quantity * unit_price_cents)
);
CREATE INDEX ticketing_order_lines_type_idx
  ON public.ticketing_order_lines (ticket_type_id, event_id, client_id, brand_id);
CREATE INDEX ticketing_order_lines_tenant_idx ON public.ticketing_order_lines (client_id, brand_id);
ALTER TABLE public.ticketing_order_lines ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.ticketing_order_taxes (
  order_id uuid NOT NULL,
  client_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  event_id uuid NOT NULL,
  code text NOT NULL CHECK (code IN ('GST', 'QST')),
  rate_ppm integer NOT NULL CHECK (rate_ppm BETWEEN 0 AND 1000000),
  taxable_cents integer NOT NULL CHECK (taxable_cents >= 0),
  amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  PRIMARY KEY (order_id, code),
  CONSTRAINT ticketing_order_taxes_order_fkey FOREIGN KEY (order_id, event_id, client_id, brand_id)
    REFERENCES public.ticketing_orders (id, event_id, client_id, brand_id) ON DELETE RESTRICT
);
CREATE INDEX ticketing_order_taxes_tenant_idx ON public.ticketing_order_taxes (client_id, brand_id);
ALTER TABLE public.ticketing_order_taxes ENABLE ROW LEVEL SECURITY;

-- ── Tickets (stable admission identities; credentials come in Run 03) ───────
CREATE TABLE public.ticketing_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  event_id uuid NOT NULL,
  session_id uuid NOT NULL,
  order_id uuid NOT NULL,
  order_line_id uuid NOT NULL,
  ticket_type_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'valid' CHECK (status IN ('valid', 'void')),
  void_reason text CHECK (void_reason IN ('refunded', 'cancelled', 'reissued', 'admin')),
  voided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticketing_tickets_order_fkey FOREIGN KEY (order_id, session_id, event_id, client_id, brand_id)
    REFERENCES public.ticketing_orders (id, session_id, event_id, client_id, brand_id) ON DELETE RESTRICT,
  CONSTRAINT ticketing_tickets_line_fkey FOREIGN KEY (order_line_id, order_id, ticket_type_id, client_id, brand_id)
    REFERENCES public.ticketing_order_lines (id, order_id, ticket_type_id, client_id, brand_id) ON DELETE RESTRICT,
  CONSTRAINT ticketing_tickets_void_ck CHECK (
    (status = 'void') = (voided_at IS NOT NULL AND void_reason IS NOT NULL)
    AND (status = 'valid') = (voided_at IS NULL AND void_reason IS NULL)
  )
);
CREATE INDEX ticketing_tickets_order_idx
  ON public.ticketing_tickets (order_id, session_id, event_id, client_id, brand_id);
CREATE INDEX ticketing_tickets_line_idx
  ON public.ticketing_tickets (order_line_id, order_id, ticket_type_id, client_id, brand_id);
CREATE INDEX ticketing_tickets_session_idx ON public.ticketing_tickets (session_id, status);
CREATE INDEX ticketing_tickets_tenant_idx ON public.ticketing_tickets (client_id, brand_id);
ALTER TABLE public.ticketing_tickets ENABLE ROW LEVEL SECURITY;

-- ── Access tokens (hashes of buyer-held secrets). Server-only. ──────────────
CREATE TABLE public.ticketing_access_tokens (
  token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
  client_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  subject_type text NOT NULL CHECK (subject_type IN ('hold', 'order')),
  subject_id uuid NOT NULL,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticketing_access_tokens_brand_fkey FOREIGN KEY (brand_id, client_id)
    REFERENCES public.ticketing_brands (id, client_id) ON DELETE RESTRICT,
  CONSTRAINT ticketing_access_tokens_subject_key UNIQUE (subject_type, subject_id)
);
CREATE INDEX ticketing_access_tokens_tenant_idx ON public.ticketing_access_tokens (client_id, brand_id);
ALTER TABLE public.ticketing_access_tokens ENABLE ROW LEVEL SECURITY;

-- ════════════════════════════════════════════════════════════════════════════
-- Invariant triggers
-- ════════════════════════════════════════════════════════════════════════════

-- History tables are never deleted from.
CREATE TRIGGER ticketing_holds_no_delete BEFORE DELETE ON public.ticketing_holds
  FOR EACH ROW EXECUTE FUNCTION alkao_private.reject_mutation();
CREATE TRIGGER ticketing_hold_items_immutable BEFORE UPDATE OR DELETE ON public.ticketing_hold_items
  FOR EACH ROW EXECUTE FUNCTION alkao_private.reject_mutation();
CREATE TRIGGER ticketing_orders_no_delete BEFORE DELETE ON public.ticketing_orders
  FOR EACH ROW EXECUTE FUNCTION alkao_private.reject_mutation();
CREATE TRIGGER ticketing_order_lines_immutable BEFORE UPDATE OR DELETE ON public.ticketing_order_lines
  FOR EACH ROW EXECUTE FUNCTION alkao_private.reject_mutation();
CREATE TRIGGER ticketing_order_taxes_immutable BEFORE UPDATE OR DELETE ON public.ticketing_order_taxes
  FOR EACH ROW EXECUTE FUNCTION alkao_private.reject_mutation();
CREATE TRIGGER ticketing_tickets_no_delete BEFORE DELETE ON public.ticketing_tickets
  FOR EACH ROW EXECUTE FUNCTION alkao_private.reject_mutation();

-- ── Holds: lifecycle + reserved_count ───────────────────────────────────────
CREATE OR REPLACE FUNCTION alkao_private.ticketing_holds_before()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  session_status text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' OR NEW.closed_at IS NOT NULL THEN
      RAISE EXCEPTION 'hold_must_start_active' USING ERRCODE = 'check_violation';
    END IF;
    SELECT s.status INTO session_status
    FROM public.ticketing_sessions s
    WHERE s.id = NEW.session_id;
    IF session_status IS DISTINCT FROM 'on_sale' THEN
      RAISE EXCEPTION 'session_not_on_sale' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.client_id <> OLD.client_id OR NEW.brand_id <> OLD.brand_id
     OR NEW.event_id <> OLD.event_id OR NEW.session_id <> OLD.session_id
     OR NEW.quantity <> OLD.quantity OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'hold_fields_immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> OLD.status THEN
    IF OLD.status <> 'active' THEN
      RAISE EXCEPTION 'hold_already_closed' USING ERRCODE = 'check_violation';
    END IF;
    NEW.closed_at := now();
  ELSIF NEW.status <> 'active' AND NEW.expires_at <> OLD.expires_at THEN
    RAISE EXCEPTION 'hold_already_closed' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION alkao_private.ticketing_holds_before() FROM PUBLIC;
CREATE TRIGGER ticketing_holds_before BEFORE INSERT OR UPDATE ON public.ticketing_holds
  FOR EACH ROW EXECUTE FUNCTION alkao_private.ticketing_holds_before();

CREATE OR REPLACE FUNCTION alkao_private.ticketing_holds_inventory()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.ticketing_sessions
    SET reserved_count = reserved_count + NEW.quantity
    WHERE id = NEW.session_id;
  ELSIF OLD.status = 'active' AND NEW.status <> 'active' THEN
    UPDATE public.ticketing_sessions
    SET reserved_count = reserved_count - OLD.quantity
    WHERE id = OLD.session_id;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION alkao_private.ticketing_holds_inventory() FROM PUBLIC;
CREATE TRIGGER ticketing_holds_inventory AFTER INSERT OR UPDATE OF status ON public.ticketing_holds
  FOR EACH ROW EXECUTE FUNCTION alkao_private.ticketing_holds_inventory();

-- Items may only be added while the hold is active.
CREATE OR REPLACE FUNCTION alkao_private.ticketing_hold_items_before_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.ticketing_holds h WHERE h.id = NEW.hold_id AND h.status = 'active'
  ) THEN
    RAISE EXCEPTION 'hold_not_active' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION alkao_private.ticketing_hold_items_before_insert() FROM PUBLIC;
CREATE TRIGGER ticketing_hold_items_before_insert BEFORE INSERT ON public.ticketing_hold_items
  FOR EACH ROW EXECUTE FUNCTION alkao_private.ticketing_hold_items_before_insert();

-- At commit: a hold's quantity equals the sum of its admission items.
CREATE OR REPLACE FUNCTION alkao_private.ticketing_holds_check_items()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  -- One function serves two tables: read the key through jsonb so either row type works.
  target uuid := (to_jsonb(NEW) ->> CASE TG_TABLE_NAME WHEN 'ticketing_holds' THEN 'id' ELSE 'hold_id' END)::uuid;
  expected integer;
  admissions integer;
BEGIN
  SELECT h.quantity INTO expected FROM public.ticketing_holds h WHERE h.id = target;
  SELECT coalesce(sum(i.quantity), 0) INTO admissions
  FROM public.ticketing_hold_items i
  JOIN public.ticketing_ticket_types t ON t.id = i.ticket_type_id
  WHERE i.hold_id = target AND t.kind = 'admission';
  IF admissions <> expected THEN
    RAISE EXCEPTION 'hold_quantity_mismatch' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION alkao_private.ticketing_holds_check_items() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER ticketing_holds_check_items AFTER INSERT ON public.ticketing_holds
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION alkao_private.ticketing_holds_check_items();
CREATE CONSTRAINT TRIGGER ticketing_hold_items_check_items AFTER INSERT ON public.ticketing_hold_items
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION alkao_private.ticketing_holds_check_items();

-- ── Orders: lifecycle, immutable money, monotonic refunds ───────────────────
CREATE OR REPLACE FUNCTION alkao_private.ticketing_orders_before()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending_payment' OR NEW.refunded_cents <> 0
       OR NEW.commission_refunded_cents <> 0 OR NEW.paid_at IS NOT NULL
       OR NEW.closed_at IS NOT NULL THEN
      RAISE EXCEPTION 'order_must_start_pending' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.client_id <> OLD.client_id OR NEW.brand_id <> OLD.brand_id
     OR NEW.event_id <> OLD.event_id OR NEW.session_id <> OLD.session_id
     OR NEW.hold_id IS DISTINCT FROM OLD.hold_id OR NEW.buyer_id <> OLD.buyer_id
     OR NEW.reference <> OLD.reference OR NEW.currency <> OLD.currency
     OR NEW.subtotal_cents <> OLD.subtotal_cents OR NEW.tax_cents <> OLD.tax_cents
     OR NEW.total_cents <> OLD.total_cents OR NEW.commission_cents <> OLD.commission_cents
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'order_fields_immutable' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.refunded_cents < OLD.refunded_cents
     OR NEW.commission_refunded_cents < OLD.commission_refunded_cents THEN
    RAISE EXCEPTION 'order_refunds_monotonic' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.paid_at IS DISTINCT FROM OLD.paid_at AND OLD.paid_at IS NOT NULL THEN
    RAISE EXCEPTION 'order_fields_immutable' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'pending_payment' AND NEW.status IN ('paid', 'cancelled', 'expired'))
    OR (OLD.status = 'paid' AND NEW.status IN ('partially_refunded', 'refunded'))
    OR (OLD.status = 'partially_refunded' AND NEW.status = 'refunded')
  ) THEN
    RAISE EXCEPTION 'order_invalid_transition' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status IN ('cancelled', 'expired', 'refunded') AND OLD.status <> NEW.status THEN
    NEW.closed_at := now();
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION alkao_private.ticketing_orders_before() FROM PUBLIC;
CREATE TRIGGER ticketing_orders_before BEFORE INSERT OR UPDATE ON public.ticketing_orders
  FOR EACH ROW EXECUTE FUNCTION alkao_private.ticketing_orders_before();

-- Lines and taxes may only be added while the order awaits payment.
CREATE OR REPLACE FUNCTION alkao_private.ticketing_order_children_before_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.ticketing_orders o
    WHERE o.id = NEW.order_id AND o.status = 'pending_payment'
  ) THEN
    RAISE EXCEPTION 'order_not_pending' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_TABLE_NAME = 'ticketing_order_lines' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.ticketing_ticket_types t
      WHERE t.id = (to_jsonb(NEW) ->> 'ticket_type_id')::uuid AND t.kind = to_jsonb(NEW) ->> 'kind'
    ) THEN
      RAISE EXCEPTION 'order_line_kind_mismatch' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION alkao_private.ticketing_order_children_before_insert() FROM PUBLIC;
CREATE TRIGGER ticketing_order_lines_before_insert BEFORE INSERT ON public.ticketing_order_lines
  FOR EACH ROW EXECUTE FUNCTION alkao_private.ticketing_order_children_before_insert();
CREATE TRIGGER ticketing_order_taxes_before_insert BEFORE INSERT ON public.ticketing_order_taxes
  FOR EACH ROW EXECUTE FUNCTION alkao_private.ticketing_order_children_before_insert();

-- At commit: order money equals its lines and taxes, and admissions match the hold.
CREATE OR REPLACE FUNCTION alkao_private.ticketing_orders_check_totals()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  target uuid := (to_jsonb(NEW) ->> CASE TG_TABLE_NAME WHEN 'ticketing_orders' THEN 'id' ELSE 'order_id' END)::uuid;
  o public.ticketing_orders%ROWTYPE;
  lines_total bigint;
  taxes_total bigint;
  admissions bigint;
  hold_quantity integer;
BEGIN
  SELECT * INTO o FROM public.ticketing_orders WHERE id = target;
  SELECT coalesce(sum(l.line_total_cents), 0),
         coalesce(sum(l.quantity) FILTER (WHERE l.kind = 'admission'), 0)
    INTO lines_total, admissions
  FROM public.ticketing_order_lines l WHERE l.order_id = target;
  SELECT coalesce(sum(t.amount_cents), 0) INTO taxes_total
  FROM public.ticketing_order_taxes t WHERE t.order_id = target;

  IF lines_total <> o.subtotal_cents THEN
    RAISE EXCEPTION 'order_subtotal_mismatch' USING ERRCODE = 'check_violation';
  END IF;
  IF taxes_total <> o.tax_cents THEN
    RAISE EXCEPTION 'order_tax_mismatch' USING ERRCODE = 'check_violation';
  END IF;
  IF admissions < 1 THEN
    RAISE EXCEPTION 'order_without_admission' USING ERRCODE = 'check_violation';
  END IF;
  IF o.hold_id IS NOT NULL THEN
    SELECT h.quantity INTO hold_quantity FROM public.ticketing_holds h WHERE h.id = o.hold_id;
    IF hold_quantity <> admissions THEN
      RAISE EXCEPTION 'order_hold_quantity_mismatch' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION alkao_private.ticketing_orders_check_totals() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER ticketing_orders_check_totals AFTER INSERT ON public.ticketing_orders
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION alkao_private.ticketing_orders_check_totals();
CREATE CONSTRAINT TRIGGER ticketing_order_lines_check_totals AFTER INSERT ON public.ticketing_order_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION alkao_private.ticketing_orders_check_totals();
CREATE CONSTRAINT TRIGGER ticketing_order_taxes_check_totals AFTER INSERT ON public.ticketing_order_taxes
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION alkao_private.ticketing_orders_check_totals();

-- ── Tickets: issuance rules, lifecycle, sold_count ──────────────────────────
CREATE OR REPLACE FUNCTION alkao_private.ticketing_tickets_before()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  order_status text;
  line_kind text;
  line_quantity integer;
  issued integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'valid' THEN
      RAISE EXCEPTION 'ticket_must_start_valid' USING ERRCODE = 'check_violation';
    END IF;
    -- Serialize issuance per order so concurrent writers cannot exceed the quantity.
    SELECT o.status INTO order_status
    FROM public.ticketing_orders o WHERE o.id = NEW.order_id FOR UPDATE;
    IF order_status NOT IN ('paid', 'partially_refunded') THEN
      RAISE EXCEPTION 'ticket_requires_paid_order' USING ERRCODE = 'check_violation';
    END IF;
    SELECT l.kind, l.quantity INTO line_kind, line_quantity
    FROM public.ticketing_order_lines l WHERE l.id = NEW.order_line_id;
    IF line_kind <> 'admission' THEN
      RAISE EXCEPTION 'ticket_requires_admission_line' USING ERRCODE = 'check_violation';
    END IF;
    SELECT count(*) INTO issued
    FROM public.ticketing_tickets t WHERE t.order_line_id = NEW.order_line_id;
    IF issued >= line_quantity THEN
      RAISE EXCEPTION 'ticket_quantity_exceeded' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.client_id <> OLD.client_id OR NEW.brand_id <> OLD.brand_id
     OR NEW.event_id <> OLD.event_id OR NEW.session_id <> OLD.session_id
     OR NEW.order_id <> OLD.order_id OR NEW.order_line_id <> OLD.order_line_id
     OR NEW.ticket_type_id <> OLD.ticket_type_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'ticket_fields_immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'void' AND (NEW.status <> 'void'
      OR NEW.void_reason IS DISTINCT FROM OLD.void_reason
      OR NEW.voided_at IS DISTINCT FROM OLD.voided_at) THEN
    RAISE EXCEPTION 'ticket_void_is_final' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION alkao_private.ticketing_tickets_before() FROM PUBLIC;
CREATE TRIGGER ticketing_tickets_before BEFORE INSERT OR UPDATE ON public.ticketing_tickets
  FOR EACH ROW EXECUTE FUNCTION alkao_private.ticketing_tickets_before();

CREATE OR REPLACE FUNCTION alkao_private.ticketing_tickets_inventory()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.ticketing_sessions SET sold_count = sold_count + 1 WHERE id = NEW.session_id;
  ELSIF OLD.status = 'valid' AND NEW.status = 'void' THEN
    UPDATE public.ticketing_sessions SET sold_count = sold_count - 1 WHERE id = OLD.session_id;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION alkao_private.ticketing_tickets_inventory() FROM PUBLIC;
CREATE TRIGGER ticketing_tickets_inventory AFTER INSERT OR UPDATE OF status ON public.ticketing_tickets
  FOR EACH ROW EXECUTE FUNCTION alkao_private.ticketing_tickets_inventory();

-- ════════════════════════════════════════════════════════════════════════════
-- Grants and policies
-- ════════════════════════════════════════════════════════════════════════════
REVOKE ALL ON TABLE
  public.ticketing_holds,
  public.ticketing_hold_items,
  public.ticketing_buyers,
  public.ticketing_orders,
  public.ticketing_order_lines,
  public.ticketing_order_taxes,
  public.ticketing_tickets,
  public.ticketing_access_tokens
FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE
  public.ticketing_holds,
  public.ticketing_hold_items,
  public.ticketing_buyers,
  public.ticketing_orders,
  public.ticketing_order_lines,
  public.ticketing_order_taxes,
  public.ticketing_tickets
TO authenticated;

CREATE POLICY ticketing_holds_member_read ON public.ticketing_holds
  FOR SELECT TO authenticated
  USING (alkao_private.is_client_member(client_id));

CREATE POLICY ticketing_hold_items_member_read ON public.ticketing_hold_items
  FOR SELECT TO authenticated
  USING (alkao_private.is_client_member(client_id));

CREATE POLICY ticketing_tickets_member_read ON public.ticketing_tickets
  FOR SELECT TO authenticated
  USING (alkao_private.is_client_member(client_id));

-- Buyer personal data and order money: owner, admin, manager only.
CREATE POLICY ticketing_buyers_manager_read ON public.ticketing_buyers
  FOR SELECT TO authenticated
  USING (alkao_private.has_client_role(client_id, ARRAY['owner', 'admin', 'manager']));

CREATE POLICY ticketing_orders_manager_read ON public.ticketing_orders
  FOR SELECT TO authenticated
  USING (alkao_private.has_client_role(client_id, ARRAY['owner', 'admin', 'manager']));

CREATE POLICY ticketing_order_lines_manager_read ON public.ticketing_order_lines
  FOR SELECT TO authenticated
  USING (alkao_private.has_client_role(client_id, ARRAY['owner', 'admin', 'manager']));

CREATE POLICY ticketing_order_taxes_manager_read ON public.ticketing_order_taxes
  FOR SELECT TO authenticated
  USING (alkao_private.has_client_role(client_id, ARRAY['owner', 'admin', 'manager']));

-- ticketing_access_tokens: intentionally no policy and no grant.
