-- ALKAO Run 69: what a buyer wants to know before choosing, set by the organizer.
--
-- Until now the platform home guessed an event's category from its words. The organizer now
-- says it, along with the minimum age, when the doors open, the language of the show and the
-- accessibility of the event. All are optional: a missing value is simply not shown. The shop,
-- the home and the search-engine data read them through the public event API, like the title.
-- No personal data.

ALTER TABLE public.ticketing_events
  -- The home's categories (src/api/home-copy.ts, CATEGORIES).
  ADD COLUMN category text
    CHECK (category IS NULL OR category IN ('concerts', 'festivals', 'sports', 'famille', 'plein-air', 'spectacles', 'soirees', 'experiences')),
  -- 0 = for all ages; 18 = 18 and over. NULL = not said.
  ADD COLUMN min_age smallint CHECK (min_age IS NULL OR min_age BETWEEN 0 AND 21),
  -- The doors open this many minutes before each session. Separate from the scanners' own
  -- window (admission_opens_before_minutes), which staff may set wider.
  ADD COLUMN doors_open_minutes smallint CHECK (doors_open_minutes IS NULL OR doors_open_minutes BETWEEN 0 AND 600),
  -- French, English, both, or no words (music, circus…).
  ADD COLUMN language text CHECK (language IS NULL OR language IN ('fr', 'en', 'fr-en', 'none')),
  -- Plain text, no markup: wheelchair access, companion seats, CAL card, sensory notes…
  ADD COLUMN accessibility text
    CHECK (accessibility IS NULL OR (length(btrim(accessibility)) BETWEEN 1 AND 1000 AND accessibility !~ '[<>]'));
