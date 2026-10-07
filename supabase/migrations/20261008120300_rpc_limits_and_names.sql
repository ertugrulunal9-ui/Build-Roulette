-- Build Roulette (T-024, M5): the name filter and the rate limits in the client RPCs.
--
-- Replaced (same signatures and grants; only the marked lines are new):
--   start_solo_battle  display name through private.check_display_name (length + filter);
--                      rate limit `start_solo_battle` (30 per hour)
--   create_room        rate limit `create_room` (10 per hour); the name filter comes with
--                      check_display_name (previous migration)
--   join_room          counts FAILED attempts (wrong or closed code) against
--                      `join_room_failed` (20 per 10 minutes); the body moved unchanged into
--                      private.join_room_as
--   ship_build         build name through the filter (`name_not_allowed`)
--   cast_vote          rate limit `cast_vote` (120 per minute, against floods only)
--
-- New errors: `name_not_allowed` (22023), `rate_limited` (PT429, HTTP 429; see
-- 20261008120100_rate_limits.sql for the details/hint format).
--
-- ─── join_room: counting failures that must not roll back ─────────────────
-- A failed call raises, and a raise rolls back everything the call wrote, including an
-- attempt counter. So join_room catches the two "this code leads nowhere" errors
-- (`room_not_found`, `room_closed`) of its body, records the failure, and RETURNS the error
-- instead of raising it: it sets PostgREST's `response.status` (404 for P0002, 400 for
-- P0001, the statuses PostgREST would have used) and returns the same object PostgREST
-- builds for a raised error, `{code, message, details, hint}`. PostgREST commits the
-- transaction (verified on the local stack by supabase/scripts/e2e-moderation.mjs), and
-- supabase-js reports a non-2xx answer as `error` with that body, so clients see exactly
-- what they saw before. Called from SQL (pgTAP), those two failures are a returned jsonb
-- with `message`, not an exception. Every other error (kicked, room_full, bad names,
-- rate_limited) still raises and is not counted: those mean the code was right.
-- Once a user has 20 failures in 10 minutes, every join_room call is refused with
-- `rate_limited` until the oldest failure leaves the window (a correct code too: otherwise
-- a guesser could keep guessing).

-- ─── start_solo_battle (replaces T-011's) ─────────────────────────────────
create or replace function public.start_solo_battle(p_display_name text, p_time_limit_seconds int default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid       uuid := auth.uid();
  v_name      text;
  v_limit     int  := p_time_limit_seconds;
  v_active    uuid;
  v_challenge uuid;
  v_battle    uuid;
  v_settings  jsonb;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_authenticated',
      detail = 'Sign in (anonymous is fine) before starting a battle.';
  end if;
  -- T-024: the shared display name check (1–24 characters, no control characters, filter).
  v_name := private.check_display_name(p_display_name);
  if v_limit is null then
    v_limit := (array[300, 600, 900])[1 + floor(random() * 3)::int];
  elsif not v_limit = any (private.build_time_limits_seconds()) then
    raise exception using errcode = '22023', message = 'invalid_time_limit',
      detail = format('The time limit must be one of %s seconds.', private.build_time_limits_seconds());
  end if;
  -- T-024: 30 starts per hour.
  perform private.rate_limit('start_solo_battle', v_uid);

  -- Serialize starts per user, so two parallel calls cannot both pass the
  -- active-battle check.
  perform pg_advisory_xact_lock(hashtextextended('br:start_solo:' || v_uid::text, 0));

  select b.id into v_active
  from public.battle_players bp
  join public.battles b on b.id = bp.battle_id
  where bp.user_id = v_uid
    and b.room_id is null
    and b.phase in ('spinning', 'building', 'shipping')
  limit 1;
  if v_active is not null then
    raise exception using errcode = 'P0001', message = 'battle_in_progress',
      detail = v_active::text,
      hint = 'Finish or wait out the running battle first.';
  end if;

  insert into public.profiles (id, display_name)
  values (v_uid, v_name)
  on conflict (id) do update set display_name = excluded.display_name;

  v_challenge := private.draw_challenge(v_uid, v_limit);
  v_settings  := jsonb_build_object('mode', 'solo') || private.default_battle_settings();

  insert into public.battles (room_id, challenge_id, host_id, phase, version,
                              phase_started_at, phase_ends_at, settings)
  values (null, v_challenge, v_uid, 'spinning', 0,
          now(), now() + private.setting_interval(v_settings, 'spinning_s'), v_settings)
  returning id into v_battle;

  insert into public.battle_players (battle_id, user_id, display_name)
  values (v_battle, v_uid, v_name);

  insert into public.builds (battle_id, builder_id)
  values (v_battle, v_uid);

  perform private.bump(v_battle, 'phase', v_uid,
    jsonb_build_object('from', null, 'to', 'spinning', 'mode', 'solo', 'challenge_id', v_challenge));

  return v_battle;
end;
$$;

-- ─── create_room (replaces T-016's) ───────────────────────────────────────
create or replace function public.create_room(p_display_name text)
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
  -- T-024: 10 rooms per hour.
  perform private.rate_limit('create_room', v_uid);

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

-- ─── join_room (replaces T-016's) ─────────────────────────────────────────
-- The T-016 body, unchanged except that the caller's id is a parameter (public.join_room
-- passes auth.uid()).
create function private.join_room_as(p_uid uuid, p_code text, p_display_name text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := p_uid;
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

-- Joins (or rejoins) a room by its code. Returns {room_id, code, role}; see the top of
-- this file for the two failures that are returned (HTTP 404/400) instead of raised.
create or replace function public.join_room(p_code text, p_display_name text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := private.require_auth();
  v_state  text;
  v_msg    text;
  v_detail text;
begin
  -- Refused while the user is at the limit of failed attempts.
  perform private.rate_limit_check('join_room_failed', v_uid);

  begin
    return private.join_room_as(v_uid, p_code, p_display_name);
  exception when sqlstate 'P0002' or sqlstate 'P0001' then
    get stacked diagnostics v_state  = returned_sqlstate,
                            v_msg    = message_text,
                            v_detail = pg_exception_detail;
    if v_msg not in ('room_not_found', 'room_closed') then
      raise;
    end if;
  end;

  -- A code that leads nowhere: count it, and answer without raising so the count stays.
  perform private.rate_limit_record('join_room_failed', v_uid);
  perform set_config('response.status', case v_state when 'P0002' then '404' else '400' end, true);
  return jsonb_build_object('code', v_state, 'message', v_msg, 'details', v_detail, 'hint', null);
end;
$$;

-- ─── ship_build (replaces T-016's) ────────────────────────────────────────
create or replace function public.ship_build(p_battle_id uuid, p_name text, p_stats jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_name  text := btrim(p_name);
  v_stats jsonb;
  b       public.battles;
  bu      public.builds;
  rm      public.room_members;
  v_files int;
  v_state jsonb;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_authenticated',
      detail = 'Sign in first.';
  end if;

  select * into b from public.battles where id = p_battle_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'battle_not_found',
      detail = 'No such battle.';
  end if;

  select * into bu from public.builds
  where battle_id = p_battle_id and builder_id = v_uid
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'not_on_roster',
      detail = 'Only players on the battle roster can ship.';
  end if;

  if b.room_id is not null then
    select * into rm from public.room_members where room_id = b.room_id and user_id = v_uid;
    if rm.kicked_at is not null then
      raise exception using errcode = '42501', message = 'kicked',
        detail = 'You were removed from this room.';
    end if;
    if rm.left_at is not null then
      raise exception using errcode = '42501', message = 'not_a_member',
        detail = 'You left the room. Join it again to ship.';
    end if;
  end if;

  if bu.status = 'disqualified' then
    raise exception using errcode = 'P0001', message = 'disqualified',
      detail = 'This build was disqualified.';
  end if;
  -- Checked before the phase, so a double-click gets the clearer answer
  -- even though the first ship already moved a solo battle to RESULTS.
  if bu.status <> 'draft' then
    raise exception using errcode = 'P0001', message = 'already_shipped',
      detail = 'Ship is final.';
  end if;
  if b.phase not in ('building', 'shipping') then
    raise exception using errcode = 'P0001', message = 'wrong_phase',
      detail = format('Cannot ship during %s.', b.phase);
  end if;
  if now() > b.building_ends_at + private.setting_interval(b.settings, 'shipping_s') then
    raise exception using errcode = 'P0001', message = 'deadline_passed',
      detail = 'The build deadline and its grace period are over.';
  end if;

  if v_name is null or char_length(v_name) not between 1 and 48 or v_name ~ '[[:cntrl:]]' then
    raise exception using errcode = '22023', message = 'invalid_name',
      detail = 'The build name must be 1 to 48 characters.';
  end if;
  -- T-024: the name filter.
  perform private.check_name_allowed(v_name, 'build');
  v_stats := private.clean_build_stats(p_stats);

  select count(*) into v_files
  from storage.objects o
  where o.bucket_id = 'ephemeral-builds'
    and o.name in (format('%s/%s/source.json', p_battle_id, v_uid),
                   format('%s/%s/bundle.js', p_battle_id, v_uid));
  if v_files < 2 then
    raise exception using errcode = 'P0001', message = 'files_missing',
      detail = 'Upload source.json and bundle.js before shipping.';
  end if;

  update public.builds
     set status        = 'shipped',
         name          = v_name,
         stats         = v_stats,
         shipped_at    = now(),
         completion_ms = greatest(0, (extract(epoch from
                           least(now(), b.building_ends_at) - b.building_started_at) * 1000)::int)
   where id = bu.id
  returning * into bu;

  perform private.bump(p_battle_id, 'ship', v_uid,
    jsonb_build_object('build_id', bu.id, 'name', bu.name, 'completion_ms', bu.completion_ms));

  v_state := private.try_advance(p_battle_id, v_uid);

  return jsonb_build_object(
    'build', jsonb_build_object(
      'id', bu.id,
      'status', bu.status,
      'name', bu.name,
      'shipped_at', bu.shipped_at,
      'completion_ms', bu.completion_ms,
      'stats', bu.stats),
    'battle', v_state - 'changed');
end;
$$;

-- ─── cast_vote (replaces T-019's) ─────────────────────────────────────────
create or replace function public.cast_vote(p_battle_id uuid, p_category text, p_build_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := private.require_auth();
  b          public.battles;
  bp         public.battle_players;
  rm         public.room_members;
  bu         public.builds;
  v_before   int;
  v_progress jsonb;
  v_mine     int;
  v_state    jsonb;
begin
  -- T-024: floods only (120 votes per minute).
  perform private.rate_limit('cast_vote', v_uid);

  select * into b from public.battles where id = p_battle_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'battle_not_found',
      detail = 'No such battle.';
  end if;

  select * into bp from public.battle_players where battle_id = p_battle_id and user_id = v_uid;
  if not found then
    raise exception using errcode = '42501', message = 'not_on_roster',
      detail = 'Only players on the battle roster vote.';
  end if;
  if b.room_id is not null then
    select * into rm from public.room_members where room_id = b.room_id and user_id = v_uid;
    if rm.kicked_at is not null then
      raise exception using errcode = '42501', message = 'kicked',
        detail = 'You were removed from this room.';
    end if;
    if rm.left_at is not null then
      raise exception using errcode = '42501', message = 'not_a_member',
        detail = 'You left the room. Join it again to vote.';
    end if;
  end if;
  if not bp.is_voter then
    raise exception using errcode = '42501', message = 'not_a_voter',
      detail = 'You cannot vote in this battle.';
  end if;

  if b.phase <> 'voting' then
    raise exception using errcode = 'P0001', message = 'wrong_phase',
      detail = format('Cannot vote during %s.', b.phase);
  end if;
  if now() >= b.phase_ends_at then
    raise exception using errcode = 'P0001', message = 'deadline_passed',
      detail = 'Voting is over.';
  end if;

  if p_category is null or not exists (select 1 from public.vote_categories c
                                       where c.slug = p_category and c.is_active) then
    raise exception using errcode = '22023', message = 'invalid_category',
      detail = 'Unknown vote category.';
  end if;
  select * into bu from public.builds where id = p_build_id and battle_id = p_battle_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'build_not_found',
      detail = 'No such build in this battle.';
  end if;
  if bu.builder_id = v_uid then
    raise exception using errcode = 'P0001', message = 'self_vote',
      detail = 'You cannot vote for your own build.';
  end if;
  if bu.status not in ('shipped', 'auto_shipped') or not (bu.id = any (b.reveal_order)) then
    raise exception using errcode = 'P0001', message = 'not_votable',
      detail = format('A %s build cannot receive votes.', bu.status);
  end if;

  -- Presence (lock order: battle, room, member rows).
  perform 1 from public.rooms where id = b.room_id for update;
  perform private.touch_member(b.room_id, v_uid);

  v_before := (private.vote_progress(p_battle_id) ->> 'voted_count')::int;
  insert into public.votes (battle_id, voter_id, category, build_id)
  values (p_battle_id, v_uid, p_category, p_build_id)
  on conflict (battle_id, voter_id, category) do update
    set build_id = excluded.build_id, updated_at = now()
    where public.votes.build_id is distinct from excluded.build_id;

  v_progress := private.vote_progress(p_battle_id);
  if (v_progress ->> 'voted_count')::int <> v_before then
    -- A voter completed their ballot: counts only, never who or what.
    perform private.bump(p_battle_id, 'vote', v_uid, v_progress);
  end if;

  select count(*)::int into v_mine
  from public.votes v
  join public.vote_categories c on c.slug = v.category and c.is_active
  where v.battle_id = p_battle_id and v.voter_id = v_uid;

  v_state := private.try_advance(p_battle_id, v_uid);

  return jsonb_build_object(
    'category', p_category,
    'build_id', p_build_id,
    'ballot_complete', v_mine >= private.active_category_count(),
    'battle', v_state - 'changed');
end;
$$;

revoke all on function private.join_room_as(uuid, text, text) from public, anon, authenticated, service_role;
