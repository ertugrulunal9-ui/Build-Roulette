-- Storage reads for REVEAL (T-019): who may read which ephemeral-builds file,
-- per phase and role, as the Storage API does (RLS on storage.objects as the
-- request's role), plus get_reveal_builds and abandonment during REVEAL.
--
-- Cast: pia (host, ships by hand), quin (auto-ships; also has a stray
-- top-level bundle.js she never shipped), rae (DNF: only an autosave
-- source.json), sam (kicked while building: draft disqualified), tia (late
-- spectator), vic (room player, not on the roster), uma (stranger).

begin;
create extension if not exists pgtap with schema extensions;

select plan(40);

\set pia  '{"sub":"16a00000-0000-0000-0000-000000000001","role":"authenticated"}'
\set quin '{"sub":"16a00000-0000-0000-0000-000000000002","role":"authenticated"}'
\set rae  '{"sub":"16a00000-0000-0000-0000-000000000003","role":"authenticated"}'
\set sam  '{"sub":"16a00000-0000-0000-0000-000000000004","role":"authenticated"}'
\set tia  '{"sub":"16a00000-0000-0000-0000-000000000005","role":"authenticated"}'
\set uma  '{"sub":"16a00000-0000-0000-0000-000000000006","role":"authenticated"}'
\set vic  '{"sub":"16a00000-0000-0000-0000-000000000007","role":"authenticated"}'
\set pia_id  '16a00000-0000-0000-0000-000000000001'
\set quin_id '16a00000-0000-0000-0000-000000000002'
\set rae_id  '16a00000-0000-0000-0000-000000000003'
\set sam_id  '16a00000-0000-0000-0000-000000000004'
\set uma_id  '16a00000-0000-0000-0000-000000000006'

insert into auth.users (id, is_anonymous)
select ('16a00000-0000-0000-0000-00000000000' || n)::uuid, true from generate_series(1, 7) n;
insert into public.profiles (id, display_name) values (:'uma_id', 'uma');

-- The ephemeral-builds files of a battle that `p_claims` can read (as the
-- `authenticated` role, or `anon` when p_claims is null), written as
-- "<builder display name>/<file>" and sorted.
create function pg_temp.readable(p_claims text, p_battle uuid) returns text[]
language plpgsql as $$
declare
  v_names text[];
begin
  if p_claims is null then
    set local role anon;
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  else
    set local role authenticated;
    perform set_config('request.jwt.claims', p_claims, true);
  end if;
  select coalesce(array_agg(o.name), '{}') into v_names
  from storage.objects o
  where o.bucket_id = 'ephemeral-builds' and o.name like p_battle::text || '/%';
  reset role;
  return coalesce((
    select array_agg(bp.display_name || substr(n, 74) order by (bp.display_name || substr(n, 74)) collate "C")
    from unnest(v_names) n
    join public.battle_players bp on bp.battle_id = p_battle and bp.user_id::text = split_part(n, '/', 2)), '{}');
end $$;

-- ═══ Room and battle ══════════════════════════════════════════════════════
set local role authenticated;
select set_config('request.jwt.claims', :'pia', true);
select public.create_room('pia') as created \gset
reset role;
select (:'created'::jsonb) ->> 'room_id' as room, (:'created'::jsonb) ->> 'code' as code \gset
set local role authenticated;
select set_config('request.jwt.claims', :'pia', true);
select public.set_ready(:'room', true);
select set_config('request.jwt.claims', :'quin', true);
select public.join_room(:'code', 'quin');
select public.set_ready(:'room', true);
select set_config('request.jwt.claims', :'rae', true);
select public.join_room(:'code', 'rae');
select public.set_ready(:'room', true);
select set_config('request.jwt.claims', :'sam', true);
select public.join_room(:'code', 'sam');
select public.set_ready(:'room', true);
select set_config('request.jwt.claims', :'vic', true);
select public.join_room(:'code', 'vic');
select set_config('request.jwt.claims', :'pia', true);
select public.start_battle(:'room') as b \gset
select set_config('request.jwt.claims', :'tia', true);
select public.join_room(:'code', 'tia');
reset role;
update public.battles set phase_ends_at = now() - interval '1 second' where id = :'b';
set local role authenticated;
select set_config('request.jwt.claims', :'pia', true);
select public.advance_battle(:'b', 1);
reset role;

-- ─── Writes: manifest.json is a new allowed file ──────────────────
set local role authenticated;
select set_config('request.jwt.claims', :'pia', true);
select lives_ok(
  format($$ insert into storage.objects (bucket_id, name) values ('ephemeral-builds', %L), ('ephemeral-builds', %L) $$,
         :'b' || '/' || :'pia_id' || '/manifest.json', :'b' || '/' || :'pia_id' || '/autosave/manifest.json'),
  'the owner writes manifest.json and autosave/manifest.json while building');
select throws_ok(
  format($$ insert into storage.objects (bucket_id, name) values ('ephemeral-builds', %L) $$,
         :'b' || '/' || :'pia_id' || '/autosave/thumb.webp'),
  '42501', null, 'other names are still refused');
reset role;

insert into storage.objects (bucket_id, name)
select 'ephemeral-builds', :'b' || '/' || f from unnest(array[
  :'pia_id' || '/source.json', :'pia_id' || '/bundle.js', :'pia_id' || '/bundle.css', :'pia_id' || '/thumb.webp',
  :'pia_id' || '/autosave/source.json', :'pia_id' || '/autosave/bundle.js',
  :'quin_id' || '/bundle.js',
  :'quin_id' || '/autosave/source.json', :'quin_id' || '/autosave/bundle.js', :'quin_id' || '/autosave/bundle.css',
  :'quin_id' || '/autosave/manifest.json',
  :'rae_id' || '/autosave/source.json',
  :'sam_id' || '/source.json', :'sam_id' || '/bundle.js']) f;

set local role authenticated;
select set_config('request.jwt.claims', :'pia', true);
select public.ship_build(:'b', 'Pia Pad', '{}');
select public.kick_member(:'room', :'sam_id');
reset role;

-- ─── BUILDING: owners only ────────────────────────────────────────
select is(pg_temp.readable(:'quin', :'b'),
  array['quin/autosave/bundle.css', 'quin/autosave/bundle.js', 'quin/autosave/manifest.json',
        'quin/autosave/source.json', 'quin/bundle.js'],
  'BUILDING: a player reads only her own files (not the shipped build of another)');
select is(pg_temp.readable(:'tia', :'b'), '{}'::text[], 'BUILDING: a spectator reads nothing');
set local role authenticated;
select set_config('request.jwt.claims', :'tia', true);
select throws_ok(format($$ select public.get_reveal_builds(%L) $$, :'b'), 'P0001', 'wrong_phase',
  'get_reveal_builds before REVEAL');
reset role;

-- ─── SHIPPING: still owners only ──────────────────────────────────
update public.battles set building_ends_at = now() - interval '20 seconds', phase_ends_at = now() - interval '20 seconds'
 where id = :'b';
set local role authenticated;
select set_config('request.jwt.claims', :'pia', true);
select is(public.advance_battle(:'b', (select version from public.battles where id = :'b')) ->> 'phase', 'shipping',
  'SHIPPING');
reset role;
select is(pg_temp.readable(:'rae', :'b'), array['rae/autosave/source.json'],
  'SHIPPING: a player reads only her own files');

-- ─── REVEAL ──────────────────────────────────────────────────────
update public.battles set phase_ends_at = now() - interval '1 second' where id = :'b';
set local role authenticated;
select set_config('request.jwt.claims', :'pia', true);
select is(public.advance_battle(:'b', (select version from public.battles where id = :'b')) ->> 'phase', 'reveal',
  'REVEAL (pia shipped, quin auto-shipped, rae DNF, sam disqualified)');
reset role;

\set pia_final '''pia/bundle.css'', ''pia/bundle.js'', ''pia/manifest.json'', ''pia/thumb.webp'''
\set quin_final '''quin/autosave/bundle.css'', ''quin/autosave/bundle.js'', ''quin/autosave/manifest.json'''
select is(pg_temp.readable(:'tia', :'b'), array[:pia_final, :quin_final],
  'REVEAL, spectator: the shipped build''s bundle, CSS, manifest and thumb; the auto-shipped build''s autosave bundle, CSS and manifest');
select is(pg_temp.readable(:'vic', :'b'), array[:pia_final, :quin_final],
  'REVEAL, a room player who is not on the roster: the same');
select is(pg_temp.readable(:'rae', :'b'), array[:pia_final, :quin_final, 'rae/autosave/source.json'],
  'REVEAL, a DNF player: the final builds of the others, and her own files');
select is(pg_temp.readable(:'quin', :'b'),
  array[:pia_final, 'quin/autosave/bundle.css', 'quin/autosave/bundle.js', 'quin/autosave/manifest.json',
        'quin/autosave/source.json', 'quin/bundle.js'],
  'REVEAL, quin: pia''s final build, never pia''s source.json or autosave');
select is(pg_temp.readable(:'pia', :'b'),
  array['pia/autosave/bundle.js', 'pia/autosave/manifest.json', 'pia/autosave/source.json',
        'pia/bundle.css', 'pia/bundle.js', 'pia/manifest.json', 'pia/source.json', 'pia/thumb.webp', :quin_final],
  'REVEAL, pia: quin''s autosave bundle, CSS and manifest; never quin''s autosave source.json or her unshipped top-level bundle');
select ok(not ('rae/autosave/source.json' = any (pg_temp.readable(:'tia', :'b'))),
  'a DNF player''s autosave stays private');
select is(pg_temp.readable(:'sam', :'b'), array['sam/bundle.js', 'sam/source.json'],
  'REVEAL, the kicked player: only his own (disqualified) files');
select is(pg_temp.readable(:'uma', :'b'), '{}'::text[], 'REVEAL, a stranger: nothing');
select is(pg_temp.readable(null, :'b'), '{}'::text[], 'REVEAL, anon: nothing');
select ok(not exists (select 1 from unnest(pg_temp.readable(:'tia', :'b')) n where n like 'sam/%'),
  'the disqualified build is not readable');

set local role authenticated;
select set_config('request.jwt.claims', :'tia', true);
select public.get_reveal_builds(:'b') as rb \gset
reset role;
select is(
  (select jsonb_agg(x.e -> 'build_id' order by (x.e ->> 'position')::int) from jsonb_array_elements(:'rb'::jsonb) x(e)),
  (select to_jsonb(reveal_order) from public.battles where id = :'b'),
  'get_reveal_builds: the builds in reveal order, position 0-based');
select is(
  (select jsonb_object_agg(e ->> 'builder_name', (e - 'build_id' - 'position' - 'builder_id'))
   from jsonb_array_elements(:'rb'::jsonb) e),
  jsonb_build_object(
    'pia', jsonb_build_object('name', 'Pia Pad', 'builder_name', 'pia', 'status', 'shipped', 'files', jsonb_build_object(
      'js', :'b' || '/' || :'pia_id' || '/bundle.js', 'css', :'b' || '/' || :'pia_id' || '/bundle.css',
      'manifest', :'b' || '/' || :'pia_id' || '/manifest.json', 'thumb', :'b' || '/' || :'pia_id' || '/thumb.webp')),
    'quin', jsonb_build_object('name', null, 'builder_name', 'quin', 'status', 'auto_shipped', 'files', jsonb_build_object(
      'js', :'b' || '/' || :'quin_id' || '/autosave/bundle.js', 'css', :'b' || '/' || :'quin_id' || '/autosave/bundle.css',
      'manifest', :'b' || '/' || :'quin_id' || '/autosave/manifest.json', 'thumb', null))),
  'get_reveal_builds: names, builders and the paths to fetch (autosave/ for the auto-shipped build)');
set local role authenticated;
select set_config('request.jwt.claims', :'uma', true);
select throws_ok(format($$ select public.get_reveal_builds(%L) $$, :'b'), 'P0002', 'battle_not_found',
  'get_reveal_builds: a stranger');
select set_config('request.jwt.claims', :'sam', true);
select throws_ok(format($$ select public.get_reveal_builds(%L) $$, :'b'), 'P0002', 'battle_not_found',
  'get_reveal_builds: a kicked player');
reset role;
select ok(public.can_read_revealed_object(:'b' || '/' || :'pia_id' || '/bundle.js') is false,
  'can_read_revealed_object is false without a user');

-- ─── VOTING and RESULTS: still readable ───────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', :'pia', true);
select public.skip_to_vote(:'b', (select version from public.battles where id = :'b'));
reset role;
select is(pg_temp.readable(:'tia', :'b'), array[:pia_final, :quin_final], 'VOTING: the same files');
update public.battles set phase_ends_at = now() - interval '1 second' where id = :'b';
set local role authenticated;
select set_config('request.jwt.claims', :'pia', true);
select is(public.advance_battle(:'b', (select version from public.battles where id = :'b')) ->> 'phase', 'results',
  'RESULTS');
reset role;
select is(pg_temp.readable(:'rae', :'b'), array[:pia_final, :quin_final, 'rae/autosave/source.json'],
  'RESULTS (last look): the same files');

-- ─── DESTROYED: owners only again ─────────────────────────────────
update public.battles set phase_ends_at = now() - interval '1 second',
                          shipping_ended_at = now() - interval '11 minutes' where id = :'b';
set local role authenticated;
select set_config('request.jwt.claims', :'pia', true);
select is(public.advance_battle(:'b', (select version from public.battles where id = :'b')) ->> 'phase', 'destroyed',
  'DESTROYED');
reset role;
select is(pg_temp.readable(:'tia', :'b'), '{}'::text[], 'DESTROYED: the spectator reads nothing');
set local role authenticated;
select set_config('request.jwt.claims', :'tia', true);
select throws_ok(format($$ select public.get_reveal_builds(%L) $$, :'b'), 'P0001', 'wrong_phase',
  'get_reveal_builds after DESTROY');
reset role;

-- ═══ Abandoned during REVEAL ══════════════════════════════════════════════
set local role authenticated;
select set_config('request.jwt.claims', :'pia', true);
select public.set_ready(:'room', true);
select set_config('request.jwt.claims', :'quin', true);
select public.set_ready(:'room', true);
select set_config('request.jwt.claims', :'pia', true);
select public.start_battle(:'room') as b2 \gset
reset role;
update public.battles set phase_ends_at = now() - interval '1 second' where id = :'b2';
set local role authenticated;
select set_config('request.jwt.claims', :'pia', true);
select public.advance_battle(:'b2', 1);
reset role;
insert into storage.objects (bucket_id, name)
select 'ephemeral-builds', :'b2' || '/' || u || '/' || f
from unnest(array[:'pia_id', :'quin_id']) u, unnest(array['source.json', 'bundle.js']) f;
set local role authenticated;
select set_config('request.jwt.claims', :'pia', true);
select public.ship_build(:'b2', 'P2', '{}');
select set_config('request.jwt.claims', :'quin', true);
select is(public.ship_build(:'b2', 'Q2', '{}') -> 'battle' ->> 'phase', 'reveal', 'battle 2 is in REVEAL');
reset role;
select is(pg_temp.readable(:'quin', :'b2'), array['pia/bundle.js', 'quin/bundle.js', 'quin/source.json'],
  'battle 2: quin reads pia''s bundle during REVEAL');
-- Nobody on the roster has been seen for 6 minutes.
update public.room_members set last_seen_at = now() - interval '6 minutes' where room_id = :'room';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select cmp_ok(public.sweep_deadlines(), '>=', 1, 'the sweep runs');
reset role;
select results_eq(
  format($$ select phase::text, is_complete, finished_at from public.battles where id = %L $$, :'b2'),
  $$ values ('abandoned', false, null::timestamptz) $$,
  'no roster player seen for 5 minutes during REVEAL: ABANDONED, no results');
select is((select payload ->> 'reason' from public.battle_events where battle_id = :'b2' and type = 'phase'
           order by id desc limit 1), 'no_presence', 'logged as no_presence');
select is((select count(*)::int from public.builds where battle_id = :'b2' and final_rank is not null), 0,
  'abandoned: no ranks');
select is(pg_temp.readable(:'quin', :'b2'), array['quin/bundle.js', 'quin/source.json'],
  'abandoned: only owners read their files');
select is((select status::text from public.rooms where id = :'room'), 'open', 'the room reopens');

-- ═══ A room without reveal and vote: nobody reads anyone else ═════════════
update public.room_members set last_seen_at = now() where room_id = :'room';
set local role authenticated;
select set_config('request.jwt.claims', :'pia', true);
select public.update_room_settings(:'room', '{"reveal_vote": false}');
select public.set_ready(:'room', true);
select set_config('request.jwt.claims', :'quin', true);
select public.set_ready(:'room', true);
select set_config('request.jwt.claims', :'pia', true);
select public.start_battle(:'room') as b3 \gset
reset role;
update public.battles set phase_ends_at = now() - interval '1 second' where id = :'b3';
set local role authenticated;
select set_config('request.jwt.claims', :'pia', true);
select public.advance_battle(:'b3', 1);
reset role;
insert into storage.objects (bucket_id, name)
select 'ephemeral-builds', :'b3' || '/' || u || '/' || f
from unnest(array[:'pia_id', :'quin_id']) u, unnest(array['source.json', 'bundle.js']) f;
set local role authenticated;
select set_config('request.jwt.claims', :'pia', true);
select public.ship_build(:'b3', 'P3', '{}');
select set_config('request.jwt.claims', :'quin', true);
select is(public.ship_build(:'b3', 'Q3', '{}') -> 'battle' ->> 'phase', 'results',
  'reveal_vote = false: the last ship goes straight to RESULTS (M3 flow)');
reset role;
select is(pg_temp.readable(:'quin', :'b3'), array['quin/bundle.js', 'quin/source.json'],
  'RESULTS without a reveal: only her own files');
select is((select ranks from (select array_agg(final_rank order by final_rank) as ranks
                              from public.builds where battle_id = :'b3') x), array[1, 1],
  'M3 ranking by completion time (equal times share rank 1)');

select * from finish();
rollback;
