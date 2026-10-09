# Capture backlog / Browser Rendering outage

The jobs in `public.jobs` are **capture** (render a shipped build, store its screenshot),
**destroy** (delete a finished battle's build files) and **takedown** (delete a removed build's
screenshot). On the free plan (T-034) the Supabase Edge Function **`jobs`** processes them:
pg_cron (`br-jobs-run`, every minute) calls it through pg_net when a job is due, and it
renders through **Cloudflare Browser Rendering's REST API** within a daily budget (9.5 of the
free 10 browser-minutes, counted in `private.browser_budget` per UTC day). The self-hosted
capture worker (`apps/capture-worker`) processes the same jobs where it runs instead
(docs/08-free-tier.md §5.6).

A job is retried with backoff (10, 20, 40, 80 s) and fails for good after 5 attempts. A capture
that cannot render falls back to the player's client thumbnail. For the function that happens
at once when the build itself is at fault or the day's budget is spent; when Browser Rendering
answers 429 or is unavailable, the job is retried first and falls back from its 3rd attempt
(about 2–3 minutes).

What waits on the queue: RESULTS ends only when every final build's screenshot is terminal
or the capture deadline passes (10 min after SHIPPING); DESTROYED battles keep their build
files until their destroy job ran (the 24 h TTL sweep is the safety net).

## Symptoms

- RESULTS screens show "screenshot pending" for minutes; rooms wait longer to get back to the
  lobby.
- `/admin` → Health: "capture: N pending, the oldest for …", "job(s) failed for good",
  "running job(s) whose worker stopped reporting", or "finished battle(s) whose files are not
  deleted yet"; "Screenshots, last 24 h" shifting from rendered to client thumbnail / failed;
  the pg_cron job `br-jobs-run` failing.
- **The function's logs** (Supabase dashboard → Edge Functions → `jobs` → Logs, one JSON line
  per event):
  - `run.unauthorized`: the Vault secret and the function's `JOBS_CRON_SECRET` differ;
  - `run.bad_config`: a missing or bad secret, named in `problems`;
  - `renderer.request_refused`: Browser Rendering refused the request (HTTP 400/401/403),
    usually the API token;
  - `capture.service_failed`: a 429 or an outage, retried;
  - `budget.spent` / `capture.budget_spent`: the day's browser time is used up;
  - `claim.failed` / `capture.error` / `run.hard_stop`.
- **Browser Rendering outage:** `capture.service_failed` lines, then `capture.fallback`;
  screenshots taken meanwhile are client thumbnails (`fallback`).
- **Budget spent:** from some time of the (UTC) day on, every screenshot is a thumbnail, with
  no errors.
- Self-hosted worker: Sentry (`service: capture-worker`): `claim.failed`, `capture.error` /
  `destroy.error`, `job.crashed`; `capture.render_unusable` (warn) in its stdout.

## Confirm

The queue, per kind and status (pending ones, and what finished in the last hour):

```sql
select j.kind, j.status, count(*) as jobs, min(j.created_at) as oldest, max(j.attempts) as max_attempts
from public.jobs j
where j.status in ('queued', 'running')
   or j.updated_at > now() - interval '1 hour'
group by j.kind, j.status
order by j.kind, j.status;
```

Recent failures (the error text says why):

```sql
select j.id, j.kind, j.ref_id, j.attempts, left(j.last_error, 200) as error, j.updated_at
from public.jobs j
where j.status = 'failed'
  and j.updated_at > now() - interval '1 hour'
order by j.updated_at desc
limit 20;
```

Running jobs whose 2-minute lease expired (the function run or the worker died; `claim_job`
hands them out again, and `sweep_deadlines` fails them after the last attempt):

```sql
select j.id, j.kind, j.ref_id, j.attempts, j.run_after as lease_ended
from public.jobs j
where j.status = 'running'
  and j.run_after < now()
order by j.run_after;
```

How screenshots turned out in the last 24 h (a jump in `fallback` is Browser Rendering
failing or the budget spent; in `failed`, no render and no thumbnail):

```sql
select bu.capture_status, count(*) as builds
from public.jobs j
join public.builds bu on bu.id = j.ref_id
where j.kind = 'capture'
  and j.updated_at > now() - interval '24 hours'
group by bu.capture_status
order by builds desc;
```

**Is pg_cron calling the function, and what does it answer?** `br-jobs-run` runs every
minute; it sends a request only when a job is due. A `202` is a started run, `401` a secret
mismatch, `500` a configuration problem (the body names it), no rows while jobs are due: the
Vault secrets are missing.

```sql
select d.status, left(d.return_message, 100) as message, d.start_time
from cron.job j
join cron.job_run_details d on d.jobid = j.jobid
where j.jobname = 'br-jobs-run'
order by d.start_time desc
limit 5;
```

```sql
select r.id, r.status_code, left(r.content, 200) as content, r.error_msg, r.created
from net._http_response r
order by r.created desc
limit 10;
```

```sql
-- The names only: never select decrypted_secret here.
select s.name, s.created_at, s.updated_at
from vault.secrets s
where s.name in ('br_jobs_function_url', 'br_jobs_cron_secret');
```

**The browser budget** (UTC days; `ms_per_render` is what a capture costs; Workers Free allows
600,000 ms a day, the function stops at 570,000):

```sql
select b.day, b.used_ms, b.reserved_ms, b.renders, b.refused, b.rate_limited,
       round(b.used_ms::numeric / nullif(b.renders, 0)) as ms_per_render
from private.browser_budget b
order by b.day desc
limit 7;
```

Run the function by hand and see what one run does (the cron secret is the function's
`JOBS_CRON_SECRET`):

```sh prod
curl -sS -X POST "$SUPABASE_URL/functions/v1/jobs?wait=1" -H "x-br-cron-secret: $JOBS_CRON_SECRET"
```

## Mitigate

1. **The function is not called, or refuses the call** (no `202` above): set the Vault secrets
   or fix the mismatch (apps/web/DEPLOY.md "Screenshots and jobs", steps 4 and 6), or fix the
   secret `run.bad_config` names and deploy again
   (`npx -y supabase@2.119.0 functions deploy jobs --no-verify-jwt`). A `404` means the
   function is not deployed.

2. **Browser Rendering is down, or rate-limits us:** nothing to do for the game. Each capture
   is retried twice and then falls back to the client thumbnail, and RESULTS ends at the
   capture deadline at the latest. A refused token (`renderer.request_refused`, 401/403) needs
   a new API token (`supabase secrets set BROWSER_RENDERING_API_TOKEN=…`). Many 429s without
   an outage: check that `BROWSER_RENDERING_MIN_INTERVAL_MS` is not below 10000 on the free
   plan. Watch [Cloudflare status](https://www.cloudflarestatus.com/); the screenshots taken
   meanwhile stay thumbnails (they are permanent).

3. **The budget is spent every day** (`refused` > 0 most days): the rest of each day gets
   thumbnails, which is the designed degradation. To get more renders: make builds signal
   readiness (the starter templates call `window.buildRoulette.ready()`; a build without it
   costs the full 6 s cap, `ms_per_render` shows it), move to Workers Paid (10 h a month
   included) and raise `BROWSER_BUDGET_MS_PER_DAY`, or run the self-hosted worker (next item).

4. **Switch to the self-hosted worker** (a machine with Playwright, `apps/capture-worker`):
   stop the function's trigger, then start the worker with its environment (`.env.example`).

   ```sql write
   -- Stops pg_cron from calling the jobs function (the self-hosted worker takes over).
   select cron.unschedule(j.jobid) from cron.job j where j.jobname = 'br-jobs-run';
   ```

   ```sh
   pnpm --filter @br/capture-worker build
   pnpm --filter @br/capture-worker start
   ```

   To drain the queues once and exit (e.g. from a one-off job):

   ```sh
   pnpm --filter @br/capture-worker start -- --once
   ```

   Back to the function:

   ```sql write
   -- Calls the jobs function every minute again (as the T-034 migration does).
   select cron.schedule('br-jobs-run', '* * * * *', 'select private.run_jobs_function()');
   ```

   The self-hosted worker can also be scaled: raise `CAPTURE_CONCURRENCY` (1–8) and restart
   (with Browser Rendering's binding on Workers Paid, 10 concurrent browsers; docs/07 §7.5).

5. **Deletes failed for good** (e.g. during a Storage outage): queue them again with fresh
   attempts (the TTL sweep does the same after 24 h):

   ```sql write
   -- Queues failed destroy and takedown jobs again (fresh attempts); safe to re-run.
   update public.jobs
      set status = 'queued', attempts = 0, run_after = now(), last_error = null, updated_at = now()
    where kind in ('destroy', 'takedown')
      and status = 'failed';
   ```

6. **Last resort, a huge capture backlog of old battles:** give up on captures queued for
   more than 15 minutes. Their builds get no screenshot at all (not even the thumbnail), and
   their battles can leave RESULTS at once.

   ```sql write
   -- Gives up on capture jobs queued for more than 15 minutes (capture_status becomes failed).
   select j.id, private.give_up_job(j.id, 'ops: capture backlog')
   from public.jobs j
   where j.kind = 'capture'
     and j.status = 'queued'
     and j.created_at < now() - interval '15 minutes';
   ```

## Verify

- Health: no capture/destroy finding; "Oldest pending" back to seconds; "Done 1 h" growing.
- The first query shows the `queued` counts falling and recent `done` rows.
- `net._http_response` shows `202`s; the function's logs show `run.end` lines with jobs.
- Battles leave RESULTS: [stuck-battle.md](stuck-battle.md)'s first query is empty.

## Follow-ups

- Recurring `capture.error`, `run.crashed` or `run.hard_stop`: a bug in the job code
  (`apps/capture-worker/src`, shared by the function and the worker); the message names the
  step (download, render, upload, `complete_capture`).
- More fallbacks than renders over days: compare `ms_per_render` with docs/08-free-tier.md
  §5.4's budget math; the assumed 3 s per capture may be off on Cloudflare.
- Leftover files after a destroy outage: Health's "24 h TTL" panel; `sweep_ttl` re-queues
  destroy jobs of battles older than 24 h.
