# Cache not revalidating

The permanent pages are cached on Cloudflare (T-026, apps/web/DEPLOY.md "Caching"):
`/battles/[id]` and its OG image for **1 hour** once the battle is settled (seconds before),
`/u/[id]`'s data for **at most 60 s**. A takedown in `/admin` expires them at once through the
tag `battle:{id}` (the D1 tag cache) and once more 10 s later by path. So a public page that
still shows something it should not, longer than those lifetimes, means a revalidation that
did not happen.

## Symptoms

- After a takedown, the battle's page (or its OG image in link previews) still shows the
  build's name or screenshot.
- A battle's page stays without screenshots (or still "in progress") long after they landed.
- Typical causes: the takedown was made with SQL (it never touches the cache); the tag write
  failed (D1 unavailable: OpenNext logs it, the admin is not told); a CDN rule ("Cache
  Everything", another CDN) in front of the Worker keeps its own copy.

## Confirm

What the database says (the truth the page should show):

```sql
select bu.id, bu.name, bu.taken_down_at, bu.screenshot_path, b.phase, b.destroyed_at
from public.builds bu
join public.battles b on b.id = bu.battle_id
where bu.battle_id = '{{battle_id}}';
```

Was it taken down from `/admin` (then the page must have been expired), and when:

```sql
select a.action, a.build_id, a.created_at
from private.admin_actions a
where a.battle_id = '{{battle_id}}'
order by a.created_at desc
limit 10;
```

What the Worker serves (`x-opennext-cache: HIT` is the R2 copy; `x-nextjs-cache` a render;
an `age` or `cf-cache-status: HIT` header means something in front of the Worker cached it):

```sh check
curl -sS -o /dev/null -D - "$APP_ORIGIN/battles/$BATTLE_ID" | grep -i -E '^(HTTP|x-opennext-cache|x-nextjs-cache|cache-control|age|cf-cache-status)'
```

The tag cache's last expiry of the battle (`revalidatedAt` in ms; none means it was never
expired):

```sh prod
pnpm --filter @br/web exec wrangler d1 execute build-roulette-web-tags --remote --command "select tag, revalidatedAt from revalidations where tag = 'battle:$BATTLE_ID'"
```

The same against the local Workers preview (after `cf:preview` has run):

```sh check-cf
pnpm --filter @br/web exec wrangler d1 execute build-roulette-web-tags --local --command "select tag, revalidatedAt from revalidations where tag = 'battle:$BATTLE_ID'"
```

## Mitigate

1. **Expire the copies:** `/admin` → look up the battle id → its log → **Refresh public
   copies**. It expires the tag (the page with its `og:image`, every history page that lists
   the battle) and, 10 s later, the page by path, like a takedown.
2. **D1 is down** (the refresh does not help; Cloudflare status shows D1 incidents): the
   copies expire on their own within the hour (`/u/[id]` within a minute). For an urgent
   removal, deploy again (`pnpm --filter @br/web cf:deploy`): every deploy starts with an
   empty cache (keys are per build id).
3. **A CDN rule in front of the Worker:** remove it (DEPLOY.md: no "Cache Everything" rule),
   then purge the URL (Cloudflare dashboard → Caching → Configuration → Purge Cache → Custom
   purge → the page URL).

## Verify

- The `curl` above shows the new content: the first request after the refresh renders
  (`x-nextjs-cache: MISS` or no `x-opennext-cache`), the next one is a `HIT` of the new copy.
- The page shows "Removed by moderators"; a link preview may keep its own old card (social
  networks cache images on their side).

## Follow-ups

- A takedown from `/admin` that did not revalidate: Workers logs (Cloudflare → Workers →
  `build-roulette-web` → Logs) around its time for a failed D1 write; Sentry for errors on
  `route: /admin`.
- If D1 is unreliable, move the tag cache to the sharded Durable Object one (DEPLOY.md
  "Caching", "Things to know").
