-- Supabase compatibility shim, part 1: roles and schemas.
--
-- TEST HARNESS ONLY. Never copy this into a migration: a real Supabase project
-- already has all of this. scripts/test.sh applies it to a throwaway vanilla
-- Postgres cluster, as the superuser `postgres`, before running the migrations.
--
-- Emulated:
--   * API roles anon, authenticated, service_role (NOLOGIN; service_role has
--     BYPASSRLS like on Supabase), and authenticator (LOGIN NOINHERIT, member of
--     the three API roles) for completeness.
--   * Schemas `extensions` (where Supabase installs extensions) and `auth`.
--   * USAGE on public/auth/extensions for the API roles.
--   * Supabase's default privileges: every table/sequence/function that
--     `postgres` creates in `public` is granted to anon, authenticated and
--     service_role. This is the dangerous default the migration has to revoke,
--     so we reproduce it to make the privilege tests meaningful.
--   * search_path "$user", public, extensions (Supabase sets this for postgres).
--
-- Every statement is idempotent so the file can be re-applied safely.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator login noinherit;
  end if;
end
$$;

grant anon, authenticated, service_role to authenticator;

create schema if not exists extensions;
create schema if not exists auth;

grant usage on schema public     to anon, authenticated, service_role;
grant usage on schema extensions to anon, authenticated, service_role;
grant usage on schema auth       to anon, authenticated, service_role;

alter default privileges for role postgres in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on sequences to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on functions to anon, authenticated, service_role;

-- Applies to sessions opened after this script (migrations and tests run in
-- new psql sessions).
alter database postgres set search_path to "$user", public, extensions;
