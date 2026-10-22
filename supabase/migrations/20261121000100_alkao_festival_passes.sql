-- ALKAO Run 98: festival passes.
--
-- A pass is one ticket, with one QR code, valid at every session of its event that was on
-- sale when it was bought: a weekend, the three days of a festival. It takes a seat on each
-- of those sessions and lets its holder in once per session.
--
--   - The order (and the ticket) belong to the first of those sessions, as any order does.
--     The other sessions' seats are rows here: held with the cart, sold with the ticket,
--     given back when the cart ends or the ticket is voided (a refund).
--   - Locks follow the sessions' order in time: the first session (the cart's own row),
--     then the others by start, on creation and on release alike. So two carts never wait
--     on each other in opposite orders.
--   - One admission per ticket and per session: a pass enters each day once; any other
--     ticket still enters its own session once (the gate refuses it anywhere else).

ALTER TABLE public.ticketing_ticket_types ADD COLUMN pass boolean NOT NULL DEFAULT false;
ALTER TABLE public.ticketing_ticket_types
  ADD CONSTRAINT ticketing_ticket_types_pass_ck CHECK (NOT pass OR (kind = 'admission' AND NOT open_date));

-- Seats a pass in a cart holds on the sessions after the cart's own.
CREATE TABLE public.ticketing_hold_pass_seats (
  hold_id uuid NOT NULL,
  session_id uuid NOT NULL,
  client_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  event_id uuid NOT NULL,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (hold_id, session_id),
  CONSTRAINT ticketing_hold_pass_seats_hold_fkey FOREIGN KEY (hold_id, event_id, client_id, brand_id)
    REFERENCES public.ticketing_holds (id, event_id, client_id, brand_id) ON DELETE RESTRICT,
  CONSTRAINT ticketing_hold_pass_seats_session_fkey FOREIGN KEY (session_id, event_id, client_id, brand_id)
    REFERENCES public.ticketing_sessions (id, event_id, client_id, brand_id) ON DELETE RESTRICT
);
CREATE INDEX ticketing_hold_pass_seats_session_idx ON public.ticketing_hold_pass_seats (session_id);
CREATE INDEX ticketing_hold_pass_seats_tenant_idx ON public.ticketing_hold_pass_seats (client_id, brand_id);
ALTER TABLE public.ticketing_hold_pass_seats ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ticketing_hold_pass_seats FROM PUBLIC, anon, authenticated;

-- And once paid, per ticket: the sessions a pass ticket is valid at besides its own.
CREATE TABLE public.ticketing_ticket_pass_seats (
  ticket_id uuid NOT NULL,
  session_id uuid NOT NULL,
  client_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  event_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ticket_id, session_id),
  CONSTRAINT ticketing_ticket_pass_seats_ticket_fkey FOREIGN KEY (ticket_id, client_id, brand_id)
    REFERENCES public.ticketing_tickets (id, client_id, brand_id) ON DELETE RESTRICT,
  CONSTRAINT ticketing_ticket_pass_seats_session_fkey FOREIGN KEY (session_id, event_id, client_id, brand_id)
    REFERENCES public.ticketing_sessions (id, event_id, client_id, brand_id) ON DELETE RESTRICT
);
CREATE INDEX ticketing_ticket_pass_seats_session_idx ON public.ticketing_ticket_pass_seats (session_id, ticket_id);
CREATE INDEX ticketing_ticket_pass_seats_tenant_idx ON public.ticketing_ticket_pass_seats (client_id, brand_id);
ALTER TABLE public.ticketing_ticket_pass_seats ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ticketing_ticket_pass_seats FROM PUBLIC, anon, authenticated;

-- A cart's pass seat: a session on sale, after the cart's own, and a seat taken there (the
-- session's capacity check refuses one too many, as for the cart's own session).
CREATE OR REPLACE FUNCTION alkao_private.ticketing_hold_pass_seats_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  own record;
  seat record;
BEGIN
  SELECT s.starts_at, s.id INTO own
  FROM public.ticketing_holds h JOIN public.ticketing_sessions s ON s.id = h.session_id
  WHERE h.id = NEW.hold_id AND h.status = 'active';
  IF own.id IS NULL THEN
    RAISE EXCEPTION 'hold_not_active' USING ERRCODE = 'check_violation';
  END IF;
  SELECT s.status, s.starts_at INTO seat FROM public.ticketing_sessions s WHERE s.id = NEW.session_id;
  IF seat.status IS DISTINCT FROM 'on_sale' THEN
    RAISE EXCEPTION 'session_not_on_sale' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.session_id = own.id OR (seat.starts_at, NEW.session_id) < (own.starts_at, own.id) THEN
    RAISE EXCEPTION 'pass_seat_order' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE public.ticketing_sessions SET reserved_count = reserved_count + NEW.quantity WHERE id = NEW.session_id;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION alkao_private.ticketing_hold_pass_seats_insert() FROM PUBLIC;
CREATE TRIGGER ticketing_hold_pass_seats_insert AFTER INSERT ON public.ticketing_hold_pass_seats
  FOR EACH ROW EXECUTE FUNCTION alkao_private.ticketing_hold_pass_seats_insert();

-- A cart that ends gives its pass seats back. The name sorts right after the cart's own
-- session (ticketing_holds_inventory) and before add-ons and quotas, as on creation.
CREATE OR REPLACE FUNCTION alkao_private.ticketing_holds_pass_seats()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  seat record;
BEGIN
  IF OLD.status = 'active' AND NEW.status <> 'active' THEN
    FOR seat IN
      SELECT p.session_id, p.quantity FROM public.ticketing_hold_pass_seats p
      JOIN public.ticketing_sessions s ON s.id = p.session_id
      WHERE p.hold_id = NEW.id ORDER BY s.starts_at, s.id
    LOOP
      UPDATE public.ticketing_sessions SET reserved_count = reserved_count - seat.quantity WHERE id = seat.session_id;
    END LOOP;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION alkao_private.ticketing_holds_pass_seats() FROM PUBLIC;
CREATE TRIGGER ticketing_holds_inventory_a_passes AFTER UPDATE OF status ON public.ticketing_holds
  FOR EACH ROW EXECUTE FUNCTION alkao_private.ticketing_holds_pass_seats();

-- A pass ticket's seat: same event as the ticket, never its own session, a seat sold there.
CREATE OR REPLACE FUNCTION alkao_private.ticketing_ticket_pass_seats_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  ticket record;
BEGIN
  SELECT t.event_id, t.session_id, t.status, tt.pass INTO ticket
  FROM public.ticketing_tickets t JOIN public.ticketing_ticket_types tt ON tt.id = t.ticket_type_id
  WHERE t.id = NEW.ticket_id;
  IF ticket.pass IS NOT TRUE OR ticket.status <> 'valid' OR ticket.event_id <> NEW.event_id OR ticket.session_id = NEW.session_id THEN
    RAISE EXCEPTION 'pass_seat_invalid' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE public.ticketing_sessions SET sold_count = sold_count + 1 WHERE id = NEW.session_id;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION alkao_private.ticketing_ticket_pass_seats_insert() FROM PUBLIC;
CREATE TRIGGER ticketing_ticket_pass_seats_insert AFTER INSERT ON public.ticketing_ticket_pass_seats
  FOR EACH ROW EXECUTE FUNCTION alkao_private.ticketing_ticket_pass_seats_insert();

-- A voided pass ticket (refund, cancellation, staff) gives its other sessions' seats back,
-- after its own (ticketing_tickets_inventory), in the sessions' order.
CREATE OR REPLACE FUNCTION alkao_private.ticketing_tickets_pass_seats()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  seat record;
BEGIN
  IF OLD.status = 'valid' AND NEW.status = 'void' THEN
    FOR seat IN
      SELECT p.session_id FROM public.ticketing_ticket_pass_seats p
      JOIN public.ticketing_sessions s ON s.id = p.session_id
      WHERE p.ticket_id = NEW.id ORDER BY s.starts_at, s.id
    LOOP
      UPDATE public.ticketing_sessions SET sold_count = sold_count - 1 WHERE id = seat.session_id;
    END LOOP;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION alkao_private.ticketing_tickets_pass_seats() FROM PUBLIC;
CREATE TRIGGER ticketing_tickets_inventory_passes AFTER UPDATE OF status ON public.ticketing_tickets
  FOR EACH ROW EXECUTE FUNCTION alkao_private.ticketing_tickets_pass_seats();

-- One admission per ticket and per session (a pass enters each of its days once).
DROP INDEX public.ticketing_scans_one_admission;
CREATE UNIQUE INDEX ticketing_scans_one_admission ON public.ticketing_scans (ticket_id, session_id) WHERE result = 'admitted';
