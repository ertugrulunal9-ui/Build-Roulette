-- Every guard of the client RPCs, one failure at a time.
--
-- Cast: gina (plays), hugo (stranger), plus a session without a user.

begin;
create extension if not exists pgtap with schema extensions;

select plan(39);

\set gina '{"sub":"6a000000-0000-0000-0000-000000000001","role":"authenticated"}'
\set hugo '{"sub":"6a000000-0000-0000-0000-000000000002","role":"authenticated"}'
\set nobody '{"role":"authenticated"}'

insert into auth.users (id, is_anonymous) values
  ('6a000000-0000-0000-0000-000000000001', true),
  ('6a000000-0000-0000-0000-000000000002', true);
insert into public.profiles (id, display_name) values ('6a000000-0000-0000-0000-000000000002', 'hugo');

-- ─── Not signed in (4) ────────────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', :'nobody', true);
select throws_ok($$ select public.start_solo_battle('x', 300) $$, '42501', 'not_authenticated',
  'start_solo_battle needs a user');
select throws_ok($$ select public.advance_battle(gen_random_uuid(), 1) $$, '42501', 'not_authenticated',
  'advance_battle needs a user (or the service role)');
select throws_ok($$ select public.ship_build(gen_random_uuid(), 'x', '{}') $$, '42501', 'not_authenticated',
  'ship_build needs a user');
select throws_ok($$ select public.get_battle_snapshot(gen_random_uuid()) $$, '42501', 'not_authenticated',
  'get_battle_snapshot needs a user');
reset role;

-- ─── start_solo_battle input (7) ──────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', :'gina', true);
select throws_ok($$ select public.start_solo_battle('   ', 300) $$, '22023', 'invalid_display_name',
  'blank display name');
select throws_ok($$ select public.start_solo_battle(null, 300) $$, '22023', 'invalid_display_name',
  'null display name');
select throws_ok($$ select public.start_solo_battle(repeat('x', 25), 300) $$, '22023', 'invalid_display_name',
  '25-character display name');
select throws_ok($$ select public.start_solo_battle(e'bad\nname', 300) $$, '22023', 'invalid_display_name',
  'control characters in the display name');
select throws_ok($$ select public.start_solo_battle('gina', 120) $$, '22023', 'invalid_time_limit',
  'a time limit outside the list (2 min)');
select throws_ok($$ select public.start_solo_battle('gina', 3600) $$, '22023', 'invalid_time_limit',
  'a time limit outside the list (60 min)');
select is((select count(*)::int from public.profiles where id = '6a000000-0000-0000-0000-000000000001'), 0,
  'a refused start leaves no profile behind');
reset role;

-- ─── One running battle per player (2) ────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', :'gina', true);
select public.start_solo_battle('gina', 300) as g_battle \gset
select throws_ok($$ select public.start_solo_battle('gina', 300) $$, 'P0001', 'battle_in_progress',
  'a second start while one is running is refused');
reset role;
select is((select count(*)::int from public.battle_players where user_id = '6a000000-0000-0000-0000-000000000001'), 1,
  'only one battle was created');

-- ─── advance_battle (4) ───────────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', :'gina', true);
select throws_ok(format($$ select public.advance_battle(%L, null) $$, :'g_battle'), '22023', 'invalid_version',
  'expected_version is required');
select throws_ok($$ select public.advance_battle(gen_random_uuid(), 1) $$, 'P0002', 'battle_not_found',
  'unknown battle');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', :'hugo', true);
select throws_ok(format($$ select public.advance_battle(%L, 1) $$, :'g_battle'), 'P0002', 'battle_not_found',
  'a non-member cannot advance (same answer as unknown)');
reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok($$ select public.advance_battle(gen_random_uuid(), 1) $$, 'P0002', 'battle_not_found',
  'service role: unknown battle');
reset role;

-- ─── ship_build: phase, roster, files (6) ─────────────────────────────────
insert into storage.objects (bucket_id, name) values
  ('ephemeral-builds', :'g_battle' || '/6a000000-0000-0000-0000-000000000001/source.json');

set local role authenticated;
select set_config('request.jwt.claims', :'gina', true);
select throws_ok(format($$ select public.ship_build(%L, 'x', '{}') $$, :'g_battle'), 'P0001', 'wrong_phase',
  'no ship while SPINNING');
select throws_ok($$ select public.ship_build(gen_random_uuid(), 'x', '{}') $$, 'P0002', 'battle_not_found',
  'unknown battle');
reset role;

update public.battles set phase_ends_at = now() - interval '1 second' where id = :'g_battle';
set local role authenticated;
select set_config('request.jwt.claims', :'gina', true);
select is(public.advance_battle(:'g_battle', 1) ->> 'phase', 'building', 'gina is BUILDING');
select throws_ok(format($$ select public.ship_build(%L, 'x', '{}') $$, :'g_battle'), 'P0001', 'files_missing',
  'bundle.js missing');
reset role;

set local role authenticated;
select set_config('request.jwt.claims', :'hugo', true);
select throws_ok(format($$ select public.ship_build(%L, 'x', '{}') $$, :'g_battle'), '42501', 'not_on_roster',
  'a stranger cannot ship into the battle');
reset role;

-- Files of the wrong player or the wrong bucket do not count.
insert into storage.objects (bucket_id, name) values
  ('ephemeral-builds', :'g_battle' || '/6a000000-0000-0000-0000-000000000002/bundle.js'),
  ('screenshots',      :'g_battle' || '/6a000000-0000-0000-0000-000000000001/bundle.js');
set local role authenticated;
select set_config('request.jwt.claims', :'gina', true);
select throws_ok(format($$ select public.ship_build(%L, 'x', '{}') $$, :'g_battle'), 'P0001', 'files_missing',
  'a bundle.js under another prefix or bucket does not count');
reset role;

insert into storage.objects (bucket_id, name) values
  ('ephemeral-builds', :'g_battle' || '/6a000000-0000-0000-0000-000000000001/bundle.js');

-- ─── ship_build: name (4) ─────────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', :'gina', true);
select throws_ok(format($$ select public.ship_build(%L, '  ', '{}') $$, :'g_battle'), '22023', 'invalid_name',
  'blank name');
select throws_ok(format($$ select public.ship_build(%L, null, '{}') $$, :'g_battle'), '22023', 'invalid_name',
  'null name');
select throws_ok(format($$ select public.ship_build(%L, repeat('x', 49), '{}') $$, :'g_battle'), '22023', 'invalid_name',
  '49-character name');
select throws_ok(format($$ select public.ship_build(%L, e'tab\there', '{}') $$, :'g_battle'), '22023', 'invalid_name',
  'control characters in the name');

-- ─── ship_build: stats (8) ────────────────────────────────────────────────
select throws_ok(format($$ select public.ship_build(%L, 'x', '[1, 2]') $$, :'g_battle'), '22023', 'invalid_stats',
  'stats must be an object');
select throws_ok(format($$ select public.ship_build(%L, 'x', '{"files": "3"}') $$, :'g_battle'), '22023', 'invalid_stats',
  'a number as a string');
select throws_ok(format($$ select public.ship_build(%L, 'x', '{"lines": -1}') $$, :'g_battle'), '22023', 'invalid_stats',
  'a negative number');
select throws_ok(format($$ select public.ship_build(%L, 'x', '{"rebuilds": 1.5}') $$, :'g_battle'), '22023', 'invalid_stats',
  'a fraction');
select throws_ok(format($$ select public.ship_build(%L, 'x', '{"deps": "react"}') $$, :'g_battle'), '22023', 'invalid_stats',
  'deps must be an array');
select throws_ok(format($$ select public.ship_build(%L, 'x', '{"deps": ["../../etc"]}') $$, :'g_battle'), '22023', 'invalid_stats',
  'deps must be npm package names');
select throws_ok(format($$ select public.ship_build(%L, 'x', '{"deps": [42]}') $$, :'g_battle'), '22023', 'invalid_stats',
  'deps must be strings');
select throws_ok(
  format($$ select public.ship_build(%L, 'x', jsonb_build_object('junk', repeat('x', 9000))) $$, :'g_battle'),
  '22023', 'stats_too_large', 'stats over 8 KB');
reset role;

-- ─── ship_build: deadline and double ship (4) ─────────────────────────────
-- The deadline passed 16 s ago: one second beyond the 15 s grace.
update public.battles
   set building_ends_at = now() - interval '16 seconds',
       phase_ends_at    = now() - interval '16 seconds'
 where id = :'g_battle';
set local role authenticated;
select set_config('request.jwt.claims', :'gina', true);
select throws_ok(format($$ select public.ship_build(%L, 'x', '{}') $$, :'g_battle'), 'P0001', 'deadline_passed',
  'one second past the grace is refused, even while the phase is still BUILDING');
reset role;

-- Exactly at the end of the grace: accepted (now() <= building_ends_at + grace).
update public.battles
   set building_started_at = now() - interval '315 seconds',
       building_ends_at    = now() - interval '15 seconds',
       phase_ends_at       = now() - interval '15 seconds'
 where id = :'g_battle';
set local role authenticated;
select set_config('request.jwt.claims', :'gina', true);
select lives_ok(
  format($$ select public.ship_build(%L, 'Edge case', '{"files": 9999, "deps": [%s, "@scope/pkg"], "lines": null}') $$,
         :'g_battle',
         (select string_agg(format('"a%s"', lpad(n::text, 2, '0')), ', ') from generate_series(0, 59) n)),
  'a ship exactly at building_ends_at + grace is accepted');
select throws_ok(format($$ select public.ship_build(%L, 'x', '{}') $$, :'g_battle'), 'P0001', 'already_shipped',
  'double ship');
reset role;
select is((select stats from public.builds where battle_id = :'g_battle'),
  jsonb_build_object('files', 500, 'deps',
    (select jsonb_agg(format('a%s', lpad(n::text, 2, '0')) order by n) from generate_series(0, 49) n)),
  'stats: deps capped at 50 entries, files capped at 500, null values dropped');

select * from finish();
rollback;
