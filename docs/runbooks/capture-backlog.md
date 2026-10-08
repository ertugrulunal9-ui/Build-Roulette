# Capture backlog / Browser Rendering outage

The capture worker (`apps/capture-worker`) takes jobs from `public.jobs`: **capture** (render
a shipped build, store its screenshot), **destroy** (delete a finished battle's build files)
and **takedown** (delete a removed build's screenshot). A job is retried with backoff
(10, 20, 40, 80 s) and fails for good after 5 attempts. A capture that cannot render falls
back to the player's client thumbnail.

What waits on the queue: RESULTS ends only when every final build's screenshot is terminal
or the capture deadline passes (10 min after SHIPPING); DESTROYED battles keep their build
files until their destroy job ran (the 24 h TTL sweep is the safety net).

## Symptoms

- RESULTS screens show "screenshot pending" for minutes; rooms wait longer to get back to the
  lobby.
- `/admin` → Health: "capture: N pending, the oldest for …", "job(s) failed for good",
  "running job(s) whose worker stopped reporting", or "finished battle(s) whose files are not
  deleted yet"; "Screenshots, last 24 h" shifting from rendered to client thumbnail / failed.
- Sentry (`service: capture-worker`): `claim.failed` (the worker cannot reach Supabase),
  `capture.error` / `destroy.error` (unexpected failures), `job.crashed`.
- **Browser Rendering outage:** renders time out or error; the worker logs
  `capture.render_unusable` (warn) and stores client thumbnails (`fallback`).

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

Running jobs whose 2-minute lease expired (the worker died or hangs; `claim_job` hands them
out again, and `sweep_deadlines` fails them after the last attempt):

```sql
select j.id, j.kind, j.ref_id, j.attempts, j.run_after as lease_ended
from public.jobs j
where j.status = 'running'
  and j.run_after < now()
order by j.run_after;
```

How screenshots turned out in the last 24 h (a jump in `fallback` is Browser Rendering
failing; in `failed`, no render and no thumbnail):

```sql
select bu.capture_status, count(*) as builds
from public.jobs j
join public.builds bu on bu.id = j.ref_id
where j.kind = 'capture'
  and j.updated_at > now() - interval '24 hours'
group by bu.capture_status
order by builds desc;
```

Is the worker alive? Its stdout has a JSON line per job (`job.start`, `job.end`); with no
`job.*` lines while the queue grows, it is not claiming.

## Mitigate

1. **The worker is down or stuck:** restart it. With its environment set (`.env.example`):

   ```sh
   pnpm --filter @br/capture-worker build
   pnpm --filter @br/capture-worker start
   ```

   To drain the queues once and exit (e.g. from a one-off job):

   ```sh
   pnpm --filter @br/capture-worker start -- --once
   ```

2. **The worker runs but cannot keep up** (no errors, the oldest pending job keeps getting
   older): raise `CAPTURE_CONCURRENCY` (1–8) and restart; in production, also Browser
   Rendering's concurrency (10 browsers on Workers Paid; docs/07 §7.5).

3. **Browser Rendering is down:** nothing to do for the game itself. Each capture falls back to
   the client thumbnail after its render fails, and RESULTS ends at the capture deadline at
   the latest. Watch [Cloudflare status](https://www.cloudflarestatus.com/); the screenshots
   taken meanwhile stay thumbnails (they are permanent).

4. **Deletes failed for good** (e.g. during a Storage outage): queue them again with fresh
   attempts (the TTL sweep does the same after 24 h):

   ```sql write
   -- Queues failed destroy and takedown jobs again (fresh attempts); safe to re-run.
   update public.jobs
      set status = 'queued', attempts = 0, run_after = now(), last_error = null, updated_at = now()
    where kind in ('destroy', 'takedown')
      and status = 'failed';
   ```

5. **Last resort, a huge capture backlog of old battles:** give up on captures queued for
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
- Battles leave RESULTS: [stuck-battle.md](stuck-battle.md)'s first query is empty.

## Follow-ups

- Recurring `capture.error` or `job.crashed` in Sentry: a worker bug; the message names the
  step (download, render, upload, `complete_capture`).
- More fallbacks than renders over days: check Browser Rendering quotas (10 h/month included,
  ~1,000 battles) and the per-capture time in the worker's `capture.rendered` lines.
- Leftover files after a destroy outage: Health's "24 h TTL" panel; `sweep_ttl` re-queues
  destroy jobs of battles older than 24 h.
