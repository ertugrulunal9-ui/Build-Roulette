-- Build Roulette (T-016, M3): multiplayer battles in rooms.
--
-- Client RPC (authenticated):
--   start_battle(room_id)   → battle id (host only)
-- Replaced (same signatures and grants; solo behaviour unchanged):
--   private.draw_challenge  now delegates to private.draw_challenge_avoiding
--   private.battle_step     multiplayer early transition, SHIPPING → RESULTS
--                           for M3 battles, room reopens at the end
--   public.ship_build       kicked / left / disqualified guards
--   public.get_battle_snapshot  multiplayer fields (me.role, me.is_host,
--                           players[].state); the solo shape is unchanged
-- New internal helpers: private.finalize_results, private.on_battle_ended,
--   private.abandon_battle, private.room_recent_cards.
--
-- ─── The M3 flow and the M4 seam ──────────────────────────────────────────
-- Multiplayer battles run spinning → building → shipping → results →
-- destroyed, like solo (user decision 2026-10-06). start_battle snapshots
-- `"reveal_vote": false` into battles.settings, and battle_step reads that
-- flag at the end of SHIPPING:
--   solo, or reveal_vote = false   → finalize, RESULTS
--   otherwise                       → REVEAL (not_implemented until M4)
-- M4 implements the REVEAL and VOTING branches of battle_step, has
-- start_battle snapshot `reveal_vote: true`, and extends finalize_results
-- with the vote tally. Nothing else in the transition table has to change,
-- and battles started before M4 finish on the M3 path.
--
-- ─── Ranking (M3, no votes yet) ───────────────────────────────────────────
-- Among shipped and auto_shipped builds:
--   1. lower completion_ms first;
--   2. at equal completion_ms, a build shipped by hand before an auto-shipped
--      one (both are capped at the time limit when shipped in the grace);
--   3. then earlier shipped_at.
-- Builds equal on all three share a rank (rank(), so 1, 1, 3): in practice two
-- auto-shipped builds, which are both stamped at building_ends_at with the full
-- time limit. DNF and disqualified builds get no rank.
-- Auto-awards: clutch_ship (by hand in the last 10 s or the grace), speedrun
-- (by hand within half of the time limit) and fastest_ship (lowest
-- completion_ms among builds shipped by hand, only when at least two were;
-- ties share the award). Auto-shipped, DNF and disqualified builds get none.

-- ─── The draw, parameterised by the cards to avoid ────────────────────────
-- Same algorithm as the T-011 draw (weighted exponential race, tag rules,
-- pass 2 allows recent cards again), with the recent cards passed in.
create function private.draw_challenge_avoiding(p_recent uuid[], p_time_limit_seconds int)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_recent uuid[] := coalesce(p_recent, '{}');
  v_build  public.prompt_cards;
  v_rule   public.prompt_cards;
  v_style  public.prompt_cards;
  v_pass   int;
  v_id     uuid;
begin
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

-- The solo draw: the player's last 10 battles are "recent". Same behaviour as
-- before, now through draw_challenge_avoiding.
create or replace function private.draw_challenge(p_user_id uuid, p_time_limit_seconds int)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_recent uuid[];
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

  return private.draw_challenge_avoiding(v_recent, p_time_limit_seconds);
end;
$$;

-- Cards a room should avoid: those of the room's last 10 battles, plus each
-- roster player's last 5 battles anywhere (solo or other rooms).
create function private.room_recent_cards(p_room_id uuid, p_roster uuid[])
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(distinct card_id), '{}')
  from (
    select unnest(array[c.build_card_id, c.rule_card_id, c.style_card_id]) as card_id
    from (
      (select b.challenge_id from public.battles b
       where b.room_id = p_room_id
       order by b.created_at desc
       limit 10)
      union
      select x.challenge_id
      from (
        select b.challenge_id,
               row_number() over (partition by bp.user_id order by b.created_at desc) as n
        from public.battle_players bp
        join public.battles b on b.id = bp.battle_id
        where bp.user_id = any (p_roster)
      ) x
      where x.n <= 5
    ) recent
    join public.challenges c on c.id = recent.challenge_id
  ) cards
  where card_id is not null
$$;

-- ─── Results (multiplayer, M3) ────────────────────────────────────────────
-- SHIPPING → RESULTS for a room battle, in the caller's transaction (battle row
-- locked). Auto-ship and DNF as in solo (every remaining draft, including
-- those of players who left); capture jobs; ranks and auto-awards as described
-- at the top. M4 adds the vote tally here.
create function private.finalize_results(p_battle_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  b          public.battles;
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
      select id, rank() over (order by completion_ms,
                                       (status = 'auto_shipped'),
                                       shipped_at) as rank
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

-- Called once a battle is terminal (DESTROYED or ABANDONED), battle row locked
-- (the lock order is battle → room). If it is its room's current battle, the
-- room goes back to `open` (a rematch is a new battle in the same room) and
-- waiting spectators fill free player slots. rooms.current_battle_id keeps
-- pointing at the finished battle until the next start, so the lobby can link
-- to its results.
create function private.on_battle_ended(p_battle_id uuid, p_actor uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.battles;
  r public.rooms;
begin
  select * into b from public.battles where id = p_battle_id;
  if b.room_id is null then
    return;
  end if;
  select * into r from public.rooms where id = b.room_id for update;
  if not found or r.status <> 'in_battle' or r.current_battle_id is distinct from p_battle_id then
    return;
  end if;

  update public.rooms set status = 'open' where id = r.id;
  perform private.room_bump(r.id, 'battle_ended', p_actor,
    jsonb_build_object('battle_id', p_battle_id, 'phase', b.phase));
  perform private.fill_player_slots(r.id, p_actor);
end;
$$;

-- Any non-terminal phase → ABANDONED (battle row locked): results stay
-- partial (is_complete = false), pending captures can never finish, the
-- destroy job is queued and the room reopens.
create function private.abandon_battle(p_battle_id uuid, p_reason text, p_actor uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.battles;
begin
  select * into b from public.battles where id = p_battle_id;
  if b.phase in ('destroyed', 'abandoned') then
    return;
  end if;

  update public.battles
     set phase            = 'abandoned',
         phase_started_at = now(),
         phase_ends_at    = null,
         is_complete      = false
   where id = p_battle_id;

  update public.builds
     set capture_status = 'failed'
   where battle_id = p_battle_id
     and status in ('shipped', 'auto_shipped')
     and capture_status = 'pending';
  update public.jobs j
     set status = 'failed', last_error = 'battle abandoned', updated_at = now()
    from public.builds bu
   where j.kind = 'capture' and j.ref_id = bu.id and bu.battle_id = p_battle_id
     and j.status in ('queued', 'running');

  perform private.bump(p_battle_id, 'phase', p_actor,
    jsonb_build_object('from', b.phase, 'to', 'abandoned', 'reason', p_reason));
  perform private.enqueue_destroy(p_battle_id);
  perform private.on_battle_ended(p_battle_id, p_actor);
end;
$$;

-- ─── The transition function (replaces T-011's) ───────────────────────────
-- Unchanged for solo. For room battles:
--   * "everyone is final" counts only roster players who are still active in
--     the room (not left, not kicked), and needs at least one of them;
--   * SHIPPING → RESULTS through finalize_results when reveal_vote is false;
--   * RESULTS → DESTROYED reopens the room.
create or replace function private.battle_step(p_battle_id uuid, p_actor uuid)
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
  v_quick       boolean;
  v_limit_s     int;
  v_terminal    boolean;
  v_from        public.battle_phase;
  v_to          public.battle_phase;
  v_payload     jsonb := '{}'::jsonb;
begin
  select * into b from public.battles where id = p_battle_id;
  v_from  := b.phase;
  v_due   := b.phase_ends_at is not null and v_now >= b.phase_ends_at;
  v_solo  := coalesce(b.settings ->> 'mode', '') = 'solo';
  -- M3 multiplayer: SHIPPING goes straight to RESULTS (no REVEAL / VOTING).
  v_quick := v_solo or coalesce((b.settings ->> 'reveal_vote')::boolean, true) = false;

  if b.room_id is null then
    -- Solo (and battles whose room was purged): every roster player counts.
    v_all_final := not exists (
      select 1 from public.builds bu
      where bu.battle_id = p_battle_id and bu.status = 'draft');
  else
    v_all_final :=
      exists (
        select 1 from public.battle_players bp
        join public.room_members rm on rm.room_id = b.room_id and rm.user_id = bp.user_id
        where bp.battle_id = p_battle_id and rm.left_at is null and rm.kicked_at is null)
      and not exists (
        select 1 from public.builds bu
        join public.room_members rm on rm.room_id = b.room_id and rm.user_id = bu.builder_id
        where bu.battle_id = p_battle_id and bu.status = 'draft'
          and rm.left_at is null and rm.kicked_at is null);
  end if;

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
    if not v_quick then
      raise exception using
        errcode = '0A000',
        message = 'not_implemented',
        detail  = 'SHIPPING → REVEAL (multiplayer with reveal and voting) is not implemented until M4.';
    end if;
    if v_solo then
      perform private.finalize_solo(p_battle_id);
    else
      perform private.finalize_results(p_battle_id);
    end if;
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
      detail  = format('Phase %s (multiplayer) is not implemented until M4.', b.phase);

  else
    return false;   -- destroyed, abandoned: terminal
  end case;

  perform private.bump(p_battle_id, 'phase', p_actor,
    v_payload || jsonb_build_object('from', v_from, 'to', v_to));

  if v_to = 'destroyed' then
    -- After the phase event, so the room's battle_ended follows it.
    perform private.on_battle_ended(p_battle_id, p_actor);
  end if;
  return true;
end;
$$;

-- ─── start_battle ─────────────────────────────────────────────────────────
-- Host only, room open. The roster is every player who is ready and present
-- (active, seen within 30 s), at most max_players, in join order; at least
-- 2 are needed. The time limit is drawn at random (5, 10 or 15 minutes, as
-- in solo); the room settings reveal_slot_s / voting_s are snapshotted for
-- M4. Readiness is reset for everyone, so a rematch needs a fresh ready-up.
create function public.start_battle(p_room_id uuid)
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

  v_limit     := (array[300, 600, 900])[1 + floor(random() * 3)::int];
  v_challenge := private.draw_challenge_avoiding(private.room_recent_cards(p_room_id, v_roster), v_limit);
  v_settings  := private.default_battle_settings()
              || jsonb_build_object('mode', 'multiplayer', 'reveal_vote', false)
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

-- ─── ship_build (replaces T-011's) ────────────────────────────────────────
-- Adds, for room battles: a kicked player gets `kicked`, a player who left the
-- room gets `not_a_member` (rejoin first), and a disqualified build gets
-- `disqualified` instead of the misleading `already_shipped`. Everything else
-- is unchanged.
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

-- ─── get_battle_snapshot (replaces T-011's) ───────────────────────────────
-- The solo snapshot is unchanged. For multiplayer battles:
--   me       + role ('player' on the roster, 'spectator' a room member who is
--              not on the roster, 'viewer' anyone else once the results are
--              public) and is_host
--   players  + state ('active' | 'left' | 'kicked', from the room membership)
-- Never contains storage paths of the ephemeral bucket, room codes or votes.
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

  if coalesce(b.settings ->> 'mode', '') <> 'solo' then
    v_out := jsonb_set(v_out, '{me}', (v_out -> 'me') || jsonb_build_object(
      'role', case when v_is_player then 'player'
                   when b.room_id is not null and public.is_room_member(b.room_id) then 'spectator'
                   else 'viewer' end,
      'is_host', b.host_id = v_uid));
    v_out := jsonb_set(v_out, '{players}', coalesce((
      select jsonb_agg(jsonb_build_object(
               'user_id', bp.user_id,
               'display_name', bp.display_name,
               'state', case when rm.kicked_at is not null then 'kicked'
                             when rm.left_at is not null then 'left'
                             else 'active' end) order by bp.display_name, bp.user_id)
      from public.battle_players bp
      left join public.room_members rm on rm.room_id = b.room_id and rm.user_id = bp.user_id
      where bp.battle_id = b.id), '[]'::jsonb));
  end if;

  return v_out;
end;
$$;

-- ─── Privileges ───────────────────────────────────────────────────────────
-- (create or replace keeps the grants of the replaced functions.)
revoke all on function private.draw_challenge_avoiding(uuid[], int)   from public, anon, authenticated;
revoke all on function private.room_recent_cards(uuid, uuid[])        from public, anon, authenticated;
revoke all on function private.finalize_results(uuid)                 from public, anon, authenticated;
revoke all on function private.on_battle_ended(uuid, uuid)            from public, anon, authenticated;
revoke all on function private.abandon_battle(uuid, text, uuid)       from public, anon, authenticated;

revoke all on function public.start_battle(uuid)                      from public, anon;
grant execute on function public.start_battle(uuid)                   to authenticated;
