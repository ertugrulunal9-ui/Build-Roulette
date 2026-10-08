-- Build Roulette (T-028, M5): a build taken down after RESULTS loses its awards on every
-- public surface. User decision 2026-10-08.
--
-- ─── The rule ─────────────────────────────────────────────────────────────
-- A build taken down in a FINISHED battle (RESULTS, DESTROYED) keeps its rank: results are
-- permanent and nothing is re-ranked. But it loses all its awards, the vote awards (one per
-- category, T-022) and the auto-awards (speedrun, clutch_ship, fastest_ship), and the
-- clients drop its "Winner" highlight (rank 1 and not taken down; see apps/web).
--   * Nothing is reassigned: no other build gets the hidden awards, and when the rank-1
--     build is taken down no build is "the winner" (the Best Build award is gone with it).
--     The remaining builds keep their own awards exactly as stored.
--   * The vote counts stay visible (builds[].votes, total_votes): they are the result the
--     rank is based on, and the ballots were cast on the build before it was removed. Only
--     the honours (awards, Winner) go.
--   * The stored `awards` rows are not touched (permanent data, auditability). The rule is
--     applied where they are read:
--       - get_public_battle, get_player_history and get_battle_snapshot leave out the
--         awards of taken-down builds (`awards` keeps its shape);
--       - the `awards_select` RLS policy hides them from direct table reads too (the table
--         is readable by everyone who can view the battle, so hiding them in the RPCs
--         alone would not do; T-024 cleared builds.name for the same reason);
--       - SECURITY DEFINER code (the admin RPCs, the tests) still sees every row.
--   * A build taken down while the battle was RUNNING is unchanged (T-024): it is
--     disqualified and never gets a rank, a tally or an award in the first place.
--
-- Replaced (same signatures and grants): public.get_battle_snapshot,
-- public.get_public_battle, public.get_player_history (T-024's versions, with only the
-- `awards` reads changed). Altered: policy awards_select on public.awards.

-- ─── awards_select (replaces T-002's): not the awards of taken-down builds ─
alter policy awards_select on public.awards
  using (public.can_view_battle(battle_id)
         and not exists (select 1 from public.builds bu
                         where bu.id = awards.build_id and bu.taken_down_at is not null));

-- ─── get_battle_snapshot (replaces T-024's): no awards of taken-down builds ─
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
      from public.awards a
      join public.builds bu on bu.id = a.build_id
      where a.battle_id = b.id
        and bu.taken_down_at is null), '[]'::jsonb)   -- T-028
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

-- ─── get_public_battle (replaces T-024's): no awards of taken-down builds ──
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
        and bu.status <> 'disqualified'::public.build_status
        and bu.taken_down_at is null), '[]'::jsonb)   -- T-028
  ) into v_out;

  return v_out;
end;
$$;

-- ─── get_player_history (replaces T-024's): no awards of taken-down builds ─
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
        -- T-028: none once the build was taken down.
        'awards', coalesce((
          select jsonb_agg(jsonb_build_object('award', a.award, 'source', a.source, 'votes', a.votes)
                           order by a.award)
          from public.awards a
          where a.build_id = bu.id
            and bu.taken_down_at is null), '[]'::jsonb)) as item
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
