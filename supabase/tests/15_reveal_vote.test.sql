-- REVEAL and VOTING (T-019), through the RPCs.
--
-- Battle A (5 on the roster): ana and ben ship by hand, cy auto-ships, dee is
--   DNF, hal is kicked while building (draft disqualified). gus is a room
--   player who is not ready (a spectator of the battle), eli joins late
--   (spectator), fay is a stranger. REVEAL with 3 builds (60 s slots): host
--   reveal_next, a slot deadline, the sweep starts VOTING (voting_s 45).
--   Every guard of reveal_next and cast_vote, revotes, a player who leaves
--   and comes back, and the early end once every PRESENT voter is done (dee
--   voted half and went silent). Ranking tie on overall and total votes →
--   earlier shipped_at; shared category awards.
-- Battle B (3, reveal_slot_s 30): everyone ships → REVEAL at once; the host
--   vanishes and ben's reveal_next makes him host; skip_to_vote; a voter is
--   kicked during VOTING (their vote is not counted); the deadline ends
--   VOTING; overall tie → total votes; a category nobody voted in has no award.
-- Battle C (2): one final build → straight to RESULTS (too_few_builds).
-- Then the reveal_vote default switch, room settings, solo, and the
-- table of reveal slot lengths (also read by the @br/game drift test).

begin;
create extension if not exists pgtap with schema extensions;

select plan(123);

\set ana '{"sub":"15a00000-0000-0000-0000-000000000001","role":"authenticated"}'
\set ben '{"sub":"15a00000-0000-0000-0000-000000000002","role":"authenticated"}'
\set cy  '{"sub":"15a00000-0000-0000-0000-000000000003","role":"authenticated"}'
\set dee '{"sub":"15a00000-0000-0000-0000-000000000004","role":"authenticated"}'
\set eli '{"sub":"15a00000-0000-0000-0000-000000000005","role":"authenticated"}'
\set fay '{"sub":"15a00000-0000-0000-0000-000000000006","role":"authenticated"}'
\set gus '{"sub":"15a00000-0000-0000-0000-000000000007","role":"authenticated"}'
\set hal '{"sub":"15a00000-0000-0000-0000-000000000008","role":"authenticated"}'
\set ivy '{"sub":"15a00000-0000-0000-0000-000000000009","role":"authenticated"}'
\set service '{"role":"service_role"}'
\set ana_id '15a00000-0000-0000-0000-000000000001'
\set ben_id '15a00000-0000-0000-0000-000000000002'
\set cy_id  '15a00000-0000-0000-0000-000000000003'
\set dee_id '15a00000-0000-0000-0000-000000000004'
\set eli_id '15a00000-0000-0000-0000-000000000005'
\set fay_id '15a00000-0000-0000-0000-000000000006'
\set gus_id '15a00000-0000-0000-0000-000000000007'
\set hal_id '15a00000-0000-0000-0000-000000000008'
\set ivy_id '15a00000-0000-0000-0000-000000000009'

insert into auth.users (id, is_anonymous)
select ('15a00000-0000-0000-0000-00000000000' || n)::uuid, true from generate_series(1, 9) n;
insert into public.profiles (id, display_name) values (:'fay_id', 'fay');

-- A build's id by builder display name, in a battle.
create function pg_temp.bid(p_battle uuid, p_name text) returns uuid language sql as $$
  select bu.id from public.builds bu
  join public.battle_players bp on bp.battle_id = bu.battle_id and bp.user_id = bu.builder_id
  where bu.battle_id = p_battle and bp.display_name = p_name
$$;
create function pg_temp.ver(p_battle uuid) returns int language sql as $$
  select version from public.battles where id = p_battle
$$;
grant execute on function pg_temp.bid(uuid, text), pg_temp.ver(uuid) to authenticated, service_role;

-- ═══ Lobby ════════════════════════════════════════════════════════════════
set local role authenticated;
select set_config('request.jwt.claims', :'ana', true);
select public.create_room('ana') as created \gset
reset role;
select (:'created'::jsonb) ->> 'room_id' as room, (:'created'::jsonb) ->> 'code' as code \gset

set local role authenticated;
select set_config('request.jwt.claims', :'ana', true);
select throws_ok(format($$ select public.update_room_settings(%L, '{"reveal_vote": 1}') $$, :'room'), '22023',
  'invalid_settings', 'reveal_vote must be a boolean');
select throws_ok(format($$ select public.update_room_settings(%L, '{"voting_s": 181}') $$, :'room'), '22023',
  'invalid_settings', 'voting_s above 180');
select throws_ok(format($$ select public.update_room_settings(%L, '{"voting_s": 29}') $$, :'room'), '22023',
  'invalid_settings', 'voting_s below 30');
select throws_ok(format($$ select public.update_room_settings(%L, '{"reveal_slot_s": 61}') $$, :'room'), '22023',
  'invalid_settings', 'reveal_slot_s above 60');
select is(public.update_room_settings(:'room', '{"voting_s": 45, "reveal_vote": true}'),
  '{"max_players": 8, "voting_s": 45, "reveal_vote": true}'::jsonb, 'the host sets voting_s and reveal_vote');
select is(public.update_room_settings(:'room', '{"reveal_vote": null}'),
  '{"max_players": 8, "voting_s": 45}'::jsonb, 'reveal_vote: null goes back to the default');
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
select set_config('request.jwt.claims', :'hal', true);
select public.join_room(:'code', 'hal');
select public.set_ready(:'room', true);
select set_config('request.jwt.claims', :'gus', true);
select public.join_room(:'code', 'gus');
reset role;
update public.room_members set joined_at = now() - make_interval(mins => 10 - n)
from (values (:'ana_id'::uuid, 1), (:'ben_id'::uuid, 2), (:'cy_id'::uuid, 3), (:'dee_id'::uuid, 4),
             (:'hal_id'::uuid, 5), (:'gus_id'::uuid, 6)) v(u, n)
where room_id = :'room' and user_id = v.u;

-- ═══ Battle A ═════════════════════════════════════════════════════════════
set local role authenticated;
select set_config('request.jwt.claims', :'ana', true);
select public.start_battle(:'room') as a \gset
select set_config('request.jwt.claims', :'eli', true);
select public.join_room(:'code', 'eli');
reset role;
select is((select settings from public.battles where id = :'a'),
  '{"mode": "multiplayer", "reveal_vote": true, "spinning_s": 6, "shipping_s": 15, "voting_s": 45,
    "results_s": 60, "capture_deadline_s": 600}'::jsonb,
  'new multiplayer battles reveal and vote (reveal_vote: true); voting_s from the room');

update public.battles set phase_ends_at = now() - interval '1 second' where id = :'a';
set local role authenticated;
select set_config('request.jwt.claims', :'ana', true);
select is(public.advance_battle(:'a', 1) ->> 'phase', 'building', 'battle A is BUILDING');
select public.kick_member(:'room', :'hal_id');
reset role;
update public.challenges set time_limit_seconds = 300
 where id = (select challenge_id from public.battles where id = :'a');
update public.battles
   set building_started_at = now() - interval '100 seconds',
       building_ends_at = now() + interval '200 seconds', phase_ends_at = now() + interval '200 seconds'
 where id = :'a';
insert into storage.objects (bucket_id, name) values
  ('ephemeral-builds', :'a' || '/' || :'ana_id' || '/source.json'),
  ('ephemeral-builds', :'a' || '/' || :'ana_id' || '/bundle.js'),
  ('ephemeral-builds', :'a' || '/' || :'ben_id' || '/source.json'),
  ('ephemeral-builds', :'a' || '/' || :'ben_id' || '/bundle.js'),
  ('ephemeral-builds', :'a' || '/' || :'cy_id' || '/autosave/source.json'),
  ('ephemeral-builds', :'a' || '/' || :'cy_id' || '/autosave/bundle.js');
set local role authenticated;
select set_config('request.jwt.claims', :'ana', true);
select public.ship_build(:'a', 'Ana Clock', '{}');
select set_config('request.jwt.claims', :'ben', true);
select is(public.ship_build(:'a', 'Ben Board', '{}') -> 'battle' ->> 'phase', 'building',
  'cy and dee still build: no early end');
reset role;
-- Timeline: building started 330 s ago, ended 30 s ago; ana shipped after
-- 100 s, ben after 150 s.
update public.builds set shipped_at = now() - interval '230 seconds', completion_ms = 100000
 where battle_id = :'a' and builder_id = :'ana_id';
update public.builds set shipped_at = now() - interval '180 seconds', completion_ms = 150000
 where battle_id = :'a' and builder_id = :'ben_id';
update public.battles
   set building_started_at = now() - interval '330 seconds',
       building_ends_at = now() - interval '30 seconds', phase_ends_at = now() - interval '30 seconds'
 where id = :'a';
set local role authenticated;
select set_config('request.jwt.claims', :'ben', true);
select is(public.advance_battle(:'a', pg_temp.ver(:'a')) ->> 'phase', 'shipping', 'deadline: SHIPPING');
reset role;
update public.battles set phase_ends_at = now() - interval '1 second' where id = :'a';
set local role authenticated;
select set_config('request.jwt.claims', :'ben', true);
select is(public.advance_battle(:'a', pg_temp.ver(:'a')) ->> 'phase', 'reveal', 'grace over, 3 final builds: REVEAL');
reset role;

-- ─── REVEAL: order and slots ──────────────────────────────────────────
select results_eq(
  format($$ select bp.display_name, bu.status::text, bu.final_rank from public.builds bu
            join public.battle_players bp on bp.battle_id = bu.battle_id and bp.user_id = bu.builder_id
            where bu.battle_id = %L order by bp.display_name $$, :'a'),
  $$ values ('ana', 'shipped', null::int), ('ben', 'shipped', null), ('cy', 'auto_shipped', null),
            ('dee', 'dnf', null), ('hal', 'disqualified', null) $$,
  'end of SHIPPING: cy auto-shipped, dee DNF, hal disqualified; no ranks before RESULTS');
select set_eq(
  format($$ select unnest(reveal_order) from public.battles where id = %L $$, :'a'),
  format($$ values (%L::uuid), (%L::uuid), (%L::uuid) $$,
         pg_temp.bid(:'a', 'ana'), pg_temp.bid(:'a', 'ben'), pg_temp.bid(:'a', 'cy')),
  'reveal_order holds exactly the shipped and auto-shipped builds (no DNF, no disqualified)');
select results_eq(
  format($$ select cardinality(reveal_order), reveal_index, phase_ends_at - phase_started_at,
                   shipping_ended_at, finished_at, is_complete
            from public.battles where id = %L $$, :'a'),
  $$ values (3, 0, interval '60 seconds', now(), null::timestamptz, false) $$,
  'slot 0 of 3, 60 s (300/3 clamped), shipping_ended_at stamped, no results yet');
select is((select count(*)::int from public.jobs j join public.builds bu on bu.id = j.ref_id
           where bu.battle_id = :'a' and j.kind = 'capture'), 3,
  'capture jobs are queued when REVEAL starts (shipped + auto-shipped)');
select is((select payload from public.battle_events where battle_id = :'a' and type = 'phase'
           order by id desc limit 1),
  '{"from": "shipping", "to": "reveal", "reveal_index": 0}'::jsonb, 'the phase event carries reveal_index 0');
select is((select status::text from public.rooms where id = :'room'), 'in_battle', 'the room is in_battle');

set local role authenticated;
select set_config('request.jwt.claims', :'eli', true);
select public.get_battle_snapshot(:'a') as snap_r \gset
reset role;
select is((:'snap_r'::jsonb) -> 'battle' -> 'reveal_order',
  (select to_jsonb(reveal_order) from public.battles where id = :'a'), 'snapshot: reveal_order');
select is(
  jsonb_build_object('i', (:'snap_r'::jsonb) -> 'battle' -> 'reveal_index',
                     's', (:'snap_r'::jsonb) -> 'battle' -> 'reveal_slot_s',
                     'rv', (:'snap_r'::jsonb) -> 'battle' -> 'reveal_vote',
                     'p', (:'snap_r'::jsonb) -> 'vote_progress',
                     'me', (:'snap_r'::jsonb) -> 'me' -> 'can_vote'),
  '{"i": 0, "s": 60, "rv": true, "p": null, "me": false}'::jsonb,
  'snapshot: reveal_index, the slot length, no vote progress before VOTING');
select is((:'snap_r'::jsonb) -> 'vote_categories',
  '[{"slug": "overall", "label": "Best Build", "description": "The build you would actually use."},
    {"slug": "rule", "label": "Best Use of the Rule", "description": "Who turned the RULE card into a feature."},
    {"slug": "style", "label": "Best Style", "description": "Who nailed the STYLE card."},
    {"slug": "chaos", "label": "Most Chaotic", "description": "Delightfully unhinged. Bugs may be features."}]'::jsonb,
  'snapshot: the vote categories in display order');

-- ─── reveal_next guards ───────────────────────────────────────────────
select pg_temp.ver(:'a') as va \gset
set local role authenticated;
select set_config('request.jwt.claims', :'ben', true);
select throws_ok(format($$ select public.reveal_next(%L, %s) $$, :'a', :va), '42501', 'not_host',
  'a roster player who is not the host cannot reveal_next');
select throws_ok(format($$ select public.skip_to_vote(%L, %s) $$, :'a', :va), '42501', 'not_host',
  'nor skip_to_vote');
select set_config('request.jwt.claims', :'eli', true);
select throws_ok(format($$ select public.reveal_next(%L, %s) $$, :'a', :va), '42501', 'not_host',
  'a spectator cannot reveal_next');
select set_config('request.jwt.claims', :'fay', true);
select throws_ok(format($$ select public.reveal_next(%L, %s) $$, :'a', :va), 'P0002', 'battle_not_found',
  'a stranger cannot see the battle');
select set_config('request.jwt.claims', :'hal', true);
select throws_ok(format($$ select public.reveal_next(%L, %s) $$, :'a', :va), 'P0002', 'battle_not_found',
  'a kicked roster player cannot either');
select set_config('request.jwt.claims', :'ana', true);
select throws_ok(format($$ select public.reveal_next(%L, null) $$, :'a'), '22023', 'invalid_version',
  'the expected version is required');
select is(public.reveal_next(:'a', :va - 1),
  jsonb_build_object('changed', false, 'version', :va, 'phase', 'reveal',
                     'phase_ends_at', now() + interval '60 seconds', 'reveal_index', 0),
  'a stale version is a no-op (compare-and-set)');
select throws_ok(format($$ select public.cast_vote(%L, 'overall', %L) $$, :'a', pg_temp.bid(:'a', 'ben')),
  'P0001', 'wrong_phase', 'no votes during REVEAL');
select is(public.reveal_next(:'a', :va) - 'phase_ends_at',
  jsonb_build_object('changed', true, 'version', :va + 1, 'phase', 'reveal', 'reveal_index', 1),
  'the host moves to the next build');
reset role;
select results_eq(
  format($$ select reveal_index, phase_started_at, phase_ends_at from public.battles where id = %L $$, :'a'),
  $$ values (1, now(), now() + interval '60 seconds') $$, 'slot 1 gets a full 60 s');
select is((select payload from public.battle_events where battle_id = :'a' order by id desc limit 1),
  '{"from": "reveal", "to": "reveal", "reveal_index": 1, "reason": "host_next"}'::jsonb,
  'logged as a phase event with reason host_next');

-- ─── A slot deadline, then the sweep starts VOTING ────────────────────
update public.battles set phase_ends_at = now() - interval '1 second' where id = :'a';
set local role authenticated;
select set_config('request.jwt.claims', :'dee', true);
select is(public.advance_battle(:'a', pg_temp.ver(:'a')) ->> 'phase', 'reveal',
  'the slot deadline (a nudge by any member) moves on');
reset role;
select results_eq(
  format($$ select reveal_index, phase_ends_at from public.battles where id = %L $$, :'a'),
  $$ values (2, now() + interval '60 seconds') $$, 'slot 2, the last one');
update public.battles set phase_ends_at = now() - interval '1 second' where id = :'a';
set local role service_role;
select set_config('request.jwt.claims', :'service', true);
select cmp_ok(public.sweep_deadlines(), '>=', 1, 'the sweep ends the last slot');
reset role;
select results_eq(
  format($$ select phase::text, phase_ends_at - phase_started_at, reveal_index from public.battles where id = %L $$, :'a'),
  $$ values ('voting', interval '45 seconds', 2) $$,
  'the last slot ended: VOTING for voting_s (45 s)');
set local role authenticated;
select set_config('request.jwt.claims', :'ana', true);
select throws_ok(format($$ select public.reveal_next(%L, %s) $$, :'a', pg_temp.ver(:'a')), 'P0001', 'wrong_phase',
  'reveal_next outside REVEAL');
select throws_ok(format($$ select public.skip_to_vote(%L, %s) $$, :'a', pg_temp.ver(:'a')), 'P0001', 'wrong_phase',
  'skip_to_vote outside REVEAL');
select is(public.get_battle_snapshot(:'a') -> 'vote_progress', '{"voted_count": 0, "eligible_count": 4}'::jsonb,
  'vote progress: 0 of 4 (the kicked player is not eligible)');
select is((public.get_battle_snapshot(:'a') -> 'me') - 'user_id',
  '{"is_player": true, "role": "player", "is_host": true, "is_voter": true, "can_vote": true}'::jsonb,
  'the host can vote');
select set_config('request.jwt.claims', :'dee', true);
select is((public.get_battle_snapshot(:'a') -> 'me' ->> 'can_vote')::boolean, true, 'a DNF player can vote');
select set_config('request.jwt.claims', :'eli', true);
select is((public.get_battle_snapshot(:'a') -> 'me' ->> 'can_vote')::boolean, false, 'a spectator cannot');
reset role;

-- ─── cast_vote guards ─────────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', :'eli', true);
select throws_ok(format($$ select public.cast_vote(%L, 'overall', %L) $$, :'a', pg_temp.bid(:'a', 'ben')),
  '42501', 'not_on_roster', 'a late spectator cannot vote');
select set_config('request.jwt.claims', :'gus', true);
select throws_ok(format($$ select public.cast_vote(%L, 'overall', %L) $$, :'a', pg_temp.bid(:'a', 'ben')),
  '42501', 'not_on_roster', 'a room player who is not on the roster cannot vote');
select set_config('request.jwt.claims', :'fay', true);
select throws_ok(format($$ select public.cast_vote(%L, 'overall', %L) $$, :'a', pg_temp.bid(:'a', 'ben')),
  '42501', 'not_on_roster', 'a stranger cannot vote');
select set_config('request.jwt.claims', :'hal', true);
select throws_ok(format($$ select public.cast_vote(%L, 'overall', %L) $$, :'a', pg_temp.bid(:'a', 'ben')),
  '42501', 'kicked', 'a kicked roster player cannot vote');
select set_config('request.jwt.claims', :'ana', true);
select throws_ok(format($$ select public.cast_vote(%L, 'winner', %L) $$, :'a', pg_temp.bid(:'a', 'ben')),
  '22023', 'invalid_category', 'an unknown category');
select throws_ok(format($$ select public.cast_vote(%L, null, %L) $$, :'a', pg_temp.bid(:'a', 'ben')),
  '22023', 'invalid_category', 'no category');
select throws_ok(format($$ select public.cast_vote(%L, 'overall', gen_random_uuid()) $$, :'a'),
  'P0002', 'build_not_found', 'a build that is not in this battle');
select throws_ok(format($$ select public.cast_vote(%L, 'overall', %L) $$, :'a', pg_temp.bid(:'a', 'ana')),
  'P0001', 'self_vote', 'no votes for your own build');
select throws_ok(format($$ select public.cast_vote(%L, 'overall', %L) $$, :'a', pg_temp.bid(:'a', 'dee')),
  'P0001', 'not_votable', 'no votes for a DNF build');
select throws_ok(format($$ select public.cast_vote(%L, 'overall', %L) $$, :'a', pg_temp.bid(:'a', 'hal')),
  'P0001', 'not_votable', 'no votes for a disqualified build');
select throws_ok(format($$ select public.cast_vote(gen_random_uuid(), 'overall', %L) $$, pg_temp.bid(:'a', 'ben')),
  'P0002', 'battle_not_found', 'an unknown battle');
reset role;
update public.battle_players set is_voter = false where battle_id = :'a' and user_id = :'ana_id';
set local role authenticated;
select set_config('request.jwt.claims', :'ana', true);
select throws_ok(format($$ select public.cast_vote(%L, 'overall', %L) $$, :'a', pg_temp.bid(:'a', 'ben')),
  '42501', 'not_a_voter', 'a roster player who is not a voter (is_voter = false)');
reset role;
update public.battle_players set is_voter = true where battle_id = :'a' and user_id = :'ana_id';
update public.battles set phase_ends_at = now() where id = :'a';
set local role authenticated;
select set_config('request.jwt.claims', :'ana', true);
select throws_ok(format($$ select public.cast_vote(%L, 'overall', %L) $$, :'a', pg_temp.bid(:'a', 'ben')),
  'P0001', 'deadline_passed', 'no votes once the deadline is reached (before anyone nudged)');
reset role;
update public.battles set phase_ends_at = now() + interval '45 seconds' where id = :'a';

-- ─── Leave and come back ──────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', :'cy', true);
select public.leave_room(:'room');
select throws_ok(format($$ select public.cast_vote(%L, 'overall', %L) $$, :'a', pg_temp.bid(:'a', 'ana')),
  '42501', 'not_a_member', 'a voter who left must rejoin to vote');
select is(public.join_room(:'code', 'cy') ->> 'role', 'player', 'cy rejoins before the deadline');
reset role;
select is((select phase::text from public.battles where id = :'a'), 'voting',
  'leaving did not end VOTING (the present voters have not voted)');

-- ─── Votes ────────────────────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', :'ana', true);
select is(public.cast_vote(:'a', 'overall', pg_temp.bid(:'a', 'ben')) - 'battle',
  jsonb_build_object('category', 'overall', 'build_id', pg_temp.bid(:'a', 'ben'), 'ballot_complete', false),
  'ana votes Best Build: ben (ballot not complete yet)');
select public.cast_vote(:'a', 'rule', pg_temp.bid(:'a', 'cy'));
select public.cast_vote(:'a', 'style', pg_temp.bid(:'a', 'ben'));
select is((public.cast_vote(:'a', 'chaos', pg_temp.bid(:'a', 'cy')) ->> 'ballot_complete')::boolean, true,
  'her fourth category completes her ballot');
select is(public.get_my_votes(:'a'),
  jsonb_build_object('votes', jsonb_build_object(
    'overall', pg_temp.bid(:'a', 'ben'), 'rule', pg_temp.bid(:'a', 'cy'),
    'style', pg_temp.bid(:'a', 'ben'), 'chaos', pg_temp.bid(:'a', 'cy')), 'complete', true),
  'get_my_votes: her own ballot');
select set_config('request.jwt.claims', :'ben', true);
select public.cast_vote(:'a', 'overall', pg_temp.bid(:'a', 'cy'));
select public.cast_vote(:'a', 'overall', pg_temp.bid(:'a', 'ana'));
select is(public.get_my_votes(:'a') -> 'votes' ->> 'overall', pg_temp.bid(:'a', 'ana')::text,
  'a revote replaces the earlier choice');
select public.cast_vote(:'a', 'rule', pg_temp.bid(:'a', 'cy'));
select public.cast_vote(:'a', 'style', pg_temp.bid(:'a', 'ana'));
select public.cast_vote(:'a', 'chaos', pg_temp.bid(:'a', 'cy'));
select is(public.get_my_votes(:'a') -> 'votes' -> 'chaos', to_jsonb(pg_temp.bid(:'a', 'cy')),
  'get_my_votes shows only the caller''s own choices');
select is((select count(*)::int from public.votes where battle_id = :'a'), 4,
  'ballot secrecy (RLS): during VOTING ben reads only his own 4 votes');
select set_config('request.jwt.claims', :'eli', true);
select is((select count(*)::int from public.votes where battle_id = :'a'), 0, 'a spectator reads no votes');
select is(public.get_my_votes(:'a'), '{"votes": {}, "complete": false}'::jsonb, 'and has an empty ballot');
select is(public.get_battle_snapshot(:'a') -> 'vote_progress', '{"voted_count": 2, "eligible_count": 4}'::jsonb,
  'vote progress: 2 of 4, counts only');
select ok(public.get_battle_snapshot(:'a')::text not like '%' || pg_temp.bid(:'a', 'ben') || '","category%'
          and (public.get_battle_snapshot(:'a') -> 'builds' -> 0 -> 'votes') = 'null'::jsonb,
  'snapshot during VOTING: no tallies (builds[].votes is null)');
select set_config('request.jwt.claims', :'cy', true);
select public.cast_vote(:'a', 'overall', pg_temp.bid(:'a', 'ana'));
select public.cast_vote(:'a', 'rule', pg_temp.bid(:'a', 'ana'));
select public.cast_vote(:'a', 'style', pg_temp.bid(:'a', 'ben'));
select public.cast_vote(:'a', 'chaos', pg_temp.bid(:'a', 'ben'));
select set_config('request.jwt.claims', :'dee', true);
select public.cast_vote(:'a', 'overall', pg_temp.bid(:'a', 'ben'));
select is(public.cast_vote(:'a', 'rule', pg_temp.bid(:'a', 'ana')) -> 'battle' ->> 'phase', 'voting',
  'dee (present) has voted in 2 of 4 categories: VOTING goes on');
reset role;
select results_eq(
  format($$ select version, payload from public.battle_events where battle_id = %L and type = 'vote' order by id $$, :'a'),
  format($$ values (%s, '{"voted_count": 1, "eligible_count": 4}'::jsonb),
                   (%s, '{"voted_count": 2, "eligible_count": 4}'::jsonb),
                   (%s, '{"voted_count": 3, "eligible_count": 4}'::jsonb) $$,
         (select version from public.battle_events where battle_id = :'a' and type = 'vote' order by id limit 1),
         (select version from public.battle_events where battle_id = :'a' and type = 'vote' order by id offset 1 limit 1),
         (select version from public.battle_events where battle_id = :'a' and type = 'vote' order by id offset 2 limit 1)),
  'one vote event per completed ballot (counts only); partial ballots and revotes add none');

-- ─── Early end: dee goes silent; the next vote ends VOTING ───────────
update public.room_members set last_seen_at = now() - interval '31 seconds'
 where room_id = :'room' and user_id = :'dee_id';
set local role authenticated;
select set_config('request.jwt.claims', :'ana', true);
select is(public.cast_vote(:'a', 'chaos', pg_temp.bid(:'a', 'cy')) -> 'battle' ->> 'phase', 'results',
  'every PRESENT eligible voter is done (dee is silent): RESULTS right away');
reset role;
select results_eq(
  format($$ select phase::text, is_complete, finished_at, phase_ends_at from public.battles where id = %L $$, :'a'),
  $$ values ('results', true, now(), now() + interval '60 seconds') $$, 'RESULTS: complete, 60 s last look');
select is((select payload from public.battle_events where battle_id = :'a' and type = 'phase' order by id desc limit 1),
  '{"from": "voting", "to": "results", "reason": "all_voted"}'::jsonb, 'the early end is logged as all_voted');

-- ─── Results ──────────────────────────────────────────────────────────
-- ana:  overall 2 (ben, cy), rule 2 (cy, dee), style 1 (ben), chaos 0 → 5
-- ben:  overall 2 (ana, dee), rule 0, style 2 (ana, cy), chaos 1 (cy) → 5
-- cy:   overall 0, rule 2 (ana, ben), style 0, chaos 2 (ana, ben)     → 4
select results_eq(
  format($$ select bp.display_name, bu.final_rank, bu.total_votes, bu.vote_counts
            from public.builds bu join public.battle_players bp
              on bp.battle_id = bu.battle_id and bp.user_id = bu.builder_id
            where bu.battle_id = %L order by bp.display_name $$, :'a'),
  $$ values ('ana', 1, 5, '{"overall": 2, "rule": 2, "style": 1, "chaos": 0}'::jsonb),
            ('ben', 2, 5, '{"overall": 2, "rule": 0, "style": 2, "chaos": 1}'::jsonb),
            ('cy',  3, 4, '{"overall": 0, "rule": 2, "style": 0, "chaos": 2}'::jsonb),
            ('dee', null::int, 0, null::jsonb),
            ('hal', null, 0, null) $$,
  'tallies; ana and ben tie on overall (2) and total (5): the earlier ship ranks first; DNF and disqualified unranked');
select results_eq(
  format($$ select a.award, bp.display_name, a.source, a.votes from public.awards a
            join public.builds bu on bu.id = a.build_id
            join public.battle_players bp on bp.battle_id = bu.battle_id and bp.user_id = bu.builder_id
            where a.battle_id = %L order by a.source desc, a.award, bp.display_name $$, :'a'),
  $$ values ('chaos', 'cy', 'vote', 2), ('overall', 'ana', 'vote', 2), ('overall', 'ben', 'vote', 2),
            ('rule', 'ana', 'vote', 2), ('rule', 'cy', 'vote', 2), ('style', 'ben', 'vote', 2),
            ('fastest_ship', 'ana', 'auto', null::int), ('speedrun', 'ana', 'auto', null), ('speedrun', 'ben', 'auto', null) $$,
  'category awards to the top build (ties share) with their vote counts, plus the auto-awards');
select is((select count(*)::int from public.battle_players where battle_id = :'a' and voted_at is not null), 0,
  'who voted is never recorded where members could read it (voted_at stays null)');

set local role authenticated;
select set_config('request.jwt.claims', :'ben', true);
select is((select count(*)::int from public.votes where battle_id = :'a'), 4,
  'ballot secrecy after RESULTS: ben still reads only his own votes');
select throws_ok(format($$ select public.cast_vote(%L, 'overall', %L) $$, :'a', pg_temp.bid(:'a', 'cy')),
  'P0001', 'wrong_phase', 'no votes after VOTING');
select public.get_battle_snapshot(:'a') as snap_res \gset
select set_config('request.jwt.claims', :'fay', true);
select is((select count(*)::int from public.votes where battle_id = :'a'), 0,
  'a stranger reads no votes, even once the results are public');
select is(public.get_my_votes(:'a') -> 'votes', '{}'::jsonb, 'and has no ballot');
reset role;
select is(
  (select jsonb_agg(jsonb_build_object('rank', b -> 'final_rank', 'votes', b -> 'votes', 'status', b -> 'status')
                    order by (b ->> 'final_rank')::int nulls last, b ->> 'status')
   from jsonb_array_elements((:'snap_res'::jsonb) -> 'builds') b),
  '[{"rank": 1, "status": "shipped", "votes": {"overall": 2, "rule": 2, "style": 1, "chaos": 0}},
    {"rank": 2, "status": "shipped", "votes": {"overall": 2, "rule": 0, "style": 2, "chaos": 1}},
    {"rank": 3, "status": "auto_shipped", "votes": {"overall": 0, "rule": 2, "style": 0, "chaos": 2}},
    {"rank": null, "status": "disqualified", "votes": null},
    {"rank": null, "status": "dnf", "votes": null}]'::jsonb,
  'snapshot after RESULTS: per-build tallies (builds in rank order)');
select ok((:'snap_res'::jsonb) -> 'vote_progress' = 'null'::jsonb
          and (:'snap_res'::jsonb)::text not like '%voter_id%'
          and (:'snap_res'::jsonb)::text not like '%ballot%',
  'snapshot after RESULTS: no vote progress, no voter ids, no ballots');
select is(
  (select jsonb_agg(b -> 'votes' order by (b ->> 'final_rank')::int)
   from jsonb_array_elements(public.get_public_battle(:'a') -> 'builds') b where b ->> 'final_rank' is not null),
  '[{"overall": 2, "rule": 2, "style": 1, "chaos": 0},
    {"overall": 2, "rule": 0, "style": 2, "chaos": 1},
    {"overall": 0, "rule": 2, "style": 0, "chaos": 2}]'::jsonb,
  'the permanent page shows the per-category counts, in rank order');
select ok(public.get_public_battle(:'a')::text not like '%voter%'
          and public.get_public_battle(:'a')::text not like '%' || :'ana_id' || '%',
  'the permanent page has no voters and no user ids');
select is((select count(*)::int from public.awards where battle_id = :'a' and source = 'vote'),
  (select jsonb_array_length(public.get_public_battle(:'a') -> 'awards')) - 3,
  'the permanent page lists the vote awards with the auto-awards');

-- ═══ Battle B: host gone mid-REVEAL, skip, a kick during VOTING ═══════════
update public.battles set phase_ends_at = now() - interval '1 second',
                          shipping_ended_at = now() - interval '11 minutes' where id = :'a';
set local role service_role;
select set_config('request.jwt.claims', :'service', true);
select is(public.advance_battle(:'a', pg_temp.ver(:'a')) ->> 'phase', 'destroyed', 'battle A ends');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', :'ana', true);
select public.update_room_settings(:'room', '{"reveal_slot_s": 30}');
select public.set_ready(:'room', true);
select set_config('request.jwt.claims', :'ben', true);
select public.set_ready(:'room', true);
select set_config('request.jwt.claims', :'cy', true);
select public.set_ready(:'room', true);
select set_config('request.jwt.claims', :'ana', true);
select public.start_battle(:'room') as b \gset
reset role;
select set_eq(format($$ select user_id from public.battle_players where battle_id = %L $$, :'b'),
  array[:'ana_id', :'ben_id', :'cy_id']::uuid[], 'battle B roster: ana, ben, cy');
update public.battles set phase_ends_at = now() - interval '1 second' where id = :'b';
set local role authenticated;
select set_config('request.jwt.claims', :'ana', true);
select public.advance_battle(:'b', 1);
reset role;
insert into storage.objects (bucket_id, name)
select 'ephemeral-builds', :'b' || '/' || u || '/' || f
from unnest(array[:'ana_id', :'ben_id', :'cy_id']) u, unnest(array['source.json', 'bundle.js']) f;
set local role authenticated;
select set_config('request.jwt.claims', :'ana', true);
select public.ship_build(:'b', 'A2', '{}');
select set_config('request.jwt.claims', :'ben', true);
select public.ship_build(:'b', 'B2', '{}');
select set_config('request.jwt.claims', :'cy', true);
select is(public.ship_build(:'b', 'C2', '{}') -> 'battle' ->> 'phase', 'reveal',
  'the last ship goes BUILDING → SHIPPING → REVEAL at once');
reset role;
select results_eq(
  format($$ select cardinality(reveal_order), phase_ends_at - phase_started_at from public.battles where id = %L $$, :'b'),
  $$ values (3, interval '30 seconds') $$, 'the room''s reveal_slot_s (30 s) replaces the 300/n rule');

-- ─── The host vanishes mid-REVEAL ─────────────────────────────────────
update public.room_members set last_seen_at = now() - interval '31 seconds'
 where room_id = :'room' and user_id = :'ana_id';
select pg_temp.ver(:'b') as vb \gset
set local role authenticated;
select set_config('request.jwt.claims', :'ben', true);
select is(public.reveal_next(:'b', :vb) - 'phase_ends_at' - 'version',
  '{"changed": true, "phase": "reveal", "reveal_index": 1}'::jsonb,
  'ana is silent for 31 s: ben''s reveal_next makes him host (earliest present player) and goes on');
reset role;
select is((select host_id from public.battles where id = :'b'), :'ben_id'::uuid, 'battles.host_id follows the room host');
select results_eq(
  format($$ select type, payload ->> 'reason' from public.battle_events where battle_id = %L and version > %s order by id $$,
         :'b', :vb),
  $$ values ('host_change', 'absent'), ('phase', 'host_next') $$,
  'events: the host change, then the slot step');
set local role authenticated;
select set_config('request.jwt.claims', :'ana', true);
select throws_ok(format($$ select public.reveal_next(%L, %s) $$, :'b', pg_temp.ver(:'b')), '42501', 'not_host',
  'the old host lost the controls');
select set_config('request.jwt.claims', :'ben', true);
select is(public.skip_to_vote(:'b', pg_temp.ver(:'b')) ->> 'phase', 'voting', 'the host skips the rest of the reveal');
reset role;
select is((select payload from public.battle_events where battle_id = :'b' order by id desc limit 1),
  '{"from": "reveal", "to": "voting", "reason": "host_skip"}'::jsonb, 'logged with reason host_skip');
select is((select phase_ends_at - phase_started_at from public.battles where id = :'b'), interval '45 seconds',
  'VOTING for voting_s');

-- ─── Votes, then a voter is kicked ───────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', :'ana', true);
select public.cast_vote(:'b', 'overall', pg_temp.bid(:'b', 'ben'));
select public.cast_vote(:'b', 'style', pg_temp.bid(:'b', 'ben'));
select set_config('request.jwt.claims', :'ben', true);
select public.cast_vote(:'b', 'overall', pg_temp.bid(:'b', 'cy'));
select public.cast_vote(:'b', 'style', pg_temp.bid(:'b', 'cy'));
select public.cast_vote(:'b', 'rule', pg_temp.bid(:'b', 'cy'));
select set_config('request.jwt.claims', :'cy', true);
select public.cast_vote(:'b', 'overall', pg_temp.bid(:'b', 'ana'));
select set_config('request.jwt.claims', :'ben', true);
select public.kick_member(:'room', :'cy_id');
select is(public.get_battle_snapshot(:'b') -> 'vote_progress', '{"voted_count": 0, "eligible_count": 2}'::jsonb,
  'the kicked voter is no longer eligible');
reset role;
select is((select phase::text from public.battles where id = :'b'), 'voting',
  'the present voters have not finished: VOTING goes on');
update public.battles set phase_ends_at = now() - interval '1 second' where id = :'b';
set local role authenticated;
select set_config('request.jwt.claims', :'ana', true);
select is(public.advance_battle(:'b', pg_temp.ver(:'b')) ->> 'phase', 'results', 'the deadline ends VOTING');
reset role;
select is((select payload from public.battle_events where battle_id = :'b' and type = 'phase' order by id desc limit 1),
  '{"from": "voting", "to": "results"}'::jsonb, 'a deadline end has no reason');
-- ana: 0; ben: overall 1 (ana), style 1 (ana) → 2; cy: overall, style, rule
-- (ben) → 3. cy's own vote (overall → ana) is not counted: cy was kicked.
select results_eq(
  format($$ select bp.display_name, bu.final_rank, bu.total_votes, bu.vote_counts
            from public.builds bu join public.battle_players bp
              on bp.battle_id = bu.battle_id and bp.user_id = bu.builder_id
            where bu.battle_id = %L order by bp.display_name $$, :'b'),
  $$ values ('ana', 3, 0, '{"overall": 0, "rule": 0, "style": 0, "chaos": 0}'::jsonb),
            ('ben', 2, 2, '{"overall": 1, "rule": 0, "style": 1, "chaos": 0}'::jsonb),
            ('cy',  1, 3, '{"overall": 1, "rule": 1, "style": 1, "chaos": 0}'::jsonb) $$,
  'overall tie (1–1): more total votes ranks first; the kicked voter''s vote is not counted, their build still is');
select results_eq(
  format($$ select a.award, bp.display_name, a.votes from public.awards a
            join public.builds bu on bu.id = a.build_id
            join public.battle_players bp on bp.battle_id = bu.battle_id and bp.user_id = bu.builder_id
            where a.battle_id = %L and a.source = 'vote' order by a.award, bp.display_name $$, :'b'),
  $$ values ('overall', 'ben', 1), ('overall', 'cy', 1), ('rule', 'cy', 1), ('style', 'ben', 1), ('style', 'cy', 1) $$,
  'shared category awards on ties; nobody voted chaos, so no chaos award');

-- ═══ Battle C: fewer than 2 final builds ══════════════════════════════════
update public.battles set phase_ends_at = now() - interval '1 second',
                          shipping_ended_at = now() - interval '11 minutes' where id = :'b';
set local role service_role;
select set_config('request.jwt.claims', :'service', true);
select is(public.advance_battle(:'b', pg_temp.ver(:'b')) ->> 'phase', 'destroyed', 'battle B ends');
reset role;
-- The deployment default says "no reveal/vote", the room says yes: the room wins.
insert into private.app_settings (key, value) values ('reveal_vote_default', 'false');
set local role authenticated;
select set_config('request.jwt.claims', :'ben', true);
select public.update_room_settings(:'room', '{"reveal_vote": true}');
select public.set_ready(:'room', true);
select set_config('request.jwt.claims', :'ana', true);
select public.set_ready(:'room', true);
select set_config('request.jwt.claims', :'ben', true);
select public.start_battle(:'room') as c \gset
reset role;
select is((select settings ->> 'reveal_vote' from public.battles where id = :'c'), 'true',
  'the room''s reveal_vote setting wins over the deployment default');
update public.battles set phase_ends_at = now() - interval '1 second' where id = :'c';
set local role authenticated;
select set_config('request.jwt.claims', :'ben', true);
select public.advance_battle(:'c', 1);
reset role;
insert into storage.objects (bucket_id, name) values
  ('ephemeral-builds', :'c' || '/' || :'ben_id' || '/source.json'),
  ('ephemeral-builds', :'c' || '/' || :'ben_id' || '/bundle.js');
set local role authenticated;
select set_config('request.jwt.claims', :'ben', true);
select public.ship_build(:'c', 'Lonely', '{}');
reset role;
update public.battles set building_ends_at = now() - interval '20 seconds', phase_ends_at = now() - interval '20 seconds'
 where id = :'c';
set local role authenticated;
select set_config('request.jwt.claims', :'ana', true);
select is(public.advance_battle(:'c', pg_temp.ver(:'c')) ->> 'phase', 'shipping', 'battle C: SHIPPING');
reset role;
update public.battles set phase_ends_at = now() - interval '1 second' where id = :'c';
set local role authenticated;
select set_config('request.jwt.claims', :'ana', true);
select is(public.advance_battle(:'c', pg_temp.ver(:'c')) ->> 'phase', 'results',
  'one final build: no REVEAL, no VOTING, straight to RESULTS');
reset role;
select results_eq(
  format($$ select phase::text, cardinality(reveal_order), is_complete, shipping_ended_at, finished_at
            from public.battles where id = %L $$, :'c'),
  $$ values ('results', 0, true, now(), now()) $$, 'RESULTS with an empty reveal order');
select is((select payload from public.battle_events where battle_id = :'c' and type = 'phase' order by id desc limit 1),
  '{"from": "shipping", "to": "results", "reason": "too_few_builds"}'::jsonb, 'logged as too_few_builds');
select results_eq(
  format($$ select bp.display_name, bu.status::text, bu.final_rank, bu.vote_counts from public.builds bu
            join public.battle_players bp on bp.battle_id = bu.battle_id and bp.user_id = bu.builder_id
            where bu.battle_id = %L order by bp.display_name $$, :'c'),
  $$ values ('ana', 'dnf', null::int, null::jsonb),
            ('ben', 'shipped', 1, '{"overall": 0, "rule": 0, "style": 0, "chaos": 0}'::jsonb) $$,
  'the single final build is rank 1 with zero votes');
select is((select count(*)::int from public.awards where battle_id = :'c' and source = 'vote'), 0, 'no vote awards');
set local role authenticated;
select set_config('request.jwt.claims', :'ana', true);
select is(public.get_reveal_builds(:'c'), '[]'::jsonb, 'nothing to reveal');
select is(public.get_battle_snapshot(:'c') -> 'battle' -> 'reveal_slot_s', 'null'::jsonb, 'no slot length');
select throws_ok(format($$ select public.cast_vote(%L, 'overall', %L) $$, :'c', pg_temp.bid(:'c', 'ben')),
  'P0001', 'wrong_phase', 'no voting');
reset role;

-- ─── The deployment default alone ─────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', :'ivy', true);
select public.create_room('ivy') as created2 \gset
reset role;
select (:'created2'::jsonb) ->> 'room_id' as room2, (:'created2'::jsonb) ->> 'code' as code2 \gset
set local role authenticated;
select set_config('request.jwt.claims', :'fay', true);
select public.join_room(:'code2', 'fay');
select public.set_ready(:'room2', true);
select set_config('request.jwt.claims', :'ivy', true);
select public.set_ready(:'room2', true);
select public.start_battle(:'room2') as d \gset
reset role;
select is((select settings ->> 'reveal_vote' from public.battles where id = :'d'), 'false',
  'with reveal_vote_default = false (test environments) and no room setting, battles skip reveal/vote');
delete from private.app_settings;

-- ─── Solo is unchanged ────────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', :'gus', true);
select public.start_solo_battle('gus', 300) as s \gset
reset role;
select is((select settings from public.battles where id = :'s') ? 'reveal_vote', false, 'solo: no reveal_vote setting');
update public.battles set phase_ends_at = now() - interval '1 second' where id = :'s';
set local role authenticated;
select set_config('request.jwt.claims', :'gus', true);
select public.advance_battle(:'s', 1);
reset role;
insert into storage.objects (bucket_id, name) values
  ('ephemeral-builds', :'s' || '/' || :'gus_id' || '/source.json'),
  ('ephemeral-builds', :'s' || '/' || :'gus_id' || '/bundle.js');
set local role authenticated;
select set_config('request.jwt.claims', :'gus', true);
select is(public.ship_build(:'s', 'Solo', '{}') -> 'battle' ->> 'phase', 'results', 'solo: ship → RESULTS, no REVEAL');
select ok(not (public.get_battle_snapshot(:'s') ? 'vote_progress')
          and not (public.get_battle_snapshot(:'s') -> 'battle' ? 'reveal_order')
          and not (public.get_battle_snapshot(:'s') -> 'me' ? 'can_vote'),
  'solo snapshot: no reveal or vote fields');
reset role;

-- ─── Realtime: phase with reveal_index, vote_progress ─────────────────
select is(
  (select jsonb_agg((payload - 'id' - 'phase_started_at' - 'phase_ends_at') order by (payload ->> 'version')::int)
   from realtime.messages where topic = 'battle:' || :'a' and payload ->> 'phase' = 'reveal'),
  format('[{"type": "phase", "version": %s, "phase": "reveal", "reveal_index": 0},
           {"type": "phase", "version": %s, "phase": "reveal", "reveal_index": 1, "reason": "host_next"},
           {"type": "phase", "version": %s, "phase": "reveal", "reveal_index": 2}]',
         :va, :va + 1, :va + 2)::jsonb,
  'phase broadcasts during REVEAL carry reveal_index (and the host''s reason)');
select is(
  (select jsonb_agg((payload - 'id' - 'version') order by (payload ->> 'version')::int)
   from realtime.messages where topic = 'battle:' || :'a' and event = 'vote_progress'),
  '[{"type": "vote_progress", "voted_count": 1, "eligible_count": 4},
    {"type": "vote_progress", "voted_count": 2, "eligible_count": 4},
    {"type": "vote_progress", "voted_count": 3, "eligible_count": 4}]'::jsonb,
  'vote_progress broadcasts: counts only, one per completed ballot');
select is(
  (select array_agg((payload ->> 'version')::int order by (payload ->> 'version')::int)
   from realtime.messages where topic = 'battle:' || :'a'),
  (select array_agg(n) from generate_series(1, pg_temp.ver(:'a')) n),
  'battle A: one broadcast per version, gap-free, through REVEAL and VOTING');
select is_empty(
  format($$ select 1 from realtime.messages where topic = 'battle:%s'
            and (payload::text ~ '(overall|"rule"|chaos|voter|ballot|tally|build_id.*category)') $$, :'a'),
  'no broadcast carries a category choice, a voter or a tally');

-- ─── Constants ────────────────────────────────────────────────────────
-- reveal-slot reference table (packages/game/src/schema-drift.test.ts checks
-- revealSlotSeconds against these same pairs).
select results_eq(
  $$ select n, private.reveal_slot_seconds(n) from unnest(array[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 20]) n $$,
  $$ values (0, 60), (1, 60), (2, 60), (3, 60), (4, 60), (5, 60), (6, 50), (7, 43), (8, 38), (9, 33),
            (10, 30), (11, 30), (12, 30), (20, 30) $$,
  'reveal slot: round(clamp(300 / n, 30, 60)) whole seconds');
select is(private.battle_reveal_slot('{"reveal_slot_s": 45}', 8), 45, 'a room''s reveal_slot_s wins');
select is(private.battle_reveal_slot('{}', 8), 38, 'otherwise the rule');

select * from finish();
rollback;
