-- ALKAO Run 71: a waitlist for sold-out sessions.
--
-- When a session is full, a buyer can leave an e-mail address in the shop. When seats come
-- back (a refund, a cancelled order, an expired hold, more capacity), ALKAO writes to the people
-- waiting, oldest first; seats then go to whoever buys first, as for everyone else. One e-mail
-- per sign-up: someone who still wants in signs up again.
--
-- Personal data: an e-mail address and a language, kept for one session only. Entries are
-- deleted 30 days after the session starts (src/delivery/waitlist.ts).

CREATE TABLE public.ticketing_waitlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  event_id uuid NOT NULL,
  session_id uuid NOT NULL,
  email text NOT NULL CHECK (email = lower(btrim(email)) AND length(email) BETWEEN 3 AND 320 AND position('@' IN email) > 1),
  language text NOT NULL DEFAULT 'fr' CHECK (language IN ('fr', 'en')),
  -- waiting → notified (the e-mail went), or expired (the session started or was cancelled
  -- first), or failed (the e-mail could not be sent).
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'notified', 'expired', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text CHECK (last_error IS NULL OR length(last_error) <= 500),
  provider_message_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  notified_at timestamptz,
  CONSTRAINT ticketing_waitlist_session_fkey FOREIGN KEY (session_id, event_id, client_id, brand_id)
    REFERENCES public.ticketing_sessions (id, event_id, client_id, brand_id) ON DELETE CASCADE,
  CONSTRAINT ticketing_waitlist_notified_ck CHECK ((status = 'notified') = (notified_at IS NOT NULL))
);
-- One waiting entry per person and session.
CREATE UNIQUE INDEX ticketing_waitlist_waiting_key ON public.ticketing_waitlist (session_id, email) WHERE status = 'waiting';
CREATE INDEX ticketing_waitlist_session_idx ON public.ticketing_waitlist (session_id, status, created_at);
CREATE INDEX ticketing_waitlist_tenant_idx ON public.ticketing_waitlist (client_id, brand_id, session_id);
-- Written and read by the server only.
ALTER TABLE public.ticketing_waitlist ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ticketing_waitlist FROM PUBLIC, anon, authenticated;
