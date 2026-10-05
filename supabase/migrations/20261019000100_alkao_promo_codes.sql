-- ALKAO Run 36: promo codes (owner decision, docs/ALKAO_DECISIONS.md).
-- A code belongs to one event: a percentage or a fixed amount off the order's pre-tax
-- subtotal, with an optional number of uses and dates. Taxes and the TAKATAK commission are
-- computed on the discounted subtotal. Existing orders keep discount_cents = 0.

CREATE TABLE public.ticketing_promo_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  event_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[A-Z0-9-]{3,32}$'),
  kind text NOT NULL CHECK (kind IN ('percent', 'amount')),
  percent integer CHECK (percent BETWEEN 1 AND 100),
  amount_cents integer CHECK (amount_cents BETWEEN 1 AND 10000000),
  max_uses integer CHECK (max_uses IS NULL OR max_uses BETWEEN 1 AND 1000000),
  -- Orders created with the code and not expired or cancelled (paid or waiting for payment).
  used_count integer NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  starts_at timestamptz,
  ends_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticketing_promo_codes_event_fkey FOREIGN KEY (event_id, client_id, brand_id)
    REFERENCES public.ticketing_events (id, client_id, brand_id) ON DELETE RESTRICT,
  CONSTRAINT ticketing_promo_codes_code_key UNIQUE (event_id, code),
  CONSTRAINT ticketing_promo_codes_tenant_key UNIQUE (id, client_id, brand_id),
  CONSTRAINT ticketing_promo_codes_value_ck CHECK (
    (kind = 'percent') = (percent IS NOT NULL) AND (kind = 'amount') = (amount_cents IS NOT NULL)
  ),
  CONSTRAINT ticketing_promo_codes_window_ck CHECK (starts_at IS NULL OR ends_at IS NULL OR starts_at < ends_at),
  CONSTRAINT ticketing_promo_codes_uses_ck CHECK (max_uses IS NULL OR used_count <= max_uses)
);
CREATE INDEX ticketing_promo_codes_tenant_idx ON public.ticketing_promo_codes (client_id, brand_id, event_id);
ALTER TABLE public.ticketing_promo_codes ENABLE ROW LEVEL SECURITY;
-- Server only: no grant and no policy for anon or authenticated.
REVOKE ALL ON TABLE public.ticketing_promo_codes FROM PUBLIC, anon, authenticated;
CREATE TRIGGER ticketing_promo_codes_touch BEFORE UPDATE ON public.ticketing_promo_codes
  FOR EACH ROW EXECUTE FUNCTION alkao_private.touch_updated_at();

-- The code a buyer entered travels with the hold, then with the order.
ALTER TABLE public.ticketing_holds ADD COLUMN promo_code_id uuid;
ALTER TABLE public.ticketing_holds
  ADD CONSTRAINT ticketing_holds_promo_fkey FOREIGN KEY (promo_code_id, client_id, brand_id)
  REFERENCES public.ticketing_promo_codes (id, client_id, brand_id) ON DELETE RESTRICT;

ALTER TABLE public.ticketing_orders
  ADD COLUMN discount_cents integer NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  ADD COLUMN promo_code_id uuid;
ALTER TABLE public.ticketing_orders
  ADD CONSTRAINT ticketing_orders_promo_fkey FOREIGN KEY (promo_code_id, client_id, brand_id)
  REFERENCES public.ticketing_promo_codes (id, client_id, brand_id) ON DELETE RESTRICT;
-- Money still adds up: the total is the subtotal less the discount, plus taxes.
ALTER TABLE public.ticketing_orders DROP CONSTRAINT ticketing_orders_total_ck;
ALTER TABLE public.ticketing_orders
  ADD CONSTRAINT ticketing_orders_total_ck CHECK (total_cents = subtotal_cents - discount_cents + tax_cents),
  ADD CONSTRAINT ticketing_orders_discount_ck CHECK (discount_cents <= subtotal_cents AND (discount_cents = 0 OR promo_code_id IS NOT NULL));
CREATE INDEX ticketing_orders_promo_idx ON public.ticketing_orders (promo_code_id) WHERE promo_code_id IS NOT NULL;

-- The discount and the code are fixed once the order exists, like the rest of its money.
CREATE OR REPLACE FUNCTION alkao_private.ticketing_orders_promo_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.discount_cents <> OLD.discount_cents OR NEW.promo_code_id IS DISTINCT FROM OLD.promo_code_id THEN
    RAISE EXCEPTION 'order_fields_immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION alkao_private.ticketing_orders_promo_immutable() FROM PUBLIC;
CREATE TRIGGER ticketing_orders_promo_immutable BEFORE UPDATE ON public.ticketing_orders
  FOR EACH ROW EXECUTE FUNCTION alkao_private.ticketing_orders_promo_immutable();

-- Uses follow orders: one more when an order is created with the code (refused past
-- max_uses by ticketing_promo_codes_uses_ck), one less if that order expires or is
-- cancelled before payment. A refund does not give the use back.
CREATE OR REPLACE FUNCTION alkao_private.ticketing_orders_promo_uses()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.promo_code_id IS NOT NULL THEN
      UPDATE public.ticketing_promo_codes SET used_count = used_count + 1 WHERE id = NEW.promo_code_id;
    END IF;
  ELSIF NEW.promo_code_id IS NOT NULL AND OLD.status = 'pending_payment' AND NEW.status IN ('expired', 'cancelled') THEN
    UPDATE public.ticketing_promo_codes SET used_count = used_count - 1 WHERE id = NEW.promo_code_id;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION alkao_private.ticketing_orders_promo_uses() FROM PUBLIC;
CREATE TRIGGER ticketing_orders_promo_uses AFTER INSERT OR UPDATE OF status ON public.ticketing_orders
  FOR EACH ROW EXECUTE FUNCTION alkao_private.ticketing_orders_promo_uses();
