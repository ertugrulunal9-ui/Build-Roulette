# 8. Free tier

The user decided on 2026-10-09 to deploy on free plans only (docs/BOARD.md, T-033…T-036).
This document collects what that takes. §1 is the web app on Workers Free (T-033); the
other free-tier tasks add their own sections.

## 1. Web app on Workers Free (T-033)

**Question:** can `@br/web` (Next.js 16 through OpenNext on Cloudflare Workers) run on
**Workers Free**: 10 ms of CPU per HTTP request, 1 s of startup, 100,000 requests a day,
and (as briefed) a 3 MB compressed Worker?

Numbers are **measured** on this machine on 2026-10-09 (with the command that reproduces
them), or come from a source marked **confirmed** (Cloudflare's docs, the workerd source,
our own bundle) or **assumed**.

### 1.1 Verdict

**NO-GO for the app as it is.** Only answers that come out of the cache fit, and only in
a warm isolate. A request that makes Next.js render takes 8.5–44 ms in a warm isolate (all
but `/admin/sign-in` over the 10 ms limit) and 250–370 ms in a fresh one, 25–37 times the
limit; Cloudflare's leeway is undocumented in size and, by the one report we have, does not
cover fresh isolates.

| Kind of request | CPU, warm isolate (median / p95) | CPU, fresh isolate (median) | Fits 10 ms? |
|---|---|---|---|
| Cache answers: prerendered pages, `/battles/[id]` HIT and its client-navigation payloads, `/r/[code]` (since T-033), the cached 404 | **2.4–4.0 / 2.9–4.8 ms** | **11–19 ms** | warm: yes, with margin. Fresh: **no on this machine**; only if a production core is ≥ 1.5–2× faster (unknown) |
| Renders: `/battles/[id]` MISS and regeneration, `/u/[id]`, `/admin` pages and actions, 404s of `/battles/*` and `/u/*` | **8.5–44 / 11–80 ms** | **250–370 ms** | **no** |
| Next.js answers that need no render (`/admin/session`, a 404 for an unknown path) | 4–5 ms | 160–165 ms | warm yes, fresh no |
| The OG image (before T-033) | 127–344 / 146–409 ms | 520–710 ms | no: **removed** (§1.6) |

What T-033 changed: the social image is no longer drawn per request (the screenshot or a
static card instead), `/r/[code]` became a cache answer, and the Worker lost `next/og`:
**2,198 → 1,318 KiB gzip** (9,129 → 6,405 KiB raw). Startup (global scope) is **46 ms**
of CPU locally against the 1 s limit. What would make the rest fit is in §1.7: Workers
Paid (US$5/month, no code), or making every frequent request a cache answer or a static
file (4–8 days).

### 1.2 Method

**Setup (local, no Cloudflare account).** The OpenNext build (`cf:build`) served by
`wrangler dev` 4.147.0, i.e. **workerd 1.20261001.1**, the runtime Cloudflare runs, with R2,
D1 and the Durable Object queue emulated, as in `cf:preview`. The local Supabase stack holds
the data. The machine is a 4-vCPU VM (Intel Xeon @ 2.80 GHz). The script:

```sh
pnpm --filter @br/web cf:build
npx -y supabase@2.119.0 start -x studio,imgproxy,vector,logflare,edge-runtime,supavisor,mailpit
pnpm --filter @br/web measure:cpu        # ~60 min; --warm/--cold/--only/--skip-* to narrow it
```

(`apps/web/scripts/measure-cpu/`.) It inserts its own data (finished battles with 4 or 8
builds and a 1280×800 PNG screenshot, a player with 10 battles, open reports, an admin),
then measures every route class:

- **warm:** one unmeasured request of the same kind first, then 20 samples (10 profiled,
  10 not; the "before" run used 30) in the same isolate;
- **cold:** workerd is restarted before every sample (6 per scenario, 3 profiled; fewer for
  the slow ones): a fresh isolate whose global scope already ran at startup, as on
  Cloudflare, then the first request. In a fresh isolate OpenNext loads the Next server
  inside that first request (§1.3).

Each request is measured until the runtime is quiet again, so work after the response
(`waitUntil`/`after()`, the ISR cache write, a background regeneration) counts too; on
Workers it belongs to the same invocation. The takedown and "refresh public copies" actions
are held 10.5 s so their second expiry (`after()`, 10 s later) is included.

**Two numbers per request:**

1. **Isolate CPU (the headline).** A V8 CPU profile of the app's isolate through the
   DevTools protocol (`Profiler.start`/`stop` around the request, via wrangler's inspector
   proxy; 100 µs sampling interval requested, about 150–200 µs effective). V8 records a
   sample only while the isolate is entered, so time spent waiting on Supabase, R2 or D1,
   and time spent in the other isolates of the local runtime (the emulated R2/D1/DO, the
   asset router), leave no samples. Each non-idle sample is credited with the gap before
   it, capped at twice the effective interval (a longer gap is time the isolate did not
   run; `profile.ts`, unit-tested). JavaScript, garbage collection, compilation and native
   calls made from JavaScript are counted: what Cloudflare's per-request CPU covers.
2. **workerd main thread CPU, unprofiled** (`/proc/<pid>/task/<pid>/schedstat`, ns). An
   upper bound: every isolate of the local runtime runs on that thread, so it adds the
   emulated R2/D1/DO and the local routing (5–10 ms on a cached page warm, 20–30 ms cold),
   which run on other machines in production.

**Cross-check:** the same scenarios on Node (`next start`, with a preload reading
`process.threadCpuUsage()` from the request's arrival until the thread is quiet). Warm,
Node and the isolate profile agree within a few ms (§1.4): the profile is not inflating
the numbers.

**Method check** (`calibrate.ts`, run by the same command on a Worker whose work is known):

| Workload | workerd thread, unprofiled (median) | isolate CPU from the profile (median) | wall (median) |
|---|---|---|---|
| empty request | 2.6 ms | 0.2 ms | 6.8 ms |
| wait 300 ms on a fetch | 3.8 ms | 0.6 ms | 308.8 ms |
| loop 2·10⁵ | 10.7 ms | 10.1 ms | 16.5 ms |
| loop 10⁶ | 50.8 ms | 55.9 ms | 59.0 ms |
| loop 4·10⁶ | 197.8 ms | 214.8 ms | 223.9 ms |

Waiting is not counted (0.6 ms for 300 ms of wall time), and for CPU-bound work the
profile reads 5–10 % above the unprofiled thread: the profiler's sampling slows the
profiled run itself. The thread's 2–4 ms on the empty request is the local runtime's own
routing.

**Precision.** For CPU-bound work the profile estimate is within about 10 % of the thread's
own CPU (the loops above; the thread also pays the request's fixed cost). For short
requests the floor is the sampling interval (±0.2 ms) plus at most 0.4 ms per wait on I/O.
The profiler costs a little CPU itself and makes first-time compilation dearer, so the
cold numbers lean pessimistic. Medians and p95 are over one run's samples (n in the CSVs;
p95 of 10–15 samples is close to the maximum). Raw samples:
`apps/web/cpu-results/<run>/samples.jsonl` (gitignored); per-scenario statistics:
[data/t033-cpu-before.csv](data/t033-cpu-before.csv) (the build before T-033's changes) and
[data/t033-cpu-after.csv](data/t033-cpu-after.csv) (after). In the CSVs,
`thread_cpu_profiled` includes the profiler's own signal handling and is not used.

**What this cannot measure: Cloudflare's CPUs.** `wrangler check startup` itself warns that
a local profile runs on "a different CPU than when your Worker runs on Cloudflare". A
production core may be faster or slower than this VM; §1.5 says where that matters.

### 1.3 How Cloudflare enforces the limit

| Finding | Status | Source |
|---|---|---|
| 10 ms CPU per HTTP request on Free (also 10 ms per Cron Trigger); 5 min max / 30 s default on Paid | confirmed | Workers limits page (`workers/platform/limits.mdx` in cloudflare-docs, read 2026-10-09) |
| Waiting on I/O does not count: "Waiting on network requests (such as `fetch()` calls, KV reads, or database queries) does **not** count toward CPU time" | confirmed | same page |
| Over the limit the visitor gets **Error 1102** "Worker exceeded resource limits"; the invocation's outcome is `exceededCpu` | confirmed | same page |
| **The global scope runs under a separate startup limit** (1 s on both plans since 2025-10-10, was 400 ms; a slower Worker is refused at deploy with error 10021 "Script startup exceeded CPU time limit"), not under a request's CPU limit | confirmed (docs and workerd) | limits page, changelog 2025-10-10; workerd `src/workerd/io/worker.c++` evaluates the main module inside `IsolateLimitEnforcer::enterStartupJs()`, while request code runs inside `LimitEnforcer::enterJs()` ("to enforce limits on that code execution, particularly the CPU limit", `limit-enforcer.h`) |
| How the production enforcer meters those scopes | assumed | the enforcer is not in workerd (its open-source build has none); we rely on the interface and the docs |
| **OpenNext loads the Next server inside the first request**, not at startup, so in a fresh isolate that work counts toward the first request's 10 ms | confirmed (our bundle) | `.open-next/worker.js` runs `await import("./server-functions/default/handler.mjs")` inside `fetch`; wrangler's esbuild turns it into a lazy `__esm` initialiser (`init_handler` in the `wrangler deploy --dry-run` output): plain JavaScript in the request, not a separately metered dynamic import (`enterDynamicImportJs`). Measured: a fresh isolate's first cache answer costs ~12 ms, but its first answer that needs Next costs ~160 ms (§1.4) |
| **Leeway:** "Each isolate has some built-in flexibility to allow for cases where your Worker infrequently runs over the configured limit. If your Worker starts hitting the limit consistently, its execution will be terminated according to the limit configured." | confirmed | docs partial `isolate-cpu-flexibility` (on the limits page) |
| The leeway is **rollover CPU time**: requests under the limit leave credit that later ones can use ("higher quantiles may appear to exceed CPU time limits without generating invocation errors because of a mechanism in the Workers runtime that allows rollover CPU time for requests below the CPU limit") | confirmed | `workers/observability/metrics-and-analytics.mdx`; workerd's source also mentions a "rollover bank" (`worker.c++`) |
| How big the bank is, how fast it fills, whether a **fresh isolate** starts with any credit | **unknown** | not documented |
| A fresh isolate gets no meaningful credit: on Workers Free, cron ticks on cold isolates were killed at exactly 10.0 ms (`exceededCpu`, `cpuTime: 10`), while warm isolates ran at a p50 of ~19 ms without errors | assumed (one third-party report) | emdash-cms/emdash issue #3858 |
| No averaging across isolates or over time beyond the per-isolate rollover | assumed | nothing in the docs says otherwise |
| Cold starts are rarer since 2025: Cloudflare routes a Worker's requests in a data center to a server that already has it loaded ("cut cold starts tenfold"; InfoQ reports a 99.99 % warm-request rate) | blog summary confirmed, the 99.99 % assumed | Cloudflare blog "Eliminating Cold Starts 2: shard and conquer" (2025-09-26), read through search snippets only |
| Worker size: the brief's 3 MB (Free) / 10 MB (Paid) compressed. The limits page now lists **64 MiB uncompressed on both plans** ("There is no compressed size limit"); secondary reports date the change to a 2026-09-04 changelog entry, and a wrangler 4.129.1 release note says the compressed limits were removed server-side | page confirmed; date assumed | limits page; release-note snippets |
| 100,000 requests/day on Free (Error 1027 beyond, reset at 00:00 UTC); static asset requests are not Worker invocations | confirmed | limits page |

The docs were read through a search tool and GitHub on 2026-10-09 (this container cannot
reach developers.cloudflare.com).

### 1.4 Results

Isolate CPU in ms, median / p95, warm (n = 10–15 profiled samples) and cold (n = 2–3; a
fresh isolate each). "workerd thread" is the unprofiled upper bound (median); "Node" is
`next start` (median). Numbers from the "after" run where the route still exists, from the
"before" run for the removed OG route (marked).

| Request | Workers, warm: median / p95 | Workers, fresh isolate: median / p95 | workerd thread, warm / fresh (median) | Node, warm / fresh (median) | warm / fresh vs 10 ms |
|---|---|---|---|---|---|
| `/` (prerendered) | 3.0 / 3.9 | 11.3 / 13.7 | 8.9 / 33.8 | 4.4 / 16.7 | ✔ / ~ |
| `/play` (prerendered) | 2.7 / 4.4 | 11.8 / 16.9 | 9.0 / 36.1 | 3.2 / 17.8 | ✔ / ~ |
| `/playground` (prerendered) | 2.6 / 3.2 | 12.4 / 17.4 | 8.2 / 32.5 | 3.0 / 18.6 | ✔ / ~ |
| `/icon.svg` (prerendered route) | 2.4 / 3.5 | 12.3 / 12.5 | 8.4 / 31.4 | 4.3 / 25.3 | ✔ / ~ |
| `/r/[code]`, T-033: one prerendered page | 3.3 / 3.7 | 13.6 / 18.0 | 8.6 / 34.1 | 3.4 / 16.4 | ✔ / ~ |
| `/r/[code]`, before T-033 (rendered per request) | 9.3 / 13.2 | 202.6 / 223.9 | 11.4 / 360.3 | 8.8 / 72.7 | ~ / ✘ |
| `/battles/[id]` HIT | 3.5 / 4.8 | 15.3 / 19.6 | 9.9 / 35.7 | 4.1 / 168.5 | ✔ / ~ |
| `/battles/[id]` RSC payload (client navigation), HIT | 4.0 / 4.8 | 19.3 / 19.4 | 9.8 / 36.5 | – / – | ✔ / ~ |
| `/battles/[id]` RSC prefetch (`<Link>` in view), HIT | 4.0 / 20.6 | 14.3 / 18.9 | 9.3 / 32.6 | – / – | ✔ / ~ |
| `/battles/<malformed id>` (404, cached 1 h), HIT | 2.5 / 2.9 | 13.1 / 14.5 | 7.6 / 32.6 | 3.8 / 151.5 | ✔ / ~ |
| `/battles/[id]` MISS: render, 4 builds | 35.0 / 40.1 | 309.8 / 324.1 | 47.8 / 493.8 | 33.0 / 171.2 | ✘ / ✘ |
| `/battles/[id]` MISS: render, 8 builds | 33.0 / 45.0 | 311.5 / 341.4 | 49.1 / 451.9 | 25.6 / 180.6 | ✘ / ✘ |
| `/battles/[id]` STALE, with the background regeneration | 44.3 / 79.4 | 370.3 / 389.0 | 56.8 / 518.1 | 27.1 / 178.4 | ✘ / ✘ |
| `/battles/<unknown id>` (404, cached 5 s) | 21.3 / 29.7 | 326.7 / 328.7 | 33.8 / 412.4 | 23.0 / 159.2 | ✘ / ✘ |
| `/u/[id]`, 10 battles, data cached | 25.3 / 56.5 | 306.4 / 317.7 | 27.9 / 390.9 | 16.7 / 146.2 | ✘ / ✘ |
| `/u/[id]`, 10 battles, data not cached | 26.2 / 29.8 | 321.5 / 325.0 | 30.2 / 431.3 | 22.8 / 149.9 | ✘ / ✘ |
| `/u/<unknown id>` (404) | 15.9 / 20.2 | 262.9 / 279.1 | 22.2 / 403.2 | 15.2 / 139.1 | ✘ / ✘ |
| `/<unknown path>` (404 from Next's cache) | 4.4 / 6.5 | 163.2 / 177.7 | 10.2 / 323.8 | 3.1 / 10.8 | ✔ / ✘ |
| `/admin/sign-in` | 8.5 / 11.3 | 252.1 / 278.3 | 12.0 / 368.7 | 8.1 / 87.7 | ~ / ✘ |
| `/admin`, not signed in (404) | 11.8 / 14.8 | 286.2 / 304.3 | 14.0 / 396.5 | 10.5 / 96.4 | ✘ / ✘ |
| `/admin` (report queue) | 26.1 / 31.3 | 283.1 / 290.5 | 30.2 / 473.7 | 21.3 / 167.0 | ✘ / ✘ |
| `/admin?q=<battle>` (event log) | 18.2 / 24.8 | 303.3 / 312.4 | 23.2 / 418.6 | 15.7 / 152.4 | ✘ / ✘ |
| action: sign in | 28.3 / 34.8 | 295.0 / 316.2 | 36.2 / 419.3 | 30.0 / 84.6 | ✘ / ✘ |
| action: dismiss reports | 27.0 / 61.5 | 298.7 / 343.0 | 32.9 / 395.3 | 26.5 / 80.5 | ✘ / ✘ |
| action: take down (with its expiry 10 s later) | 25.0 / 26.3 | 301.6 / 329.5 | 44.9 / 373.2 | 91.3 / 210.8 | ✘ / ✘ |
| action: refresh public copies (same) | 23.8 / 24.7 | 280.4 / 313.1 | 40.9 / 398.0 | 73.8 / 203.0 | ✘ / ✘ |
| `/admin/session` (route handler) | 5.4 / 10.0 | 160.2 / 175.2 | 9.3 / 313.4 | 7.2 / 56.4 | ✔ / ✘ |
| OG image MISS, PNG screenshot (before T-033; removed) | 343.7 / 408.8 | 709.0 / 722.6 | 306.6 / 857.2 | 44.8 / 311.6 | ✘ / ✘ |
| OG image MISS, no screenshot (before T-033; removed) | 127.4 / 146.0 | 521.6 / 557.9 | 122.9 / 652.7 | 32.8 / 318.4 | ✘ / ✘ |
| OG image HIT (before T-033; removed) | 2.8 / 3.4 | 14.1 / 16.8 | 10.0 / 34.0 | 3.6 / 332.1 | ✔ / ~ |
| `/og-card.png` (static asset, T-033) | 0.0 / 0.1 | 0.0 / 0.0 | 2.8 / 7.7 | 1.6 / 8.3 | no Worker |

✔ fits with margin (≤ 6 ms), ~ at the limit (10–20 ms in a fresh isolate), ✘ over.
Warm, the three measurements agree: profile, unprofiled thread minus the local R2/D1
emulation (5–7 ms on cache answers), and Node. One exception: the OG image costs 45 ms on
Node and 344 ms on workerd, where resvg runs as WebAssembly instead of native code.

How the cold cost splits (medians, isolate CPU): the routing and cache-interception code
that a fresh isolate compiles on first use costs ~9 ms (a cache answer: ~3 ms warm, ~12 ms
cold); loading the Next server adds ~150 ms (a 404 that Next answers from its own cache:
4 ms warm, 163 ms cold); the first render of a route then adds 40–150 ms of compilation on
top (`/r/[code]` before T-033: 203 ms cold; `/battles/[id]` MISS: 310 ms). Run to run, the
fresh-isolate medians move by ±15 % (before/after CSVs, same code).

Startup (`wrangler check startup`, part of `measure:cpu`): **46 ms** of CPU after T-033
(51–55 ms before), against the 1 s limit: fine.

### 1.5 GO / NO-GO

Per route, against 10 ms (✔ fits with margin, ~ at the limit, ✘ over):

| Route | Warm | Fresh isolate | When it renders | What a visitor sees when it does not fit |
|---|---|---|---|---|
| `/`, `/play`, `/playground`, `/icon.svg` | ✔ 2.4–3.0 ms | ~ 11–12 ms | never (prerendered) | Error 1102 instead of the page, on the first request of a fresh isolate |
| `/r/[code]` (T-033: one prerendered page) | ✔ 3.3 ms | ~ 14 ms | never | as above: the invite link opens on an error page |
| `/battles/[id]` HIT, client navigation and `<Link>` prefetch payloads | ✔ 3.5–4.0 ms | ~ 14–19 ms | — | as above; a failed prefetch only costs the speed-up |
| `/battles/[id]` MISS | ✘ 33–35 ms | ✘ 310–312 ms | the first view of a battle (right after RESULTS: the most shared moment) and the first view after a takedown (its copy is expired, not served once more) | Error 1102 on the results page; after a takedown the next viewer gets the error rather than the removed build |
| `/battles/[id]` STALE | ✔ the answer itself is a cache answer | ~ | a view of a copy past its lifetime (5 s while the battle can change, 1 h once settled) starts a background regeneration: its own invocation, as costly as a MISS | the visitor gets the old copy at once; the regeneration fails, so the copy stays old (T-026's lifetimes stop holding: screenshots and `destroyed_at` never show) |
| `/battles/<unknown id>`, `/u/<unknown id>` | ✘ 16–21 ms | ✘ 263–327 ms | every request | Error 1102 instead of the 404 |
| `/battles/<malformed id>` | ✔ 2.5 ms | ~ 13 ms | once an hour | as for cache answers |
| `/u/[id]` | ✘ 25–26 ms | ✘ 306–322 ms | every request (dynamic) | Error 1102: "Your battle history" does not open |
| `/<unknown path>` (404) | ✔ 4.4 ms | ✘ ~163 ms | — | Error 1102 instead of the 404 in a fresh isolate |
| `/admin/sign-in`, `/admin` 404 | ~ 8.5–11.8 ms (p95 11–15) | ✘ 252–286 ms | every request | moderators get 1102 at times |
| `/admin`, `/admin?q=` | ✘ 18–26 ms | ✘ 283–303 ms | every request | moderation unusable |
| Admin server actions (sign in, dismiss, take down, refresh) | ✘ 24–28 ms | ✘ 280–302 ms | every request | the action fails. **A takedown can end half done**: if the Worker is stopped after the RPC and before the tag write, the build is down in the database but the cached pages keep showing it for up to an hour |
| `/admin/session` (route handler) | ✔ 5.4 ms | ✘ ~160 ms | — | the session refresh fails in a fresh isolate |
| OG image | — | — | removed by T-033 | (before: no preview image, 1102 to the crawler) |
| Static assets (JS/CSS, `esbuild.wasm`, `/og-card.png`) | not a Worker invocation | | | — |

**Overall: NO-GO.** On Workers Free the app would serve its prerendered and cached pages
while isolates are warm, and fail with Error 1102 on every server render: results pages
the first time they are viewed (and after each takedown), every player-history page,
every 404 under `/battles` and `/u`, and all of `/admin`. In a fresh isolate even the
cached pages are at the limit on this machine. Two unknowns could soften this but not
flip it: a faster production CPU (renders would still need to be 3–37× faster), and the
rollover bank (a warm isolate serving mostly 3 ms cache answers may absorb an occasional
30 ms render; `/u/[id]` and `/admin` render on every request, which is "hitting the limit
consistently").

**How often fresh isolates happen** (assumed, not measurable without an account): every
deploy, every data center the first time it serves the Worker, and after an idle eviction
(Cloudflare publishes no idle timeout). Since 2025 a data center sends a Worker's requests
to one server that has it loaded, which cut cold starts tenfold (§1.3), but a party game
with a few battles a day is the low-traffic case where isolates are evicted between visits.

### 1.6 What T-033 changed

1. **No social card drawn per request.** `/battles/[id]/opengraph-image` (satori + resvg in
   the Worker: 344 ms warm with a PNG screenshot, 127 ms without, 520–710 ms cold) is gone.
   The page's `og:image`/`twitter:image` (`src/lib/solo/og-image.ts`, used by
   `generateMetadata`) is now
   - the rank-1 build's screenshot as stored in the public `screenshots` bucket (served by
     Supabase Storage, not by the Worker), with its size (1280×800 captured, 640×400 for the
     client fallback) and type;
   - otherwise the static `public/og-card.png` (1200×630, drawn once by
     `pnpm --filter @br/web og-card`, served as a static asset): no builds, no screenshot,
     or **a rank-1 build taken down after RESULTS: its screenshot never appears and the next
     build is not promoted (T-028)**. Unit tests in
     `src/components/results/public-pages.test.ts`; the ISR and moderation e2e check the
     `og:image` before and after a takedown, on `next start` and on Workers.

   What the old card drew (the challenge, WINNER and the awards) stays in
   `og:title`/`og:description` and on the page. A WebP screenshot (what the local capture
   worker stores) as `og:image` relies on the preview crawler accepting WebP; most do
   (assumed, not tested); T-034's Browser Rendering can store PNG/JPEG if one matters.
   The Worker also lost `next/og` (resvg.wasm, yoga.wasm, a font, satori):
   **9,129 → 6,405 KiB raw, 2,198 → 1,318 KiB gzip** (`wrangler deploy --dry-run`), under
   the 3 MB compressed limit of the brief with room to spare (and far under today's 64 MiB).
2. **`/r/[code]` is one prerendered page.** `next.config.ts` rewrites `/r/{code}` to `/r`
   (`src/app/r/page.tsx`); `RoomLoader` reads the code from the browser's URL after
   hydration (`src/lib/room/path.ts`, unit-tested), remounts the room when the code changes
   and sets the tab title. OpenNext's cache interception runs after rewrites, so the Worker
   answers every room link from the cache: **9.3 → 3.3 ms warm,
   203 → 14 ms in a fresh isolate** (isolate CPU, median).
   The room itself was already client-only, so nothing users see changes (the URL stays
   `/r/{code}`; the multiplayer e2e pass).
3. **Cached answers take the cheap path (checked, nothing to change).** Prerendered pages,
   `/battles/[id]` HITs, a battle's RSC payload for client navigations and `<Link>`
   prefetches, the cached 404 of a malformed battle id and `/icon.svg` are answered by
   OpenNext's cache interception before the Next server loads (`x-opennext-cache: HIT`):
   2–4 ms warm. A 404 for an unknown path is the one cheap answer that needs Next loaded (it
   serves the prerendered not-found from Next's own cache: 4 ms warm, ~163 ms in a fresh
   isolate).

Not done, and why: moving OpenNext's lazy Next-server load into the global scope (a custom
Worker entry) would move ~150 ms of a fresh isolate's first render into the 1 s startup
budget, but the first render would still compile 40–150 ms of code: it changes no verdict
above. V8 compile hints (eager compilation at startup) are untested and would grow startup
for a 6 MB script.

### 1.7 Options for what does not fit

None of these is implemented: each is a refactor or a product decision. Efforts are for one
worker, tests and e2e included, from what this task saw of the code.

| | Option | What it takes | Effort | On Workers Free |
|---|---|---|---|---|
| A | **Workers Paid** (US$5/month; the T-012 plan) | Nothing. | none | Everything fits: 30 s of CPU by default; the slowest request left is under 0.4 s, in a fresh isolate. |
| B | **"Cache-only Worker"**: keep Next/OpenNext, make every frequent request a cache answer | (1) `/u/[id]`: a prerendered shell (`/u` plus a rewrite, as `/r` now) whose data the browser reads with `get_player_history` (anon key). (2) `/battles/[id]`: the same, plus a few lines in a custom Worker entry that read `get_public_battle` and write the `og:`/`twitter:` tags and the title into the cached shell with `HTMLRewriter` (streaming, native; to be measured, expected well under 5 ms). The T-026 ISR/tag machinery for both pages goes away: the browser reads live data, so a takedown shows at once. (3) `/admin`: a client page calling the admin RPCs with the admin's own session (Postgres already checks `is_admin()`), no server actions. (4) Unknown paths: a static 404 from the Worker entry before Next loads. | **M–L: 4–6 days** | Warm: fits (2–4 ms). Fresh isolate: **11–19 ms on this machine, at the limit**; fits only if a production core is 1.5–2× faster. Needs a check on a real account (Workers Observability shows CPU per invocation) before relying on it. |
| C | **Static export** (`output: 'export'`) on Workers static assets, no Next server | Every page client-side (as in B) and served as a file: no Worker CPU at all, and static asset requests are free and do **not** count toward the 100,000 requests/day. Dynamic paths through a single-page-application fallback or `_redirects` (`/battles/:id` → one shell). Link previews per battle either dropped (the static card for all) or kept by a tiny Worker on `/battles/*` that only runs `HTMLRewriter` (as in B). R2, D1, the Durable Object queue and the OpenNext adapter leave the deploy. | **L: 6–8 days** | Fits by construction (the only Worker, if kept, does `HTMLRewriter` work and one fetch). The most robust free setup and the simplest to operate. |
| D | Another free host for the server-rendered routes (e.g. Netlify's free tier) | A second deploy target, its own limits and quotas; one more vendor (the user dropped Vercel). | M: 1–2 days, plus ops | Not evaluated here. |
| E | Change nothing and rely on the rollover leeway | — | none | **Not recommended:** undocumented size; fresh isolates (common at low traffic) get none (assumed, §1.3); `/u/[id]` and `/admin` render on every request. |

Worth doing with any of A–C:

- Turn off `<Link>` prefetching in lists (`/u/[id]` prefetches every "Full results" link,
  one Worker request each). Cheap in CPU (3–4 ms) but each counts toward the 100,000
  requests/day on Free. S.
- If anything still renders in the Worker (B's `HTMLRewriter` path, or ISR if kept), warm
  it from T-034's cron Worker right after RESULTS so a player's first view is not the
  render. S, after T-034.
