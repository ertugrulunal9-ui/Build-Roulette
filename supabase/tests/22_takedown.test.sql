-- T-024: takedowns in a RUNNING battle (treated like disqualified: no reveal slot, no
-- votes, no rank), in FINISHED results (rank kept, "Removed by moderators" everywhere), and
-- the takedown job (claim ordering with the capture job, complete_capture ignored,
-- complete_takedown).
--
-- One room battle with 4 players (ana, ben, cy, dee) who all ship, so it reaches REVEAL
-- with 4 builds in a random order o1..o4 (reveal_order[1..4]); eli is a spectator.
--   REVEAL slot o1: o2 is taken down (not on screen) → nothing moves; its files are no
--     longer readable; get_reveal_builds keeps its position, flagged, without files.
--   o1's slot ends → the reveal jumps to o3 (o2 has no slot).
--   o3 (on screen, its capture running) is taken down → the reveal moves on to o4 at once.
--   VOTING: votes for o4, then o4 is taken down → those votes are deleted and o4 is
--     not votable; RESULTS rank only o1.
--   RESULTS: o1 (rank 1) is taken down → the rank stays, name and screenshot go, and
--     (T-028) its awards are no longer shown.

begin;
create extension if not exists pgtap with schema extensions;

select plan(48);

\set ana '{"sub":"22a00000-0000-0000-0000-000000000001","role":"authenticated"}'
\set ben '{"sub":"22a00000-0000-0000-0000-000000000002","role":"authenticated"}'
\set cy  '{"sub":"22a00000-0000-0000-0000-000000000003","role":"authenticated"}'
\set dee '{"sub":"22a00000-0000-0000-0000-000000000004","role":"authenticated"}'
\set eli '{"sub":"22a00000-0000-0000-0000-000000000005","role":"authenticated"}'
\set mod '{"sub":"22a00000-0000-0000-0000-000000000006","role":"authenticated","is_anonymous":false}'
\set service '{"role":"service_role"}'
\set ana_id '22a00000-0000-0000-0000-000000000001'
\set ben_id '22a00000-0000-0000-0000-000000000002'
\set cy_id  '22a00000-0000-0000-0000-000000000003'
\set dee_id '22a00000-0000-0000-0000-000000000004'
\set eli_id '22a00000-0000-0000-0000-000000000005'
\set mod_id '22a00000-0000-0000-0000-000000000006'

insert into auth.users (id, is_anonymous)
select ('22a00000-0000-0000-0000-00000000000' || n)::uuid, true from generate_series(1, 5) n;
insert into auth.users (id, is_anonymous, email) values (:'mod_id', false, 'mod22@example.test');
insert into private.admins (user_id) values (:'mod_id');

create function pg_temp.ver(p_battle uuid) returns int language sql as $$
  select version from public.battles where id = p_battle
$$;
grant execute on function pg_temp.ver(uuid) to authenticated, service_role;

-- ─── A battle in REVEAL with 4 builds ─────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', :'ana', true);
select public.create_room('ana') as created \gset
reset role;
select (:'created'::jsonb) ->> 'room_id' as room, (:'created'::jsonb) ->> 'code' as code \gset
set local role authenticated;
select set_config('request.jwt.claims', :'ana', true);
select public.set_ready(:'room', true);
select set_config('request.jwt.claims', :'ben', true);
select public.join_room(:'code', 'ben');
select public.set_ready(:'room', true);
select set_config('request.jwt.claims', :'cy', true);
select public.join_room(:'code', 'cy');
select public.set_ready(:'room', true);
select set_config('request.jwt.claims', :'dee', true);
select public.join_room(:'code', 'dee');
select public.set_ready(:'room', true);
select set_config('request.jwt.claims', :'ana', true);
select public.start_battle(:'room') as b \gset
select set_config('request.jwt.claims', :'eli', true);
select public.join_room(:'code', 'eli');
reset role;
update public.battles set phase_ends_at = now() - interval '1 second' where id = :'b';
set local role authenticated;
select set_config('request.jwt.claims', :'ana', true);
select public.advance_battle(:'b', pg_temp.ver(:'b'));
reset role;
insert into storage.objects (bucket_id, name)
select 'ephemeral-builds', :'b' || '/' || u || '/' || f
from unnest(array[:'ana_id', :'ben_id', :'cy_id', :'dee_id']) u,
     unnest(array['source.json', 'bundle.js']) f;
set local role authenticated;
select set_config('request.jwt.claims', :'ana', true);
select public.ship_build(:'b', 'Ana App', '{}');
select set_config('request.jwt.claims', :'ben', true);
select public.ship_build(:'b', 'Ben App', '{}');
select set_config('request.jwt.claims', :'cy', true);
select public.ship_build(:'b', 'Cy App', '{}');
select set_config('request.jwt.claims', :'dee', true);
select is(public.ship_build(:'b', 'Dee App', '{}') -> 'battle' ->> 'phase', 'reveal',
  'everyone shipped: REVEAL with 4 builds');
reset role;
select reveal_order[1] as o1, reveal_order[2] as o2, reveal_order[3] as o3, reveal_order[4] as o4
from public.battles where id = :'b' \gset
select builder_id as o2_builder from public.builds where id = :'o2' \gset
select builder_id as o1_builder from public.builds where id = :'o1' \gset

-- ═══ Takedown during REVEAL, not on screen (o2) ═══════════════════════════
set local role authenticated;
select set_config('request.jwt.claims', :'mod', true);
select is(public.admin_take_down_build(:'o2', 'offensive') -> 'disqualified', 'true'::jsonb,
  'a build of a running battle is disqualified by its takedown');
reset role;
select is((select jsonb_build_object('status', status, 'name', name, 'capture', capture_status)
           from public.builds where id = :'o2'),
  '{"status": "disqualified", "name": null, "capture": "failed"}'::jsonb,
  'o2: disqualified, no name, its pending capture will not happen');
select is((select jsonb_build_object('status', status, 'error', last_error) from public.jobs
           where kind = 'capture' and ref_id = :'o2'),
  '{"status": "done", "error": "taken down"}'::jsonb, 'its queued capture job is cancelled');
select is((select jsonb_build_object('phase', phase, 'index', reveal_index) from public.battles where id = :'b'),
  '{"phase": "reveal", "index": 0}'::jsonb, 'o2 was not on screen: the reveal does not move');
select is((select type from public.battle_events where battle_id = :'b' order by id desc limit 1), 'takedown',
  'a takedown event (members refetch)');

set local role authenticated;
select set_config('request.jwt.claims', :'eli', true);
select public.get_reveal_builds(:'b') as rb \gset
select public.get_battle_snapshot(:'b') as snap \gset
select ok(not public.can_read_revealed_object(:'b' || '/' || :'o2_builder' || '/bundle.js'),
  'storage: its bundle is no longer readable by members');
select ok(public.can_read_revealed_object(:'b' || '/' || :'o1_builder' || '/bundle.js'),
  'the other builds still are');
reset role;
select is((select jsonb_build_object('pos', e -> 'position', 'down', e -> 'taken_down', 'name', e -> 'name',
                                     'files', e -> 'files')
           from jsonb_array_elements(:'rb'::jsonb) e where e ->> 'build_id' = :'o2'),
  '{"pos": 1, "down": true, "name": null, "files": {"js": null, "css": null, "manifest": null, "thumb": null}}'::jsonb,
  'get_reveal_builds: o2 keeps its position, flagged, without files');
select is(jsonb_array_length(:'rb'::jsonb), 4, 'get_reveal_builds still lists 4 positions');
select is((select jsonb_build_object('down', e -> 'taken_down', 'status', e -> 'status', 'name', e -> 'name')
           from jsonb_array_elements((:'snap'::jsonb) -> 'builds') e where e ->> 'id' = :'o2'),
  '{"down": true, "status": "disqualified", "name": null}'::jsonb, 'the snapshot flags it');

-- ═══ The reveal skips it ══════════════════════════════════════════════════
update public.battles set phase_ends_at = now() - interval '1 second' where id = :'b';
set local role authenticated;
select set_config('request.jwt.claims', :'ana', true);
select is(public.advance_battle(:'b', pg_temp.ver(:'b')) ->> 'changed', 'true', 'o1''s slot is over...');
reset role;
select is((select reveal_index from public.battles where id = :'b'), 2,
  '...the reveal jumps to o3 (o2 has no slot)');
select is((select payload ->> 'reveal_index' from public.battle_events where battle_id = :'b' and type = 'phase'
           order by id desc limit 1), '2', 'the phase event says index 2');

-- ═══ Takedown of the build on screen (o3), with its capture in flight ═════
-- The capture worker claims captures in order; take o3's job and o4's (both running).
update public.jobs set run_after = now() - interval '1 second' where kind = 'capture';
set local role service_role;
select set_config('request.jwt.claims', :'service', true);
select (public.claim_job('capture')).ref_id as cap1 \gset
select (public.claim_job('capture')).ref_id as cap2 \gset
select (public.claim_job('capture')).ref_id as cap3 \gset
reset role;
select set_eq(format($$ values (%L::uuid), (%L::uuid), (%L::uuid) $$, :'cap1', :'cap2', :'cap3'),
  format($$ values (%L::uuid), (%L::uuid), (%L::uuid) $$, :'o1', :'o3', :'o4'),
  'claim_job(capture) never hands out the capture of the taken-down o2');
set local role authenticated;
select set_config('request.jwt.claims', :'mod', true);
select public.admin_take_down_build(:'o3');
reset role;
select is((select jsonb_build_object('phase', phase, 'index', reveal_index) from public.battles where id = :'b'),
  '{"phase": "reveal", "index": 3}'::jsonb, 'o3 was on screen: the reveal moves on to o4 at once');
select is((select payload from public.battle_events where battle_id = :'b' and type = 'phase'
           order by id desc limit 1),
  '{"from": "reveal", "to": "reveal", "reveal_index": 3, "reason": "takedown"}'::jsonb,
  'with reason takedown');
select is((select status::text from public.jobs where kind = 'capture' and ref_id = :'o3'), 'running',
  'a running capture is left to finish');

-- The takedown jobs: o2's is free, o3's waits for its capture.
set local role service_role;
select set_config('request.jwt.claims', :'service', true);
select is((public.claim_job('takedown')).ref_id, :'o2'::uuid, 'claim_job(takedown): o2 first');
select is((public.claim_job('takedown')).id, null, 'o3''s takedown waits while its capture runs');
select public.complete_capture(:'o3', 'captured', :'b' || '/' || :'o3' || '.webp');
reset role;
select is((select jsonb_build_object('path', screenshot_path, 'job', (select status from public.jobs
                                     where kind = 'capture' and ref_id = :'o3'))
           from public.builds where id = :'o3'),
  '{"path": null, "job": "done"}'::jsonb, 'complete_capture after the takedown records nothing, closes the job');
set local role service_role;
select set_config('request.jwt.claims', :'service', true);
select is((public.claim_job('takedown')).ref_id, :'o3'::uuid, 'then o3''s takedown can run');
select public.complete_takedown(:'o3');
select public.complete_takedown(:'o3');
select throws_ok(format($$ select public.complete_takedown(%L) $$, :'o1'), 'P0001', 'not_taken_down',
  'complete_takedown refuses a build that was not taken down');
reset role;
select is((select jsonb_build_object('deleted', storage_deleted_at is not null,
                                     'job', (select status from public.jobs where kind = 'takedown' and ref_id = :'o3'))
           from private.build_takedowns where build_id = :'o3'),
  '{"deleted": true, "job": "done"}'::jsonb, 'complete_takedown: storage_deleted_at stamped, job done (idempotent)');
-- A capture job of a taken-down build that somehow is queued again is never claimed.
update public.jobs set status = 'queued', run_after = now() - interval '1 second', attempts = 1
 where kind = 'capture' and ref_id = :'o2';
set local role service_role;
select set_config('request.jwt.claims', :'service', true);
select is((public.claim_job('capture')).id, null, 'claim_job(capture) skips taken-down builds');
reset role;

-- ═══ VOTING: o4 is voted for, then taken down ═════════════════════════════
update public.battles set phase_ends_at = now() - interval '1 second' where id = :'b';
set local role authenticated;
select set_config('request.jwt.claims', :'ana', true);
select is(public.advance_battle(:'b', pg_temp.ver(:'b')) ->> 'phase', 'voting', 'o4''s slot ends: VOTING');
reset role;
select builder_id as o4_builder from public.builds where id = :'o4' \gset
-- Two voters who did not build o4 vote for it in every category.
select array_agg(u order by u) as voters
from unnest(array[:'ana_id', :'ben_id', :'cy_id', :'dee_id']::uuid[]) u
where u <> :'o4_builder'::uuid \gset
select (:'voters'::uuid[])[1] as v1, (:'voters'::uuid[])[2] as v2 \gset
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'v1', 'role', 'authenticated')::text, true);
select public.cast_vote(:'b', c.slug, :'o4') from public.vote_categories c where c.is_active;
select set_config('request.jwt.claims', json_build_object('sub', :'v2', 'role', 'authenticated')::text, true);
select public.cast_vote(:'b', 'overall', :'o4');
select public.get_battle_snapshot(:'b') -> 'vote_progress' as vp_before \gset
reset role;
select is(:'vp_before'::jsonb ->> 'voted_count', '1', 'one voter completed a ballot with o4 in it');
set local role authenticated;
select set_config('request.jwt.claims', :'mod', true);
select public.admin_take_down_build(:'o4');
reset role;
select is((select count(*)::int from public.votes where build_id = :'o4'), 0,
  'the votes cast for o4 are deleted (those voters vote again in that category)');
select is((select payload from public.battle_events where battle_id = :'b' and type = 'vote'
           order by id desc limit 1),
  '{"voted_count": 0, "eligible_count": 4}'::jsonb, 'the vote progress drops and is broadcast');
select is((select phase::text from public.battles where id = :'b'), 'voting', 'VOTING goes on');
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'v1', 'role', 'authenticated')::text, true);
select throws_ok(format($$ select public.cast_vote(%L, 'overall', %L) $$, :'b', :'o4'), 'P0001', 'not_votable',
  'o4 cannot receive votes any more');
reset role;
-- Someone who did not build o1 votes for it; the deadline ends VOTING.
select u as o1_fan from unnest(array[:'ana_id', :'ben_id', :'cy_id', :'dee_id']::uuid[]) u
where u <> :'o1_builder'::uuid limit 1 \gset
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'o1_fan', 'role', 'authenticated')::text, true);
select public.cast_vote(:'b', 'overall', :'o1');
reset role;
update public.battles set phase_ends_at = now() - interval '1 second' where id = :'b';
set local role authenticated;
select set_config('request.jwt.claims', :'ana', true);
select is(public.advance_battle(:'b', pg_temp.ver(:'b')) ->> 'phase', 'results', 'the deadline: RESULTS');
reset role;
select is((select jsonb_build_object('status', status, 'rank', final_rank, 'votes', vote_counts ->> 'overall')
           from public.builds where id = :'o1'),
  '{"status": "shipped", "rank": 1, "votes": "1"}'::jsonb, 'RESULTS: o1 is ranked 1 with its tally');
select is((select jsonb_agg(distinct jsonb_build_object('status', status, 'rank', final_rank, 'votes', vote_counts))
           from public.builds where id in (:'o2', :'o3', :'o4')),
  '[{"status": "disqualified", "rank": null, "votes": null}]'::jsonb,
  'the three taken-down builds have no rank and no tallies');
select is((select count(*)::int from public.awards where battle_id = :'b' and build_id <> :'o1'), 0,
  'no award goes to a taken-down build');

-- ═══ Finished results: o1 (rank 1) is taken down ══════════════════════════
update public.builds set capture_status = 'captured', screenshot_path = :'b' || '/' || :'o1' || '.webp'
 where id = :'o1';
set local role anon;
select public.get_public_battle(:'b') as pub_before \gset
reset role;
select is(jsonb_array_length((:'pub_before'::jsonb) -> 'builds'), 1,
  'public results: the builds taken down while running are left out (disqualified)');
set local role authenticated;
select set_config('request.jwt.claims', :'mod', true);
select is(public.admin_take_down_build(:'o1') -> 'disqualified', 'false'::jsonb,
  'a takedown in RESULTS does not disqualify');
reset role;
set local role anon;
select public.get_public_battle(:'b') as pub \gset
select public.get_player_history(:'o1_builder') as hist \gset
reset role;
select is(((:'pub'::jsonb) -> 'builds' -> 0) - 'id' - 'shipped_at' - 'completion_ms' - 'stats' - 'builder_name',
  '{"name": null, "votes": {"rule": 0, "chaos": 0, "style": 0, "overall": 1}, "status": "shipped",
    "final_rank": 1, "taken_down": true, "total_votes": 1, "capture_status": "captured", "screenshot_path": null}'::jsonb,
  'get_public_battle: rank, status, votes kept; no name, no screenshot; taken_down');
-- T-028 (user decision 2026-10-08): the awards go from every public read; the rows stay
-- (23_takedown_awards.test.sql covers the rule in depth).
select is((select count(*)::int from jsonb_array_elements((:'pub'::jsonb) -> 'awards') a
           where a ->> 'build_id' = :'o1'), 0, 'T-028: its awards are no longer shown...');
select ok((select count(*)::int from public.awards where build_id = :'o1') > 0,
  '...but its award rows stay (permanent data)');
select is((select jsonb_build_object('name', x -> 'build' -> 'name', 'shot', x -> 'build' -> 'screenshot_path',
                                     'down', x -> 'build' -> 'taken_down', 'rank', x -> 'build' -> 'final_rank')
           from jsonb_array_elements((:'hist'::jsonb) -> 'battles') x where x ->> 'battle_id' = :'b'),
  '{"name": null, "shot": null, "down": true, "rank": 1}'::jsonb,
  'get_player_history: the same (the battle stays in the history)');
set local role authenticated;
select set_config('request.jwt.claims', :'eli', true);
select is((select jsonb_build_object('name', e -> 'name', 'shot', e -> 'screenshot_path', 'down', e -> 'taken_down')
           from jsonb_array_elements(public.get_battle_snapshot(:'b') -> 'builds') e where e ->> 'id' = :'o1'),
  '{"name": null, "shot": null, "down": true}'::jsonb, 'get_battle_snapshot: the same');
select is((select jsonb_build_object('name', name, 'shot', screenshot_path) from public.builds where id = :'o1'),
  '{"name": null, "shot": null}'::jsonb, 'and the builds table itself (RLS read) has neither');
select ok(not public.can_read_revealed_object(:'b' || '/' || :'o1_builder' || '/bundle.js'),
  'the last look in RESULTS cannot load it either');
reset role;
select is((select status::text from public.jobs where kind = 'takedown' and ref_id = :'o1'), 'queued',
  'its screenshot is queued for deletion');

-- RESULTS → DESTROYED is not held up by a taken-down build's capture.
select is((select count(*)::int from public.builds
           where battle_id = :'b' and status in ('shipped', 'auto_shipped') and capture_status = 'pending'), 0,
  'no pending capture is left to wait for');
select is((select count(*)::int from public.battle_events where battle_id = :'b' and type = 'takedown'), 4,
  'one takedown event per takedown');
select is((select count(*)::int from private.admin_actions where admin_id = :'mod_id' and action = 'take_down_build'),
  4, 'every takedown is in the admin log');

select * from finish();
rollback;
