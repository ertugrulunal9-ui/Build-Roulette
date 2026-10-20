-- Build Roulette (T-046, M6): import mode (docs/09-import-mode.md §9.4, §9.7).
--
-- Players build a site with their own tools and import the BUILT static site. One import
-- becomes one immutable site pack (`@br/site`, `BRSITE1` format), stored as ONE object, so
-- the bucket keeps a fixed allowlist of file names (no free file hosting):
--
--   ephemeral-builds/{battle}/{uid}/autosave/site.bin   every import during BUILD
--   ephemeral-builds/{battle}/{uid}/site.bin            SHIP
--   ephemeral-builds/{battle}/{uid}/thumb.webp          SHIP (client thumbnail, capture fallback)
--
-- Replaced (same signatures and grants; only what is listed changes):
--   can_write_build_object  the writable names are exactly site.bin, thumb.webp and
--                           autosave/site.bin (same draft + deadline rule, same path checks)
--   ship_build              requires {battle}/{uid}/site.bin (`files_missing`)
--   finalize_solo,          a draft is auto-shipped when autosave/site.bin exists (was
--   close_shipping          autosave/bundle.js + autosave/source.json); private.has_autosave
--   reveal_file_names       {site, thumb}: shipped site.bin + thumb.webp, auto-shipped
--                           autosave/site.bin + null. can_read_revealed_object and
--                           get_reveal_builds read the names from here, so REVEAL reads and
--                           `get_reveal_builds().files` follow (files: {site, thumb})
--   get_reveal_builds       a taken-down build's files are {site: null, thumb: null}
--   clean_build_stats       accepts `imports` (how many imports the player made); the older
--                           keys are still accepted, so rows written before stay valid
--   build_time_limits_seconds  10, 15, 20, 30, 45 minutes (were 3, 5, 10, 15, 20, 30)
--   start_solo_battle,      the random time limit (solo without a choice, every room battle)
--   start_battle            draws from private.random_build_time_limits_seconds(): 10, 15 or
--                           20 minutes (was 5, 10 or 15)
--
-- The bucket allows `application/octet-stream` (the pack) and `image/webp` (the thumbnail);
-- the file size limit stays 5 MB (`SITE_LIMITS.maxPackBytes`). There is no source.json any
-- more, so nothing private stays behind: what a player imports is exactly what the other
-- members see in REVEAL. DESTROY is unchanged (the whole {battle}/ prefix).
--
-- Nothing is rewritten: challenges keep their time limit (2700 already fits the
-- time_limit_seconds check, 60..3600), builds keep their stats, and objects uploaded under the
-- old names are still deleted by DESTROY. A battle running across this migration whose
-- player uploaded only the old names can no longer ship or be auto-shipped (DNF); the web app
-- and this migration ship together (T-047).

-- ─── Bucket ───────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('ephemeral-builds', 'ephemeral-builds', false, 5 * 1024 * 1024,
   array['application/octet-stream', 'image/webp'])
on conflict (id) do update set
  public             = excluded.public,
  file_size_limit    = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- ─── Writes: site.bin, thumb.webp, autosave/site.bin ──────────────────────
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
     or array_to_string(v_parts[3:], '/') not in ('site.bin', 'thumb.webp', 'autosave/site.bin')
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

-- ─── Auto-ship: the autosave is one site pack ─────────────────────────────
-- True when the player's last import during BUILD is in storage.
create function private.has_autosave(p_battle_id uuid, p_builder_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from storage.objects o
                 where o.bucket_id = 'ephemeral-builds'
                   and o.name = format('%s/%s/autosave/site.bin', p_battle_id, p_builder_id))
$$;

revoke all on function private.has_autosave(uuid, uuid) from public, anon, authenticated;

-- Solo results (replaces T-011's; only the auto-ship condition changed).
create or replace function private.finalize_solo(p_battle_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.battles;
  v_limit_ms int;
begin
  select * into b from public.battles where id = p_battle_id;

  select c.time_limit_seconds * 1000 into v_limit_ms
  from public.challenges c where c.id = b.challenge_id;

  update public.builds bu
     set status        = 'auto_shipped',
         shipped_at    = b.building_ends_at,
         completion_ms = greatest(0, (extract(epoch from b.building_ends_at - b.building_started_at) * 1000)::int)
   where bu.battle_id = p_battle_id
     and bu.status = 'draft'
     and private.has_autosave(p_battle_id, bu.builder_id);

  update public.builds
     set status = 'dnf'
   where battle_id = p_battle_id
     and status = 'draft';

  insert into public.jobs (kind, ref_id)
  select 'capture'::public.job_kind, bu.id
  from public.builds bu
  where bu.battle_id = p_battle_id
    and bu.status in ('shipped', 'auto_shipped')
  on conflict (kind, ref_id) do nothing;

  update public.builds bu
     set final_rank = ranked.rank
    from (
      select id, rank() over (order by completion_ms, shipped_at) as rank
      from public.builds
      where battle_id = p_battle_id
        and status in ('shipped', 'auto_shipped')
    ) ranked
   where bu.id = ranked.id;

  insert into public.awards (battle_id, build_id, award, source)
  select p_battle_id, bu.id, 'clutch_ship', 'auto'
  from public.builds bu
  where bu.battle_id = p_battle_id
    and bu.status = 'shipped'
    and bu.shipped_at >= b.building_ends_at - interval '10 seconds';

  insert into public.awards (battle_id, build_id, award, source)
  select p_battle_id, bu.id, 'speedrun', 'auto'
  from public.builds bu
  where bu.battle_id = p_battle_id
    and bu.status = 'shipped'
    and bu.completion_ms * 2 <= v_limit_ms;

  insert into public.awards (battle_id, build_id, award, source)
  select p_battle_id, bu.id, 'fastest_ship', 'auto'
  from public.builds bu
  where bu.battle_id = p_battle_id
    and bu.status = 'shipped'
    and (select count(*) from public.builds x
         where x.battle_id = p_battle_id and x.status = 'shipped') >= 2
    and bu.completion_ms = (select min(x.completion_ms) from public.builds x
                            where x.battle_id = p_battle_id and x.status = 'shipped');
end;
$$;

-- End of SHIPPING of a room battle (replaces T-019's; only the auto-ship condition changed).
create or replace function private.close_shipping(p_battle_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.battles;
begin
  select * into b from public.battles where id = p_battle_id;

  update public.builds bu
     set status        = 'auto_shipped',
         shipped_at    = b.building_ends_at,
         completion_ms = greatest(0, (extract(epoch from b.building_ends_at - b.building_started_at) * 1000)::int)
   where bu.battle_id = p_battle_id
     and bu.status = 'draft'
     and private.has_autosave(p_battle_id, bu.builder_id);

  update public.builds
     set status = 'dnf'
   where battle_id = p_battle_id
     and status = 'draft';

  insert into public.jobs (kind, ref_id)
  select 'capture'::public.job_kind, bu.id
  from public.builds bu
  where bu.battle_id = p_battle_id
    and bu.status in ('shipped', 'auto_shipped')
  on conflict (kind, ref_id) do nothing;
end;
$$;

-- ─── ship_build (replaces T-024's; only the file check changed) ──────────
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

  -- T-046: the site pack of the last import.
  if not exists (select 1 from storage.objects o
                 where o.bucket_id = 'ephemeral-builds'
                   and o.name = format('%s/%s/site.bin', p_battle_id, v_uid)) then
    raise exception using errcode = 'P0001', message = 'files_missing',
      detail = 'Upload site.bin before shipping.';
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

-- ─── REVEAL: the one site path ────────────────────────────────────────────
-- Object names (relative to the bucket) of the files a build exposes during REVEAL. Empty
-- for builds that are not final. can_read_revealed_object (the storage read policy) and
-- get_reveal_builds take their names from here.
create or replace function private.reveal_file_names(p_battle_id uuid, p_builder_id uuid, p_status public.build_status)
returns jsonb
language sql
immutable
security definer
set search_path = ''
as $$
  select case p_status
    when 'shipped' then jsonb_build_object(
      'site',  format('%s/%s/site.bin', p_battle_id, p_builder_id),
      'thumb', format('%s/%s/thumb.webp', p_battle_id, p_builder_id))
    when 'auto_shipped' then jsonb_build_object(
      'site',  format('%s/%s/autosave/site.bin', p_battle_id, p_builder_id),
      'thumb', null)   -- an autosave has no thumbnail
    else '{}'::jsonb
  end
$$;

-- get_reveal_builds (replaces T-024's): `files` is {site, thumb}; a taken-down build keeps
-- its position with no files.
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
               then jsonb_build_object('site', null, 'thumb', null)
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

-- ─── Stats: `imports` ─────────────────────────────────────────────────────
-- Validates and caps the client-reported build stats (display-only, docs/01 §1.4). Import
-- mode reports `files`, `bundle_bytes` (the pack size) and `imports`; `lines`, `rebuilds`,
-- `pastes` and `deps` (the in-browser editor's) are still accepted.
create or replace function private.clean_build_stats(p_stats jsonb)
returns jsonb
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  v_out  jsonb := '{}'::jsonb;
  v_key  text;
  v_cap  numeric;
  v_val  jsonb;
  v_num  numeric;
  v_deps text[] := '{}';
  v_dep  jsonb;
begin
  if p_stats is null or p_stats = 'null'::jsonb then
    return v_out;
  end if;
  if jsonb_typeof(p_stats) <> 'object' then
    raise exception using errcode = '22023', message = 'invalid_stats',
      detail = 'stats must be a JSON object';
  end if;
  if octet_length(p_stats::text) > 8192 then
    raise exception using errcode = '22023', message = 'stats_too_large',
      detail = 'stats must be at most 8 KB of JSON';
  end if;

  for v_key, v_cap in
    select * from (values
      ('files', 500::numeric),
      ('lines', 100000),
      ('bundle_bytes', 5 * 1024 * 1024),
      ('imports', 100000),
      ('rebuilds', 100000),
      ('pastes', 100000)) as caps(key, cap)
  loop
    v_val := p_stats -> v_key;
    continue when v_val is null or v_val = 'null'::jsonb;
    if jsonb_typeof(v_val) <> 'number' then
      raise exception using errcode = '22023', message = 'invalid_stats',
        detail = format('stats.%s must be a number', v_key);
    end if;
    v_num := v_val::text::numeric;
    if v_num < 0 or v_num <> trunc(v_num) then
      raise exception using errcode = '22023', message = 'invalid_stats',
        detail = format('stats.%s must be a non-negative integer', v_key);
    end if;
    v_out := v_out || jsonb_build_object(v_key, least(v_num, v_cap));
  end loop;

  v_val := p_stats -> 'deps';
  if v_val is not null and v_val <> 'null'::jsonb then
    if jsonb_typeof(v_val) <> 'array' then
      raise exception using errcode = '22023', message = 'invalid_stats',
        detail = 'stats.deps must be an array of package names';
    end if;
    for v_dep in select value from jsonb_array_elements(v_val) loop
      -- npm package name rules: at most 214 characters, lowercase, optional scope.
      if jsonb_typeof(v_dep) <> 'string'
         or char_length(v_dep #>> '{}') > 214
         or (v_dep #>> '{}') !~ '^(@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*$'
      then
        raise exception using errcode = '22023', message = 'invalid_stats',
          detail = 'stats.deps must contain npm package names';
      end if;
      if not (v_dep #>> '{}') = any (v_deps) and cardinality(v_deps) < 50 then
        v_deps := v_deps || (v_dep #>> '{}');
      end if;
    end loop;
    v_out := v_out || jsonb_build_object('deps', to_jsonb(v_deps));
  end if;

  return v_out;
end;
$$;

-- ─── Build time limits: 10, 15, 20, 30, 45 minutes ────────────────────────
-- packages/game/src/schema-drift.test.ts parses the two functions below (the last
-- definition across the migrations) and compares them with BUILD_TIME_LIMITS_MINUTES and
-- RANDOM_BUILD_TIME_LIMITS_MINUTES. Keep each `array[...]` a flat literal list.
create or replace function private.build_time_limits_seconds()
returns int[]
language sql
immutable
security definer
set search_path = ''
as $$
  select array[600, 900, 1200, 1800, 2700]
$$;

-- The limits the server draws from when nobody chose one (a solo start without a limit,
-- every room battle): 10, 15 or 20 minutes.
create function private.random_build_time_limits_seconds()
returns int[]
language sql
immutable
security definer
set search_path = ''
as $$
  select array[600, 900, 1200]
$$;

-- One of random_build_time_limits_seconds(), uniformly.
create function private.draw_build_time_limit()
returns int
language sql
volatile
security definer
set search_path = ''
as $$
  select l[1 + floor(random() * cardinality(l))::int]
  from (select private.random_build_time_limits_seconds() as l) s
$$;

revoke all on function private.random_build_time_limits_seconds() from public, anon, authenticated;
revoke all on function private.draw_build_time_limit()            from public, anon, authenticated;

-- ─── start_solo_battle (replaces T-024's; only the random time limit changed) ──
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
    -- T-046: 10, 15 or 20 minutes.
    v_limit := private.draw_build_time_limit();
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

-- ─── start_battle (replaces T-019's; only the random time limit changed) ──
create or replace function public.start_battle(p_room_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid       uuid := private.require_auth();
  r           public.rooms;
  v_roster    uuid[];
  v_limit     int;
  v_challenge uuid;
  v_settings  jsonb;
  v_battle    uuid;
  v_user      uuid;
begin
  r := private.lock_room_for(p_room_id);
  perform private.require_active_member(p_room_id, v_uid);
  perform private.touch_member(p_room_id, v_uid);
  perform private.ensure_host(p_room_id, v_uid);
  select * into r from public.rooms where id = p_room_id;
  if r.host_id <> v_uid then
    raise exception using errcode = '42501', message = 'not_host',
      detail = 'Only the host can start the battle.';
  end if;
  if r.status <> 'open' then
    raise exception using errcode = 'P0001', message = 'wrong_room_state',
      detail = format('A battle can only start while the room is open (it is %s).', r.status);
  end if;

  select coalesce(array_agg(user_id order by joined_at, user_id), '{}') into v_roster
  from (
    select m.user_id, m.joined_at
    from public.room_members m
    where m.room_id = p_room_id
      and m.role = 'player'
      and m.is_ready
      and private.is_present(m)
    order by m.joined_at, m.user_id
    limit private.room_max_players(r.settings)
  ) ready;
  if cardinality(v_roster) < private.room_limit('min_players') then
    raise exception using errcode = 'P0001', message = 'not_enough_players',
      detail = format('%s ready players are needed; %s are ready and here.',
                      private.room_limit('min_players'), cardinality(v_roster));
  end if;

  -- T-046: 10, 15 or 20 minutes.
  v_limit     := private.draw_build_time_limit();
  v_challenge := private.draw_challenge_avoiding(private.room_recent_cards(p_room_id, v_roster), v_limit);
  v_settings  := private.default_battle_settings()
              || jsonb_build_object(
                   'mode', 'multiplayer',
                   'reveal_vote', coalesce((r.settings ->> 'reveal_vote')::boolean,
                                           private.reveal_vote_default()))
              || jsonb_strip_nulls(jsonb_build_object(
                   'reveal_slot_s', r.settings -> 'reveal_slot_s',
                   'voting_s', r.settings -> 'voting_s'));

  insert into public.battles (room_id, challenge_id, host_id, phase, version,
                              phase_started_at, phase_ends_at, settings)
  values (p_room_id, v_challenge, v_uid, 'spinning', 0,
          now(), now() + private.setting_interval(v_settings, 'spinning_s'), v_settings)
  returning id into v_battle;

  insert into public.battle_players (battle_id, user_id, display_name)
  select v_battle, p.id, p.display_name
  from public.profiles p
  where p.id = any (v_roster);

  insert into public.builds (battle_id, builder_id)
  select v_battle, u from unnest(v_roster) as u;

  perform private.bump(v_battle, 'phase', v_uid,
    jsonb_build_object('from', null, 'to', 'spinning', 'mode', 'multiplayer',
                       'challenge_id', v_challenge, 'roster', to_jsonb(v_roster)));

  update public.rooms set status = 'in_battle', current_battle_id = v_battle where id = p_room_id;
  perform private.room_bump(p_room_id, 'battle_started', v_uid, jsonb_build_object('battle_id', v_battle));

  for v_user in
    select m.user_id from public.room_members m
    where m.room_id = p_room_id and m.is_ready
    order by m.joined_at, m.user_id
  loop
    update public.room_members set is_ready = false where room_id = p_room_id and user_id = v_user;
    perform private.room_bump(p_room_id, 'member_ready', null,
      jsonb_build_object('user_id', v_user, 'is_ready', false));
  end loop;

  return v_battle;
end;
$$;
