-- Build Roulette: the battle state machine for the M2 solo loop.
--
-- Client RPCs (authenticated):
--   server_now()                                      clock-offset sampling
--   start_solo_battle(display_name, time_limit_s)     → battle id
--   advance_battle(battle_id, expected_version)       → {changed, version, phase, phase_ends_at}
--   ship_build(battle_id, name, stats)                → {build, battle}
--   get_battle_snapshot(battle_id)                    → jsonb
--
-- Internal (schema `private`, not callable by any API role):
--   private.draw_challenge, private.battle_step, private.advance,
--   private.try_advance, private.finalize_solo, private.clean_build_stats,
--   private.bump, private.enqueue_destroy
--
-- docs/04 is the spec. This migration implements the SOLO path
--   spinning → building → shipping → results → destroyed
-- Solo skips REVEAL and VOTING (docs/04 §4.9). The multiplayer branches
-- (shipping → reveal, reveal, voting) raise `not_implemented` (SQLSTATE
-- 0A000) for non-solo battles until M3; they are not half-implemented.
--
-- Errors: guards raise with a stable snake_case MESSAGE that clients can map
-- (supabase-js `error.message`), and a human-readable DETAIL. SQLSTATE:
--   42501  not_authenticated, not_on_roster, not_a_member
--   P0002  battle_not_found
--   22023  invalid_time_limit, invalid_display_name, invalid_name,
--          invalid_stats, stats_too_large, invalid_version
--   P0001  wrong_phase, deadline_passed, already_shipped, files_missing,
--          battle_in_progress, deck_empty
--   0A000  not_implemented

-- ─── Helpers ──────────────────────────────────────────────────────────────

-- Bumps the version of a battle whose row the caller has locked, and appends
-- the matching battle_events row. Returns the new version.
create function private.bump(p_battle_id uuid, p_type text, p_actor uuid, p_payload jsonb)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version int;
begin
  update public.battles
     set version = version + 1
   where id = p_battle_id
  returning version into v_version;

  insert into public.battle_events (battle_id, version, type, actor_id, payload)
  values (p_battle_id, v_version, p_type, p_actor, coalesce(p_payload, '{}'::jsonb));

  return v_version;
end;
$$;

create function private.enqueue_destroy(p_battle_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.jobs (kind, ref_id)
  values ('destroy'::public.job_kind, p_battle_id)
  on conflict (kind, ref_id) do nothing;
$$;

-- Weighted random draw of BUILD, RULE and STYLE that respects the tag rules
-- and avoids cards from the caller's last 10 battles when possible.
-- Weighted sampling: order by -ln(1 - random()) / weight (exponential race),
-- which picks each card with probability weight / sum(weights).
create function private.draw_challenge(p_user_id uuid, p_time_limit_seconds int)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_recent uuid[];
  v_build  public.prompt_cards;
  v_rule   public.prompt_cards;
  v_style  public.prompt_cards;
  v_pass   int;
  v_id     uuid;
begin
  select coalesce(array_agg(card_id), '{}') into v_recent
  from (
    select unnest(array[c.build_card_id, c.rule_card_id, c.style_card_id]) as card_id
    from (
      select b.challenge_id
      from public.battle_players bp
      join public.battles b on b.id = bp.battle_id
      where bp.user_id = p_user_id
      order by b.created_at desc
      limit 10
    ) recent
    join public.challenges c on c.id = recent.challenge_id
  ) cards
  where card_id is not null;

  -- Pass 1 avoids recent cards; pass 2 (only if pass 1 found nothing that
  -- fits) allows them again.
  for v_pass in 1..2 loop
    select * into v_build
    from public.prompt_cards c
    where c.kind = 'build' and c.is_active
      and (v_pass = 2 or c.id <> all (v_recent))
    order by -ln(1.0 - random()) / c.weight
    limit 1;

    if v_build.id is null then
      continue;
    end if;

    select * into v_rule
    from public.prompt_cards c
    where c.kind = 'rule' and c.is_active
      and (v_pass = 2 or c.id <> all (v_recent))
      and private.tags_compatible(v_build.tags, c.tags)
    order by -ln(1.0 - random()) / c.weight
    limit 1;

    if v_rule.id is null then
      v_build := null;
      continue;
    end if;

    select * into v_style
    from public.prompt_cards c
    where c.kind = 'style' and c.is_active
      and (v_pass = 2 or c.id <> all (v_recent))
      and private.tags_compatible(v_build.tags, c.tags)
      and private.tags_compatible(v_rule.tags, c.tags)
    order by -ln(1.0 - random()) / c.weight
    limit 1;

    exit when v_style.id is not null;
    v_build := null;
    v_rule  := null;
  end loop;

  if v_style.id is null then
    raise exception using
      errcode = 'P0001',
      message = 'deck_empty',
      detail  = 'No compatible BUILD, RULE and STYLE cards are active.';
  end if;

  insert into public.challenges (
    build_card_id, rule_card_id, style_card_id,
    build_text, rule_text, style_text,
    build_hint, rule_hint, style_hint,
    time_limit_seconds)
  values (
    v_build.id, v_rule.id, v_style.id,
    v_build.text, v_rule.text, v_style.text,
    v_build.hint, v_rule.hint, v_style.hint,
    p_time_limit_seconds)
  returning id into v_id;

  return v_id;
end;
$$;

-- Validates and caps the client-reported build stats. They are display-only
-- (docs/01 §1.4: the client can lie), so the goal is bounded size and sane
-- types, not truth. Unknown keys are dropped; numbers above a cap are
-- clamped; a wrong type is an error.
create function private.clean_build_stats(p_stats jsonb)
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

-- ─── Results (solo) ───────────────────────────────────────────────────────
-- SHIPPING → RESULTS for a solo battle, in the caller's transaction (battle
-- row locked):
--   1. drafts with an autosave (autosave/bundle.js + autosave/source.json)
--      become auto_shipped with shipped_at = building_ends_at; the rest dnf;
--   2. one capture job per shipped/auto_shipped build;
--   3. ranks (by completion time, then shipped_at) and auto-awards:
--        clutch_ship   shipped by hand in the last 10 s of BUILD or in the grace
--        speedrun      shipped by hand using at most half of the time limit
--        fastest_ship  lowest completion time among hand-shipped builds,
--                      only when at least two builds were shipped by hand
--                      (never in solo; kept so M3 can reuse this function)
create function private.finalize_solo(p_battle_id uuid)
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
     and exists (select 1 from storage.objects o
                 where o.bucket_id = 'ephemeral-builds'
                   and o.name = format('%s/%s/autosave/bundle.js', p_battle_id, bu.builder_id))
     and exists (select 1 from storage.objects o
                 where o.bucket_id = 'ephemeral-builds'
                   and o.name = format('%s/%s/autosave/source.json', p_battle_id, bu.builder_id));

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

-- ─── The transition function ──────────────────────────────────────────────
-- Performs at most ONE transition of the docs/04 table if it is due, and
-- returns whether it did. The caller must hold the battle row lock.
create function private.battle_step(p_battle_id uuid, p_actor uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  b             public.battles;
  v_now         timestamptz := now();
  v_due         boolean;
  v_all_final   boolean;
  v_solo        boolean;
  v_limit_s     int;
  v_terminal    boolean;
  v_from        public.battle_phase;
  v_to          public.battle_phase;
  v_payload     jsonb := '{}'::jsonb;
begin
  select * into b from public.battles where id = p_battle_id;
  v_from := b.phase;
  v_due  := b.phase_ends_at is not null and v_now >= b.phase_ends_at;
  v_solo := coalesce(b.settings ->> 'mode', '') = 'solo';

  -- "Every roster player has a non-draft build". A roster without builds
  -- (never happens: builds are created with the roster) counts as final.
  -- M3: exclude players who left the room.
  v_all_final := not exists (
    select 1 from public.builds bu
    where bu.battle_id = p_battle_id and bu.status = 'draft');

  case b.phase
  when 'spinning' then
    if not v_due then return false; end if;
    select c.time_limit_seconds into v_limit_s
    from public.challenges c where c.id = b.challenge_id;
    v_to := 'building';
    update public.battles
       set phase               = v_to,
           phase_started_at    = v_now,
           building_started_at = v_now,
           building_ends_at    = v_now + make_interval(secs => v_limit_s),
           phase_ends_at       = v_now + make_interval(secs => v_limit_s)
     where id = p_battle_id;

  when 'building' then
    if not (v_due or v_all_final) then return false; end if;
    v_to := 'shipping';
    -- Everyone shipped → no grace (docs/04): SHIPPING is due immediately.
    update public.battles
       set phase            = v_to,
           phase_started_at = v_now,
           phase_ends_at    = case when v_all_final then v_now
                                   else v_now + private.setting_interval(b.settings, 'shipping_s') end
     where id = p_battle_id;
    v_payload := jsonb_build_object('early', v_all_final and not v_due);

  when 'shipping' then
    if not (v_due or v_all_final) then return false; end if;
    if not v_solo then
      raise exception using
        errcode = '0A000',
        message = 'not_implemented',
        detail  = 'SHIPPING → REVEAL (multiplayer) is not implemented until M3.';
    end if;
    -- Solo: REVEAL and VOTING are skipped (docs/04 §4.9).
    perform private.finalize_solo(p_battle_id);
    v_to := 'results';
    update public.battles
       set phase             = v_to,
           phase_started_at  = v_now,
           phase_ends_at     = v_now + private.setting_interval(b.settings, 'results_s'),
           shipping_ended_at = v_now,
           finished_at       = v_now,
           is_complete       = true
     where id = p_battle_id;

  when 'results' then
    if not v_due then return false; end if;
    v_terminal := not exists (
      select 1 from public.builds bu
      where bu.battle_id = p_battle_id
        and bu.status in ('shipped', 'auto_shipped')
        and bu.capture_status = 'pending');
    if not v_terminal
       and v_now <= b.shipping_ended_at + private.setting_interval(b.settings, 'capture_deadline_s') then
      return false;   -- wait for screenshots (sweep_deadlines retries)
    end if;
    if not v_terminal then
      -- Capture deadline hit: the sources are about to be destroyed, so the
      -- remaining captures can never succeed.
      update public.builds
         set capture_status = 'failed'
       where battle_id = p_battle_id
         and status in ('shipped', 'auto_shipped')
         and capture_status = 'pending';
      update public.jobs j
         set status = 'failed', last_error = 'capture deadline passed', updated_at = v_now
        from public.builds bu
       where j.kind = 'capture' and j.ref_id = bu.id and bu.battle_id = p_battle_id
         and j.status in ('queued', 'running');
      v_payload := jsonb_build_object('capture_deadline', true);
    end if;
    v_to := 'destroyed';
    update public.battles
       set phase            = v_to,
           phase_started_at = v_now,
           phase_ends_at    = null
     where id = p_battle_id;
    perform private.enqueue_destroy(p_battle_id);

  when 'reveal', 'voting' then
    raise exception using
      errcode = '0A000',
      message = 'not_implemented',
      detail  = format('Phase %s (multiplayer) is not implemented until M3.', b.phase);

  else
    return false;   -- destroyed, abandoned: terminal
  end case;

  perform private.bump(p_battle_id, 'phase', p_actor,
    v_payload || jsonb_build_object('from', v_from, 'to', v_to));
  return true;
end;
$$;

-- Locks the battle, applies the compare-and-set on `version` (skipped when
-- p_expected_version is null: internal callers), then performs every
-- transition that is due, in order. Several steps can be due at once, e.g.
-- BUILDING → SHIPPING → RESULTS when the last player ships.
create function private.advance(p_battle_id uuid, p_expected_version int, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  b         public.battles;
  v_changed boolean := false;
  v_steps   int := 0;
begin
  select * into b from public.battles where id = p_battle_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'battle_not_found',
      detail = 'No such battle.';
  end if;

  if p_expected_version is null or b.version = p_expected_version then
    -- The phase graph only moves forward (at most 4 steps from SPINNING to
    -- DESTROYED); the bound is a safety net.
    loop
      exit when v_steps >= 8 or not private.battle_step(p_battle_id, p_actor);
      v_changed := true;
      v_steps   := v_steps + 1;
    end loop;
    select * into b from public.battles where id = p_battle_id;
  end if;

  return jsonb_build_object(
    'changed', v_changed,
    'version', b.version,
    'phase', b.phase,
    'phase_ends_at', b.phase_ends_at);
end;
$$;

-- Event-driven early advance (docs/04 §4.5, item 3), called at the end of
-- ship_build and complete_capture with the battle row already locked.
create function private.try_advance(p_battle_id uuid, p_actor uuid)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.advance(p_battle_id, null, p_actor);
$$;

-- ─── Client RPCs ──────────────────────────────────────────────────────────

create function public.server_now()
returns timestamptz
language sql
volatile
security definer
set search_path = ''
as $$
  select clock_timestamp();
$$;

-- Starts a solo battle for the caller and returns its id. The battle is in
-- SPINNING for 6 s (the spin animation lands on the challenge in the
-- snapshot), then BUILDING.
--   p_display_name        1–24 characters; upserted into profiles
--   p_time_limit_seconds  one of 180/300/600/900/1200/1800, or null for a
--                         random 5/10/15 minutes (the roulette picks)
-- One active solo battle per player: while one is in SPINNING, BUILDING or
-- SHIPPING, another start raises battle_in_progress (DETAIL holds its id).
create function public.start_solo_battle(p_display_name text, p_time_limit_seconds int default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid       uuid := auth.uid();
  v_name      text := btrim(p_display_name);
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
  if v_name is null or char_length(v_name) not between 1 and 24 or v_name ~ '[[:cntrl:]]' then
    raise exception using errcode = '22023', message = 'invalid_display_name',
      detail = 'The display name must be 1 to 24 characters.';
  end if;
  if v_limit is null then
    v_limit := (array[300, 600, 900])[1 + floor(random() * 3)::int];
  elsif not v_limit = any (private.build_time_limits_seconds()) then
    raise exception using errcode = '22023', message = 'invalid_time_limit',
      detail = format('The time limit must be one of %s seconds.', private.build_time_limits_seconds());
  end if;

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

-- The only public transition entry point (docs/04 §4.5). Any battle member
-- may nudge it when their countdown reaches zero; the service role may too.
-- A stale version or a deadline that is not due yet returns changed = false.
create function public.advance_battle(p_battle_id uuid, p_expected_version int)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null and coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'not_authenticated',
      detail = 'Sign in first.';
  end if;
  if p_expected_version is null then
    raise exception using errcode = '22023', message = 'invalid_version',
      detail = 'expected_version is required (compare-and-set).';
  end if;
  if v_uid is not null and not public.is_battle_member(p_battle_id) then
    -- Same answer for "does not exist" and "not yours".
    raise exception using errcode = 'P0002', message = 'battle_not_found',
      detail = 'No such battle.';
  end if;

  return private.advance(p_battle_id, p_expected_version, v_uid);
end;
$$;

-- Ships the caller's build (docs/04 §4.4, §4.5). Ship is final.
-- Guards, in order: caller on the roster; the build is still a draft;
-- phase BUILDING or SHIPPING; now() <= building_ends_at + shipping grace;
-- a valid name and stats;
-- {battle_id}/{uid}/source.json and bundle.js exist in ephemeral-builds.
-- Returns {build: {...}, battle: {version, phase, phase_ends_at}} after the
-- early advance (the battle is usually in RESULTS already in solo).
create function public.ship_build(p_battle_id uuid, p_name text, p_stats jsonb default '{}'::jsonb)
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

-- One round trip for the client sync loop (docs/04 §4.7). Visible to battle
-- members, and to every signed-in user once the battle is in RESULTS or
-- DESTROYED (public results pages); otherwise battle_not_found.
-- Never contains storage paths of the ephemeral bucket or votes.
create function public.get_battle_snapshot(p_battle_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  b     public.battles;
  v_out jsonb;
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

  select jsonb_build_object(
    'server_now', clock_timestamp(),
    'me', jsonb_build_object(
      'user_id', v_uid,
      'is_player', exists (select 1 from public.battle_players bp
                           where bp.battle_id = b.id and bp.user_id = v_uid)),
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
               'name', bu.name,
               'status', bu.status,
               'shipped_at', bu.shipped_at,
               'completion_ms', bu.completion_ms,
               'stats', bu.stats,
               'capture_status', bu.capture_status,
               'screenshot_path', bu.screenshot_path,
               'captured_at', bu.captured_at,
               'source_destroyed_at', bu.source_destroyed_at,
               'final_rank', bu.final_rank,
               'total_votes', bu.total_votes) order by bu.final_rank nulls last, bu.created_at, bu.id)
      from public.builds bu where bu.battle_id = b.id), '[]'::jsonb),
    'awards', coalesce((
      select jsonb_agg(jsonb_build_object(
               'build_id', a.build_id,
               'award', a.award,
               'source', a.source,
               'votes', a.votes) order by a.award, a.build_id)
      from public.awards a where a.battle_id = b.id), '[]'::jsonb)
  ) into v_out;

  return v_out;
end;
$$;

-- ─── Privileges ───────────────────────────────────────────────────────────
revoke all on function private.bump(uuid, text, uuid, jsonb)        from public, anon, authenticated;
revoke all on function private.enqueue_destroy(uuid)                from public, anon, authenticated;
revoke all on function private.draw_challenge(uuid, int)            from public, anon, authenticated;
revoke all on function private.clean_build_stats(jsonb)             from public, anon, authenticated;
revoke all on function private.finalize_solo(uuid)                  from public, anon, authenticated;
revoke all on function private.battle_step(uuid, uuid)              from public, anon, authenticated;
revoke all on function private.advance(uuid, int, uuid)             from public, anon, authenticated;
revoke all on function private.try_advance(uuid, uuid)              from public, anon, authenticated;

revoke all on function public.server_now()                          from public, anon;
revoke all on function public.start_solo_battle(text, int)          from public, anon;
revoke all on function public.advance_battle(uuid, int)             from public, anon;
revoke all on function public.ship_build(uuid, text, jsonb)         from public, anon;
revoke all on function public.get_battle_snapshot(uuid)             from public, anon;

grant execute on function public.server_now()                       to authenticated, service_role;
grant execute on function public.start_solo_battle(text, int)       to authenticated;
grant execute on function public.advance_battle(uuid, int)          to authenticated, service_role;
grant execute on function public.ship_build(uuid, text, jsonb)      to authenticated;
grant execute on function public.get_battle_snapshot(uuid)          to authenticated;
