-- ALKAO Run 49: add-ons sold the way a resort sells them, and where each sale came from.
--
-- 1. How many of an add-on an order may take:
--      per_admission     exactly one per person (FESTI-ICE Flex Météo, as before);
--      up_to_admissions  from 1 up to the number of people (a meal, the inflatables);
--      per_order         any quantity within its minimum and maximum (glow sticks).
-- 2. A stock per session (per evening) for an add-on, optional. A cart's add-ons are reserved
--    with its hold, counted as sold when the hold becomes an order, and released when the hold
--    expires or the order is refunded in full. A paid order is never refused for stock: a
--    payment that arrives after its hold expired is counted even if that goes over.
-- 3. The order keeps where the buyer came from (UTM tags, landing page), for the campaign report.

ALTER TABLE public.ticketing_ticket_types DROP CONSTRAINT ticketing_ticket_types_add_on_scope_check;
ALTER TABLE public.ticketing_ticket_types
  ADD CONSTRAINT ticketing_ticket_types_add_on_scope_check CHECK (add_on_scope IN ('per_admission', 'up_to_admissions', 'per_order'));

ALTER TABLE public.ticketing_ticket_types
  ADD COLUMN stock_per_session integer CHECK (stock_per_session BETWEEN 0 AND 100000);
ALTER TABLE public.ticketing_ticket_types
  ADD CONSTRAINT ticketing_ticket_types_stock_ck CHECK (stock_per_session IS NULL OR kind = 'add_on');

CREATE TABLE public.ticketing_add_on_stock (
  session_id uuid NOT NULL,
  ticket_type_id uuid NOT NULL,
  client_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  event_id uuid NOT NULL,
  reserved_count integer NOT NULL DEFAULT 0 CHECK (reserved_count >= 0),
  sold_count integer NOT NULL DEFAULT 0 CHECK (sold_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, ticket_type_id),
  CONSTRAINT ticketing_add_on_stock_session_fkey FOREIGN KEY (session_id, event_id, client_id, brand_id)
    REFERENCES public.ticketing_sessions (id, event_id, client_id, brand_id) ON DELETE RESTRICT,
  CONSTRAINT ticketing_add_on_stock_type_fkey FOREIGN KEY (ticket_type_id, event_id, client_id, brand_id)
    REFERENCES public.ticketing_ticket_types (id, event_id, client_id, brand_id) ON DELETE RESTRICT
);
CREATE INDEX ticketing_add_on_stock_tenant_idx ON public.ticketing_add_on_stock (client_id, brand_id);
CREATE INDEX ticketing_add_on_stock_type_idx ON public.ticketing_add_on_stock (ticket_type_id);
ALTER TABLE public.ticketing_add_on_stock ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ticketing_add_on_stock FROM PUBLIC, anon, authenticated;

-- Moves an add-on's counts for one session; nothing for an add-on without stock. Only a new
-- reservation checks the stock (a cart is refused, a payment never is).
CREATE OR REPLACE FUNCTION alkao_private.ticketing_add_on_stock_move(
  p_session uuid, p_type uuid, p_reserved integer, p_sold integer, p_check boolean)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  stock integer;
  reserved integer;
  sold integer;
BEGIN
  SELECT t.stock_per_session INTO stock FROM public.ticketing_ticket_types t WHERE t.id = p_type AND t.kind = 'add_on';
  IF stock IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO public.ticketing_add_on_stock AS a (session_id, ticket_type_id, client_id, brand_id, event_id, reserved_count, sold_count)
  SELECT p_session, t.id, t.client_id, t.brand_id, t.event_id, GREATEST(p_reserved, 0), GREATEST(p_sold, 0)
  FROM public.ticketing_ticket_types t WHERE t.id = p_type
  ON CONFLICT (session_id, ticket_type_id) DO UPDATE
    SET reserved_count = GREATEST(a.reserved_count + p_reserved, 0),
        sold_count = GREATEST(a.sold_count + p_sold, 0),
        updated_at = now()
  RETURNING a.reserved_count, a.sold_count INTO reserved, sold;
  IF p_check AND reserved + sold > stock THEN
    RAISE EXCEPTION 'add_on_sold_out' USING ERRCODE = 'check_violation';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION alkao_private.ticketing_add_on_stock_move(uuid, uuid, integer, integer, boolean) FROM PUBLIC;

-- A cart's add-ons are reserved with its hold.
CREATE OR REPLACE FUNCTION alkao_private.ticketing_hold_items_add_on_stock()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  PERFORM alkao_private.ticketing_add_on_stock_move(h.session_id, NEW.ticket_type_id, NEW.quantity, 0, true)
  FROM public.ticketing_holds h WHERE h.id = NEW.hold_id;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION alkao_private.ticketing_hold_items_add_on_stock() FROM PUBLIC;
CREATE TRIGGER ticketing_hold_items_add_on_stock AFTER INSERT ON public.ticketing_hold_items
  FOR EACH ROW EXECUTE FUNCTION alkao_private.ticketing_hold_items_add_on_stock();

-- A hold that ends gives its reservation back; one that became a paid order turns it into a sale.
-- The trigger's name sorts after ticketing_holds_inventory, so the session row is always locked
-- before the add-on's stock row, as when a hold is created (no deadlock between the two).
CREATE OR REPLACE FUNCTION alkao_private.ticketing_holds_add_on_stock()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF OLD.status = 'active' AND NEW.status <> 'active' THEN
    PERFORM alkao_private.ticketing_add_on_stock_move(
      NEW.session_id, i.ticket_type_id, -i.quantity, CASE WHEN NEW.status = 'converted' THEN i.quantity ELSE 0 END, false)
    FROM public.ticketing_hold_items i WHERE i.hold_id = NEW.id;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION alkao_private.ticketing_holds_add_on_stock() FROM PUBLIC;
CREATE TRIGGER ticketing_holds_inventory_add_ons AFTER UPDATE OF status ON public.ticketing_holds
  FOR EACH ROW EXECUTE FUNCTION alkao_private.ticketing_holds_add_on_stock();

-- A payment whose hold had already ended is counted now; a full refund puts the stock back.
-- A session change (exchange order) moves no add-on: they stay counted on the original session.
CREATE OR REPLACE FUNCTION alkao_private.ticketing_orders_add_on_stock()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.exchange_of_order_id IS NOT NULL OR NEW.status = OLD.status THEN
    RETURN NULL;
  END IF;
  IF OLD.status = 'pending_payment' AND NEW.status = 'paid'
     AND NOT EXISTS (SELECT 1 FROM public.ticketing_holds h WHERE h.id = NEW.hold_id AND h.status = 'converted') THEN
    PERFORM alkao_private.ticketing_add_on_stock_move(NEW.session_id, l.ticket_type_id, 0, l.quantity, false)
    FROM public.ticketing_order_lines l WHERE l.order_id = NEW.id AND l.kind = 'add_on';
  ELSIF OLD.status IN ('paid', 'partially_refunded') AND NEW.status = 'refunded' THEN
    PERFORM alkao_private.ticketing_add_on_stock_move(NEW.session_id, l.ticket_type_id, 0, -l.quantity, false)
    FROM public.ticketing_order_lines l WHERE l.order_id = NEW.id AND l.kind = 'add_on';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION alkao_private.ticketing_orders_add_on_stock() FROM PUBLIC;
CREATE TRIGGER ticketing_orders_add_on_stock AFTER UPDATE OF status ON public.ticketing_orders
  FOR EACH ROW EXECUTE FUNCTION alkao_private.ticketing_orders_add_on_stock();

-- Where the buyer came from: utm_source, utm_medium, utm_campaign, utm_content, utm_term and
-- the landing page, as the website passed them at checkout. Never personal data.
ALTER TABLE public.ticketing_orders
  ADD COLUMN attribution jsonb CHECK (attribution IS NULL OR (jsonb_typeof(attribution) = 'object' AND pg_column_size(attribution) <= 2048));
CREATE INDEX ticketing_orders_campaign_idx ON public.ticketing_orders (client_id, brand_id, paid_at)
  WHERE attribution IS NOT NULL AND paid_at IS NOT NULL;
