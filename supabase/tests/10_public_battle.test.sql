-- T-014 additions: get_public_battle (the permanent results page, readable
-- with the anon key) and the autosave/bundle.css storage slot.
--
-- Cast: nora (plays and ships), otto (only autosaves, with CSS → auto-shipped),
-- pia (her battle is abandoned).

begin;
create extension if not exists pgtap with schema extensions;

select plan(30);

\set nora '{"sub":"9a000000-0000-0000-0000-000000000001","role":"authenticated"}'
\set otto '{"sub":"9a000000-0000-0000-0000-000000000002","role":"authenticated"}'
\set pia  '{"sub":"9a000000-0000-0000-0000-000000000003","role":"authenticated"}'
\set nora_id '9a000000-0000-0000-0000-000000000001'
\set otto_id '9a000000-0000-0000-0000-000000000002'
\set pia_id  '9a000000-0000-0000-0000-000000000003'
\set service '{"role":"service_role"}'

insert into auth.users (id, is_anonymous) values (:'nora_id', true), (:'otto_id', true), (:'pia_id', true);

-- Calls get_public_battle as anon (no session), the way the results page does.
create function pg_temp.public_battle(p_id uuid) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  set local role anon;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  v := public.get_public_battle(p_id);
  reset role;
  return v;
end $$;
grant execute on function pg_temp.public_battle(uuid) to public;

-- ═══ nora: SPINNING ═══════════════════════════════════════════════════════
set local role authenticated;
select set_config('request.jwt.claims', :'nora', true);
select public.start_solo_battle('Nora', 300) as n_battle \gset
reset role;
\set np :n_battle '/' :nora_id

-- ─── Nothing is public before RESULTS (5) ─────────────────────────────────
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok(format($$ select public.get_public_battle(%L) $$, :'n_battle'),
  'P0002', 'battle_not_found', 'SPINNING: anon gets battle_not_found');
select throws_ok($$ select public.get_public_battle(gen_random_uuid()) $$,
  'P0002', 'battle_not_found', 'an unknown id gets the same answer');
reset role;

set local role authenticated;
select set_config('request.jwt.claims', :'nora', true);
select throws_ok(format($$ select public.get_public_battle(%L) $$, :'n_battle'),
  'P0002', 'battle_not_found', 'SPINNING: not even the player gets it (she has the snapshot)');
reset role;

update public.battles set phase_ends_at = now() - interval '1 second' where id = :'n_battle';
set local role authenticated;
select set_config('request.jwt.claims', :'nora', true);
select public.advance_battle(:'n_battle', 1) ->> 'phase' as n_phase \gset
reset role;
select is(:'n_phase'::text, 'building', 'fixture: nora is BUILDING');

set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok(format($$ select public.get_public_battle(%L) $$, :'n_battle'),
  'P0002', 'battle_not_found', 'BUILDING: anon gets battle_not_found');
reset role;

-- ─── autosave/bundle.css (4) ──────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', :'nora', true);
select lives_ok(
  format($$ insert into storage.objects (bucket_id, name, owner_id) values ('ephemeral-builds', %L, %L) $$,
         :'np' || '/autosave/bundle.css', :'nora_id'),
  'the owner can create autosave/bundle.css while BUILDING');
with u as (
  update storage.objects set user_metadata = '{"v": 2}'
  where bucket_id = 'ephemeral-builds' and name = :'np' || '/autosave/bundle.css'
  returning 1)
select count(*) as n from u \gset
select is(:n::int, 1, 'and overwrite it (upsert)');
select throws_ok(
  format($$ insert into storage.objects (bucket_id, name) values ('ephemeral-builds', %L) $$,
         :'np' || '/autosave/thumb.webp'),
  '42501', null, 'other autosave names are still refused');
select is(public.can_write_build_object(:'np' || '/autosave/bundle.css'), true,
  'can_write_build_object accepts autosave/bundle.css');
reset role;

-- ═══ nora ships (SHIPPING is passed through at once) ══════════════════════
update public.battles
   set building_started_at = now() - interval '60 seconds',
       building_ends_at    = now() + interval '240 seconds',
       phase_ends_at       = now() + interval '240 seconds'
 where id = :'n_battle';
insert into storage.objects (bucket_id, name) values
  ('ephemeral-builds', :'np' || '/source.json'),
  ('ephemeral-builds', :'np' || '/bundle.js');
set local role authenticated;
select set_config('request.jwt.claims', :'nora', true);
select public.ship_build(:'n_battle', 'Snack Overflow',
  '{"files": 3, "lines": 42, "deps": ["react", "react-dom"]}') -> 'build' ->> 'id' as n_build \gset
reset role;

-- ─── RESULTS: permanent data only (13) ────────────────────────────────────
select pg_temp.public_battle(:'n_battle') as n_pub \gset

select is((:'n_pub'::jsonb) -> 'battle' ->> 'phase', 'results', 'RESULTS: anon can read the battle');
select is(
  (select array_agg(k order by k) from jsonb_object_keys((:'n_pub'::jsonb) -> 'battle') k),
  array['building_ends_at', 'building_started_at', 'created_at', 'destroyed_at', 'finished_at',
        'id', 'is_complete', 'mode', 'phase'],
  'battle: timestamps, mode and phase only (no host, room, settings or version)');
select is((:'n_pub'::jsonb) -> 'challenge' -> 'build' ->> 'text',
  (select c.build_text from public.battles b join public.challenges c on c.id = b.challenge_id
   where b.id = :'n_battle'),
  'the challenge texts are included');
select is((:'n_pub'::jsonb) -> 'challenge' ->> 'time_limit_seconds', '300', 'and the time limit');
select is((:'n_pub'::jsonb) -> 'players', '["Nora"]'::jsonb, 'players are display names only');
select is(
  (select array_agg(k order by k) from jsonb_object_keys((:'n_pub'::jsonb) -> 'builds' -> 0) k),
  array['builder_name', 'capture_status', 'completion_ms', 'final_rank', 'id', 'name',
        'screenshot_path', 'shipped_at', 'stats', 'status', 'total_votes', 'votes'],
  'builds: the permanent fields only (no builder id, no source_destroyed_at; votes = per-category counts)');
select results_eq(
  format($$ select b ->> 'builder_name', b ->> 'name', b ->> 'status', (b ->> 'completion_ms')::int,
                   (b ->> 'final_rank')::int, b ->> 'id'
            from jsonb_array_elements(%L::jsonb -> 'builds') b $$, :'n_pub'),
  format($$ values ('Nora', 'Snack Overflow', 'shipped', 60000, 1, %L) $$, :'n_build'),
  'the build: builder name, build name, status, completion time, rank');
select is((:'n_pub'::jsonb) -> 'builds' -> 0 -> 'screenshot_path', 'null'::jsonb,
  'no screenshot path while the capture is pending');
select is((:'n_pub'::jsonb) -> 'awards',
  jsonb_build_array(jsonb_build_object('build_id', :'n_build', 'award', 'speedrun', 'source', 'auto', 'votes', null)),
  'the auto-award is included');
select ok(position(:'nora_id' in :'n_pub') = 0,
  'the player''s user id appears nowhere in the output');
select ok(:'n_pub' !~ '(source\.json|bundle\.js|bundle\.css|thumb\.webp|autosave)',
  'no ephemeral storage path appears in the output');

set local role service_role;
select set_config('request.jwt.claims', :'service', true);
select public.complete_capture(:'n_build'::uuid, 'captured', :'n_battle' || '/' || :'n_build' || '.webp');
reset role;
select is(pg_temp.public_battle(:'n_battle') -> 'builds' -> 0 ->> 'screenshot_path',
  :'n_battle' || '/' || :'n_build' || '.webp', 'the public screenshot path once captured');

set local role authenticated;
select set_config('request.jwt.claims', :'otto', true);
select is(public.get_public_battle(:'n_battle') -> 'battle' ->> 'id', :'n_battle',
  'any signed-in user can read it too');
reset role;

-- ═══ DESTROYED: still public (2) ═══════════════════════════════════════════
update public.battles set phase_ends_at = now() - interval '1 second' where id = :'n_battle';
select public.sweep_deadlines();
select is((select phase::text from public.battles where id = :'n_battle'), 'destroyed',
  'fixture: nora''s battle is DESTROYED');
select is(pg_temp.public_battle(:'n_battle') -> 'builds' -> 0 ->> 'name', 'Snack Overflow',
  'DESTROYED: the results stay public');

-- ═══ otto: autosave with CSS → auto_shipped (2) ═══════════════════════════
set local role authenticated;
select set_config('request.jwt.claims', :'otto', true);
select public.start_solo_battle('Otto', 300) as o_battle \gset
reset role;
update public.battles set phase_ends_at = now() - interval '1 second' where id = :'o_battle';
select public.sweep_deadlines();
insert into storage.objects (bucket_id, name) values
  ('ephemeral-builds', :'o_battle' || '/' || :'otto_id' || '/autosave/source.json'),
  ('ephemeral-builds', :'o_battle' || '/' || :'otto_id' || '/autosave/bundle.js'),
  ('ephemeral-builds', :'o_battle' || '/' || :'otto_id' || '/autosave/bundle.css');
update public.battles
   set building_started_at = now() - interval '320 seconds',
       building_ends_at    = now() - interval '20 seconds',
       phase_ends_at       = now() - interval '20 seconds'
 where id = :'o_battle';
select public.sweep_deadlines();   -- BUILDING → SHIPPING (grace)
select throws_ok(format($$ select pg_temp.public_battle(%L) $$, :'o_battle'),
  'P0002', 'battle_not_found', 'SHIPPING: anon gets battle_not_found');
update public.battles set phase_ends_at = now() - interval '1 second' where id = :'o_battle';
select public.sweep_deadlines();   -- SHIPPING → RESULTS, auto-ship
select is(pg_temp.public_battle(:'o_battle') -> 'builds' -> 0 ->> 'status', 'auto_shipped',
  'an autosave with CSS is auto-shipped (and public at RESULTS)');

-- ═══ pia: ABANDONED is not public (1) ═════════════════════════════════════
set local role authenticated;
select set_config('request.jwt.claims', :'pia', true);
select public.start_solo_battle('Pia', 300) as p_battle \gset
reset role;
update public.battles set phase = 'abandoned', phase_ends_at = null where id = :'p_battle';
select throws_ok(format($$ select pg_temp.public_battle(%L) $$, :'p_battle'),
  'P0002', 'battle_not_found', 'ABANDONED: not public');

-- ═══ Disqualified builds are hidden (2) ════════════════════════════════════
update public.builds set status = 'disqualified' where id = :'n_build';
select is(pg_temp.public_battle(:'n_battle') -> 'builds', '[]'::jsonb,
  'a disqualified build is left out');
select is(pg_temp.public_battle(:'n_battle') -> 'awards', '[]'::jsonb,
  'and so are its awards');

-- ═══ Privileges (1) ═══════════════════════════════════════════════════════
select ok(
  has_function_privilege('anon', 'public.get_public_battle(uuid)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.get_public_battle(uuid)', 'EXECUTE'),
  'anon and authenticated can execute get_public_battle');

select * from finish();
rollback;
