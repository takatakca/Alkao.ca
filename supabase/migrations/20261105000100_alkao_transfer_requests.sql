-- Run 77, phase 1: transfer request safety boundary. NO buyer API or acceptance yet.
-- A ticket is NOT transferred by creating a request. The original QR remains
-- usable until a later, recipient-verified atomic acceptance implementation.
-- Default off for every Brand. Only backend service role may read these rows.
ALTER TABLE public.ticketing_brand_settings
  ADD COLUMN ticket_transfers_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE public.ticketing_transfer_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  event_id uuid NOT NULL,
  session_id uuid NOT NULL,
  ticket_id uuid NOT NULL,
  recipient_email text NOT NULL
    CHECK (length(recipient_email) <= 320 AND recipient_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  -- Hash of the future one-time recipient claim secret, NEVER the bearer secret.
  claim_token_hash bytea NOT NULL UNIQUE CHECK (octet_length(claim_token_hash) = 32),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'cancelled', 'expired')),
  expires_at timestamptz NOT NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticketing_transfer_requests_ticket_fkey
    FOREIGN KEY (ticket_id, session_id, event_id, client_id, brand_id)
    REFERENCES public.ticketing_tickets (id, session_id, event_id, client_id, brand_id)
    ON DELETE RESTRICT,
  CONSTRAINT ticketing_transfer_requests_tenant_key UNIQUE (id, client_id, brand_id),
  CONSTRAINT ticketing_transfer_requests_expiry_ck CHECK
    (expires_at > created_at AND expires_at <= created_at + interval '48 hours'),
  CONSTRAINT ticketing_transfer_requests_resolution_ck CHECK
    ((status = 'pending') = (resolved_at IS NULL))
);
CREATE UNIQUE INDEX ticketing_transfer_requests_one_pending
  ON public.ticketing_transfer_requests (ticket_id) WHERE status = 'pending';
CREATE INDEX ticketing_transfer_requests_expiry
  ON public.ticketing_transfer_requests (expires_at) WHERE status = 'pending';
CREATE INDEX ticketing_transfer_requests_scope
  ON public.ticketing_transfer_requests (client_id, brand_id, ticket_id);

ALTER TABLE public.ticketing_transfer_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ticketing_transfer_requests FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION alkao_private.ticketing_transfer_requests_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  candidate record;
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
       OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION 'transfer_request_immutable' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status <> 'pending' OR NEW.status NOT IN ('cancelled', 'expired') THEN
      RAISE EXCEPTION 'transfer_invalid_transition' USING ERRCODE = 'check_violation';
    END IF;
    NEW.resolved_at := now();
    RETURN NEW;
  END IF;

  IF NEW.status <> 'pending' OR NEW.resolved_at IS NOT NULL THEN
    RAISE EXCEPTION 'transfer_must_start_pending' USING ERRCODE = 'check_violation';
  END IF;
  -- Serialize requests for the same ticket (also protected by the partial index).
  -- Only a valid, paid, unscanned admission can be offered for transfer.
  SELECT t.id, o.status AS order_status, b.email_normalized AS sender_email,
         s.starts_at, st.ticket_transfers_enabled
    INTO candidate
    FROM public.ticketing_tickets t
    JOIN public.ticketing_orders o ON o.id = t.order_id
      AND o.client_id = t.client_id AND o.brand_id = t.brand_id
    JOIN public.ticketing_buyers b ON b.id = o.buyer_id
      AND b.client_id = o.client_id AND b.brand_id = o.brand_id
    JOIN public.ticketing_sessions s ON s.id = t.session_id
      AND s.client_id = t.client_id AND s.brand_id = t.brand_id
    JOIN public.ticketing_brand_settings st ON st.client_id = t.client_id
      AND st.brand_id = t.brand_id
   WHERE t.id = NEW.ticket_id AND t.client_id = NEW.client_id
     AND t.brand_id = NEW.brand_id AND t.session_id = NEW.session_id
     AND t.event_id = NEW.event_id AND t.status = 'valid'
   FOR UPDATE OF t;
  IF NOT FOUND OR NOT candidate.ticket_transfers_enabled
     OR candidate.order_status NOT IN ('paid', 'partially_refunded')
     OR candidate.starts_at <= now()
     OR candidate.sender_email = lower(btrim(NEW.recipient_email))
     OR EXISTS (
       SELECT 1 FROM public.ticketing_scans sc
       WHERE sc.ticket_id = NEW.ticket_id AND sc.result = 'admitted'
     )
  THEN
    RAISE EXCEPTION 'transfer_not_permitted' USING ERRCODE = 'check_violation';
  END IF;
  NEW.recipient_email := lower(btrim(NEW.recipient_email));
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION alkao_private.ticketing_transfer_requests_guard() FROM PUBLIC;
CREATE TRIGGER ticketing_transfer_requests_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.ticketing_transfer_requests
  FOR EACH ROW EXECUTE FUNCTION alkao_private.ticketing_transfer_requests_guard();
