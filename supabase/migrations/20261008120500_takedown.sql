-- Build Roulette (T-024, M5): the takedown job and what a taken-down build shows.
-- The decision itself (admin_take_down_build) is in 20261008120400_reports_and_admin.sql;
-- its header describes the whole takedown.
--
-- ─── The job ──────────────────────────────────────────────────────────────
-- `takedown` jobs (ref_id = build id) are processed by the capture-worker: it deletes
-- `screenshots/{battle}/{build}.*` through the Storage API, checks that nothing is left,
-- then calls complete_takedown(build) (service role), which stamps
-- private.build_takedowns.storage_deleted_at and marks the job done. Failures use fail_job
-- (5 attempts, backoff), like the other kinds; a failed takedown job can be queued again
-- from the admin page (admin_take_down_build on the same build).
--
-- Ordering with the capture of the same build (both write or delete the same object):
--   * claim_job('capture') never hands out the capture job of a taken-down build (its
--     queued job was cancelled by the takedown; this also covers a running job whose lease
--     expired);
--   * claim_job('takedown') waits while the build's capture job is running with a live
--     lease, so a capture in flight finishes (and uploads) before the files are deleted;
--   * complete_capture of a taken-down build records nothing (no path, no event) and only
--     closes its job.
--
-- ─── What a taken-down build shows ────────────────────────────────────────
-- Everywhere (get_public_battle, get_player_history, get_battle_snapshot,
-- get_reveal_builds): `taken_down: true`, `name: null`, `screenshot_path: null`; the
-- clients show "Removed by moderators". What stays visible in a finished battle: the
-- builder's display name, the rank, the status, the completion time, the stats, the vote
-- counts and the awards (so the results stay consistent). During REVEAL, VOTING and RESULTS
-- its files are no longer readable by battle members (can_read_revealed_object) and
-- get_reveal_builds returns no file names for it. A build taken down while the battle was
-- running is `disqualified`, so get_public_battle and get_player_history leave it out, as
-- for a kicked player.
--
-- Replaced (same signatures and grants): private.lock_job_battle, public.claim_job,
-- public.complete_capture, private.reveal_move, public.get_battle_snapshot,
-- public.get_public_battle, public.get_player_history, public.can_read_revealed_object,
-- public.get_reveal_builds. New: public.complete_takedown (service role).

-- ─── lock_job_battle (replaces T-011's): takedown jobs reference a build ──
create or replace function private.lock_job_battle(p_job_id bigint)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_battle uuid;
begin
  select case
           when j.kind in ('capture', 'takedown')
             then (select bu.battle_id from public.builds bu where bu.id = j.ref_id)
           else j.ref_id
         end
    into v_battle
  from public.jobs j
  where j.id = p_job_id;

  if v_battle is not null then
    perform 1 from public.battles where id = v_battle for update;
  end if;
  return v_battle;
end;
$$;

-- ─── claim_job (replaces T-011's): the capture/takedown ordering above ────
create or replace function public.claim_job(p_kind public.job_kind)
returns public.jobs
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  j public.jobs;
begin
  select * into j
  from public.jobs
  where kind = p_kind
    and status in ('queued', 'running')
    and run_after <= now()
    and attempts < 5
    -- T-024: never capture a taken-down build.
    and not (p_kind = 'capture' and exists (
          select 1 from public.builds bu where bu.id = jobs.ref_id and bu.taken_down_at is not null))
    -- T-024: delete only once no capture of the build is in flight.
    and not (p_kind = 'takedown' and exists (
          select 1 from public.jobs c
          where c.kind = 'capture' and c.ref_id = jobs.ref_id
            and c.status = 'running' and c.run_after > now()))
  order by run_after, id
  limit 1
  for update skip locked;

  if not found then
    return null;
  end if;

  update public.jobs
     set status     = 'running',
         attempts   = attempts + 1,
         run_after  = now() + interval '2 minutes',   -- lease
         updated_at = now()
   where id = j.id
  returning * into j;

  return j;
end;
$$;

-- ─── complete_capture (replaces T-011's): ignored for a taken-down build ──
create or replace function public.complete_capture(p_build_id uuid, p_status public.capture_status, p_path text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  bu public.builds;
begin
  select * into bu from public.builds where id = p_build_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'build_not_found',
      detail = 'No such build.';
  end if;

  -- Lock order: battle row first, then builds and jobs.
  perform 1 from public.battles where id = bu.battle_id for update;
  select * into bu from public.builds where id = p_build_id for update;

  -- T-024: a capture that finished after the takedown records nothing; the takedown job
  -- deletes what it stored.
  if bu.taken_down_at is not null then
    update public.jobs
       set status = 'done', last_error = 'taken down', updated_at = now()
     where kind = 'capture' and ref_id = p_build_id;
    return;
  end if;

  if p_status is null or p_status = 'pending' then
    raise exception using errcode = '22023', message = 'invalid_capture_status',
      detail = 'Use captured, fallback or failed.';
  end if;
  if bu.status not in ('shipped', 'auto_shipped') then
    raise exception using errcode = 'P0001', message = 'not_capturable',
      detail = format('A %s build has nothing to capture.', bu.status);
  end if;
  if p_status = 'failed' then
    if p_path is not null then
      raise exception using errcode = '22023', message = 'invalid_path',
        detail = 'A failed capture has no screenshot path.';
    end if;
  elsif p_path is null
        or p_path !~ ('^' || bu.battle_id::text || '/' || bu.id::text || '\.(webp|png)$') then
    raise exception using errcode = '22023', message = 'invalid_path',
      detail = 'The path must be {battle_id}/{build_id}.webp (or .png) in the screenshots bucket.';
  end if;

  if bu.capture_status <> 'captured' then
    update public.builds
       set capture_status  = p_status,
           screenshot_path = p_path,
           captured_at     = case when p_status = 'failed' then null else now() end
     where id = p_build_id;

    perform private.bump(bu.battle_id, 'capture', null,
      jsonb_build_object('build_id', p_build_id, 'capture_status', p_status));
  end if;

  update public.jobs
     set status = 'done', last_error = null, updated_at = now()
   where kind = 'capture' and ref_id = p_build_id;

  perform private.try_advance(bu.battle_id, null);
end;
$$;

-- ─── complete_takedown (new, service role) ────────────────────────────────
-- Called by the capture-worker after it deleted screenshots/{battle}/{build}.* through the
-- Storage API and checked that nothing is left. Stamps storage_deleted_at (once), keeps
-- screenshot_path cleared, and closes the build's takedown job and any capture job left
-- behind. Idempotent. Only for a build that was taken down (not_taken_down otherwise).
create function public.complete_takedown(p_build_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  bu public.builds;
begin
  select * into bu from public.builds where id = p_build_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'build_not_found',
      detail = 'No such build.';
  end if;

  -- Lock order: battle row first, then builds and jobs.
  perform 1 from public.battles where id = bu.battle_id for update;
  select * into bu from public.builds where id = p_build_id for update;
  if bu.taken_down_at is null then
    raise exception using errcode = 'P0001', message = 'not_taken_down',
      detail = 'This build was not taken down; its screenshot stays.';
  end if;

  update private.build_takedowns
     set storage_deleted_at = coalesce(storage_deleted_at, now())
   where build_id = p_build_id;
  update public.builds set screenshot_path = null where id = p_build_id and screenshot_path is not null;

  update public.jobs
     set status = 'done', last_error = null, updated_at = now()
   where kind = 'takedown' and ref_id = p_build_id;
  update public.jobs
     set status = 'done', last_error = 'taken down', updated_at = now()
   where kind = 'capture' and ref_id = p_build_id and status in ('queued', 'running');
end;
$$;

-- ─── reveal_move (replaces T-019's): taken-down builds have no slot ──────
-- The next slot is the next build in reveal_order that was not taken down; when there is
-- none, VOTING starts. A takedown of the build on screen calls this at once (reason
-- `takedown`).
create or replace function private.reveal_move(p_battle_id uuid, p_actor uuid, p_skip boolean, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  b      public.battles;
  v_now  timestamptz := now();
  v_slot int;
  v_next int;
begin
  select * into b from public.battles where id = p_battle_id;

  v_next := b.reveal_index + 1;
  while v_next < cardinality(b.reveal_order)
        and exists (select 1 from public.builds bu
                    where bu.id = b.reveal_order[v_next + 1] and bu.taken_down_at is not null) loop
    v_next := v_next + 1;
  end loop;

  if not p_skip and v_next < cardinality(b.reveal_order) then
    v_slot := private.battle_reveal_slot(b.settings, cardinality(b.reveal_order));
    update public.battles
       set reveal_index     = v_next,
           phase_started_at = v_now,
           phase_ends_at    = v_now + make_interval(secs => v_slot)
     where id = p_battle_id;
    perform private.bump(p_battle_id, 'phase', p_actor, jsonb_strip_nulls(jsonb_build_object(
      'from', 'reveal', 'to', 'reveal', 'reveal_index', v_next, 'reason', p_reason)));
  else
    update public.battles
       set phase            = 'voting',
           phase_started_at = v_now,
           phase_ends_at    = v_now + private.setting_interval(b.settings, 'voting_s')
     where id = p_battle_id;
    perform private.bump(p_battle_id, 'phase', p_actor, jsonb_strip_nulls(jsonb_build_object(
      'from', 'reveal', 'to', 'voting', 'reason', p_reason)));
  end if;
end;
$$;

-- ─── get_battle_snapshot (replaces T-019's): builds[].taken_down ─────────
create or replace function public.get_battle_snapshot(p_battle_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid       uuid := auth.uid();
  b           public.battles;
  v_out       jsonb;
  v_is_player boolean;
  v_is_voter  boolean;
  rm          public.room_members;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'not_authenticated',
      detail = 'Sign in first.';
  end if;

  select * into b from public.battles where id = p_battle_id;
  if not found or not public.can_view_battle(p_battle_id) then
    raise exception using errcode = 'P0002', message = 'battle_not_found',
      detail = 'No such battle.';
  end if;

  v_is_player := exists (select 1 from public.battle_players bp
                         where bp.battle_id = b.id and bp.user_id = v_uid);

  select jsonb_build_object(
    'server_now', clock_timestamp(),
    'me', jsonb_build_object(
      'user_id', v_uid,
      'is_player', v_is_player),
    'battle', jsonb_build_object(
      'id', b.id,
      'room_id', b.room_id,
      'host_id', b.host_id,
      'mode', coalesce(b.settings ->> 'mode', 'multiplayer'),
      'phase', b.phase,
      'version', b.version,
      'phase_started_at', b.phase_started_at,
      'phase_ends_at', b.phase_ends_at,
      'settings', b.settings,
      'building_started_at', b.building_started_at,
      'building_ends_at', b.building_ends_at,
      'shipping_ended_at', b.shipping_ended_at,
      'finished_at', b.finished_at,
      'destroyed_at', b.destroyed_at,
      'is_complete', b.is_complete,
      'created_at', b.created_at),
    'challenge', (
      select jsonb_build_object(
        'id', c.id,
        'build', jsonb_build_object('text', c.build_text, 'hint', c.build_hint),
        'rule',  jsonb_build_object('text', c.rule_text,  'hint', c.rule_hint),
        'style', jsonb_build_object('text', c.style_text, 'hint', c.style_hint),
        'time_limit_seconds', c.time_limit_seconds)
      from public.challenges c where c.id = b.challenge_id),
    'players', coalesce((
      select jsonb_agg(jsonb_build_object(
               'user_id', bp.user_id,
               'display_name', bp.display_name) order by bp.display_name, bp.user_id)
      from public.battle_players bp where bp.battle_id = b.id), '[]'::jsonb),
    'builds', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', bu.id,
               'builder_id', bu.builder_id,
               'name', case when bu.taken_down_at is null then bu.name end,
               'status', bu.status,
               'shipped_at', bu.shipped_at,
               'completion_ms', bu.completion_ms,
               'stats', bu.stats,
               'capture_status', bu.capture_status,
               'screenshot_path', case when bu.taken_down_at is null then bu.screenshot_path end,
               'captured_at', bu.captured_at,
               'source_destroyed_at', bu.source_destroyed_at,
               'final_rank', bu.final_rank,
               'total_votes', bu.total_votes,
               'taken_down', bu.taken_down_at is not null) order by bu.final_rank nulls last, bu.created_at, bu.id)
      from public.builds bu where bu.battle_id = b.id), '[]'::jsonb),
    'awards', coalesce((
      select jsonb_agg(jsonb_build_object(
               'build_id', a.build_id,
               'award', a.award,
               'source', a.source,
               'votes', a.votes) order by a.award, a.build_id)
      from public.awards a where a.battle_id = b.id), '[]'::jsonb)
  ) into v_out;

  if coalesce(b.settings ->> 'mode', '') <> 'solo' then
    if b.room_id is not null then
      select * into rm from public.room_members where room_id = b.room_id and user_id = v_uid;
    end if;
    v_is_voter := v_is_player
                  and rm.kicked_at is null
                  and exists (select 1 from public.battle_players bp
                              where bp.battle_id = b.id and bp.user_id = v_uid and bp.is_voter);

    v_out := jsonb_set(v_out, '{me}', (v_out -> 'me') || jsonb_build_object(
      'role', case when v_is_player then 'player'
                   when b.room_id is not null and public.is_room_member(b.room_id) then 'spectator'
                   else 'viewer' end,
      'is_host', b.host_id = v_uid,
      'is_voter', v_is_voter,
      'can_vote', v_is_voter
                  and rm.left_at is null
                  and b.phase = 'voting'
                  and now() < b.phase_ends_at));
    v_out := jsonb_set(v_out, '{players}', coalesce((
      select jsonb_agg(jsonb_build_object(
               'user_id', bp.user_id,
               'display_name', bp.display_name,
               'state', case when m.kicked_at is not null then 'kicked'
                             when m.left_at is not null then 'left'
                             else 'active' end) order by bp.display_name, bp.user_id)
      from public.battle_players bp
      left join public.room_members m on m.room_id = b.room_id and m.user_id = bp.user_id
      where bp.battle_id = b.id), '[]'::jsonb));
    v_out := jsonb_set(v_out, '{battle}', (v_out -> 'battle') || jsonb_build_object(
      'reveal_vote', coalesce((b.settings ->> 'reveal_vote')::boolean, true),
      'reveal_order', to_jsonb(b.reveal_order),
      'reveal_index', b.reveal_index,
      'reveal_slot_s', case when cardinality(b.reveal_order) > 0
                            then private.battle_reveal_slot(b.settings, cardinality(b.reveal_order)) end));
    v_out := jsonb_set(v_out, '{builds}', coalesce((
      select jsonb_agg(x.build || jsonb_build_object('votes', bu.vote_counts) order by x.n)
      from jsonb_array_elements(v_out -> 'builds') with ordinality x(build, n)
      join public.builds bu on bu.id = (x.build ->> 'id')::uuid), '[]'::jsonb));
    v_out := v_out || jsonb_build_object(
      'vote_categories', coalesce((
        select jsonb_agg(jsonb_build_object('slug', c.slug, 'label', c.label, 'description', c.description)
                         order by c.sort_order, c.slug)
        from public.vote_categories c where c.is_active), '[]'::jsonb),
      'vote_progress', case when b.phase = 'voting' then private.vote_progress(b.id) end);
  end if;

  return v_out;
end;
$$;

-- ─── get_public_battle (replaces T-019's): builds[].taken_down ───────────
create or replace function public.get_public_battle(p_battle_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  b     public.battles;
  v_out jsonb;
begin
  select * into b from public.battles where id = p_battle_id;
  if not found or b.phase not in ('results'::public.battle_phase, 'destroyed'::public.battle_phase) then
    raise exception using errcode = 'P0002', message = 'battle_not_found',
      detail = 'No such battle, or its results are not public yet.';
  end if;

  select jsonb_build_object(
    'battle', jsonb_build_object(
      'id', b.id,
      'mode', coalesce(b.settings ->> 'mode', 'multiplayer'),
      'phase', b.phase,
      'is_complete', b.is_complete,
      'building_started_at', b.building_started_at,
      'building_ends_at', b.building_ends_at,
      'finished_at', b.finished_at,
      'destroyed_at', b.destroyed_at,
      'created_at', b.created_at),
    'challenge', (
      select jsonb_build_object(
        'build', jsonb_build_object('text', c.build_text, 'hint', c.build_hint),
        'rule',  jsonb_build_object('text', c.rule_text,  'hint', c.rule_hint),
        'style', jsonb_build_object('text', c.style_text, 'hint', c.style_hint),
        'time_limit_seconds', c.time_limit_seconds)
      from public.challenges c where c.id = b.challenge_id),
    'players', coalesce((
      select jsonb_agg(bp.display_name order by bp.display_name)
      from public.battle_players bp where bp.battle_id = b.id), '[]'::jsonb),
    'builds', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', bu.id,
               'builder_name', bp.display_name,
               'name', case when bu.taken_down_at is null then bu.name end,
               'status', bu.status,
               'shipped_at', bu.shipped_at,
               'completion_ms', bu.completion_ms,
               'final_rank', bu.final_rank,
               'total_votes', bu.total_votes,
               'votes', bu.vote_counts,
               'stats', bu.stats,
               'capture_status', bu.capture_status,
               -- Only a finished capture has a path, and it is in the public
               -- `screenshots` bucket (complete_capture checks the shape).
               'screenshot_path', case when bu.capture_status in ('captured', 'fallback')
                                        and bu.taken_down_at is null
                                       then bu.screenshot_path end,
               'taken_down', bu.taken_down_at is not null)
             order by bu.final_rank nulls last, bp.display_name, bu.id)
      from public.builds bu
      join public.battle_players bp on bp.battle_id = bu.battle_id and bp.user_id = bu.builder_id
      where bu.battle_id = b.id
        and bu.status <> 'disqualified'::public.build_status), '[]'::jsonb),
    'awards', coalesce((
      select jsonb_agg(jsonb_build_object(
               'build_id', a.build_id,
               'award', a.award,
               'source', a.source,
               'votes', a.votes) order by a.award, a.build_id)
      from public.awards a
      join public.builds bu on bu.id = a.build_id
      where a.battle_id = b.id
        and bu.status <> 'disqualified'::public.build_status), '[]'::jsonb)
  ) into v_out;

  return v_out;
end;
$$;

-- ─── get_player_history (replaces T-021's): build.taken_down ─────────────
create or replace function public.get_player_history(
  p_user_id       uuid,
  p_before        timestamptz default null,
  p_before_battle uuid        default null,
  p_limit         int         default 20)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit int := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_name  text;
  v_rows  jsonb;
  v_more  boolean;
  v_last  jsonb;
begin
  -- The newest display name among the public battles (null: no public battle).
  select bp.display_name into v_name
  from public.battle_players bp
  join public.battles b on b.id = bp.battle_id
  join public.builds bu on bu.battle_id = b.id and bu.builder_id = bp.user_id
  where bp.user_id = p_user_id
    and b.phase in ('results'::public.battle_phase, 'destroyed'::public.battle_phase)
    and b.finished_at is not null
    and bu.status <> 'disqualified'::public.build_status
  order by b.finished_at desc, b.id desc
  limit 1;

  if v_name is null then
    return jsonb_build_object('player', null, 'battles', '[]'::jsonb, 'next', null);
  end if;

  -- One page (plus one row, to know whether there is a next page) of the player's public
  -- battles, newest first.
  with fetched as (
    select b.id as battle_id, b.finished_at,
      jsonb_build_object(
        'battle_id', b.id,
        'mode', coalesce(b.settings ->> 'mode', 'multiplayer'),
        'phase', b.phase,
        'finished_at', b.finished_at,
        'destroyed_at', b.destroyed_at,
        'display_name', bp.display_name,
        'challenge', jsonb_build_object(
          'build', jsonb_build_object('text', c.build_text),
          'rule',  jsonb_build_object('text', c.rule_text),
          'style', jsonb_build_object('text', c.style_text),
          'time_limit_seconds', c.time_limit_seconds),
        -- N in "rank k of N": the builds the public results page lists.
        'players_count', (select count(*) from public.builds x
                          where x.battle_id = b.id
                            and x.status <> 'disqualified'::public.build_status),
        'build', jsonb_build_object(
          'id', bu.id,
          'name', case when bu.taken_down_at is null then bu.name end,
          'status', bu.status,
          'completion_ms', bu.completion_ms,
          'final_rank', bu.final_rank,
          'total_votes', bu.total_votes,
          'votes', bu.vote_counts,
          'capture_status', bu.capture_status,
          'screenshot_path', case when bu.capture_status in ('captured', 'fallback')
                                   and bu.taken_down_at is null
                                  then bu.screenshot_path end,
          'taken_down', bu.taken_down_at is not null),
        'awards', coalesce((
          select jsonb_agg(jsonb_build_object('award', a.award, 'source', a.source, 'votes', a.votes)
                           order by a.award)
          from public.awards a where a.build_id = bu.id), '[]'::jsonb)) as item
    from public.battle_players bp
    join public.battles b on b.id = bp.battle_id
    join public.builds bu on bu.battle_id = b.id and bu.builder_id = bp.user_id
    join public.challenges c on c.id = b.challenge_id
    where bp.user_id = p_user_id
      and b.phase in ('results'::public.battle_phase, 'destroyed'::public.battle_phase)
      and b.finished_at is not null
      and bu.status <> 'disqualified'::public.build_status
      and (p_before is null
           or b.finished_at < p_before
           or (p_before_battle is not null and b.finished_at = p_before and b.id < p_before_battle))
    order by b.finished_at desc, b.id desc
    limit v_limit + 1
  ),
  page as (
    select * from fetched order by finished_at desc, battle_id desc limit v_limit
  )
  select
    coalesce((select jsonb_agg(item order by finished_at desc, battle_id desc) from page),
             '[]'::jsonb),
    (select count(*) from fetched) > v_limit,
    -- The cursor of the next page: the oldest row of this one.
    (select jsonb_build_object('before', finished_at, 'before_battle', battle_id)
       from page order by finished_at asc, battle_id asc limit 1)
  into v_rows, v_more, v_last;

  return jsonb_build_object(
    'player', jsonb_build_object('display_name', v_name),
    'battles', v_rows,
    'next', case when v_more then v_last end);
end;
$$;

-- ─── can_read_revealed_object (replaces T-019's): not a taken-down build ─
create or replace function public.can_read_revealed_object(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uuid  text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_parts text[];
  v_battle uuid;
begin
  if auth.uid() is null or p_name is null then
    return false;
  end if;
  v_parts := string_to_array(p_name, '/');
  if coalesce(array_length(v_parts, 1), 0) not in (3, 4)
     or v_parts[1] !~ v_uuid
     or v_parts[2] !~ v_uuid then
    return false;
  end if;
  v_battle := v_parts[1]::uuid;

  return exists (
      select 1
      from public.battles b
      join public.builds bu on bu.battle_id = b.id and bu.builder_id = v_parts[2]::uuid
      where b.id = v_battle
        and b.phase in ('reveal'::public.battle_phase, 'voting'::public.battle_phase,
                        'results'::public.battle_phase)
        and bu.id = any (b.reveal_order)
        and bu.taken_down_at is null
        and exists (select 1
                    from jsonb_each_text(private.reveal_file_names(b.id, bu.builder_id, bu.status)) f
                    where f.value = p_name))
    and public.is_battle_member(v_battle);
end;
$$;

-- ─── get_reveal_builds (replaces T-019's) ─────────────────────────────────
-- A taken-down build keeps its position (so reveal_index still points at the right
-- entry) with `taken_down: true`, `name: null` and no files.
create or replace function public.get_reveal_builds(p_battle_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  b public.battles;
begin
  perform private.require_auth();
  select * into b from public.battles where id = p_battle_id;
  if not found or not public.is_battle_member(p_battle_id) then
    raise exception using errcode = 'P0002', message = 'battle_not_found',
      detail = 'No such battle.';
  end if;
  if b.phase not in ('reveal', 'voting', 'results') then
    raise exception using errcode = 'P0001', message = 'wrong_phase',
      detail = format('Nothing is revealed during %s.', b.phase);
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'build_id', bu.id,
             'position', o.n - 1,
             'name', case when bu.taken_down_at is null then bu.name end,
             'builder_id', bu.builder_id,
             'builder_name', bp.display_name,
             'status', bu.status,
             'taken_down', bu.taken_down_at is not null,
             'files', case when bu.taken_down_at is not null
               then jsonb_build_object('js', null, 'css', null, 'manifest', null, 'thumb', null)
               else (
               select jsonb_object_agg(f.key, case when exists (
                          select 1 from storage.objects so
                          where so.bucket_id = 'ephemeral-builds' and so.name = f.value)
                        then f.value end)
               from jsonb_each_text(private.reveal_file_names(b.id, bu.builder_id, bu.status)) f) end)
           order by o.n)
    from unnest(b.reveal_order) with ordinality o(build_id, n)
    join public.builds bu on bu.id = o.build_id
    join public.battle_players bp on bp.battle_id = bu.battle_id and bp.user_id = bu.builder_id
    where bu.status in ('shipped', 'auto_shipped') or bu.taken_down_at is not null), '[]'::jsonb);
end;
$$;

revoke all on function public.complete_takedown(uuid) from public, anon, authenticated;
grant execute on function public.complete_takedown(uuid) to service_role;
