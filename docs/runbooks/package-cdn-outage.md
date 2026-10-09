# Package CDN outage

**Which CDN?** On the free plan, production uses the **public esm.sh** (`https://esm.sh`,
T-035): see "esm.sh (free plan)" right below. The rest of this runbook is for our own CDN,
`@br/pkg-cdn`, when it runs in production (a paid plan). Players see the same thing either
way (Symptoms).

`@br/pkg-cdn` (`apps/pkg-cdn`) serves npm packages as ES modules to every preview, the reveal
and the screenshot renderer. It runs in Cloudflare Containers behind the Cloudflare cache:
exact-version URLs are immutable, so the edge answers almost every request and the origin
only bundles packages nobody asked for yet. It depends on the npm registry for those.

## esm.sh (free plan)

esm.sh is a third party: there is nothing of ours to restart. The player-facing behaviour and
texts are the ones under Symptoms below ("Package server unreachable: …" names the package as
the build imports it, also when a module behind esm.sh's entry URL is what failed); a failed
esm.sh build shows as "Package server error (HTTP 500) for …: [esm.sh] …".

Confirm that esm.sh itself answers (the template's React; expect `HTTP/2 200`, a long
`cache-control`, `access-control-allow-origin: *`):

```sh prod
curl -sS -o /dev/null -D - "https://esm.sh/react@19.3.0" \
  | grep -i -E '^(HTTP|cache-control|access-control-allow-origin|vary|cf-cache-status)'
```

Then:
1. **esm.sh is down or slow for everyone:** wait. Players keep every package their browser
   loaded (React for anyone who waited in a lobby or ran SPIN); new packages fail with the
   texts above, screenshots fall back to client thumbnails. Note the time span for the
   post-incident review.
2. **Only some packages fail** (a 4xx/5xx for one URL, others fine): an esm.sh build problem
   for that package or version. Nothing to do for the battle; if it persists, report it to
   esm.sh and check the package with the compatibility suite
   (`pnpm --filter @br/pkg-cdn compat --cdn https://esm.sh --only <package>`).
3. **Long or repeated outages, or esm.sh changes its terms:** move to another CDN
   (docs/08-free-tier.md §4 "Switching back to our CDN"): our own `@br/pkg-cdn` (needs a paid
   plan for Containers, or another host), or another esm.sh-compatible CDN after the
   compatibility suite passes against it. It is a configuration change: the app's
   `NEXT_PUBLIC_PKG_CDN_URL`, the shell's `BR_PKG_CDN_URL`, the capture worker's
   `PKG_CDN_URL`, then rebuild and deploy the app and the shell.

What players see while it is down (T-032, docs/03-sandbox.md "Package cache and CDN
outages"): every package their browser already loaded keeps working from the browser's
HTTP cache. That covers the template's React for anyone who waited in a room lobby on a
desktop or whose BUILD preview ran during SPIN, so edits, preview restarts, reloads,
autosave, ship and the last look go on. Only packages a browser never loaded fail.

## Symptoms

- The preview's overlay says **"The build failed to load"** with **"Package server
  unreachable: zustand@5.0.15"** (no answer), "Package server not responding: …" (timed
  out) or "Package server error (HTTP 5xx) for …" (the CDN's own error text), about a second
  after the edit. A CDN that accepts connections but never answers shows "Still waiting for
  the package server after 8 s: …" instead. Package CSS shows the same words in Problems.
- In REVEAL, a build whose packages this viewer never loaded shows its screenshot with
  "This build's packages couldn't load on your screen (the package server isn't
  answering)". Spectators on phones (no warm-up) see this most.
- Screenshots fall back to client thumbnails (the capture renderer is a fresh browser that
  imports React from the CDN), see [capture-backlog.md](capture-backlog.md).
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
   packages keep being served by the edge meanwhile (`cf-cache-status: HIT`), and players'
   browsers keep what they loaded; only packages never requested before fail. If the
   template packages answer with a 5xx instead of `HIT`, the edge does not have them: see
   the edge setup in `apps/pkg-cdn/README.md` "Origin outages" and pre-warm them once the
   origin is back (below).
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
- Pre-warm the template's packages through the same URL as the app (after an outage, a
  deploy or a purge), so the edge has them before the next outage. The version is
  `REACT_VERSION` in `packages/workspace/src/templates.ts`. Each line should say `200`, and
  a second run should show `cf-cache-status: HIT` behind Cloudflare:

```sh check
v=19.3.0
for p in "react@$v" "react@$v/jsx-runtime?external=react,react-dom" \
  "react@$v/jsx-dev-runtime?external=react,react-dom" \
  "react-dom@$v?external=react,react-dom" "react-dom@$v/client?external=react,react-dom"; do
  echo "$p: $(curl -sS -o /dev/null -D - "$PKG_CDN_URL/$p" \
    | grep -i -E '^(HTTP|cf-cache-status)' | tr -d '\r' | paste -sd ' ' -)"
done
```

## Follow-ups

- A 500 with `code: internal` is a CDN bug: the Sentry event has the package path and the
  stack.
- If npm outages hurt, run the pre-warm above from the deploy pipeline, and consider Cache
  Reserve so the edge keeps every package ever requested (`apps/pkg-cdn/README.md` "Origin
  outages").
- Reproduce locally: `pnpm --filter @br/runtime exec playwright test e2e/cdn-outage.spec.ts`
  and `pnpm --filter @br/web exec playwright test e2e/cdn-outage.spec.ts` take the mock CDN
  down mid-test (`POST 127.0.0.1:4323/cdn-outage?mode=refuse|error|hang|off` while
  `dev:sandbox` runs).
