-- Run 78: transactional, service-only delivery queue for recipient transfer proofs.
-- Invitation is NOT sent by the default worker until a real claim endpoint exists.
-- Raw bearer/claim secrets are never stored (worker derives from server master key).
CREATE TABLE public.ticketing_transfer_invitation_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL UNIQUE,
  client_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'skipped', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 100),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text CHECK (last_error IS NULL OR length(last_error) <= 100),
  provider_message_id text CHECK (provider_message_id IS NULL OR length(provider_message_id) <= 200),
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticketing_transfer_invitation_outbox_request_fkey
    FOREIGN KEY (request_id, client_id, brand_id)
    REFERENCES public.ticketing_transfer_requests (id, client_id, brand_id) ON DELETE RESTRICT,
  CONSTRAINT ticketing_transfer_invitation_outbox_sent_ck CHECK
    ((status = 'sent') = (sent_at IS NOT NULL))
);
CREATE INDEX ticketing_transfer_invitation_outbox_due
  ON public.ticketing_transfer_invitation_outbox (next_attempt_at, id)
  WHERE status = 'pending';
CREATE INDEX ticketing_transfer_invitation_outbox_scope
  ON public.ticketing_transfer_invitation_outbox (client_id, brand_id, request_id);
ALTER TABLE public.ticketing_transfer_invitation_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ticketing_transfer_invitation_outbox FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION alkao_private.ticketing_transfer_invitation_outbox_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'transfer_delivery_history_immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.request_id IS DISTINCT FROM OLD.request_id
     OR NEW.client_id IS DISTINCT FROM OLD.client_id OR NEW.brand_id IS DISTINCT FROM OLD.brand_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'transfer_delivery_identity_immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'transfer_delivery_final' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION alkao_private.ticketing_transfer_invitation_outbox_guard() FROM PUBLIC;
CREATE TRIGGER ticketing_transfer_invitation_outbox_guard
  BEFORE UPDATE OR DELETE ON public.ticketing_transfer_invitation_outbox
  FOR EACH ROW EXECUTE FUNCTION alkao_private.ticketing_transfer_invitation_outbox_guard();
