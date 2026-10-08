-- Build Roulette (T-029, M5): heartbeat also returns the room's current battle and its
-- version.
--
-- Why: the T-023 lost-broadcast check (docs/04 §4.10) made every client read
-- `battles.version` through PostgREST next to each heartbeat, i.e. two requests every
-- 10 s per connected player (the load test, docs/07 §7.3: 5.96 heartbeats + 5.60 version
-- reads per client-minute). The heartbeat already holds the room row, so it can answer
-- the version itself and the second request goes away.
--
-- ─── Contract ─────────────────────────────────────────────────────────────
-- heartbeat(room_id) → {server_now, room_version, host_id, status,      (unchanged)
--                       battle_id, battle_version}                     (new, additive)
--   * battle_id: rooms.current_battle_id (the running battle, or the last one once the
--     room is back in the lobby), null when the room never had a battle.
--   * battle_version: that battle's battles.version, null with battle_id.
--   Old clients ignore the two fields. Callers are unchanged: still members only (a
--   stranger gets not_a_member, a kicked member kicked, a member who left not_a_member),
--   the same errors (not_authenticated, room_not_found, room_closed), the same rate-limited
--   last_seen_at stamp and the same lazy host migration. The battle row is read without a
--   lock (a version is a hint: a newer one makes the client refetch the snapshot).
--
-- Replaced (same signature, same grants, restated below): public.heartbeat(uuid), T-016's
-- version with only the two fields added.

create or replace function public.heartbeat(p_room_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := private.require_auth();
  m         public.room_members;
  r         public.rooms;
  h         public.room_members;
  v_version int;
begin
  select * into r from public.rooms where id = p_room_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'room_not_found',
      detail = 'No such room.';
  end if;
  m := private.require_active_member(p_room_id, v_uid);
  if r.status = 'closed' then
    raise exception using errcode = 'P0001', message = 'room_closed',
      detail = 'This room is closed.';
  end if;

  select * into h from public.room_members where room_id = p_room_id and user_id = r.host_id;
  if not private.is_present(h) and r.host_id <> v_uid then
    -- Lock order: battle, room, then member rows.
    r := private.lock_room_for(p_room_id);
    update public.room_members set last_seen_at = now()
     where room_id = p_room_id and user_id = v_uid;
    perform private.ensure_host(p_room_id, v_uid);
    select * into r from public.rooms where id = p_room_id;
  elsif m.last_seen_at < now() - private.room_limit_interval('heartbeat_min_interval_s') then
    update public.room_members set last_seen_at = now()
     where room_id = p_room_id and user_id = v_uid;
  end if;

  if r.current_battle_id is not null then
    select version into v_version from public.battles where id = r.current_battle_id;
  end if;

  return jsonb_build_object(
    'server_now', clock_timestamp(),
    'room_version', r.version,
    'host_id', r.host_id,
    'status', r.status,
    'battle_id', r.current_battle_id,
    'battle_version', v_version);
end;
$$;

revoke all on function public.heartbeat(uuid) from public, anon;
grant execute on function public.heartbeat(uuid) to authenticated;
