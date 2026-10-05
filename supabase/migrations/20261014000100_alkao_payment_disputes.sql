-- ALKAO Run 19: what Stripe reports about a paid order after the sale, outside ALKAO.
--
-- * Disputes (chargebacks): the buyer's bank takes the money back from the Client's account.
-- * Refunds made directly in the Client's Stripe dashboard: ALKAO keeps Stripe's running
--   total for the charge; the part ALKAO did not issue is a refund made outside ALKAO.
--
-- Both are recorded and shown to the Client's staff. Neither moves money nor cancels a
-- ticket by itself. Server-only tables (no Data API access), like the email outbox.

-- ── Disputes ────────────────────────────────────────────────────────────────
CREATE TABLE public.ticketing_payment_disputes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  event_id uuid NOT NULL,
  order_id uuid NOT NULL,
  -- dp_… today; any Stripe-style id is accepted so an unexpected prefix never blocks the webhook.
  stripe_dispute_id text NOT NULL UNIQUE CHECK (stripe_dispute_id ~ '^[a-z]+_[A-Za-z0-9_]+$' AND length(stripe_dispute_id) <= 255),
  amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  currency text NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  -- Stripe's own values, kept as text: Stripe may add new ones.
  reason text NOT NULL CHECK (length(reason) <= 100),
  status text NOT NULL CHECK (length(status) <= 100),
  evidence_due_by timestamptz,
  -- Time of the Stripe event last applied; an older event arriving late changes nothing.
  provider_updated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticketing_payment_disputes_order_fkey FOREIGN KEY (order_id, event_id, client_id, brand_id)
    REFERENCES public.ticketing_orders (id, event_id, client_id, brand_id) ON DELETE RESTRICT
);
CREATE INDEX ticketing_payment_disputes_order_idx ON public.ticketing_payment_disputes (order_id, event_id, client_id, brand_id);
CREATE INDEX ticketing_payment_disputes_tenant_idx ON public.ticketing_payment_disputes (client_id, brand_id, created_at);
ALTER TABLE public.ticketing_payment_disputes ENABLE ROW LEVEL SECURITY;

-- ── Stripe's refunded total per order ───────────────────────────────────────
CREATE TABLE public.ticketing_charge_refund_totals (
  order_id uuid PRIMARY KEY,
  client_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  event_id uuid NOT NULL,
  -- charge.amount_refunded: everything refunded on the charge, by ALKAO or not. Only grows.
  refunded_cents integer NOT NULL CHECK (refunded_cents >= 0),
  provider_updated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticketing_charge_refund_totals_order_fkey FOREIGN KEY (order_id, event_id, client_id, brand_id)
    REFERENCES public.ticketing_orders (id, event_id, client_id, brand_id) ON DELETE RESTRICT
);
CREATE INDEX ticketing_charge_refund_totals_tenant_idx ON public.ticketing_charge_refund_totals (client_id, brand_id);
ALTER TABLE public.ticketing_charge_refund_totals ENABLE ROW LEVEL SECURITY;

-- Rows never move to another order or Client, and are never deleted.
CREATE OR REPLACE FUNCTION alkao_private.ticketing_payment_reports_before()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.client_id <> OLD.client_id OR NEW.brand_id <> OLD.brand_id OR NEW.event_id <> OLD.event_id
     OR NEW.order_id <> OLD.order_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'payment_report_fields_immutable' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION alkao_private.ticketing_payment_reports_before() FROM PUBLIC;
CREATE TRIGGER ticketing_payment_disputes_before BEFORE UPDATE ON public.ticketing_payment_disputes
  FOR EACH ROW EXECUTE FUNCTION alkao_private.ticketing_payment_reports_before();
CREATE TRIGGER ticketing_payment_disputes_no_delete BEFORE DELETE ON public.ticketing_payment_disputes
  FOR EACH ROW EXECUTE FUNCTION alkao_private.reject_mutation();
CREATE TRIGGER ticketing_charge_refund_totals_before BEFORE UPDATE ON public.ticketing_charge_refund_totals
  FOR EACH ROW EXECUTE FUNCTION alkao_private.ticketing_payment_reports_before();
CREATE TRIGGER ticketing_charge_refund_totals_no_delete BEFORE DELETE ON public.ticketing_charge_refund_totals
  FOR EACH ROW EXECUTE FUNCTION alkao_private.reject_mutation();

REVOKE ALL ON TABLE public.ticketing_payment_disputes, public.ticketing_charge_refund_totals FROM PUBLIC, anon, authenticated;
-- Intentionally no policy and no grant: read through the admin API only.
