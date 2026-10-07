-- Build Roulette (T-019, M4): what the REVEAL reads from the ephemeral-builds
-- bucket, and the RPC that says where it is.
--
-- ─── The rule ─────────────────────────────────────────────────────────────
-- From REVEAL until DESTROYED (phases reveal, voting, results), every battle
-- member (roster players and spectators of the room; never kicked users, never
-- strangers, never `anon`) may READ the final artifacts of the builds in
-- reveal_order, and nothing else:
--
--   build status    readable files under {battle}/{builder}/
--   shipped         bundle.js, bundle.css, manifest.json, thumb.webp
--   auto_shipped    autosave/bundle.js, autosave/bundle.css, autosave/manifest.json
--
-- So drafts, a DNF player's autosave, the autosave of a build that was shipped
-- by hand, the top-level files of an auto-shipped build, disqualified builds,
-- and everything before REVEAL stay readable by their owner only (the T-011
-- policy). Battles that skipped REVEAL (reveal_vote = false, or fewer than 2
-- final builds) have an empty reveal_order, so nobody reads anyone else's
-- files there, exactly as in M3. ABANDONED battles are not readable either.
--
-- ─── source.json stays private: manifest.json ─────────────────────────────
-- The reveal only needs what the capture worker needs: the bundle, its CSS
-- and an import map, which is built from the manifest's pinned dependencies
-- (react / react-dom versions; @br/runtime buildImportMap ignores anything
-- else). source.json holds the whole workspace (every source file); exposing
-- it would hand every player's code to every member, which the game does not
-- need and which outlives the screen time of a 30–60 s slot. Instead the
-- client uploads a small `manifest.json` next to the bundle when it ships, and
-- `autosave/manifest.json` with each autosave (both are now writable under
-- the usual draft + deadline rule). Its content is untrusted, like everything
-- a build produces: the reveal page must validate it the way the capture
-- page does. A build without a manifest is revealed with an empty import map
-- (the same fallback as the capture worker), so older clients degrade
-- instead of breaking; ship_build does not require it (yet).
--
-- ─── Spectators ───────────────────────────────────────────────────────────
-- Yes: the reveal is a show for the whole room, spectators watch it live on
-- the same timeline, and they already see everything else about the battle
-- (they cannot vote). Kicked members and strangers get nothing: storage reads
-- go through is_battle_member, like the battle topic.

-- ─── Writes: allow manifest.json and autosave/manifest.json ───────────────
-- Same function as in 20261006120000 with two more file names.
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
          'source.json', 'bundle.js', 'bundle.css', 'thumb.webp', 'manifest.json',
          'autosave/source.json', 'autosave/bundle.js', 'autosave/bundle.css',
          'autosave/manifest.json')
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

-- ─── The revealable files of a build ──────────────────────────────────────
-- Object names (relative to the bucket) of the files a build exposes during
-- REVEAL, by role. Empty for builds that are not final.
create function private.reveal_file_names(p_battle_id uuid, p_builder_id uuid, p_status public.build_status)
returns jsonb
language sql
immutable
security definer
set search_path = ''
as $$
  select case p_status
    when 'shipped' then jsonb_build_object(
      'js',       format('%s/%s/bundle.js', p_battle_id, p_builder_id),
      'css',      format('%s/%s/bundle.css', p_battle_id, p_builder_id),
      'manifest', format('%s/%s/manifest.json', p_battle_id, p_builder_id),
      'thumb',    format('%s/%s/thumb.webp', p_battle_id, p_builder_id))
    when 'auto_shipped' then jsonb_build_object(
      'js',       format('%s/%s/autosave/bundle.js', p_battle_id, p_builder_id),
      'css',      format('%s/%s/autosave/bundle.css', p_battle_id, p_builder_id),
      'manifest', format('%s/%s/autosave/manifest.json', p_battle_id, p_builder_id),
      'thumb',    null)   -- an autosave has no thumbnail
    else '{}'::jsonb
  end
$$;

-- ─── Read guard ───────────────────────────────────────────────────────────
-- True when the caller may read `p_name` in ephemeral-builds because it is a
-- revealed artifact of another player (see the rule at the top). In `public`
-- like the other RLS helpers, because the storage policy runs as
-- `authenticated`. It only answers a question about the caller.
create function public.can_read_revealed_object(p_name text)
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
        and exists (select 1
                    from jsonb_each_text(private.reveal_file_names(b.id, bu.builder_id, bu.status)) f
                    where f.value = p_name))
    and public.is_battle_member(v_battle);
end;
$$;

revoke all on function public.can_read_revealed_object(text) from public, anon;
grant execute on function public.can_read_revealed_object(text) to authenticated, service_role;
revoke all on function private.reveal_file_names(uuid, uuid, public.build_status) from public, anon, authenticated;

create policy "ephemeral-builds: battle members read revealed builds"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'ephemeral-builds'
    and public.can_read_revealed_object(name)
  );

-- ─── get_reveal_builds ────────────────────────────────────────────────────
-- The builds of the reveal, in reveal order, with the object names to fetch
-- from ephemeral-builds (Storage download or createSignedUrl). For battle
-- members (roster and spectators, not kicked) in REVEAL, VOTING or RESULTS;
-- otherwise battle_not_found (not a member) or wrong_phase. Returns
--   [{build_id, position, name, builder_id, builder_name, status,
--     files: {js, css, manifest, thumb}}]
-- position is 0-based, like reveal_index. A file is null when it was never
-- uploaded (css and manifest are optional; thumb only exists for builds
-- shipped by hand), so the client never has to probe. An auto-shipped build's
-- files are under autosave/. The list is empty when the battle skipped REVEAL.
create function public.get_reveal_builds(p_battle_id uuid)
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
             'name', bu.name,
             'builder_id', bu.builder_id,
             'builder_name', bp.display_name,
             'status', bu.status,
             'files', (
               select jsonb_object_agg(f.key, case when exists (
                          select 1 from storage.objects so
                          where so.bucket_id = 'ephemeral-builds' and so.name = f.value)
                        then f.value end)
               from jsonb_each_text(private.reveal_file_names(b.id, bu.builder_id, bu.status)) f))
           order by o.n)
    from unnest(b.reveal_order) with ordinality o(build_id, n)
    join public.builds bu on bu.id = o.build_id
    join public.battle_players bp on bp.battle_id = bu.battle_id and bp.user_id = bu.builder_id
    where bu.status in ('shipped', 'auto_shipped')), '[]'::jsonb);
end;
$$;

revoke all on function public.get_reveal_builds(uuid) from public, anon;
grant execute on function public.get_reveal_builds(uuid) to authenticated;
