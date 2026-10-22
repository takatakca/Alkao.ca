-- ALKAO Run 97: presales and discount coupons, for any event (a festival, a food fair, a
-- clothing sale, a market over one to three days).
--
-- 1. A presale ticket ("Adulte — Prévente") is an ordinary ticket type tied to the regular one
--    it undercuts (presale_of). Its price must stay below the regular price, and it must end:
--    on a date (sales_end_at), after a number of tickets (quantity_limit, "the first 200"), or
--    both. Being an ordinary type, it is held, paid, scanned and refunded like any other.
-- 2. A quantity limit counts tickets across the whole event, all sessions together: reserved
--    with the hold, sold when the hold becomes a paid order, released when the hold ends or
--    the order is refunded in full. As for add-on stock (Run 49), a cart is refused past the
--    limit and a payment never is. Holds past their deadline that the sweeper has not closed
--    yet never take a ticket from a buyer.
-- 3. A promo code can be shown as a coupon on the event's page and on alkao.ca (public), with a
--    short label ("Coupon prévente"). A private code stays a code people must be given.
-- 4. Three event categories for the events ALKAO now sells: food, fashion, markets and fairs.

ALTER TABLE public.ticketing_ticket_types
  ADD COLUMN presale_of uuid,
  ADD COLUMN sales_end_at timestamptz,
  ADD COLUMN quantity_limit integer CHECK (quantity_limit BETWEEN 1 AND 1000000);
ALTER TABLE public.ticketing_ticket_types
  ADD CONSTRAINT ticketing_ticket_types_presale_fkey FOREIGN KEY (presale_of, event_id, client_id, brand_id)
    REFERENCES public.ticketing_ticket_types (id, event_id, client_id, brand_id) ON DELETE RESTRICT,
  ADD CONSTRAINT ticketing_ticket_types_presale_self_ck CHECK (presale_of IS NULL OR presale_of <> id),
  -- A presale ends, by date or by quantity.
  ADD CONSTRAINT ticketing_ticket_types_presale_ends_ck CHECK (presale_of IS NULL OR sales_end_at IS NOT NULL OR quantity_limit IS NOT NULL),
  ADD CONSTRAINT ticketing_ticket_types_quantity_limit_ck CHECK (quantity_limit IS NULL OR kind = 'admission');
CREATE INDEX ticketing_ticket_types_presale_idx ON public.ticketing_ticket_types (presale_of) WHERE presale_of IS NOT NULL;

-- A presale is cheaper than the ticket it undercuts, of the same kind, and that ticket is a
-- regular one (no presale of a presale). Changing the regular price checks its presales too.
CREATE OR REPLACE FUNCTION alkao_private.ticketing_ticket_types_presale_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  regular record;
BEGIN
  IF NEW.presale_of IS NOT NULL THEN
    SELECT t.kind, t.price_cents, t.presale_of INTO regular
    FROM public.ticketing_ticket_types t WHERE t.id = NEW.presale_of;
    IF regular.presale_of IS NOT NULL OR regular.kind <> NEW.kind THEN
      RAISE EXCEPTION 'presale_of_invalid' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.price_cents >= regular.price_cents THEN
      RAISE EXCEPTION 'presale_price_not_lower' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.price_cents IS DISTINCT FROM OLD.price_cents AND EXISTS (
    SELECT 1 FROM public.ticketing_ticket_types p WHERE p.presale_of = NEW.id AND p.price_cents >= NEW.price_cents
  ) THEN
    RAISE EXCEPTION 'presale_price_not_lower' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.presale_of IS NULL AND OLD.presale_of IS NULL AND EXISTS (
    SELECT 1 FROM public.ticketing_ticket_types p WHERE p.presale_of = NEW.id AND p.kind <> NEW.kind
  ) THEN
    RAISE EXCEPTION 'presale_of_invalid' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION alkao_private.ticketing_ticket_types_presale_check() FROM PUBLIC;
CREATE TRIGGER ticketing_ticket_types_presale_check BEFORE INSERT OR UPDATE ON public.ticketing_ticket_types
  FOR EACH ROW EXECUTE FUNCTION alkao_private.ticketing_ticket_types_presale_check();

-- Tickets of a limited type, for the whole event.
CREATE TABLE public.ticketing_ticket_type_counts (
  ticket_type_id uuid PRIMARY KEY,
  client_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  event_id uuid NOT NULL,
  reserved_count integer NOT NULL DEFAULT 0 CHECK (reserved_count >= 0),
  sold_count integer NOT NULL DEFAULT 0 CHECK (sold_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticketing_ticket_type_counts_type_fkey FOREIGN KEY (ticket_type_id, event_id, client_id, brand_id)
    REFERENCES public.ticketing_ticket_types (id, event_id, client_id, brand_id) ON DELETE RESTRICT
);
CREATE INDEX ticketing_ticket_type_counts_tenant_idx ON public.ticketing_ticket_type_counts (client_id, brand_id, event_id);
ALTER TABLE public.ticketing_ticket_type_counts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ticketing_ticket_type_counts FROM PUBLIC, anon, authenticated;

-- Moves a limited type's counts; nothing for a type without a limit. Only a new reservation
-- checks the limit, and holds past their deadline do not count against it.
CREATE OR REPLACE FUNCTION alkao_private.ticketing_ticket_type_quota_move(
  p_type uuid, p_reserved integer, p_sold integer, p_check boolean)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  quota integer;
  reserved integer;
  sold integer;
  lapsed integer;
BEGIN
  SELECT t.quantity_limit INTO quota FROM public.ticketing_ticket_types t WHERE t.id = p_type;
  IF quota IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO public.ticketing_ticket_type_counts AS c (ticket_type_id, client_id, brand_id, event_id, reserved_count, sold_count)
  SELECT t.id, t.client_id, t.brand_id, t.event_id, GREATEST(p_reserved, 0), GREATEST(p_sold, 0)
  FROM public.ticketing_ticket_types t WHERE t.id = p_type
  ON CONFLICT (ticket_type_id) DO UPDATE
    SET reserved_count = GREATEST(c.reserved_count + p_reserved, 0),
        sold_count = GREATEST(c.sold_count + p_sold, 0),
        updated_at = now()
  RETURNING c.reserved_count, c.sold_count INTO reserved, sold;
  IF p_check THEN
    SELECT coalesce(sum(i.quantity), 0)::int INTO lapsed
    FROM public.ticketing_hold_items i JOIN public.ticketing_holds h ON h.id = i.hold_id
    WHERE i.ticket_type_id = p_type AND h.status = 'active' AND h.expires_at <= now();
    IF reserved - lapsed + sold > quota THEN
      RAISE EXCEPTION 'ticket_type_sold_out' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION alkao_private.ticketing_ticket_type_quota_move(uuid, integer, integer, boolean) FROM PUBLIC;

-- Reserved with the hold. The trigger's name sorts after the add-on stock one, so locks are
-- always taken session row, add-on stock row, then this row (no deadlock between them).
CREATE OR REPLACE FUNCTION alkao_private.ticketing_hold_items_quota()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  PERFORM alkao_private.ticketing_ticket_type_quota_move(NEW.ticket_type_id, NEW.quantity, 0, true);
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION alkao_private.ticketing_hold_items_quota() FROM PUBLIC;
CREATE TRIGGER ticketing_hold_items_quota AFTER INSERT ON public.ticketing_hold_items
  FOR EACH ROW EXECUTE FUNCTION alkao_private.ticketing_hold_items_quota();

-- A hold that ends gives its reservation back; one that became a paid order turns it into a sale.
CREATE OR REPLACE FUNCTION alkao_private.ticketing_holds_quota()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF OLD.status = 'active' AND NEW.status <> 'active' THEN
    PERFORM alkao_private.ticketing_ticket_type_quota_move(
      i.ticket_type_id, -i.quantity, CASE WHEN NEW.status = 'converted' THEN i.quantity ELSE 0 END, false)
    FROM public.ticketing_hold_items i WHERE i.hold_id = NEW.id
    ORDER BY i.ticket_type_id;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION alkao_private.ticketing_holds_quota() FROM PUBLIC;
CREATE TRIGGER ticketing_holds_inventory_quota AFTER UPDATE OF status ON public.ticketing_holds
  FOR EACH ROW EXECUTE FUNCTION alkao_private.ticketing_holds_quota();

-- A payment whose hold had already ended is counted now; a full refund gives the tickets back.
-- A session change (exchange order) moves nothing: the event's count is the same.
CREATE OR REPLACE FUNCTION alkao_private.ticketing_orders_quota()
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
    PERFORM alkao_private.ticketing_ticket_type_quota_move(l.ticket_type_id, 0, l.quantity, false)
    FROM public.ticketing_order_lines l WHERE l.order_id = NEW.id AND l.kind = 'admission'
    ORDER BY l.ticket_type_id;
  ELSIF OLD.status IN ('paid', 'partially_refunded') AND NEW.status = 'refunded' THEN
    PERFORM alkao_private.ticketing_ticket_type_quota_move(l.ticket_type_id, 0, -l.quantity, false)
    FROM public.ticketing_order_lines l WHERE l.order_id = NEW.id AND l.kind = 'admission'
    ORDER BY l.ticket_type_id;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION alkao_private.ticketing_orders_quota() FROM PUBLIC;
CREATE TRIGGER ticketing_orders_quota AFTER UPDATE OF status ON public.ticketing_orders
  FOR EACH ROW EXECUTE FUNCTION alkao_private.ticketing_orders_quota();

-- Coupons: a promo code shown to every buyer, with its label.
ALTER TABLE public.ticketing_promo_codes
  ADD COLUMN public boolean NOT NULL DEFAULT false,
  ADD COLUMN label text CHECK (label IS NULL OR (length(btrim(label)) BETWEEN 1 AND 60 AND label !~ '[<>]'));
CREATE INDEX ticketing_promo_codes_public_idx ON public.ticketing_promo_codes (event_id) WHERE public AND active;

-- Categories for food, fashion, and markets and fairs.
ALTER TABLE public.ticketing_events DROP CONSTRAINT ticketing_events_category_check;
ALTER TABLE public.ticketing_events
  ADD CONSTRAINT ticketing_events_category_check CHECK (category IS NULL OR category IN (
    'concerts', 'festivals', 'sports', 'famille', 'plein-air', 'spectacles', 'soirees', 'experiences',
    'gastronomie', 'mode', 'marches'));
