-- Build Roulette (T-022, M5): one winner per vote category, and the early end
-- of VOTING re-checked by sweep_deadlines.
--
-- Replaced (same signatures and grants):
--   private.finalize_votes   category awards: one winner per category; ranks
--                            get the same final tie-break (no shared ranks)
--   public.sweep_deadlines   step 1 also advances VOTING battles whose early
--                            end is due (private.all_present_voted)
-- Unchanged: the tallies, the auto-awards, get_battle_snapshot,
-- get_public_battle and get_player_history (the shape of `awards` and
-- `builds[]` is the same; a category simply has at most one vote award now).
--
-- ─── One winner per vote category (user decision 2026-10-07) ─────────────
-- Until now a tie for the top count of a category gave every tied build an
-- award. From now on each active category has at most one `awards` row
-- (source 'vote', votes = its count). Among the final builds with the top
-- count in the category, and only when that count is > 0:
--   1. more total votes (builds.total_votes, all active categories) wins;
--   2. then the earlier shipped_at;
--   3. then the lower build id, so the result is always deterministic.
-- A category nobody voted in still gives no award.
--
-- Level 3 is rare but not impossible: auto-shipped builds all have
-- shipped_at = building_ends_at, so two auto-shipped builds with the same
-- counts tie on levels 1 and 2. The build id is arbitrary but stable.
--
-- Ranks (vote-based): Best Build votes desc, total votes desc, earlier
-- shipped_at, as before, plus the same final tie-break (lower build id).
-- They were computed with rank() (full ties shared a rank); now every final
-- build gets a distinct rank 1..n. With the same order for both, the Best
-- Build award (when anyone voted Best Build) always goes to the rank-1 build,
-- and RESULTS has exactly one winner banner. The M3 ranking of battles
-- without votes (private.finalize_results, reveal_vote = false) is unchanged
-- and still shares ranks on full ties.
--
-- Which battles: awards and ranks are written once, when a battle enters
-- RESULTS. This migration does not touch stored rows, so battles that
-- finished before it keep their (possibly shared) awards and ranks: they are
-- permanent results. Every battle that reaches RESULTS after it, including
-- one that is in REVEAL or VOTING while the migration runs, gets the new rule
-- (nobody has seen its awards yet).
--
-- ─── The early end of VOTING in sweep_deadlines (docs/04 §4.11 gap) ──────
-- private.battle_step already ends VOTING early when at least one eligible
-- voter is present and every present eligible voter has completed their
-- ballot (private.all_present_voted; present = active in the room and seen
-- within 30 s, private.is_present). Until now that was only evaluated after
-- a vote, a leave or a kick, so a voter who simply went silent made the
-- battle wait for the timer: their presence lapses without any request.
-- sweep_deadlines (pg_cron, every 5 s) now selects VOTING battles whose early
-- end is due along with the overdue battles and advances them the same way
-- (private.advance → battle_step, `phase` event with reason `all_voted`). So
-- VOTING ends at most ~5 s after the last unfinished voter stops counting as
-- present (30 s after their last heartbeat).
--   * Idempotent: battle_step re-evaluates the condition under the battle
--     lock; a battle that already left VOTING, or whose condition no longer
--     holds (the silent voter came back), is not changed.
--   * Lock order: the sweep locks the battle row first (for update skip
--     locked, as before) and battle_step's VOTING → RESULTS step takes no
--     room or member lock, so the order battle → room → members holds.
--   * The heartbeat path is unchanged: a heartbeat cannot see a lapse sooner
--     than the next sweep, and locking the battle on every heartbeat would
--     put the busiest RPC on the battle row.

-- ─── Results of a voted battle (replaces T-019's) ─────────────────────────
create or replace function private.finalize_votes(p_battle_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Tallies (unchanged): votes of voters who are still eligible, in active
  -- categories, for every final build (0s included).
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

  -- Ranks 1..n: Best Build votes, total votes, earlier ship, lower build id.
  update public.builds bu
     set final_rank = ranked.rank
    from (
      select id, row_number() over (order by coalesce((vote_counts ->> 'overall')::int, 0) desc,
                                             total_votes desc,
                                             shipped_at,
                                             id) as rank
      from public.builds
      where battle_id = p_battle_id
        and status in ('shipped', 'auto_shipped')
    ) ranked
   where bu.id = ranked.id;

  -- One award per active category with votes: the top count, then total
  -- votes, then earlier ship, then lower build id.
  insert into public.awards (battle_id, build_id, award, source, votes)
  select distinct on (c.slug)
         p_battle_id, bu.id, c.slug, 'vote', (bu.vote_counts ->> c.slug)::int
  from public.builds bu
  cross join public.vote_categories c
  where bu.battle_id = p_battle_id
    and bu.status in ('shipped', 'auto_shipped')
    and c.is_active
    and (bu.vote_counts ->> c.slug)::int > 0
  order by c.slug,
           (bu.vote_counts ->> c.slug)::int desc,
           bu.total_votes desc,
           bu.shipped_at,
           bu.id;

  perform private.award_auto(p_battle_id);
end;
$$;

-- ─── sweep_deadlines (replaces T-016's) ───────────────────────────────────
-- (pg_cron, every 5 s), in this order, each battle or room in its own
-- subtransaction so one failure cannot stop the others:
--   1. advance overdue battles, and battles in VOTING whose early end is due
--      (every present eligible voter has voted; at least one is present);
--   2. abandonment (unchanged);
--   3. host migration (unchanged);
--   4. jobs whose last lease expired (unchanged).
--   Returns the number of battles that changed (advanced or abandoned).
create or replace function public.sweep_deadlines()
returns int
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id      uuid;
  v_job     bigint;
  v_room    uuid;
  r         public.rooms;
  v_changed int := 0;
begin
  -- 1. Deadlines, and the early end of VOTING.
  for v_id in
    select b.id
    from public.battles b
    where b.phase not in ('destroyed', 'abandoned')
      and (b.phase_ends_at <= now()
           or (b.phase = 'voting' and private.all_present_voted(b.id)))
    order by b.phase_ends_at
    limit 200
    for update skip locked
  loop
    begin
      if (private.advance(v_id, null, null) ->> 'changed')::boolean then
        v_changed := v_changed + 1;
      end if;
    exception when others then
      raise warning 'sweep_deadlines: battle % not advanced: % (%)', v_id, sqlerrm, sqlstate;
    end;
  end loop;

  -- 2. Abandonment (room battles only; RESULTS ends on its own deadline).
  for v_id in
    select b.id
    from public.battles b
    where b.phase in ('spinning', 'building', 'shipping', 'reveal', 'voting')
      and b.room_id is not null
      and not exists (
        select 1
        from public.battle_players bp
        join public.room_members rm on rm.room_id = b.room_id and rm.user_id = bp.user_id
        where bp.battle_id = b.id
          and rm.kicked_at is null
          and rm.last_seen_at >= now() - private.room_limit_interval('abandon_s'))
    order by b.created_at
    limit 200
    for update skip locked
  loop
    begin
      perform private.abandon_battle(v_id, 'no_presence', null);
      v_changed := v_changed + 1;
    exception when others then
      raise warning 'sweep_deadlines: battle % not abandoned: % (%)', v_id, sqlerrm, sqlstate;
    end;
  end loop;

  -- 3. Host migration.
  for v_room in
    select ro.id
    from public.rooms ro
    where ro.status <> 'closed'
      and not exists (
        select 1 from public.room_members h
        where h.room_id = ro.id and h.user_id = ro.host_id and private.is_present(h))
      and exists (
        select 1 from public.room_members c
        where c.room_id = ro.id and c.user_id <> ro.host_id and private.is_present(c))
    limit 200
  loop
    begin
      r := private.lock_room(v_room, true);
      if r.id is not null then
        perform private.ensure_host(v_room, null);
      end if;
    exception when others then
      raise warning 'sweep_deadlines: room % host not migrated: % (%)', v_room, sqlerrm, sqlstate;
    end;
  end loop;

  -- 4. Jobs that used their last attempt and whose lease expired.
  for v_job in
    select j.id from public.jobs j
    where j.status = 'running' and j.attempts >= 5 and j.run_after <= now()
    limit 200
  loop
    begin
      perform private.give_up_job(v_job, 'lease expired after the last attempt');
    exception when others then
      raise warning 'sweep_deadlines: job % not failed: % (%)', v_job, sqlerrm, sqlstate;
    end;
  end loop;

  return v_changed;
end;
$$;
