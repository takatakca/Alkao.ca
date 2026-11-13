-- ALKAO Run 109 (2026-11-13): merchant vouchers ("bons d'achat"), as on Groupon, Tuango and
-- PromoRabais. A voucher event is an offer from a restaurant, a spa or an activity: its session
-- is the validity window (the scanner admits once, any time inside it, docs/ALKAO_SCANNER_V1.md),
-- and an admission can state its face value ("valeur 80 $") above its price. The fine print is
-- the event page's `terms` (checked by the API). Nothing here is about buyers.
ALTER TABLE public.ticketing_events ADD COLUMN voucher boolean NOT NULL DEFAULT false;

ALTER TABLE public.ticketing_ticket_types
  ADD COLUMN value_cents integer,
  -- A face value is an admission's, and always above what the buyer pays: a voucher never
  -- claims a saving it does not give.
  ADD CONSTRAINT ticketing_ticket_types_value_ck
    CHECK (value_cents IS NULL OR (kind = 'admission' AND value_cents > price_cents AND value_cents <= 100000000));
