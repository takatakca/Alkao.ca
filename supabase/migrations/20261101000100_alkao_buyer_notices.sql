-- ALKAO Run 65: what Quebec's consumer protection office (OPC) asks of a ticket seller.
--
-- 1. The exchange and refund policy. "Vous êtes libre de fixer les conditions de votre
--    politique d'échange et de remboursement", but it must be told to buyers before they
--    buy. Each Brand writes its own; the shop shows it before payment, and the tickets page
--    and the tickets e-mail repeat it. Plain text, no markup.
-- 2. A change of time or place. Since 12 September 2026, the seller "doit, dans les plus
--    brefs délais, informer le consommateur" of any change to an event's time or venue.
--    When a session's end time or its venue's name or address changes, ALKAO records the
--    change (before and after) and e-mails every order that holds a valid ticket for it.
--    Cancellation already has its own e-mail and refund (Run 10).
--
-- The change record holds no personal data: times and a venue's public address.

ALTER TABLE public.ticketing_brand_settings
  ADD COLUMN refund_policy text
    CHECK (refund_policy IS NULL OR (length(btrim(refund_policy)) BETWEEN 1 AND 2000 AND refund_policy !~ '[<>]'));

CREATE TABLE public.ticketing_session_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  event_id uuid NOT NULL,
  session_id uuid NOT NULL,
  old_starts_at timestamptz NOT NULL,
  new_starts_at timestamptz NOT NULL,
  old_ends_at timestamptz,
  new_ends_at timestamptz,
  old_place text NOT NULL CHECK (length(old_place) BETWEEN 1 AND 600),
  new_place text NOT NULL CHECK (length(new_place) BETWEEN 1 AND 600),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticketing_session_changes_session_fkey FOREIGN KEY (session_id, event_id, client_id, brand_id)
    REFERENCES public.ticketing_sessions (id, event_id, client_id, brand_id) ON DELETE RESTRICT,
  CONSTRAINT ticketing_session_changes_tenant_key UNIQUE (id, client_id, brand_id),
  CONSTRAINT ticketing_session_changes_changed_ck CHECK (
    old_starts_at IS DISTINCT FROM new_starts_at OR old_ends_at IS DISTINCT FROM new_ends_at OR old_place IS DISTINCT FROM new_place)
);
CREATE INDEX ticketing_session_changes_session_idx ON public.ticketing_session_changes (client_id, brand_id, session_id);
-- Written and read by the server only.
ALTER TABLE public.ticketing_session_changes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ticketing_session_changes FROM PUBLIC, anon, authenticated;

-- The e-mail: one per order and change (an order may be told about several changes).
ALTER TABLE public.ticketing_email_outbox ADD COLUMN change_id uuid;
ALTER TABLE public.ticketing_email_outbox
  ADD CONSTRAINT ticketing_email_outbox_change_fkey FOREIGN KEY (change_id, client_id, brand_id)
    REFERENCES public.ticketing_session_changes (id, client_id, brand_id) ON DELETE RESTRICT;
ALTER TABLE public.ticketing_email_outbox DROP CONSTRAINT ticketing_email_outbox_kind_check;
ALTER TABLE public.ticketing_email_outbox
  ADD CONSTRAINT ticketing_email_outbox_kind_check
    CHECK (kind IN ('order_tickets', 'exchange_tickets', 'session_cancelled', 'refund', 'reminder', 'session_changed')),
  ADD CONSTRAINT ticketing_email_outbox_change_ck CHECK ((kind = 'session_changed') = (change_id IS NOT NULL));
ALTER TABLE public.ticketing_email_outbox DROP CONSTRAINT ticketing_email_outbox_order_kind_key;
ALTER TABLE public.ticketing_email_outbox
  ADD CONSTRAINT ticketing_email_outbox_order_kind_key UNIQUE NULLS NOT DISTINCT (order_id, kind, refund_id, change_id);

-- As in Run 12, with the change it is about as immutable as its refund.
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
     OR NEW.refund_id IS DISTINCT FROM OLD.refund_id OR NEW.change_id IS DISTINCT FROM OLD.change_id THEN
    RAISE EXCEPTION 'email_fields_immutable' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION alkao_private.ticketing_email_outbox_before() FROM PUBLIC;

-- The two triggers that queue e-mails name the unique key in ON CONFLICT: same bodies as in
-- Run 12, with the key's new column.
CREATE OR REPLACE FUNCTION alkao_private.ticketing_orders_queue_tickets_email()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.ticketing_email_outbox (client_id, brand_id, event_id, order_id, kind)
  VALUES (NEW.client_id, NEW.brand_id, NEW.event_id, NEW.id,
          CASE WHEN NEW.exchange_of_order_id IS NULL THEN 'order_tickets' ELSE 'exchange_tickets' END)
  ON CONFLICT (order_id, kind, refund_id, change_id) DO NOTHING;
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
    ON CONFLICT (order_id, kind, refund_id, change_id) DO NOTHING;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION alkao_private.ticketing_refunds_queue_email() FROM PUBLIC;
