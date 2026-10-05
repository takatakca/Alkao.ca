-- ALKAO Run 10: the organizer cancels a session (weather, ice) and every buyer is refunded.
--
-- A cancellation is a job: the session stops selling at once, then the worker refunds each
-- paying order in full (TAKATAK commission included, V1 policy), voids free tickets, and
-- emails every buyer. Each order is tracked so a crash or a Stripe failure never refunds
-- twice and never forgets anyone.

CREATE TABLE public.ticketing_session_cancellations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  event_id uuid NOT NULL,
  session_id uuid NOT NULL,
  reason text CHECK (length(reason) <= 500),
  requested_by uuid,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT ticketing_session_cancellations_session_fkey FOREIGN KEY (session_id, event_id, client_id, brand_id)
    REFERENCES public.ticketing_sessions (id, event_id, client_id, brand_id) ON DELETE RESTRICT,
  CONSTRAINT ticketing_session_cancellations_once UNIQUE (session_id),
  CONSTRAINT ticketing_session_cancellations_tenant_key UNIQUE (id, client_id, brand_id),
  CONSTRAINT ticketing_session_cancellations_done_ck CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);
CREATE INDEX ticketing_session_cancellations_running_idx ON public.ticketing_session_cancellations (created_at) WHERE status = 'running';
CREATE INDEX ticketing_session_cancellations_tenant_idx ON public.ticketing_session_cancellations (client_id, brand_id);
ALTER TABLE public.ticketing_session_cancellations ENABLE ROW LEVEL SECURITY;

-- One row per paying order affected: the order that holds the money (for a Flex exchange,
-- the original order), refunded or voided exactly once.
CREATE TABLE public.ticketing_session_cancellation_orders (
  cancellation_id uuid NOT NULL,
  client_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  event_id uuid NOT NULL,
  order_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'refunded', 'voided', 'skipped', 'failed')),
  refund_id uuid,
  amount_cents integer NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 100),
  last_error text CHECK (length(last_error) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cancellation_id, order_id),
  CONSTRAINT ticketing_session_cancellation_orders_job_fkey FOREIGN KEY (cancellation_id, client_id, brand_id)
    REFERENCES public.ticketing_session_cancellations (id, client_id, brand_id) ON DELETE RESTRICT,
  CONSTRAINT ticketing_session_cancellation_orders_order_fkey FOREIGN KEY (order_id, event_id, client_id, brand_id)
    REFERENCES public.ticketing_orders (id, event_id, client_id, brand_id) ON DELETE RESTRICT
);
CREATE INDEX ticketing_session_cancellation_orders_pending_idx ON public.ticketing_session_cancellation_orders (cancellation_id) WHERE status = 'pending';
ALTER TABLE public.ticketing_session_cancellation_orders ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION alkao_private.ticketing_cancellations_touch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'history_is_append_only' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION alkao_private.ticketing_cancellations_touch() FROM PUBLIC;
CREATE TRIGGER ticketing_session_cancellations_touch BEFORE UPDATE OR DELETE ON public.ticketing_session_cancellations
  FOR EACH ROW EXECUTE FUNCTION alkao_private.ticketing_cancellations_touch();
CREATE TRIGGER ticketing_session_cancellation_orders_touch BEFORE UPDATE OR DELETE ON public.ticketing_session_cancellation_orders
  FOR EACH ROW EXECUTE FUNCTION alkao_private.ticketing_cancellations_touch();

-- The buyer is told: a third kind of email.
ALTER TABLE public.ticketing_email_outbox DROP CONSTRAINT ticketing_email_outbox_kind_check;
ALTER TABLE public.ticketing_email_outbox
  ADD CONSTRAINT ticketing_email_outbox_kind_check CHECK (kind IN ('order_tickets', 'exchange_tickets', 'session_cancelled'));

-- Service only: refunds are run by the ALKAO server, never through the Data API.
REVOKE ALL ON TABLE public.ticketing_session_cancellations, public.ticketing_session_cancellation_orders
FROM PUBLIC, anon, authenticated;
