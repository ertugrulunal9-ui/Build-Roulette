# supabase/

Database schema, RPCs, storage policies and database tests for Build Roulette.
The design lives in [docs/04-state-machine.md](../docs/04-state-machine.md) and
[docs/05-database.md](../docs/05-database.md); this folder implements it.

## Layout

```
supabase/
├── config.toml                  Supabase CLI v2 config (local stack; anonymous sign-ins, manual linking)
├── migrations/
│   ├── 20261003120000_initial_schema.sql              enums, tables, indexes, RLS, grants, vote categories
│   ├── 20261004120000_private_schema_and_constants.sql  function default privileges, `private` schema,
│   │                                                    time limits, default durations, tag rule
│   ├── 20261004120100_prompt_deck.sql                 60 BUILD / 40 RULE / 30 STYLE cards, tag vocabulary
│   ├── 20261004120200_storage.sql                     buckets + storage.objects policies
│   ├── 20261004120300_solo_battle.sql                 state machine + client RPCs
│   ├── 20261004120400_jobs.sql                        capture/destroy job queue (service role)
│   ├── 20261004120500_sweeps_and_cron.sql             sweep_deadlines, sweep_ttl, pg_cron schedule
│   ├── 20261006120000_autosave_css_and_public_battle.sql  autosave/bundle.css slot, get_public_battle (T-014)
│   ├── 20261006130000_rooms.sql                       room_events, lobby RPCs, host migration, kick visibility (T-016)
│   ├── 20261006130100_multiplayer_battle.sql          start_battle, multiplayer results, room reopen (T-016)
│   ├── 20261006130200_presence_sweeps.sql             abandonment, host migration, idle close, purge (T-016)
│   └── 20261006130300_realtime.sql                    broadcast triggers, realtime.messages policies (T-016)
├── tests/                       pgTAP tests (*.test.sql), one transaction each, rolled back
│   ├── 00_schema.test.sql       tables/enums exist, RLS on every table, policies, table privileges
│   ├── 01_constraints.test.sql  room codes, time limits, one build per player, vote PK, cascades
│   ├── 02_rls.test.sql          who can see what, with fixture users; no client writes
│   ├── 03_deck.test.sql         deck counts and tags, the draw (tag rules, recency, weights)
│   ├── 04_functions.test.sql    SECURITY DEFINER + search_path, EXECUTE grants per role
│   ├── 05_solo_lifecycle.test.sql  spin → build → ship → results → destroy, auto-ship, DNF, awards
│   ├── 06_guards.test.sql       every RPC guard
│   ├── 07_jobs.test.sql         claim / fail / backoff / lease, complete_capture, complete_destroy
│   ├── 08_storage.test.sql      storage.objects policies as the API roles
│   ├── 09_sweeps.test.sql       sweep_deadlines, sweep_ttl, pg_cron jobs
│   ├── 10_public_battle.test.sql   get_public_battle (permanent data only, RESULTS/DESTROYED only), autosave/bundle.css
│   ├── 11_rooms.test.sql        lobby RPCs and every guard (create, join, ready, settings, kick, heartbeat, snapshot)
│   ├── 12_multiplayer_lifecycle.test.sql  two battles in a room: ship/auto-ship/DNF, kick, leave, early end, ties
│   ├── 13_presence.test.sql     host migration (lazy + sweep), abandonment, idle close, purge
│   └── 14_realtime.test.sql     broadcast payloads (one per version), realtime.messages RLS per role
└── scripts/
    ├── e2e-solo.mjs             the solo loop through the real HTTP APIs (Auth, PostgREST, Storage, pg_cron)
    ├── e2e-multiplayer.mjs      a 3-player battle + late spectator through supabase-js, with Realtime reception
    ├── e2e-realtime.mjs         private topics, gap-free versions, presence, refused subscriptions
    └── lib.mjs                  shared helpers of the two scripts above (supabase-js from apps/web)
```

There is no `seed.sql`. Reference data that production needs (vote categories, the
prompt deck) is inserted by migrations, because `seed.sql` never runs on `supabase db push`.

## Running the tests

Everything runs against the real local Supabase stack (Docker). The plain-Postgres harness
(`scripts/test.sh` + a Supabase shim) was retired in T-011: storage policies, `storage.*`
triggers and pg_cron cannot be emulated faithfully, and tests against an emulation would
prove the emulation.

```bash
# once per session (in the cloud container: start dockerd first, and pull from Docker Hub)
SUPABASE_INTERNAL_IMAGE_REGISTRY=docker.io npx -y supabase@2.119.0 start \
  -x studio,imgproxy,vector,logflare,edge-runtime,supavisor,mailpit,postgres-meta

npx -y supabase@2.119.0 db reset             # re-apply all migrations to a fresh database
npx -y supabase@2.119.0 test db              # pgTAP: supabase/tests/*.test.sql
node supabase/scripts/e2e-solo.mjs           # solo API end-to-end check (needs psql on PATH)
node supabase/scripts/e2e-multiplayer.mjs    # multiplayer + Realtime (needs psql and pnpm install)
node supabase/scripts/e2e-realtime.mjs       # Realtime authorization and ordering (same needs)

npx -y supabase@2.119.0 stop --no-backup
```

`SUPABASE_INTERNAL_IMAGE_REGISTRY=docker.io` is only needed where `public.ecr.aws` is blocked
(the cloud dev container). **Realtime must run** for `14_realtime.test.sql` and the two
supabase-js scripts (it owns `realtime.messages` and its daily partitions). The migrations
themselves also apply to a stack started with `-x realtime` (the capture CI job does that).
Drop `studio,postgres-meta` from `-x` to get the dashboard. The containers are named after
`project_id`, so only one checkout can run the stack at a time.

The e2e scripts commit data (anonymous users, rooms, battles, small files) and move deadlines
with psql. `e2e-multiplayer.mjs` and `e2e-realtime.mjs` use `@supabase/supabase-js`, resolved
from `apps/web` (so run `pnpm install` first); `e2e-solo.mjs` has no dependencies. Run it on a stack you can reset. They read `API_URL`, `ANON_KEY`, `SERVICE_ROLE_KEY` and
`DB_URL` from the environment or from `supabase status -o env`; `VERBOSE=1` prints the
response behind each check. Locally the anonymous sign-up limit is raised to 300 per hour
(`config.toml`), since a full run signs up about a dozen users.

CI (`.github/workflows/ci.yml`, job `db`) runs the same steps on a fresh stack with Realtime.

### Writing pgTAP tests

- Each file is `begin; create extension if not exists pgtap with schema extensions;
  select plan(n); ... select * from finish(); rollback;`.
- Tests run through psql, so `\set` and `\gset` work (e.g. keep a battle id returned by an RPC).
- Insert fixtures as the superuser (RLS doesn't apply), then impersonate:
  ```sql
  set local role authenticated;
  select set_config('request.jwt.claims', '{"sub":"<uuid>","role":"authenticated"}', true);
  -- service role: set local role service_role; claims '{"role":"service_role"}'
  ```
  Use `reset role;` to go back to the superuser.
- **Time:** inside a transaction `now()` is constant. Simulate time by moving
  `phase_ends_at`, `building_started_at`, `building_ends_at` etc. into the past.
- A function that inserts a row can't have that row read back in the *same* statement
  (statement snapshot); call it with `\gset` first.
- `storage.objects` blocks direct DELETEs with a trigger; set
  `storage.allow_delete_query = 'true'` (locally) to test what RLS alone allows.
- Prefer catalog-driven checks (00, 04) so new tables and functions are covered
  automatically.

## Security model (summary)

- RLS is enabled on every `public` table. Table policies are SELECT-only and granted `to authenticated`.
- `anon` and `authenticated` have no INSERT/UPDATE/DELETE/TRUNCATE privilege on any table.
  All writes go through `SECURITY DEFINER` RPCs.
- `anon` (a request with no session) can read nothing and execute exactly one function,
  `get_public_battle`, which returns the permanent results of a battle in RESULTS or
  DESTROYED (the shareable `/battles/[id]` page renders with the anon key). Anonymous
  sign-ins still get the `authenticated` role.
- Default privileges: tables, sequences and functions created by later migrations are *not*
  auto-exposed to `anon`/`authenticated` (functions not to `PUBLIC` either). Grant
  explicitly.
- Every function is `SECURITY DEFINER` with `search_path = ''` and schema-qualified
  references. Internal helpers live in schema `private`, on which no API role has USAGE
  and which the Data API does not expose.
- `authenticated` can execute exactly: `server_now`, `start_solo_battle`,
  `advance_battle`, `ship_build`, `get_battle_snapshot`, `get_public_battle`, the room RPCs
  (`create_room`, `join_room`, `leave_room`, `set_ready`, `update_room_settings`,
  `kick_member`, `heartbeat`, `get_room_snapshot`, `start_battle`), and the RLS helpers
  `is_room_member`, `is_battle_member`, `can_view_battle`, `can_write_build_object`,
  `can_use_realtime_topic`. Worker and sweep functions are `service_role` only.
- Kicks (T-016, replacing the T-002 note): a kicked member loses the room, its Realtime
  topics and the running battle they were on (`is_battle_member` is false for them); the
  battle becomes readable again, like for everyone, once it reaches RESULTS.
- Realtime: only room members receive `room:{id}`, only battle members receive
  `battle:{id}`; clients may send Presence only, never Broadcast (see below).

## RPCs (M2)

Errors use a stable snake_case `message` (supabase-js `error.message`) and a human `details`.
SQLSTATEs: 42501 auth/roster/membership, P0002 not found, 22023 bad input, P0001 guard
failures, 0A000 not implemented.

| RPC | Caller | Returns |
|---|---|---|
| `server_now()` | authenticated | `timestamptz` (clock_timestamp) |
| `start_solo_battle(p_display_name text, p_time_limit_seconds int default null)` | authenticated | battle `uuid` |
| `advance_battle(p_battle_id uuid, p_expected_version int)` | battle member, service role | `{changed, version, phase, phase_ends_at}` |
| `ship_build(p_battle_id uuid, p_name text, p_stats jsonb default '{}')` | roster player | `{build: {id, status, name, shipped_at, completion_ms, stats}, battle: {version, phase, phase_ends_at}}` |
| `get_battle_snapshot(p_battle_id uuid)` | member, or anyone signed in once RESULTS/DESTROYED | `{server_now, me, battle, challenge, players, builds, awards}` |
| `get_public_battle(p_battle_id uuid)` | anyone, including `anon`; RESULTS/DESTROYED only, otherwise `battle_not_found` | `{battle, challenge, players, builds, awards}`: permanent data only (display names, no user ids, no ephemeral paths; screenshot path only once captured) |
| `claim_job(p_kind job_kind)` | service role | `jobs` row, or all-null when there is nothing to do |
| `complete_capture(p_build_id uuid, p_status capture_status, p_path text)` | service role | void |
| `fail_job(p_job_id bigint, p_error text)` | service role | `jobs` row |
| `complete_destroy(p_battle_id uuid)` | service role | void |
| `sweep_deadlines()`, `sweep_ttl()` | pg_cron, service role | `int` |

## Rooms and multiplayer (M3, T-016)

| RPC | Caller | Returns | Errors (besides `not_authenticated`) |
|---|---|---|---|
| `create_room(p_display_name text)` | authenticated | `{room_id, code}` | `invalid_display_name`, `too_many_rooms` (3 hosted, not closed) |
| `join_room(p_code text, p_display_name text)` | authenticated | `{room_id, code, role}` | `room_not_found`, `room_closed`, `kicked`, `room_full`, `invalid_display_name` |
| `leave_room(p_room_id uuid)` | member | void | `room_not_found`, `not_a_member` |
| `set_ready(p_room_id uuid, p_ready boolean)` | active player, room open | void | `invalid_ready`, `room_not_found`, `not_a_member`, `kicked`, `not_a_player`, `wrong_room_state` |
| `update_room_settings(p_room_id uuid, p_settings jsonb)` | host, room open | the new settings | `room_not_found`, `not_a_member`, `not_host`, `wrong_room_state`, `invalid_settings` |
| `kick_member(p_room_id uuid, p_user_id uuid)` | host | void | `room_not_found`, `not_a_member`, `not_host`, `cannot_kick_self`, `member_not_found` |
| `heartbeat(p_room_id uuid)` | active member | `{server_now, room_version, host_id, status}` | `room_not_found`, `not_a_member`, `kicked`, `room_closed` |
| `get_room_snapshot(p_room_id uuid)` | member (also after leaving; not kicked) | `{server_now, me, room, members, battle}` | `room_not_found` |
| `start_battle(p_room_id uuid)` | host, room open | battle `uuid` | `room_not_found`, `not_a_member`, `not_host`, `wrong_room_state`, `not_enough_players` |

`ship_build` adds `kicked` (42501), `not_a_member` (42501, left the room) and `disqualified`
(P0001) for room battles. Any room RPC may rarely raise `room_busy` (P0001, retry).
For multiplayer battles `get_battle_snapshot` adds `me.role` (`player`, `spectator` or
`viewer`), `me.is_host` and `players[].state` (`active`, `left` or `kicked`); the solo
snapshot is unchanged.

- **Room:** a code of 5 characters from `A–H J–N P–Z 2–9`; at most 8 players
  (`settings.max_players`, 2–8) and 20 spectators. Settings: `max_players`, plus
  `reveal_slot_s` / `voting_s` stored for M4. The build time limit is never a setting: the
  server draws 5, 10 or 15 minutes per battle.
- **Members:** active, left (can rejoin, still reads the lobby) or kicked (cannot rejoin, no
  access). Joining an open room makes you a player while a slot is free, otherwise a
  spectator; joining during a battle makes you a spectator (a roster player coming back
  plays on). Spectators are promoted in join order when a player slot frees in an open room
  and when the room reopens. The last active member leaving an open room closes it.
- **Presence:** clients call `heartbeat` about every 10 s while the room page is open, also
  during a battle (writes are rate-limited to one per 5 s; extra calls are no-ops). Any
  member RPC counts too. Present = active and seen within 30 s.
- **Host migration:** when the host is not present (left, kicked, silent 30 s), the present
  member who joined earliest becomes host (players first). Done lazily by the RPCs and by
  `sweep_deadlines`; logged as `host_changed` in `room_events` and, during a battle, as
  `host_change` in `battle_events` (`battles.host_id` follows).
- **Battles:** `start_battle` freezes the roster (ready and present players, join order, at
  most `max_players`, at least 2), creates a draft per player, resets readiness and puts
  the room `in_battle`. M3 battles run SPINNING → BUILDING → SHIPPING → RESULTS →
  DESTROYED (`settings.reveal_vote = false`; M4 adds REVEAL and VOTING there). BUILDING
  ends early when every roster player still active in the room (not left, not kicked) has
  shipped. Drafts of everyone else, including players who left, are auto-shipped or DNF at
  the end of SHIPPING. A kick disqualifies the player's draft. At DESTROYED or ABANDONED the
  room reopens (`current_battle_id` keeps pointing at the finished battle until the next
  start).
- **Ranks (M3):** shipped and auto-shipped builds by `completion_ms`, then hand-shipped
  before auto-shipped, then earlier `shipped_at`; builds equal on all three share the rank
  (1, 1, 3). Awards: `clutch_ship`, `speedrun`, and `fastest_ship` when at least two builds
  were shipped by hand (shared on a tie).
- **Sweeps:** `sweep_deadlines` (5 s) also abandons room battles with no roster player seen
  for 5 minutes (not in RESULTS) and migrates hosts; `sweep_ttl` (10 min) also closes open
  rooms idle for 2 hours (no room event, no heartbeat) and deletes rooms closed for 7 days
  (battles keep their results with `room_id = null`).
- **Lock order:** battle row, then room row, then member rows (`private.lock_room`).
- The limits live in `private.room_limits()`.

## Realtime (M3, T-016)

Private channels only (`supabase.channel(topic, { config: { private: true } })`):

| Topic | Who receives | Who may track Presence |
|---|---|---|
| `room:{room_id}` | room members (active or left, not kicked) | active members |
| `battle:{battle_id}` | battle members (roster, or room members; not kicked) | active members of the room (roster players of a solo battle) |

No client may send Broadcast: every broadcast is authoritative state from Postgres. The
policies on `realtime.messages` call `public.can_use_realtime_topic` and also require the
row's topic to be the channel's topic.

Every `battle_events` / `room_events` row (exactly one per `battles.version` /
`rooms.version`) becomes one broadcast through a trigger, in the same transaction
(`realtime.send`, private). The event name is `payload.type`; every payload has `version`:

| Topic | Event | Payload (besides `type`, `version` and the `id` Realtime adds) |
|---|---|---|
| battle | `phase` | `phase, phase_started_at, phase_ends_at, reason?` (`reveal_index` in M4) |
| battle | `build` | `build_id, user_id, status: 'shipped', name, completion_ms` |
| battle | `player` | `user_id, status ('left', 'active' or 'kicked'), build_status?` |
| battle | `host` | `host_id` |
| battle | `capture` | `build_id, capture_status` |
| battle | `destroyed` | nothing (the destroy-worker finished) |
| room | `room` | `change, status, host_id, settings, current_battle_id, reason?` |
| room | `member` | `change, user_id, display_name, role, is_ready, state` |
| both | `sync` | nothing (an event type the client does not know: refetch) |

Clients keep the snapshot `version`, ignore `version <= current`, refetch on a gap, and
refetch the battle snapshot after `phase` events (builds, ranks and awards change in bulk
at RESULTS). Payloads never carry votes, storage paths, stats, room codes or presence data.

**Production:** in the dashboard (Realtime → Settings) turn off public access, so channels
are private-only and nobody can use a public channel of the same name. Realtime checks the
policies when a channel is joined, so an open subscription survives a kick until the
client rejoins or refreshes its token; every RPC re-checks.

## Auth (M3)

`config.toml` enables `enable_manual_linking` (an anonymous player links GitHub or Google
later with `linkIdentity`). CAPTCHA is off locally; production turns on Cloudflare
Turnstile (dashboard → Auth → Bot and Abuse Protection, or `[auth.captcha]` as described in
`config.toml`).

## Prompt deck tags

Tags only exclude impossible combinations. `needs:<cap>` means the card can't be done without
`<cap>`, `no:<cap>` means it forbids it; a draw is valid when no card forbids what another
needs (`private.tags_compatible`, checked pairwise). Capabilities: `text`, `keyboard`,
`pointer`, `audio`, `color`, `animation`, `scroll`, `buttons`. A check constraint rejects
any other tag, and `03_deck.test.sql` checks that every BUILD card keeps at least 30
compatible RULE cards and every compatible BUILD + RULE pair at least 15 STYLE cards.

## pg_cron

`20261004120500_sweeps_and_cron.sql` creates `pg_cron` (in `pg_catalog`, as Supabase does)
when the extension is available and schedules `br-sweep-deadlines` (every 5 s),
`br-sweep-ttl` (every 10 min) and `br-cron-history-cleanup` (daily, keeps 2 days of
`cron.job_run_details`). Without `pg_cron` the block is skipped with a NOTICE. Hosted
Supabase ships pg_cron; this has only been verified on the local stack so far, so check the
schedule (`select * from cron.job`) after the first `supabase db push`.
