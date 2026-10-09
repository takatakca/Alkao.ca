-- ALKAO Run 56: an add-on's stock per session follows the tickets through a session change.
--
-- Run 49 left a moved order's add-ons counted on the session it was bought for, so a meal
-- for Saturday stayed counted on Friday after the family moved: Friday showed fewer meals
-- left than it had, and Saturday could be sold past its stock. Now:
--
--   - a session change moves the original order's add-ons from the session the tickets leave
--     to the session they join, checked against the new session's stock: the change is
--     refused (add_on_sold_out) rather than selling a meal the kitchen does not have;
--   - a full refund releases them from the session they are counted on (the latest move's).
--
-- Lock order stays session row, then add-on stock row (as for a hold): the move runs after
-- the new tickets (new session row) and the voided ones (old session row).

CREATE OR REPLACE FUNCTION alkao_private.ticketing_exchange_add_on_stock(p_exchange_order uuid, p_from_session uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  target uuid;
  original uuid;
BEGIN
  SELECT o.session_id, o.exchange_of_order_id INTO target, original
  FROM public.ticketing_orders o WHERE o.id = p_exchange_order;
  IF original IS NULL OR target = p_from_session THEN
    RETURN;
  END IF;
  PERFORM alkao_private.ticketing_add_on_stock_move(p_from_session, l.ticket_type_id, 0, -l.quantity, false)
  FROM public.ticketing_order_lines l
  WHERE l.order_id = original AND l.kind = 'add_on' AND l.quantity > 0
  ORDER BY l.ticket_type_id;
  PERFORM alkao_private.ticketing_add_on_stock_move(target, l.ticket_type_id, 0, l.quantity, true)
  FROM public.ticketing_order_lines l
  WHERE l.order_id = original AND l.kind = 'add_on' AND l.quantity > 0
  ORDER BY l.ticket_type_id;
END;
$$;
REVOKE ALL ON FUNCTION alkao_private.ticketing_exchange_add_on_stock(uuid, uuid) FROM PUBLIC;

-- Same as Run 49, except that a full refund releases the add-ons from the session of the
-- order's latest move, where they are now counted.
CREATE OR REPLACE FUNCTION alkao_private.ticketing_orders_add_on_stock()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  counted_on uuid;
BEGIN
  IF NEW.exchange_of_order_id IS NOT NULL OR NEW.status = OLD.status THEN
    RETURN NULL;
  END IF;
  IF OLD.status = 'pending_payment' AND NEW.status = 'paid'
     AND NOT EXISTS (SELECT 1 FROM public.ticketing_holds h WHERE h.id = NEW.hold_id AND h.status = 'converted') THEN
    PERFORM alkao_private.ticketing_add_on_stock_move(NEW.session_id, l.ticket_type_id, 0, l.quantity, false)
    FROM public.ticketing_order_lines l WHERE l.order_id = NEW.id AND l.kind = 'add_on';
  ELSIF OLD.status IN ('paid', 'partially_refunded') AND NEW.status = 'refunded' THEN
    SELECT coalesce((
      SELECT x.session_id FROM public.ticketing_orders x
      WHERE x.exchange_of_order_id = NEW.id ORDER BY x.created_at DESC, x.id DESC LIMIT 1
    ), NEW.session_id) INTO counted_on;
    PERFORM alkao_private.ticketing_add_on_stock_move(counted_on, l.ticket_type_id, 0, -l.quantity, false)
    FROM public.ticketing_order_lines l WHERE l.order_id = NEW.id AND l.kind = 'add_on';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION alkao_private.ticketing_orders_add_on_stock() FROM PUBLIC;
