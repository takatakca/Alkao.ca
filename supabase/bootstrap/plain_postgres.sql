-- Run 62: what ALKAO's migrations need from a Supabase project, for a production database
-- that is plain PostgreSQL (a Coolify database, Docker, a managed PostgreSQL).
--
--   * roles anon / authenticated / service_role, NOLOGIN: nobody connects as them; the
--     migrations grant and revoke on them, and RLS policies name them;
--   * auth.uid(), read by the staff read policies.
--
-- Unlike supabase/tests/supabase_shim.sql (tests only), it grants nothing by default:
-- a table added later stays closed to anon and authenticated until a migration opens it.
--
-- Safe to run again, and it does nothing on a Supabase project (auth.uid() already there):
-- npm run db:migrate and scripts/container.ts run it before the migrations.
DO $bootstrap$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'auth' AND p.proname = 'uid'
  ) THEN
    RETURN;
  END IF;

  -- Roles belong to the whole server: another database on it may have made them already.
  BEGIN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
  END;
  BEGIN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
  END;
  BEGIN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
  END;

  CREATE SCHEMA IF NOT EXISTS auth;
  REVOKE ALL ON SCHEMA auth FROM PUBLIC;
  GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

  CREATE FUNCTION auth.uid()
  RETURNS uuid
  LANGUAGE sql
  STABLE
  SET search_path = ''
  AS $uid$
    SELECT coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    )::uuid
  $uid$;
  REVOKE ALL ON FUNCTION auth.uid() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
END
$bootstrap$;
