-- Build Roulette: initial schema.
--
-- Implements docs/05-database.md §5.2 (DDL) and §5.3 (row-level security).
-- Principle (docs/01 §1.1, §1.4): clients get SELECT only, through RLS. Every
-- write goes through SECURITY DEFINER RPCs added by later migrations.
--
-- Deviations from the §5.2 draft are marked "DEVIATION" with the reason.
-- Every object is schema-qualified, so the migration does not depend on the
-- caller's search_path.

-- ─── Extensions ───────────────────────────────────────────────────────────
-- On Supabase pgcrypto is preinstalled in `extensions`; this is then a no-op.
create extension if not exists pgcrypto with schema extensions;

-- ─── Enums ────────────────────────────────────────────────────────────────
create type public.card_kind      as enum ('build', 'rule', 'style');
create type public.room_status    as enum ('open', 'in_battle', 'closed');
create type public.member_role    as enum ('player', 'spectator');
create type public.battle_phase   as enum ('spinning', 'building', 'shipping', 'reveal',
                                           'voting', 'results', 'destroyed', 'abandoned');
create type public.build_status   as enum ('draft', 'shipped', 'auto_shipped', 'dnf', 'disqualified');
create type public.capture_status as enum ('pending', 'captured', 'fallback', 'failed');
create type public.job_kind       as enum ('capture', 'destroy');
create type public.job_status     as enum ('queued', 'running', 'done', 'failed');

-- ─── People ───────────────────────────────────────────────────────────────
create table public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  display_name  text not null check (char_length(display_name) between 1 and 24),
  -- DEVIATION: gen_random_bytes is qualified with `extensions.` (pgcrypto
  -- lives there on Supabase and `public` is not on its search_path).
  avatar_seed   text not null default encode(extensions.gen_random_bytes(6), 'hex'),
  created_at    timestamptz not null default now()
);

-- ─── Challenge deck ───────────────────────────────────────────────────────
create table public.prompt_cards (
  id         uuid primary key default gen_random_uuid(),
  kind       public.card_kind not null,
  text       text not null,                 -- "A pomodoro timer"
  hint       text,                          -- optional clarification
  weight     int  not null default 10 check (weight > 0),
  tags       text[] not null default '{}',  -- e.g. {'canvas','audio'} to avoid impossible combos
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.challenges (
  id                 uuid primary key default gen_random_uuid(),
  build_card_id      uuid references public.prompt_cards (id),
  rule_card_id       uuid references public.prompt_cards (id),
  style_card_id      uuid references public.prompt_cards (id),
  -- text snapshots: editing a card later never rewrites history
  build_text         text not null,
  rule_text          text not null,
  style_text         text not null,
  time_limit_seconds int  not null check (time_limit_seconds between 60 and 3600),
  created_at         timestamptz not null default now()
);

-- ─── Rooms (transient lobby, kept small) ──────────────────────────────────
create table public.rooms (
  id                uuid primary key default gen_random_uuid(),
  code              text not null unique check (code ~ '^[A-HJ-NP-Z2-9]{5}$'), -- no I/O/0/1
  host_id           uuid not null references public.profiles (id),
  status            public.room_status not null default 'open',
  settings          jsonb not null default '{}',  -- max_players, allowed_time_limits, reveal_slot_s, vote_s, categories[]
  current_battle_id uuid,                         -- fk added below
  created_at        timestamptz not null default now(),
  last_activity_at  timestamptz not null default now(),
  closed_at         timestamptz
);

create table public.room_members (
  room_id      uuid not null references public.rooms (id) on delete cascade,
  user_id      uuid not null references public.profiles (id),
  role         public.member_role not null default 'player',
  is_ready     boolean not null default false,
  joined_at    timestamptz not null default now(),
  last_seen_at timestamptz not null default now(), -- heartbeat RPC; used by abandonment sweep
  left_at      timestamptz,
  kicked_at    timestamptz,
  primary key (room_id, user_id)
);

-- ─── Battles (permanent) ──────────────────────────────────────────────────
create table public.battles (
  id                  uuid primary key default gen_random_uuid(),
  room_id             uuid references public.rooms (id) on delete set null,  -- results outlive rooms
  -- DEVIATION: unique. The ER diagram says challenges ||--|| battles and
  -- start_battle inserts a fresh challenge per battle. The unique index also
  -- serves the challenges RLS lookup (battles by challenge_id).
  challenge_id        uuid not null unique references public.challenges (id),
  host_id             uuid not null references public.profiles (id),
  phase               public.battle_phase not null default 'spinning',
  version             int not null default 0,
  phase_started_at    timestamptz not null default now(),
  phase_ends_at       timestamptz,
  settings            jsonb not null,               -- snapshot of room settings at start
  building_started_at timestamptz,
  building_ends_at    timestamptz,
  shipping_ended_at   timestamptz,
  reveal_order        uuid[] not null default '{}', -- build ids
  reveal_index        int not null default 0,
  finished_at         timestamptz,                  -- results computed
  destroyed_at        timestamptz,                  -- ephemeral data confirmed deleted
  is_complete         boolean not null default false, -- false for abandoned
  created_at          timestamptz not null default now()
);
alter table public.rooms add constraint rooms_current_battle_fk
  foreign key (current_battle_id) references public.battles (id) on delete set null;

create index battles_active_deadline_idx on public.battles (phase_ends_at)
  where phase not in ('destroyed', 'abandoned');
create index battles_room_idx on public.battles (room_id, created_at desc);

create table public.battle_players (
  battle_id      uuid not null references public.battles (id) on delete cascade,
  user_id        uuid not null references public.profiles (id),
  display_name   text not null,        -- snapshot for permanent results
  is_voter       boolean not null default true,
  voted_at       timestamptz,          -- set when all categories are cast
  primary key (battle_id, user_id)
);
-- Not in the draft: supports "battles I played in" (history page) and the
-- FK check when a profile is deleted.
create index battle_players_user_idx on public.battle_players (user_id);

-- ─── Builds (permanent metadata only) ─────────────────────────────────────
create table public.builds (
  id                  uuid primary key default gen_random_uuid(),
  battle_id           uuid not null references public.battles (id) on delete cascade,
  builder_id          uuid not null references public.profiles (id),
  name                text check (char_length(name) between 1 and 48),
  status              public.build_status not null default 'draft',
  shipped_at          timestamptz,
  completion_ms       int check (completion_ms >= 0),
  stats               jsonb not null default '{}',   -- {files, lines, deps[], bundle_bytes, rebuilds, pastes}
  capture_status      public.capture_status not null default 'pending',
  screenshot_path     text,                          -- screenshots/{battle_id}/{id}.webp
  captured_at         timestamptz,
  source_destroyed_at timestamptz,
  final_rank          int,
  total_votes         int not null default 0,
  created_at          timestamptz not null default now(),
  unique (battle_id, builder_id),
  -- DEVIATION: target for the composite FKs from votes and awards, so a vote
  -- or award can only reference a build of the same battle.
  unique (id, battle_id),
  foreign key (battle_id, builder_id) references public.battle_players (battle_id, user_id)
);
create index builds_builder_history_idx on public.builds (builder_id, created_at desc);

-- ─── Voting & awards ──────────────────────────────────────────────────────
create table public.vote_categories (
  slug        text primary key,           -- 'overall', 'rule', 'style', 'chaos'
  label       text not null,
  description text,
  sort_order  int not null default 0,
  is_active   boolean not null default true
);

create table public.votes (
  battle_id  uuid not null references public.battles (id) on delete cascade,
  voter_id   uuid not null,
  category   text not null references public.vote_categories (slug),
  build_id   uuid not null references public.builds (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (battle_id, voter_id, category),
  foreign key (battle_id, voter_id) references public.battle_players (battle_id, user_id),
  -- DEVIATION: the draft allowed a vote in battle X for a build of battle Y.
  foreign key (build_id, battle_id)
    references public.builds (id, battle_id) on delete cascade
);
-- Not in the draft: tallies by build and the cascade from builds.
create index votes_build_idx on public.votes (build_id);

create table public.awards (
  id         uuid primary key default gen_random_uuid(),
  battle_id  uuid not null references public.battles (id) on delete cascade,
  build_id   uuid not null references public.builds (id) on delete cascade,
  award      text not null,               -- category slug or auto award: 'fastest_ship', 'clutch_ship', 'winner'
  source     text not null check (source in ('vote', 'auto')),
  votes      int,
  created_at timestamptz not null default now(),
  unique (battle_id, award, build_id),    -- ties produce multiple rows
  -- DEVIATION: same-battle guarantee, as for votes.
  foreign key (build_id, battle_id)
    references public.builds (id, battle_id) on delete cascade
);
-- Not in the draft: "awards won by this build" and the cascade from builds.
create index awards_build_idx on public.awards (build_id);

-- ─── Ops ──────────────────────────────────────────────────────────────────
create table public.battle_events (         -- append-only audit/debug log
  id         bigint generated always as identity primary key,
  battle_id  uuid not null references public.battles (id) on delete cascade,
  version    int not null,
  type       text not null,                 -- 'phase', 'ship', 'vote', 'kick', 'host_change', ...
  actor_id   uuid,                          -- null = system/cron
  payload    jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index battle_events_battle_idx on public.battle_events (battle_id, id);

create table public.jobs (                  -- tiny durable queue for capture/destroy workers
  id          bigint generated always as identity primary key,
  kind        public.job_kind not null,
  ref_id      uuid not null,                -- build_id (capture) or battle_id (destroy)
  status      public.job_status not null default 'queued',
  attempts    int not null default 0,
  run_after   timestamptz not null default now(),
  last_error  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (kind, ref_id)
);
create index jobs_ready_idx on public.jobs (run_after) where status in ('queued', 'running');

create table public.reports (
  id          uuid primary key default gen_random_uuid(),
  build_id    uuid not null references public.builds (id) on delete cascade,
  reporter_id uuid not null references public.profiles (id),
  reason      text not null check (reason in ('offensive', 'phishing', 'malware', 'spam', 'other')),
  details     text,
  status      text not null default 'open' check (status in ('open', 'actioned', 'dismissed')),
  created_at  timestamptz not null default now(),
  unique (build_id, reporter_id)
);

-- ─── Reference data ───────────────────────────────────────────────────────
-- Default vote categories (docs/04 §4.9). Seeded here rather than in seed.sql
-- because seed.sql only runs on local `supabase db reset`, never on
-- `supabase db push` to a hosted project, and votes.category has an FK to
-- these rows: production needs them.
insert into public.vote_categories (slug, label, description, sort_order) values
  ('overall', 'Best Build',           'The build you would actually use.',              10),
  ('rule',    'Best Use of the Rule', 'Who turned the RULE card into a feature.',       20),
  ('style',   'Best Style',           'Who nailed the STYLE card.',                     30),
  ('chaos',   'Most Chaotic',         'Delightfully unhinged. Bugs may be features.',   40)
on conflict (slug) do nothing;

-- ═══ Row-level security (docs/05 §5.3) ════════════════════════════════════
--
-- Visibility definitions used by the policies:
--
--   room member     A row in room_members for (room, auth.uid()) with
--                   kicked_at IS NULL. Leaving (left_at set) does not remove
--                   visibility: the player can still rejoin and see the
--                   lobby. Kicking does.
--
--   battle member   EITHER on the battle's roster (battle_players), OR a
--                   room member (as above) of the room that hosts the battle
--                   (battles.room_id). The room path covers spectators and
--                   late joiners. Once the room is purged (room_id set to
--                   null), only the roster remains.
--
--   battle visible  battle member, OR phase in ('results', 'destroyed')
--                   (public results pages). 'abandoned' is NOT public.
--
-- The helpers are SECURITY DEFINER so that the lookups they do are not
-- themselves subject to RLS (no policy recursion, cheap index probes). They
-- only ever answer a question about the caller (auth.uid()).

create function public.is_room_member(p_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.room_members rm
    where rm.room_id = p_room_id
      and rm.user_id = (select auth.uid())
      and rm.kicked_at is null
  );
$$;

create function public.is_battle_member(p_battle_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.battle_players bp
    where bp.battle_id = p_battle_id
      and bp.user_id = (select auth.uid())
  )
  or exists (
    select 1
    from public.battles b
    join public.room_members rm on rm.room_id = b.room_id
    where b.id = p_battle_id
      and rm.user_id = (select auth.uid())
      and rm.kicked_at is null
  );
$$;

create function public.can_view_battle(p_battle_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.battles b
    where b.id = p_battle_id
      and b.phase in ('results'::public.battle_phase, 'destroyed'::public.battle_phase)
  )
  or public.is_battle_member(p_battle_id);
$$;

revoke all on function public.is_room_member(uuid)   from public, anon;
revoke all on function public.is_battle_member(uuid) from public, anon;
revoke all on function public.can_view_battle(uuid)  from public, anon;
grant execute on function public.is_room_member(uuid)   to authenticated, service_role;
grant execute on function public.is_battle_member(uuid) to authenticated, service_role;
grant execute on function public.can_view_battle(uuid)  to authenticated, service_role;

alter table public.profiles        enable row level security;
alter table public.prompt_cards    enable row level security;
alter table public.challenges      enable row level security;
alter table public.rooms           enable row level security;
alter table public.room_members    enable row level security;
alter table public.battles         enable row level security;
alter table public.battle_players  enable row level security;
alter table public.builds          enable row level security;
alter table public.vote_categories enable row level security;
alter table public.votes           enable row level security;
alter table public.awards          enable row level security;
alter table public.battle_events   enable row level security;
alter table public.jobs            enable row level security;
alter table public.reports         enable row level security;

-- SELECT policies only. There are deliberately no INSERT/UPDATE/DELETE
-- policies: clients write through RPCs. prompt_cards, battle_events and jobs
-- have no policy at all (service role / SECURITY DEFINER only).

create policy profiles_select on public.profiles
  for select to authenticated
  using (true);

create policy challenges_select on public.challenges
  for select to authenticated
  using (exists (
    select 1 from public.battles b
    where b.challenge_id = challenges.id
      and public.can_view_battle(b.id)
  ));

create policy rooms_select on public.rooms
  for select to authenticated
  using (public.is_room_member(id));

create policy room_members_select on public.room_members
  for select to authenticated
  using (public.is_room_member(room_id));

create policy battles_select on public.battles
  for select to authenticated
  using (phase in ('results', 'destroyed') or public.is_battle_member(id));

create policy battle_players_select on public.battle_players
  for select to authenticated
  using (public.can_view_battle(battle_id));

create policy builds_select on public.builds
  for select to authenticated
  using (public.can_view_battle(battle_id));

-- Not listed in §5.3: categories are non-secret reference data that the
-- ballot UI needs.
create policy vote_categories_select on public.vote_categories
  for select to authenticated
  using (true);

create policy votes_select_own on public.votes
  for select to authenticated
  using (voter_id = (select auth.uid()));

create policy awards_select on public.awards
  for select to authenticated
  using (public.can_view_battle(battle_id));

create policy reports_select_own on public.reports
  for select to authenticated
  using (reporter_id = (select auth.uid()));

-- ─── Table privileges ─────────────────────────────────────────────────────
-- Supabase's default privileges grant ALL on every new public table to anon
-- and authenticated. RLS alone would already block writes (no write
-- policies), but we also remove the privileges so that a mistakenly added
-- permissive policy can never open a write path.
--
-- anon gets nothing. Every real user, including "anonymous" sign-ins, holds
-- the `authenticated` role; `anon` is only a request with no session at all.
-- Public results pages read through get_battle_snapshot (an RPC, later task)
-- or server-side, so no table needs to be readable without a session.
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant select on
  public.profiles,
  public.challenges,
  public.rooms,
  public.room_members,
  public.battles,
  public.battle_players,
  public.builds,
  public.vote_categories,
  public.votes,
  public.awards,
  public.reports
to authenticated;

-- service_role (server-side workers) bypasses RLS and keeps full access.
grant all on all tables    in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- Secure by default for later migrations: tables and sequences created by the
-- migration role in `public` are no longer auto-granted to anon or
-- authenticated. Each later migration grants SELECT explicitly when it adds a
-- policy.
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
