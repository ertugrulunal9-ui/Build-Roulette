# Removed content still visible

Since T-037 the public pages (`/battles/[id]`, `/u/[id]`) are static shells that read the
database in the browser on every load (`get_public_battle`, `get_player_history`, no cache).
A takedown, from `/admin` or with SQL, shows on the very next page load: there are no cached
copies of the pages to expire (this runbook replaces T-026's "cache not revalidating").
What can still show a removed build for a while is outside the pages: its **screenshot file**
and **link previews**.

## Symptoms

- After a takedown, someone still sees the build's name or screenshot on `/battles/<id>` or
  `/u/<id>`, or in a link preview (a chat app, a social network).
- The screenshot URL (`/storage/v1/object/public/screenshots/<battle>/<build>.<ext>`) still
  answers 200.

## Confirm

What the database says (the truth the page shows): `taken_down_at` set and the public name
gone means the page is right on its next load.

```sql
select bu.id, bu.name, bu.taken_down_at, bu.screenshot_path, b.phase, b.destroyed_at
from public.builds bu
join public.battles b on b.id = bu.battle_id
where bu.battle_id = '{{battle_id}}';
```

What the public RPC returns, exactly as the page reads it (no cache on the way):

```sh check
curl -sS -X POST "$SUPABASE_URL/rest/v1/rpc/get_public_battle" -H "apikey: $SUPABASE_ANON_KEY" -H "content-type: application/json" -d "{\"p_battle_id\":\"$BATTLE_ID\"}" | head -c 600; echo
```

The page itself is a static file; its HTML holds no battle data (the browser revalidates it on
every load: `max-age=0, must-revalidate`):

```sh check
curl -sS -o /dev/null -D - "$APP_ORIGIN/battles/$BATTLE_ID" | grep -i -E '^(HTTP|cache-control|age|cf-cache-status)'
```

The screenshot's deletion (the capture worker's takedown job):

```sql
select j.status, j.attempts, left(j.last_error, 200) as error, t.storage_deleted_at
from public.jobs j
left join private.build_takedowns t on t.build_id = j.ref_id
where j.kind = 'takedown' and j.ref_id = '{{build_id}}';
```

## Mitigate

1. **The page shows the build and the database says it is not taken down:** take it down
   ([takedown-abuse.md](takedown-abuse.md)). The next load shows "Removed by moderators".
2. **The database says taken down but someone still sees it:** they are looking at a page
   loaded before the takedown. A reload shows the removal.
3. **The screenshot file still answers:** the takedown job has not finished or failed:
   "Retry the screenshot delete" in `/admin`'s resolved reports, or
   [capture-backlog.md](capture-backlog.md) step 4. Once deleted, browsers and Supabase's CDN
   may still hold it for up to 5 minutes (the upload's `max-age=300`).
4. **A link preview:** social networks and chat apps cache previews on their side; most offer
   a refresh tool (e.g. a debugger page) for the URL. Until T-038 every battle's preview is the
   static card anyway, never a screenshot.

## Verify

- `/battles/<id>` shows "Removed by moderators" without its screenshot on a fresh load, and so
  does the builder's `/u/<id>`.
- The takedown job is `done` with `storage_deleted_at` set (query above), and the screenshot
  URL answers 400 or 404.

## Follow-ups

- A page that still shows a removed build **after a reload** would be a bug in the public RPCs
  (they hide removed builds: T-024/T-028): open an issue with the battle id and the RPC answer.
