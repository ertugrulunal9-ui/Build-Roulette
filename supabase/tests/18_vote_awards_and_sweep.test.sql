-- T-022: one winner per vote category, and the early end of VOTING in
-- sweep_deadlines.
--
-- Part 1 (fixtures, private.finalize_votes called directly):
--   Battle X: every tie-break level that 15_reveal_vote.test.sql cannot reach
--     through the RPCs: a top-count tie decided by total votes although the
--     loser shipped earlier (total votes come before the ship time), and a tie
--     on count, total votes and shipped_at (two auto-shipped builds) decided by
--     the lower build id, for the award and for the rank. A category nobody
--     voted in gives no award.
--   Battle Z: two auto-shipped builds and no votes at all: distinct ranks (lower
--     build id first), no vote award.
--   Battle L: a battle that finished before T-022 with a shared award keeps it,
--     and the public page still lists both rows (same shape).
-- Part 2 (RPCs): a room battle in VOTING and sweep_deadlines.
--   * nobody voted, everyone present: no early end;
--   * nobody present at all: no early end (the deadline decides);
--   * ana and ben completed their ballots, but they went silent and cy, the only
--     present voter, has not voted: no early end;
--   * ana and ben present again and cy goes silent: the sweep ends VOTING with
--     reason all_voted; a second sweep changes nothing.
--   (The early end after a vote, a leave and a kick is in 15_reveal_vote.)

begin;
create extension if not exists pgtap with schema extensions;

select plan(23);

-- ═══ Part 1: fixtures ═════════════════════════════════════════════════════
\set u1 '18a00000-0000-0000-0000-000000000001'
\set u2 '18a00000-0000-0000-0000-000000000002'
\set u3 '18a00000-0000-0000-0000-000000000003'
\set u4 '18a00000-0000-0000-0000-000000000004'
\set x  '18b00000-0000-0000-0000-00000000000a'
\set z  '18b00000-0000-0000-0000-00000000000b'
\set l  '18b00000-0000-0000-0000-00000000000c'
-- Build ids: Q's id is lower than P's on purpose (the id level must pick Q, the
-- one inserted second).
\set q  '18d00000-0000-0000-0000-000000000001'
\set p  '18d00000-0000-0000-0000-000000000002'
\set r  '18d00000-0000-0000-0000-000000000003'
\set s  '18d00000-0000-0000-0000-000000000004'
\set z1 '18d00000-0000-0000-0000-000000000011'
\set z2 '18d00000-0000-0000-0000-000000000012'
\set l1 '18d00000-0000-0000-0000-000000000021'
\set l2 '18d00000-0000-0000-0000-000000000022'
\set t0 '2026-10-07 12:00:00+00'

insert into auth.users (id, is_anonymous) values (:'u1', true), (:'u2', true), (:'u3', true), (:'u4', true);
insert into public.profiles (id, display_name) values
  (:'u1', 'Pat'), (:'u2', 'Quinn'), (:'u3', 'Rae'), (:'u4', 'Sol');

insert into public.challenges (id, build_text, rule_text, style_text, time_limit_seconds)
select ('18c00000-0000-0000-0000-00000000000' || n)::uuid, 'Build ' || n, 'Rule ' || n, 'Style ' || n, 300
from generate_series(1, 3) n;

insert into public.battles (id, challenge_id, host_id, settings, phase, building_started_at, building_ends_at)
values
  (:'x', '18c00000-0000-0000-0000-000000000001', :'u1', '{"mode":"multiplayer","reveal_vote":true}', 'voting',
   :'t0'::timestamptz - interval '300 seconds', :'t0'),
  (:'z', '18c00000-0000-0000-0000-000000000002', :'u1', '{"mode":"multiplayer","reveal_vote":true}', 'voting',
   :'t0'::timestamptz - interval '300 seconds', :'t0'),
  (:'l', '18c00000-0000-0000-0000-000000000003', :'u1', '{"mode":"multiplayer","reveal_vote":true}', 'results',
   :'t0'::timestamptz - interval '300 seconds', :'t0');
update public.battles set finished_at = :'t0'::timestamptz + interval '2 minutes', is_complete = true where id = :'l';

insert into public.battle_players (battle_id, user_id, display_name)
select b, u, p.display_name
from unnest(array[:'x', :'z', :'l']::uuid[]) b
cross join unnest(array[:'u1', :'u2', :'u3', :'u4']::uuid[]) u
join public.profiles p on p.id = u
where b = :'x' or u in (:'u1', :'u2');

-- Battle X. P and Q auto-shipped at the deadline (same shipped_at); R shipped by
-- hand earlier; S is DNF.
insert into public.builds (id, battle_id, builder_id, name, status, shipped_at, completion_ms) values
  (:'p', :'x', :'u1', 'P', 'auto_shipped', :'t0', 300000),
  (:'q', :'x', :'u2', 'Q', 'auto_shipped', :'t0', 300000),
  (:'r', :'x', :'u3', 'R', 'shipped', :'t0'::timestamptz - interval '60 seconds', 240000),
  (:'s', :'x', :'u4', 'S', 'dnf', null, null);
update public.battles set reveal_order = array[:'p', :'q', :'r']::uuid[] where id = :'x';
-- Ballots (nobody votes chaos):
--   overall: Pat → Q, Quinn → P, Rae → P, Sol → Q     P 2, Q 2
--   rule:    Pat → R, Quinn → P                       P 1, R 1
--   style:   Rae → Q, Sol → R                         Q 1, R 1
-- Totals: P 3, Q 3, R 2.
insert into public.votes (battle_id, voter_id, category, build_id) values
  (:'x', :'u1', 'overall', :'q'), (:'x', :'u2', 'overall', :'p'),
  (:'x', :'u3', 'overall', :'p'), (:'x', :'u4', 'overall', :'q'),
  (:'x', :'u1', 'rule', :'r'),    (:'x', :'u2', 'rule', :'p'),
  (:'x', :'u3', 'style', :'q'),   (:'x', :'u4', 'style', :'r');

-- Battle Z: two auto-shipped builds, nobody voted.
insert into public.builds (id, battle_id, builder_id, name, status, shipped_at, completion_ms) values
  (:'z2', :'z', :'u1', 'Z2', 'auto_shipped', :'t0', 300000),
  (:'z1', :'z', :'u2', 'Z1', 'auto_shipped', :'t0', 300000);
update public.battles set reveal_order = array[:'z2', :'z1']::uuid[] where id = :'z';

-- Battle L: finished under the old rule (a shared Best Build award).
insert into public.builds (id, battle_id, builder_id, name, status, shipped_at, completion_ms,
                           final_rank, total_votes, vote_counts) values
  (:'l1', :'l', :'u1', 'L1', 'shipped', :'t0'::timestamptz - interval '9 seconds', 291000, 1, 1,
   '{"overall": 1, "rule": 0, "style": 0, "chaos": 0}'),
  (:'l2', :'l', :'u2', 'L2', 'shipped', :'t0'::timestamptz - interval '9 seconds', 291000, 1, 1,
   '{"overall": 1, "rule": 0, "style": 0, "chaos": 0}');
insert into public.awards (battle_id, build_id, award, source, votes) values
  (:'l', :'l1', 'overall', 'vote', 1), (:'l', :'l2', 'overall', 'vote', 1);

select private.finalize_votes(:'x');
select private.finalize_votes(:'z');
update public.battles set phase = 'results', finished_at = :'t0'::timestamptz + interval '1 minute',
                          is_complete = true
 where id in (:'x', :'z');

-- ─── Battle X ─────────────────────────────────────────────────────────
select results_eq(
  format($$ select name, final_rank, total_votes, vote_counts from public.builds
            where battle_id = %L order by name $$, :'x'),
  $$ values ('P', 2, 3, '{"overall": 2, "rule": 1, "style": 0, "chaos": 0}'::jsonb),
            ('Q', 1, 3, '{"overall": 2, "rule": 0, "style": 1, "chaos": 0}'::jsonb),
            ('R', 3, 2, '{"overall": 0, "rule": 1, "style": 1, "chaos": 0}'::jsonb),
            ('S', null::int, 0, null::jsonb) $$,
  'ranks: P and Q tie on Best Build (2), total votes (3) and shipped_at: the lower build id (Q) ranks first');
select results_eq(
  format($$ select award, b.name, a.votes from public.awards a join public.builds b on b.id = a.build_id
            where a.battle_id = %L and a.source = 'vote' order by award $$, :'x'),
  $$ values ('overall', 'Q', 2), ('rule', 'P', 1), ('style', 'Q', 1) $$,
  'one winner per category: overall P–Q tie on everything → lower build id (Q); rule P–R and style Q–R → more total votes (3 vs 2)');
select is((select b.shipped_at < (select shipped_at from public.builds where id = :'p')
           from public.builds b where b.id = :'r'), true,
  'R shipped earlier than P and Q: total votes are compared before the ship time');
select is((select count(*)::int from public.awards where battle_id = :'x' and source = 'vote' and award = 'chaos'), 0,
  'nobody voted chaos: no chaos award');
select is_empty(
  format($$ select award from public.awards where battle_id = %L and source = 'vote'
            group by award having count(*) > 1 $$, :'x'),
  'at most one vote award per category');
select is((select bu.final_rank from public.awards a join public.builds bu on bu.id = a.build_id
           where a.battle_id = :'x' and a.award = 'overall'), 1,
  'the Best Build award goes to the rank-1 build (same order for both)');
select is(
  public.get_public_battle(:'x') -> 'awards',
  jsonb_build_array(
    jsonb_build_object('build_id', :'q', 'award', 'overall', 'source', 'vote', 'votes', 2),
    jsonb_build_object('build_id', :'p', 'award', 'rule', 'source', 'vote', 'votes', 1),
    jsonb_build_object('build_id', :'q', 'award', 'style', 'source', 'vote', 'votes', 1)),
  'get_public_battle: the same award shape, one row per category');

-- ─── Battle Z ─────────────────────────────────────────────────────────
select results_eq(
  format($$ select name, final_rank, total_votes from public.builds where battle_id = %L order by final_rank $$, :'z'),
  $$ values ('Z1', 1, 0), ('Z2', 2, 0) $$,
  'no votes, same shipped_at: distinct ranks, the lower build id first');
select is((select count(*)::int from public.awards where battle_id = :'z' and source = 'vote'), 0,
  'zero votes in every category: no vote award');

-- ─── Battle L ─────────────────────────────────────────────────────────
select is(
  (select count(*)::int from jsonb_array_elements(public.get_public_battle(:'l') -> 'awards') a
   where a ->> 'award' = 'overall'),
  2, 'a battle finished under the old rule keeps its shared award (permanent results)');

-- ═══ Part 2: the early end of VOTING in sweep_deadlines ═══════════════════
\set ana '{"sub":"18e00000-0000-0000-0000-000000000001","role":"authenticated"}'
\set ben '{"sub":"18e00000-0000-0000-0000-000000000002","role":"authenticated"}'
\set cy  '{"sub":"18e00000-0000-0000-0000-000000000003","role":"authenticated"}'
\set service '{"role":"service_role"}'
\set ana_id '18e00000-0000-0000-0000-000000000001'
\set ben_id '18e00000-0000-0000-0000-000000000002'
\set cy_id  '18e00000-0000-0000-0000-000000000003'

insert into auth.users (id, is_anonymous) values (:'ana_id', true), (:'ben_id', true), (:'cy_id', true);

create function pg_temp.bid(p_battle uuid, p_name text) returns uuid language sql as $$
  select bu.id from public.builds bu
  join public.battle_players bp on bp.battle_id = bu.battle_id and bp.user_id = bu.builder_id
  where bu.battle_id = p_battle and bp.display_name = p_name
$$;
create function pg_temp.ver(p_battle uuid) returns int language sql as $$
  select version from public.battles where id = p_battle
$$;
create function pg_temp.phase_events(p_battle uuid) returns int language sql as $$
  select count(*)::int from public.battle_events where battle_id = p_battle and type = 'phase'
$$;
grant execute on function pg_temp.bid(uuid, text), pg_temp.ver(uuid) to authenticated, service_role;

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
select set_config('request.jwt.claims', :'ana', true);
select public.start_battle(:'room') as v \gset
reset role;
update public.battles set phase_ends_at = now() - interval '1 second' where id = :'v';
set local role authenticated;
select set_config('request.jwt.claims', :'ana', true);
select public.advance_battle(:'v', 1);
reset role;
insert into storage.objects (bucket_id, name)
select 'ephemeral-builds', :'v' || '/' || u || '/' || f
from unnest(array[:'ana_id', :'ben_id', :'cy_id']) u, unnest(array['source.json', 'bundle.js']) f;
set local role authenticated;
select set_config('request.jwt.claims', :'ana', true);
select public.ship_build(:'v', 'A', '{}');
select set_config('request.jwt.claims', :'ben', true);
select public.ship_build(:'v', 'B', '{}');
select set_config('request.jwt.claims', :'cy', true);
select public.ship_build(:'v', 'C', '{}');
select set_config('request.jwt.claims', :'ana', true);
select is(public.skip_to_vote(:'v', pg_temp.ver(:'v')) ->> 'phase', 'voting', 'battle V is in VOTING');
reset role;

-- ─── Nobody voted, everyone present ──────────────────────────────────
set local role service_role;
select set_config('request.jwt.claims', :'service', true);
select public.sweep_deadlines();
reset role;
select is((select phase::text from public.battles where id = :'v'), 'voting',
  'nobody voted and everyone is present: the sweep does not end VOTING');

-- ─── Nobody present at all ───────────────────────────────────────────
update public.room_members set last_seen_at = now() - interval '31 seconds' where room_id = :'room';
set local role service_role;
select set_config('request.jwt.claims', :'service', true);
select public.sweep_deadlines();
reset role;
select is((select phase::text from public.battles where id = :'v'), 'voting',
  'every voter silent: no present voter, so no early end (the deadline decides)');
update public.room_members set last_seen_at = now() where room_id = :'room';

-- ─── ana and ben complete their ballots while cy is present ──────────
set local role authenticated;
select set_config('request.jwt.claims', :'ana', true);
select public.cast_vote(:'v', 'overall', pg_temp.bid(:'v', 'ben'));
select public.cast_vote(:'v', 'rule', pg_temp.bid(:'v', 'cy'));
select public.cast_vote(:'v', 'style', pg_temp.bid(:'v', 'ben'));
select public.cast_vote(:'v', 'chaos', pg_temp.bid(:'v', 'cy'));
select set_config('request.jwt.claims', :'ben', true);
select public.cast_vote(:'v', 'overall', pg_temp.bid(:'v', 'cy'));
select public.cast_vote(:'v', 'rule', pg_temp.bid(:'v', 'ana'));
select public.cast_vote(:'v', 'style', pg_temp.bid(:'v', 'ana'));
select is(public.cast_vote(:'v', 'chaos', pg_temp.bid(:'v', 'ana')) -> 'battle' ->> 'phase', 'voting',
  'ana and ben are done, cy (present) has not voted: VOTING goes on');
reset role;
set local role service_role;
select set_config('request.jwt.claims', :'service', true);
select public.sweep_deadlines();
reset role;
select is((select phase::text from public.battles where id = :'v'), 'voting',
  'the sweep agrees while cy is present');

-- ─── The voters who are done go silent; cy is the only one present ───
update public.room_members set last_seen_at = now() - interval '31 seconds'
 where room_id = :'room' and user_id in (:'ana_id', :'ben_id');
set local role service_role;
select set_config('request.jwt.claims', :'service', true);
select public.sweep_deadlines();
reset role;
select is((select phase::text from public.battles where id = :'v'), 'voting',
  'nobody present has voted (ana and ben are silent, cy has not voted): no early end');

-- ─── cy goes silent: the sweep ends VOTING ───────────────────────────
update public.room_members set last_seen_at = now() where room_id = :'room' and user_id in (:'ana_id', :'ben_id');
update public.room_members set last_seen_at = now() - interval '29 seconds'
 where room_id = :'room' and user_id = :'cy_id';
set local role service_role;
select set_config('request.jwt.claims', :'service', true);
select public.sweep_deadlines();
reset role;
select is((select phase::text from public.battles where id = :'v'), 'voting',
  'cy was seen 29 s ago: still present, still waited for');
update public.room_members set last_seen_at = now() - interval '31 seconds'
 where room_id = :'room' and user_id = :'cy_id';
select pg_temp.ver(:'v') as v_before \gset
set local role service_role;
select set_config('request.jwt.claims', :'service', true);
select cmp_ok(public.sweep_deadlines(), '>=', 1, 'the sweep counts the battle it advanced');
reset role;
select results_eq(
  format($$ select phase::text, is_complete, finished_at, phase_ends_at from public.battles where id = %L $$, :'v'),
  $$ values ('results', true, now(), now() + interval '60 seconds') $$,
  'cy went silent 31 s ago: every present voter is done, the sweep ends VOTING (RESULTS, 60 s last look)');
select results_eq(
  format($$ select actor_id, payload from public.battle_events
            where battle_id = %L and version > %s and type = 'phase' order by id $$, :'v', :v_before),
  $$ values (null::uuid, '{"from": "voting", "to": "results", "reason": "all_voted"}'::jsonb) $$,
  'one phase event by the system, reason all_voted (the same sweep also gave the host role back to ana)');
select results_eq(
  format($$ select bp.display_name, bu.final_rank, bu.total_votes from public.builds bu
            join public.battle_players bp on bp.battle_id = bu.battle_id and bp.user_id = bu.builder_id
            where bu.battle_id = %L order by bu.final_rank $$, :'v'),
  $$ values ('cy', 1, 3), ('ben', 2, 2), ('ana', 3, 3) $$,
  'results from the two complete ballots: cy and ben tie on Best Build (1), cy has more votes in all');

-- ─── Idempotent ──────────────────────────────────────────────────────
select pg_temp.phase_events(:'v') as events_before, pg_temp.ver(:'v') as v_after \gset
set local role service_role;
select set_config('request.jwt.claims', :'service', true);
select public.sweep_deadlines();
reset role;
select results_eq(
  format($$ select phase::text, version from public.battles where id = %L $$, :'v'),
  format($$ values ('results', %s) $$, :v_after),
  'a second sweep changes nothing');
select is(pg_temp.phase_events(:'v'), :events_before, 'and logs nothing');

select * from finish();
rollback;
