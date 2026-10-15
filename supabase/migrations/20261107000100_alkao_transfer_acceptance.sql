-- Run 79: atomic recipient acceptance and irrevocable QR replacement.
-- This does NOT publish public routes or enable invitation dispatch.
ALTER TABLE public.ticketing_transfer_requests DROP CONSTRAINT ticketing_transfer_requests_status_check;
ALTER TABLE public.ticketing_transfer_requests ADD CONSTRAINT ticketing_transfer_requests_status_check
  CHECK (status IN ('pending', 'cancelled', 'expired', 'claimed'));

CREATE TABLE public.ticketing_transfer_acceptances (
  request_id uuid PRIMARY KEY,
  client_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  ticket_id uuid NOT NULL UNIQUE,
  credential_id uuid NOT NULL UNIQUE,
  recipient_access_hash bytea NOT NULL UNIQUE
    CHECK (octet_length(recipient_access_hash) = 32),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticketing_transfer_acceptances_request_fkey
    FOREIGN KEY (request_id, client_id, brand_id)
    REFERENCES public.ticketing_transfer_requests (id, client_id, brand_id) ON DELETE RESTRICT,
  CONSTRAINT ticketing_transfer_acceptances_ticket_fkey
    FOREIGN KEY (ticket_id) REFERENCES public.ticketing_tickets (id) ON DELETE RESTRICT,
  CONSTRAINT ticketing_transfer_acceptances_credential_fkey
    FOREIGN KEY (credential_id, client_id, brand_id)
    REFERENCES public.ticketing_credentials (id, client_id, brand_id) ON DELETE RESTRICT
);
CREATE INDEX ticketing_transfer_acceptances_scope ON public.ticketing_transfer_acceptances
  (client_id, brand_id, ticket_id);
ALTER TABLE public.ticketing_transfer_acceptances ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ticketing_transfer_acceptances FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION alkao_private.ticketing_transfer_acceptances_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE original record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'transfer_acceptance_immutable' USING ERRCODE = 'check_violation';
  END IF;
  SELECT r.ticket_id, r.client_id, r.brand_id, r.status INTO original
    FROM public.ticketing_transfer_requests r WHERE r.id = NEW.request_id FOR UPDATE;
  IF NOT FOUND OR original.status <> 'pending'
     OR original.ticket_id <> NEW.ticket_id OR original.client_id <> NEW.client_id
     OR original.brand_id <> NEW.brand_id THEN
    RAISE EXCEPTION 'transfer_acceptance_mismatch' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION alkao_private.ticketing_transfer_acceptances_guard() FROM PUBLIC;
CREATE TRIGGER ticketing_transfer_acceptances_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.ticketing_transfer_acceptances
  FOR EACH ROW EXECUTE FUNCTION alkao_private.ticketing_transfer_acceptances_guard();

-- Run 77 request immutability remains unchanged except for exactly-once claimed.
CREATE OR REPLACE FUNCTION alkao_private.ticketing_transfer_requests_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE candidate record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'transfer_history_immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.client_id IS DISTINCT FROM OLD.client_id
       OR NEW.brand_id IS DISTINCT FROM OLD.brand_id OR NEW.event_id IS DISTINCT FROM OLD.event_id
       OR NEW.session_id IS DISTINCT FROM OLD.session_id OR NEW.ticket_id IS DISTINCT FROM OLD.ticket_id
       OR NEW.recipient_email IS DISTINCT FROM OLD.recipient_email
       OR NEW.claim_token_hash IS DISTINCT FROM OLD.claim_token_hash
       OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'transfer_request_immutable' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status <> 'pending' OR NEW.status NOT IN ('cancelled', 'expired', 'claimed')
       OR (NEW.status = 'claimed' AND NOT EXISTS (
         SELECT 1 FROM public.ticketing_transfer_acceptances a
         WHERE a.request_id = OLD.id AND a.ticket_id = OLD.ticket_id
           AND a.client_id = OLD.client_id AND a.brand_id = OLD.brand_id)) THEN
      RAISE EXCEPTION 'transfer_invalid_transition' USING ERRCODE = 'check_violation';
    END IF;
    NEW.resolved_at := now();
    RETURN NEW;
  END IF;
  IF NEW.status <> 'pending' OR NEW.resolved_at IS NOT NULL THEN
    RAISE EXCEPTION 'transfer_must_start_pending' USING ERRCODE = 'check_violation';
  END IF;
  SELECT t.id, o.status AS order_status, b.email_normalized AS sender_email,
         s.starts_at, e.admission_opens_before_minutes, st.ticket_transfers_enabled INTO candidate
    FROM public.ticketing_tickets t
    JOIN public.ticketing_orders o ON o.id = t.order_id
      AND o.client_id = t.client_id AND o.brand_id = t.brand_id
    JOIN public.ticketing_buyers b ON b.id = o.buyer_id
      AND b.client_id = o.client_id AND b.brand_id = o.brand_id
    JOIN public.ticketing_sessions s ON s.id = t.session_id
      AND s.client_id = t.client_id AND s.brand_id = t.brand_id
    JOIN public.ticketing_events e ON e.id = t.event_id
      AND e.client_id = t.client_id AND e.brand_id = t.brand_id
    JOIN public.ticketing_brand_settings st ON st.client_id = t.client_id
      AND st.brand_id = t.brand_id
   WHERE t.id = NEW.ticket_id AND t.client_id = NEW.client_id
     AND t.brand_id = NEW.brand_id AND t.session_id = NEW.session_id
     AND t.event_id = NEW.event_id AND t.status = 'valid'
   FOR UPDATE OF t;
  IF NOT FOUND OR NOT candidate.ticket_transfers_enabled
     OR candidate.order_status NOT IN ('paid', 'partially_refunded')
     -- Transfer must finish before any 10-minute offline gate manifest can cover admission.
     OR candidate.starts_at <= now() + ((candidate.admission_opens_before_minutes + 15) * interval '1 minute')
     OR candidate.sender_email = lower(btrim(NEW.recipient_email))
     OR EXISTS (SELECT 1 FROM public.ticketing_transfer_acceptances a
                WHERE a.ticket_id = NEW.ticket_id)
     OR EXISTS (SELECT 1 FROM public.ticketing_scans sc
                WHERE sc.ticket_id = NEW.ticket_id AND sc.result = 'admitted') THEN
    RAISE EXCEPTION 'transfer_not_permitted' USING ERRCODE = 'check_violation';
  END IF;
  NEW.recipient_email := lower(btrim(NEW.recipient_email));
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION alkao_private.ticketing_transfer_requests_guard() FROM PUBLIC;
