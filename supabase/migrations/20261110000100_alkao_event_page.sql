-- Run 93 (2026-10-18): the event page in full, as the organizer writes it. A duration and a
-- format for the hero, and the page's sections (highlights, gallery, "Le jour J", FAQ, an
-- advisory and a one-line summary) in one document checked by the API (src/contracts/api-v1.ts).
-- Nothing here is about buyers: it is shown publicly once the event is published.
ALTER TABLE public.ticketing_events
  ADD COLUMN duration_minutes integer CHECK (duration_minutes BETWEEN 5 AND 1440),
  ADD COLUMN format text CHECK (length(btrim(format)) BETWEEN 1 AND 80 AND format !~ '[<>]'),
  ADD COLUMN page jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(page) = 'object' AND octet_length(page::text) <= 65536);
