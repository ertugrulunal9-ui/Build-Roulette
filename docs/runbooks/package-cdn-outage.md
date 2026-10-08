# Package CDN outage

`@br/pkg-cdn` (`apps/pkg-cdn`) serves npm packages as ES modules to every preview, the reveal
and the screenshot renderer. It runs in Cloudflare Containers behind the Cloudflare cache:
exact-version URLs are immutable, so the edge answers almost every request and the origin
only bundles packages nobody asked for yet. It depends on the npm registry for those.

## Symptoms

- Previews fail to start or show "Failed to fetch dynamically imported module" / an import
  error in the build overlay; the playground and BUILD previews stay blank.
- Screenshots fall back to client thumbnails (the capture page imports React from the CDN),
  see [capture-backlog.md](capture-backlog.md).
- Sentry (`service: pkg-cdn`): `code: internal` (500, a CDN bug) or `code: registry-error`
  (502: the npm registry failed). 503 (`overloaded`, load shedding) and 504 (`timeout`, a
  slow cold build) are not reported; they show in `/health`.

## Confirm

The origin's own view: uptime, requests by status, the queues and load shedding:

```sh check
curl -sS "$PKG_CDN_URL/health"
```

A package the templates use, through the same URL as the app (`X-Cache` says whether the
origin's disk cache had it; behind Cloudflare also look at `cf-cache-status`):

```sh check
curl -sS -o /dev/null -D - "$PKG_CDN_URL/react@19.3.0" | grep -i -E '^(HTTP|x-cache|cf-cache-status|x-pkg-cdn-error)'
```

Is npm itself down?

```sh
curl -sS https://status.npmjs.org/api/v2/status.json
```

The captures that failed for the same reason in the last hour (a blank render is what a
build looks like when its packages do not load):

```sql
select left(j.last_error, 120) as error, count(*) as jobs
from public.jobs j
where j.kind = 'capture'
  and j.updated_at > now() - interval '1 hour'
  and j.last_error is not null
group by 1
order by jobs desc
limit 10;
```

## Mitigate

1. **The origin is down** (`/health` does not answer): restart or redeploy the container
   (Cloudflare dashboard → Workers & Pages → Containers → the package CDN → restart). Cached
   packages keep being served by the edge meanwhile; only packages never requested before
   fail.
2. **npm is down** (502 `registry-error`): nothing to fix on our side. Cached packages keep
   working; new or never-used versions fail until npm is back. Do **not** purge the
   Cloudflare cache: it is what keeps the game running.
3. **Overloaded** (many 503 in `/health` → `requests.byStatus`, `queues.*.queued` at their
   limit): a burst of cold packages. The client retries after `Retry-After`; if it persists,
   raise `PKG_CDN_MAX_CONCURRENT_BUILDS` / `PKG_CDN_MAX_CONCURRENT_FETCHES` (README
   "Configuration") or give the container more CPU.
4. **The disk cache is full or broken** (`/health` → `cache`): the cache is LRU-evicted at
   `PKG_CDN_CACHE_QUOTA_MB`; a fresh container starts empty and refills from npm.

## Verify

- `/health` shows 2xx growing and no new 5xx; the `curl` of `react@19.3.0` answers `200`.
- A new `/playground` tab renders its template; Sentry's `pkg-cdn` issues stop growing.

## Follow-ups

- A 500 with `code: internal` is a CDN bug: the Sentry event has the package path and the
  stack.
- If npm outages hurt, pre-warm the template packages at deploy (request their exact URLs) so
  the edge always has them.
