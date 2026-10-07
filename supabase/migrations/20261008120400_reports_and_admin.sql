-- Build Roulette (T-024, M5): reports, the admin role, the admin RPCs and the takedown
-- decision (docs/02 R9, docs/06 M5 "report queue and admin takedown", and the admin
-- event-log page moved from M3).
--
-- Client RPC (authenticated, anonymous sign-ins included; never `anon`):
--   report_build(build_id, reason, details)        → {report_id, build_id, reason, created_at}
-- Admin RPCs (authenticated AND public.is_admin(); everyone else gets not_admin):
--   is_admin()                                     → boolean (anyone signed in may ask)
--   admin_report_queue(resolved, limit)            → {builds: [...]} reports grouped by build
--   admin_dismiss_reports(build_id, note)          → {build_id, dismissed}
--   admin_take_down_build(build_id, note)          → {build_id, battle_id, taken_down_at, ...}
--   admin_battle_log(battle_id)                    → battle, builds, battle_events, jobs
--   admin_room_log(code)                           → room, members, battles, room_events
--   admin_action_log(limit)                        → the latest admin actions
-- The takedown JOB (Storage delete) and the visibility rules of taken-down builds are in the
-- next migration.
--
-- ─── Who can report what ──────────────────────────────────────────────────
-- Anyone who can SEE the build: a final build (shipped or auto-shipped) that is
--   * in a battle in RESULTS or DESTROYED that the public results page lists (not
--     disqualified), for anyone signed in, or
--   * in the reveal (in reveal_order) of a battle in REVEAL, VOTING or RESULTS, for its
--     battle members (roster and spectators, not kicked).
-- Everything else, including a build already taken down, is `build_not_found` (no
-- probing). Not your own build (`own_build`). One report per user per build (the unique
-- constraint; a second one is `already_reported`). Reasons: offensive, phishing, malware,
-- spam, other. Details: optional, at most 500 characters, no control characters besides
-- newlines and tabs. Rate limit `report_build`: 20 per hour.
--
-- ─── Admins ───────────────────────────────────────────────────────────────
-- `private.admins (user_id)` is managed with SQL only (no API role can reach schema
-- private). An anonymous user can never be an admin: a trigger refuses such rows, and
-- is_admin() also requires a non-anonymous JWT and a non-anonymous auth user. Production:
-- create the user (dashboard → Authentication → Add user, email + password), then
--   insert into private.admins (user_id, note)
--   select id, 'moderator' from auth.users where email = 'mod@example.com';
-- Locally: supabase/scripts/seed-admin.mjs. Every admin action is logged in
-- private.admin_actions (who, what, which build/battle/room, note, when), including the
-- battle and room lookups.
--
-- ─── Takedown ─────────────────────────────────────────────────────────────
-- admin_take_down_build hides a build at once and for good:
--   * builds.taken_down_at is stamped; builds.name and builds.screenshot_path are cleared
--     (the table is readable through RLS, so hiding them in the RPCs alone would not be
--     enough). The originals are archived in private.build_takedowns for the admins;
--   * a `takedown` job deletes `screenshots/{battle}/{build}.*` through the Storage API
--     (capture-worker), then complete_takedown stamps storage_deleted_at;
--   * a queued capture job of the build is cancelled, a pending capture_status becomes
--     `failed` (so RESULTS → DESTROYED does not wait for it);
--   * the open reports of the build become `actioned`;
--   * in a battle that is still RUNNING (any phase before RESULTS), the build is also
--     disqualified, like a kicked player's: it is never revealed again (its REVEAL slot is
--     skipped, and if it is on screen the reveal moves on at once), cannot receive votes
--     (votes already cast for it are deleted, so those voters vote again in that category),
--     gets no tally, rank or award, and is left out of the public results like every
--     disqualified build;
--   * in a FINISHED battle (RESULTS, DESTROYED) the results stay as they were: rank, status,
--     completion time, votes and awards remain; the build shows as "Removed by moderators"
--     with no name and no screenshot;
--   * a `takedown` battle event (one version bump) makes the clients in the battle refetch.
-- A takedown cannot be undone from the admin page (the archive keeps what is needed to do
-- it by hand).

-- ─── Schema ───────────────────────────────────────────────────────────────

-- Reports by anonymous viewers of a public page: the reporter may have no profile (they
-- never played), so the reporter is an auth user, not a profile. resolved_at says when a
-- moderator dismissed or actioned it; WHO did it is in private.admin_actions only (reporters
-- read their own rows through RLS, and admin ids are not theirs to see).
alter table public.reports drop constraint reports_reporter_id_fkey;
alter table public.reports
  add constraint reports_reporter_id_fkey
    foreign key (reporter_id) references auth.users (id) on delete cascade,
  add constraint reports_details_check check (char_length(details) between 1 and 500),
  add column resolved_at timestamptz;
create index reports_open_build_idx on public.reports (build_id, created_at) where status = 'open';
create index reports_reporter_idx on public.reports (reporter_id);
create index reports_build_idx on public.reports (build_id);

alter table public.builds add column taken_down_at timestamptz;

create table private.admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  note       text,
  created_at timestamptz not null default now()
);
revoke all on private.admins from public, anon, authenticated, service_role;

create function private.admins_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select u.is_anonymous from auth.users u where u.id = new.user_id) is distinct from false then
    raise exception 'private.admins: % is an anonymous (or unknown) user and cannot be an admin',
      new.user_id;
  end if;
  return new;
end;
$$;
create trigger admins_not_anonymous
  before insert or update on private.admins
  for each row execute function private.admins_guard();

create table private.admin_actions (
  id         bigint generated always as identity primary key,
  admin_id   uuid references auth.users (id) on delete set null,
  action     text not null check (action in ('dismiss_reports', 'take_down_build', 'retry_takedown',
                                             'view_battle', 'view_room')),
  build_id   uuid,
  battle_id  uuid,
  room_id    uuid,
  note       text,
  payload    jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index admin_actions_created_idx on private.admin_actions (created_at desc);
revoke all on private.admin_actions from public, anon, authenticated, service_role;

-- The originals of a taken-down build (admins only) and the progress of the Storage delete.
create table private.build_takedowns (
  build_id                 uuid primary key references public.builds (id) on delete cascade,
  battle_id                uuid not null,
  original_name            text,
  original_screenshot_path text,
  original_status          public.build_status not null,
  phase_at_takedown        public.battle_phase not null,
  admin_id                 uuid references auth.users (id) on delete set null,
  note                     text,
  requested_at             timestamptz not null default now(),
  storage_deleted_at       timestamptz
);
revoke all on private.build_takedowns from public, anon, authenticated, service_role;

-- ─── Helpers ──────────────────────────────────────────────────────────────

-- True for a signed-in, non-anonymous user listed in private.admins.
create function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
     and exists (
       select 1
       from private.admins a
       join auth.users u on u.id = a.user_id
       where a.user_id = auth.uid()
         and u.is_anonymous is false)
$$;

create function private.require_admin()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_auth();
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'not_admin',
      detail = 'This needs a moderator account.';
  end if;
  return v_uid;
end;
$$;

-- An optional admin note: trimmed, at most 500 characters.
create function private.clean_note(p_note text)
returns text
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  v_note text := nullif(btrim(p_note), '');
begin
  if v_note is not null and (char_length(v_note) > 500
                             or regexp_replace(v_note, '[\n\r\t]', '', 'g') ~ '[[:cntrl:]]') then
    raise exception using errcode = '22023', message = 'invalid_details',
      detail = 'A note is at most 500 characters.';
  end if;
  return v_note;
end;
$$;

create function private.log_admin_action(p_admin uuid, p_action text, p_build uuid, p_battle uuid,
                                         p_room uuid, p_note text, p_payload jsonb)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  insert into private.admin_actions (admin_id, action, build_id, battle_id, room_id, note, payload)
  values (p_admin, p_action, p_build, p_battle, p_room, p_note, coalesce(p_payload, '{}'::jsonb));
$$;

-- ─── report_build ─────────────────────────────────────────────────────────
create function public.report_build(p_build_id uuid, p_reason text, p_details text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := private.require_auth();
  v_details text := nullif(btrim(p_details), '');
  bu        public.builds;
  b         public.battles;
  v_id      uuid;
  v_at      timestamptz;
begin
  perform private.rate_limit('report_build', v_uid);

  if p_reason is null or p_reason not in ('offensive', 'phishing', 'malware', 'spam', 'other') then
    raise exception using errcode = '22023', message = 'invalid_reason',
      detail = 'Pick one of: offensive, phishing, malware, spam, other.';
  end if;
  if v_details is not null and (char_length(v_details) > 500
                                or regexp_replace(v_details, '[\n\r\t]', '', 'g') ~ '[[:cntrl:]]') then
    raise exception using errcode = '22023', message = 'invalid_details',
      detail = 'The details are at most 500 characters.';
  end if;

  select * into bu from public.builds where id = p_build_id;
  if found then
    select * into b from public.battles where id = bu.battle_id;
  end if;
  if not found
     or bu.taken_down_at is not null
     or bu.status not in ('shipped', 'auto_shipped')
     or not (
       b.phase in ('results', 'destroyed')
       or (b.phase in ('reveal', 'voting')
           and bu.id = any (b.reveal_order)
           and public.is_battle_member(b.id))) then
    raise exception using errcode = 'P0002', message = 'build_not_found',
      detail = 'No such build.';
  end if;
  if bu.builder_id = v_uid then
    raise exception using errcode = 'P0001', message = 'own_build',
      detail = 'You cannot report your own build.';
  end if;

  insert into public.reports (build_id, reporter_id, reason, details)
  values (bu.id, v_uid, p_reason, v_details)
  on conflict (build_id, reporter_id) do nothing
  returning id, created_at into v_id, v_at;
  if v_id is null then
    raise exception using errcode = 'P0001', message = 'already_reported',
      detail = 'You already reported this build. Thanks!';
  end if;

  return jsonb_build_object('report_id', v_id, 'build_id', bu.id, 'reason', p_reason, 'created_at', v_at);
end;
$$;

-- ─── The report queue ─────────────────────────────────────────────────────
-- Reports grouped by build. p_resolved = false: builds with at least one open report,
-- most open reports first; true: builds whose reports are all resolved, latest first.
-- Each build: where it is, its (original) name and screenshot, the takedown state, the
-- reason counts and the reports themselves (newest first, at most 50).
create function public.admin_report_queue(p_resolved boolean default false, p_limit int default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 200);
begin
  perform private.require_admin();

  return jsonb_build_object('builds', coalesce((
    select jsonb_agg(x.item order by x.open_count desc, x.last_at desc)
    from (
      select r.build_id,
             count(*) filter (where r.status = 'open') as open_count,
             max(coalesce(r.resolved_at, r.created_at)) as last_at
      from public.reports r
      group by r.build_id
      having (count(*) filter (where r.status = 'open') > 0) = not coalesce(p_resolved, false)
      order by 2 desc, 3 desc
      limit v_limit
    ) g
    cross join lateral (
      select g.open_count, g.last_at, jsonb_build_object(
        'build_id', bu.id,
        'battle_id', bu.battle_id,
        'battle_phase', b.phase,
        'battle_mode', coalesce(b.settings ->> 'mode', 'multiplayer'),
        'finished_at', b.finished_at,
        'name', coalesce(bu.name, t.original_name),
        'builder_id', bu.builder_id,
        'builder_name', bp.display_name,
        'status', bu.status,
        'final_rank', bu.final_rank,
        'capture_status', bu.capture_status,
        'screenshot_path', bu.screenshot_path,
        'taken_down_at', bu.taken_down_at,
        'takedown', case when t.build_id is not null then jsonb_build_object(
          'requested_at', t.requested_at,
          'storage_deleted_at', t.storage_deleted_at,
          'original_screenshot_path', t.original_screenshot_path,
          'note', t.note,
          'job_status', j.status,
          'job_error', j.last_error) end,
        'open_count', g.open_count,
        'report_count', (select count(*) from public.reports r2 where r2.build_id = bu.id),
        'reasons', (select jsonb_object_agg(rc.reason, rc.n)
                    from (select r3.reason, count(*) as n from public.reports r3
                          where r3.build_id = bu.id group by r3.reason) rc),
        'first_reported_at', (select min(r4.created_at) from public.reports r4 where r4.build_id = bu.id),
        'last_reported_at', (select max(r5.created_at) from public.reports r5 where r5.build_id = bu.id),
        'reports', (select jsonb_agg(jsonb_build_object(
                             'id', r6.id, 'reason', r6.reason, 'details', r6.details,
                             'status', r6.status, 'created_at', r6.created_at,
                             'resolved_at', r6.resolved_at)
                           order by r6.created_at desc)
                    from (select * from public.reports r7 where r7.build_id = bu.id
                          order by r7.created_at desc limit 50) r6)) as item
      from public.builds bu
      join public.battles b on b.id = bu.battle_id
      left join public.battle_players bp on bp.battle_id = bu.battle_id and bp.user_id = bu.builder_id
      left join private.build_takedowns t on t.build_id = bu.id
      left join public.jobs j on j.kind = 'takedown' and j.ref_id = bu.id
      where bu.id = g.build_id
    ) x), '[]'::jsonb));
end;
$$;

-- Dismisses the open reports of a build (they stay in the history as `dismissed`).
create function public.admin_dismiss_reports(p_build_id uuid, p_note text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_admin uuid := private.require_admin();
  v_note  text := private.clean_note(p_note);
  v_battle uuid;
  v_count int;
begin
  select battle_id into v_battle from public.builds where id = p_build_id;
  if v_battle is null then
    raise exception using errcode = 'P0002', message = 'build_not_found',
      detail = 'No such build.';
  end if;

  update public.reports
     set status = 'dismissed', resolved_at = now()
   where build_id = p_build_id and status = 'open';
  get diagnostics v_count = row_count;

  if v_count > 0 then
    perform private.log_admin_action(v_admin, 'dismiss_reports', p_build_id, v_battle, null, v_note,
      jsonb_build_object('dismissed', v_count));
  end if;
  return jsonb_build_object('build_id', p_build_id, 'dismissed', v_count);
end;
$$;

-- Takes a build down (see the top of this file). A build that is already taken down gets
-- already_taken_down, unless its Storage delete failed for good: then the job is queued
-- again (`retry_takedown`).
create function public.admin_take_down_build(p_build_id uuid, p_note text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_admin    uuid := private.require_admin();
  v_note     text := private.clean_note(p_note);
  v_battle   uuid;
  b          public.battles;
  bu         public.builds;
  j          public.jobs;
  v_running  boolean;
  v_actioned int;
  v_before   int;
  v_progress jsonb;
  v_now      timestamptz := now();
begin
  select battle_id into v_battle from public.builds where id = p_build_id;
  if v_battle is null then
    raise exception using errcode = 'P0002', message = 'build_not_found',
      detail = 'No such build.';
  end if;

  -- Lock order: battle row, then builds and jobs (like the job functions).
  select * into b from public.battles where id = v_battle for update;
  select * into bu from public.builds where id = p_build_id for update;

  if bu.taken_down_at is not null then
    select * into j from public.jobs where kind = 'takedown' and ref_id = bu.id for update;
    if j.status = 'failed' then
      update public.jobs
         set status = 'queued', attempts = 0, run_after = v_now, last_error = null, updated_at = v_now
       where id = j.id;
      perform private.log_admin_action(v_admin, 'retry_takedown', bu.id, b.id, null, v_note, '{}'::jsonb);
      return jsonb_build_object('build_id', bu.id, 'battle_id', b.id, 'taken_down_at', bu.taken_down_at,
                                'retried', true, 'job_id', j.id);
    end if;
    raise exception using errcode = 'P0001', message = 'already_taken_down',
      detail = 'This build was already taken down.';
  end if;

  v_running := b.phase not in ('results', 'destroyed', 'abandoned');

  insert into private.build_takedowns (build_id, battle_id, original_name, original_screenshot_path,
                                       original_status, phase_at_takedown, admin_id, note, requested_at)
  values (bu.id, b.id, bu.name, bu.screenshot_path, bu.status, b.phase, v_admin, v_note, v_now);

  update public.builds
     set taken_down_at   = v_now,
         name            = null,
         screenshot_path = null,
         status          = case when v_running then 'disqualified'::public.build_status else status end,
         capture_status  = case when capture_status = 'pending' then 'failed'::public.capture_status
                                else capture_status end
   where id = bu.id;

  -- A capture that has not started will not; one in flight finishes, and complete_capture
  -- ignores its result (the takedown job waits for it, then deletes whatever it stored).
  update public.jobs
     set status = 'done', last_error = 'taken down', updated_at = v_now
   where kind = 'capture' and ref_id = bu.id and status = 'queued';

  insert into public.jobs (kind, ref_id)
  values ('takedown', bu.id)
  on conflict (kind, ref_id) do update
    set status = 'queued', attempts = 0, run_after = v_now, last_error = null, updated_at = v_now
  returning * into j;

  update public.reports
     set status = 'actioned', resolved_at = v_now
   where build_id = bu.id and status = 'open';
  get diagnostics v_actioned = row_count;

  -- A running battle: the build is out of the reveal and the vote from now on.
  if b.phase = 'reveal' and b.reveal_order[b.reveal_index + 1] = bu.id then
    perform private.reveal_move(b.id, null, false, 'takedown');   -- skips taken-down builds
  elsif b.phase = 'voting' then
    v_before := (private.vote_progress(b.id) ->> 'voted_count')::int;
    delete from public.votes where battle_id = b.id and build_id = bu.id;
    v_progress := private.vote_progress(b.id);
    if (v_progress ->> 'voted_count')::int <> v_before then
      perform private.bump(b.id, 'vote', null, v_progress);
    end if;
  end if;
  if b.phase not in ('destroyed', 'abandoned') then
    -- Clients refetch on it (the broadcast is a `sync`). The admin is the actor in the
    -- service-only log; broadcasts never carry actors.
    perform private.bump(b.id, 'takedown', v_admin, jsonb_build_object('build_id', bu.id));
  end if;

  perform private.log_admin_action(v_admin, 'take_down_build', bu.id, b.id, null, v_note,
    jsonb_build_object('phase', b.phase, 'disqualified', v_running, 'actioned_reports', v_actioned,
                       'job_id', j.id));

  return jsonb_build_object(
    'build_id', bu.id,
    'battle_id', b.id,
    'taken_down_at', v_now,
    'disqualified', v_running,
    'actioned_reports', v_actioned,
    'retried', false,
    'job_id', j.id);
end;
$$;

-- ─── Battle and room lookups (the event logs) ─────────────────────────────

-- Everything an admin needs to understand a battle: the row, the room, the roster, the
-- builds (original names of taken-down ones), the battle_events timeline (oldest first,
-- the latest 2000) and the jobs. Logged as `view_battle`.
create function public.admin_battle_log(p_battle_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_admin uuid := private.require_admin();
  b       public.battles;
  v_out   jsonb;
begin
  select * into b from public.battles where id = p_battle_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'battle_not_found',
      detail = 'No such battle.';
  end if;

  select jsonb_build_object(
    'battle', to_jsonb(b),
    'challenge', (select jsonb_build_object('build', c.build_text, 'rule', c.rule_text,
                                            'style', c.style_text,
                                            'time_limit_seconds', c.time_limit_seconds)
                  from public.challenges c where c.id = b.challenge_id),
    'room', (select jsonb_build_object('id', r.id, 'code', r.code, 'status', r.status)
             from public.rooms r where r.id = b.room_id),
    'players', coalesce((
      select jsonb_agg(jsonb_build_object(
               'user_id', bp.user_id,
               'display_name', bp.display_name,
               'is_voter', bp.is_voter,
               'state', case when m.kicked_at is not null then 'kicked'
                             when m.left_at is not null then 'left'
                             when m.user_id is null then null
                             else 'active' end) order by bp.display_name, bp.user_id)
      from public.battle_players bp
      left join public.room_members m on m.room_id = b.room_id and m.user_id = bp.user_id
      where bp.battle_id = b.id), '[]'::jsonb),
    'builds', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', bu.id,
               'builder_id', bu.builder_id,
               'builder_name', bp.display_name,
               'name', coalesce(bu.name, t.original_name),
               'status', bu.status,
               'shipped_at', bu.shipped_at,
               'completion_ms', bu.completion_ms,
               'capture_status', bu.capture_status,
               'screenshot_path', bu.screenshot_path,
               'final_rank', bu.final_rank,
               'total_votes', bu.total_votes,
               'taken_down_at', bu.taken_down_at,
               'reports', (select count(*) from public.reports r where r.build_id = bu.id),
               'open_reports', (select count(*) from public.reports r
                                where r.build_id = bu.id and r.status = 'open'))
             order by bu.final_rank nulls last, bp.display_name, bu.id)
      from public.builds bu
      left join public.battle_players bp on bp.battle_id = bu.battle_id and bp.user_id = bu.builder_id
      left join private.build_takedowns t on t.build_id = bu.id
      where bu.battle_id = b.id), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', e.id,
               'version', e.version,
               'type', e.type,
               'actor_id', e.actor_id,
               'actor_name', coalesce(bp.display_name, p.display_name,
                                      case when e.actor_id is not null and exists (
                                             select 1 from private.admins a where a.user_id = e.actor_id)
                                           then 'moderator' end),
               'payload', e.payload,
               'created_at', e.created_at) order by e.id)
      from (select * from public.battle_events x where x.battle_id = b.id order by x.id desc limit 2000) e
      left join public.battle_players bp on bp.battle_id = b.id and bp.user_id = e.actor_id
      left join public.profiles p on p.id = e.actor_id), '[]'::jsonb),
    'jobs', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', j.id, 'kind', j.kind, 'ref_id', j.ref_id, 'status', j.status,
               'attempts', j.attempts, 'last_error', j.last_error, 'updated_at', j.updated_at)
             order by j.id)
      from public.jobs j
      where (j.kind = 'destroy' and j.ref_id = b.id)
         or (j.kind in ('capture', 'takedown')
             and j.ref_id in (select bu.id from public.builds bu where bu.battle_id = b.id))), '[]'::jsonb)
  ) into v_out;

  perform private.log_admin_action(v_admin, 'view_battle', null, b.id, b.room_id, null, '{}'::jsonb);
  return v_out;
end;
$$;

-- A room by its code (any case): the row, its members, its battles (newest first) and the
-- room_events timeline (oldest first, the latest 2000). Logged as `view_room`. Rooms are
-- purged 7 days after they close; their battles stay findable by id.
create function public.admin_room_log(p_code text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_admin uuid := private.require_admin();
  r       public.rooms;
  v_out   jsonb;
begin
  select * into r from public.rooms where code = upper(btrim(p_code));
  if not found then
    raise exception using errcode = 'P0002', message = 'room_not_found',
      detail = 'No room has this code (closed rooms are purged after 7 days).';
  end if;

  select jsonb_build_object(
    'room', to_jsonb(r) || jsonb_build_object(
      'host_name', (select p.display_name from public.profiles p where p.id = r.host_id)),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
               'user_id', m.user_id,
               'display_name', p.display_name,
               'role', m.role,
               'is_ready', m.is_ready,
               'joined_at', m.joined_at,
               'last_seen_at', m.last_seen_at,
               'left_at', m.left_at,
               'kicked_at', m.kicked_at) order by m.joined_at, m.user_id)
      from public.room_members m
      left join public.profiles p on p.id = m.user_id
      where m.room_id = r.id), '[]'::jsonb),
    'battles', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', b.id, 'phase', b.phase, 'created_at', b.created_at,
               'finished_at', b.finished_at, 'is_complete', b.is_complete) order by b.created_at desc)
      from public.battles b where b.room_id = r.id), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', e.id,
               'version', e.version,
               'type', e.type,
               'actor_id', e.actor_id,
               'actor_name', p.display_name,
               'payload', e.payload,
               'created_at', e.created_at) order by e.id)
      from (select * from public.room_events x where x.room_id = r.id order by x.id desc limit 2000) e
      left join public.profiles p on p.id = e.actor_id), '[]'::jsonb)
  ) into v_out;

  perform private.log_admin_action(v_admin, 'view_room', null, null, r.id, null,
    jsonb_build_object('code', r.code));
  return v_out;
end;
$$;

-- The latest admin actions, newest first (who did what).
create function public.admin_action_log(p_limit int default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', a.id,
             'admin_id', a.admin_id,
             'admin_email', u.email,
             'action', a.action,
             'build_id', a.build_id,
             'battle_id', a.battle_id,
             'room_id', a.room_id,
             'note', a.note,
             'payload', a.payload,
             'created_at', a.created_at) order by a.id desc)
    from (select * from private.admin_actions x order by x.id desc
          limit least(greatest(coalesce(p_limit, 50), 1), 200)) a
    left join auth.users u on u.id = a.admin_id), '[]'::jsonb);
end;
$$;

-- ─── Privileges ───────────────────────────────────────────────────────────
revoke all on function private.admins_guard()                                     from public, anon, authenticated, service_role;
revoke all on function private.require_admin()                                    from public, anon, authenticated, service_role;
revoke all on function private.clean_note(text)                                   from public, anon, authenticated, service_role;
revoke all on function private.log_admin_action(uuid, text, uuid, uuid, uuid, text, jsonb)
  from public, anon, authenticated, service_role;

revoke all on function public.is_admin()                                          from public, anon;
revoke all on function public.report_build(uuid, text, text)                      from public, anon;
revoke all on function public.admin_report_queue(boolean, int)                    from public, anon;
revoke all on function public.admin_dismiss_reports(uuid, text)                   from public, anon;
revoke all on function public.admin_take_down_build(uuid, text)                   from public, anon;
revoke all on function public.admin_battle_log(uuid)                              from public, anon;
revoke all on function public.admin_room_log(text)                                from public, anon;
revoke all on function public.admin_action_log(int)                               from public, anon;

grant execute on function public.is_admin()                                       to authenticated;
grant execute on function public.report_build(uuid, text, text)                   to authenticated;
grant execute on function public.admin_report_queue(boolean, int)                 to authenticated;
grant execute on function public.admin_dismiss_reports(uuid, text)                to authenticated;
grant execute on function public.admin_take_down_build(uuid, text)                to authenticated;
grant execute on function public.admin_battle_log(uuid)                           to authenticated;
grant execute on function public.admin_room_log(text)                             to authenticated;
grant execute on function public.admin_action_log(int)                            to authenticated;
