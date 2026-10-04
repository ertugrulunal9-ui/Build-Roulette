-- Build Roulette: function privileges, the `private` schema and game constants.
--
-- Part of T-011 (M2 solo loop). Later migrations in this wave add the deck,
-- storage, the battle RPCs, the job queue and the sweeps.
--
-- Conventions for every function added from here on (checked by
-- tests/04_functions.test.sql, which looks at the catalog, so new functions
-- are covered automatically):
--   * SECURITY DEFINER and `set search_path = ''`; every reference is
--     schema-qualified (pg_catalog is still searched implicitly).
--   * EXECUTE is revoked from public and anon and granted explicitly, either
--     to `authenticated` (client RPCs) or to `service_role` (workers, sweeps).
--   * Internal helpers live in `private`, which is not exposed by the Data API
--     and on which no API role has USAGE. They run as the owner (postgres)
--     because only SECURITY DEFINER functions call them.

-- ─── Default privileges for functions ─────────────────────────────────────
-- The initial migration revoked the Supabase default grants for tables and
-- sequences. Functions were still auto-granted to anon and authenticated
-- (Supabase's per-schema default) and to PUBLIC (the built-in global
-- default). Close both, so a function that a later migration forgets to lock
-- down is not callable by clients. A per-schema entry cannot take away a
-- global default, hence the second, schema-less statement. It applies to
-- functions the migration role creates in any schema.
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
alter default privileges revoke execute on functions from public;

-- ─── private schema ───────────────────────────────────────────────────────
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
alter default privileges in schema private revoke execute on functions from public, anon, authenticated;

-- ─── Constants shared with @br/game ───────────────────────────────────────
-- packages/game/src/schema-drift.test.ts parses the two functions below and
-- compares them with BUILD_TIME_LIMITS_MINUTES and DEFAULT_PHASE_DURATIONS.
-- Keep each `array[...]` / `jsonb_build_object(...)` a flat literal list.

-- Allowed build time limits in seconds: 3, 5, 10, 15, 20, 30 minutes.
create function private.build_time_limits_seconds()
returns int[]
language sql
immutable
security definer
set search_path = ''
as $$
  select array[180, 300, 600, 900, 1200, 1800]
$$;

-- Default phase durations (seconds), snapshotted into battles.settings when a
-- battle starts. `<phase>_s` keys mirror DEFAULT_PHASE_DURATIONS; the extra
-- `capture_deadline_s` is how long after SHIPPING ends the battle waits for
-- screenshots before it is destroyed anyway (docs/04 transition table).
create function private.default_battle_settings()
returns jsonb
language sql
immutable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'spinning_s', 6,
    'shipping_s', 15,
    'voting_s', 60,
    'results_s', 60,
    'capture_deadline_s', 600
  )
$$;

-- A duration from battles.settings, falling back to the default above.
create function private.setting_interval(p_settings jsonb, p_key text)
returns interval
language sql
immutable
security definer
set search_path = ''
as $$
  select make_interval(secs => coalesce(
    (p_settings ->> p_key)::numeric,
    (private.default_battle_settings() ->> p_key)::numeric
  )::double precision)
$$;

-- ─── Card tag rules ───────────────────────────────────────────────────────
-- prompt_cards.tags uses a tiny vocabulary (see the deck migration):
--   needs:<cap>   this card cannot be done without <cap>
--   no:<cap>      this card forbids <cap>
-- Two cards are compatible unless one forbids what the other needs. The draw
-- checks every pair of the three cards, so a challenge never asks for
-- something impossible (e.g. "Every action makes a sound" + "Silent film").
create function private.tags_compatible(p_a text[], p_b text[])
returns boolean
language sql
immutable
security definer
set search_path = ''
as $$
  select not exists (
    select 1
    from unnest(coalesce(p_a, '{}')) as a(tag)
    cross join unnest(coalesce(p_b, '{}')) as b(tag)
    where (a.tag like 'no:%' and b.tag = 'needs:' || substr(a.tag, 4))
       or (b.tag like 'no:%' and a.tag = 'needs:' || substr(b.tag, 4))
  )
$$;

revoke all on function private.build_time_limits_seconds()      from public, anon, authenticated;
revoke all on function private.default_battle_settings()        from public, anon, authenticated;
revoke all on function private.setting_interval(jsonb, text)    from public, anon, authenticated;
revoke all on function private.tags_compatible(text[], text[])  from public, anon, authenticated;
