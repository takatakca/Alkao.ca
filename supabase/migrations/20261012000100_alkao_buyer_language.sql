-- ALKAO Run 16: the buyer's language for emails (French by default; English on request).
-- The latest checkout's choice applies to the buyer's later emails.
ALTER TABLE public.ticketing_buyers
  ADD COLUMN language text NOT NULL DEFAULT 'fr' CHECK (language IN ('fr', 'en'));
