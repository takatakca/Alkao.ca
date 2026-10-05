-- ALKAO Run 03: signed ticket credentials, scanner manifest data, and scans.
--
-- Credential rule (frozen): the signed QR carries only stable identifiers — a format tag,
-- the signing key id (kid, which carries the key version) and the credential id. No event or
-- session dates. Validity windows and revocation live in the scanner manifest, built from
-- the tables below.
--
-- Invariants enforced here:
--   * Every ticket gets exactly one active credential, issued by trigger.
--   * Voiding a ticket revokes its credential, by trigger.
--   * A ticket is admitted at most once, whatever the number of scanners (unique index).
--   * Keys, credentials and scans are never deleted; their identity never changes.
--   * Private signing keys are never stored: only public keys (see src/credentials/keys.ts).

-- ── Admission window per event (relative to each session) ───────────────────
ALTER TABLE public.ticketing_events
  ADD COLUMN admission_opens_before_minutes integer NOT NULL DEFAULT 60
    CHECK (admission_opens_before_minutes BETWEEN 0 AND 1440),
  ADD COLUMN admission_closes_after_minutes integer NOT NULL DEFAULT 120
    CHECK (admission_closes_after_minutes BETWEEN 0 AND 1440);

-- Composite keys the new tables reference.
ALTER TABLE public.ticketing_tickets
  ADD CONSTRAINT ticketing_tickets_tenant_key UNIQUE (id, session_id, event_id, client_id, brand_id);

-- ── Signing keys (public halves only) ───────────────────────────────────────
CREATE TABLE public.ticketing_credential_keys (
  kid text PRIMARY KEY CHECK (kid ~ '^k[0-9a-z]{10}$'),
  client_id uuid NOT NULL REFERENCES public.ticketing_clients (id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version >= 1),
  algorithm text NOT NULL DEFAULT 'Ed25519' CHECK (algorithm = 'Ed25519'),
  public_key text NOT NULL CHECK (public_key ~ '^[A-Za-z0-9_-]{43}$'),
  -- active: signs new QR codes. retired: still verifies existing ones. revoked: verifies nothing.
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  CONSTRAINT ticketing_credential_keys_version_key UNIQUE (client_id, version),
  CONSTRAINT ticketing_credential_keys_retired_ck CHECK ((status = 'active') = (retired_at IS NULL))
);
CREATE UNIQUE INDEX ticketing_credential_keys_one_active ON public.ticketing_credential_keys (client_id) WHERE status = 'active';
ALTER TABLE public.ticketing_credential_keys ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION alkao_private.ticketing_credential_keys_before_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.kid <> OLD.kid OR NEW.client_id <> OLD.client_id OR NEW.version <> OLD.version
     OR NEW.algorithm <> OLD.algorithm OR NEW.public_key <> OLD.public_key OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'credential_key_immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'active' AND NEW.status IN ('retired', 'revoked'))
    OR (OLD.status = 'retired' AND NEW.status = 'revoked')
  ) THEN
    RAISE EXCEPTION 'credential_key_invalid_transition' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION alkao_private.ticketing_credential_keys_before_update() FROM PUBLIC;
CREATE TRIGGER ticketing_credential_keys_before_update BEFORE UPDATE ON public.ticketing_credential_keys
  FOR EACH ROW EXECUTE FUNCTION alkao_private.ticketing_credential_keys_before_update();
CREATE TRIGGER ticketing_credential_keys_no_delete BEFORE DELETE ON public.ticketing_credential_keys
  FOR EACH ROW EXECUTE FUNCTION alkao_private.reject_mutation();

-- ── Credentials (one active per ticket) ─────────────────────────────────────
CREATE TABLE public.ticketing_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  event_id uuid NOT NULL,
  session_id uuid NOT NULL,
  ticket_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  revoke_reason text CHECK (revoke_reason IN ('ticket_void', 'reissued', 'admin')),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticketing_credentials_ticket_fkey FOREIGN KEY (ticket_id, session_id, event_id, client_id, brand_id)
    REFERENCES public.ticketing_tickets (id, session_id, event_id, client_id, brand_id) ON DELETE RESTRICT,
  CONSTRAINT ticketing_credentials_tenant_key UNIQUE (id, client_id, brand_id),
  CONSTRAINT ticketing_credentials_revoked_ck CHECK (
    (status = 'revoked') = (revoked_at IS NOT NULL AND revoke_reason IS NOT NULL)
    AND (status = 'active') = (revoked_at IS NULL AND revoke_reason IS NULL)
  )
);
CREATE UNIQUE INDEX ticketing_credentials_one_active ON public.ticketing_credentials (ticket_id) WHERE status = 'active';
CREATE INDEX ticketing_credentials_ticket_idx ON public.ticketing_credentials (ticket_id, session_id, event_id, client_id, brand_id);
CREATE INDEX ticketing_credentials_session_idx ON public.ticketing_credentials (session_id, status);
CREATE INDEX ticketing_credentials_tenant_idx ON public.ticketing_credentials (client_id, brand_id);
ALTER TABLE public.ticketing_credentials ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION alkao_private.ticketing_credentials_before_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.client_id <> OLD.client_id OR NEW.brand_id <> OLD.brand_id
     OR NEW.event_id <> OLD.event_id OR NEW.session_id <> OLD.session_id
     OR NEW.ticket_id <> OLD.ticket_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'credential_fields_immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'revoked' AND (NEW.status <> 'revoked' OR NEW.revoke_reason IS DISTINCT FROM OLD.revoke_reason
      OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'credential_revocation_is_final' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION alkao_private.ticketing_credentials_before_update() FROM PUBLIC;
CREATE TRIGGER ticketing_credentials_before_update BEFORE UPDATE ON public.ticketing_credentials
  FOR EACH ROW EXECUTE FUNCTION alkao_private.ticketing_credentials_before_update();
CREATE TRIGGER ticketing_credentials_no_delete BEFORE DELETE ON public.ticketing_credentials
  FOR EACH ROW EXECUTE FUNCTION alkao_private.reject_mutation();

-- Issue a credential with every ticket; revoke it when the ticket is voided.
CREATE OR REPLACE FUNCTION alkao_private.ticketing_tickets_credentials()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.ticketing_credentials (client_id, brand_id, event_id, session_id, ticket_id)
    VALUES (NEW.client_id, NEW.brand_id, NEW.event_id, NEW.session_id, NEW.id);
  ELSIF OLD.status = 'valid' AND NEW.status = 'void' THEN
    UPDATE public.ticketing_credentials
    SET status = 'revoked', revoke_reason = 'ticket_void', revoked_at = now()
    WHERE ticket_id = NEW.id AND status = 'active';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION alkao_private.ticketing_tickets_credentials() FROM PUBLIC;
CREATE TRIGGER ticketing_tickets_credentials AFTER INSERT OR UPDATE OF status ON public.ticketing_tickets
  FOR EACH ROW EXECUTE FUNCTION alkao_private.ticketing_tickets_credentials();

-- Backfill tickets issued before this migration.
INSERT INTO public.ticketing_credentials (client_id, brand_id, event_id, session_id, ticket_id, status, revoke_reason, revoked_at)
SELECT t.client_id, t.brand_id, t.event_id, t.session_id, t.id,
       CASE t.status WHEN 'valid' THEN 'active' ELSE 'revoked' END,
       CASE t.status WHEN 'valid' THEN NULL ELSE 'ticket_void' END,
       CASE t.status WHEN 'valid' THEN NULL ELSE coalesce(t.voided_at, now()) END
FROM public.ticketing_tickets t;

-- ── Scans (append-only gate log) ────────────────────────────────────────────
CREATE TABLE public.ticketing_scans (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  event_id uuid NOT NULL,
  -- The session the gate is admitting for (not necessarily the ticket's).
  session_id uuid NOT NULL,
  credential_id uuid,
  ticket_id uuid,
  result text NOT NULL CHECK (result IN (
    'admitted', 'already_admitted', 'revoked', 'wrong_session', 'too_early', 'too_late',
    'unknown_credential', 'invalid_signature', 'unknown_key', 'malformed'
  )),
  device_id text CHECK (device_id IS NULL OR length(device_id) <= 100),
  scanned_by uuid NOT NULL,
  scanned_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  offline boolean NOT NULL DEFAULT false,
  CONSTRAINT ticketing_scans_session_fkey FOREIGN KEY (session_id, event_id, client_id, brand_id)
    REFERENCES public.ticketing_sessions (id, event_id, client_id, brand_id) ON DELETE RESTRICT,
  CONSTRAINT ticketing_scans_credential_fkey FOREIGN KEY (credential_id, client_id, brand_id)
    REFERENCES public.ticketing_credentials (id, client_id, brand_id) ON DELETE RESTRICT,
  CONSTRAINT ticketing_scans_identified_ck CHECK (
    (result IN ('admitted', 'already_admitted', 'revoked', 'wrong_session', 'too_early', 'too_late'))
    = (credential_id IS NOT NULL AND ticket_id IS NOT NULL)
  )
);
-- One admission per ticket, across every gate and every reissued credential.
CREATE UNIQUE INDEX ticketing_scans_one_admission ON public.ticketing_scans (ticket_id) WHERE result = 'admitted';
CREATE INDEX ticketing_scans_session_idx ON public.ticketing_scans (session_id, event_id, client_id, brand_id);
CREATE INDEX ticketing_scans_credential_idx ON public.ticketing_scans (credential_id, client_id, brand_id);
CREATE INDEX ticketing_scans_tenant_idx ON public.ticketing_scans (client_id, brand_id, received_at);
ALTER TABLE public.ticketing_scans ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER ticketing_scans_append_only BEFORE UPDATE OR DELETE ON public.ticketing_scans
  FOR EACH ROW EXECUTE FUNCTION alkao_private.reject_mutation();

-- ── Grants and policies ─────────────────────────────────────────────────────
REVOKE ALL ON TABLE
  public.ticketing_credential_keys,
  public.ticketing_credentials,
  public.ticketing_scans
FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.ticketing_scans_id_seq FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE
  public.ticketing_credential_keys,
  public.ticketing_credentials,
  public.ticketing_scans
TO authenticated;

CREATE POLICY ticketing_credential_keys_member_read ON public.ticketing_credential_keys
  FOR SELECT TO authenticated
  USING (alkao_private.is_client_member(client_id));

CREATE POLICY ticketing_credentials_member_read ON public.ticketing_credentials
  FOR SELECT TO authenticated
  USING (alkao_private.is_client_member(client_id));

CREATE POLICY ticketing_scans_member_read ON public.ticketing_scans
  FOR SELECT TO authenticated
  USING (alkao_private.is_client_member(client_id));
