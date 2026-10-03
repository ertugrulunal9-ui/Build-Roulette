# supabase/

Database schema, row-level security and database tests for Build Roulette.
The design lives in [docs/05-database.md](../docs/05-database.md); this folder implements it.

## Layout

```
supabase/
├── config.toml                  Supabase CLI v2 config (local stack; anonymous sign-ins on)
├── migrations/
│   └── 20261003120000_initial_schema.sql   enums, tables, indexes, RLS, grants, vote categories
├── tests/                       pgTAP tests (*.test.sql), one transaction each, rolled back
│   ├── 00_schema.test.sql       tables/enums exist, RLS on every table, policies, privileges
│   ├── 01_constraints.test.sql  room codes, time limits, one build per player, vote PK, cascades
│   └── 02_rls.test.sql          who can see what, with fixture users; no client writes
└── scripts/
    ├── test.sh                  offline test harness (plain Postgres 16, no Docker)
    └── shim/                    Supabase emulation for test.sh only (never a migration)
        ├── 01_roles.sql
        └── 02_auth.sql
```

There is no `seed.sql` yet. `config.toml` already points at `./seed.sql` for local-only
data such as a dev prompt deck; `test.sh` applies it when it exists. Reference data
that production needs (the four vote categories) is inserted by the migration,
because `seed.sql` never runs on `supabase db push`.

## Running the tests

```bash
bash supabase/scripts/test.sh
```

What it does:

1. Installs `postgresql-16-pgtap` and `pg_prove` (`libtap-parser-sourcehandler-pgtap-perl`)
   with apt if they are missing. pgTAP is required. Without pg_prove it falls back to plain psql.
2. `initdb`s a throwaway cluster in `/tmp/build-roulette-pgtest.XXXXXX` and starts it on a
   unix socket only (no TCP port is opened). As root, the server runs as the `postgres`
   system user, because Postgres refuses to run as root.
3. Applies `scripts/shim/*.sql`, then `migrations/*.sql` in filename order (each file in
   one transaction), then `seed.sql` if present.
4. Runs `tests/*.test.sql` with `pg_prove`.
5. Always stops the server and deletes the temp dir (trap on EXIT/INT/TERM).

The exit code is 0 only if every test passes.

Options (environment variables): `VERBOSE=1` prints every TAP line, `NO_PG_PROVE=1`
forces the psql runner, `KEEP_TMP=1` keeps the temp dir for debugging, `PG_BIN`
picks the Postgres binaries (default `/usr/lib/postgresql/16/bin`), `PGTEST_TMPDIR`
sets the temp parent, and `PG_PORT` sets the socket port (default 54329).

### Writing tests

- Each file is `begin; create extension if not exists pgtap with schema extensions;
  select plan(n); ... select * from finish(); rollback;`.
- Insert fixtures as the superuser (RLS doesn't apply), then impersonate a user:
  ```sql
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"<uuid>","role":"authenticated"}';
  ```
  Use `reset role;` to go back to the superuser for more fixture changes.
- Prefer catalog-driven checks (see `00_schema.test.sql`) so new tables are covered
  automatically. Any new public table must have RLS enabled and no client write
  privileges, or the suite fails.

## The shim (`scripts/shim/`)

A vanilla Postgres cluster has none of the objects Supabase provides. The shim adds
the smallest set our schema and tests rely on:

| Emulated | Notes |
|---|---|
| Roles `anon`, `authenticated`, `service_role`, `authenticator` | NOLOGIN API roles. `service_role` has BYPASSRLS. `authenticator` is a member of all three. |
| Schemas `extensions`, `auth` | `pgcrypto` and `pgtap` are installed into `extensions`, as on Supabase |
| `auth.users` | Only `id`, `email`, `is_anonymous`, `raw_user_meta_data`, `created_at` |
| `auth.uid()`, `auth.role()`, `auth.jwt()` | Same bodies as Supabase. They read `request.jwt.claims` (and the legacy `request.jwt.claim.sub/role`). |
| Supabase default privileges | `postgres`-created objects in `public` are auto-granted to anon/authenticated/service_role, which is the default the migration must revoke |
| `search_path` | `"$user", public, extensions` |

Limits: this is not Supabase. There is no PostgREST, GoTrue, Realtime, Storage
(`storage.objects`), `pg_cron`, `pg_net`, `supabase_realtime` publication,
`supabase_admin` / `supabase_auth_admin` ownership, or event triggers. In the
harness `postgres` is a true superuser, while on Supabase it is a non-superuser owner.
Tests that need those features (storage policies, realtime authorization, cron)
need the real stack or more shim, added deliberately.

The shim lives under `scripts/` rather than `tests/` on purpose: `supabase test db` runs
`pg_prove --ext .pg --ext .sql -r` over `supabase/tests`, so any `.sql` file there,
in any subfolder, is executed as a test.

## Mapping to the real Supabase CLI

| Here | With the CLI and Docker |
|---|---|
| `bash supabase/scripts/test.sh` | `supabase start`, then `supabase db reset` (migrations + seed), then `supabase test db` |
| shim | Not needed: Supabase provides the roles, `auth`, `extensions` and default privileges |
| `tests/*.test.sql` | Run as-is by `supabase test db`. The CLI enables pgTAP itself, so the per-file `create extension if not exists` is a no-op. |
| migrations | Applied as-is by `supabase db reset` locally, and by `supabase db push` to hosted projects |

The CLI (v2.119.0 from npm) applied this migration with
`supabase migration up --db-url <url>?sslmode=disable` against a shim-prepared
cluster, and it accepts `config.toml`. `supabase test db` and `supabase start`
need Docker, which isn't available in the cloud dev container.

## Security model (summary)

- RLS is enabled on every `public` table. Policies are SELECT-only and granted `to authenticated`.
- `anon` and `authenticated` have no INSERT/UPDATE/DELETE/TRUNCATE privilege on any table.
  All writes go through `SECURITY DEFINER` RPCs (later migrations).
- `anon` (a request with no session) can read nothing. Anonymous sign-ins still get the
  `authenticated` role. Public results pages are expected to go through an RPC
  (`get_battle_snapshot`) or server-side code.
- Default privileges are changed so that tables created by later migrations are *not*
  auto-exposed to `anon`/`authenticated`. Grant `select` explicitly together with the policy.
- Visibility helpers (`security definer`, `stable`, `search_path = ''`):
  - `is_room_member(room)`: the caller has a `room_members` row with `kicked_at is null`
    (having left doesn't remove visibility).
  - `is_battle_member(battle)`: the caller is on the roster, or is a non-kicked member of
    the battle's room.
  - `can_view_battle(battle)`: `is_battle_member`, or the battle is in `results` or `destroyed`.
