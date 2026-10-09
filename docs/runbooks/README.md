# Runbooks

What to do when something in production goes wrong. Each runbook has the same parts:
**Symptoms**, **Confirm**, **Mitigate**, **Verify**, **Follow-ups**.

| Runbook | When |
|---|---|
| [stuck-battle.md](stuck-battle.md) | A battle sits past its deadline and does not move on |
| [capture-backlog.md](capture-backlog.md) | Screenshots or deletes pile up; Browser Rendering is down |
| [package-cdn-outage.md](package-cdn-outage.md) | Previews cannot load npm packages |
| [realtime-quota.md](realtime-quota.md) | "Reconnecting…", channels closed by Realtime, the spend-cap decision |
| [supabase-outage.md](supabase-outage.md) | Supabase (database, Auth, Realtime, Storage) is down or degraded |
| [takedown-abuse.md](takedown-abuse.md) | A takedown or abuse request (a build, a name, a flood) |
| [removed-content-still-visible.md](removed-content-still-visible.md) | A removed build still shows somewhere (its screenshot file, a link preview) |

## Where the signals are

- **`/admin` → Health** (`admin_ops_health`, T-030): battles past their deadline (stuck vs.
  RESULTS waiting for screenshots), the jobs queue per kind (pending, oldest, expired leases,
  done and failed in the last hour), screenshot outcomes of the last 24 h, the pg_cron sweeps
  (last run, failures) and the 24 h TTL leftovers. Findings at the top name the runbook to
  open. It also has **Send a test error to Sentry** (throws in the page: checks the build's
  Sentry setup).
- **Sentry** (when `NEXT_PUBLIC_SENTRY_DSN` is set at the web build and `SENTRY_DSN` for the
  workers, `apps/web/DEPLOY.md` "Observability"): browser errors (`runtime: browser`, with
  `route`; the web app is a static site since T-037, so it has no server errors), the
  capture worker's error lines (`service: capture-worker`, grouped by log message:
  `claim.failed`, `capture.error`, …) and the package CDN's 500/502 (`service: pkg-cdn`).
  Tags `battle_id` / `room_id` / `phase` locate a battle.
- **PostHog** (when `NEXT_PUBLIC_POSTHOG_KEY` is set): the funnel (`room_created` →
  `room_joined` → `battle_started` → `build_shipped` → `vote_cast` → `battle_completed` →
  `rematch`), `report_filed`, and **`sync_health`**: one event per battle and client with
  `missed` (broadcasts Realtime never delivered), `refetches`, `gaps`, `degraded_ms`,
  `rejoins`, `server_closed`, `channel_errors`, and the preview counts `preview_crashes`,
  `preview_restarts`, `preview_stalls`, `preview_stall_ms`, `preview_spared` (T-031).
  **`preview_crash`**: one event per preview crash (`reason`, `phase`, `mode`, `silent_ms`
  in app-awake time, `wall_silent_ms`, `stalled_ms`, `longest_stall_ms`, `restarted`). Many
  crashes with a large `stalled_ms` point at overloaded player machines, not at loops.
- **Logs:** Supabase dashboard → Logs (Postgres: `sweep_deadlines: battle … not advanced`
  warnings; Realtime; Auth), the capture worker's and the package CDN's stdout (one JSON
  object per line). The web app is static files on Cloudflare Pages: it has no logs of its
  own (Workers & Pages → `build-roulette-web` → Deployments shows what is live).

## Running the SQL

Every SQL block runs as written in the Supabase dashboard's SQL editor (it runs as `postgres`,
which owns the functions and can read `private` and `cron`) or with
`psql "$DB_URL"`. Replace the `{{…}}` placeholders first:

| Placeholder | What | Where to find it |
|---|---|---|
| `{{battle_id}}` | a battle's id (a UUID) | the `/battles/<id>` URL, Health's links, Sentry's `battle_id` tag |
| `{{build_id}}` | a build's id | `/admin` report queue, a battle log's Builds table |
| `{{user_id}}` | a player's (anonymous) user id | `/u/<id>` URL; the battle log's roster |
| `{{room_code}}` | a room code (5 characters) | the `/r/<code>` URL |
| `{{admin_email}}` | a moderator's email | `private.admins` joined with `auth.users` |

Blocks marked `sql` only read. Blocks that change data say so in their first line comment
and are written to be safe to run more than once. A change made with SQL (a takedown, a
renamed player) shows on the public pages at their next load: they read the database in the
browser, with no cache (T-037).

Shell blocks read their targets from the environment: `APP_ORIGIN` (the app, e.g.
`https://buildroulette.example`), `PKG_CDN_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`BATTLE_ID`.

## Keeping them true

`node supabase/scripts/check-runbooks.mjs` (local stack running) extracts every SQL block of
these files, fills the placeholders with fixtures, and runs it against the local database:
`sql` blocks inside a read-only transaction (a write would fail the check), `sql write`
blocks in a transaction that is rolled back. It syntax-checks every shell block (`bash -n`).
With `--sh` it also runs the `sh check` blocks against local stand-ins (`APP_ORIGIN`, default
`http://localhost:3100`; `PKG_CDN_URL`, default `http://127.0.0.1:4400`; the local
Supabase; `BATTLE_ID`). `sh` blocks reach external status pages and `sh prod`
blocks need the production account: those are only syntax-checked. Run it after changing a
runbook or a migration the runbooks touch:

```text
node supabase/scripts/check-runbooks.mjs
APP_ORIGIN=http://localhost:3000 PKG_CDN_URL=http://127.0.0.1:4400 BATTLE_ID=<a settled battle> \
  node supabase/scripts/check-runbooks.mjs --sh      # with `pnpm --filter @br/web preview` and the package CDN running
```
