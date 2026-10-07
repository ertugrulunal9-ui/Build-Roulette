-- Build Roulette (T-019, M4): REVEAL and VOTING for multiplayer battles.
--
-- Client RPCs (authenticated):
--   reveal_next(battle_id, expected_version)    → {changed, version, phase, phase_ends_at, reveal_index}
--   skip_to_vote(battle_id, expected_version)   → same shape (host only, REVEAL only)
--   cast_vote(battle_id, category, build_id)    → {category, build_id, ballot_complete, battle}
--   get_my_votes(battle_id)                     → {votes: {category: build_id}, complete}
-- Replaced (same signatures and grants):
--   private.battle_step       SHIPPING → REVEAL → VOTING → RESULTS for reveal_vote battles
--   private.finalize_results  split into close_shipping + M3 ranks + award_auto (same result)
--   public.update_room_settings  new key `reveal_vote` (boolean)
--   public.start_battle       snapshots `reveal_vote` (true unless the room or the
--                             deployment says otherwise)
--   public.get_battle_snapshot   reveal and voting fields (multiplayer only)
--   public.get_public_battle     per-build vote counts per category
-- New: builds.vote_counts, private.app_settings and the helpers below.
-- The storage read access for REVEAL and get_reveal_builds are in the next
-- migration, the `vote_progress` broadcast in the one after.
--
-- ─── The flow (docs/04 §4.3, §4.9) ────────────────────────────────────────
-- Multiplayer battles with settings.reveal_vote = true (every new one, unless
-- the room turned it off) run
--   spinning → building → shipping → REVEAL → VOTING → results → destroyed.
-- Solo battles and reveal_vote = false battles (all battles started before
-- this migration, and rooms that opt out) keep shipping → results.
--
-- End of SHIPPING (deadline, or every active roster player final):
--   * drafts are auto-shipped (autosave bundle.js + source.json) or DNF, and a
--     capture job is queued per shipped / auto-shipped build (private.close_shipping);
--   * the FINAL builds are the shipped and auto_shipped ones (DNF and
--     disqualified builds are never revealed and never receive votes);
--   * 2 or more final builds → REVEAL, with reveal_order = a random shuffle of
--     their ids, reveal_index = 0 and one slot per build;
--   * 0 or 1 final build → straight to RESULTS (reason `too_few_builds`): there
--     is nothing to compare. Ranks then follow the vote-based rule with zero
--     votes (the single final build is rank 1) and only auto-awards exist.
--   shipping_ended_at is stamped here in both cases (the capture deadline
--   counts from it).
--
-- REVEAL: the slot length is the room's reveal_slot_s (30–60, snapshotted into
--   battles.settings) or round(clamp(300 / n, 30, 60)) seconds for n final
--   builds (private.reveal_slot_seconds; @br/game revealSlotSeconds rounds the
--   same way). Each slot ends on its deadline (advance_battle nudges and the
--   sweep) or when the host calls reveal_next; then reveal_index + 1 with a
--   fresh full slot. The end of the last slot (deadline or reveal_next), or the
--   host's skip_to_vote at any time, starts VOTING. Each step is a `phase`
--   event (from 'reveal'), whose broadcast carries reveal_index.
--
-- VOTING lasts voting_s (room setting 30–180, default 60 s). Rules:
--   * eligible voters: roster players (battle_players.is_voter, DNF included)
--     who were not kicked from the room. A player who left can vote again
--     after rejoining the room before the deadline. Spectators never vote;
--   * one vote per active category per voter (overall, rule, style, chaos);
--     a revote replaces the earlier choice until the deadline (upsert);
--   * no self-votes; only builds in reveal_order (shipped / auto_shipped);
--   * early end: as soon as every eligible voter who is PRESENT (active in the
--     room and seen within 30 s, the host-migration rule) has voted in every
--     category, and at least one eligible voter is present. Players who left
--     or went silent do not hold the battle up; if nobody is present the
--     deadline decides. The check runs after every vote and after leave/kick
--     (they call advance), and at the deadline;
--   * progress is broadcast as counts only (`vote_progress` {voted_count,
--     eligible_count}), and only when voted_count changes (a voter completed
--     their ballot). Partial ballots and revotes change nothing visible.
--     Nobody can read another user's votes (RLS: own rows only), and
--     battle_players.voted_at stays null: who voted is never exposed.
--
-- RESULTS (private.finalize_votes), counting only votes of voters who are
-- still eligible (a voter kicked during VOTING is not counted) in active
-- categories:
--   * builds.vote_counts = {category: votes} for every final build (0s
--     included), builds.total_votes = their sum;
--   * rank (rank(), ties share): overall votes desc, total votes desc, earlier
--     shipped_at. DNF and disqualified builds are unranked;
--   * one `awards` row (source 'vote', votes = count) per category for the
--     build(s) with the most votes in it; ties share, a category nobody voted
--     in gives no award;
--   * auto-awards as in M3 (clutch_ship, speedrun, fastest_ship).
--
-- ─── Host, presence and abandonment in REVEAL / VOTING ────────────────────
-- Deadlines drive both phases, so nothing waits for the host. If the host
-- vanishes mid-REVEAL the slots keep advancing on their deadlines; after 30 s
-- without a heartbeat the host role moves to the earliest-joined present
-- member (players first), lazily in the RPCs (reveal_next / skip_to_vote call
-- ensure_host) and in sweep_deadlines, and the new host can reveal_next /
-- skip_to_vote. Abandonment is unchanged: a battle in REVEAL or VOTING with no
-- roster player seen for 5 minutes is ABANDONED (no tallies, no ranks).
--
-- ─── Errors (docs/05 §5.7 contract) ───────────────────────────────────────
--   42501  not_authenticated, not_on_roster (spectators), kicked, not_a_member
--          (left: rejoin first), not_host, not_a_voter (is_voter = false)
--   P0002  battle_not_found, build_not_found (not a build of this battle)
--   22023  invalid_version, invalid_category
--   P0001  wrong_phase, deadline_passed, self_vote, not_votable (DNF,
--          disqualified, or otherwise not in reveal_order)

-- ─── Deployment switch: the default of reveal_vote ────────────────────────
-- One row per known key, service-side only (schema `private`, no API role has
-- USAGE). Production has no row, so new multiplayer battles reveal and vote.
-- A test environment can make the M3 flow the default without touching any
-- room (e.g. web e2e suites written before the VOTE stage existed):
--   insert into private.app_settings (key, value) values ('reveal_vote_default', 'false')
--   on conflict (key) do update set value = excluded.value;
-- A room's own `reveal_vote` setting always wins over this default.
create table private.app_settings (
  key        text primary key check (key in ('reveal_vote_default')),
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
revoke all on private.app_settings from public, anon, authenticated, service_role;

create function private.reveal_vote_default()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select (s.value #>> '{}')::boolean from private.app_settings s where s.key = 'reveal_vote_default'),
    true)
$$;

-- ─── Constants shared with @br/game ───────────────────────────────────────
-- packages/game/src/schema-drift.test.ts parses this flat jsonb_build_object
-- and compares it with REVEAL_* and VOTING_* in @br/game.
create function private.reveal_vote_limits()
returns jsonb
language sql
immutable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'reveal_total_s', 300,
    'reveal_slot_min_s', 30,
    'reveal_slot_max_s', 60,
    'voting_min_s', 30,
    'voting_max_s', 180
  )
$$;

create function private.reveal_vote_limit(p_key text)
returns int
language sql
immutable
security definer
set search_path = ''
as $$
  select (private.reveal_vote_limits() ->> p_key)::int
$$;

-- round(clamp(300 / n, 30, 60)) whole seconds; n <= 0 gives the maximum.
-- round() on numeric rounds half away from zero (37.5 → 38), like Math.round
-- for these positive values. supabase/tests/15_reveal_vote.test.sql holds the
-- reference table that the @br/game drift test also checks.
create function private.reveal_slot_seconds(p_builds int)
returns int
language sql
immutable
security definer
set search_path = ''
as $$
  select case
    when p_builds is null or p_builds <= 0 then private.reveal_vote_limit('reveal_slot_max_s')
    else round(least(private.reveal_vote_limit('reveal_slot_max_s')::numeric,
                     greatest(private.reveal_vote_limit('reveal_slot_min_s')::numeric,
                              private.reveal_vote_limit('reveal_total_s')::numeric / p_builds)))::int
  end
$$;

-- The slot of a battle: the room's reveal_slot_s if it set one, else the rule.
create function private.battle_reveal_slot(p_settings jsonb, p_builds int)
returns int
language sql
immutable
security definer
set search_path = ''
as $$
  select coalesce((p_settings ->> 'reveal_slot_s')::int, private.reveal_slot_seconds(p_builds))
$$;

-- ─── Schema ───────────────────────────────────────────────────────────────
-- Per-category vote counts of a final build, frozen at RESULTS
-- ({"overall": 2, "rule": 0, ...}); null before RESULTS and for builds that
-- were not final. Permanent like total_votes: the ballots may be pruned later
-- (docs/05 §5.6), the tallies stay.
alter table public.builds add column vote_counts jsonb;

-- ─── Voters ───────────────────────────────────────────────────────────────
-- Every eligible voter of a battle: roster players with is_voter, not kicked
-- from the room. `present` = active in the room and seen within present_s;
-- `categories` = how many active categories they have voted in.
create function private.eligible_voters(p_battle_id uuid)
returns table (user_id uuid, present boolean, categories int)
language sql
stable
security definer
set search_path = ''
as $$
  select bp.user_id,
         private.is_present(rm) as present,
         (select count(*)::int
          from public.votes v
          join public.vote_categories c on c.slug = v.category and c.is_active
          where v.battle_id = p_battle_id and v.voter_id = bp.user_id) as categories
  from public.battle_players bp
  join public.battles b on b.id = bp.battle_id
  left join public.room_members rm on rm.room_id = b.room_id and rm.user_id = bp.user_id
  where bp.battle_id = p_battle_id
    and bp.is_voter
    and rm.kicked_at is null
$$;

create function private.active_category_count()
returns int
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::int from public.vote_categories where is_active
$$;

-- {voted_count, eligible_count}: eligible voters, and those of them who voted
-- in every active category. Counts only, never names.
create function private.vote_progress(p_battle_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'voted_count', count(*) filter (where e.categories >= private.active_category_count()),
    'eligible_count', count(*))
  from private.eligible_voters(p_battle_id) e
$$;

-- The early end of VOTING: at least one eligible voter is present, and every
-- present eligible voter has voted in every active category.
create function private.all_present_voted(p_battle_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from private.eligible_voters(p_battle_id) e where e.present)
     and not exists (select 1 from private.eligible_voters(p_battle_id) e
                     where e.present and e.categories < private.active_category_count())
$$;

-- ─── End of SHIPPING, results ─────────────────────────────────────────────
-- Remaining drafts → auto_shipped (autosave bundle.js + source.json exist,
-- shipped_at = building_ends_at, the full time limit) or dnf, and a capture
-- job per shipped / auto_shipped build. Battle row locked by the caller.
-- (The first half of the M3 finalize_results, unchanged.)
create function private.close_shipping(p_battle_id uuid)
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
end;
$$;

-- The automatic awards of a room battle (unchanged from M3): clutch_ship (by
-- hand in the last 10 s or the grace), speedrun (by hand within half of the
-- time limit), fastest_ship (lowest completion_ms among builds shipped by
-- hand, only when at least two were; ties share it).
create function private.award_auto(p_battle_id uuid)
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

-- M3 results (reveal_vote = false): same behaviour as T-016's function, now
-- built from the shared pieces.
create or replace function private.finalize_results(p_battle_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.close_shipping(p_battle_id);

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

  perform private.award_auto(p_battle_id);
end;
$$;

-- M4 results: tallies, vote-based ranks, category awards, auto-awards (see
-- the top of this file). close_shipping already ran at the end of SHIPPING.
create function private.finalize_votes(p_battle_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  with cats as (
    select slug from public.vote_categories where is_active
  ),
  counted as (
    select v.build_id, v.category, count(*)::int as n
    from public.votes v
    join cats on cats.slug = v.category
    join private.eligible_voters(p_battle_id) e on e.user_id = v.voter_id
    where v.battle_id = p_battle_id
    group by v.build_id, v.category
  ),
  per_build as (
    select bu.id,
           jsonb_object_agg(cats.slug, coalesce(c.n, 0)) as counts,
           coalesce(sum(c.n), 0)::int as total
    from public.builds bu
    cross join cats
    left join counted c on c.build_id = bu.id and c.category = cats.slug
    where bu.battle_id = p_battle_id
      and bu.status in ('shipped', 'auto_shipped')
    group by bu.id
  )
  update public.builds bu
     set vote_counts = p.counts,
         total_votes = p.total
    from per_build p
   where bu.id = p.id;

  update public.builds bu
     set final_rank = ranked.rank
    from (
      select id, rank() over (order by coalesce((vote_counts ->> 'overall')::int, 0) desc,
                                       total_votes desc,
                                       shipped_at) as rank
      from public.builds
      where battle_id = p_battle_id
        and status in ('shipped', 'auto_shipped')
    ) ranked
   where bu.id = ranked.id;

  insert into public.awards (battle_id, build_id, award, source, votes)
  select p_battle_id, x.id, x.slug, 'vote', x.n
  from (
    select bu.id, c.slug, (bu.vote_counts ->> c.slug)::int as n,
           max((bu.vote_counts ->> c.slug)::int) over (partition by c.slug) as top
    from public.builds bu
    cross join public.vote_categories c
    where bu.battle_id = p_battle_id
      and bu.status in ('shipped', 'auto_shipped')
      and c.is_active
  ) x
  where x.n > 0 and x.n = x.top;

  perform private.award_auto(p_battle_id);
end;
$$;

-- ─── REVEAL steps ─────────────────────────────────────────────────────────
-- The battle (row locked by the caller) is in REVEAL. Moves to the next slot,
-- or to VOTING after the last slot or when p_skip. One `phase` event either
-- way; its payload carries reveal_index for the slot steps.
create function private.reveal_move(p_battle_id uuid, p_actor uuid, p_skip boolean, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  b      public.battles;
  v_now  timestamptz := now();
  v_slot int;
begin
  select * into b from public.battles where id = p_battle_id;

  if not p_skip and b.reveal_index < cardinality(b.reveal_order) - 1 then
    v_slot := private.battle_reveal_slot(b.settings, cardinality(b.reveal_order));
    update public.battles
       set reveal_index     = b.reveal_index + 1,
           phase_started_at = v_now,
           phase_ends_at    = v_now + make_interval(secs => v_slot)
     where id = p_battle_id;
    perform private.bump(p_battle_id, 'phase', p_actor, jsonb_strip_nulls(jsonb_build_object(
      'from', 'reveal', 'to', 'reveal', 'reveal_index', b.reveal_index + 1, 'reason', p_reason)));
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

-- ─── The transition function (replaces T-016's) ───────────────────────────
-- Unchanged for SPINNING, BUILDING and RESULTS, for solo and for
-- reveal_vote = false battles. New: SHIPPING → REVEAL (or RESULTS when fewer
-- than 2 builds are final), REVEAL slots, VOTING → RESULTS.
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
  v_order       uuid[];
  v_slot        int;
  v_from        public.battle_phase;
  v_to          public.battle_phase;
  v_payload     jsonb := '{}'::jsonb;
begin
  select * into b from public.battles where id = p_battle_id;
  v_from  := b.phase;
  v_due   := b.phase_ends_at is not null and v_now >= b.phase_ends_at;
  v_solo  := coalesce(b.settings ->> 'mode', '') = 'solo';
  -- Solo, and multiplayer battles without reveal and vote: SHIPPING → RESULTS.
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
    if v_quick then
      if v_solo then
        perform private.finalize_solo(p_battle_id);
      else
        perform private.finalize_results(p_battle_id);
      end if;
      v_to := 'results';
    else
      perform private.close_shipping(p_battle_id);
      select coalesce(array_agg(bu.id order by random()), '{}') into v_order
      from public.builds bu
      where bu.battle_id = p_battle_id
        and bu.status in ('shipped', 'auto_shipped');

      if cardinality(v_order) >= 2 then
        v_to   := 'reveal';
        v_slot := private.battle_reveal_slot(b.settings, cardinality(v_order));
        update public.battles
           set phase             = v_to,
               phase_started_at  = v_now,
               phase_ends_at     = v_now + make_interval(secs => v_slot),
               shipping_ended_at = v_now,
               reveal_order      = v_order,
               reveal_index      = 0
         where id = p_battle_id;
        v_payload := jsonb_build_object('reveal_index', 0);
      else
        -- Nothing to compare: no REVEAL, no VOTING.
        perform private.finalize_votes(p_battle_id);
        v_to := 'results';
        v_payload := jsonb_build_object('reason', 'too_few_builds');
      end if;
    end if;

    if v_to = 'results' then
      update public.battles
         set phase             = v_to,
             phase_started_at  = v_now,
             phase_ends_at     = v_now + private.setting_interval(b.settings, 'results_s'),
             shipping_ended_at = v_now,
             finished_at       = v_now,
             is_complete       = true
       where id = p_battle_id;
    end if;

  when 'reveal' then
    if not v_due then return false; end if;
    perform private.reveal_move(p_battle_id, p_actor, false, null);
    return true;   -- reveal_move logged the phase event

  when 'voting' then
    if not (v_due or private.all_present_voted(p_battle_id)) then return false; end if;
    perform private.finalize_votes(p_battle_id);
    v_to := 'results';
    update public.battles
       set phase            = v_to,
           phase_started_at = v_now,
           phase_ends_at    = v_now + private.setting_interval(b.settings, 'results_s'),
           finished_at      = v_now,
           is_complete      = true
     where id = p_battle_id;
    if not v_due then
      v_payload := jsonb_build_object('reason', 'all_voted');
    end if;

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

-- ─── Room settings (replaces T-016's) ─────────────────────────────────────
-- Host only, while the room is open. Merges p_settings into rooms.settings; a
-- key set to null is removed (back to the default). Accepted keys:
--   max_players    2–8, not below the current number of active players
--   reveal_slot_s  30–60 (seconds per build in REVEAL; default: the 300/n rule)
--   voting_s       30–180 (VOTING length; default 60)
--   reveal_vote    boolean: false skips REVEAL and VOTING (SHIPPING → RESULTS
--                  with M3 ranking by completion time); default true
-- Returns the new settings.
create or replace function public.update_room_settings(p_room_id uuid, p_settings jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := private.require_auth();
  r         public.rooms;
  v_key     text;
  v_val     jsonb;
  v_num     numeric;
  v_new     jsonb;
  v_players int;
begin
  r := private.lock_room_for(p_room_id);
  perform private.require_active_member(p_room_id, v_uid);
  perform private.touch_member(p_room_id, v_uid);
  perform private.ensure_host(p_room_id, v_uid);
  select * into r from public.rooms where id = p_room_id;
  if r.host_id <> v_uid then
    raise exception using errcode = '42501', message = 'not_host',
      detail = 'Only the host can change the room settings.';
  end if;
  if r.status <> 'open' then
    raise exception using errcode = 'P0001', message = 'wrong_room_state',
      detail = format('Settings can only change while the room is open (it is %s).', r.status);
  end if;
  if p_settings is null or jsonb_typeof(p_settings) <> 'object' then
    raise exception using errcode = '22023', message = 'invalid_settings',
      detail = 'settings must be a JSON object.';
  end if;

  v_new := r.settings;
  for v_key, v_val in select key, value from jsonb_each(p_settings) loop
    if v_key not in ('max_players', 'reveal_slot_s', 'voting_s', 'reveal_vote') then
      raise exception using errcode = '22023', message = 'invalid_settings',
        detail = format('Unknown setting %s.', v_key);
    end if;
    if v_val = 'null'::jsonb then
      v_new := v_new - v_key;
      continue;
    end if;
    if v_key = 'reveal_vote' then
      if jsonb_typeof(v_val) <> 'boolean' then
        raise exception using errcode = '22023', message = 'invalid_settings',
          detail = 'reveal_vote must be true or false.';
      end if;
      v_new := v_new || jsonb_build_object(v_key, v_val);
      continue;
    end if;
    if jsonb_typeof(v_val) <> 'number' then
      raise exception using errcode = '22023', message = 'invalid_settings',
        detail = format('%s must be a number.', v_key);
    end if;
    v_num := v_val::text::numeric;
    if v_num <> trunc(v_num)
       or (v_key = 'max_players' and v_num not between private.room_limit('min_players') and private.room_limit('max_players'))
       or (v_key = 'reveal_slot_s' and v_num not between private.reveal_vote_limit('reveal_slot_min_s')
                                                     and private.reveal_vote_limit('reveal_slot_max_s'))
       or (v_key = 'voting_s' and v_num not between private.reveal_vote_limit('voting_min_s')
                                                and private.reveal_vote_limit('voting_max_s')) then
      raise exception using errcode = '22023', message = 'invalid_settings',
        detail = format('%s is out of range.', v_key);
    end if;
    v_new := v_new || jsonb_build_object(v_key, v_num::int);
  end loop;

  select count(*) into v_players from public.room_members
  where room_id = p_room_id and role = 'player' and left_at is null and kicked_at is null;
  if private.room_max_players(v_new) < v_players then
    raise exception using errcode = '22023', message = 'invalid_settings',
      detail = format('The room already has %s players.', v_players);
  end if;

  if v_new is distinct from r.settings then
    update public.rooms set settings = v_new where id = p_room_id;
    perform private.room_bump(p_room_id, 'settings', v_uid, jsonb_build_object('settings', v_new));
    perform private.fill_player_slots(p_room_id, v_uid);
  end if;
  return v_new;
end;
$$;

-- ─── start_battle (replaces T-016's) ──────────────────────────────────────
-- Unchanged except for the settings snapshot: reveal_vote is the room's
-- setting, or private.reveal_vote_default() (true in production).
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

  v_limit     := (array[300, 600, 900])[1 + floor(random() * 3)::int];
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

-- ─── Host controls of REVEAL ──────────────────────────────────────────────
-- Shared by reveal_next and skip_to_vote. Guards, in order: signed in;
-- expected_version given; a battle the caller can see as a member; an active
-- room member (kicked → kicked, left → not_a_member); the host (after the
-- lazy host migration, which this call's presence feeds); then the
-- compare-and-set: a stale version is a no-op ({changed: false}), like
-- advance_battle, so a double click is harmless; then the phase (REVEAL).
create function private.host_reveal_action(p_battle_id uuid, p_expected_version int, p_skip boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := private.require_auth();
  b         public.battles;
  v_version int;
  v_changed boolean := false;
begin
  if p_expected_version is null then
    raise exception using errcode = '22023', message = 'invalid_version',
      detail = 'expected_version is required (compare-and-set).';
  end if;
  if not public.is_battle_member(p_battle_id) then
    raise exception using errcode = 'P0002', message = 'battle_not_found',
      detail = 'No such battle.';
  end if;

  -- Lock order: battle, room, member rows.
  select * into b from public.battles where id = p_battle_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'battle_not_found',
      detail = 'No such battle.';
  end if;
  v_version := b.version;
  if b.room_id is null then
    raise exception using errcode = '42501', message = 'not_host',
      detail = 'A solo battle has no host controls.';
  end if;
  perform private.lock_room_for(b.room_id);
  perform private.require_active_member(b.room_id, v_uid);
  perform private.touch_member(b.room_id, v_uid);
  perform private.ensure_host(b.room_id, v_uid);

  select * into b from public.battles where id = p_battle_id;
  if b.host_id <> v_uid then
    raise exception using errcode = '42501', message = 'not_host',
      detail = 'Only the host controls the reveal.';
  end if;

  if v_version = p_expected_version then
    if b.phase <> 'reveal' then
      raise exception using errcode = 'P0001', message = 'wrong_phase',
        detail = format('There is no reveal to control during %s.', b.phase);
    end if;
    perform private.reveal_move(p_battle_id, v_uid, p_skip,
      case when p_skip then 'host_skip' else 'host_next' end);
    v_changed := true;
    select * into b from public.battles where id = p_battle_id;
  end if;

  return jsonb_build_object(
    'changed', v_changed,
    'version', b.version,
    'phase', b.phase,
    'phase_ends_at', b.phase_ends_at,
    'reveal_index', b.reveal_index);
end;
$$;

-- Host only, REVEAL only: ends the current slot now. On the last slot this
-- starts VOTING. Compare-and-set on the battle version.
create function public.reveal_next(p_battle_id uuid, p_expected_version int)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select private.host_reveal_action(p_battle_id, p_expected_version, false);
$$;

-- Host only, REVEAL only: skips the remaining slots and starts VOTING.
create function public.skip_to_vote(p_battle_id uuid, p_expected_version int)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select private.host_reveal_action(p_battle_id, p_expected_version, true);
$$;

-- ─── Voting ───────────────────────────────────────────────────────────────
-- One vote in one category; casting again in the same category replaces the
-- earlier choice (until the deadline). Guards, in order: signed in; the
-- battle exists; the caller is on its roster (spectators: not_on_roster);
-- not kicked; still in the room (left: not_a_member, rejoin to vote); a
-- voter; phase VOTING and before its deadline; an active category; a build
-- of this battle; not their own; a final build that was revealed.
-- Counts as presence. Returns {category, build_id, ballot_complete, battle:
-- {version, phase, phase_ends_at}} after the early-end check (the battle may
-- already be in RESULTS).
create function public.cast_vote(p_battle_id uuid, p_category text, p_build_id uuid)
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

-- The caller's own ballot: {votes: {category: build_id}, complete}. Readable
-- by anyone who can see the battle; it only ever contains the caller's votes
-- (empty for spectators and viewers).
create function public.get_my_votes(p_battle_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := private.require_auth();
  v_votes jsonb;
begin
  if not exists (select 1 from public.battles where id = p_battle_id)
     or not public.can_view_battle(p_battle_id) then
    raise exception using errcode = 'P0002', message = 'battle_not_found',
      detail = 'No such battle.';
  end if;

  select coalesce(jsonb_object_agg(v.category, v.build_id), '{}'::jsonb) into v_votes
  from public.votes v
  join public.vote_categories c on c.slug = v.category and c.is_active
  where v.battle_id = p_battle_id and v.voter_id = v_uid;

  return jsonb_build_object(
    'votes', v_votes,
    'complete', (select count(*) from jsonb_object_keys(v_votes)) >= private.active_category_count());
end;
$$;

-- ─── get_battle_snapshot (replaces T-016's) ───────────────────────────────
-- The solo snapshot is unchanged. Multiplayer battles add:
--   battle   + reveal_vote, reveal_order (build ids, the reveal sequence),
--              reveal_index, reveal_slot_s (the slot length; null when there
--              is no reveal). During REVEAL, phase_started_at/phase_ends_at
--              are the current slot.
--   me       + is_voter (on the roster, a voter, not kicked) and can_vote
--              (is_voter, in the room, VOTING before its deadline)
--   builds[] + votes: {category: count}, null until RESULTS
--   vote_categories  [{slug, label, description}] in display order
--   vote_progress    {voted_count, eligible_count} during VOTING, else null
-- Never contains ballots, storage paths of the ephemeral bucket or room codes.
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

-- ─── get_public_battle (replaces T-014's) ─────────────────────────────────
-- Adds builds[].votes ({category: count}, null for battles without voting and
-- for builds that were not final). The vote awards (source 'vote') were
-- already part of `awards`. Never ballots or voter names.
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
               'name', bu.name,
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

-- ─── Privileges ───────────────────────────────────────────────────────────
-- (create or replace keeps the grants of the replaced functions.)
revoke all on function private.reveal_vote_default()                       from public, anon, authenticated;
revoke all on function private.reveal_vote_limits()                        from public, anon, authenticated;
revoke all on function private.reveal_vote_limit(text)                     from public, anon, authenticated;
revoke all on function private.reveal_slot_seconds(int)                    from public, anon, authenticated;
revoke all on function private.battle_reveal_slot(jsonb, int)              from public, anon, authenticated;
revoke all on function private.eligible_voters(uuid)                       from public, anon, authenticated;
revoke all on function private.active_category_count()                     from public, anon, authenticated;
revoke all on function private.vote_progress(uuid)                         from public, anon, authenticated;
revoke all on function private.all_present_voted(uuid)                     from public, anon, authenticated;
revoke all on function private.close_shipping(uuid)                        from public, anon, authenticated;
revoke all on function private.award_auto(uuid)                            from public, anon, authenticated;
revoke all on function private.finalize_votes(uuid)                        from public, anon, authenticated;
revoke all on function private.reveal_move(uuid, uuid, boolean, text)      from public, anon, authenticated;
revoke all on function private.host_reveal_action(uuid, int, boolean)      from public, anon, authenticated;

revoke all on function public.reveal_next(uuid, int)                       from public, anon;
revoke all on function public.skip_to_vote(uuid, int)                      from public, anon;
revoke all on function public.cast_vote(uuid, text, uuid)                  from public, anon;
revoke all on function public.get_my_votes(uuid)                           from public, anon;

grant execute on function public.reveal_next(uuid, int)                    to authenticated;
grant execute on function public.skip_to_vote(uuid, int)                   to authenticated;
grant execute on function public.cast_vote(uuid, text, uuid)               to authenticated;
grant execute on function public.get_my_votes(uuid)                        to authenticated;
