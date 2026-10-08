-- LOCAL/EPHEMERAL TEST DATABASES ONLY. Never apply to staging or production.
--
-- Reproduces the parts of a Supabase project that ALKAO migrations rely on, so RLS can
-- be proven on plain PostgreSQL:
--   * roles anon / authenticated / service_role
--   * auth.uid() reading the PostgREST JWT claims GUC
--   * Supabase's default privileges, which GRANT ALL on new public tables to anon and
--     authenticated. Migrations must revoke these; the tests prove they do.

-- Roles belong to the whole server: test files create them at the same moment, and the
-- loser of that race gets unique_violation rather than duplicate_object.
DO $$
BEGIN
  CREATE ROLE anon NOLOGIN NOINHERIT;
EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
END $$;

DO $$
BEGIN
  CREATE ROLE authenticated NOLOGIN NOINHERIT;
EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
END $$;

DO $$
BEGIN
  CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
END $$;

CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
