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
│   ├── 20261006130300_realtime.sql                    broadcast triggers, realtime.messages policies (T-016)
│   ├── 20261007120000_reveal_and_voting.sql           REVEAL + VOTING phases, vote RPCs, results by votes (T-019)
│   ├── 20261007120100_reveal_storage.sql              reveal reads of final builds, get_reveal_builds (T-019)
│   └── 20261007120200_reveal_vote_realtime.sql        reveal_index on phase events, vote_progress (T-019)
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
│   ├── 14_realtime.test.sql     broadcast payloads (one per version), realtime.messages RLS per role
│   ├── 15_reveal_vote.test.sql  REVEAL/VOTING lifecycle, every guard, tie-breaks, secret ballots, too few builds,
│   │                            the reveal_vote switches, solo unchanged, the reveal-slot reference table
│   └── 16_reveal_storage.test.sql  storage reads per phase and role, get_reveal_builds, abandoned in REVEAL
└── scripts/
    ├── e2e-solo.mjs             the solo loop through the real HTTP APIs (Auth, PostgREST, Storage, pg_cron)
    ├── e2e-multiplayer.mjs      a 3-player battle + late spectator through supabase-js, with Realtime reception
    ├── e2e-realtime.mjs         private topics, gap-free versions, presence, refused subscriptions
    ├── e2e-reveal-vote.mjs      REVEAL + VOTING: storage reads, host controls, ballots, tallies, events
    └── lib.mjs                  shared helpers of the supabase-js scripts above (supabase-js from apps/web)
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
node supabase/scripts/e2e-reveal-vote.mjs    # REVEAL and VOTING through the real APIs (same needs)

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
  `kick_member`, `heartbeat`, `get_room_snapshot`, `start_battle`), the reveal and vote RPCs
  (`reveal_next`, `skip_to_vote`, `cast_vote`, `get_my_votes`, `get_reveal_builds`), and the
  RLS helpers `is_room_member`, `is_battle_member`, `can_view_battle`, `can_write_build_object`,
  `can_read_revealed_object`, `can_use_realtime_topic`. Worker and sweep functions are
  `service_role` only.
- Kicks (T-016, replacing the T-002 note): a kicked member loses the room, its Realtime
  topics and the running battle they were on (`is_battle_member` is false for them); the
  battle becomes readable again, like for everyone, once it reaches RESULTS.
- Realtime: only room members receive `room:{id}`, only battle members receive
  `battle:{id}`; clients may send Presence only, never Broadcast (see below).

## RPCs (M2)

Errors use a stable snake_case `message` (supabase-js `error.message`) and a human `details`.
SQLSTATEs: 42501 auth/roster/membership, P0002 not found, 22023 bad input, P0001 guard
failures, 0A000 not implemented (`not_implemented`, raised by no current function since T-019).

| RPC | Caller | Returns |
|---|---|---|
| `server_now()` | authenticated | `timestamptz` (clock_timestamp) |
| `start_solo_battle(p_display_name text, p_time_limit_seconds int default null)` | authenticated | battle `uuid` |
| `advance_battle(p_battle_id uuid, p_expected_version int)` | battle member, service role | `{changed, version, phase, phase_ends_at}` |
| `ship_build(p_battle_id uuid, p_name text, p_stats jsonb default '{}')` | roster player | `{build: {id, status, name, shipped_at, completion_ms, stats}, battle: {version, phase, phase_ends_at}}` |
| `get_battle_snapshot(p_battle_id uuid)` | member, or anyone signed in once RESULTS/DESTROYED | `{server_now, me, battle, challenge, players, builds, awards}` (+ reveal/vote fields for multiplayer, see M4) |
| `get_public_battle(p_battle_id uuid)` | anyone, including `anon`; RESULTS/DESTROYED only, otherwise `battle_not_found` | `{battle, challenge, players, builds, awards}`: permanent data only (display names, no user ids, no ephemeral paths; screenshot path only once captured; `builds[].votes` = per-category counts, never ballots) |
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
  (`settings.max_players`, 2–8) and 20 spectators. Settings: `max_players`, and for M4
  `reveal_slot_s` (30–60), `voting_s` (30–180) and `reveal_vote` (boolean, default true; see
  below). The build time limit is never a setting: the server draws 5, 10 or 15 minutes per
  battle.
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
  the room `in_battle`. Battles with `settings.reveal_vote = false` (every battle started
  before T-019, and rooms that opt out) run SPINNING → BUILDING → SHIPPING → RESULTS →
  DESTROYED; the others add REVEAL and VOTING after SHIPPING (next section). BUILDING
  ends early when every roster player still active in the room (not left, not kicked) has
  shipped. Drafts of everyone else, including players who left, are auto-shipped or DNF at
  the end of SHIPPING. A kick disqualifies the player's draft. At DESTROYED or ABANDONED the
  room reopens (`current_battle_id` keeps pointing at the finished battle until the next
  start).
- **Ranks (M3, `reveal_vote = false` only):** shipped and auto-shipped builds by `completion_ms`, then hand-shipped
  before auto-shipped, then earlier `shipped_at`; builds equal on all three share the rank
  (1, 1, 3). Awards: `clutch_ship`, `speedrun`, and `fastest_ship` when at least two builds
  were shipped by hand (shared on a tie).
- **Sweeps:** `sweep_deadlines` (5 s) also abandons room battles with no roster player seen
  for 5 minutes (not in RESULTS) and migrates hosts; `sweep_ttl` (10 min) also closes open
  rooms idle for 2 hours (no room event, no heartbeat) and deletes rooms closed for 7 days
  (battles keep their results with `room_id = null`).
- **Lock order:** battle row, then room row, then member rows (`private.lock_room`).
- The limits live in `private.room_limits()`.

## Reveal and voting (M4, T-019)

| RPC | Caller | Returns | Errors (besides `not_authenticated`) |
|---|---|---|---|
| `reveal_next(p_battle_id uuid, p_expected_version int)` | host, REVEAL | `{changed, version, phase, phase_ends_at, reveal_index}` | `invalid_version`, `battle_not_found`, `not_a_member`, `not_host`, `wrong_phase` |
| `skip_to_vote(p_battle_id uuid, p_expected_version int)` | host, REVEAL | same | same |
| `cast_vote(p_battle_id uuid, p_category text, p_build_id uuid)` | roster voter, VOTING | `{category, build_id, ballot_complete, battle: {version, phase, phase_ends_at}}` | `battle_not_found`, `not_on_roster`, `kicked`, `not_a_member`, `not_a_voter`, `wrong_phase`, `deadline_passed`, `invalid_category`, `build_not_found`, `self_vote`, `not_votable` |
| `get_my_votes(p_battle_id uuid)` | anyone who can see the battle | `{votes: {category: build_id}, complete}` (own ballot only) | `battle_not_found` |
| `get_reveal_builds(p_battle_id uuid)` | battle member (roster or spectator, not kicked) in REVEAL, VOTING or RESULTS | `[{build_id, position, name, builder_id, builder_name, status, files: {js, css, manifest, thumb}}]` | `battle_not_found`, `wrong_phase` |

A stale `p_expected_version` makes `reveal_next` / `skip_to_vote` a no-op (`changed: false`),
like `advance_battle`, so a double click is harmless. SQLSTATEs: `not_a_voter` 42501,
`build_not_found` P0002, `invalid_category` 22023, `self_vote` / `not_votable` P0001.

- **Flow:** new multiplayer battles snapshot `reveal_vote: true`. At the end of SHIPPING
  (deadline, or every active roster player final) drafts are auto-shipped or DNF and capture
  jobs are queued, as before. The **final** builds are the shipped and auto-shipped ones.
  With **2 or more** final builds the battle enters REVEAL; with 0 or 1 it goes straight to
  RESULTS (`reason: too_few_builds`; the lone build is rank 1, no vote awards).
- **REVEAL:** `reveal_order` is a random shuffle of the final build ids, `reveal_index`
  starts at 0. Each build gets one slot of `reveal_slot_s` (room setting) or
  `round(clamp(300 / n, 30, 60))` seconds (`private.reveal_slot_seconds`, whole seconds, half
  up; `revealSlotSeconds` in `@br/game` rounds the same way and a drift test checks both
  against the table in `15_reveal_vote.test.sql`). A slot ends on its deadline
  (`advance_battle` nudges, `sweep_deadlines`) or by the host's `reveal_next`, and the next
  slot gets the full length; the end of the last slot, or `skip_to_vote` at any time, starts
  VOTING. Every step is a `phase` event (`from: reveal`) whose broadcast carries
  `reveal_index`; `reason` is `host_next` / `host_skip` for host actions.
- **VOTING** lasts `voting_s` (default 60). Eligible voters are roster players with
  `is_voter` (DNF included) who were not kicked; a player who left votes again after
  rejoining before the deadline; spectators never vote. One vote per active category
  (`overall`, `rule`, `style`, `chaos`), upserted, so revotes replace the earlier choice. No
  self-votes; only builds in `reveal_order`. **Early end:** after a vote, a leave or a kick,
  VOTING ends at once when at least one eligible voter is *present* (active and seen within
  30 s) and every present eligible voter has voted in every category (`reason: all_voted`).
  Voters who left or went silent do not hold the battle up, and their partial ballots count.
- **Secrecy:** `votes` is readable by its voter only (RLS); `get_my_votes` returns only the
  caller's ballot; `battle_players.voted_at` is never set; the `vote_progress` event and the
  snapshot carry counts only, and only change when a voter completes a ballot (partial
  ballots and revotes are invisible). Tallies appear at RESULTS.
- **RESULTS** (`private.finalize_votes`, votes of voters still eligible in active
  categories): `builds.vote_counts` `{category: n}` for each final build (frozen; null for
  others and before RESULTS) and `total_votes`; ranks by Best Build votes, then total votes,
  then earlier `shipped_at` (`rank()`: full ties share); one `awards` row per category for
  the top build(s) (`source: vote`, `votes` = count; ties share, no award for a category
  nobody voted in); auto-awards as in M3.
- **Snapshot (multiplayer):** `battle.reveal_vote`, `battle.reveal_order`,
  `battle.reveal_index`, `battle.reveal_slot_s` (null without a reveal); during REVEAL
  `phase_started_at` / `phase_ends_at` are the current slot. `me.is_voter`, `me.can_vote`,
  `vote_categories` (`[{slug, label, description}]`), `vote_progress`
  (`{voted_count, eligible_count}` during VOTING, else null), `builds[].votes` (null until
  RESULTS).
- **Storage (reveal reads):** from REVEAL until DESTROYED (phases `reveal`, `voting`,
  `results`) every battle member, spectators included, may read the final artifacts of the
  builds in `reveal_order`: `bundle.js`, `bundle.css`, `manifest.json`, `thumb.webp` of a
  shipped build; `autosave/bundle.js`, `autosave/bundle.css`, `autosave/manifest.json` of an
  auto-shipped one (`public.can_read_revealed_object`). Never `source.json`, never drafts,
  the autosave of a hand-shipped build, a DNF player's files, disqualified builds, or
  anything before REVEAL, after DESTROY or in an ABANDONED battle; never strangers, kicked
  users or `anon`. The import map comes from `manifest.json` (`{dependencies}`, untrusted:
  validate like the capture page), which clients upload next to the bundle at ship and with
  each autosave (both names are now writable); a build without one is revealed with an
  empty import map. `get_reveal_builds` returns the object names, null for files that were
  never uploaded.
- **Host and presence:** deadlines drive REVEAL and VOTING, so a vanished host blocks
  nothing; after 30 s the host role moves as in M3 (lazily, including in `reveal_next` /
  `skip_to_vote`, and in the sweep) and the new host gets the controls. A battle in REVEAL
  or VOTING with no roster player seen for 5 minutes is ABANDONED (no tallies, no ranks).
- **Opting out:** the room setting `reveal_vote: false` keeps the M3 flow. Without a room
  setting the default is `private.reveal_vote_default()`: true, unless the deployment has
  the row `('reveal_vote_default', false)` in `private.app_settings` (service-side only). The
  CI web e2e jobs insert that row until the web app has the REVEAL and VOTE stages (T-020);
  production must not.
- The limits live in `private.reveal_vote_limits()` (drift-tested against `@br/game`).

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
| battle | `phase` | `phase, phase_started_at, phase_ends_at, reason?, reveal_index` (the last one only when `phase` is `reveal`) |
| battle | `build` | `build_id, user_id, status: 'shipped', name, completion_ms` |
| battle | `player` | `user_id, status ('left', 'active' or 'kicked'), build_status?` |
| battle | `host` | `host_id` |
| battle | `capture` | `build_id, capture_status` |
| battle | `vote_progress` | `voted_count, eligible_count` (M4: when a voter completes their ballot; counts only) |
| battle | `destroyed` | nothing (the destroy-worker finished) |
| room | `room` | `change, status, host_id, settings, current_battle_id, reason?` |
| room | `member` | `change, user_id, display_name, role, is_ready, state` |
| both | `sync` | nothing (an event type the client does not know: refetch) |

Clients keep the snapshot `version`, ignore `version <= current`, refetch on a gap, and
refetch the battle snapshot after `phase` events (builds, ranks and awards change in bulk
at RESULTS). Payloads never carry votes (who or what), tallies, storage paths, stats, room
codes or presence data.

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
