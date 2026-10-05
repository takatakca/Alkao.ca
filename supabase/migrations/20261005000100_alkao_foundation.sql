-- ALKAO foundation: local projections of GROUPE TAKATAK master records (Clients, Brands,
-- Memberships, Ticketing entitlements), the control-contract inbox, the audit log, and
-- RLS helpers.
--
-- Rules (frozen):
--   * Every ticketing_* table enables RLS in the migration that creates it.
--   * anon: no grants, no policies. authenticated: SELECT only, through membership policies.
--   * No INSERT/UPDATE/DELETE policies. Writes go through the ALKAO server (table owner /
--     service_role). A future write policy MUST have both USING and WITH CHECK.
--   * Client and Brand ids are TAKATAK master UUIDs: external references, validated and
--     stored locally. No foreign key ever points at the TAKATAK database.
--   * Identity is auth.uid() only. Never user_metadata.

-- ── Non-exposed helper schema ───────────────────────────────────────────────
-- Do not add alkao_private to PostgREST exposed schemas: helpers must not become /rpc.
CREATE SCHEMA IF NOT EXISTS alkao_private;
REVOKE ALL ON SCHEMA alkao_private FROM PUBLIC;
GRANT USAGE ON SCHEMA alkao_private TO authenticated;

CREATE OR REPLACE FUNCTION alkao_private.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION alkao_private.touch_updated_at() FROM PUBLIC;

-- ── Clients (projection of TAKATAK clients) ─────────────────────────────────
CREATE TABLE public.ticketing_clients (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'archived')),
  timezone text NOT NULL DEFAULT 'America/Toronto',
  currency text NOT NULL DEFAULT 'CAD' CHECK (currency = 'CAD'),
  -- Transactional commission terms, set by the TAKATAK control contract.
  commission_rate_bps integer NOT NULL DEFAULT 0
    CHECK (commission_rate_bps BETWEEN 0 AND 10000),
  commission_fixed_cents integer NOT NULL DEFAULT 0
    CHECK (commission_fixed_cents BETWEEN 0 AND 100000),
  master_version bigint NOT NULL DEFAULT 0 CHECK (master_version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ticketing_clients ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER ticketing_clients_touch BEFORE UPDATE ON public.ticketing_clients
  FOR EACH ROW EXECUTE FUNCTION alkao_private.touch_updated_at();

-- ── Brands (projection of TAKATAK business_brands) ──────────────────────────
CREATE TABLE public.ticketing_brands (
  id uuid PRIMARY KEY,
  client_id uuid NOT NULL REFERENCES public.ticketing_clients (id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'archived')),
  master_version bigint NOT NULL DEFAULT 0 CHECK (master_version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticketing_brands_id_client_key UNIQUE (id, client_id)
);
CREATE INDEX ticketing_brands_client_idx ON public.ticketing_brands (client_id);
ALTER TABLE public.ticketing_brands ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER ticketing_brands_touch BEFORE UPDATE ON public.ticketing_brands
  FOR EACH ROW EXECUTE FUNCTION alkao_private.touch_updated_at();

-- A brand never moves to another Client.
CREATE OR REPLACE FUNCTION alkao_private.ticketing_brands_client_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.client_id <> OLD.client_id THEN
    RAISE EXCEPTION 'brand_client_immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION alkao_private.ticketing_brands_client_immutable() FROM PUBLIC;
CREATE TRIGGER ticketing_brands_client_immutable BEFORE UPDATE ON public.ticketing_brands
  FOR EACH ROW EXECUTE FUNCTION alkao_private.ticketing_brands_client_immutable();

-- ── Memberships (projection of TAKATAK client_memberships) ──────────────────
-- Client-scoped, like TAKATAK ClientMembership. One person working for Havana Resort and
-- FESTI-ICE has two rows. user_id is the Supabase auth user id (auth.uid()).
CREATE TABLE public.ticketing_memberships (
  client_id uuid NOT NULL REFERENCES public.ticketing_clients (id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  role text NOT NULL
    CHECK (role IN ('owner', 'admin', 'manager', 'editor', 'staff', 'viewer')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  master_version bigint NOT NULL DEFAULT 0 CHECK (master_version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, user_id)
);
CREATE INDEX ticketing_memberships_user_idx ON public.ticketing_memberships (user_id, status);
ALTER TABLE public.ticketing_memberships ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER ticketing_memberships_touch BEFORE UPDATE ON public.ticketing_memberships
  FOR EACH ROW EXECUTE FUNCTION alkao_private.touch_updated_at();

-- ── Ticketing entitlements (projection of the TAKATAK control contract) ─────
-- Absence of a row means Ticketing is disabled for that Client/Brand.
CREATE TABLE public.ticketing_entitlements (
  client_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'inactive'
    CHECK (status IN ('active', 'inactive', 'suspended')),
  contract_version text NOT NULL CHECK (contract_version ~ '^alkao\.control\.v[0-9]+$'),
  valid_from timestamptz,
  valid_until timestamptz,
  master_version bigint NOT NULL DEFAULT 0 CHECK (master_version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, brand_id),
  CONSTRAINT ticketing_entitlements_brand_fkey FOREIGN KEY (brand_id, client_id)
    REFERENCES public.ticketing_brands (id, client_id) ON DELETE CASCADE,
  CONSTRAINT ticketing_entitlements_window_ck
    CHECK (valid_from IS NULL OR valid_until IS NULL OR valid_from < valid_until)
);
ALTER TABLE public.ticketing_entitlements ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER ticketing_entitlements_touch BEFORE UPDATE ON public.ticketing_entitlements
  FOR EACH ROW EXECUTE FUNCTION alkao_private.touch_updated_at();

-- ── Control-contract inbox (idempotency / replay log) ───────────────────────
-- Server-only: RLS enabled, zero policies, zero grants.
CREATE TABLE public.ticketing_control_events (
  event_id uuid PRIMARY KEY,
  contract_version text NOT NULL,
  type text NOT NULL,
  client_id uuid,
  issued_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  outcome text NOT NULL CHECK (outcome IN ('applied', 'stale'))
);
CREATE INDEX ticketing_control_events_client_idx
  ON public.ticketing_control_events (client_id, received_at);
ALTER TABLE public.ticketing_control_events ENABLE ROW LEVEL SECURITY;

-- ── Audit log ───────────────────────────────────────────────────────────────
-- brand_id is NULL only for Client-level actions (memberships, Client terms).
CREATE TABLE public.ticketing_audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id uuid NOT NULL REFERENCES public.ticketing_clients (id) ON DELETE RESTRICT,
  brand_id uuid,
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'control', 'system', 'public')),
  actor_id text,
  action text NOT NULL CHECK (action ~ '^[a-z_]+(\.[a-z_]+)+$'),
  entity_type text NOT NULL,
  entity_id text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticketing_audit_log_brand_fkey FOREIGN KEY (brand_id, client_id)
    REFERENCES public.ticketing_brands (id, client_id) ON DELETE RESTRICT
);
CREATE INDEX ticketing_audit_log_client_idx ON public.ticketing_audit_log (client_id, created_at);
ALTER TABLE public.ticketing_audit_log ENABLE ROW LEVEL SECURITY;

-- Append-only.
CREATE OR REPLACE FUNCTION alkao_private.reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION '%_is_append_only', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END;
$$;
REVOKE ALL ON FUNCTION alkao_private.reject_mutation() FROM PUBLIC;
CREATE TRIGGER ticketing_audit_log_append_only BEFORE UPDATE OR DELETE ON public.ticketing_audit_log
  FOR EACH ROW EXECUTE FUNCTION alkao_private.reject_mutation();

-- ── RLS helpers (SECURITY DEFINER, boolean only, empty search_path) ─────────
CREATE OR REPLACE FUNCTION alkao_private.is_client_member(target_client uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.ticketing_memberships m
    WHERE m.client_id = target_client
      AND m.user_id = auth.uid()
      AND m.status = 'active'
  )
$$;

CREATE OR REPLACE FUNCTION alkao_private.has_client_role(target_client uuid, roles text[])
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.ticketing_memberships m
    WHERE m.client_id = target_client
      AND m.user_id = auth.uid()
      AND m.status = 'active'
      AND m.role = ANY (roles)
  )
$$;

REVOKE ALL ON FUNCTION alkao_private.is_client_member(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION alkao_private.has_client_role(uuid, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION alkao_private.is_client_member(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION alkao_private.has_client_role(uuid, text[]) TO authenticated;

-- ── Grants: remove Supabase default ALL; authenticated gets SELECT only ─────
REVOKE ALL ON TABLE
  public.ticketing_clients,
  public.ticketing_brands,
  public.ticketing_memberships,
  public.ticketing_entitlements,
  public.ticketing_control_events,
  public.ticketing_audit_log
FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.ticketing_audit_log_id_seq FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE
  public.ticketing_clients,
  public.ticketing_brands,
  public.ticketing_memberships,
  public.ticketing_entitlements,
  public.ticketing_audit_log
TO authenticated;

-- ── Policies (SELECT only) ──────────────────────────────────────────────────
CREATE POLICY ticketing_clients_member_read ON public.ticketing_clients
  FOR SELECT TO authenticated
  USING (alkao_private.is_client_member(id));

CREATE POLICY ticketing_brands_member_read ON public.ticketing_brands
  FOR SELECT TO authenticated
  USING (alkao_private.is_client_member(client_id));

-- A member sees their own membership; owners/admins see their Client's memberships.
CREATE POLICY ticketing_memberships_read ON public.ticketing_memberships
  FOR SELECT TO authenticated
  USING (
    (user_id = auth.uid() AND status = 'active')
    OR alkao_private.has_client_role(client_id, ARRAY['owner', 'admin'])
  );

CREATE POLICY ticketing_entitlements_member_read ON public.ticketing_entitlements
  FOR SELECT TO authenticated
  USING (alkao_private.is_client_member(client_id));

CREATE POLICY ticketing_audit_log_admin_read ON public.ticketing_audit_log
  FOR SELECT TO authenticated
  USING (alkao_private.has_client_role(client_id, ARRAY['owner', 'admin']));

-- ticketing_control_events: intentionally no policy.
