-- ALKAO Run 04: Flex Météo session change, as a linked exchange order.
--
-- An order that bought an add-on granting a session change (FESTI-ICE FLEX_WEATHER) may move
-- its valid tickets, once, to another session of the same event. The move is a separate
-- zero-amount exchange order: the money stays on the original order (and its Stripe payment),
-- the new tickets live on the exchange order, the original tickets are voided. Every existing
-- invariant (capacity, immutable money, ticket issuance, credentials) still applies.

ALTER TABLE public.ticketing_ticket_types
  ADD COLUMN grants_session_change boolean NOT NULL DEFAULT false;
ALTER TABLE public.ticketing_ticket_types
  ADD CONSTRAINT ticketing_ticket_types_session_change_ck CHECK (NOT grants_session_change OR kind = 'add_on');

ALTER TABLE public.ticketing_orders
  ADD COLUMN exchange_of_order_id uuid;
ALTER TABLE public.ticketing_orders
  ADD CONSTRAINT ticketing_orders_exchange_fkey FOREIGN KEY (exchange_of_order_id, event_id, client_id, brand_id)
    REFERENCES public.ticketing_orders (id, event_id, client_id, brand_id) ON DELETE RESTRICT,
  -- An exchange moves tickets; it never carries money or a hold.
  ADD CONSTRAINT ticketing_orders_exchange_ck CHECK (
    exchange_of_order_id IS NULL OR (total_cents = 0 AND commission_cents = 0 AND hold_id IS NULL)
  );
-- One change per original order.
CREATE UNIQUE INDEX ticketing_orders_one_exchange ON public.ticketing_orders (exchange_of_order_id)
  WHERE exchange_of_order_id IS NOT NULL;
CREATE INDEX ticketing_orders_exchange_idx ON public.ticketing_orders (exchange_of_order_id, event_id, client_id, brand_id);

-- The exchange link is immutable like the rest of an order's identity.
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
     OR NEW.created_at <> OLD.created_at
     OR NEW.exchange_of_order_id IS DISTINCT FROM OLD.exchange_of_order_id THEN
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
