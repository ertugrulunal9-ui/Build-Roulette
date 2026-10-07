-- Build Roulette (T-021, M4): the player history page `/u/[id]`.
--
-- `get_player_history(p_user_id, p_before, p_before_battle, p_limit)` is read-only and
-- callable by `anon` (the page is server-rendered with the anon key, like /battles/[id]).
-- It follows the privacy rules of `get_public_battle` (T-014):
--
--   * only battles in RESULTS or DESTROYED (never a running, abandoned or unknown one);
--   * only PERMANENT data of the player's own build in each: challenge texts, the build's
--     name, status, completion time, rank out of N, vote counts per category, awards and
--     the public screenshot path (once captured), plus the battle's mode and timestamps;
--   * never another user's id, never an ephemeral storage path, never a ballot (who voted
--     for what), never room ids, settings or versions. The output does not even repeat
--     the caller's `p_user_id`;
--   * a disqualified build (the player was kicked) is not public, so that battle is left
--     out, as `get_public_battle` leaves the build out.
--
-- The display name is the one the player used in their newest public battle (the
-- permanent roster snapshot, `battle_players.display_name`), not the mutable profile.
-- An unknown user, or one without any public battle, gets the same answer:
-- `{player: null, battles: [], next: null}`, so the function cannot tell whether an id
-- exists or has a battle running.
--
-- Pagination is keyset, newest first, on (finished_at, battle id): a sweep can finish
-- several battles in one transaction (same `now()`), so the timestamp alone is not a
-- cursor. `p_before` / `p_before_battle` come from the previous page's `next`;
-- `p_limit` is clamped to 1..50 (default 20).
--
-- Anonymous players: the history belongs to the anonymous auth user. Clearing the
-- browser's storage loses the session, and with it the way back to "your history" (the
-- page itself stays readable by its URL). Account linking (docs/06 M6) is what will keep
-- it across devices; nothing here depends on it.

create function public.get_player_history(
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
          'name', bu.name,
          'status', bu.status,
          'completion_ms', bu.completion_ms,
          'final_rank', bu.final_rank,
          'total_votes', bu.total_votes,
          'votes', bu.vote_counts,
          'capture_status', bu.capture_status,
          'screenshot_path', case when bu.capture_status in ('captured', 'fallback')
                                  then bu.screenshot_path end),
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

revoke all on function public.get_player_history(uuid, timestamptz, uuid, int) from public;
grant execute on function public.get_player_history(uuid, timestamptz, uuid, int)
  to anon, authenticated, service_role;
