-- Supabase compatibility shim, part 2: a minimal `auth` schema.
--
-- TEST HARNESS ONLY (see 01_roles.sql).
--
-- Emulated:
--   * auth.users with the handful of columns our schema and tests touch. The
--     real table (owned by supabase_auth_admin, managed by GoTrue) has many
--     more columns; anything beyond `id` is informational here.
--   * auth.uid(), auth.role(), auth.jwt(): same bodies as Supabase. They read
--     the PostgREST GUC `request.jwt.claims` (and the legacy
--     `request.jwt.claim.sub` / `request.jwt.claim.role`).
--
-- Tests impersonate a user with:
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"<uuid>","role":"authenticated"}';

create table if not exists auth.users (
  id                 uuid primary key,
  email              text,
  is_anonymous       boolean not null default false,
  raw_user_meta_data jsonb not null default '{}',
  created_at         timestamptz not null default now()
);

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

create or replace function auth.jwt()
returns jsonb
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

grant execute on function auth.uid(), auth.role(), auth.jwt()
  to anon, authenticated, service_role;
