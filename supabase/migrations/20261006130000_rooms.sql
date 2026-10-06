-- Build Roulette (T-016, M3): rooms, members and the lobby RPCs.
--
-- Client RPCs (authenticated):
--   create_room(display_name)                 → {room_id, code}
--   join_room(code, display_name)             → {room_id, code, role}
--   leave_room(room_id)                       → void
--   set_ready(room_id, ready)                 → void
--   update_room_settings(room_id, settings)   → jsonb (the new settings)
--   kick_member(room_id, user_id)             → void
--   heartbeat(room_id)                        → {server_now, room_version, host_id, status}
--   get_room_snapshot(room_id)                → jsonb
-- start_battle and the multiplayer state machine are in the next migration;
-- the sweeps (host migration, abandonment, idle close, purge) in the one after.
--
-- ─── Rules (docs/04 §4.2, §4.4, §4.8) ─────────────────────────────────────
-- * A room has at most 8 players (settings.max_players, 2–8) and 20
--   spectators. A member is `active` (left_at and kicked_at null), `left`
--   (can rejoin) or `kicked` (cannot rejoin, loses all live access).
-- * Joining an open room makes you a player while a player slot is free,
--   otherwise a spectator. Joining while a battle runs makes you a spectator
--   (late joiner), except for a roster player coming back. When the room
--   reopens, and whenever a player slot frees up in an open room, the
--   longest-waiting spectators are promoted to players.
-- * Presence: clients call heartbeat(room_id) every ~10 s. A member is
--   `present` when active and last_seen_at is at most 30 s old. Writes are
--   rate-limited to one per 5 s per member (extra calls are cheap no-ops).
-- * Host migration: when the host is not present (left, kicked, or silent for
--   30 s), the present member who joined earliest (players before
--   spectators) becomes host. Done lazily by the room RPCs and by the
--   sweep. It is logged in room_events and, during a battle, in
--   battle_events (and battles.host_id follows the room host).
-- * The last active member leaving an open room closes it.
-- * Every room change bumps rooms.version and appends to room_events (one
--   row per version). The Realtime migration broadcasts each row on the
--   private topic room:{room_id}.
--
-- ─── Lock order ───────────────────────────────────────────────────────────
-- Battle row first, then room row, then room_members rows. The battle code
-- (advance, ship, captures, sweeps) locks the battle and only then touches
-- the room, so the room RPCs take the current battle's lock first too:
-- private.lock_room() does it.
--
-- ─── Errors (same contract as docs/05 §5.7) ───────────────────────────────
--   42501  not_authenticated, not_a_member, not_host, kicked, not_a_player
--   P0002  room_not_found, member_not_found
--   22023  invalid_display_name, invalid_settings, invalid_ready
--   P0001  room_closed, room_full, wrong_room_state, cannot_kick_self,
--          too_many_rooms, room_busy

-- ─── Schema additions ─────────────────────────────────────────────────────
alter table public.rooms
  add column version int not null default 0;

-- Append-only log of room changes, one row per rooms.version (the room-level
-- twin of battle_events). Service role only, like battle_events; purged with
-- the room.
create table public.room_events (
  id         bigint generated always as identity primary key,
  room_id    uuid not null references public.rooms (id) on delete cascade,
  version    int not null,
  type       text not null,   -- created, member_joined, member_left, member_ready,
                              -- member_kicked, member_promoted, member_updated,
                              -- settings, host_changed, battle_started,
                              -- battle_ended, closed
  actor_id   uuid,            -- null = system / sweep
  payload    jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index room_events_room_idx on public.room_events (room_id, id);
alter table public.room_events enable row level security;
revoke all on public.room_events from anon, authenticated;
grant all on public.room_events to service_role;

-- "Rooms I am in", the FK check from profiles, and the sweeps.
create index room_members_user_idx on public.room_members (user_id);
create index rooms_host_idx on public.rooms (host_id) where status <> 'closed';
create index rooms_status_activity_idx on public.rooms (status, last_activity_at);

-- ─── Constants ────────────────────────────────────────────────────────────
-- Shared with @br/game later (T-017 can add a drift test like the one for
-- default_battle_settings). Keep it a flat jsonb_build_object literal.
create function private.room_limits()
returns jsonb
language sql
immutable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'max_players', 8,
    'min_players', 2,
    'max_spectators', 20,
    'present_s', 30,
    'heartbeat_min_interval_s', 5,
    'abandon_s', 300,
    'idle_close_s', 7200,
    'purge_closed_s', 604800,
    'max_hosted_rooms', 3
  )
$$;

create function private.room_limit(p_key text)
returns int
language sql
immutable
security definer
set search_path = ''
as $$
  select (private.room_limits() ->> p_key)::int
$$;

create function private.room_limit_interval(p_key text)
returns interval
language sql
immutable
security definer
set search_path = ''
as $$
  select make_interval(secs => private.room_limit(p_key))
$$;

create function private.room_max_players(p_settings jsonb)
returns int
language sql
immutable
security definer
set search_path = ''
as $$
  select least(greatest(coalesce((p_settings ->> 'max_players')::int, private.room_limit('max_players')),
                        private.room_limit('min_players')),
               private.room_limit('max_players'))
$$;

-- ─── Helpers ──────────────────────────────────────────────────────────────

-- 5 characters from the 32-letter alphabet of the rooms.code check (no I, O,
-- 0, 1). 256 is a multiple of 32, so every character is uniform.
create function private.new_room_code()
returns text
language sql
volatile
security definer
set search_path = ''
as $$
  select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', get_byte(x.b, i) % 32 + 1, 1), '' order by i)
  from (select extensions.gen_random_bytes(5) as b) x
  cross join generate_series(0, 4) as i
$$;

-- Same rule as start_solo_battle: 1–24 characters, no control characters.
create function private.check_display_name(p_name text)
returns text
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  v_name text := btrim(p_name);
begin
  if v_name is null or char_length(v_name) not between 1 and 24 or v_name ~ '[[:cntrl:]]' then
    raise exception using errcode = '22023', message = 'invalid_display_name',
      detail = 'The display name must be 1 to 24 characters.';
  end if;
  return v_name;
end;
$$;

-- Bumps rooms.version of a room whose row the caller has locked, stamps
-- last_activity_at and appends the matching room_events row. Returns the new
-- version.
create function private.room_bump(p_room_id uuid, p_type text, p_actor uuid, p_payload jsonb)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version int;
begin
  update public.rooms
     set version = version + 1,
         last_activity_at = now()
   where id = p_room_id
  returning version into v_version;

  insert into public.room_events (room_id, version, type, actor_id, payload)
  values (p_room_id, v_version, p_type, p_actor, coalesce(p_payload, '{}'::jsonb));

  return v_version;
end;
$$;

-- Locks a room in the global lock order: the running battle (if the room is
-- in_battle) first, then the room row. Returns the locked row, or an all-null
-- row when the room does not exist (or, with p_skip_locked, when a lock is
-- held by someone else: the sweeps skip such rooms and retry later).
-- An open room's current battle is terminal and nothing touches it from the
-- room side, so it is not locked.
create function private.lock_room(p_room_id uuid, p_skip_locked boolean default false)
returns public.rooms
language plpgsql
security definer
set search_path = ''
as $$
declare
  r        public.rooms;
  v_status public.room_status;
  v_battle uuid;
  v_try    int := 0;
begin
  loop
    v_try := v_try + 1;
    select status, current_battle_id into v_status, v_battle
    from public.rooms where id = p_room_id;
    if not found then
      return null;
    end if;

    if v_status = 'in_battle' and v_battle is not null then
      if p_skip_locked then
        perform 1 from public.battles where id = v_battle for update skip locked;
        if not found then
          return null;
        end if;
      else
        perform 1 from public.battles where id = v_battle for update;
      end if;
    end if;

    if p_skip_locked then
      select * into r from public.rooms where id = p_room_id for update skip locked;
    else
      select * into r from public.rooms where id = p_room_id for update;
    end if;
    if not found then
      return null;
    end if;

    -- The room may have started or ended a battle between the two reads.
    exit when r.status <> 'in_battle'
           or (v_status = 'in_battle' and r.current_battle_id is not distinct from v_battle);
    if v_try >= 3 then
      raise exception using errcode = 'P0001', message = 'room_busy',
        detail = 'The room changed while it was being locked. Try again.';
    end if;
  end loop;
  return r;
end;
$$;

-- True when the member row is present: active and seen within present_s.
create function private.is_present(p_member public.room_members)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_member.user_id is not null
     and p_member.left_at is null
     and p_member.kicked_at is null
     and p_member.last_seen_at >= now() - private.room_limit_interval('present_s')
$$;

-- Host migration (docs/04 §4.8). The caller holds private.lock_room().
-- If the host is not present, the present member who joined earliest
-- becomes host (players before spectators). Returns true when the host
-- changed. During a battle the battle's host_id follows, and the change is
-- logged in battle_events too (host powers such as kick move with it).
create function private.ensure_host(p_room_id uuid, p_actor uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  r       public.rooms;
  h       public.room_members;
  v_new   uuid;
  v_why   text;
  v_phase public.battle_phase;
begin
  select * into r from public.rooms where id = p_room_id;
  if not found or r.status = 'closed' then
    return false;
  end if;

  select * into h from public.room_members where room_id = p_room_id and user_id = r.host_id;
  if private.is_present(h) then
    return false;
  end if;

  select m.user_id into v_new
  from public.room_members m
  where m.room_id = p_room_id
    and m.user_id <> r.host_id
    and private.is_present(m)
  order by (m.role = 'player') desc, m.joined_at, m.user_id
  limit 1;
  if v_new is null then
    return false;   -- nobody to hand over to; the sweep or the next RPC retries
  end if;

  v_why := case when h.user_id is null then 'missing'
                when h.kicked_at is not null then 'kicked'
                when h.left_at is not null then 'left'
                else 'absent' end;

  update public.rooms set host_id = v_new where id = p_room_id;
  perform private.room_bump(p_room_id, 'host_changed', p_actor,
    jsonb_build_object('from', r.host_id, 'to', v_new, 'reason', v_why));

  if r.status = 'in_battle' and r.current_battle_id is not null then
    select phase into v_phase from public.battles where id = r.current_battle_id;
    if v_phase not in ('destroyed', 'abandoned') then
      update public.battles set host_id = v_new where id = r.current_battle_id;
      perform private.bump(r.current_battle_id, 'host_change', p_actor,
        jsonb_build_object('from', r.host_id, 'host_id', v_new, 'reason', v_why));
    end if;
  end if;
  return true;
end;
$$;

-- Promotes the longest-waiting active spectators of an OPEN room to players
-- while player slots are free. The caller holds private.lock_room().
create function private.fill_player_slots(p_room_id uuid, p_actor uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  r        public.rooms;
  v_free   int;
  v_user   uuid;
  v_count  int := 0;
begin
  select * into r from public.rooms where id = p_room_id;
  if not found or r.status <> 'open' then
    return 0;
  end if;

  select private.room_max_players(r.settings) - count(*)::int into v_free
  from public.room_members m
  where m.room_id = p_room_id and m.role = 'player' and m.left_at is null and m.kicked_at is null;

  for v_user in
    select m.user_id from public.room_members m
    where m.room_id = p_room_id and m.role = 'spectator' and m.left_at is null and m.kicked_at is null
    order by m.joined_at, m.user_id
    limit greatest(v_free, 0)
  loop
    update public.room_members set role = 'player', is_ready = false
     where room_id = p_room_id and user_id = v_user;
    perform private.room_bump(p_room_id, 'member_promoted', p_actor, jsonb_build_object('user_id', v_user));
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- The caller's member row, which must be active. Used by the member RPCs.
create function private.require_active_member(p_room_id uuid, p_uid uuid)
returns public.room_members
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  m public.room_members;
begin
  select * into m from public.room_members where room_id = p_room_id and user_id = p_uid;
  if not found then
    raise exception using errcode = '42501', message = 'not_a_member',
      detail = 'Join the room first.';
  end if;
  if m.kicked_at is not null then
    raise exception using errcode = '42501', message = 'kicked',
      detail = 'You were removed from this room.';
  end if;
  if m.left_at is not null then
    raise exception using errcode = '42501', message = 'not_a_member',
      detail = 'You left this room. Join it again first.';
  end if;
  return m;
end;
$$;

create function private.require_auth()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_authenticated',
      detail = 'Sign in (anonymous is fine) first.';
  end if;
  return v_uid;
end;
$$;

-- lock_room for a client RPC: unknown room → room_not_found.
create function private.lock_room_for(p_room_id uuid)
returns public.rooms
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.rooms;
begin
  r := private.lock_room(p_room_id, false);
  if r.id is null then
    raise exception using errcode = 'P0002', message = 'room_not_found',
      detail = 'No such room.';
  end if;
  return r;
end;
$$;

-- ─── Visibility: a kicked roster player loses the running battle ──────────
-- Replaces the T-002 helper. DECISION (T-016, supersedes the T-002 note "a
-- kicked roster player can still read their battle"): a kick removes every
-- live view of the room, including the battle the player was on. Their draft
-- is disqualified, so they have nothing left to do there, and the battle
-- topic must not keep streaming to them. Once the battle reaches RESULTS or
-- DESTROYED it is public anyway (can_view_battle), like for everyone.
-- Solo battles (room_id null) and battles whose room was purged keep the
-- plain roster rule.
create or replace function public.is_battle_member(p_battle_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.battle_players bp
    join public.battles b on b.id = bp.battle_id
    where bp.battle_id = p_battle_id
      and bp.user_id = (select auth.uid())
      and not exists (
        select 1 from public.room_members rm
        where rm.room_id = b.room_id
          and rm.user_id = bp.user_id
          and rm.kicked_at is not null)
  )
  or exists (
    select 1
    from public.battles b
    join public.room_members rm on rm.room_id = b.room_id
    where b.id = p_battle_id
      and rm.user_id = (select auth.uid())
      and rm.kicked_at is null
  );
$$;

-- ─── Client RPCs ──────────────────────────────────────────────────────────

-- Creates a room with the caller as host and only member (a player). A user
-- can host at most 3 rooms that are not closed.
create function public.create_room(p_display_name text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := private.require_auth();
  v_name text := private.check_display_name(p_display_name);
  v_code text;
  v_room uuid;
  v_try  int;
begin
  perform pg_advisory_xact_lock(hashtextextended('br:create_room:' || v_uid::text, 0));

  if (select count(*) from public.rooms r
      where r.host_id = v_uid and r.status <> 'closed') >= private.room_limit('max_hosted_rooms') then
    raise exception using errcode = 'P0001', message = 'too_many_rooms',
      detail = format('You already host %s open rooms. Leave one first.', private.room_limit('max_hosted_rooms'));
  end if;

  insert into public.profiles (id, display_name)
  values (v_uid, v_name)
  on conflict (id) do update set display_name = excluded.display_name;

  -- 32^5 ≈ 33.5 M codes; retry on the (rare) collision with a live or
  -- recently closed room.
  for v_try in 1..10 loop
    v_code := private.new_room_code();
    begin
      insert into public.rooms (code, host_id, settings)
      values (v_code, v_uid, jsonb_build_object('max_players', private.room_limit('max_players')))
      returning id into v_room;
      exit;
    exception when unique_violation then
      v_room := null;
    end;
  end loop;
  if v_room is null then
    raise exception using errcode = 'P0001', message = 'room_busy',
      detail = 'Could not find a free room code. Try again.';
  end if;

  insert into public.room_members (room_id, user_id, role)
  values (v_room, v_uid, 'player');

  perform private.room_bump(v_room, 'created', v_uid, jsonb_build_object('user_id', v_uid));

  return jsonb_build_object('room_id', v_room, 'code', v_code);
end;
$$;

-- Joins (or rejoins) a room by its code. See the rules at the top. Joining
-- again while already active only refreshes the display name and presence.
create function public.join_room(p_code text, p_display_name text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := private.require_auth();
  v_name    text := private.check_display_name(p_display_name);
  v_code    text := upper(btrim(p_code));
  v_room    uuid;
  r         public.rooms;
  m         public.room_members;
  v_old     text;
  v_roster  boolean := false;
  v_role    public.member_role;
  v_players int;
  v_specs   int;
  v_phase   public.battle_phase;
begin
  if v_code is null or v_code !~ '^[A-HJ-NP-Z2-9]{5}$' then
    raise exception using errcode = 'P0002', message = 'room_not_found',
      detail = 'No room has this code.';
  end if;
  select id into v_room from public.rooms where code = v_code;
  if v_room is null then
    raise exception using errcode = 'P0002', message = 'room_not_found',
      detail = 'No room has this code.';
  end if;

  r := private.lock_room_for(v_room);
  if r.status = 'closed' then
    raise exception using errcode = 'P0001', message = 'room_closed',
      detail = 'This room is closed.';
  end if;

  select * into m from public.room_members where room_id = v_room and user_id = v_uid for update;
  if found and m.kicked_at is not null then
    raise exception using errcode = '42501', message = 'kicked',
      detail = 'You were removed from this room and cannot rejoin it.';
  end if;

  select display_name into v_old from public.profiles where id = v_uid;
  insert into public.profiles (id, display_name)
  values (v_uid, v_name)
  on conflict (id) do update set display_name = excluded.display_name;

  if m.user_id is not null and m.left_at is null then
    -- Already in: refresh presence (and the name).
    update public.room_members set last_seen_at = now() where room_id = v_room and user_id = v_uid;
    if v_old is distinct from v_name then
      perform private.room_bump(v_room, 'member_updated', v_uid, jsonb_build_object('user_id', v_uid));
    end if;
    perform private.ensure_host(v_room, v_uid);
    return jsonb_build_object('room_id', v_room, 'code', r.code, 'role', m.role);
  end if;

  if r.status = 'in_battle' then
    select b.phase into v_phase from public.battles b where b.id = r.current_battle_id;
    v_roster := exists (select 1 from public.battle_players bp
                        where bp.battle_id = r.current_battle_id and bp.user_id = v_uid);
  end if;

  select count(*) filter (where role = 'player'), count(*) filter (where role = 'spectator')
    into v_players, v_specs
  from public.room_members
  where room_id = v_room and left_at is null and kicked_at is null;

  if v_roster then
    v_role := 'player';                 -- back to their own battle
  elsif r.status = 'open' and v_players < private.room_max_players(r.settings) then
    v_role := 'player';
  elsif v_specs < private.room_limit('max_spectators') then
    v_role := 'spectator';              -- late joiner or full room
  else
    raise exception using errcode = 'P0001', message = 'room_full',
      detail = 'This room has no free player or spectator slot.';
  end if;

  insert into public.room_members (room_id, user_id, role, is_ready, joined_at, last_seen_at, left_at)
  values (v_room, v_uid, v_role, false, now(), now(), null)
  on conflict (room_id, user_id) do update
    set role = excluded.role, is_ready = false, joined_at = now(), last_seen_at = now(), left_at = null;

  perform private.room_bump(v_room, 'member_joined', v_uid,
    jsonb_build_object('user_id', v_uid, 'role', v_role, 'rejoin', m.user_id is not null));

  if v_roster and v_phase not in ('destroyed', 'abandoned') then
    perform private.bump(r.current_battle_id, 'rejoin', v_uid, jsonb_build_object('user_id', v_uid));
  end if;

  perform private.ensure_host(v_room, v_uid);
  return jsonb_build_object('room_id', v_room, 'code', r.code, 'role', v_role);
end;
$$;

-- Leaves a room (the row stays; the player can rejoin). Idempotent. A roster
-- player leaving a running battle no longer blocks the early transition; their
-- draft is auto-shipped or DNF at the end of SHIPPING. The last active member
-- leaving an open room closes it.
create function public.leave_room(p_room_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := private.require_auth();
  r        public.rooms;
  m        public.room_members;
  v_phase  public.battle_phase;
begin
  r := private.lock_room_for(p_room_id);
  select * into m from public.room_members where room_id = p_room_id and user_id = v_uid for update;
  if not found or m.kicked_at is not null then
    raise exception using errcode = '42501', message = 'not_a_member',
      detail = 'You are not in this room.';
  end if;
  if m.left_at is not null then
    return;
  end if;

  update public.room_members set left_at = now(), is_ready = false
   where room_id = p_room_id and user_id = v_uid;
  perform private.room_bump(p_room_id, 'member_left', v_uid, jsonb_build_object('user_id', v_uid));

  if r.status = 'in_battle' then
    select phase into v_phase from public.battles where id = r.current_battle_id;
    if v_phase not in ('destroyed', 'abandoned')
       and exists (select 1 from public.battle_players bp
                   where bp.battle_id = r.current_battle_id and bp.user_id = v_uid) then
      perform private.bump(r.current_battle_id, 'leave', v_uid, jsonb_build_object('user_id', v_uid));
      -- Everyone who is still here may have shipped already.
      perform private.advance(r.current_battle_id, null, v_uid);
    end if;
  end if;

  select * into r from public.rooms where id = p_room_id;
  if r.status = 'open'
     and not exists (select 1 from public.room_members x
                     where x.room_id = p_room_id and x.left_at is null and x.kicked_at is null) then
    update public.rooms set status = 'closed', closed_at = now() where id = p_room_id;
    perform private.room_bump(p_room_id, 'closed', v_uid, jsonb_build_object('reason', 'empty'));
    return;
  end if;

  perform private.ensure_host(p_room_id, v_uid);
  perform private.fill_player_slots(p_room_id, v_uid);
end;
$$;

-- Ready / not ready, for players in an open room.
create function public.set_ready(p_room_id uuid, p_ready boolean)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_auth();
  r     public.rooms;
  m     public.room_members;
begin
  if p_ready is null then
    raise exception using errcode = '22023', message = 'invalid_ready',
      detail = 'ready must be true or false.';
  end if;
  r := private.lock_room_for(p_room_id);
  m := private.require_active_member(p_room_id, v_uid);
  if m.role <> 'player' then
    raise exception using errcode = '42501', message = 'not_a_player',
      detail = 'Spectators cannot ready up.';
  end if;
  if r.status <> 'open' then
    raise exception using errcode = 'P0001', message = 'wrong_room_state',
      detail = format('Cannot change readiness while the room is %s.', r.status);
  end if;

  update public.room_members set is_ready = p_ready, last_seen_at = now()
   where room_id = p_room_id and user_id = v_uid;
  if m.is_ready is distinct from p_ready then
    perform private.room_bump(p_room_id, 'member_ready', v_uid,
      jsonb_build_object('user_id', v_uid, 'is_ready', p_ready));
  end if;
  perform private.ensure_host(p_room_id, v_uid);
end;
$$;

-- Host only, while the room is open. Merges p_settings into rooms.settings;
-- a key set to null is removed (back to the default). Accepted keys:
--   max_players    2–8, not below the current number of active players
--   reveal_slot_s  30–60  (stored for M4; snapshotted into new battles)
--   voting_s       30–180 (stored for M4; snapshotted into new battles)
-- The build time limit is NOT a room setting in M3: the server draws 5, 10 or
-- 15 minutes for every battle (user decision 2026-10-06).
-- Returns the new settings.
create function public.update_room_settings(p_room_id uuid, p_settings jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := private.require_auth();
  r         public.rooms;
  v_key     text;
  v_val     jsonb;
  v_num     numeric;
  v_new     jsonb;
  v_players int;
begin
  r := private.lock_room_for(p_room_id);
  perform private.require_active_member(p_room_id, v_uid);
  perform private.ensure_host(p_room_id, v_uid);
  select * into r from public.rooms where id = p_room_id;
  if r.host_id <> v_uid then
    raise exception using errcode = '42501', message = 'not_host',
      detail = 'Only the host can change the room settings.';
  end if;
  if r.status <> 'open' then
    raise exception using errcode = 'P0001', message = 'wrong_room_state',
      detail = format('Settings can only change while the room is open (it is %s).', r.status);
  end if;
  if p_settings is null or jsonb_typeof(p_settings) <> 'object' then
    raise exception using errcode = '22023', message = 'invalid_settings',
      detail = 'settings must be a JSON object.';
  end if;

  v_new := r.settings;
  for v_key, v_val in select key, value from jsonb_each(p_settings) loop
    if v_key not in ('max_players', 'reveal_slot_s', 'voting_s') then
      raise exception using errcode = '22023', message = 'invalid_settings',
        detail = format('Unknown setting %s.', v_key);
    end if;
    if v_val = 'null'::jsonb then
      v_new := v_new - v_key;
      continue;
    end if;
    if jsonb_typeof(v_val) <> 'number' then
      raise exception using errcode = '22023', message = 'invalid_settings',
        detail = format('%s must be a number.', v_key);
    end if;
    v_num := v_val::text::numeric;
    if v_num <> trunc(v_num)
       or (v_key = 'max_players' and v_num not between private.room_limit('min_players') and private.room_limit('max_players'))
       or (v_key = 'reveal_slot_s' and v_num not between 30 and 60)
       or (v_key = 'voting_s' and v_num not between 30 and 180) then
      raise exception using errcode = '22023', message = 'invalid_settings',
        detail = format('%s is out of range.', v_key);
    end if;
    v_new := v_new || jsonb_build_object(v_key, v_num::int);
  end loop;

  select count(*) into v_players from public.room_members
  where room_id = p_room_id and role = 'player' and left_at is null and kicked_at is null;
  if private.room_max_players(v_new) < v_players then
    raise exception using errcode = '22023', message = 'invalid_settings',
      detail = format('The room already has %s players.', v_players);
  end if;

  if v_new is distinct from r.settings then
    update public.rooms set settings = v_new where id = p_room_id;
    perform private.room_bump(p_room_id, 'settings', v_uid, jsonb_build_object('settings', v_new));
    perform private.fill_player_slots(p_room_id, v_uid);
  end if;
  return v_new;
end;
$$;

-- Host only. The kicked user cannot rejoin and loses every live view of the
-- room and of its running battle (see is_battle_member above). If a battle is
-- running and they are on its roster, their draft build is disqualified (a
-- build they already shipped stays; moderation is a separate path), and the
-- battle may advance early.
create function public.kick_member(p_room_id uuid, p_user_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := private.require_auth();
  r        public.rooms;
  t        public.room_members;
  v_phase  public.battle_phase;
  v_status public.build_status;
begin
  r := private.lock_room_for(p_room_id);
  perform private.require_active_member(p_room_id, v_uid);
  perform private.ensure_host(p_room_id, v_uid);
  select * into r from public.rooms where id = p_room_id;
  if r.host_id <> v_uid then
    raise exception using errcode = '42501', message = 'not_host',
      detail = 'Only the host can kick.';
  end if;
  if p_user_id = v_uid then
    raise exception using errcode = 'P0001', message = 'cannot_kick_self',
      detail = 'Leave the room instead.';
  end if;

  select * into t from public.room_members where room_id = p_room_id and user_id = p_user_id for update;
  if not found or t.kicked_at is not null then
    raise exception using errcode = 'P0002', message = 'member_not_found',
      detail = 'No such member in this room.';
  end if;

  update public.room_members
     set kicked_at = now(), left_at = coalesce(left_at, now()), is_ready = false
   where room_id = p_room_id and user_id = p_user_id;
  perform private.room_bump(p_room_id, 'member_kicked', v_uid, jsonb_build_object('user_id', p_user_id));

  if r.status = 'in_battle' then
    select phase into v_phase from public.battles where id = r.current_battle_id;
    if v_phase not in ('destroyed', 'abandoned')
       and exists (select 1 from public.battle_players bp
                   where bp.battle_id = r.current_battle_id and bp.user_id = p_user_id) then
      update public.builds set status = 'disqualified'
       where battle_id = r.current_battle_id and builder_id = p_user_id and status = 'draft';
      select status into v_status from public.builds
       where battle_id = r.current_battle_id and builder_id = p_user_id;
      perform private.bump(r.current_battle_id, 'kick', v_uid,
        jsonb_build_object('user_id', p_user_id, 'build_status', v_status));
      perform private.advance(r.current_battle_id, null, v_uid);
    end if;
  end if;

  perform private.fill_player_slots(p_room_id, v_uid);
end;
$$;

-- Presence for the server (docs/05 §5.4): clients call this every ~10 s while
-- the room page is open. It stamps last_seen_at at most once per 5 s per
-- member (more frequent calls are no-ops, not errors) and migrates the host
-- if the host went silent. Returns {server_now, room_version, host_id,
-- status}; a client that sees a newer room_version than it holds can resync.
create function public.heartbeat(p_room_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_auth();
  m     public.room_members;
  r     public.rooms;
  h     public.room_members;
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

  return jsonb_build_object(
    'server_now', clock_timestamp(),
    'room_version', r.version,
    'host_id', r.host_id,
    'status', r.status);
end;
$$;

-- The lobby's one round trip: room, members, and a summary of the current
-- (or last) battle. Visible to members who were not kicked (members who left
-- still see it, so they can rejoin); otherwise room_not_found.
create function public.get_room_snapshot(p_room_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_auth();
  r     public.rooms;
  me    public.room_members;
begin
  select * into r from public.rooms where id = p_room_id;
  if not found or not public.is_room_member(p_room_id) then
    raise exception using errcode = 'P0002', message = 'room_not_found',
      detail = 'No such room.';
  end if;
  select * into me from public.room_members where room_id = p_room_id and user_id = v_uid;

  return jsonb_build_object(
    'server_now', clock_timestamp(),
    'me', jsonb_build_object(
      'user_id', v_uid,
      'role', me.role,
      'state', case when me.left_at is null then 'active' else 'left' end,
      'is_ready', me.is_ready,
      'is_host', r.host_id = v_uid),
    'room', jsonb_build_object(
      'id', r.id,
      'code', r.code,
      'host_id', r.host_id,
      'status', r.status,
      'version', r.version,
      'settings', r.settings,
      'max_players', private.room_max_players(r.settings),
      'max_spectators', private.room_limit('max_spectators'),
      'current_battle_id', r.current_battle_id,
      'created_at', r.created_at,
      'last_activity_at', r.last_activity_at,
      'closed_at', r.closed_at),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
               'user_id', m.user_id,
               'display_name', p.display_name,
               'avatar_seed', p.avatar_seed,
               'role', m.role,
               'state', case when m.left_at is null then 'active' else 'left' end,
               'is_ready', m.is_ready,
               'is_host', m.user_id = r.host_id,
               'joined_at', m.joined_at,
               'last_seen_at', m.last_seen_at,
               'left_at', m.left_at) order by m.joined_at, m.user_id)
      from public.room_members m
      join public.profiles p on p.id = m.user_id
      where m.room_id = p_room_id and m.kicked_at is null), '[]'::jsonb),
    'battle', (
      select jsonb_build_object(
        'id', b.id,
        'phase', b.phase,
        'version', b.version,
        'host_id', b.host_id,
        'phase_started_at', b.phase_started_at,
        'phase_ends_at', b.phase_ends_at,
        'building_started_at', b.building_started_at,
        'building_ends_at', b.building_ends_at,
        'finished_at', b.finished_at,
        'is_complete', b.is_complete,
        'created_at', b.created_at,
        'roster', coalesce((
          select jsonb_agg(jsonb_build_object('user_id', bp.user_id, 'display_name', bp.display_name)
                           order by bp.display_name, bp.user_id)
          from public.battle_players bp where bp.battle_id = b.id), '[]'::jsonb))
      from public.battles b where b.id = r.current_battle_id));
end;
$$;

-- ─── Privileges ───────────────────────────────────────────────────────────
revoke all on function private.room_limits()                              from public, anon, authenticated;
revoke all on function private.room_limit(text)                           from public, anon, authenticated;
revoke all on function private.room_limit_interval(text)                  from public, anon, authenticated;
revoke all on function private.room_max_players(jsonb)                    from public, anon, authenticated;
revoke all on function private.new_room_code()                            from public, anon, authenticated;
revoke all on function private.check_display_name(text)                   from public, anon, authenticated;
revoke all on function private.room_bump(uuid, text, uuid, jsonb)         from public, anon, authenticated;
revoke all on function private.lock_room(uuid, boolean)                   from public, anon, authenticated;
revoke all on function private.is_present(public.room_members)            from public, anon, authenticated;
revoke all on function private.ensure_host(uuid, uuid)                    from public, anon, authenticated;
revoke all on function private.fill_player_slots(uuid, uuid)              from public, anon, authenticated;
revoke all on function private.require_active_member(uuid, uuid)          from public, anon, authenticated;
revoke all on function private.require_auth()                             from public, anon, authenticated;
revoke all on function private.lock_room_for(uuid)                        from public, anon, authenticated;

revoke all on function public.create_room(text)                           from public, anon;
revoke all on function public.join_room(text, text)                       from public, anon;
revoke all on function public.leave_room(uuid)                            from public, anon;
revoke all on function public.set_ready(uuid, boolean)                    from public, anon;
revoke all on function public.update_room_settings(uuid, jsonb)           from public, anon;
revoke all on function public.kick_member(uuid, uuid)                     from public, anon;
revoke all on function public.heartbeat(uuid)                             from public, anon;
revoke all on function public.get_room_snapshot(uuid)                     from public, anon;

grant execute on function public.create_room(text)                        to authenticated;
grant execute on function public.join_room(text, text)                    to authenticated;
grant execute on function public.leave_room(uuid)                         to authenticated;
grant execute on function public.set_ready(uuid, boolean)                 to authenticated;
grant execute on function public.update_room_settings(uuid, jsonb)        to authenticated;
grant execute on function public.kick_member(uuid, uuid)                  to authenticated;
grant execute on function public.heartbeat(uuid)                          to authenticated;
grant execute on function public.get_room_snapshot(uuid)                  to authenticated;
