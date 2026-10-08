-- heartbeat(room_id) also answers the room's current battle and its version (T-029):
-- the client's T-023 lost-broadcast check reads them instead of a second request.
--
-- Cast (uuids end in the list number):
--   1 ada  creates the room (host), starts the battle
--   2 bo   joins, plays
--   3 cal  stranger
--   4 dot  joins, is kicked
--   5 eve  joins, leaves
--   6 fin  joins, spectates (not ready)

begin;
create extension if not exists pgtap with schema extensions;

select plan(27);

\set ada '{"sub":"24a00000-0000-0000-0000-000000000001","role":"authenticated"}'
\set bo  '{"sub":"24a00000-0000-0000-0000-000000000002","role":"authenticated"}'
\set cal '{"sub":"24a00000-0000-0000-0000-000000000003","role":"authenticated"}'
\set dot '{"sub":"24a00000-0000-0000-0000-000000000004","role":"authenticated"}'
\set eve '{"sub":"24a00000-0000-0000-0000-000000000005","role":"authenticated"}'
\set fin '{"sub":"24a00000-0000-0000-0000-000000000006","role":"authenticated"}'
\set nobody '{"role":"authenticated"}'
\set ada_id '24a00000-0000-0000-0000-000000000001'
\set bo_id  '24a00000-0000-0000-0000-000000000002'
\set dot_id '24a00000-0000-0000-0000-000000000004'

insert into auth.users (id, is_anonymous)
select ('24a00000-0000-0000-0000-00000000000' || n)::uuid, true from generate_series(1, 6) n;

-- ═══ The function itself ══════════════════════════════════════════════
select ok((select prosecdef from pg_proc where oid = 'public.heartbeat(uuid)'::regprocedure),
  'heartbeat is SECURITY DEFINER');
select is((select proconfig from pg_proc where oid = 'public.heartbeat(uuid)'::regprocedure),
  array['search_path=""'], 'heartbeat pins search_path to empty');
select ok(not has_function_privilege('anon', 'public.heartbeat(uuid)', 'EXECUTE'),
  'anon cannot call heartbeat');
select ok(has_function_privilege('authenticated', 'public.heartbeat(uuid)', 'EXECUTE'),
  'authenticated can call heartbeat');

-- ═══ Lobby: no battle yet ═════════════════════════════════════════════
set local role authenticated;
select set_config('request.jwt.claims', :'ada', true);
select public.create_room('ada') as created \gset
reset role;
select (:'created'::jsonb) ->> 'room_id' as room, (:'created'::jsonb) ->> 'code' as code \gset

set local role authenticated;
select set_config('request.jwt.claims', :'bo', true);
select public.join_room(:'code', 'bo');
select set_config('request.jwt.claims', :'dot', true);
select public.join_room(:'code', 'dot');
select set_config('request.jwt.claims', :'eve', true);
select public.join_room(:'code', 'eve');
select set_config('request.jwt.claims', :'fin', true);
select public.join_room(:'code', 'fin');
select set_config('request.jwt.claims', :'bo', true);
select public.heartbeat(:'room') as hb0 \gset
reset role;

select ok((:'hb0'::jsonb) ? 'server_now'
          and ((:'hb0'::jsonb) ->> 'room_version')::int = (select version from public.rooms where id = :'room')
          and (:'hb0'::jsonb) ->> 'host_id' = :'ada_id'
          and (:'hb0'::jsonb) ->> 'status' = 'open',
  'the T-016 fields are unchanged: server_now, room_version, host_id, status');
select ok((:'hb0'::jsonb) ? 'battle_id' and (:'hb0'::jsonb) ? 'battle_version',
  'the new fields are always present');
select is((:'hb0'::jsonb) -> 'battle_id', 'null'::jsonb, 'no battle yet: battle_id is null');
select is((:'hb0'::jsonb) -> 'battle_version', 'null'::jsonb, 'no battle yet: battle_version is null');

-- ═══ A battle runs ════════════════════════════════════════════════════
set local role authenticated;
select set_config('request.jwt.claims', :'ada', true);
select public.set_ready(:'room', true);
select set_config('request.jwt.claims', :'bo', true);
select public.set_ready(:'room', true);
select set_config('request.jwt.claims', :'ada', true);
select public.start_battle(:'room') as b \gset
select set_config('request.jwt.claims', :'bo', true);
select public.heartbeat(:'room') as hb1 \gset
reset role;

select is((:'hb1'::jsonb) ->> 'battle_id', :'b', 'battle_id is the running battle');
select is(((:'hb1'::jsonb) ->> 'battle_version')::int, (select version from public.battles where id = :'b'),
  'battle_version is the battle''s version');
select is((:'hb1'::jsonb) ->> 'status', 'in_battle', 'the room is in_battle');

-- The battle moves on (SPINNING → BUILDING); the next beat has the new version.
update public.battles set phase_ends_at = now() - interval '1 second' where id = :'b';
select version as v1 from public.battles where id = :'b' \gset
set local role authenticated;
select set_config('request.jwt.claims', :'bo', true);
select is(public.advance_battle(:'b', :v1) ->> 'phase', 'building', 'the battle moves to BUILDING');
select set_config('request.jwt.claims', :'fin', true);
select public.heartbeat(:'room') as hb2 \gset
reset role;
select is(((:'hb2'::jsonb) ->> 'battle_version')::int, :v1 + 1,
  'the next heartbeat reports the new version (a spectator''s too)');

-- The live version, not a copy: whatever bumps battles.version shows up.
update public.battles set version = version + 5 where id = :'b';
set local role authenticated;
select set_config('request.jwt.claims', :'bo', true);
select is((public.heartbeat(:'room') ->> 'battle_version')::int, :v1 + 6,
  'battle_version is read live from the battle row');
reset role;

select version as room_v, (select version from public.battles where id = :'b') as battle_v
  from public.rooms where id = :'room' \gset
set local role authenticated;
select set_config('request.jwt.claims', :'ada', true);
select public.heartbeat(:'room');
reset role;
select is((select version from public.rooms where id = :'room'), :room_v,
  'a heartbeat does not bump the room version');
select is((select version from public.battles where id = :'b'), :battle_v,
  'a heartbeat does not bump the battle version');

-- ═══ Members only, the same errors ════════════════════════════════════
set local role authenticated;
select set_config('request.jwt.claims', :'nobody', true);
select throws_ok(format($$ select public.heartbeat(%L) $$, :'room'), '42501', 'not_authenticated',
  'not signed in: not_authenticated');
select set_config('request.jwt.claims', :'cal', true);
select throws_ok(format($$ select public.heartbeat(%L) $$, :'room'), '42501', 'not_a_member',
  'a stranger learns nothing about the battle (not_a_member)');
select throws_ok($$ select public.heartbeat(gen_random_uuid()) $$, 'P0002', 'room_not_found',
  'unknown room: room_not_found');
select set_config('request.jwt.claims', :'ada', true);
select public.kick_member(:'room', :'dot_id');
select set_config('request.jwt.claims', :'dot', true);
select throws_ok(format($$ select public.heartbeat(%L) $$, :'room'), '42501', 'kicked',
  'a kicked member: kicked');
select set_config('request.jwt.claims', :'eve', true);
select public.leave_room(:'room');
select throws_ok(format($$ select public.heartbeat(%L) $$, :'room'), '42501', 'not_a_member',
  'a member who left: not_a_member');
reset role;

-- ═══ Back in the lobby: the last battle stays the current one ═════════
update public.battles set phase = 'destroyed', phase_ends_at = null where id = :'b';
update public.rooms set status = 'open' where id = :'room';
set local role authenticated;
select set_config('request.jwt.claims', :'bo', true);
select public.heartbeat(:'room') as hb3 \gset
reset role;
select is((:'hb3'::jsonb) ->> 'battle_id', :'b', 'after the battle: battle_id is the last battle');
select is(((:'hb3'::jsonb) ->> 'battle_version')::int, (select version from public.battles where id = :'b'),
  'after the battle: its final version');

-- ═══ Lazy host migration still works (the other branch) ═══════════════
update public.room_members set last_seen_at = now() - interval '31 seconds'
 where room_id = :'room' and user_id = :'ada_id';
set local role authenticated;
select set_config('request.jwt.claims', :'bo', true);
select public.heartbeat(:'room') as hb4 \gset
reset role;
select is((:'hb4'::jsonb) ->> 'host_id', :'bo_id', 'a silent host is migrated by a heartbeat');
select is((:'hb4'::jsonb) ->> 'battle_id', :'b', 'and that answer has the battle too');
select is(((:'hb4'::jsonb) ->> 'battle_version')::int, (select version from public.battles where id = :'b'),
  'with its version');

-- ═══ Closed room ══════════════════════════════════════════════════════
update public.rooms set status = 'closed' where id = :'room';
set local role authenticated;
select set_config('request.jwt.claims', :'bo', true);
select throws_ok(format($$ select public.heartbeat(%L) $$, :'room'), 'P0001', 'room_closed',
  'a closed room: room_closed');
reset role;

select * from finish();
rollback;
