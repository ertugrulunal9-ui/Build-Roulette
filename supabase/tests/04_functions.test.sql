-- Function hygiene and EXECUTE privileges. Catalog-driven: functions added by
-- later migrations to `public` or `private` are covered automatically.
--
-- The rule: anon can execute exactly get_public_battle (the permanent results
-- page, T-014) and get_player_history (the player history page, T-021);
-- authenticated can execute exactly the client RPCs plus the RLS helpers that
-- policies call; the worker and sweep functions are service_role only; nothing
-- in `private` is reachable by an API role.

begin;
create extension if not exists pgtap with schema extensions;

select plan(14);

create temp view our_functions as
select p.oid, n.nspname as schema, p.proname as name,
       format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) as signature,
       p.prosecdef, p.proconfig
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname in ('public', 'private')
  and p.prokind in ('f', 'p')
  -- not created by an extension
  and not exists (select 1 from pg_depend d
                  where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e');
grant select on our_functions to public;

-- ─── Hygiene (3) ──────────────────────────────────────────────────────────
select cmp_ok((select count(*)::int from our_functions), '>=', 30,
  'the checks below see all our functions');

select is_empty(
  $$ select signature from our_functions where not prosecdef $$,
  'every function in public and private is SECURITY DEFINER');

select is_empty(
  $$ select signature from our_functions
     where proconfig is distinct from array['search_path=""'] $$,
  'every function in public and private pins search_path to empty');

-- ─── EXECUTE (6) ──────────────────────────────────────────────────────────
select set_eq(
  $$ select signature from our_functions where has_function_privilege('anon', oid, 'EXECUTE') $$,
  array['public.get_public_battle(p_battle_id uuid)',
        'public.get_player_history(p_user_id uuid, p_before timestamp with time zone, p_before_battle uuid, p_limit integer)'],
  'anon can execute exactly get_public_battle and get_player_history (public pages)');

select set_eq(
  $$ select signature from our_functions where has_function_privilege('authenticated', oid, 'EXECUTE') $$,
  array[
    -- client RPCs
    'public.server_now()',
    'public.start_solo_battle(p_display_name text, p_time_limit_seconds integer)',
    'public.advance_battle(p_battle_id uuid, p_expected_version integer)',
    'public.ship_build(p_battle_id uuid, p_name text, p_stats jsonb)',
    'public.get_battle_snapshot(p_battle_id uuid)',
    'public.get_public_battle(p_battle_id uuid)',
    -- the player history page (T-021)
    'public.get_player_history(p_user_id uuid, p_before timestamp with time zone, p_before_battle uuid, p_limit integer)',
    -- room RPCs (T-016)
    'public.create_room(p_display_name text)',
    'public.join_room(p_code text, p_display_name text)',
    'public.leave_room(p_room_id uuid)',
    'public.set_ready(p_room_id uuid, p_ready boolean)',
    'public.update_room_settings(p_room_id uuid, p_settings jsonb)',
    'public.kick_member(p_room_id uuid, p_user_id uuid)',
    'public.heartbeat(p_room_id uuid)',
    'public.get_room_snapshot(p_room_id uuid)',
    'public.start_battle(p_room_id uuid)',
    -- reveal and voting RPCs (T-019)
    'public.reveal_next(p_battle_id uuid, p_expected_version integer)',
    'public.skip_to_vote(p_battle_id uuid, p_expected_version integer)',
    'public.cast_vote(p_battle_id uuid, p_category text, p_build_id uuid)',
    'public.get_my_votes(p_battle_id uuid)',
    'public.get_reveal_builds(p_battle_id uuid)',
    -- RLS helpers called by table, storage and realtime.messages policies
    'public.is_room_member(p_room_id uuid)',
    'public.is_battle_member(p_battle_id uuid)',
    'public.can_view_battle(p_battle_id uuid)',
    'public.can_write_build_object(p_name text)',
    'public.can_read_revealed_object(p_name text)',
    'public.can_use_realtime_topic(p_topic text, p_send boolean)'
  ],
  'authenticated can execute exactly the client RPCs and the RLS helpers');

select ok(
  bool_and(has_function_privilege('service_role', f, 'EXECUTE')),
  'service_role can execute the worker and sweep functions')
from unnest(array[
  'public.claim_job(public.job_kind)',
  'public.complete_capture(uuid, public.capture_status, text)',
  'public.fail_job(bigint, text)',
  'public.complete_destroy(uuid)',
  'public.sweep_deadlines()',
  'public.sweep_ttl()',
  'public.advance_battle(uuid, integer)']) as f;

select is_empty(
  $$ select signature from our_functions
     where schema = 'private'
       and (has_function_privilege('service_role', oid, 'EXECUTE')
            or has_function_privilege('authenticated', oid, 'EXECUTE')) $$,
  'no API role can execute a private function');

select ok(
  not has_schema_privilege('anon', 'private', 'USAGE')
  and not has_schema_privilege('authenticated', 'private', 'USAGE')
  and not has_schema_privilege('service_role', 'private', 'USAGE'),
  'no API role has USAGE on schema private');

-- A function that a later migration forgets to lock down is not executable
-- by clients (default privileges).
create function public.__probe_default_acl() returns int language sql as 'select 1';
create function private.__probe_default_acl() returns int language sql as 'select 1';
select ok(
  not has_function_privilege('anon', 'public.__probe_default_acl()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.__probe_default_acl()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private.__probe_default_acl()', 'EXECUTE'),
  'default privileges: a new public or private function is not executable by anon/authenticated');
drop function public.__probe_default_acl();
drop function private.__probe_default_acl();

-- ─── Calls as the API roles (5) ───────────────────────────────────────────
set local role anon;
select throws_ok($$ select public.server_now() $$, '42501', null, 'anon: server_now is denied');
select throws_ok($$ select public.get_battle_snapshot(gen_random_uuid()) $$, '42501', null,
  'anon: get_battle_snapshot is denied');
reset role;

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"4a000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select throws_ok($$ select public.claim_job('capture') $$, '42501', null,
  'authenticated: claim_job is denied');
select throws_ok($$ select public.sweep_deadlines() $$, '42501', null,
  'authenticated: sweep_deadlines is denied');
select cmp_ok(abs(extract(epoch from public.server_now() - clock_timestamp())), '<', 5::numeric,
  'authenticated: server_now returns the server clock');
reset role;

select * from finish();
rollback;
