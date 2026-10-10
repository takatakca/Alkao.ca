-- ALKAO platform directory: a Brand chooses whether its sellable events may appear on alkao.ca.
-- The existing ticketing_brand_settings table is already tenant-scoped and protected by RLS.
-- Default false is intentional: deploying this migration publishes nothing until an authorized
-- Brand editor explicitly opts in from /ops -> Apparence.
ALTER TABLE public.ticketing_brand_settings
  ADD COLUMN show_on_alkao boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.ticketing_brand_settings.show_on_alkao IS
  'Explicit Brand opt-in to the public ALKAO platform directory/homepage; default false.';
