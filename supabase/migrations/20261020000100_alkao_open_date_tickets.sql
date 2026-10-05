-- ALKAO Run 37: "billet ouvert" (owner decision, docs/ALKAO_DECISIONS.md). An admission
-- type can be open-date: its order keeps a seat in the session chosen at purchase, and can
-- move to another session of the event as often as needed while no ticket has entered.
ALTER TABLE public.ticketing_ticket_types
  ADD COLUMN open_date boolean NOT NULL DEFAULT false;
ALTER TABLE public.ticketing_ticket_types
  ADD CONSTRAINT ticketing_ticket_types_open_date_ck CHECK (NOT open_date OR kind = 'admission');

-- Every move of an order points to the order that holds the money (its original), so the
-- refund, cancellation and email code that looks one level down still finds every ticket.
-- An open-date order can move again from its latest move, so an original can now have
-- several moves over time; the code allows a new move only from the latest one (under a row
-- lock on the original), and Flex Météo orders still move once.
DROP INDEX public.ticketing_orders_one_exchange;

CREATE OR REPLACE FUNCTION alkao_private.ticketing_orders_exchange_root()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.exchange_of_order_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.ticketing_orders o WHERE o.id = NEW.exchange_of_order_id AND o.exchange_of_order_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'exchange_must_point_to_original' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION alkao_private.ticketing_orders_exchange_root() FROM PUBLIC;
CREATE TRIGGER ticketing_orders_exchange_root BEFORE INSERT ON public.ticketing_orders
  FOR EACH ROW EXECUTE FUNCTION alkao_private.ticketing_orders_exchange_root();
