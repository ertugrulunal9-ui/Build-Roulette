# supabase/

Database schema, RPCs, storage policies and database tests for Build Roulette.
The design lives in [docs/04-state-machine.md](../docs/04-state-machine.md) and
[docs/05-database.md](../docs/05-database.md); this folder implements it.

## Layout

```
supabase/
├── config.toml                  Supabase CLI v2 config (local stack; anonymous sign-ins on)
├── migrations/
│   ├── 20261003120000_initial_schema.sql              enums, tables, indexes, RLS, grants, vote categories
│   ├── 20261004120000_private_schema_and_constants.sql  function default privileges, `private` schema,
│   │                                                    time limits, default durations, tag rule
│   ├── 20261004120100_prompt_deck.sql                 60 BUILD / 40 RULE / 30 STYLE cards, tag vocabulary
│   ├── 20261004120200_storage.sql                     buckets + storage.objects policies
│   ├── 20261004120300_solo_battle.sql                 state machine + client RPCs
│   ├── 20261004120400_jobs.sql                        capture/destroy job queue (service role)
│   ├── 20261004120500_sweeps_and_cron.sql             sweep_deadlines, sweep_ttl, pg_cron schedule
│   └── 20261006120000_autosave_css_and_public_battle.sql  autosave/bundle.css slot, get_public_battle (T-014)
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
│   └── 10_public_battle.test.sql   get_public_battle (permanent data only, RESULTS/DESTROYED only), autosave/bundle.css
└── scripts/
    └── e2e-solo.mjs             the solo loop through the real HTTP APIs (Auth, PostgREST, Storage, pg_cron)
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
  -x studio,imgproxy,vector,logflare,edge-runtime,supavisor,mailpit,realtime,postgres-meta

npx -y supabase@2.119.0 db reset      # re-apply all migrations to a fresh database
npx -y supabase@2.119.0 test db       # pgTAP: supabase/tests/*.test.sql
node supabase/scripts/e2e-solo.mjs    # API end-to-end check (needs psql on PATH)

npx -y supabase@2.119.0 stop --no-backup
```

`SUPABASE_INTERNAL_IMAGE_REGISTRY=docker.io` is only needed where `public.ecr.aws` is blocked
(the cloud dev container). Drop `realtime` from `-x` when working on Realtime (M3), and
drop `studio,postgres-meta` to get the dashboard. The containers are named after
`project_id`, so only one checkout can run the stack at a time.

`e2e-solo.mjs` commits data (anonymous users, battles, small files) and moves deadlines with
psql. Run it on a stack you can reset. It reads `API_URL`, `ANON_KEY`, `SERVICE_ROLE_KEY` and
`DB_URL` from the environment or from `supabase status -o env`; `VERBOSE=1` prints the
response behind each check.

CI (`.github/workflows/ci.yml`, job `db`) runs the same three steps on a fresh stack.

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
  `advance_battle`, `ship_build`, `get_battle_snapshot`, `get_public_battle`, and the RLS helpers
  `is_room_member`, `is_battle_member`, `can_view_battle`, `can_write_build_object`.
  Worker and sweep functions are `service_role` only.

## RPCs (M2)

Errors use a stable snake_case `message` (supabase-js `error.message`) and a human `details`.

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
