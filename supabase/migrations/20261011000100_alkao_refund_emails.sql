-- ALKAO Run 12: the buyer is told about every refund.
--
-- Each succeeded refund queues a "Remboursement" email, one per refund: an order can be
-- partially refunded several times. A session cancellation sends its own email instead.

ALTER TABLE public.ticketing_refunds
  ADD CONSTRAINT ticketing_refunds_tenant_key UNIQUE (id, order_id, client_id, brand_id);
ALTER TABLE public.ticketing_email_outbox ADD COLUMN refund_id uuid;
-- The refund must be this order's, in this tenant.
ALTER TABLE public.ticketing_email_outbox
  ADD CONSTRAINT ticketing_email_outbox_refund_fkey FOREIGN KEY (refund_id, order_id, client_id, brand_id)
    REFERENCES public.ticketing_refunds (id, order_id, client_id, brand_id) ON DELETE RESTRICT;
ALTER TABLE public.ticketing_email_outbox DROP CONSTRAINT ticketing_email_outbox_kind_check;
ALTER TABLE public.ticketing_email_outbox
  ADD CONSTRAINT ticketing_email_outbox_kind_check CHECK (kind IN ('order_tickets', 'exchange_tickets', 'session_cancelled', 'refund')),
  ADD CONSTRAINT ticketing_email_outbox_refund_ck CHECK ((kind = 'refund') = (refund_id IS NOT NULL));
ALTER TABLE public.ticketing_email_outbox DROP CONSTRAINT ticketing_email_outbox_order_kind_key;
ALTER TABLE public.ticketing_email_outbox
  ADD CONSTRAINT ticketing_email_outbox_order_kind_key UNIQUE NULLS NOT DISTINCT (order_id, kind, refund_id);

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
     OR NEW.order_id <> OLD.order_id OR NEW.kind <> OLD.kind OR NEW.created_at <> OLD.created_at
     OR NEW.refund_id IS DISTINCT FROM OLD.refund_id THEN
    RAISE EXCEPTION 'email_fields_immutable' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION alkao_private.ticketing_orders_queue_tickets_email()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.ticketing_email_outbox (client_id, brand_id, event_id, order_id, kind)
  VALUES (NEW.client_id, NEW.brand_id, NEW.event_id, NEW.id,
          CASE WHEN NEW.exchange_of_order_id IS NULL THEN 'order_tickets' ELSE 'exchange_tickets' END)
  ON CONFLICT (order_id, kind, refund_id) DO NOTHING;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION alkao_private.ticketing_refunds_queue_email()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.reason IS DISTINCT FROM 'session_cancelled' THEN
    INSERT INTO public.ticketing_email_outbox (client_id, brand_id, event_id, order_id, kind, refund_id)
    VALUES (NEW.client_id, NEW.brand_id, NEW.event_id, NEW.order_id, 'refund', NEW.id)
    ON CONFLICT (order_id, kind, refund_id) DO NOTHING;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION alkao_private.ticketing_refunds_queue_email() FROM PUBLIC;
CREATE TRIGGER ticketing_refunds_queue_email AFTER UPDATE OF status ON public.ticketing_refunds
  FOR EACH ROW WHEN (NEW.status = 'succeeded' AND OLD.status <> 'succeeded')
  EXECUTE FUNCTION alkao_private.ticketing_refunds_queue_email();

-- One personal link per order, shared by all its emails. The token is derived from the
-- server secret, the order id and this random nonce; it is never stored. Staff rotate the
-- nonce to kill a link that leaked (the old link stops working at once).
ALTER TABLE public.ticketing_access_tokens ADD COLUMN link_nonce bytea CHECK (link_nonce IS NULL OR octet_length(link_nonce) = 16);
ALTER TABLE public.ticketing_access_tokens
  ADD CONSTRAINT ticketing_access_tokens_email_nonce_ck CHECK (purpose = 'checkout' OR link_nonce IS NOT NULL) NOT VALID;
