-- ALKAO Run 02: payments with Stripe Connect direct charges.
--
-- Each TAKATAK Client sells through its own Stripe account (separate finances). Buyers pay
-- the Client directly; the TAKATAK transactional commission is the application fee.
--
-- Invariants enforced here:
--   * A payment equals its order: amount = order total, application fee = commission.
--   * Payments and refunds follow fixed state machines; their money never changes.
--   * At most one refund per order is in flight.
--   * At commit, an order's refunded totals equal the sum of its succeeded refunds.

-- ── Connected accounts (one per Client) ─────────────────────────────────────
CREATE TABLE public.ticketing_payment_accounts (
  client_id uuid PRIMARY KEY REFERENCES public.ticketing_clients (id) ON DELETE RESTRICT,
  provider text NOT NULL DEFAULT 'stripe' CHECK (provider = 'stripe'),
  stripe_account_id text NOT NULL UNIQUE CHECK (stripe_account_id ~ '^acct_[A-Za-z0-9]+$'),
  charges_enabled boolean NOT NULL DEFAULT false,
  payouts_enabled boolean NOT NULL DEFAULT false,
  details_submitted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticketing_payment_accounts_client_account_key UNIQUE (client_id, stripe_account_id)
);
ALTER TABLE public.ticketing_payment_accounts ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER ticketing_payment_accounts_touch BEFORE UPDATE ON public.ticketing_payment_accounts
  FOR EACH ROW EXECUTE FUNCTION alkao_private.touch_updated_at();

CREATE OR REPLACE FUNCTION alkao_private.ticketing_payment_accounts_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.client_id <> OLD.client_id OR NEW.stripe_account_id <> OLD.stripe_account_id THEN
    RAISE EXCEPTION 'payment_account_immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION alkao_private.ticketing_payment_accounts_immutable() FROM PUBLIC;
CREATE TRIGGER ticketing_payment_accounts_immutable BEFORE UPDATE ON public.ticketing_payment_accounts
  FOR EACH ROW EXECUTE FUNCTION alkao_private.ticketing_payment_accounts_immutable();

-- ── Brand checkout settings ─────────────────────────────────────────────────
-- Buyers return to the Brand's own site after Stripe Checkout; only these origins are
-- accepted as success/cancel URLs (no open redirect).
CREATE OR REPLACE FUNCTION alkao_private.valid_https_origins(origins text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT coalesce(bool_and(o ~ '^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:[0-9]{1,5})?$'), true)
         AND coalesce(array_length(origins, 1), 0) <= 10
  FROM unnest(origins) AS o
$$;
REVOKE ALL ON FUNCTION alkao_private.valid_https_origins(text[]) FROM PUBLIC;

CREATE TABLE public.ticketing_brand_settings (
  client_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  checkout_return_origins text[] NOT NULL DEFAULT '{}'
    CHECK (alkao_private.valid_https_origins(checkout_return_origins)),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, brand_id),
  CONSTRAINT ticketing_brand_settings_brand_fkey FOREIGN KEY (brand_id, client_id)
    REFERENCES public.ticketing_brands (id, client_id) ON DELETE CASCADE
);
ALTER TABLE public.ticketing_brand_settings ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER ticketing_brand_settings_touch BEFORE UPDATE ON public.ticketing_brand_settings
  FOR EACH ROW EXECUTE FUNCTION alkao_private.touch_updated_at();

-- ── Payments (one Stripe Checkout per order) ────────────────────────────────
CREATE TABLE public.ticketing_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  event_id uuid NOT NULL,
  order_id uuid NOT NULL UNIQUE,
  provider text NOT NULL DEFAULT 'stripe' CHECK (provider = 'stripe'),
  stripe_account_id text NOT NULL,
  checkout_session_id text UNIQUE CHECK (checkout_session_id ~ '^cs_[A-Za-z0-9_]+$'),
  checkout_url text CHECK (checkout_url ~ '^https://'),
  payment_intent_id text UNIQUE CHECK (payment_intent_id ~ '^pi_[A-Za-z0-9_]+$'),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  application_fee_cents integer NOT NULL CHECK (application_fee_cents >= 0),
  currency text NOT NULL DEFAULT 'CAD' CHECK (currency = 'CAD'),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'expired')),
  expires_at timestamptz NOT NULL,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticketing_payments_order_fkey FOREIGN KEY (order_id, event_id, client_id, brand_id)
    REFERENCES public.ticketing_orders (id, event_id, client_id, brand_id) ON DELETE RESTRICT,
  CONSTRAINT ticketing_payments_account_fkey FOREIGN KEY (client_id, stripe_account_id)
    REFERENCES public.ticketing_payment_accounts (client_id, stripe_account_id) ON DELETE RESTRICT,
  CONSTRAINT ticketing_payments_fee_ck CHECK (application_fee_cents <= amount_cents),
  CONSTRAINT ticketing_payments_paid_ck CHECK ((status = 'paid') = (paid_at IS NOT NULL AND payment_intent_id IS NOT NULL))
);
CREATE INDEX ticketing_payments_order_idx ON public.ticketing_payments (order_id, event_id, client_id, brand_id);
CREATE INDEX ticketing_payments_tenant_idx ON public.ticketing_payments (client_id, brand_id, created_at);
ALTER TABLE public.ticketing_payments ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION alkao_private.ticketing_payments_before()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  o public.ticketing_orders%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO o FROM public.ticketing_orders WHERE id = NEW.order_id;
    IF NEW.status <> 'open' OR NEW.paid_at IS NOT NULL THEN
      RAISE EXCEPTION 'payment_must_start_open' USING ERRCODE = 'check_violation';
    END IF;
    IF o.status <> 'pending_payment' THEN
      RAISE EXCEPTION 'order_not_pending' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.amount_cents <> o.total_cents OR NEW.application_fee_cents <> o.commission_cents THEN
      RAISE EXCEPTION 'payment_amount_mismatch' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.client_id <> OLD.client_id OR NEW.brand_id <> OLD.brand_id OR NEW.event_id <> OLD.event_id
     OR NEW.order_id <> OLD.order_id OR NEW.stripe_account_id <> OLD.stripe_account_id
     OR NEW.amount_cents <> OLD.amount_cents OR NEW.application_fee_cents <> OLD.application_fee_cents
     OR NEW.currency <> OLD.currency OR NEW.created_at <> OLD.created_at
     OR (OLD.checkout_session_id IS NOT NULL AND NEW.checkout_session_id IS DISTINCT FROM OLD.checkout_session_id)
     OR (OLD.payment_intent_id IS NOT NULL AND NEW.payment_intent_id IS DISTINCT FROM OLD.payment_intent_id) THEN
    RAISE EXCEPTION 'payment_fields_immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (OLD.status = 'open' AND NEW.status IN ('paid', 'expired')) THEN
    RAISE EXCEPTION 'payment_invalid_transition' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION alkao_private.ticketing_payments_before() FROM PUBLIC;
CREATE TRIGGER ticketing_payments_before BEFORE INSERT OR UPDATE ON public.ticketing_payments
  FOR EACH ROW EXECUTE FUNCTION alkao_private.ticketing_payments_before();
CREATE TRIGGER ticketing_payments_no_delete BEFORE DELETE ON public.ticketing_payments
  FOR EACH ROW EXECUTE FUNCTION alkao_private.reject_mutation();

-- ── Refunds ─────────────────────────────────────────────────────────────────
CREATE TABLE public.ticketing_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  event_id uuid NOT NULL,
  order_id uuid NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  commission_refund_cents integer NOT NULL CHECK (commission_refund_cents >= 0),
  reason text CHECK (reason IS NULL OR length(reason) <= 500),
  void_ticket_ids uuid[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'canceled')),
  stripe_refund_id text UNIQUE CHECK (stripe_refund_id ~ '^re_[A-Za-z0-9_]+$'),
  stripe_fee_refund_id text UNIQUE CHECK (stripe_fee_refund_id ~ '^fr_[A-Za-z0-9_]+$'),
  last_error text,
  requested_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT ticketing_refunds_order_fkey FOREIGN KEY (order_id, event_id, client_id, brand_id)
    REFERENCES public.ticketing_orders (id, event_id, client_id, brand_id) ON DELETE RESTRICT,
  CONSTRAINT ticketing_refunds_completed_ck CHECK ((status = 'succeeded') = (completed_at IS NOT NULL)),
  CONSTRAINT ticketing_refunds_fee_ck CHECK (commission_refund_cents <= amount_cents)
);
CREATE UNIQUE INDEX ticketing_refunds_one_pending ON public.ticketing_refunds (order_id) WHERE status = 'pending';
CREATE INDEX ticketing_refunds_order_idx ON public.ticketing_refunds (order_id, event_id, client_id, brand_id);
CREATE INDEX ticketing_refunds_tenant_idx ON public.ticketing_refunds (client_id, brand_id, created_at);
ALTER TABLE public.ticketing_refunds ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION alkao_private.ticketing_refunds_before()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR NEW.completed_at IS NOT NULL THEN
      RAISE EXCEPTION 'refund_must_start_pending' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.client_id <> OLD.client_id OR NEW.brand_id <> OLD.brand_id OR NEW.event_id <> OLD.event_id
     OR NEW.order_id <> OLD.order_id OR NEW.amount_cents <> OLD.amount_cents
     OR NEW.commission_refund_cents <> OLD.commission_refund_cents
     OR NEW.void_ticket_ids <> OLD.void_ticket_ids OR NEW.requested_by <> OLD.requested_by
     OR NEW.created_at <> OLD.created_at
     OR (OLD.stripe_refund_id IS NOT NULL AND NEW.stripe_refund_id IS DISTINCT FROM OLD.stripe_refund_id)
     OR (OLD.stripe_fee_refund_id IS NOT NULL AND NEW.stripe_fee_refund_id IS DISTINCT FROM OLD.stripe_fee_refund_id) THEN
    RAISE EXCEPTION 'refund_fields_immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (OLD.status = 'pending' AND NEW.status IN ('succeeded', 'canceled')) THEN
    RAISE EXCEPTION 'refund_invalid_transition' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'succeeded' AND OLD.status = 'pending' THEN
    NEW.completed_at := now();
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION alkao_private.ticketing_refunds_before() FROM PUBLIC;
CREATE TRIGGER ticketing_refunds_before BEFORE INSERT OR UPDATE ON public.ticketing_refunds
  FOR EACH ROW EXECUTE FUNCTION alkao_private.ticketing_refunds_before();
CREATE TRIGGER ticketing_refunds_no_delete BEFORE DELETE ON public.ticketing_refunds
  FOR EACH ROW EXECUTE FUNCTION alkao_private.reject_mutation();

-- At commit: order refund totals equal the sum of its succeeded refunds.
CREATE OR REPLACE FUNCTION alkao_private.ticketing_refunds_check_totals()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  target uuid := (to_jsonb(NEW) ->> CASE TG_TABLE_NAME WHEN 'ticketing_orders' THEN 'id' ELSE 'order_id' END)::uuid;
  refunded bigint;
  commission_refunded bigint;
  o public.ticketing_orders%ROWTYPE;
BEGIN
  SELECT * INTO o FROM public.ticketing_orders WHERE id = target;
  SELECT coalesce(sum(amount_cents), 0), coalesce(sum(commission_refund_cents), 0)
    INTO refunded, commission_refunded
  FROM public.ticketing_refunds WHERE order_id = target AND status = 'succeeded';
  IF refunded <> o.refunded_cents OR commission_refunded <> o.commission_refunded_cents THEN
    RAISE EXCEPTION 'order_refund_ledger_mismatch' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION alkao_private.ticketing_refunds_check_totals() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER ticketing_refunds_check_totals AFTER INSERT OR UPDATE ON public.ticketing_refunds
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION alkao_private.ticketing_refunds_check_totals();
CREATE CONSTRAINT TRIGGER ticketing_orders_check_refund_ledger
  AFTER UPDATE OF refunded_cents, commission_refunded_cents ON public.ticketing_orders
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION alkao_private.ticketing_refunds_check_totals();

-- ── Provider webhook inbox (idempotency). Server-only. ──────────────────────
CREATE TABLE public.ticketing_payment_events (
  event_id text PRIMARY KEY CHECK (event_id ~ '^evt_[A-Za-z0-9_]+$'),
  type text NOT NULL,
  stripe_account_id text,
  client_id uuid,
  received_at timestamptz NOT NULL DEFAULT now(),
  outcome text NOT NULL CHECK (outcome IN ('processed', 'ignored'))
);
ALTER TABLE public.ticketing_payment_events ENABLE ROW LEVEL SECURITY;

-- ── Grants and policies ─────────────────────────────────────────────────────
REVOKE ALL ON TABLE
  public.ticketing_payment_accounts,
  public.ticketing_brand_settings,
  public.ticketing_payments,
  public.ticketing_refunds,
  public.ticketing_payment_events
FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE
  public.ticketing_payment_accounts,
  public.ticketing_brand_settings,
  public.ticketing_payments,
  public.ticketing_refunds
TO authenticated;

CREATE POLICY ticketing_payment_accounts_admin_read ON public.ticketing_payment_accounts
  FOR SELECT TO authenticated
  USING (alkao_private.has_client_role(client_id, ARRAY['owner', 'admin']));

CREATE POLICY ticketing_brand_settings_member_read ON public.ticketing_brand_settings
  FOR SELECT TO authenticated
  USING (alkao_private.is_client_member(client_id));

CREATE POLICY ticketing_payments_manager_read ON public.ticketing_payments
  FOR SELECT TO authenticated
  USING (alkao_private.has_client_role(client_id, ARRAY['owner', 'admin', 'manager']));

CREATE POLICY ticketing_refunds_manager_read ON public.ticketing_refunds
  FOR SELECT TO authenticated
  USING (alkao_private.has_client_role(client_id, ARRAY['owner', 'admin', 'manager']));

-- ticketing_payment_events: intentionally no policy and no grant.
