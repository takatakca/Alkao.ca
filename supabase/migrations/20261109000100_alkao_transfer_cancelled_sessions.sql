-- Run 82 (2026-10-16): reject new ticket transfers into sessions cancelled
-- before the background refund/cancellation worker has voided the tickets.
-- Existing request and acceptance histories remain append-only and unchanged.
CREATE OR REPLACE FUNCTION alkao_private.ticketing_transfer_session_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE current_status text;
BEGIN
  -- FOR SHARE serializes with the cancellation writer's session FOR UPDATE,
  -- regardless of whether the async refund worker has reached the ticket.
  SELECT s.status INTO current_status
    FROM public.ticketing_sessions s
   WHERE s.id = NEW.session_id AND s.client_id = NEW.client_id
     AND s.brand_id = NEW.brand_id
   FOR SHARE;
  IF NOT FOUND OR current_status = 'cancelled' THEN
    RAISE EXCEPTION 'transfer_session_cancelled' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION alkao_private.ticketing_transfer_session_guard() FROM PUBLIC;
CREATE TRIGGER ticketing_transfer_session_guard
  BEFORE INSERT ON public.ticketing_transfer_requests
  FOR EACH ROW EXECUTE FUNCTION alkao_private.ticketing_transfer_session_guard();
