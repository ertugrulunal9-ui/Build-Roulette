-- Build Roulette (T-014): two small additions for the solo game UI.
--
-- 1. `autosave/bundle.css`
--    The autosave had no CSS slot (docs/05 §5.5), so an auto-shipped build was
--    captured without its styles. The client now uploads
--    {battle}/{uid}/autosave/bundle.css next to autosave/bundle.js and
--    autosave/source.json, and the capture worker reads it for auto_shipped
--    builds. Auto-ship itself (private.finalize_solo) still needs only
--    autosave/bundle.js + autosave/source.json: the CSS is optional, because a
--    build without any CSS is valid and the client skips an empty file.
--
-- 2. `get_public_battle(p_battle_id)`
--    The permanent results page (/battles/[id]) is server-rendered with the
--    anon key only (no session, no service key in the web app). This read-only
--    function returns a battle's PERMANENT data (docs/05 §5.6), and only for a
--    battle in RESULTS or DESTROYED:
--      challenge texts and hints, the time limit, display names, build names,
--      build statuses, completion times, ranks, vote totals, display-only
--      stats, awards, public screenshot paths, and the battle timestamps.
--    Never: user ids, room ids, settings, versions, ephemeral storage paths,
--    votes. Builds are keyed by their build id (awards point at it), and the
--    builder is named by the display name on the roster. Disqualified builds
--    are left out (docs/04 §4.4). Any other phase, an abandoned battle or an
--    unknown id raise battle_not_found (P0002): the same answer, so the
--    function cannot be used to probe for running battles.

-- ─── 1. Storage write guard: allow autosave/bundle.css ────────────────────
-- Same function as in 20261004120200_storage.sql with one more file name.
-- `create or replace` keeps the grants and the policies that call it.
create or replace function public.can_write_build_object(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_parts text[];
begin
  if v_uid is null or p_name is null then
    return false;
  end if;

  v_parts := string_to_array(p_name, '/');
  -- The battle id must be the canonical (lowercase) uuid text, so that one
  -- battle cannot have two prefixes that the destroy-worker might miss.
  if coalesce(array_length(v_parts, 1), 0) not in (3, 4)
     or v_parts[1] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or v_parts[2] <> v_uid::text
     or array_to_string(v_parts[3:], '/') not in (
          'source.json', 'bundle.js', 'bundle.css', 'thumb.webp',
          'autosave/source.json', 'autosave/bundle.js', 'autosave/bundle.css')
  then
    return false;
  end if;

  return exists (
    select 1
    from public.battles b
    join public.builds bu on bu.battle_id = b.id and bu.builder_id = v_uid
    where b.id = v_parts[1]::uuid
      and b.phase in ('building'::public.battle_phase, 'shipping'::public.battle_phase)
      and bu.status = 'draft'::public.build_status
      and now() <= b.building_ends_at + private.setting_interval(b.settings, 'shipping_s')
  );
end;
$$;

-- ─── 2. The public results read ───────────────────────────────────────────
create function public.get_public_battle(p_battle_id uuid)
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
               'name', bu.name,
               'status', bu.status,
               'shipped_at', bu.shipped_at,
               'completion_ms', bu.completion_ms,
               'final_rank', bu.final_rank,
               'total_votes', bu.total_votes,
               'stats', bu.stats,
               'capture_status', bu.capture_status,
               -- Only a finished capture has a path, and it is in the public
               -- `screenshots` bucket (complete_capture checks the shape).
               'screenshot_path', case when bu.capture_status in ('captured', 'fallback')
                                       then bu.screenshot_path end)
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

revoke all on function public.get_public_battle(uuid) from public;
grant execute on function public.get_public_battle(uuid) to anon, authenticated, service_role;
