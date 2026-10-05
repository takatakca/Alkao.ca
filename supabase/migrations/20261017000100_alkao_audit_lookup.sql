-- ALKAO Run 30: the audit journal and the order history read the log by what it is about.
-- Indexes only: no table, column, policy or grant changes.

-- Journal filters (entity type and id) and the order history's order, ticket and buyer entries.
CREATE INDEX ticketing_audit_log_entity_idx
  ON public.ticketing_audit_log (client_id, entity_type, entity_id);

-- Refund entries name their order in data.orderId; an exchange names its new order in
-- data.exchangeOrderId.
CREATE INDEX ticketing_audit_log_order_ref_idx
  ON public.ticketing_audit_log (client_id, (data->>'orderId')) WHERE data ? 'orderId';
CREATE INDEX ticketing_audit_log_exchange_ref_idx
  ON public.ticketing_audit_log (client_id, (data->>'exchangeOrderId')) WHERE data ? 'exchangeOrderId';
