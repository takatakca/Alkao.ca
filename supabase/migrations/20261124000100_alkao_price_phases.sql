-- ALKAO Run 104: price phases. A ticket type can start selling at a set moment, as it can
-- already stop (Run 97): "Lève-tôt" until November 1, then "Prévente" from November 1 to 15,
-- then the regular price. Before its start it is not sold, and the shop announces it as the
-- next price, with its date.

ALTER TABLE public.ticketing_ticket_types ADD COLUMN sales_start_at timestamptz;
ALTER TABLE public.ticketing_ticket_types
  ADD CONSTRAINT ticketing_ticket_types_sales_window_ck CHECK (sales_start_at IS NULL OR sales_end_at IS NULL OR sales_start_at < sales_end_at);
