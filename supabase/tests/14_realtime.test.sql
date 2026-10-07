-- Realtime (T-016): the broadcast triggers (one realtime.messages row per
-- battle/room version, small allow-listed payloads, private topics) and who
-- may receive or send on a topic (RLS on realtime.messages).
-- Needs the stack's Realtime service (it creates realtime.messages and its
-- daily partitions).
--
-- Cast: 1 ava (host), 2 bo (player), 3 cal (late spectator), 4 dot (kicked
-- player), 5 eve (left the room), 6 sol (stranger).

begin;
create extension if not exists pgtap with schema extensions;

select plan(51);

\set ava '{"sub":"14a00000-0000-0000-0000-000000000001","role":"authenticated"}'
\set bo  '{"sub":"14a00000-0000-0000-0000-000000000002","role":"authenticated"}'
\set cal '{"sub":"14a00000-0000-0000-0000-000000000003","role":"authenticated"}'
\set dot '{"sub":"14a00000-0000-0000-0000-000000000004","role":"authenticated"}'
\set eve '{"sub":"14a00000-0000-0000-0000-000000000005","role":"authenticated"}'
\set sol '{"sub":"14a00000-0000-0000-0000-000000000006","role":"authenticated"}'
\set service '{"role":"service_role"}'
\set ava_id '14a00000-0000-0000-0000-000000000001'
\set bo_id  '14a00000-0000-0000-0000-000000000002'
\set cal_id '14a00000-0000-0000-0000-000000000003'
\set dot_id '14a00000-0000-0000-0000-000000000004'
\set eve_id '14a00000-0000-0000-0000-000000000005'

insert into auth.users (id, is_anonymous)
select ('14a00000-0000-0000-0000-00000000000' || n)::uuid, true from generate_series(1, 6) n;
insert into public.profiles (id, display_name) values ('14a00000-0000-0000-0000-000000000006', 'sol');

-- ─── A short battle through the RPCs ──────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', :'ava', true);
select public.create_room('ava') as created \gset
reset role;
select (:'created'::jsonb) ->> 'room_id' as room, (:'created'::jsonb) ->> 'code' as code \gset
\set room_topic 'room:' :room

set local role authenticated;
select set_config('request.jwt.claims', :'bo', true);
select public.join_room(:'code', 'bo');
select public.set_ready(:'room', true);
select set_config('request.jwt.claims', :'dot', true);
select public.join_room(:'code', 'dot');
select public.set_ready(:'room', true);
select set_config('request.jwt.claims', :'eve', true);
select public.join_room(:'code', 'eve');
select set_config('request.jwt.claims', :'ava', true);
select public.set_ready(:'room', true);
select public.update_room_settings(:'room', '{"voting_s": 45}');
select public.start_battle(:'room') as battle \gset
reset role;
\set battle_topic 'battle:' :battle

set local role authenticated;
select set_config('request.jwt.claims', :'cal', true);
select public.join_room(:'code', 'cal');
select set_config('request.jwt.claims', :'eve', true);
select public.leave_room(:'room');
reset role;
update public.battles set phase_ends_at = now() - interval '1 second' where id = :'battle';
set local role authenticated;
select set_config('request.jwt.claims', :'ava', true);
select public.advance_battle(:'battle', 1);
select public.kick_member(:'room', :'dot_id');
reset role;
insert into storage.objects (bucket_id, name) values
  ('ephemeral-builds', :'battle' || '/' || :'ava_id' || '/source.json'),
  ('ephemeral-builds', :'battle' || '/' || :'ava_id' || '/bundle.js'),
  ('ephemeral-builds', :'battle' || '/' || :'bo_id' || '/source.json'),
  ('ephemeral-builds', :'battle' || '/' || :'bo_id' || '/bundle.js');
set local role authenticated;
select set_config('request.jwt.claims', :'ava', true);
select public.ship_build(:'battle', 'Alpha', '{"files": 3, "lines": 99}');
select set_config('request.jwt.claims', :'bo', true);
select public.ship_build(:'battle', 'Bravo', '{}');
reset role;
set local role service_role;
select set_config('request.jwt.claims', :'service', true);
select public.complete_capture(bu.id, 'captured', :'battle' || '/' || bu.id || '.webp')
from public.builds bu where bu.battle_id = :'battle' and bu.builder_id = :'ava_id';
reset role;

create temp view msgs as
select topic, event, private, extension, payload, (payload ->> 'version')::int as version
from realtime.messages
where topic in (:'room_topic', :'battle_topic');

-- ─── Battle topic: one message per version ────────────────────────────
select is(
  (select array_agg(version order by version) from msgs where topic = :'battle_topic'),
  (select array_agg(version order by version) from public.battle_events where battle_id = :'battle'),
  'battle topic: exactly one message per battle_events version');
select is(
  (select array_agg(version order by version) from msgs where topic = :'battle_topic'),
  (select array_agg(n) from generate_series(1, (select version from public.battles where id = :'battle')) n),
  'battle topic: versions 1..current, gap-free');
select is(
  (select string_agg(coalesce(payload ->> 'phase', payload ->> 'status', event), ' ' order by version)
   from msgs where topic = :'battle_topic'),
  'spinning building kicked shipped shipped shipping reveal capture',
  'battle topic: spinning, building, the kick, two ships, early SHIPPING and REVEAL (2 final builds), the capture');
select is(
  (select payload - 'id' from msgs where topic = :'battle_topic' and payload ->> 'phase' = 'reveal'),
  (select jsonb_build_object('type', 'phase', 'version', 7, 'phase', 'reveal',
                             'phase_started_at', b.phase_started_at,
                             'phase_ends_at', b.phase_ends_at, 'reveal_index', 0)
   from public.battles b where b.id = :'battle'),
  'phase REVEAL: the payload carries reveal_index');
select ok((select bool_and(event = payload ->> 'type') from msgs), 'the event name is the payload type');
select ok((select bool_and(private) from msgs), 'every message is for private channels only');
select ok((select bool_and(extension = 'broadcast') from msgs), 'every message is a broadcast');
select is(
  (select payload - 'id' from msgs where topic = :'battle_topic' and version = 2),
  (select jsonb_build_object('type', 'phase', 'version', 2, 'phase', 'building',
                             'phase_started_at', b.building_started_at,
                             'phase_ends_at', b.building_ends_at)
   from public.battles b where b.id = :'battle'),
  'phase: {type, version, phase, phase_started_at, phase_ends_at}');
select is(
  (select payload - 'id' from msgs where topic = :'battle_topic' and event = 'player'),
  jsonb_build_object('type', 'player', 'version', 3, 'user_id', :'dot_id', 'status', 'kicked',
                     'build_status', 'disqualified'),
  'player: the kick, with the disqualified build');

-- ─── Battle payloads ──────────────────────────────────────────────────
select is(
  (select payload - 'id' from msgs where topic = :'battle_topic' and event = 'build' and payload ->> 'name' = 'Alpha'),
  (select jsonb_build_object('type', 'build', 'version', 4, 'build_id', bu.id, 'user_id', :'ava_id',
                             'status', 'shipped', 'name', 'Alpha', 'completion_ms', bu.completion_ms)
   from public.builds bu where bu.battle_id = :'battle' and bu.builder_id = :'ava_id'),
  'build: id, builder, status, name and completion time; no stats');
select is(
  (select payload - 'id' from msgs where topic = :'battle_topic' and event = 'capture'),
  (select jsonb_build_object('type', 'capture', 'version', 8, 'build_id', bu.id, 'capture_status', 'captured')
   from public.builds bu where bu.battle_id = :'battle' and bu.builder_id = :'ava_id'),
  'capture: build and status only (no screenshot path)');
select is_empty(
  $$ select 1 from msgs
     where payload::text ~ '(source\.json|bundle\.js|autosave|ephemeral|screenshot|stats|"lines"|vote|last_seen)' $$,
  'no payload carries storage paths, stats, votes or presence timestamps');
select is_empty(
  format($$ select 1 from msgs where payload::text like '%%%s%%' $$, :'code'),
  'no payload carries the room code');

-- ─── Room topic ───────────────────────────────────────────────────────
select is(
  (select array_agg(version order by version) from msgs where topic = :'room_topic'),
  (select array_agg(n) from generate_series(1, (select version from public.rooms where id = :'room')) n),
  'room topic: versions 1..current, gap-free (one message per room_events row)');
select is(
  (select payload - 'id' from msgs where topic = :'room_topic' and version = 1),
  jsonb_build_object('type', 'room', 'version', 1, 'change', 'created', 'status', 'open',
                     'host_id', :'ava_id', 'settings', '{"max_players": 8}'::jsonb, 'current_battle_id', null),
  'room: {change, status, host_id, settings, current_battle_id}');
select is(
  (select payload - 'id' from msgs where topic = :'room_topic' and version = 2),
  jsonb_build_object('type', 'member', 'version', 2, 'change', 'member_joined', 'user_id', :'bo_id',
                     'display_name', 'bo', 'role', 'player', 'is_ready', false, 'state', 'active'),
  'member: {change, user_id, display_name, role, is_ready, state}');
select is(
  (select payload ->> 'settings' from msgs where topic = :'room_topic' and payload ->> 'change' = 'settings'),
  '{"voting_s": 45, "max_players": 8}',
  'room: the settings change carries the new settings');
select is(
  (select string_agg(payload ->> 'change', ' ' order by version) from msgs
   where topic = :'room_topic' and version > (select version from msgs where topic = :'room_topic'
                                              and payload ->> 'change' = 'settings')),
  'battle_started member_ready member_ready member_ready member_joined member_left member_kicked',
  'room: battle start (with the ready resets), the late joiner, a leave, the kick');
select is(
  (select payload ->> 'role' from msgs where topic = :'room_topic' and payload ->> 'user_id' = :'cal_id'),
  'spectator', 'member: the late joiner arrives as a spectator');
select is(
  (select payload ->> 'state' from msgs where topic = :'room_topic' and payload ->> 'change' = 'member_kicked'),
  'kicked', 'member: the kicked state');

-- ─── Unknown event types still keep the sequence ──────────────────────
select is(
  private.battle_broadcast(row(0, :'battle', 42, 'mystery', null, '{"secret": 1}', now())::public.battle_events),
  '{"type": "sync", "version": 42}'::jsonb,
  'an unknown battle event becomes {type: sync, version} (payload dropped)');
select is(
  private.room_broadcast(row(0, :'room', 42, 'mystery', null, '{"secret": 1}', now())::public.room_events),
  '{"type": "sync", "version": 42}'::jsonb,
  'an unknown room event becomes {type: sync, version}');

-- ─── can_use_realtime_topic ──────────────────────────────────────────
-- (topic, send) per user: who may receive (send = false) or track presence (true).
create temp table topic_cases (who text, claims text, topic text, send boolean, expected boolean) on commit drop;
insert into topic_cases values
  ('ava (host, roster)',   :'ava', :'room_topic',   false, true),
  ('ava',                  :'ava', :'battle_topic', true,  true),
  ('cal (late spectator)', :'cal', :'battle_topic', false, true),
  ('cal',                  :'cal', :'battle_topic', true,  true),
  ('eve (left the room)',  :'eve', :'room_topic',   false, true),
  ('eve',                  :'eve', :'room_topic',   true,  false),
  ('eve',                  :'eve', :'battle_topic', true,  false),
  ('dot (kicked roster)',  :'dot', :'room_topic',   false, false),
  ('dot',                  :'dot', :'battle_topic', false, false),
  ('sol (stranger)',       :'sol', :'room_topic',   false, false),
  ('sol',                  :'sol', :'battle_topic', false, false),
  ('ava, malformed topic', :'ava', 'room:' || upper(:'room'), false, false),
  ('ava, other prefix',    :'ava', 'lobby:' || :'room', false, false);
grant select on topic_cases to authenticated;

create function pg_temp.topic_ok(p_claims text, p_topic text, p_send boolean) returns boolean
language plpgsql as $$
declare v boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', p_claims, true);
  v := public.can_use_realtime_topic(p_topic, p_send);
  reset role;
  return v;
end $$;

select is(pg_temp.topic_ok(claims, topic, send), expected,
  format('%s: %s %s', who, case when send then 'track presence on' else 'receive' end, split_part(topic, ':', 1)))
from topic_cases;

-- ─── RLS on realtime.messages, as Realtime evaluates it ──────────────
-- Realtime sets realtime.topic for the channel and runs the check as the
-- user: SELECT decides who receives, INSERT who may send.
create function pg_temp.can_read(p_claims text, p_topic text) returns int
language plpgsql as $$
declare v int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', p_claims, true);
  perform set_config('realtime.topic', p_topic, true);
  select count(*) into v from realtime.messages where extension = 'broadcast';
  perform set_config('realtime.topic', '', true);
  reset role;
  return v;
end $$;

create function pg_temp.try_send(p_claims text, p_topic text, p_extension text, p_row_topic text default null)
returns text
language plpgsql as $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', p_claims, true);
  perform set_config('realtime.topic', p_topic, true);
  insert into realtime.messages (topic, extension, event, payload, private)
  values (coalesce(p_row_topic, p_topic), p_extension, 'x', '{}', true);
  perform set_config('realtime.topic', '', true);
  reset role;
  return 'allowed';
exception when insufficient_privilege then
  reset role;
  return 'denied';
end $$;

select is(pg_temp.can_read(:'ava', :'room_topic'),
  (select count(*)::int from msgs where topic = :'room_topic'),
  'member: reads every broadcast of the room topic');
select is(pg_temp.can_read(:'ava', :'battle_topic'),
  (select count(*)::int from msgs where topic = :'battle_topic'),
  'roster player: reads every broadcast of the battle topic, and only that topic''s rows');
select is(pg_temp.can_read(:'cal', :'battle_topic'),
  (select count(*)::int from msgs where topic = :'battle_topic'),
  'late spectator: reads the battle topic');
select is(pg_temp.can_read(:'eve', :'room_topic'),
  (select count(*)::int from msgs where topic = :'room_topic'),
  'member who left: still reads the room topic');
select is(pg_temp.can_read(:'dot', :'room_topic'), 0, 'kicked: reads nothing on the room topic');
select is(pg_temp.can_read(:'dot', :'battle_topic'), 0, 'kicked roster player: reads nothing on the battle topic');
select is(pg_temp.can_read(:'sol', :'battle_topic'), 0, 'stranger: reads nothing');
select is(pg_temp.can_read(:'sol', ''), 0, 'no topic set: reads nothing');

select is(pg_temp.try_send(:'ava', :'room_topic', 'presence'), 'allowed', 'member: may track presence on the room');
select is(pg_temp.try_send(:'cal', :'battle_topic', 'presence'), 'allowed', 'spectator: may track presence on the battle');
select is(pg_temp.try_send(:'ava', :'room_topic', 'broadcast'), 'denied', 'member: may NOT broadcast (server-only)');
select is(pg_temp.try_send(:'ava', :'battle_topic', 'broadcast'), 'denied', 'roster player: may NOT broadcast');
select is(pg_temp.try_send(:'eve', :'room_topic', 'presence'), 'denied', 'member who left: no presence');
select is(pg_temp.try_send(:'dot', :'battle_topic', 'presence'), 'denied', 'kicked: no presence');
select is(pg_temp.try_send(:'sol', :'room_topic', 'presence'), 'denied', 'stranger: no presence');
select is(pg_temp.try_send(:'ava', :'room_topic', 'presence', 'room:' || gen_random_uuid()), 'denied',
  'a row for another topic than the channel''s is refused');

select * from finish();
rollback;
