-- ALKAO Run 18: indexes for volume (a few seasons of sales per Brand). Indexes only: no
-- table, column, constraint, policy or grant changes.
--
-- Order search (staff, box office) by reference prefix, email prefix or a piece of the
-- buyer's name. text_pattern_ops serves LIKE 'prefix%' under any database collation; the
-- name search ("contains") needs trigrams, from the pg_trgm extension (bundled with
-- PostgreSQL and available on Supabase, where extensions live in the "extensions" schema).
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

CREATE INDEX ticketing_orders_reference_search_idx
  ON public.ticketing_orders (reference text_pattern_ops);
CREATE INDEX ticketing_buyers_email_search_idx
  ON public.ticketing_buyers (client_id, brand_id, email_normalized text_pattern_ops);

-- pg_trgm may already be installed in another schema: use its operator class from there.
DO $$
DECLARE
  trgm_schema text;
BEGIN
  SELECT n.nspname INTO STRICT trgm_schema
  FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
  WHERE e.extname = 'pg_trgm';
  EXECUTE format(
    'CREATE INDEX ticketing_buyers_name_search_idx ON public.ticketing_buyers USING gin (full_name %I.gin_trgm_ops)',
    trgm_schema
  );
END
$$;

-- Sales reports and the orders export for a period (a day, a weekend) read only that
-- period's paid orders.
CREATE INDEX ticketing_orders_paid_idx
  ON public.ticketing_orders (client_id, brand_id, paid_at) WHERE paid_at IS NOT NULL;

-- Every email the worker sends looks up the order's session-cancellation refund, by order.
CREATE INDEX ticketing_session_cancellation_orders_order_idx
  ON public.ticketing_session_cancellation_orders (order_id);
