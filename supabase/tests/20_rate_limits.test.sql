-- T-024: per-user rate limits (private.rate_limits, private.rate_events, the helpers) and
-- their use in create_room, join_room (failed codes only), report_build,
-- start_solo_battle and cast_vote.
--
-- Events are seeded directly where reaching a limit through the RPC would need dozens of
-- calls with other side effects (rooms, battles); the counting itself (only successful
-- calls, failed join codes, nothing else) is checked through the RPCs.

begin;
create extension if not exists pgtap with schema extensions;

select plan(33);

\set ana '{"sub":"20a00000-0000-0000-0000-000000000001","role":"authenticated"}'
\set ben '{"sub":"20a00000-0000-0000-0000-000000000002","role":"authenticated"}'
\set cy  '{"sub":"20a00000-0000-0000-0000-000000000003","role":"authenticated"}'
\set dee '{"sub":"20a00000-0000-0000-0000-000000000004","role":"authenticated"}'
\set ana_id '20a00000-0000-0000-0000-000000000001'
\set ben_id '20a00000-0000-0000-0000-000000000002'
\set cy_id  '20a00000-0000-0000-0000-000000000003'
\set dee_id '20a00000-0000-0000-0000-000000000004'
insert into auth.users (id, is_anonymous)
select ('20a00000-0000-0000-0000-00000000000' || n)::uuid, true from generate_series(1, 4) n;

create function pg_temp.events(p_user uuid, p_action text) returns int language sql as $$
  select count(*)::int from private.rate_events where user_id = p_user and action = p_action
$$;
-- n events of p_action for p_user, p_age seconds old.
create function pg_temp.seed(p_user uuid, p_action text, p_n int, p_age int) returns void language sql as $$
  insert into private.rate_events (action, user_id, created_at)
  select p_action, p_user, now() - make_interval(secs => p_age) from generate_series(1, p_n)
$$;

-- ─── The configuration (2) ────────────────────────────────────────────────
select results_eq(
  $$ select action, max_count, window_s from private.rate_limits order by action $$,
  $$ values ('cast_vote', 120, 60), ('create_room', 10, 3600), ('join_room_failed', 20, 600),
            ('report_build', 20, 3600), ('start_solo_battle', 30, 3600) $$,
  'the default limits (mirrored by @br/game RATE_LIMITS)');
select ok(not has_table_privilege('service_role', 'private.rate_limits', 'SELECT')
          and not has_table_privilege('authenticated', 'private.rate_events', 'SELECT'),
  'limits and events are service-side only');

-- ─── The helper (10) ──────────────────────────────────────────────────────
update private.rate_limits set max_count = 3, window_s = 600 where action = 'report_build';
select lives_ok($$ select private.rate_limit('report_build', '20a00000-0000-0000-0000-000000000001') $$,
  'under the limit: allowed');
select is(pg_temp.events(:'ana_id', 'report_build'), 1, 'an allowed call is counted');
select pg_temp.seed(:'ana_id', 'report_build', 2, 100);
select throws_ok($$ select private.rate_limit('report_build', '20a00000-0000-0000-0000-000000000001') $$,
  'PT429', 'rate_limited', 'at the limit: rate_limited (SQLSTATE PT429 → HTTP 429)');
select is(pg_temp.events(:'ana_id', 'report_build'), 3, 'a refused call is not counted');

-- The error's details and hint: the oldest event (100 s old) frees the slot in 500 s.
create function pg_temp.err(p_sql text) returns jsonb language plpgsql as $$
declare v_m text; v_d text; v_h text; v_s text;
begin
  execute p_sql;
  return null;
exception when others then
  get stacked diagnostics v_s = returned_sqlstate, v_m = message_text, v_d = pg_exception_detail,
                          v_h = pg_exception_hint;
  return jsonb_build_object('code', v_s, 'message', v_m, 'details', v_d, 'hint', v_h);
end;
$$;
select is(pg_temp.err($$ select private.rate_limit('report_build', '20a00000-0000-0000-0000-000000000001') $$),
  '{"code":"PT429","message":"rate_limited","details":"You sent too many reports recently. Try again in 9 minutes.","hint":"{\"retry_after_s\": 500}"}'::jsonb,
  'details for people, hint {"retry_after_s": n} for clients (sliding window: the oldest event decides)');

-- Expired events do not count, and are pruned by the next check.
delete from private.rate_events where user_id = :'ana_id';
select pg_temp.seed(:'ana_id', 'report_build', 5, 601);
select lives_ok($$ select private.rate_limit('report_build', '20a00000-0000-0000-0000-000000000001') $$,
  'events older than the window do not count');
select is(pg_temp.events(:'ana_id', 'report_build'), 1, 'the check prunes the user''s expired events');
-- Other users and other actions are separate.
select pg_temp.seed(:'ben_id', 'report_build', 3, 10);
select lives_ok($$ select private.rate_limit('create_room', '20a00000-0000-0000-0000-000000000002') $$,
  'limits are per action');
select throws_ok($$ select private.rate_limit_check('nope', '20a00000-0000-0000-0000-000000000002') $$,
  'P0001', null, 'an unknown action is a programming error');

-- prune_rate_events (hourly cron) drops what no window can see any more.
select pg_temp.seed(:'cy_id', 'cast_vote', 4, 90000);
select cmp_ok(private.prune_rate_events(), '>=', 4, 'prune_rate_events deletes events older than the longest window');

-- ─── create_room: 10 per hour (4) ─────────────────────────────────────────
delete from private.rate_events;
update private.rate_limits set max_count = 20, window_s = 3600 where action = 'report_build';
set local role authenticated;
select set_config('request.jwt.claims', :'ana', true);
select public.create_room('Ana') as r1 \gset
reset role;
select is(pg_temp.events(:'ana_id', 'create_room'), 1, 'create_room: a created room is counted');
set local role authenticated;
select set_config('request.jwt.claims', :'ana', true);
select throws_ok($$ select public.create_room('') $$, '22023', 'invalid_display_name', 'a refused create...');
reset role;
select is(pg_temp.events(:'ana_id', 'create_room'), 1, '...is not counted');
select pg_temp.seed(:'ana_id', 'create_room', 9, 1800);
set local role authenticated;
select set_config('request.jwt.claims', :'ana', true);
select throws_ok($$ select public.create_room('Ana') $$, 'PT429', 'rate_limited',
  'create_room: the 11th room within an hour is refused');
reset role;

-- ─── join_room: 20 FAILED codes per 10 minutes (9) ───────────────────────
set local role authenticated;
select set_config('request.jwt.claims', :'ben', true);
select is((select count(*)::int from (select public.join_room('ZZZZZ', 'Ben') from generate_series(1, 19)) x), 19,
  'join_room: 19 wrong codes answer room_not_found');
reset role;
select is(pg_temp.events(:'ben_id', 'join_room_failed'), 19, 'each failed code is counted (the answer is returned, not raised)');
set local role authenticated;
select set_config('request.jwt.claims', :'ben', true);
select is(public.join_room((:'r1'::jsonb) ->> 'code', 'Ben') ->> 'role', 'player',
  'a right code still works below the limit');
reset role;
select is(pg_temp.events(:'ben_id', 'join_room_failed'), 19, 'a successful join is not counted');
set local role authenticated;
select set_config('request.jwt.claims', :'ben', true);
select is(public.join_room('I0O1x', 'Ben') ->> 'message', 'room_not_found', 'the 20th failure');
select throws_ok($$ select public.join_room('ZZZZZ', 'Ben') $$, 'PT429', 'rate_limited',
  'the 21st attempt within 10 minutes is refused');
select throws_ok(format($$ select public.join_room(%L, 'Ben') $$, (:'r1'::jsonb) ->> 'code'), 'PT429', 'rate_limited',
  'a right code too, while at the limit (no guessing around it)');
reset role;
-- Failures of a right code (kicked, full) are not guesses.
insert into public.profiles (id, display_name) values (:'cy_id', 'Cy') on conflict do nothing;
insert into public.room_members (room_id, user_id, role, kicked_at)
values (((:'r1'::jsonb) ->> 'room_id')::uuid, :'cy_id', 'player', now());
set local role authenticated;
select set_config('request.jwt.claims', :'cy', true);
select throws_ok(format($$ select public.join_room(%L, 'Cy') $$, (:'r1'::jsonb) ->> 'code'), '42501', 'kicked',
  'kicked: still raised...');
reset role;
select is(pg_temp.events(:'cy_id', 'join_room_failed'), 0, '...and not counted as a guess');

-- ─── start_solo_battle: 30 per hour (3) ───────────────────────────────────
select pg_temp.seed(:'dee_id', 'start_solo_battle', 29, 100);
set local role authenticated;
select set_config('request.jwt.claims', :'dee', true);
select lives_ok($$ select public.start_solo_battle('Dee') $$, 'start_solo_battle: the 30th start in an hour');
reset role;
update public.battles set phase = 'results' where host_id = :'dee_id';
set local role authenticated;
select set_config('request.jwt.claims', :'dee', true);
select throws_ok($$ select public.start_solo_battle('Dee') $$, 'PT429', 'rate_limited',
  'start_solo_battle: the 31st is refused');
reset role;
select is(pg_temp.events(:'dee_id', 'start_solo_battle'), 30, 'starts are counted');

-- ─── report_build: 20 per hour (2) ────────────────────────────────────────
select pg_temp.seed(:'cy_id', 'report_build', 20, 60);
set local role authenticated;
select set_config('request.jwt.claims', :'cy', true);
select throws_ok($$ select public.report_build(gen_random_uuid(), 'spam', null) $$, 'PT429', 'rate_limited',
  'report_build: the 21st report within an hour is refused (before any other check)');
select set_config('request.jwt.claims', :'dee', true);
select throws_ok($$ select public.report_build(gen_random_uuid(), 'spam', null) $$, 'P0002', 'build_not_found',
  'another user is not limited');
reset role;

-- ─── cast_vote: 120 per minute (2) ────────────────────────────────────────
select pg_temp.seed(:'cy_id', 'cast_vote', 120, 30);
set local role authenticated;
select set_config('request.jwt.claims', :'cy', true);
select throws_ok($$ select public.cast_vote(gen_random_uuid(), 'overall', gen_random_uuid()) $$, 'PT429',
  'rate_limited', 'cast_vote: the 121st vote within a minute is refused');
reset role;
update private.rate_events set created_at = now() - interval '61 seconds'
 where user_id = :'cy_id' and action = 'cast_vote';
set local role authenticated;
select set_config('request.jwt.claims', :'cy', true);
select throws_ok($$ select public.cast_vote(gen_random_uuid(), 'overall', gen_random_uuid()) $$, 'P0002',
  'battle_not_found', 'a minute later the votes are free again (the next guard answers)');
reset role;

-- ─── Grants (1) ───────────────────────────────────────────────────────────
select ok(not has_function_privilege('authenticated', 'private.rate_limit(text, uuid)', 'EXECUTE')
          and not has_function_privilege('service_role', 'private.rate_limit(text, uuid)', 'EXECUTE'),
  'the helpers are not callable through the API');

select * from finish();
rollback;
