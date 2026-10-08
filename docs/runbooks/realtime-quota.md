# Realtime quota hit

Supabase Realtime carries the room's Presence (who is online, the BUILD sidebar's activity)
and the database's broadcasts ("something changed, refetch"). The game state itself is in
Postgres: a client that loses Realtime keeps playing (it polls every few seconds and its
heartbeat compares the battle version every ~10 s), so a Realtime problem degrades the
experience but does not stop battles.

The quota that bites first is **Presence messages per second** (docs/07 §7.5.1): with the
Pro plan's spend cap ON the tenant gets 50/s (assumed), about 15 concurrent 8-player rooms
in BUILD. Above it, Realtime closes channels ("Too many presence messages per second").

## Symptoms

- "Reconnecting…" in rooms; presence dots and the BUILD sidebar flicker or go stale; events
  arrive late (after the next heartbeat).
- PostHog `sync_health` events with `server_closed > 0`, `rejoins > 0`, a high `degraded_ms`
  or `missed > 0`. A useful insight: *Trends → `sync_health` → sum of `server_closed`*, and
  the same for `missed`, by hour.
- Supabase dashboard → Realtime → usage/limits, and Logs → Realtime: rate-limit or
  quota messages.

## Confirm

How many rooms and players are in a running battle right now (compare with ~15 busy
8-player rooms for the capped quota):

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

1. **The spend-cap decision** (docs/07 §7.6, recommendation 1): with the cap ON, Realtime's
   quotas are hard limits. Before about 15 concurrent 8-player rooms in BUILD, turn the spend
   cap **off** (Supabase dashboard → Organization → Billing → Spend cap) or move to the Team
   plan; set a billing alert either way. This is the user's decision (cost); take it before a
   marketing push, not during one if avoidable.
2. **Realtime's database pool**: if joins time out at the start of battles
   (`channel_errors` in `sync_health`, `IncreaseConnectionPool` in the Realtime log), raise
   the Realtime authorization pool (dashboard → Realtime settings, database connection pool;
   ~10, docs/07 §7.5.4).
3. **Nothing to change in the clients**: they already send at most one activity update per
   15 s during BUILD and back off 5, 10, 20, 30 s (+ jitter) after a server-closed channel,
   so a rate limit does not turn into a reconnect storm.

## Verify

- `sync_health`: `server_closed` and `rejoins` back to 0 for new battles; `degraded_ms`
  small.
- No new rate-limit messages in the Realtime log; "Reconnecting…" gone.

## Follow-ups

- Re-measure with the load test on staging (`pnpm --filter @br/loadtest loadtest --profile
  full`, docs/07 §7.7) when the plan or the quotas change; the 50/s figure is an assumption.
- If Presence remains the limit, the next cuts cost sidebar freshness (docs/07 §7.6 item 2).
