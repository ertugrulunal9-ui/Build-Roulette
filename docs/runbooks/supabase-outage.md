# Supabase outage

Supabase is the game's server: Postgres (all state and every rule), Auth (anonymous
sessions), Realtime, Storage (build files, screenshots) and pg_cron (deadlines). When it is
down, nothing can change state. What keeps working (docs/02 R10): editing and the live
preview are local to each browser, and the app's pages themselves (static files on Cloudflare
Pages, T-037), which load but cannot show any data.

## Symptoms

- Players: "Reconnecting…", ships and votes failing (the client retries), new visitors cannot
  sign in; `/battles/[id]` and `/u/[id]` say "Could not load this page" with a Try again
  button.
- Sentry: the capture worker's `claim.failed`, many browser errors at once (`runtime:
  browser`).
- `/admin` → Health: "Could not load the health signals" (it is an RPC itself).

## Confirm

Supabase's status page (incidents per region and service):

```sh
curl -sS https://status.supabase.com/api/v2/status.json
```

Our project's API and Auth answer (`200` when up):

```sh check
curl -sS -o /dev/null -w 'rest %{http_code} %{time_total}s\n' "$SUPABASE_URL/rest/v1/" -H "apikey: $SUPABASE_ANON_KEY"
curl -sS -o /dev/null -w 'auth %{http_code} %{time_total}s\n' "$SUPABASE_URL/auth/v1/health" -H "apikey: $SUPABASE_ANON_KEY"
```

Once the database answers again: is the deadline sweep running, and since when?

```sql
select d.status, count(*) as runs, min(d.start_time) as first, max(d.start_time) as last
from cron.job_run_details d
join cron.job j on j.jobid = d.jobid
where j.jobname = 'br-sweep-deadlines'
  and d.start_time > now() - interval '1 hour'
group by d.status;
```

## Mitigate

During the outage there is nothing to fix on our side: communicate (status message), and do
not deploy. The game resumes by itself: clients keep their workspaces locally, ships retry
with backoff, and deadlines are enforced from the data once the database is back.

After it recovers:

1. **Catch up on deadlines at once** instead of waiting for the next tick (battles whose
   deadline passed during the outage move on; drafts are auto-shipped from their last
   autosave):

   ```sql write
   -- Advances every overdue battle now; returns how many moved.
   select public.sweep_deadlines();
   ```

2. **Re-queue deletes that failed for good** during the outage (Storage errors):

   ```sql write
   -- Queues destroy and takedown jobs that failed in the last 6 hours again (fresh attempts).
   update public.jobs
      set status = 'queued', attempts = 0, run_after = now(), last_error = null, updated_at = now()
    where kind in ('destroy', 'takedown')
      and status = 'failed'
      and updated_at > now() - interval '6 hours';
   ```

3. **Check the queues and stuck battles**: Health, then [capture-backlog.md](capture-backlog.md)
   and [stuck-battle.md](stuck-battle.md) if it flags anything. Captures that failed during
   the outage keep their client thumbnail (or none); they are not retried.

## Verify

- Health is "All clear" (or only shows findings you are handling).
- The cron query shows `succeeded` runs every 5 s since the recovery.
- Sentry's error rate is back to its usual level; new battles complete (PostHog
  `battle_completed`).

## Follow-ups

- Battles that ended ABANDONED because nobody was seen for 5 minutes during the outage cannot
  be revived; their players start a rematch.
- Note the outage window for the cost and SLA review; if it repeats, consider the Supabase
  plan's support level.
