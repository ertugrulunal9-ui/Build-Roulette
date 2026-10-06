-- Presence rules (T-016, docs/04 §4.8): host migration (lazy in the RPCs and
-- in sweep_deadlines), abandonment (sweep_deadlines), idle close and purge
-- (sweep_ttl). Fixtures are inserted directly; time is simulated by moving
-- last_seen_at / last_activity_at / closed_at into the past.
--
-- Users 13a…0N: 1 hh (host), 2 pp (player), 3 ss (spectator), 4 qq (player),
-- 5 rr, 6 tt.
-- Rooms 13e…0N:
--   1  lobby, lazy host migration through heartbeat
--   2  lobby, nobody present but the silent host → no migration
--   3  in battle (b31, BUILDING), host migration by the sweep
--   4  in battle (b41, BUILDING), everyone silent > 5 min → ABANDONED
--   5  in battle (b51, BUILDING), one player seen 4 min ago → kept
--   6  in battle (b61, RESULTS), everyone silent → kept (RESULTS ends on its own)
--   7  open, idle > 2 h → closed
--   8  open, old activity but a recent heartbeat → kept
--   9  closed 8 days ago (with a finished battle b91) → purged
--   10 closed 6 days ago → kept

begin;
create extension if not exists pgtap with schema extensions;

select plan(44);

\set hh '{"sub":"13a00000-0000-0000-0000-000000000001","role":"authenticated"}'
\set pp '{"sub":"13a00000-0000-0000-0000-000000000002","role":"authenticated"}'
\set ss '{"sub":"13a00000-0000-0000-0000-000000000003","role":"authenticated"}'
\set qq '{"sub":"13a00000-0000-0000-0000-000000000004","role":"authenticated"}'
\set service '{"role":"service_role"}'
\set hh_id '13a00000-0000-0000-0000-000000000001'
\set pp_id '13a00000-0000-0000-0000-000000000002'
\set ss_id '13a00000-0000-0000-0000-000000000003'
\set qq_id '13a00000-0000-0000-0000-000000000004'
\set rr_id '13a00000-0000-0000-0000-000000000005'
\set tt_id '13a00000-0000-0000-0000-000000000006'

insert into auth.users (id, is_anonymous)
select ('13a00000-0000-0000-0000-00000000000' || n)::uuid, true from generate_series(1, 6) n;
insert into public.profiles (id, display_name)
select ('13a00000-0000-0000-0000-00000000000' || n)::uuid, (array['hh', 'pp', 'ss', 'qq', 'rr', 'tt'])[n]
from generate_series(1, 6) n;

insert into public.rooms (id, code, host_id, status, last_activity_at, closed_at)
select ('13e00000-0000-0000-0000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       'PRES' || (array['2', '3', '4', '5', '6', '7', '8', '9', 'A', 'B'])[n],
       '13a00000-0000-0000-0000-000000000001',
       case when n in (9, 10) then 'closed'::public.room_status
            when n in (3, 4, 5, 6) then 'in_battle'
            else 'open' end,
       case when n in (7, 8) then now() - interval '3 hours' else now() end,
       case n when 9 then now() - interval '8 days' when 10 then now() - interval '6 days' end
from generate_series(1, 10) n;

-- Members of rooms 1–6: hh (host), ss (spectator, joined first), pp, qq.
insert into public.room_members (room_id, user_id, role, joined_at)
select ('13e00000-0000-0000-0000-0000000000' || lpad(r::text, 2, '0'))::uuid, u.id, u.role, now() - u.ago
from generate_series(1, 6) r
cross join (values (:'hh_id'::uuid, 'player'::public.member_role, interval '1 hour'),
                   (:'ss_id'::uuid, 'spectator', interval '50 minutes'),
                   (:'pp_id'::uuid, 'player', interval '40 minutes'),
                   (:'qq_id'::uuid, 'player', interval '30 minutes')) u(id, role, ago);
insert into public.room_members (room_id, user_id, role, last_seen_at) values
  ('13e00000-0000-0000-0000-000000000007', :'rr_id', 'player', now() - interval '3 hours'),
  ('13e00000-0000-0000-0000-000000000008', :'rr_id', 'player', now() - interval '1 hour'),
  ('13e00000-0000-0000-0000-000000000009', :'rr_id', 'player', now() - interval '8 days'),
  ('13e00000-0000-0000-0000-000000000010', :'rr_id', 'player', now() - interval '6 days');

-- Battles: b31, b41, b51 in BUILDING, b61 in RESULTS, b91 destroyed (room 9).
insert into public.challenges (id, build_text, rule_text, style_text, time_limit_seconds)
select ('13c00000-0000-0000-0000-0000000000' || k)::uuid, 'b', 'r', 's', 300
from unnest(array['31', '41', '51', '61', '91']) k;
insert into public.battles (id, room_id, challenge_id, host_id, phase, version, settings, phase_ends_at,
                            building_started_at, building_ends_at, shipping_ended_at, is_complete)
select ('13b00000-0000-0000-0000-0000000000' || k)::uuid,
       ('13e00000-0000-0000-0000-0000000000' || lpad(substr(k, 1, 1), 2, '0'))::uuid,
       ('13c00000-0000-0000-0000-0000000000' || k)::uuid,
       :'hh_id',
       case k when '61' then 'results'::public.battle_phase when '91' then 'destroyed' else 'building' end,
       3,
       '{"mode": "multiplayer", "reveal_vote": false}',
       case k when '91' then null else now() + interval '1 minute' end,
       now() - interval '10 minutes', now() - interval '5 minutes',
       case when k in ('61', '91') then now() - interval '5 minutes' end,
       k in ('61', '91')
from unnest(array['31', '41', '51', '61', '91']) k;
update public.rooms set current_battle_id = '13b00000-0000-0000-0000-000000000031' where id = '13e00000-0000-0000-0000-000000000003';
update public.rooms set current_battle_id = '13b00000-0000-0000-0000-000000000041' where id = '13e00000-0000-0000-0000-000000000004';
update public.rooms set current_battle_id = '13b00000-0000-0000-0000-000000000051' where id = '13e00000-0000-0000-0000-000000000005';
update public.rooms set current_battle_id = '13b00000-0000-0000-0000-000000000061' where id = '13e00000-0000-0000-0000-000000000006';
update public.rooms set current_battle_id = '13b00000-0000-0000-0000-000000000091' where id = '13e00000-0000-0000-0000-000000000009';
-- Rosters: hh, pp, qq (not the spectator ss).
insert into public.battle_players (battle_id, user_id, display_name)
select b.id, u.id, p.display_name
from public.battles b
cross join unnest(array[:'hh_id', :'pp_id', :'qq_id']::uuid[]) u(id)
join public.profiles p on p.id = u.id
where b.id::text like '13b00000-%';
insert into public.builds (battle_id, builder_id, status, shipped_at, completion_ms)
select bp.battle_id, bp.user_id,
       case when bp.battle_id in ('13b00000-0000-0000-0000-000000000061', '13b00000-0000-0000-0000-000000000091')
                 or bp.user_id = :'pp_id' then 'shipped'::public.build_status else 'draft' end,
       case when bp.battle_id in ('13b00000-0000-0000-0000-000000000061', '13b00000-0000-0000-0000-000000000091')
                 or bp.user_id = :'pp_id' then now() - interval '6 minutes' end,
       case when bp.battle_id in ('13b00000-0000-0000-0000-000000000061', '13b00000-0000-0000-0000-000000000091')
                 or bp.user_id = :'pp_id' then 240000 end
from public.battle_players bp where bp.battle_id::text like '13b00000-%';

-- ═══ Lazy host migration (room 1) ═════════════════════════════════════════
-- The host is silent for 29 s: still present.
update public.room_members set last_seen_at = now() - interval '29 seconds'
 where room_id = '13e00000-0000-0000-0000-000000000001' and user_id = :'hh_id';
set local role authenticated;
select set_config('request.jwt.claims', :'qq', true);
select is(public.heartbeat('13e00000-0000-0000-0000-000000000001') ->> 'host_id', :'hh_id',
  'a host seen 29 s ago is still present: no migration');
reset role;

update public.room_members set last_seen_at = now() - interval '31 seconds'
 where room_id = '13e00000-0000-0000-0000-000000000001' and user_id = :'hh_id';
set local role authenticated;
select set_config('request.jwt.claims', :'qq', true);
select is(public.heartbeat('13e00000-0000-0000-0000-000000000001') ->> 'host_id', :'pp_id',
  'host silent for 31 s: any heartbeat migrates the host to the longest-present PLAYER (pp, not the earlier spectator)');
select set_config('request.jwt.claims', :'pp', true);
select is(public.get_room_snapshot('13e00000-0000-0000-0000-000000000001') -> 'me' ->> 'is_host', 'true',
  'the snapshot shows the new host');
reset role;
select results_eq(
  $$ select type, payload ->> 'from', payload ->> 'to', payload ->> 'reason', actor_id
     from public.room_events where room_id = '13e00000-0000-0000-0000-000000000001' $$,
  format($$ values ('host_changed', %L, %L, 'absent', %L::uuid) $$, :'hh_id', :'pp_id', :'qq_id'),
  'the migration is logged in room_events with its reason and the nudging member');

-- The old host comes back: they are an ordinary member now.
set local role authenticated;
select set_config('request.jwt.claims', :'hh', true);
select is(public.heartbeat('13e00000-0000-0000-0000-000000000001') ->> 'host_id', :'pp_id',
  'the old host coming back does not take the host back');
select throws_ok($$ select public.update_room_settings('13e00000-0000-0000-0000-000000000001', '{"max_players": 6}') $$,
  '42501', 'not_host', 'the old host lost host powers');
select set_config('request.jwt.claims', :'pp', true);
select lives_ok($$ select public.update_room_settings('13e00000-0000-0000-0000-000000000001', '{"max_players": 6}') $$,
  'the new host has them');
reset role;

-- Spectators are picked when no player is present.
update public.room_members set last_seen_at = now() - interval '1 minute'
 where room_id = '13e00000-0000-0000-0000-000000000001' and user_id <> :'ss_id';
set local role authenticated;
select set_config('request.jwt.claims', :'ss', true);
select is(public.heartbeat('13e00000-0000-0000-0000-000000000001') ->> 'host_id', :'ss_id',
  'with no player present, a present spectator becomes host');
reset role;

-- ═══ No candidate (room 2) ════════════════════════════════════════════════
update public.room_members set last_seen_at = now() - interval '5 minutes'
 where room_id = '13e00000-0000-0000-0000-000000000002';
select ok(
  (select ensured = false from (select private.ensure_host('13e00000-0000-0000-0000-000000000002', null) as ensured) x),
  'nobody present: the host stays');

-- ═══ A host RPC is proof of presence (room 11, created through the RPCs) ══
set local role authenticated;
select set_config('request.jwt.claims', :'qq', true);
select public.create_room('qq') as c11 \gset
select (:'c11'::jsonb) ->> 'room_id' as room_11, (:'c11'::jsonb) ->> 'code' as code_11 \gset
select set_config('request.jwt.claims', :'pp', true);
select public.join_room(:'code_11', 'pp');
reset role;
update public.room_members set last_seen_at = now() - interval '31 seconds'
 where room_id = :'room_11' and user_id = :'qq_id';
set local role authenticated;
select set_config('request.jwt.claims', :'qq', true);
select lives_ok(format($$ select public.update_room_settings(%L, '{"max_players": 5}') $$, :'room_11'),
  'a host whose heartbeat is late can still use host powers: the call itself counts as presence');
reset role;
select results_eq(
  format($$ select r.host_id, m.last_seen_at from public.rooms r
            join public.room_members m on m.room_id = r.id and m.user_id = r.host_id where r.id = %L $$, :'room_11'),
  format($$ values (%L::uuid, now()) $$, :'qq_id'),
  '...the host is unchanged and their last_seen_at refreshed');
select is_empty(format($$ select 1 from public.room_events where room_id = %L and type = 'host_changed' $$, :'room_11'),
  '...and no host change was logged');

-- ═══ Abandonment and host migration in the sweep ══════════════════════════
-- room 3 (b31): host silent 1 min, others present → host migration, battle kept.
update public.room_members set last_seen_at = now() - interval '1 minute'
 where room_id = '13e00000-0000-0000-0000-000000000003' and user_id = :'hh_id';
-- room 4 (b41): everyone silent for 5 min 1 s → abandoned. qq is present but
-- kicked (and the spectator ss is present, but not on the roster): neither counts.
update public.room_members set last_seen_at = now() - interval '301 seconds'
 where room_id = '13e00000-0000-0000-0000-000000000004' and user_id in (:'hh_id', :'pp_id');
update public.room_members set kicked_at = now(), left_at = now()
 where room_id = '13e00000-0000-0000-0000-000000000004' and user_id = :'qq_id';
-- room 5 (b51): pp was seen 4 min ago → kept.
update public.room_members set last_seen_at = now() - interval '301 seconds'
 where room_id = '13e00000-0000-0000-0000-000000000005';
update public.room_members set last_seen_at = now() - interval '240 seconds'
 where room_id = '13e00000-0000-0000-0000-000000000005' and user_id = :'pp_id';
-- room 6 (b61, RESULTS): everyone silent for 3 h, no activity for 3 h → kept
-- (RESULTS ends on its own deadline, and a room in battle is never idle-closed).
update public.room_members set last_seen_at = now() - interval '3 hours'
 where room_id = '13e00000-0000-0000-0000-000000000006';
update public.rooms set last_activity_at = now() - interval '3 hours'
 where id = '13e00000-0000-0000-0000-000000000006';
-- room 2 has no present member either; rooms 7–10 are not in battle.
insert into public.jobs (kind, ref_id)
select 'capture', id from public.builds
where battle_id = '13b00000-0000-0000-0000-000000000041' and status = 'shipped';

set local role service_role;
select set_config('request.jwt.claims', :'service', true);
select is(public.sweep_deadlines(), 1, 'sweep_deadlines: one battle changed (b41 abandoned)');
reset role;

select results_eq(
  $$ select phase::text, is_complete, phase_ends_at, phase_started_at from public.battles
     where id = '13b00000-0000-0000-0000-000000000041' $$,
  $$ select 'abandoned', false, null::timestamptz, now() $$,
  'no roster player seen for 5 min: ABANDONED, incomplete');
select results_eq(
  $$ select version, type, payload ->> 'from', payload ->> 'to', payload ->> 'reason', actor_id
     from public.battle_events where battle_id = '13b00000-0000-0000-0000-000000000041' $$,
  $$ values (4, 'phase', 'building', 'abandoned', 'no_presence', null::uuid) $$,
  'the abandonment is logged with its reason');
select results_eq(
  $$ select bp.display_name, bu.status::text, bu.capture_status::text, bu.final_rank
     from public.builds bu join public.battle_players bp on bp.battle_id = bu.battle_id and bp.user_id = bu.builder_id
     where bu.battle_id = '13b00000-0000-0000-0000-000000000041' order by bp.display_name $$,
  $$ values ('hh', 'draft', 'pending', null::int), ('pp', 'shipped', 'failed', null),
            ('qq', 'draft', 'pending', null) $$,
  'results stay partial: no auto-ship, no ranks; a pending capture can never finish');
select results_eq(
  $$ select j.kind::text, j.status::text from public.jobs j
     where j.ref_id = '13b00000-0000-0000-0000-000000000041'
        or j.ref_id in (select id from public.builds where battle_id = '13b00000-0000-0000-0000-000000000041')
     order by j.kind $$,
  $$ values ('capture', 'failed'), ('destroy', 'queued') $$,
  'the capture job is failed and the destroy job queued');
select results_eq(
  $$ select status::text, current_battle_id from public.rooms where id = '13e00000-0000-0000-0000-000000000004' $$,
  $$ values ('open', '13b00000-0000-0000-0000-000000000041'::uuid) $$,
  'the room of the abandoned battle is open again');
select results_eq(
  $$ select type, payload ->> 'phase' from public.room_events
     where room_id = '13e00000-0000-0000-0000-000000000004' order by id limit 1 $$,
  $$ values ('battle_ended', 'abandoned') $$,
  'room event: battle_ended (abandoned)');

select is((select phase::text from public.battles where id = '13b00000-0000-0000-0000-000000000051'), 'building',
  'a battle with a roster player seen 4 min ago is kept');
select is((select phase::text from public.battles where id = '13b00000-0000-0000-0000-000000000061'), 'results',
  'a battle in RESULTS is never abandoned (its deadline ends it)');

-- room 3: hh is silent during the battle; pp is the longest-present player.
select results_eq(
  $$ select r.host_id, b.host_id from public.rooms r join public.battles b on b.id = r.current_battle_id
     where r.id = '13e00000-0000-0000-0000-000000000003' $$,
  format($$ values (%L::uuid, %L::uuid) $$, :'pp_id', :'pp_id'),
  'the sweep migrated the host of a room in battle, and the battle host followed');
select results_eq(
  $$ select version, type, payload ->> 'host_id', payload ->> 'reason', actor_id from public.battle_events
     where battle_id = '13b00000-0000-0000-0000-000000000031' $$,
  format($$ values (4, 'host_change', %L, 'absent', null::uuid) $$, :'pp_id'),
  'the host change is logged on the battle (version 4) by the system');
select is((select phase::text from public.battles where id = '13b00000-0000-0000-0000-000000000031'), 'building',
  'the battle itself goes on');
select is((select host_id from public.rooms where id = '13e00000-0000-0000-0000-000000000004'), :'ss_id'::uuid,
  'room 4 (now open): the present spectator takes over from the silent host');
select is((select host_id from public.rooms where id = '13e00000-0000-0000-0000-000000000002'), :'hh_id'::uuid,
  'room 2: nobody present, the host stays');

set local role authenticated;
select set_config('request.jwt.claims', :'hh', true);
select throws_ok($$ select public.kick_member('13e00000-0000-0000-0000-000000000003', '13a00000-0000-0000-0000-000000000004') $$,
  '42501', 'not_host', 'the old host lost the kick power during the battle');
select set_config('request.jwt.claims', :'pp', true);
select lives_ok($$ select public.kick_member('13e00000-0000-0000-0000-000000000003', '13a00000-0000-0000-0000-000000000004') $$,
  'the new host kicks during the battle');
reset role;

set local role service_role;
select set_config('request.jwt.claims', :'service', true);
select is(public.sweep_deadlines(), 0, 'a second sweep has nothing left to do');
reset role;

-- ═══ Solo battles are not subject to presence ═════════════════════════════
set local role authenticated;
select set_config('request.jwt.claims', :'qq', true);
select public.start_solo_battle('qq', 300) as solo \gset
reset role;
set local role service_role;
select set_config('request.jwt.claims', :'service', true);
select public.sweep_deadlines();
reset role;
select is((select phase::text from public.battles where id = :'solo'), 'spinning',
  'a solo battle (no room, no heartbeat) is never abandoned for presence');

-- ═══ sweep_ttl: idle close and purge ══════════════════════════════════════
select results_eq(
  $$ select count(*)::int from public.room_events where room_id = '13e00000-0000-0000-0000-000000000009' $$,
  $$ values (0) $$, 'fixture: room 9 has no events');
insert into public.room_events (room_id, version, type) values ('13e00000-0000-0000-0000-000000000009', 1, 'created');

set local role service_role;
select set_config('request.jwt.claims', :'service', true);
select is(public.sweep_ttl(), 0, 'sweep_ttl: no battle is past the 24 h TTL (rooms are not counted)');
reset role;

select results_eq(
  $$ select status::text, closed_at from public.rooms where id = '13e00000-0000-0000-0000-000000000007' $$,
  $$ select 'closed', now() $$,
  'an open room with no activity and no heartbeat for 2 h is closed');
select results_eq(
  $$ select type, payload ->> 'reason', actor_id from public.room_events
     where room_id = '13e00000-0000-0000-0000-000000000007' $$,
  $$ values ('closed', 'idle', null::uuid) $$,
  'the idle close is logged');
select is((select status::text from public.rooms where id = '13e00000-0000-0000-0000-000000000008'), 'open',
  'old activity but a heartbeat within 2 h: kept');
select is((select status::text from public.rooms where id = '13e00000-0000-0000-0000-000000000006'), 'in_battle',
  'a room in battle is never idle-closed');
select is((select status::text from public.rooms where id = '13e00000-0000-0000-0000-000000000001'), 'open',
  'an active room is kept');

select is_empty($$ select 1 from public.rooms where id = '13e00000-0000-0000-0000-000000000009' $$,
  'a room closed 8 days ago is purged');
select is_empty($$ select 1 from public.room_members where room_id = '13e00000-0000-0000-0000-000000000009' $$,
  '...with its members');
select is_empty($$ select 1 from public.room_events where room_id = '13e00000-0000-0000-0000-000000000009' $$,
  '...and its events');
select results_eq(
  $$ select room_id, phase::text, (select count(*)::int from public.builds where battle_id = b.id)
     from public.battles b where id = '13b00000-0000-0000-0000-000000000091' $$,
  $$ values (null::uuid, 'destroyed', 3) $$,
  'its battle keeps its results, with room_id = null');
select is(jsonb_array_length(public.get_public_battle('13b00000-0000-0000-0000-000000000091') -> 'builds'), 3,
  'the permanent results page still works after the purge');
set local role authenticated;
select set_config('request.jwt.claims', :'hh', true);
select ok(public.is_battle_member('13b00000-0000-0000-0000-000000000091'),
  'roster players remain battle members after the purge');
reset role;
select is((select status::text from public.rooms where id = '13e00000-0000-0000-0000-000000000010'), 'closed',
  'a room closed 6 days ago is kept');

select * from finish();
rollback;
