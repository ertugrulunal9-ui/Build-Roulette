# Supabase Free: a quota or the 7-day pause

On the Free plan Supabase does not bill overages: it **pauses** an inactive project, makes a
database over its size limit **read-only**, and **restricts** a project over its other
quotas after a grace period (requests answer HTTP 402). docs/08-free-tier.md §6 has the
limits, what each costs us per battle and which one comes first; docs/07 §7.8 turns them into
battles per month and says what to upgrade first.

| Limit (Free) | Past it | Our signal |
|---|---|---|
| 7 days without user activity | the project is **paused**: every request answers **540**, the app shows "could not load" everywhere | the daily keep-alive workflow fails ("Supabase project is PAUSED"); `/admin` → Health is unreachable too |
| 500 MB database size | **read-only**: `cannot execute INSERT in a read-only transaction`; no battle can start | Health → Plan usage → Database (warns at 80 %); the keep-alive fails ("READ-ONLY") |
| 1 GB file storage | after a grace period, restrictions (402); uploads fail: no autosave, ship, screenshot | Health → Plan usage → File storage (warns at 80 %) |
| 5 GB egress a month (plus 5 GB cached) | after a grace period, restrictions (402) | Supabase dashboard → Organization → Usage only |
| 2 M Realtime messages a month, 200 connections, 20 Presence messages/s | Realtime refuses or closes channels | [realtime-quota.md](realtime-quota.md) |
| 50,000 MAU (anonymous sign-ins count) | after a grace period, restrictions | Health → Plan usage → Monthly active users (a lower bound) |
| 500,000 Edge Function invocations a month | after a grace period, restrictions | far away: pg_cron calls the `jobs` function at most once a minute (≤ 43,200) |

The grace period and the exact restrictions are Supabase's (not documented in detail; the
emails say what applies). **Results are permanent:** screenshots are never deleted to make
room, and nothing here suggests it.

## Symptoms

- GitHub emails a failed run of **Keep Supabase awake** (`.github/workflows/keep-alive.yml`):
  its error title says PAUSED, RESTRICTED, READ-ONLY, "Key refused", "not found" or "No
  answer".
- An email from Supabase: "project will be paused", "paused", "exceeding usage limits",
  "grace period".
- `/admin` → Health: a finding of area *usage* (Storage, Database, Monthly active users, or
  "No keep-alive ping for …").
- Players: every page "could not load" (paused, 540, or restricted, 402), or battles that will
  not start while pages still load (read-only).

## Confirm

The numbers of Health's Plan usage panel (in the SQL editor, which runs as `postgres`):

```sql
select jsonb_pretty(private.ops_usage());
```

Storage per bucket, and how fast the screenshots grow (they are permanent):

```sql
select bucket_id, count(*) as objects,
       pg_size_pretty(sum((metadata ->> 'size')::bigint)) as size
from storage.objects
group by bucket_id
order by sum((metadata ->> 'size')::bigint) desc nulls last;

select date_trunc('month', created_at) as month, count(*) as screenshots,
       pg_size_pretty(sum((metadata ->> 'size')::bigint)) as added,
       round(avg((metadata ->> 'size')::bigint) / 1024.0, 1) as mean_kib
from storage.objects
where bucket_id = 'screenshots'
group by 1
order by 1 desc
limit 12;
```

The database: Supabase's figure (every database of the cluster) and the largest tables:

```sql
select pg_size_pretty(sum(pg_database_size(datname))) as database_size from pg_database;

select n.nspname || '.' || r.relname as relation,
       pg_size_pretty(sum(pg_total_relation_size(c.oid))) as size
from pg_class c
join pg_class r on r.oid = coalesce(pg_partition_root(c.oid), c.oid)
join pg_namespace n on n.oid = r.relnamespace
where c.relkind in ('r', 'm') and n.nspname not in ('pg_catalog', 'information_schema')
group by 1
order by sum(pg_total_relation_size(c.oid)) desc
limit 15;
```

The event logs and their daily sweep (`br-event-logs-prune`), the keep-alive's last ping, and
battles per month (to compare with docs/07 §7.8):

```sql
select (select count(*) from public.battle_events) as battle_events,
       (select min(created_at) from public.battle_events) as oldest_event,
       (select count(*) from public.jobs where status in ('done', 'failed')) as finished_jobs,
       (select event_log_retention_days from private.ops_settings) as retention_days;

select d.start_time, d.status, d.return_message
from cron.job_run_details d
join cron.job j on j.jobid = d.jobid
where j.jobname = 'br-event-logs-prune'
order by d.start_time desc
limit 5;

select last_ping_at, now() - last_ping_at as since, pings from private.keep_alive;

select date_trunc('month', created_at) as month, count(*) as battles,
       count(*) filter (where room_id is null) as solo
from public.battles
group by 1
order by 1 desc
limit 6;
```

## Mitigate

**The project is paused.** Supabase dashboard → the project → **Restore project** (a few
minutes; the data is kept, Supabase allows a restore for a long time after the pause). Then
run the keep-alive once (GitHub → Actions → Keep Supabase awake → Run workflow) and find out
why it did not keep the project awake: the workflow disabled (a public repository after 60
days without commits), Actions minutes used up (a private repository; the nightly CI run is
the big consumer), a rotated anon key not updated in the repository secret. The `jobs`
function's cron starts again by itself.

```sh prod
gh workflow run keep-alive.yml && gh run list --workflow keep-alive.yml --limit 3
```

**File storage near 1 GB** (the screenshots: docs/08 §6.3 has the measurements):

1. Check the mean size per month above: about 60 KiB per screenshot is expected at WebP
   quality 70 (T-036); a much larger mean means grainy builds, not a bug.
2. Plan the upgrade: Supabase Pro has 100 GB (docs/07 §7.8, "What to upgrade first").
3. Cheaper code changes, if the upgrade must wait (each a task, not a setting): store new
   screenshots at 960×600 (Browser Rendering's `screenshotOptions.clip.scale` 0.75: about a
   third smaller again, softer on high-density screens), or move the `screenshots` bucket to
   Cloudflare R2 (10 GB free, no egress fees).
4. Never delete screenshots of finished battles to make room. Takedowns delete theirs as
   before.

**Database near 500 MB** (or read-only already):

1. See which tables grew (the query above). The event logs should be no older than the
   retention; if the sweep failed, its run history says why.
2. Keep less history: a shorter retention for the event logs and finished jobs, then run the
   sweep at once (the admin's battle logs of older battles become empty; results stay):
   ```sql write
   update private.ops_settings set event_log_retention_days = 14, job_retention_days = 3;
   select private.prune_event_logs();
   ```
3. Deleted rows free space for new rows but the files do not shrink, so the size Supabase
   reports drops only after a `VACUUM FULL` of the big table (it locks the table: do it at a
   quiet hour), e.g. `vacuum full public.battle_events;`.
4. Already read-only: Supabase's docs allow writes again for one session to clean up
   (`set session characteristics as transaction read write;` in the SQL editor), then delete
   as above. It turns read-write again by itself once the size is below the limit.
5. Then upgrade (Pro: 8 GB) before it comes back.

**Monthly active users near 50,000:** every new browser that plays signs in anonymously and
counts. Bots: turn on Turnstile (CAPTCHA in Supabase Auth plus `NEXT_PUBLIC_TURNSTILE_SITE_KEY`,
DEPLOY.md). Real players: upgrade (Pro: 100,000).

**Egress near 5 GB a month** (Usage page): about half of it is screenshot views and two
fifths the REVEAL downloads (docs/08 §6.5). The screenshot levers above help here too;
otherwise upgrade (Pro: 250 GB).

**Realtime:** [realtime-quota.md](realtime-quota.md).

**Restricted (HTTP 402):** usage went over a quota and the grace period ended. Reduce the usage
or upgrade; the restriction is lifted by Supabase (the email says how).

## Verify

- The keep-alive workflow passes ("Supabase is awake") and Health shows "last ping … ago".
- Health → Plan usage: every meter under 80 %, no *usage* finding.
- A solo battle runs to RESULTS with its screenshot.

## Follow-ups

- Check the measured numbers against the real ones after a month: screenshot mean size (the
  query above), database growth per battle, and egress per battle (Usage page ÷ battles).
  docs/08 §6 and docs/07 §7.8 assume 6-player battles.
- The limits in `private.ops_settings` are the Free plan's; after an upgrade set them to the
  new plan's (`update private.ops_settings set storage_limit_bytes = 100000000000,
  database_limit_bytes = 8000000000, mau_limit = 100000;`), or the warnings fire too early.
