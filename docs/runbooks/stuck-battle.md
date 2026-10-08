# Stuck battle

A battle whose phase deadline (`battles.phase_ends_at`) has passed and that does not move on.
Normally the clients nudge `advance_battle` at the deadline and `sweep_deadlines` (pg_cron,
every 5 s) is the backstop, so a battle more than a few seconds overdue is not moving by
itself.

Not stuck: a battle in **RESULTS** past its 60 s last look while a final build's screenshot
is still pending. It waits until the screenshot lands or the capture deadline (10 min after
SHIPPING) passes; Health counts it as "waiting for screenshots". If many do, see
[capture-backlog.md](capture-backlog.md).

## Symptoms

- Players see a countdown at 0:00 that never turns into the next phase (the client keeps
  nudging with backoff: 5, 10, 20, then every 30 s).
- `/admin` → Health: "N battle(s) past the deadline and not moving", or a sweep that "has not
  run for …".
- Postgres logs: `sweep_deadlines: battle <id> not advanced: <error>` warnings.
- PostHog: `battle_started` without a `battle_completed`; Sentry: errors tagged with the
  `battle_id`.

Different problem, same look: the battle **did** move but the players' screens did not (a
Realtime broadcast was lost). Each client's heartbeat catches that within ~10 s; PostHog's
`sync_health` shows it as `missed > 0`. If the SQL below shows the battle in the next phase,
see [realtime-quota.md](realtime-quota.md) instead.

## Confirm

The overdue battles (the same list as Health, with the phase and how long):

```sql
select b.id, b.phase, b.version, b.settings ->> 'mode' as mode, b.room_id,
       now() - b.phase_ends_at as overdue
from public.battles b
where b.phase not in ('destroyed', 'abandoned')
  and b.phase_ends_at < now() - interval '30 seconds'
order by b.phase_ends_at
limit 50;
```

Is pg_cron running the sweeps? (`br-sweep-deadlines` should have run in the last few seconds
with `succeeded`.)

```sql
select j.jobname, j.schedule, j.active, d.status, d.start_time, left(d.return_message, 200) as message
from cron.job j
left join lateral (
  select r.status, r.start_time, r.return_message
  from cron.job_run_details r
  where r.jobid = j.jobid
  order by r.runid desc
  limit 1) d on true
where j.jobname like 'br-%'
order by j.jobname;
```

The battle's last events and its builds:

```sql
select e.version, e.type, e.payload, e.created_at
from public.battle_events e
where e.battle_id = '{{battle_id}}'
order by e.version desc
limit 20;
```

```sql
select bu.id, bu.status, bu.capture_status, bu.shipped_at, bu.taken_down_at
from public.builds bu
where bu.battle_id = '{{battle_id}}';
```

## Mitigate

1. **The sweeps are not running** (no recent `br-sweep-deadlines` run, or `active` false):
   schedule them again. `cron.schedule` replaces a job of the same name, so this is safe to
   run twice.

   ```sql write
   -- Re-creates the two sweeps exactly as the migration does, and makes sure they are active.
   select cron.schedule('br-sweep-deadlines', '5 seconds', 'select public.sweep_deadlines()');
   select cron.schedule('br-sweep-ttl', '*/10 * * * *', 'select public.sweep_ttl()');
   select cron.alter_job(j.jobid, active := true)
   from cron.job j
   where j.jobname in ('br-sweep-deadlines', 'br-sweep-ttl');
   ```

2. **Run the sweep now** (what pg_cron runs every 5 s; returns how many battles it moved):

   ```sql write
   -- Advances every overdue battle it can (writes battle events, moves phases).
   select public.sweep_deadlines();
   ```

3. **One battle does not move with the sweep**: advance it by hand. Unlike the sweep, this
   shows the error instead of only logging a warning.

   ```sql write
   -- Advances one battle by its deadline rules (no version check, no actor), like the sweep.
   select private.advance('{{battle_id}}', null, null);
   ```

   The answer is `{"changed": true, ...}` when it moved. An error here is a bug: keep the
   message and the event list above for the follow-up.

4. **It still cannot move** (the error repeats) and players are waiting: end it the way the
   24 h TTL sweep would. A battle in RESULTS becomes DESTROYED (results kept); any other phase
   becomes ABANDONED (no results). Pending screenshots are given up, the room reopens, and
   the destroy job deletes the build files.

   ```sql write
   -- Ends battle {{battle_id}} now, exactly like sweep_ttl does after 24 h (safe to re-run).
   do $$
   declare
     v_id    uuid := '{{battle_id}}';
     v_phase public.battle_phase;
     v_to    public.battle_phase;
   begin
     select phase into v_phase from public.battles where id = v_id for update;
     if v_phase is null or v_phase in ('destroyed', 'abandoned') then
       raise notice 'battle % is %: nothing to do', v_id, coalesce(v_phase::text, 'missing');
       return;
     end if;
     v_to := case when v_phase = 'results' then 'destroyed' else 'abandoned' end;
     update public.battles
        set phase = v_to, phase_started_at = now(), phase_ends_at = null,
            is_complete = (v_phase = 'results')
      where id = v_id;
     -- The files are about to go: pending screenshots can never be taken.
     update public.builds
        set capture_status = 'failed'
      where battle_id = v_id and status in ('shipped', 'auto_shipped') and capture_status = 'pending';
     perform private.bump(v_id, 'phase', null,
       jsonb_build_object('from', v_phase, 'to', v_to, 'reason', 'ops'));
     perform private.on_battle_ended(v_id, null);
     insert into public.jobs (kind, ref_id) values ('destroy', v_id)
     on conflict (kind, ref_id) do update
       set status = 'queued', attempts = 0, run_after = now(), last_error = null, updated_at = now()
       where public.jobs.status = 'failed';
     raise notice 'battle % ended: % -> %', v_id, v_phase, v_to;
   end
   $$;
   ```

## Verify

- `/admin` → Health: "Past the deadline … stuck: 0"; the sweep's last run a few seconds ago.
- The first query above no longer lists the battle; its events end with a `phase` event.
- The players' screens follow within one heartbeat (~10 s): every `phase` event refetches.

## Follow-ups

- A battle that the sweep could not advance is a bug: open an issue with the battle id, the
  error from step 3 and the events (`/admin?q={{battle_id}}` shows the same timeline).
- Sweeps that stopped: check the Postgres logs around the last run, and that pg_cron is still
  enabled (Database → Extensions). `cron.job_run_details` keeps two days of runs.
