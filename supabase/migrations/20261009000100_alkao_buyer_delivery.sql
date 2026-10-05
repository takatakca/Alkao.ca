-- ALKAO Run 06: tickets reach the buyer.
--
-- 1. An order can have two access links: the checkout token, shown once to the buyer's
--    browser, and the email link. Rotating one never invalidates the other.
-- 2. When an order becomes paid, a "your tickets" email is queued in the same transaction.
--    The worker (npm run worker:email) sends it. Nothing is sent unless email is configured.

ALTER TABLE public.ticketing_access_tokens
  ADD COLUMN purpose text NOT NULL DEFAULT 'checkout' CHECK (purpose IN ('checkout', 'email'));
ALTER TABLE public.ticketing_access_tokens
  DROP CONSTRAINT ticketing_access_tokens_subject_key;
ALTER TABLE public.ticketing_access_tokens
  ADD CONSTRAINT ticketing_access_tokens_subject_key UNIQUE (subject_type, subject_id, purpose),
  ADD CONSTRAINT ticketing_access_tokens_email_ck CHECK (purpose = 'checkout' OR subject_type = 'order');

CREATE TABLE public.ticketing_email_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  event_id uuid NOT NULL,
  order_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('order_tickets', 'exchange_tickets')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'skipped', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 100),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text CHECK (length(last_error) <= 500),
  provider_message_id text CHECK (length(provider_message_id) <= 200),
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticketing_email_outbox_order_fkey FOREIGN KEY (order_id, event_id, client_id, brand_id)
    REFERENCES public.ticketing_orders (id, event_id, client_id, brand_id) ON DELETE RESTRICT,
  CONSTRAINT ticketing_email_outbox_order_kind_key UNIQUE (order_id, kind),
  CONSTRAINT ticketing_email_outbox_sent_ck CHECK ((status = 'sent') = (sent_at IS NOT NULL))
);
CREATE INDEX ticketing_email_outbox_due_idx ON public.ticketing_email_outbox (next_attempt_at) WHERE status = 'pending';
CREATE INDEX ticketing_email_outbox_tenant_idx ON public.ticketing_email_outbox (client_id, brand_id);
ALTER TABLE public.ticketing_email_outbox ENABLE ROW LEVEL SECURITY;

-- Identity never changes; only delivery state does.
CREATE OR REPLACE FUNCTION alkao_private.ticketing_email_outbox_before()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'history_is_append_only' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.client_id <> OLD.client_id OR NEW.brand_id <> OLD.brand_id OR NEW.event_id <> OLD.event_id
     OR NEW.order_id <> OLD.order_id OR NEW.kind <> OLD.kind OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'email_fields_immutable' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION alkao_private.ticketing_email_outbox_before() FROM PUBLIC;
CREATE TRIGGER ticketing_email_outbox_before BEFORE UPDATE OR DELETE ON public.ticketing_email_outbox
  FOR EACH ROW EXECUTE FUNCTION alkao_private.ticketing_email_outbox_before();

-- Paid → queue the tickets email, whichever code path marked the order paid.
CREATE OR REPLACE FUNCTION alkao_private.ticketing_orders_queue_tickets_email()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.ticketing_email_outbox (client_id, brand_id, event_id, order_id, kind)
  VALUES (NEW.client_id, NEW.brand_id, NEW.event_id, NEW.id,
          CASE WHEN NEW.exchange_of_order_id IS NULL THEN 'order_tickets' ELSE 'exchange_tickets' END)
  ON CONFLICT (order_id, kind) DO NOTHING;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION alkao_private.ticketing_orders_queue_tickets_email() FROM PUBLIC;
CREATE TRIGGER ticketing_orders_queue_tickets_email AFTER UPDATE OF status ON public.ticketing_orders
  FOR EACH ROW WHEN (OLD.status = 'pending_payment' AND NEW.status = 'paid')
  EXECUTE FUNCTION alkao_private.ticketing_orders_queue_tickets_email();

-- Buyer emails are personal data: service only, invisible through the Data API.
REVOKE ALL ON TABLE public.ticketing_email_outbox FROM PUBLIC, anon, authenticated;
