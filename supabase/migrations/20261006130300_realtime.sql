-- Build Roulette (T-016, M3): Realtime broadcast from the database, and who
-- may use the private topics (docs/04 §4.7, docs/01 §1.3).
--
-- ─── Topics ───────────────────────────────────────────────────────────────
--   room:{room_id}       lobby: room and member changes
--   battle:{battle_id}   one battle: phase, players, builds, captures
-- Both are PRIVATE channels (supabase-js: `{ config: { private: true } }`).
--
-- ─── Broadcast: one message per version ───────────────────────────────────
-- Every battle change already appends exactly one battle_events row per
-- battles.version (private.bump), and every room change one room_events row
-- per rooms.version (private.room_bump). An AFTER INSERT trigger on each log
-- turns that row into one Realtime message, in the same transaction. So:
--   * versions on a topic are gap-free and arrive in commit order (the row
--     lock on the battle / room serialises writers);
--   * a rolled-back change sends nothing;
--   * a change that is not a known event type still sends {type: 'sync'}
--     with its version, so clients never see a false gap (they refetch).
-- realtime.send() is used rather than realtime.broadcast_changes(): the
-- latter ships the whole OLD/NEW row, which would leak columns (settings,
-- stats, ranks before results...) and is not versioned. The payloads below are
-- built from an allow-list of small fields.
--
-- Battle topic events (payload always has `type` = event name and `version`):
--   phase      {phase, phase_started_at, phase_ends_at, reason?}
--   build      {build_id, user_id, status: 'shipped', name, completion_ms}
--   player     {user_id, status: 'left' | 'active' | 'kicked', build_status?}
--   host       {host_id}
--   capture    {build_id, capture_status}
--   destroyed  {}  (the destroy-worker finished: wipe local copies)
--   sync       {}  (anything else: refetch)
-- Room topic events:
--   room       {change, status, host_id, settings, current_battle_id, reason?}
--   member     {change, user_id, display_name, role, is_ready, state}
--   sync       {}
-- Never in a payload: votes or ballots, ephemeral storage paths, stats, room
-- codes, timestamps of other users' presence.
--
-- ─── Authorization (RLS on realtime.messages) ─────────────────────────────
-- Receive (SELECT; broadcast and presence):
--   room:{id}    is_room_member (active or left, not kicked)
--   battle:{id}  is_battle_member (roster, or room member; not kicked)
-- Send (INSERT): PRESENCE ONLY, and only for active members (not left, not
--   kicked): room:{id} → active member of the room; battle:{id} → active
--   member of the battle's room (roster players for a solo battle).
-- Both policies also require the row's topic to be the channel's topic
-- (realtime.topic(), set by Realtime for the check), so a grant for one topic
-- never covers rows of another.
-- Client broadcast sends are refused on both topics: every broadcast is
-- authoritative state from Postgres, and a member who could broadcast could
-- forge `phase` events with a higher version that other clients would apply.
-- Presence is client-claimed by design (online status, activity pulses) and
-- carries no authority: the server never reads it.
-- Realtime evaluates these policies when a client joins a channel, so an
-- open subscription survives a kick until the client rejoins or refreshes its
-- token; the payloads are small and non-secret, and every RPC re-checks.
--
-- ─── Without the Realtime service ─────────────────────────────────────────
-- The trigger functions call realtime.send only if it exists, and the
-- policies are created only if realtime.messages exists, so the migrations
-- also apply to a stack started without Realtime (realtime.send itself turns
-- any failure into a WARNING and never aborts the transaction).

-- ─── Topic authorization helper ───────────────────────────────────────────
-- In `public` like the other RLS helpers, because the realtime.messages
-- policies run as `authenticated`. It only answers a question about the
-- caller.
create function public.can_use_realtime_topic(p_topic text, p_send boolean default false)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := auth.uid();
  v_m    text[];
  v_id   uuid;
begin
  if v_uid is null or p_topic is null then
    return false;
  end if;
  v_m := regexp_match(p_topic,
    '^(room|battle):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$');
  if v_m is null then
    return false;
  end if;
  v_id := v_m[2]::uuid;

  if v_m[1] = 'room' then
    if not p_send then
      return public.is_room_member(v_id);
    end if;
    return exists (
      select 1 from public.room_members rm
      where rm.room_id = v_id and rm.user_id = v_uid
        and rm.left_at is null and rm.kicked_at is null);
  end if;

  -- battle
  if not p_send then
    return public.is_battle_member(v_id);
  end if;
  return exists (
    select 1 from public.battles b
    where b.id = v_id
      and case
            when b.room_id is null then exists (
              select 1 from public.battle_players bp
              where bp.battle_id = b.id and bp.user_id = v_uid)
            else exists (
              select 1 from public.room_members rm
              where rm.room_id = b.room_id and rm.user_id = v_uid
                and rm.left_at is null and rm.kicked_at is null)
          end);
end;
$$;

revoke all on function public.can_use_realtime_topic(text, boolean) from public, anon;
grant execute on function public.can_use_realtime_topic(text, boolean) to authenticated, service_role;

-- ─── Payload builders ─────────────────────────────────────────────────────
-- Exposed separately from the triggers so tests can call them directly.

create function private.battle_broadcast(p_event public.battle_events)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  b       public.battles;
  v_type  text;
  v_body  jsonb := '{}'::jsonb;
begin
  case p_event.type
  when 'phase' then
    select * into b from public.battles where id = p_event.battle_id;
    v_type := 'phase';
    v_body := jsonb_build_object(
      'phase', p_event.payload ->> 'to',
      'phase_started_at', b.phase_started_at,
      'phase_ends_at', b.phase_ends_at)
      || jsonb_strip_nulls(jsonb_build_object('reason', p_event.payload ->> 'reason'));
    if b.phase = 'reveal' then
      v_body := v_body || jsonb_build_object('reveal_index', b.reveal_index);
    end if;
  when 'ship' then
    v_type := 'build';
    v_body := jsonb_build_object(
      'build_id', p_event.payload ->> 'build_id',
      'user_id', p_event.actor_id,
      'status', 'shipped',
      'name', p_event.payload ->> 'name',
      'completion_ms', (p_event.payload ->> 'completion_ms')::int);
  when 'leave' then
    v_type := 'player';
    v_body := jsonb_build_object('user_id', p_event.payload ->> 'user_id', 'status', 'left');
  when 'rejoin' then
    v_type := 'player';
    v_body := jsonb_build_object('user_id', p_event.payload ->> 'user_id', 'status', 'active');
  when 'kick' then
    v_type := 'player';
    v_body := jsonb_build_object(
      'user_id', p_event.payload ->> 'user_id',
      'status', 'kicked',
      'build_status', p_event.payload ->> 'build_status');
  when 'host_change' then
    v_type := 'host';
    v_body := jsonb_build_object('host_id', p_event.payload ->> 'host_id');
  when 'capture' then
    v_type := 'capture';
    v_body := jsonb_build_object(
      'build_id', p_event.payload ->> 'build_id',
      'capture_status', p_event.payload ->> 'capture_status');
  when 'destroyed' then
    v_type := 'destroyed';
  else
    v_type := 'sync';
  end case;

  return jsonb_build_object('type', v_type, 'version', p_event.version) || v_body;
end;
$$;

create function private.room_broadcast(p_event public.room_events)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r      public.rooms;
  m      public.room_members;
  v_name text;
  v_type text;
  v_body jsonb := '{}'::jsonb;
  v_user uuid;
begin
  if p_event.type in ('member_joined', 'member_left', 'member_ready', 'member_kicked',
                      'member_promoted', 'member_updated') then
    v_type := 'member';
    v_user := (p_event.payload ->> 'user_id')::uuid;
    select * into m from public.room_members where room_id = p_event.room_id and user_id = v_user;
    select display_name into v_name from public.profiles where id = v_user;
    v_body := jsonb_build_object(
      'change', p_event.type,
      'user_id', v_user,
      'display_name', v_name,
      'role', m.role,
      'is_ready', m.is_ready,
      'state', case when m.kicked_at is not null then 'kicked'
                    when m.left_at is not null then 'left'
                    else 'active' end);
  elsif p_event.type in ('created', 'settings', 'host_changed', 'battle_started',
                         'battle_ended', 'closed') then
    v_type := 'room';
    select * into r from public.rooms where id = p_event.room_id;
    v_body := jsonb_build_object(
      'change', p_event.type,
      'status', r.status,
      'host_id', r.host_id,
      'settings', r.settings,
      'current_battle_id', r.current_battle_id)
      || jsonb_strip_nulls(jsonb_build_object('reason', p_event.payload ->> 'reason'));
  else
    v_type := 'sync';
  end if;

  return jsonb_build_object('type', v_type, 'version', p_event.version) || v_body;
end;
$$;

-- ─── Triggers ─────────────────────────────────────────────────────────────
create function private.broadcast_battle_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_msg jsonb;
begin
  if to_regprocedure('realtime.send(jsonb, text, text, boolean)') is null then
    return null;
  end if;
  v_msg := private.battle_broadcast(new);
  perform realtime.send(v_msg, v_msg ->> 'type', 'battle:' || new.battle_id::text, true);
  return null;
end;
$$;

create function private.broadcast_room_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_msg jsonb;
begin
  if to_regprocedure('realtime.send(jsonb, text, text, boolean)') is null then
    return null;
  end if;
  v_msg := private.room_broadcast(new);
  perform realtime.send(v_msg, v_msg ->> 'type', 'room:' || new.room_id::text, true);
  return null;
end;
$$;

create trigger battle_events_broadcast
  after insert on public.battle_events
  for each row execute function private.broadcast_battle_event();

create trigger room_events_broadcast
  after insert on public.room_events
  for each row execute function private.broadcast_room_event();

revoke all on function private.battle_broadcast(public.battle_events) from public, anon, authenticated;
revoke all on function private.room_broadcast(public.room_events)     from public, anon, authenticated;
revoke all on function private.broadcast_battle_event()               from public, anon, authenticated;
revoke all on function private.broadcast_room_event()                 from public, anon, authenticated;

-- ─── Policies on realtime.messages ────────────────────────────────────────
do $$
begin
  if to_regclass('realtime.messages') is null then
    raise notice 'realtime.messages does not exist: Realtime policies are not created';
    return;
  end if;

  execute $p$
    create policy "br: members receive their room and battle topics"
      on realtime.messages for select to authenticated
      using (
        extension in ('broadcast', 'presence')
        and topic = (select realtime.topic())
        and public.can_use_realtime_topic((select realtime.topic()), false)
      )
  $p$;

  execute $p$
    create policy "br: active members track presence on their topics"
      on realtime.messages for insert to authenticated
      with check (
        extension = 'presence'
        and topic = (select realtime.topic())
        and public.can_use_realtime_topic((select realtime.topic()), true)
      )
  $p$;
end;
$$;
