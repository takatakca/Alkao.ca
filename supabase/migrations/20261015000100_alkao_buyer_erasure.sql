-- ALKAO Run 20: a buyer's personal data on request (Québec Law 25): export it, or anonymize
-- the buyer. Anonymizing replaces the email, name and phone on the buyer row; orders, amounts,
-- tickets and scans stay, so sales, taxes and commission remain exact.
--
-- This table records that a buyer was anonymized, when and by whom, and nothing personal.
-- Server-only (no Data API access). Rows are never changed or deleted.
CREATE TABLE public.ticketing_buyer_erasures (
  buyer_id uuid PRIMARY KEY,
  client_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  requested_by text NOT NULL CHECK (length(requested_by) <= 200),
  erased_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticketing_buyer_erasures_buyer_fkey FOREIGN KEY (buyer_id, client_id, brand_id)
    REFERENCES public.ticketing_buyers (id, client_id, brand_id) ON DELETE RESTRICT
);
CREATE INDEX ticketing_buyer_erasures_tenant_idx ON public.ticketing_buyer_erasures (client_id, brand_id, erased_at);
ALTER TABLE public.ticketing_buyer_erasures ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER ticketing_buyer_erasures_append_only BEFORE UPDATE OR DELETE ON public.ticketing_buyer_erasures
  FOR EACH ROW EXECUTE FUNCTION alkao_private.reject_mutation();

REVOKE ALL ON TABLE public.ticketing_buyer_erasures FROM PUBLIC, anon, authenticated;
-- Intentionally no policy and no grant: read through the admin API only.
