# Realtime quota hit

Supabase Realtime carries the room's Presence (who is online, the BUILD sidebar's activity)
and the database's broadcasts ("something changed, refetch"). The game state itself is in
Postgres: a client that loses Realtime keeps playing (it polls every few seconds and its
heartbeat compares the battle version every ~10 s), so a Realtime problem degrades the
experience but does not stop battles.

**On the Free plan** (the deploy since 2026-10-09, docs/08 §6.5) Realtime's quotas are hard
limits (confirmed: Supabase's Realtime limits page):

| Free quota | Our use | Holds |
|---|---|---|
| **20 Presence messages per second** | 1.7–2.1/s per 6-player room in BUILD (2.9–3.6/s with 8 players) | **~10 concurrent 6-player rooms in BUILD** (5–6 of 8): the first limit at a peak. 10 × 6 measured clean on the Free quotas |
| 200 concurrent connections | one per player | 33 six-player battles at once |
| 100 messages per second, 100 joins per second | | not reached at 10 rooms |
| **2 M messages a month** (secondary) | 1,490 per battle | **~1,340 battles a month** |

Above a per-second quota Realtime closes channels ("Too many presence messages per second");
over the monthly quota Supabase restricts the project after a grace period (assumed; the email
says what applies). On **Pro** the Presence quota is 50/s with the spend cap ON (about 15
busy 8-player rooms, docs/07 §7.5.1) and 1,000/s with it off, and messages are 5 M a month
plus $2.50 per million.

## Symptoms

- "Reconnecting…" in rooms; presence dots and the BUILD sidebar flicker or go stale; events
  arrive late (after the next heartbeat).
- PostHog `sync_health` events with `server_closed > 0`, `rejoins > 0`, a high `degraded_ms`
  or `missed > 0`. A useful insight: *Trends → `sync_health` → sum of `server_closed`*, and
  the same for `missed`, by hour.
- Supabase dashboard → Realtime → usage/limits, and Logs → Realtime: rate-limit or
  quota messages.

## Confirm

How many rooms and players are in a running battle right now (compare with ~10 busy
6-player rooms on Free, ~15 busy 8-player rooms on Pro with the spend cap):

```sql
select b.phase,
       count(*) as battles,
       sum((select count(*) from public.battle_players p where p.battle_id = b.id)) as players
from public.battles b
where b.phase not in ('destroyed', 'abandoned')
  and b.room_id is not null
group by b.phase
order by battles desc;
```

Room members seen in the last 30 s (each one holds a room channel with Presence):

```sql
select count(*) as present_members, count(distinct m.room_id) as rooms
from public.room_members m
where m.kicked_at is null
  and m.left_at is null
  and m.last_seen_at > now() - interval '30 seconds';
```

Broadcast volume: the database's events per minute over the last hour (each event is one
broadcast to every member of the topic):

```sql
select date_trunc('minute', e.created_at) as minute, count(*) as battle_events
from public.battle_events e
where e.created_at > now() - interval '1 hour'
group by 1
order by 1 desc
limit 60;
```

## Mitigate

1. **On Free: upgrade to Pro** when busy rooms crowd the Presence quota regularly (more than
   ~8 rooms in BUILD at once) or the month's messages pass ~1.6 M (80 %; Supabase dashboard →
   Organization → Usage → Realtime messages). There is no spend cap to turn off on Free and
   nothing to buy per message: the upgrade is the lever (docs/07 §7.8, "What to upgrade
   first"). It is the user's decision (cost); take it before an event or a marketing push,
   not during one if avoidable. A short peak does not need it: the clients back off and keep
   playing (point 4).
2. **On Pro: the spend-cap decision** (docs/07 §7.6, recommendation 1): with the cap ON,
   Realtime's quotas are hard limits. Before about 15 concurrent 8-player rooms in BUILD, turn
   the spend cap **off** (Supabase dashboard → Organization → Billing → Spend cap) or move to
   the Team plan; set a billing alert either way.
3. **Realtime's database pool**: if joins time out at the start of battles
   (`channel_errors` in `sync_health`, `IncreaseConnectionPool` in the Realtime log), raise
   the Realtime authorization pool (dashboard → Realtime settings, database connection pool;
   ~10, docs/07 §7.5.4).
4. **Nothing to change in the clients**: they already send at most one activity update per
   15 s during BUILD and back off 5, 10, 20, 30 s (+ jitter) after a server-closed channel,
   so a rate limit does not turn into a reconnect storm.

## Verify

- `sync_health`: `server_closed` and `rejoins` back to 0 for new battles; `degraded_ms`
  small.
- No new rate-limit messages in the Realtime log; "Reconnecting…" gone.

## Follow-ups

- Re-measure with the load test on staging (`pnpm --filter @br/loadtest loadtest --profile
  full --realtime-limits free`, docs/07 §7.7; `BR_JOBS=worker` for its capture services) when
  the plan or the quotas change; Pro's 50/s figure is an assumption, Free's 20/s is
  Supabase's documented limit.
- If Presence remains the limit, the next cuts cost sidebar freshness (docs/07 §7.6 item 2).
