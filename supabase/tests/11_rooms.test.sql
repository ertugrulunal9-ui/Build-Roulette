-- Rooms and the lobby RPCs (T-016): create, join, leave, ready, settings,
-- kick, heartbeat, snapshot, and every guard.
--
-- Cast (uuids end in the list number):
--   1 hana  creates room A (host)
--   2 ivan  joins A
--   3 jo    joins A
--   4 kim   joins A when it is full → spectator
--   5 lou   stranger; later fills rooms
--   6 max   joins, is kicked
--   7 noa   room B: alone, leaves → B closes

begin;
create extension if not exists pgtap with schema extensions;

select plan(84);

\set hana '{"sub":"11a00000-0000-0000-0000-000000000001","role":"authenticated"}'
\set ivan '{"sub":"11a00000-0000-0000-0000-000000000002","role":"authenticated"}'
\set jo   '{"sub":"11a00000-0000-0000-0000-000000000003","role":"authenticated"}'
\set kim  '{"sub":"11a00000-0000-0000-0000-000000000004","role":"authenticated"}'
\set lou  '{"sub":"11a00000-0000-0000-0000-000000000005","role":"authenticated"}'
\set max  '{"sub":"11a00000-0000-0000-0000-000000000006","role":"authenticated"}'
\set noa  '{"sub":"11a00000-0000-0000-0000-000000000007","role":"authenticated"}'
\set nobody '{"role":"authenticated"}'
\set hana_id '11a00000-0000-0000-0000-000000000001'
\set ivan_id '11a00000-0000-0000-0000-000000000002'
\set jo_id   '11a00000-0000-0000-0000-000000000003'
\set kim_id  '11a00000-0000-0000-0000-000000000004'
\set lou_id  '11a00000-0000-0000-0000-000000000005'
\set max_id  '11a00000-0000-0000-0000-000000000006'
\set noa_id  '11a00000-0000-0000-0000-000000000007'

insert into auth.users (id, is_anonymous)
select ('11a00000-0000-0000-0000-00000000000' || n)::uuid, true from generate_series(1, 7) n;

-- ═══ Not signed in (9) ════════════════════════════════════════════════════
set local role authenticated;
select set_config('request.jwt.claims', :'nobody', true);
select throws_ok($$ select public.create_room('x') $$, '42501', 'not_authenticated', 'create_room needs a user');
select throws_ok($$ select public.join_room('ABCDE', 'x') $$, '42501', 'not_authenticated', 'join_room needs a user');
select throws_ok($$ select public.leave_room(gen_random_uuid()) $$, '42501', 'not_authenticated', 'leave_room needs a user');
select throws_ok($$ select public.set_ready(gen_random_uuid(), true) $$, '42501', 'not_authenticated', 'set_ready needs a user');
select throws_ok($$ select public.update_room_settings(gen_random_uuid(), '{}') $$, '42501', 'not_authenticated',
  'update_room_settings needs a user');
select throws_ok($$ select public.kick_member(gen_random_uuid(), gen_random_uuid()) $$, '42501', 'not_authenticated',
  'kick_member needs a user');
select throws_ok($$ select public.heartbeat(gen_random_uuid()) $$, '42501', 'not_authenticated', 'heartbeat needs a user');
select throws_ok($$ select public.get_room_snapshot(gen_random_uuid()) $$, '42501', 'not_authenticated',
  'get_room_snapshot needs a user');
select throws_ok($$ select public.start_battle(gen_random_uuid()) $$, '42501', 'not_authenticated',
  'start_battle needs a user');
reset role;

-- ═══ create_room (8) ══════════════════════════════════════════════════════
set local role authenticated;
select set_config('request.jwt.claims', :'hana', true);
select throws_ok($$ select public.create_room('  ') $$, '22023', 'invalid_display_name', 'blank display name');
select throws_ok($$ select public.create_room(repeat('x', 25)) $$, '22023', 'invalid_display_name', '25 characters');
select public.create_room('  Hana  ') as a_created \gset
reset role;
select (:'a_created'::jsonb) ->> 'room_id' as room_a, (:'a_created'::jsonb) ->> 'code' as code_a \gset

select ok(:'code_a' ~ '^[A-HJ-NP-Z2-9]{5}$', 'create_room returns a 5-character code without I/O/0/1');
select results_eq(
  format($$ select host_id, status::text, version, settings from public.rooms where id = %L $$, :'room_a'),
  format($$ values (%L::uuid, 'open', 1, '{"max_players": 8}'::jsonb) $$, :'hana_id'),
  'the room is open, hosted by the caller, version 1, max 8 players');
select results_eq(
  format($$ select user_id, role::text, is_ready, left_at, kicked_at from public.room_members where room_id = %L $$, :'room_a'),
  format($$ values (%L::uuid, 'player', false, null::timestamptz, null::timestamptz) $$, :'hana_id'),
  'the host is the only member, a player, not ready');
select is((select display_name from public.profiles where id = :'hana_id'), 'Hana', 'the profile is upserted (trimmed)');
select results_eq(
  format($$ select version, type, actor_id from public.room_events where room_id = %L $$, :'room_a'),
  format($$ values (1, 'created', %L::uuid) $$, :'hana_id'),
  'the creation is logged in room_events');

-- A user hosts at most 3 open rooms.
set local role authenticated;
select set_config('request.jwt.claims', :'lou', true);
select public.create_room('lou') as l1 \gset
select public.create_room('lou') as l2 \gset
select public.create_room('lou') as l3 \gset
select throws_ok($$ select public.create_room('lou') $$, 'P0001', 'too_many_rooms', 'a fourth hosted room is refused');
reset role;

-- ═══ join_room (14) ═══════════════════════════════════════════════════════
set local role authenticated;
select set_config('request.jwt.claims', :'ivan', true);
select throws_ok($$ select public.join_room('ZZZZZ', 'ivan') $$, 'P0002', 'room_not_found', 'unknown code');
select throws_ok($$ select public.join_room('I0O1x', 'ivan') $$, 'P0002', 'room_not_found', 'malformed code');
select throws_ok(format($$ select public.join_room(%L, '') $$, :'code_a'), '22023', 'invalid_display_name',
  'join needs a display name');
select is(public.join_room(' ' || lower(:'code_a') || ' ', 'ivan') - 'room_id',
  jsonb_build_object('code', :'code_a', 'role', 'player'),
  'join with a lower-case, padded code: player');
select is(public.join_room(:'code_a', 'ivan') ->> 'role', 'player', 'joining again while in the room is harmless');
reset role;
select is((select version from public.rooms where id = :'room_a'), 2, 'the repeated join did not bump the version');

set local role authenticated;
select set_config('request.jwt.claims', :'ivan', true);
select lives_ok(format($$ select public.join_room(%L, 'Ivan the Great') $$, :'code_a'), 'a join can rename');
reset role;
select results_eq(
  format($$ select version, type from public.room_events where room_id = %L order by id desc limit 1 $$, :'room_a'),
  $$ values (3, 'member_updated') $$,
  'the rename is a member_updated event');

update public.rooms set settings = '{"max_players": 3}' where id = :'room_a';
update public.room_members set joined_at = now() - interval '10 minutes' where room_id = :'room_a' and user_id = :'hana_id';
update public.room_members set joined_at = now() - interval '9 minutes' where room_id = :'room_a' and user_id = :'ivan_id';

set local role authenticated;
select set_config('request.jwt.claims', :'jo', true);
select is(public.join_room(:'code_a', 'jo') ->> 'role', 'player', 'jo fills the last of 3 player slots');
select set_config('request.jwt.claims', :'kim', true);
select is(public.join_room(:'code_a', 'kim') ->> 'role', 'spectator', 'kim finds the room full: spectator');
reset role;
update public.room_members set joined_at = now() - interval '8 minutes' where room_id = :'room_a' and user_id = :'jo_id';
update public.room_members set joined_at = now() - interval '7 minutes' where room_id = :'room_a' and user_id = :'kim_id';

-- 20 spectators is the cap.
insert into auth.users (id, is_anonymous)
select ('11b00000-0000-0000-0000-0000000000' || lpad(n::text, 2, '0'))::uuid, true from generate_series(1, 19) n;
insert into public.profiles (id, display_name)
select ('11b00000-0000-0000-0000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'fan' || n from generate_series(1, 19) n;
insert into public.room_members (room_id, user_id, role)
select :'room_a', ('11b00000-0000-0000-0000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'spectator'
from generate_series(1, 19) n;
set local role authenticated;
select set_config('request.jwt.claims', :'max', true);
select throws_ok(format($$ select public.join_room(%L, 'max') $$, :'code_a'), 'P0001', 'room_full',
  'no player slot and 20 spectators: room_full');
reset role;
delete from public.room_members where room_id = :'room_a' and user_id::text like '11b00000-%';

set local role authenticated;
select set_config('request.jwt.claims', :'max', true);
select is(public.join_room(:'code_a', 'max') ->> 'role', 'spectator', 'with a spectator slot free, max spectates');
reset role;

-- A closed room cannot be joined.
update public.rooms set status = 'closed', closed_at = now() where id = ((:'l3'::jsonb) ->> 'room_id')::uuid;
set local role authenticated;
select set_config('request.jwt.claims', :'ivan', true);
select throws_ok(format($$ select public.join_room(%L, 'ivan') $$, (:'l3'::jsonb) ->> 'code'), 'P0001', 'room_closed',
  'a closed room cannot be joined');
reset role;
select results_eq(
  format($$ select count(*)::int from public.room_members where room_id = %L $$, (:'l3'::jsonb) ->> 'room_id'),
  $$ values (1) $$,
  'the refused join left no member row');

-- ═══ set_ready (7) ════════════════════════════════════════════════════════
set local role authenticated;
select set_config('request.jwt.claims', :'ivan', true);
select throws_ok(format($$ select public.set_ready(%L, null) $$, :'room_a'), '22023', 'invalid_ready', 'ready must not be null');
select lives_ok(format($$ select public.set_ready(%L, true) $$, :'room_a'), 'a player readies up');
select set_config('request.jwt.claims', :'kim', true);
select throws_ok(format($$ select public.set_ready(%L, true) $$, :'room_a'), '42501', 'not_a_player',
  'a spectator cannot ready up');
select set_config('request.jwt.claims', :'lou', true);
select throws_ok(format($$ select public.set_ready(%L, true) $$, :'room_a'), '42501', 'not_a_member',
  'a stranger cannot ready up');
select throws_ok($$ select public.set_ready(gen_random_uuid(), true) $$, 'P0002', 'room_not_found', 'unknown room');
reset role;
select is((select is_ready from public.room_members where room_id = :'room_a' and user_id = :'ivan_id'), true,
  'ivan is ready');
select v as v_before from (select version as v from public.rooms where id = :'room_a') x \gset
set local role authenticated;
select set_config('request.jwt.claims', :'ivan', true);
select public.set_ready(:'room_a', true);
reset role;
select is((select version from public.rooms where id = :'room_a'), :v_before, 'readying again changes nothing');

-- ═══ update_room_settings (11) ════════════════════════════════════════════
set local role authenticated;
select set_config('request.jwt.claims', :'ivan', true);
select throws_ok(format($$ select public.update_room_settings(%L, '{"max_players": 4}') $$, :'room_a'), '42501', 'not_host',
  'only the host changes settings');
select set_config('request.jwt.claims', :'hana', true);
select throws_ok(format($$ select public.update_room_settings(%L, '{"time_limit": 300}') $$, :'room_a'), '22023',
  'invalid_settings', 'unknown keys are refused (no time limit setting in M3)');
select throws_ok(format($$ select public.update_room_settings(%L, '{"max_players": 9}') $$, :'room_a'), '22023',
  'invalid_settings', 'max_players above 8');
select throws_ok(format($$ select public.update_room_settings(%L, '{"max_players": 2}') $$, :'room_a'), '22023',
  'invalid_settings', 'max_players below the current number of players');
select throws_ok(format($$ select public.update_room_settings(%L, '{"voting_s": "60"}') $$, :'room_a'), '22023',
  'invalid_settings', 'a setting must be a number');
select throws_ok(format($$ select public.update_room_settings(%L, '{"reveal_slot_s": 29}') $$, :'room_a'), '22023',
  'invalid_settings', 'reveal_slot_s below 30');
select throws_ok(format($$ select public.update_room_settings(%L, '[]') $$, :'room_a'), '22023',
  'invalid_settings', 'settings must be an object');
select is(public.update_room_settings(:'room_a', '{"max_players": 4, "voting_s": 90}'),
  '{"max_players": 4, "voting_s": 90}'::jsonb, 'the host merges settings');
reset role;
select results_eq(
  format($$ select role::text from public.room_members where room_id = %L and user_id = %L $$, :'room_a', :'kim_id'),
  $$ values ('player') $$,
  'a free player slot promotes the longest-waiting spectator (kim)');
select is((select role::text from public.room_members where room_id = :'room_a' and user_id = :'max_id'), 'spectator',
  'the next spectator keeps waiting');
set local role authenticated;
select set_config('request.jwt.claims', :'hana', true);
select is(public.update_room_settings(:'room_a', '{"voting_s": null}'), '{"max_players": 4}'::jsonb,
  'a null value removes the key');
reset role;

-- ═══ heartbeat (6) ════════════════════════════════════════════════════════
update public.room_members set last_seen_at = now() - interval '3 seconds'
 where room_id = :'room_a' and user_id = :'ivan_id';
select version as v_hb from public.rooms where id = :'room_a' \gset
set local role authenticated;
select set_config('request.jwt.claims', :'ivan', true);
select public.heartbeat(:'room_a') as hb \gset
reset role;
select ok((:'hb'::jsonb) ? 'server_now'
          and ((:'hb'::jsonb) ->> 'room_version')::int = (select version from public.rooms where id = :'room_a')
          and (:'hb'::jsonb) ->> 'host_id' = :'hana_id'
          and (:'hb'::jsonb) ->> 'status' = 'open',
  'heartbeat returns server_now, room_version, host_id and status');
select is((select last_seen_at from public.room_members where room_id = :'room_a' and user_id = :'ivan_id'),
  now() - interval '3 seconds', 'a heartbeat within 5 s of the last one writes nothing (rate limit)');
update public.room_members set last_seen_at = now() - interval '6 seconds'
 where room_id = :'room_a' and user_id = :'ivan_id';
set local role authenticated;
select set_config('request.jwt.claims', :'ivan', true);
select public.heartbeat(:'room_a');
select set_config('request.jwt.claims', :'lou', true);
select throws_ok(format($$ select public.heartbeat(%L) $$, :'room_a'), '42501', 'not_a_member', 'a stranger cannot heartbeat');
select throws_ok($$ select public.heartbeat(gen_random_uuid()) $$, 'P0002', 'room_not_found', 'heartbeat: unknown room');
reset role;
select is((select last_seen_at from public.room_members where room_id = :'room_a' and user_id = :'ivan_id'),
  now(), 'after 5 s, the heartbeat stamps last_seen_at');
select is((select version from public.rooms where id = :'room_a'), :v_hb,
  'heartbeats do not bump the room version (no broadcast)');

-- ═══ get_room_snapshot (6) ════════════════════════════════════════════════
set local role authenticated;
select set_config('request.jwt.claims', :'jo', true);
select public.get_room_snapshot(:'room_a') as snap \gset
select set_config('request.jwt.claims', :'lou', true);
select throws_ok(format($$ select public.get_room_snapshot(%L) $$, :'room_a'), 'P0002', 'room_not_found',
  'a stranger cannot read the room');
reset role;
select is((:'snap'::jsonb) -> 'me',
  jsonb_build_object('user_id', :'jo_id', 'role', 'player', 'state', 'active', 'is_ready', false, 'is_host', false),
  'snapshot: me');
select ok((:'snap'::jsonb) -> 'room' ->> 'code' = :'code_a'
          and (:'snap'::jsonb) -> 'room' ->> 'status' = 'open'
          and ((:'snap'::jsonb) -> 'room' ->> 'max_players')::int = 4
          and ((:'snap'::jsonb) -> 'room' ->> 'max_spectators')::int = 20
          and ((:'snap'::jsonb) -> 'room' ->> 'version')::int = (select version from public.rooms where id = :'room_a'),
  'snapshot: room with code, status, limits and version');
select is(
  (select jsonb_agg(jsonb_build_array(e ->> 'display_name', e ->> 'role', e ->> 'is_host', e ->> 'is_ready'))
   from jsonb_array_elements((:'snap'::jsonb) -> 'members') e),
  '[["Hana", "player", "true", "false"], ["Ivan the Great", "player", "false", "true"],
    ["jo", "player", "false", "false"], ["kim", "player", "false", "false"],
    ["max", "spectator", "false", "false"]]'::jsonb,
  'snapshot: members in join order with role, host and readiness');
select is((:'snap'::jsonb) -> 'battle', 'null'::jsonb, 'snapshot: no battle yet');
select ok(not ((:'snap'::jsonb)::text like '%kicked%'), 'snapshot: no kicked members listed');

-- ═══ kick_member (12) ═════════════════════════════════════════════════════
set local role authenticated;
select set_config('request.jwt.claims', :'ivan', true);
select throws_ok(format($$ select public.kick_member(%L, %L) $$, :'room_a', :'max_id'), '42501', 'not_host',
  'only the host kicks');
select set_config('request.jwt.claims', :'hana', true);
select throws_ok(format($$ select public.kick_member(%L, %L) $$, :'room_a', :'hana_id'), 'P0001', 'cannot_kick_self',
  'the host cannot kick themself');
select throws_ok(format($$ select public.kick_member(%L, %L) $$, :'room_a', :'lou_id'), 'P0002', 'member_not_found',
  'kicking a non-member');
select lives_ok(format($$ select public.kick_member(%L, %L) $$, :'room_a', :'jo_id'), 'the host kicks jo (a player)');
select throws_ok(format($$ select public.kick_member(%L, %L) $$, :'room_a', :'jo_id'), 'P0002', 'member_not_found',
  'kicking twice');
reset role;
select ok((select kicked_at = now() and left_at = now() and not is_ready from public.room_members
           where room_id = :'room_a' and user_id = :'jo_id'),
  'jo is kicked (and counted as gone)');
select is((select role::text from public.room_members where room_id = :'room_a' and user_id = :'max_id'), 'player',
  'the freed player slot promotes max');
set local role authenticated;
select set_config('request.jwt.claims', :'jo', true);
select throws_ok(format($$ select public.join_room(%L, 'jo') $$, :'code_a'), '42501', 'kicked', 'a kicked user cannot rejoin');
select throws_ok(format($$ select public.get_room_snapshot(%L) $$, :'room_a'), 'P0002', 'room_not_found',
  'a kicked user cannot read the room');
select throws_ok(format($$ select public.heartbeat(%L) $$, :'room_a'), '42501', 'kicked', 'a kicked user cannot heartbeat');
select throws_ok(format($$ select public.leave_room(%L) $$, :'room_a'), '42501', 'not_a_member', 'a kicked user cannot leave');
select is_empty(format($$ select 1 from public.rooms where id = %L $$, :'room_a'), 'RLS: a kicked user sees no room row');
reset role;

-- ═══ leave_room and host migration (11) ═══════════════════════════════════
-- hana (host) leaves: ivan joined earliest of the present players.
set local role authenticated;
select set_config('request.jwt.claims', :'hana', true);
select lives_ok(format($$ select public.leave_room(%L) $$, :'room_a'), 'the host leaves');
select lives_ok(format($$ select public.leave_room(%L) $$, :'room_a'), 'leaving twice is a no-op');
select is(public.get_room_snapshot(:'room_a') -> 'me' ->> 'state', 'left', 'a member who left still reads the room');
select throws_ok(format($$ select public.heartbeat(%L) $$, :'room_a'), '42501', 'not_a_member',
  'a member who left cannot heartbeat');
reset role;
select is((select host_id from public.rooms where id = :'room_a'), :'ivan_id'::uuid,
  'the host left: the longest-present player becomes host');
select results_eq(
  format($$ select type, payload ->> 'from', payload ->> 'to', payload ->> 'reason' from public.room_events
            where room_id = %L and type = 'host_changed' $$, :'room_a'),
  format($$ values ('host_changed', %L, %L, 'left') $$, :'hana_id', :'ivan_id'),
  'the host change is logged with its reason');

update public.room_members set joined_at = now() - interval '1 hour' where room_id = :'room_a' and user_id = :'hana_id';
set local role authenticated;
select set_config('request.jwt.claims', :'hana', true);
select is(public.join_room(:'code_a', 'Hana') ->> 'role', 'player', 'hana rejoins as a player (slot free)');
reset role;
select ok((select joined_at = now() and left_at is null from public.room_members
           where room_id = :'room_a' and user_id = :'hana_id'),
  'rejoining resets joined_at: hana is now the newest member');
select is((select host_id from public.rooms where id = :'room_a'), :'ivan_id'::uuid, 'rejoining does not take the host back');

-- noa alone in room B leaves: the room closes.
set local role authenticated;
select set_config('request.jwt.claims', :'noa', true);
select (public.create_room('noa')) ->> 'room_id' as room_b \gset
select public.leave_room(:'room_b');
reset role;
select results_eq(
  format($$ select status::text, closed_at from public.rooms where id = %L $$, :'room_b'),
  $$ select 'closed', now() $$,
  'the last active member leaving an open room closes it');
select is((select type from public.room_events where room_id = :'room_b' order by id desc limit 1), 'closed',
  'the close is logged');

select * from finish();
rollback;
