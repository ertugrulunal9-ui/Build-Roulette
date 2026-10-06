-- Multiplayer battles in a room (T-016), through the RPCs:
--   start_battle → spinning → building → shipping → results → destroyed
-- and back to an open room, then a rematch in the same room.
--
-- Battle 1 (3 players): ana ships by hand (speedrun), ben auto-ships from his
--   autosave, cy has nothing (DNF). gus is in the room but not ready (not on
--   the roster); eli joins late (spectator); fay is a stranger.
-- Battle 2 (rematch, 4 players): dee leaves mid-battle (autosave → auto-ship),
--   the host kicks cy (draft disqualified), ana and ben ship at the same
--   instant → early transition straight to RESULTS, a shared rank 1 and a
--   shared fastest_ship.

begin;
create extension if not exists pgtap with schema extensions;

select plan(88);

\set ana '{"sub":"12a00000-0000-0000-0000-000000000001","role":"authenticated"}'
\set ben '{"sub":"12a00000-0000-0000-0000-000000000002","role":"authenticated"}'
\set cy  '{"sub":"12a00000-0000-0000-0000-000000000003","role":"authenticated"}'
\set dee '{"sub":"12a00000-0000-0000-0000-000000000004","role":"authenticated"}'
\set eli '{"sub":"12a00000-0000-0000-0000-000000000005","role":"authenticated"}'
\set fay '{"sub":"12a00000-0000-0000-0000-000000000006","role":"authenticated"}'
\set gus '{"sub":"12a00000-0000-0000-0000-000000000007","role":"authenticated"}'
\set service '{"role":"service_role"}'
\set ana_id '12a00000-0000-0000-0000-000000000001'
\set ben_id '12a00000-0000-0000-0000-000000000002'
\set cy_id  '12a00000-0000-0000-0000-000000000003'
\set dee_id '12a00000-0000-0000-0000-000000000004'
\set eli_id '12a00000-0000-0000-0000-000000000005'
\set fay_id '12a00000-0000-0000-0000-000000000006'
\set gus_id '12a00000-0000-0000-0000-000000000007'

insert into auth.users (id, is_anonymous)
select ('12a00000-0000-0000-0000-00000000000' || n)::uuid, true from generate_series(1, 7) n;
insert into public.profiles (id, display_name) values (:'fay_id', 'fay');

-- ═══ Lobby ════════════════════════════════════════════════════════════════
set local role authenticated;
select set_config('request.jwt.claims', :'ana', true);
select public.create_room('ana') as created \gset
reset role;
select (:'created'::jsonb) ->> 'room_id' as room, (:'created'::jsonb) ->> 'code' as code \gset

set local role authenticated;
select set_config('request.jwt.claims', :'ben', true);
select public.join_room(:'code', 'ben');
select set_config('request.jwt.claims', :'cy', true);
select public.join_room(:'code', 'cy');
select set_config('request.jwt.claims', :'gus', true);
select public.join_room(:'code', 'gus');
select set_config('request.jwt.claims', :'ana', true);
select public.set_ready(:'room', true);
reset role;
-- Join order: ana, ben, cy, gus.
update public.room_members set joined_at = now() - make_interval(mins => 10 - n)
from (values (:'ana_id'::uuid, 1), (:'ben_id'::uuid, 2), (:'cy_id'::uuid, 3), (:'gus_id'::uuid, 4)) v(u, n)
where room_id = :'room' and user_id = v.u;

-- ─── start_battle guards ──────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', :'ben', true);
select throws_ok(format($$ select public.start_battle(%L) $$, :'room'), '42501', 'not_host', 'only the host starts');
select set_config('request.jwt.claims', :'fay', true);
select throws_ok(format($$ select public.start_battle(%L) $$, :'room'), '42501', 'not_a_member', 'a stranger cannot start');
select set_config('request.jwt.claims', :'ana', true);
select throws_ok(format($$ select public.start_battle(%L) $$, :'room'), 'P0001', 'not_enough_players',
  'one ready player is not enough');
select throws_ok($$ select public.start_battle(gen_random_uuid()) $$, 'P0002', 'room_not_found', 'unknown room');
select set_config('request.jwt.claims', :'ben', true);
select public.set_ready(:'room', true);
reset role;
-- ben is ready but silent for 31 s: not present, so not counted.
update public.room_members set last_seen_at = now() - interval '31 seconds' where room_id = :'room' and user_id = :'ben_id';
set local role authenticated;
select set_config('request.jwt.claims', :'ana', true);
select throws_ok(format($$ select public.start_battle(%L) $$, :'room'), 'P0001', 'not_enough_players',
  'a ready player who is not present does not count');
reset role;
update public.room_members set last_seen_at = now() where room_id = :'room' and user_id = :'ben_id';
set local role authenticated;
select set_config('request.jwt.claims', :'cy', true);
select public.set_ready(:'room', true);
select set_config('request.jwt.claims', :'ana', true);
select public.start_battle(:'room') as b1 \gset
reset role;
select isnt(:'b1'::uuid, null::uuid, 'the host starts with 3 ready players');

-- ─── After the start ─────────────────────────────────────────────────
select results_eq(
  format($$ select phase::text, version, room_id, host_id, is_complete, phase_ends_at - phase_started_at
            from public.battles where id = %L $$, :'b1'),
  format($$ values ('spinning', 1, %L::uuid, %L::uuid, false, interval '6 seconds') $$, :'room', :'ana_id'),
  'battle 1 is SPINNING (6 s) at version 1 in the room, hosted by ana');
select is((select settings from public.battles where id = :'b1'),
  '{"mode": "multiplayer", "reveal_vote": false, "spinning_s": 6, "shipping_s": 15, "voting_s": 60,
    "results_s": 60, "capture_deadline_s": 600}'::jsonb,
  'settings: multiplayer, no reveal/vote (M3), default durations');
select ok((select c.time_limit_seconds in (300, 600, 900) from public.battles b
           join public.challenges c on c.id = b.challenge_id where b.id = :'b1'),
  'the time limit is drawn by the server (5, 10 or 15 min)');
select set_eq(
  format($$ select user_id from public.battle_players where battle_id = %L $$, :'b1'),
  array[:'ana_id', :'ben_id', :'cy_id']::uuid[],
  'the roster is frozen: the 3 ready, present players (not gus)');
select results_eq(
  format($$ select bp.display_name, bu.status::text from public.battle_players bp
            join public.builds bu on bu.battle_id = bp.battle_id and bu.builder_id = bp.user_id
            where bp.battle_id = %L order by bp.display_name $$, :'b1'),
  $$ values ('ana', 'draft'), ('ben', 'draft'), ('cy', 'draft') $$,
  'one draft build per roster player, with display names');
select results_eq(
  format($$ select status::text, current_battle_id from public.rooms where id = %L $$, :'room'),
  format($$ values ('in_battle', %L::uuid) $$, :'b1'),
  'the room is in_battle with the new battle');
select is((select count(*)::int from public.room_members where room_id = :'room' and is_ready), 0,
  'readiness is reset for the rematch');
select results_eq(
  format($$ select type from public.room_events where room_id = %L
            and id >= (select max(id) from public.room_events where room_id = %L and type = 'battle_started')
            order by id $$, :'room', :'room'),
  $$ values ('battle_started'), ('member_ready'), ('member_ready'), ('member_ready') $$,
  'room events: battle_started, then one ready reset per ready member');
select results_eq(
  format($$ select version, type, payload ->> 'to', payload -> 'roster' from public.battle_events where battle_id = %L $$, :'b1'),
  format($$ values (1, 'phase', 'spinning', %L::jsonb) $$,
         jsonb_build_array(:'ana_id', :'ben_id', :'cy_id')),
  'the start is logged with the roster');
select results_eq(
  format($$ select count(*)::int from public.jobs where ref_id = %L $$, :'b1'),
  $$ values (0) $$, 'no jobs yet');

-- ─── Late joiner, spectators, strangers ──────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', :'eli', true);
select is(public.join_room(:'code', 'eli') ->> 'role', 'spectator', 'a late joiner becomes a spectator');
select is(public.get_battle_snapshot(:'b1') -> 'me',
  jsonb_build_object('user_id', :'eli_id', 'is_player', false, 'role', 'spectator', 'is_host', false),
  'the spectator reads the running battle');
select throws_ok(format($$ select public.ship_build(%L, 'x', '{}') $$, :'b1'), '42501', 'not_on_roster',
  'a spectator cannot ship');
select throws_ok(format($$ select public.set_ready(%L, true) $$, :'room'), '42501', 'not_a_player',
  'a spectator cannot ready up');
select set_config('request.jwt.claims', :'gus', true);
select is(public.get_battle_snapshot(:'b1') -> 'me' ->> 'role', 'spectator',
  'a room player who is not on the roster watches as a spectator');
select throws_ok(format($$ select public.set_ready(%L, true) $$, :'room'), 'P0001', 'wrong_room_state',
  'nobody readies up during a battle');
select set_config('request.jwt.claims', :'ana', true);
select throws_ok(format($$ select public.start_battle(%L) $$, :'room'), 'P0001', 'wrong_room_state',
  'no second battle while one runs');
select throws_ok(format($$ select public.update_room_settings(%L, '{"max_players": 5}') $$, :'room'), 'P0001',
  'wrong_room_state', 'settings are frozen during a battle');
select is(public.get_battle_snapshot(:'b1') -> 'me',
  jsonb_build_object('user_id', :'ana_id', 'is_player', true, 'role', 'player', 'is_host', true),
  'the host reads the battle as a player and host');
select set_config('request.jwt.claims', :'fay', true);
select throws_ok(format($$ select public.get_battle_snapshot(%L) $$, :'b1'), 'P0002', 'battle_not_found',
  'a stranger cannot read the running battle');
select throws_ok(format($$ select public.advance_battle(%L, 1) $$, :'b1'), 'P0002', 'battle_not_found',
  'a stranger cannot nudge it');
select is((select count(*)::int from public.builds where battle_id = :'b1'), 0, 'RLS: a stranger sees no builds');
reset role;

-- ─── SPINNING → BUILDING ──────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', :'ben', true);
select is(public.advance_battle(:'b1', 1) ->> 'changed', 'false', 'not due yet: no-op');
reset role;
update public.battles set phase_ends_at = now() - interval '1 second' where id = :'b1';
set local role authenticated;
select set_config('request.jwt.claims', :'ben', true);
select is(public.advance_battle(:'b1', 0) ->> 'changed', 'false', 'a stale version is a no-op, even when due');
select set_config('request.jwt.claims', :'eli', true);
select is(public.advance_battle(:'b1', 1) ->> 'phase', 'building', 'any member (here a spectator) can nudge');
reset role;

-- A 300 s battle, 100 s in.
update public.challenges set time_limit_seconds = 300
 where id = (select challenge_id from public.battles where id = :'b1');
update public.battles
   set building_started_at = now() - interval '100 seconds',
       building_ends_at    = now() + interval '200 seconds',
       phase_ends_at       = now() + interval '200 seconds'
 where id = :'b1';

-- ─── Leave and come back ──────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', :'cy', true);
select public.leave_room(:'room');
select is(public.get_battle_snapshot(:'b1') -> 'players' -> 2 ->> 'state', 'left',
  'a roster player who left is shown as left (and still reads the battle)');
select throws_ok(format($$ select public.ship_build(%L, 'x', '{}') $$, :'b1'), '42501', 'not_a_member',
  'a roster player who left must rejoin to ship');
select is(public.join_room(:'code', 'cy') ->> 'role', 'player', 'the roster player rejoins as a player');
reset role;
select results_eq(
  format($$ select type, payload ->> 'user_id' from public.battle_events
            where battle_id = %L and type in ('leave', 'rejoin') order by id $$, :'b1'),
  format($$ values ('leave', %L), ('rejoin', %L) $$, :'cy_id', :'cy_id'),
  'leave and rejoin are battle events');

-- ─── ana ships ────────────────────────────────────────────────────────
insert into storage.objects (bucket_id, name) values
  ('ephemeral-builds', :'b1' || '/' || :'ana_id' || '/source.json'),
  ('ephemeral-builds', :'b1' || '/' || :'ana_id' || '/bundle.js'),
  ('ephemeral-builds', :'b1' || '/' || :'ben_id' || '/autosave/source.json'),
  ('ephemeral-builds', :'b1' || '/' || :'ben_id' || '/autosave/bundle.js');
set local role authenticated;
select set_config('request.jwt.claims', :'ana', true);
select public.ship_build(:'b1', 'Pomodoro Pro', '{"files": 2}') as a_ship \gset
select throws_ok(format($$ select public.ship_build(%L, 'again', '{}') $$, :'b1'), 'P0001', 'already_shipped',
  'ship is final');
reset role;
select is((:'a_ship'::jsonb) -> 'battle' ->> 'phase', 'building', 'others are still building: no early transition');
select results_eq(
  format($$ select status::text, completion_ms from public.builds where battle_id = %L and builder_id = %L $$,
         :'b1', :'ana_id'),
  $$ values ('shipped', 100000) $$,
  'ana shipped after 100 s');
select is(public.can_write_build_object(:'b1' || '/' || :'ana_id' || '/bundle.js'), false,
  'storage: nothing more can be written after ship');

-- ─── Deadline: SHIPPING, then RESULTS ────────────────────────────────
-- Move the whole timeline 220 s into the past (ana's ship included), so the
-- deadline was 20 s ago.
update public.builds set shipped_at = now() - interval '220 seconds'
 where battle_id = :'b1' and builder_id = :'ana_id';
update public.battles
   set building_started_at = now() - interval '320 seconds',
       building_ends_at    = now() - interval '20 seconds',
       phase_ends_at       = now() - interval '20 seconds'
 where id = :'b1';
set local role authenticated;
select set_config('request.jwt.claims', :'ben', true);
select results_eq(
  format($$ select (r ->> 'phase'), (r ->> 'phase_ends_at')::timestamptz
            from (select public.advance_battle(%L, (select version from public.battles where id = %L)) as r) x $$,
         :'b1', :'b1'),
  $$ select 'shipping', now() + interval '15 seconds' $$,
  'the deadline with drafts left: SHIPPING with the 15 s grace');
select throws_ok(format($$ select public.ship_build(%L, 'late', '{}') $$, :'b1'), 'P0001', 'deadline_passed',
  'past the deadline and the grace: refused');
reset role;
update public.battles set phase_ends_at = now() - interval '1 second' where id = :'b1';
set local role service_role;
select set_config('request.jwt.claims', :'service', true);
select is(public.advance_battle(:'b1', (select version from public.battles where id = :'b1')) ->> 'phase', 'results',
  'grace over: RESULTS');
reset role;

select results_eq(
  format($$ select bp.display_name, bu.status::text, bu.completion_ms, bu.final_rank, bu.shipped_at
            from public.builds bu join public.battle_players bp
              on bp.battle_id = bu.battle_id and bp.user_id = bu.builder_id
            where bu.battle_id = %L order by bp.display_name $$, :'b1'),
  $$ values ('ana', 'shipped', 100000, 1, now() - interval '220 seconds'),
            ('ben', 'auto_shipped', 300000, 2, now() - interval '20 seconds'),
            ('cy', 'dnf', null::int, null::int, null::timestamptz) $$,
  'results: shipped (rank 1), auto-shipped at building_ends_at (rank 2), DNF (no rank)');
select results_eq(
  format($$ select a.award, bp.display_name from public.awards a
            join public.builds bu on bu.id = a.build_id
            join public.battle_players bp on bp.battle_id = bu.battle_id and bp.user_id = bu.builder_id
            where a.battle_id = %L order by a.award $$, :'b1'),
  $$ values ('speedrun', 'ana') $$,
  'awards: speedrun for ana; no fastest_ship with only one build shipped by hand; nothing for auto-ship or DNF');
select is((select count(*)::int from public.jobs j join public.builds bu on bu.id = j.ref_id
           where bu.battle_id = :'b1' and j.kind = 'capture' and j.status = 'queued'), 2,
  'capture jobs for the shipped and the auto-shipped build, none for the DNF');
select results_eq(
  format($$ select phase::text, is_complete, finished_at, shipping_ended_at, phase_ends_at
            from public.battles where id = %L $$, :'b1'),
  $$ select 'results', true, now(), now(), now() + interval '60 seconds' $$,
  'RESULTS: complete, 60 s last look');
select is((select status::text from public.rooms where id = :'room'), 'in_battle', 'the room waits during RESULTS');

set local role authenticated;
select set_config('request.jwt.claims', :'fay', true);
select is(public.get_battle_snapshot(:'b1') -> 'me',
  jsonb_build_object('user_id', :'fay_id', 'is_player', false, 'role', 'viewer', 'is_host', false),
  'RESULTS are public: a stranger reads them as a viewer');
select ok(not (public.get_battle_snapshot(:'b1')::text like '%' || :'code' || '%'),
  'the battle snapshot never contains the room code');
select set_config('request.jwt.claims', :'ana', true);
select public.get_battle_snapshot(:'b1') as snap1 \gset
reset role;
select is((:'snap1'::jsonb) -> 'players',
  jsonb_build_array(
    jsonb_build_object('user_id', :'ana_id', 'display_name', 'ana', 'state', 'active'),
    jsonb_build_object('user_id', :'ben_id', 'display_name', 'ben', 'state', 'active'),
    jsonb_build_object('user_id', :'cy_id', 'display_name', 'cy', 'state', 'active')),
  'snapshot players carry their room state');
select ok((:'snap1'::jsonb) -> 'battle' ->> 'mode' = 'multiplayer'
          and jsonb_array_length((:'snap1'::jsonb) -> 'builds') = 3
          and (:'snap1'::jsonb)::text not like '%source.json%'
          and (:'snap1'::jsonb)::text not like '%autosave%'
          and not ((:'snap1'::jsonb) ? 'votes'),
  'snapshot: multiplayer, 3 builds, no ephemeral paths, no votes');
select is(public.get_public_battle(:'b1') -> 'players', '["ana", "ben", "cy"]'::jsonb,
  'the permanent results page lists the roster');

-- ─── RESULTS → DESTROYED, room reopens ────────────────────────────────
update public.battles set phase_ends_at = now() - interval '1 second',
                          shipping_ended_at = now() - interval '11 minutes' where id = :'b1';
set local role authenticated;
select set_config('request.jwt.claims', :'cy', true);
select is(public.advance_battle(:'b1', (select version from public.battles where id = :'b1')) ->> 'phase', 'destroyed',
  'capture deadline passed: DESTROYED');
reset role;
select results_eq(
  format($$ select status::text, current_battle_id from public.rooms where id = %L $$, :'room'),
  format($$ values ('open', %L::uuid) $$, :'b1'),
  'the room is open again and still points at the finished battle');
select is((select status::text from public.jobs where kind = 'destroy' and ref_id = :'b1'), 'queued',
  'the destroy job is queued');
select results_eq(
  format($$ select type from public.room_events where room_id = %L
            and type in ('battle_ended', 'member_promoted') order by id $$, :'room'),
  $$ values ('battle_ended'), ('member_promoted') $$,
  'room events: battle_ended, then the waiting spectator is promoted');
select is((select role::text from public.room_members where room_id = :'room' and user_id = :'eli_id'), 'player',
  'the late joiner is a player for the next battle');
select results_eq(
  format($$ select payload ->> 'from', payload ->> 'to' from public.battle_events
            where battle_id = %L and type = 'phase' order by id $$, :'b1'),
  $$ values (null, 'spinning'), ('spinning', 'building'), ('building', 'shipping'),
            ('shipping', 'results'), ('results', 'destroyed') $$,
  'battle 1 went spinning → building → shipping → results → destroyed (no REVEAL or VOTING in M3)');
select is(
  (select array_agg(version order by id) from public.battle_events where battle_id = :'b1'),
  (select array_agg(n) from generate_series(1, (select version from public.battles where id = :'b1')) n),
  'battle_events has exactly one row per version, gap-free');

-- ═══ Battle 2: rematch with leave, kick, early transition and ties ════════
set local role authenticated;
select set_config('request.jwt.claims', :'dee', true);
select is(public.join_room(:'code', 'dee') ->> 'role', 'player', 'dee joins the open room as a player');
select set_config('request.jwt.claims', :'ana', true);
select public.set_ready(:'room', true);
select set_config('request.jwt.claims', :'ben', true);
select public.set_ready(:'room', true);
select set_config('request.jwt.claims', :'cy', true);
select public.set_ready(:'room', true);
select set_config('request.jwt.claims', :'dee', true);
select public.set_ready(:'room', true);
select set_config('request.jwt.claims', :'ana', true);
select public.start_battle(:'room') as b2 \gset
reset role;
select set_eq(
  format($$ select user_id from public.battle_players where battle_id = %L $$, :'b2'),
  array[:'ana_id', :'ben_id', :'cy_id', :'dee_id']::uuid[],
  'battle 2 roster: the four ready players');
select ok((select challenge_id from public.battles where id = :'b2')
          <> (select challenge_id from public.battles where id = :'b1'),
  'a rematch is a new battle with a new challenge');

update public.battles set phase_ends_at = now() - interval '1 second' where id = :'b2';
set local role authenticated;
select set_config('request.jwt.claims', :'ana', true);
select is(public.advance_battle(:'b2', 1) ->> 'phase', 'building', 'battle 2 is BUILDING');
reset role;
update public.challenges set time_limit_seconds = 600
 where id = (select challenge_id from public.battles where id = :'b2');
update public.battles
   set building_started_at = now() - interval '100 seconds',
       building_ends_at    = now() + interval '500 seconds',
       phase_ends_at       = now() + interval '500 seconds'
 where id = :'b2';
insert into storage.objects (bucket_id, name) values
  ('ephemeral-builds', :'b2' || '/' || :'dee_id' || '/autosave/source.json'),
  ('ephemeral-builds', :'b2' || '/' || :'dee_id' || '/autosave/bundle.js'),
  ('ephemeral-builds', :'b2' || '/' || :'ana_id' || '/source.json'),
  ('ephemeral-builds', :'b2' || '/' || :'ana_id' || '/bundle.js'),
  ('ephemeral-builds', :'b2' || '/' || :'ben_id' || '/source.json'),
  ('ephemeral-builds', :'b2' || '/' || :'ben_id' || '/bundle.js'),
  ('ephemeral-builds', :'b2' || '/' || :'cy_id' || '/source.json'),
  ('ephemeral-builds', :'b2' || '/' || :'cy_id' || '/bundle.js');

-- ─── dee leaves, cy is kicked ────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', :'dee', true);
select public.leave_room(:'room');
select set_config('request.jwt.claims', :'ben', true);
select throws_ok(format($$ select public.kick_member(%L, %L) $$, :'room', :'cy_id'), '42501', 'not_host',
  'only the host kicks during a battle');
select set_config('request.jwt.claims', :'ana', true);
select public.kick_member(:'room', :'cy_id');
reset role;
select is((select phase::text from public.battles where id = :'b2'), 'building',
  'ana and ben still build: no early transition yet');
select results_eq(
  format($$ select status::text from public.builds where battle_id = %L and builder_id = %L $$, :'b2', :'cy_id'),
  $$ values ('disqualified') $$,
  'the kicked player''s draft is disqualified');
select results_eq(
  format($$ select type, payload ->> 'user_id', payload ->> 'build_status' from public.battle_events
            where battle_id = %L and type in ('leave', 'kick') order by id $$, :'b2'),
  format($$ values ('leave', %L, null), ('kick', %L, 'disqualified') $$, :'dee_id', :'cy_id'),
  'leave and kick are logged on the battle');

set local role authenticated;
select set_config('request.jwt.claims', :'cy', true);
select throws_ok(format($$ select public.ship_build(%L, 'x', '{}') $$, :'b2'), '42501', 'kicked',
  'a kicked player cannot ship');
select throws_ok(format($$ select public.get_battle_snapshot(%L) $$, :'b2'), 'P0002', 'battle_not_found',
  'a kicked roster player loses the running battle');
select throws_ok(format($$ select public.advance_battle(%L, 1) $$, :'b2'), 'P0002', 'battle_not_found',
  'a kicked roster player cannot nudge it');
select is(public.is_battle_member(:'b2'), false, 'is_battle_member: false after the kick');
select is(public.can_write_build_object(:'b2' || '/' || :'cy_id' || '/bundle.js'), false,
  'storage: a kicked player cannot write');
select ok(public.get_battle_snapshot(:'b1') ->> 'battle' is not null,
  'a kicked player still reads the earlier, public battle');
select set_config('request.jwt.claims', :'dee', true);
select is(public.get_battle_snapshot(:'b2') -> 'me' ->> 'role', 'player', 'a roster player who left still reads it');
select set_config('request.jwt.claims', :'gus', true);
select throws_ok(format($$ select public.kick_member(%L, %L) $$, :'room', :'ben_id'), '42501', 'not_host',
  'a spectator cannot kick');
reset role;

-- ─── ana and ben ship at the same instant: early end ──────────────────
set local role authenticated;
select set_config('request.jwt.claims', :'ana', true);
select is(public.ship_build(:'b2', 'Twin A', '{}') -> 'battle' ->> 'phase', 'building', 'ana ships; ben still builds');
select set_config('request.jwt.claims', :'ben', true);
select public.ship_build(:'b2', 'Twin B', '{}') as b_ship \gset
reset role;
select is((:'b_ship'::jsonb) -> 'battle' ->> 'phase', 'results',
  'the last active player ships: BUILDING → SHIPPING (no grace) → RESULTS at once');
select results_eq(
  format($$ select type, payload ->> 'from', payload ->> 'to', (payload ->> 'early')::boolean
            from public.battle_events where battle_id = %L and type in ('ship', 'phase') and version > 2
            order by id $$, :'b2'),
  $$ values ('ship', null, null, null::boolean), ('ship', null, null, null),
            ('phase', 'building', 'shipping', true), ('phase', 'shipping', 'results', null) $$,
  'events: two ships, then the early transitions');
select results_eq(
  format($$ select bp.display_name, bu.status::text, bu.completion_ms, bu.final_rank
            from public.builds bu join public.battle_players bp
              on bp.battle_id = bu.battle_id and bp.user_id = bu.builder_id
            where bu.battle_id = %L order by bp.display_name $$, :'b2'),
  $$ values ('ana', 'shipped', 100000, 1), ('ben', 'shipped', 100000, 1),
            ('cy', 'disqualified', null::int, null::int), ('dee', 'auto_shipped', 600000, 3) $$,
  'ranks: a tie shares rank 1 (rank 3 follows); the player who left is auto-shipped; disqualified: no rank');
select results_eq(
  format($$ select a.award, bp.display_name from public.awards a
            join public.builds bu on bu.id = a.build_id
            join public.battle_players bp on bp.battle_id = bu.battle_id and bp.user_id = bu.builder_id
            where a.battle_id = %L order by a.award, bp.display_name $$, :'b2'),
  $$ values ('fastest_ship', 'ana'), ('fastest_ship', 'ben'), ('speedrun', 'ana'), ('speedrun', 'ben') $$,
  'awards: fastest_ship is shared on a tie; speedrun for both; nothing for auto-ship or disqualified');
select results_eq(
  format($$ select bp.display_name from public.jobs j join public.builds bu on bu.id = j.ref_id
            join public.battle_players bp on bp.battle_id = bu.battle_id and bp.user_id = bu.builder_id
            where bu.battle_id = %L and j.kind = 'capture' order by bp.display_name $$, :'b2'),
  $$ values ('ana'), ('ben'), ('dee') $$,
  'capture jobs for the three shipped builds, none for the disqualified one');
select is(public.get_public_battle(:'b2') -> 'builds' -> 0 ->> 'final_rank', '1',
  'the permanent page shows the ranks');
select ok(not (public.get_public_battle(:'b2')::text like '%disqualified%'),
  'the permanent page hides the disqualified build');

set local role authenticated;
select set_config('request.jwt.claims', :'ana', true);
select is(
  (select jsonb_agg(p ->> 'state' order by p ->> 'display_name')
   from jsonb_array_elements(public.get_battle_snapshot(:'b2') -> 'players') p),
  '["active", "active", "kicked", "left"]'::jsonb,
  'snapshot: ana and ben active, cy kicked, dee left');
reset role;

-- ─── Captures arrive, DESTROYED, room open ────────────────────────────
set local role service_role;
select set_config('request.jwt.claims', :'service', true);
select public.complete_capture(bu.id, 'captured', :'b2' || '/' || bu.id || '.webp')
from public.builds bu where bu.battle_id = :'b2' and bu.status in ('shipped', 'auto_shipped');
reset role;
select is((select phase::text from public.battles where id = :'b2'), 'results',
  'all captures done, but the last look is not over');
update public.battles set phase_ends_at = now() - interval '1 second' where id = :'b2';
set local role service_role;
select set_config('request.jwt.claims', :'service', true);
select is(public.sweep_deadlines(), 1, 'the sweep ends the last look');
reset role;
select is((select phase::text from public.battles where id = :'b2'), 'destroyed', 'battle 2 is DESTROYED');
select is((select status::text from public.rooms where id = :'room'), 'open', 'the room is open for the next rematch');

select * from finish();
rollback;
