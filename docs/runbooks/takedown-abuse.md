# Takedown / abuse request

A build that must go (a report in the queue, an email, a legal request), a player's name that
must go, or someone flooding the game. The tools: `/admin` (report queue, takedown, battle and
room logs), the name filter and the rate limits (supabase/README.md "Abuse controls").

**Take builds down from `/admin`.** It hides the build at once everywhere, deletes its
screenshot (the capture worker's takedown job), marks its reports actioned, logs who did it,
and expires the cached public pages. A takedown made with SQL does all of that **except** the
cache: follow it with "Refresh public copies" ([cache-not-revalidating.md](cache-not-revalidating.md)).

## Symptoms

- `/admin` → Open reports; PostHog `report_filed` rising (by `reason`).
- A request by email naming a results page (`/battles/<id>`), a player page (`/u/<id>`) or a
  room code.
- A flood: Sentry or the logs full of `rate_limited`, many rooms or reports from few users.

## Confirm

The builds of the battle in the request (its id is in the `/battles/<id>` URL), with their
public name and state:

```sql
select bu.id as build_id, bu.name, bp.display_name as builder, bu.status, bu.final_rank,
       bu.capture_status, bu.taken_down_at
from public.builds bu
join public.battle_players bp on bp.battle_id = bu.battle_id and bp.user_id = bu.builder_id
where bu.battle_id = '{{battle_id}}'
order by bu.final_rank nulls last, bu.shipped_at;
```

Its reports, and earlier moderator actions on it:

```sql
select r.reason, r.status, left(r.details, 200) as details, r.created_at
from public.reports r
where r.build_id = '{{build_id}}'
order by r.created_at desc;
```

```sql
select a.action, u.email as admin, a.note, a.created_at
from private.admin_actions a
left join auth.users u on u.id = a.admin_id
where a.build_id = '{{build_id}}' or a.battle_id = '{{battle_id}}'
order by a.created_at desc
limit 20;
```

## Mitigate

1. **A build:** `/admin` → find it in the report queue, or look up the battle id → its log →
   the build → **Take down**, with a note. In a running battle it is also disqualified (its
   reveal slot is skipped, votes for it are dropped). It cannot be undone from the page.

2. **`/admin` is unavailable** (it needs the web app): take it down with SQL, as the admin.
   This sets the admin's identity for this transaction only and calls the same RPC the page
   does, so the checks and the log are the same. Then refresh the cached pages from `/admin`
   once it is back.

   ```sql write
   -- Takes build {{build_id}} down as the admin {{admin_email}} (same RPC as /admin).
   begin;
   select set_config('request.jwt.claims', json_build_object(
            'sub', (select a.user_id from private.admins a
                    join auth.users u on u.id = a.user_id
                    where u.email = '{{admin_email}}'),
            'role', 'authenticated',
            'is_anonymous', false)::text, true);
   select public.admin_take_down_build('{{build_id}}', 'taken down with SQL (runbook)');
   commit;
   ```

3. **A player's name** (on a permanent results page or their history): replace it on every
   battle they played and in their profile, then refresh the public copies of those battles.

   ```sql write
   -- Replaces player {{user_id}}'s display name everywhere it is shown.
   update public.battle_players set display_name = 'Player' where user_id = '{{user_id}}';
   update public.profiles set display_name = 'Player' where id = '{{user_id}}';
   select bp.battle_id from public.battle_players bp where bp.user_id = '{{user_id}}';
   ```

4. **A word the name filter should block** (it is folded: lowercase a–z; `word` must be a
   whole token, `substring` matches anywhere; supabase/README.md "Name filter"):

   ```sql write
   -- Adds a blocked term (safe to re-run).
   insert into private.blocked_terms (term, match, lang)
   values ('zorblax', 'word', 'en')
   on conflict (term) do nothing;
   ```

5. **A flood:** tighten a rate limit for a while (per user; the defaults are in
   supabase/README.md "Rate limits"), and add Cloudflare rate-limiting rules per IP in front
   of the Supabase API for floods from many anonymous accounts.

   ```sql write
   -- Halves the room-creation limit (default 10 per hour); set it back with 10 later.
   update private.rate_limits set max_count = 5, updated_at = now() where action = 'create_room';
   ```

   Who is hitting the limits right now:

   ```sql
   select e.action, e.user_id, count(*) as events, max(e.created_at) as last
   from private.rate_events e
   where e.created_at > now() - interval '1 hour'
   group by e.action, e.user_id
   order by events desc
   limit 20;
   ```

## Verify

- The public page shows "Removed by moderators" without its screenshot on the first request
  (and the OG image, and the builder's `/u/<id>`).
- The screenshot is gone from Storage and the takedown job is done (Health → Jobs →
  takedown "Done 1 h"):

  ```sql
  select j.status, j.attempts, left(j.last_error, 200) as error, t.storage_deleted_at
  from public.jobs j
  left join private.build_takedowns t on t.build_id = j.ref_id
  where j.kind = 'takedown' and j.ref_id = '{{build_id}}';
  ```

- A failed takedown job: "Retry the screenshot delete" in the report queue's resolved view
  (or [capture-backlog.md](capture-backlog.md), step 4).

## Follow-ups

- Answer the requester; keep the admin action log entry (who, when, note) as the record.
- Repeated abuse from one account: its user id is in the battle log's roster; anonymous
  accounts are cheap, so prefer per-IP rules at the edge to per-user bans.
