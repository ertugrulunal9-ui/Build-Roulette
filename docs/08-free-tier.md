# 8. Free tier

The user decided on 2026-10-09 to deploy on free plans only (docs/BOARD.md, T-033…T-036).
This document collects what that takes. §1 is the web app on Workers Free (T-033: it does
not fit); §2 is what replaced it, the web app as a static site (T-037; on Cloudflare Pages,
since T-043 the static assets of a Worker on `workers.dev`, §2.7); §3 is the one piece of edge
code left, the per-battle link previews (T-038: a Pages Function that fits; a Worker since
T-043); §4 was the package CDN, the public esm.sh instead of our own (T-035; removed in M6:
players import built sites, docs/09); §5 is the
screenshots and the delete jobs without an always-on server (T-034: a Supabase Edge
Function and Browser Rendering's REST API); §6 is Supabase Free itself (T-036: the 7-day pause
and the keep-alive, storage, database, and what each quota allows per month). The step-by-step
deploy of this setup is `DEPLOY.md` at the repository root.

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

## 2. Static site (T-037)

**Decision (the user, 2026-10-09, after §1's NO-GO): option C.** The web app is a static
export served by **Cloudflare Pages** (Free), with every piece of data loaded in the browser.
No Next.js server and no Worker run for the app, so the 10 ms CPU limit and the 100,000
requests a day of Workers Free do not apply to it: static requests on Pages are free,
unlimited and not Worker invocations. Per-battle link previews come back with a small Pages
Function on `/battles/*` in T-038, measured against the 10 ms first (§3).

**Since T-043 (2026-10-16) the host is Workers, not Pages:** `*.pages.dev` is blocked in
Turkey, where the players are (a court/federation order of 2025-11, reported active again in
2026-08), while `*.workers.dev` opens there (the user checked a Hello World Worker). The same
static export is now the **static assets of a Worker** on `workers.dev` (Workers Free), and the
link-preview Function is that Worker's code, run only for `/battles/*`. Static requests stay
free, unlimited and not Worker invocations. The sandbox shell moved the same way, to a
second Cloudflare account (§2.7). The rest of this section describes the static site; where it
says Pages, the Worker's static assets now do the same (§2.7 lists the differences).

### 2.1 What changed

| | Before (T-012…T-033) | After (T-037) |
|---|---|---|
| Build | `next build` + OpenNext → a Worker (1.3 MB gzip) + assets | `next build` with `output: 'export'` → `apps/web/out/` (94 files, 15.8 MiB; JS 706 KiB gzip) + `_headers` and `_redirects` written by `scripts/pages-config.ts` |
| Hosting | Workers (+ R2 incremental cache, D1 tag cache, Durable Object queue) | Pages, static files only (`apps/web/wrangler.jsonc`: `pages_build_output_dir`); since T-043 a Worker's static assets (`assets.directory: ./out`, §2.7) |
| `/`, `/play`, `/playground` | prerendered, served from R2 by the Worker | static files |
| `/r/{code}` | one prerendered page behind a Next rewrite (T-033) | one shell (`out/r.html`) behind a Pages rewrite (`/r/:code /r 200`); the code is read in the browser, as before |
| `/battles/{id}` | ISR: rendered by the Worker, cached up to an hour, revalidated by takedowns | one shell (`out/battles.html`, rewrite `/battles/:id /battles 200`); the browser calls `get_public_battle` (anon key) on every load: loading, not found, "could not load" with a retry, or the results; the tab title is set in the browser |
| `/u/{id}` | rendered per request from data cached ≤ 60 s | one shell (`out/u.html`, rewrite `/u/:id /u 200`); `get_player_history` in the browser, the keyset cursor still in the query string |
| Unknown paths | Next's 404, rendered in the Worker (~163 ms CPU in a fresh isolate) | `out/404.html`, served by Pages with a 404 (since T-043 by the static assets, `not_found_handling: "404-page"`) |
| `/admin` | server-rendered; httpOnly cookies; server actions | a static page; the moderator's own Supabase session in the browser (§2.3); the admin RPCs called with it |
| Takedown visible | on the next request, through tag revalidation (and a second expiry 10 s later) | on the next page load: nothing is cached, nothing to revalidate; a takedown made with SQL shows too |
| Security headers | none set by the app | `_headers`: a CSP without `'unsafe-inline'` scripts (§2.4), `frame-ancestors 'none'`, `X-Frame-Options`, `nosniff`, referrer and permissions policies, COOP, HSTS |
| Error reporting | browser + server (`onRequestError`, `service: web`) | browser only; "Send a test error" throws in the admin page |
| Removed | — | `open-next.config.ts`, the Worker's `wrangler.jsonc`, `@opennextjs/cloudflare`, the `cf:*` and `test:e2e:cf*` scripts, the server actions and the `/admin/session` route handler, `instrumentation.ts`, `lib/cache/policy.ts` and the `'use cache'` loaders, `lib/telemetry/server.ts`, `e2e/isr.spec.ts`, "Refresh public copies", the cache runbook (replaced by `removed-content-still-visible.md`) |

The links between shells (`/battles/{id}`, `/u/{id}`, `/r/{code}`) are plain page loads
(`<a>`, `loadPage()`): Next's client router would first ask for `{path}.txt`, which only real
pages have; the rewrite would answer it with the shell's HTML and the router would fall back
to a page load anyway. Links to real pages (`/`, `/play`) stay client-side.

`next dev` gets the same rewrites from `next.config.ts` (development phase only, from the same
list as `_redirects`: `src/lib/hosting/shells.ts`).

### 2.2 Trade-offs

| | What it costs | Mitigation / owner |
|---|---|---|
| **Link previews** | Crawlers do not run scripts: every battle shares one preview (the generic title and `og-card.png`) instead of its own title and rank-1 screenshot (T-033's `og:image` rule) | **Done in T-038** (§3): a Pages Function on `/battles/*` writes the tags with `HTMLRewriter`. `/u/{id}` and `/r/{code}` keep the generic preview |
| **Status codes** | A shell answers 200 for an unknown battle or player, and `/admin` answers 200 to everyone (the page shows the 404 screen); truly unknown paths still get a real 404 | **Done in T-038 for battles** (§3: a real 404 for an unknown, not-yet-public or malformed battle id); `/u/{id}` still 200; `/admin` is `noindex` (`X-Robots-Tag`) |
| **First paint** | Results and history appear after one RPC round trip from the browser (the HTML is a loading screen); before, the HTML held them | The answer is small: ~3 KB per battle (750–950 bytes gzip, 3–4 builds, measured locally) |
| **Supabase load** | Every view of a results page is one `get_public_battle` call (before: at most one per hour per battle, from the edge cache). A link seen 10,000 times is 10,000 small reads (~10 MB of egress, gzip) | Well inside Supabase's quotas (docs/07 §7); T-036 reviews the Free plan's |
| **Admin session** | In the tab's `sessionStorage`, readable by script on the app origin (an XSS), where T-024's httpOnly cookies were not | §2.3 |
| **SEO of `/u/{id}`, `/battles/{id}`** | No content in the HTML for crawlers | T-038 (§3) gives `/battles/{id}` its own title, description and canonical link; the body stays the shell; full server rendering is what §1 ruled out |
| **Takedown safety net** | Gone, and not needed: a takedown is visible on the next load, whether made in `/admin` or with SQL (T-026's "an SQL takedown stays cached for up to an hour" caveat is gone) | — |

### 2.3 The admin session in the browser

`/admin` is a static page like the others; anyone can load its script, which holds nothing
secret. Postgres's `is_admin()`, checked by every admin RPC, stays the only authority, and the
web app still has no service key (the build fails if any file in `out/` holds one:
`scripts/pages-config.ts`).

**How the session is kept** (`src/lib/admin/client.ts`):

- **A client of its own**, not the player's. The player's supabase-js client keeps its
  anonymous session in localStorage (`br-auth`); signing a moderator in through it would
  replace the player's session (their battles in that browser) and send every game RPC with
  the moderator's token. The moderator client has its own storage key, `br-admin-auth`.
- **This tab only.** supabase-js holds the session in memory (`persistSession: false`) and the
  page mirrors it into the tab's `sessionStorage` on sign-in and on every token refresh, so a
  reload or a link inside `/admin` keeps it. Not localStorage: it would outlive the tab and the
  browser session and be readable from every tab of the origin. Not supabase-js's own
  persistence either: it announces every sign-in and token refresh, session included, on a
  `BroadcastChannel` named after the storage key, which any page of the origin can listen to
  (a player tab would hear the moderator's tokens). Cost: a new tab signs in again; closing
  the tab ends the session in that browser.
- **Sign-out** revokes this session at Supabase Auth (its refresh token stops working: checked
  by the moderation e2e; the account's sessions elsewhere stay) and removes it from memory
  and sessionStorage. A real account that is not an admin is signed out at once, with the
  same answer as a wrong password.
- **Sign-in** sends a Turnstile token when Turnstile is configured (Supabase Auth's CAPTCHA
  protection also covers password sign-ins; T-024's server-side sign-in sent none).
- The sign-in button stays disabled until the page runs, so a form submitted before hydration
  cannot put the password in the URL.

**Against T-024's httpOnly cookies.** The cookies were out of reach of any script on the
origin; a session in `sessionStorage` is not, so an XSS on the app origin in a moderator's
tab could read the moderator's tokens (and act as the moderator until the access token
expires, or until the moderator signs out, which revokes the refresh token). What keeps that
risk low:

- **The app origin serves no user-generated HTML or script.** Builds run on the sandbox site
  (another site with its own CSP, T-009); results show text through React (escaped) and
  screenshots as `<img>`; names pass the name filter.
- **The CSP blocks injected scripts** (`script-src 'self'` plus the hashes of the exported
  pages' own inline scripts, no `'unsafe-inline'`; `'wasm-unsafe-eval'` until M6: the
  static-site e2e injects one and checks it does not run) and limits where data can go
  (`connect-src`: the app, Supabase, Sentry, PostHog, Turnstile; the package CDN until M6).
- `frame-ancestors 'none'` / `X-Frame-Options: DENY` (no clickjacking of the admin page),
  `base-uri 'self'`, `form-action 'self'`, `object-src 'none'`.
- The exposure lasts one tab's lifetime; a leaked access token lives for its own lifetime
  (Supabase's default: 1 hour).
- An XSS could already act as every *player* (their anonymous sessions were always in
  localStorage); what changed is the moderator's tab, while it is open.

Still to do at deploy (as for T-024): admin accounts only for people who need them, strong
passwords, Supabase Auth's rate limits on password sign-in. An edge rule on `/admin*` no
longer protects anything (the page is a public file); the Auth endpoint is what to protect.

### 2.4 The Content-Security-Policy

Next's static export puts two inline scripts in every page (its flight data). They differ per
page but are fixed per build, so `scripts/pages-config.ts` hashes them: 10 distinct hashes
for the 10 HTML files, one policy for every path (a rewritten shell and the 404 page get the
same one). The header line is ~950 characters against the 2,000 per line that Pages and
Workers static assets both allow (one shared parser, §2.7); the build fails if it ever grows
past that. The hosts come from the build's own `NEXT_PUBLIC_*` values, so the
policy always matches the bundles. There is no `'unsafe-eval'`, and since M6 no
`'wasm-unsafe-eval'` either (it was for the playground's esbuild).

Every e2e suite runs under it (`wrangler dev` applies `_headers`; `wrangler pages dev`
before T-043), and the `/try` (the playground before M6),
solo, moderation, rooms and chaos suites fail on any CSP violation of the app's pages
(`e2e/csp.ts`).

### 2.5 CPU

Production runs no Worker for any request of the app. Locally, `wrangler pages dev` runs a
shim Worker that hands each request to the asset server; `pnpm --filter @br/web measure:cpu`
(T-033's tool, trimmed to Pages: `scripts/measure-cpu/`) measures it. On this machine
(2026-10-09, a short run: 2 profiled warm samples and 1 fresh isolate per request): 0.2–0.6 ms
warm and 0.5–1.4 ms in a fresh isolate for `/`, the shells, a JS chunk, `og-card.png` and the
404. That is wrangler's local shim, which Cloudflare does not run or bill for static files;
the tool is kept for T-038's Function on `/battles/*`, which must fit 10 ms (its fixtures,
battles with and without a rank-1 screenshot, are in `scripts/measure-cpu/fixtures.ts`).
Since T-038 production runs one Worker, that Function, and only for `/battles/*` (§3). Since
T-043 the local runtime is `wrangler dev` with static assets: a static path never enters the
Worker's isolate at all (the asset router is a separate worker), as in production.

### 2.6 Verification

`pnpm --filter @br/web build` checks the export (the pages present, no secret key, the host's
limits) and prints its size. Every e2e suite serves `out/` and the Worker with `wrangler dev`
(`e2e/app-server.ts`; `wrangler pages dev` before T-043): `/try` (the playground before M6; with
`e2e/static-site.spec.ts`: rewrites, the 404 page, the headers, the CSP enforced and never violated, `/admin` without a session), solo,
moderation (a takedown visible on the next load; the admin session's storage, its separation
from the player session and from another tab, sign-out revoking the refresh token), rooms,
telemetry (the admin's test error from the browser, no server events) and the three chaos
shards.

### 2.7 Workers instead of Pages (T-043)

**Why:** `*.pages.dev` is blocked in Turkey (a court/federation order of 2025-11, reported
active again in 2026-08) and the players are there; `*.workers.dev` is not (§2). The first
production deploy (Deploy run 2, 2026-10) had been on Pages and passed every check.

| | Web app | Sandbox shell |
|---|---|---|
| Cloudflare account | A, the existing one (also Browser Rendering, Turnstile) | B, a second free account |
| Worker | `build-roulette-web` | `build-roulette-sandbox` |
| Address | `https://build-roulette-web.<subdomain A>.workers.dev` | `https://build-roulette-sandbox.<subdomain B>.workers.dev/v2/` (`/v1/` before M6) |
| Config | `apps/web/wrangler.jsonc` | `apps/sandbox-shell/wrangler.jsonc` |
| Static assets | `apps/web/out/` with `_headers`, `_redirects`, `404.html` | `apps/sandbox-shell/dist/` with `_headers`, `404.html` |
| Worker code, run only for (`run_worker_first`) | `dist/worker.js`: the link previews, `/battles/*` | `dist/worker.js`: the capture gate, `/v2/capture` (`/v1/capture` before M6; Worker secret `CAPTURE_HMAC_SECRET`) |

**Why two accounts.** A Worker's address is `<worker>.<account subdomain>.workers.dev`, one
subdomain per account. The Public Suffix List lists `workers.dev` but not `*.workers.dev`
(checked in the `psl` npm package 1.15.0: the registrable domain of
`build-roulette-web.buildroulette.workers.dev` is `buildroulette.workers.dev`), so two Workers
of one account are one *site*, and the shell must be another site than the app (docs/01 §1.1,
docs/03 §3.5). On Pages each project had its own `<project>.pages.dev`, and `pages.dev` is on
the list, so one account was enough. Now the shell goes to a second free account with its own
subdomain; the deploy refuses the same account for both (`scripts/deploy/settings.mjs`).

**What we rely on, checked offline** against wrangler 4.147.0 (its config schema, its source,
and the workers-shared router and asset workers it runs locally through miniflare
5.20261001.0, the code Cloudflare runs in front of a Worker with static assets) and against
`wrangler dev`:

| Claim | Status | How |
|---|---|---|
| A request served from the assets does not invoke the Worker unless it matches `run_worker_first` | **confirmed** | the router's source: a `run_worker_first` match goes to the Worker; any other path goes to the assets when they can answer it, and with `run_worker_first` set the 404 page counts as an answer. Measured with an instrumented Worker under `wrangler dev`: `/v1/`, `/v1/shell.js` and an unknown path did not invoke it, `/v1/capture` did (shell v1; since M6 the paths are `/v2/…`, the same rule). **Without a `404.html` an unknown path does invoke the Worker** (measured), which is why the shell got one |
| … and is free and unlimited | assumed (Cloudflare's docs and pricing) | not in the source; consistent with it: when an account's Free requests are used up, the router still serves the assets (below) |
| Worker invocations count toward 100,000 a day, with 10 ms CPU each | confirmed in T-033 (§1.3, Cloudflare's limits page) | not checkable offline; the router's "rate limited" answer for an account over its Free requests is in the source |
| 20,000 files per version | assumed (Cloudflare's docs) | wrangler checks no file count before a Workers upload (it does for Pages: 20,000); the export has 94 files, the shell 5 |
| 25 MiB per file | **confirmed** | wrangler refuses a larger asset (`MAX_ASSET_SIZE = 25 * 1024 * 1024`); `esbuild.wasm` (13.3 MiB) was the largest until M6 removed it |
| `_headers` and `_redirects` | **confirmed** | wrangler reads both from the assets directory (and never uploads them as assets); the same workers-shared parser as Pages, with the same limits (100 header rules, 2,000 characters a line, 2,000 static and 100 dynamic redirects); the e2e (§2.6) |
| `_redirects` 200 rewrites (`/u/:id /u 200`) | **confirmed** | the asset worker serves the destination as a proxied path for status 200; the e2e: `/u/x`, `/r/K7QXM` answer 200 with the shell, the URL kept |
| `_headers` applies to what the Worker gets through `env.ASSETS.fetch` | **confirmed** | the asset worker adds the matching `_headers` rules to every answer, also those for the binding; measured: a Worker passing an `env.ASSETS.fetch` answer through keeps the `_headers` CSP. It does not apply to a response the Worker builds itself (`/v2/capture`'s gate, `/v1/` before M6; a preview's 200/404), so those set their headers in code, as before (§3.2) |
| `run_worker_first` as a list of patterns, `not_found_handling: "404-page"`, `workers_dev`, `preview_urls` | **confirmed** | wrangler's config schema |
| `wrangler deploy --secrets-file` | **confirmed** | wrangler 4.147.0: "secrets to upload with the version (JSON or .env format)… omitted secrets will not be deleted"; with `secrets.required` in the config, a deploy without the secret fails on a new Worker and keeps the current value on an existing one |
| Account → Workers Scripts → Edit covers the workers.dev subdomain and route endpoints | confirmed indirectly | wrangler's matching OAuth scope `workers_scripts:write`: "See and change Cloudflare Workers scripts, durable objects, subdomains, triggers, and tail data" |
| A Worker on workers.dev needs the account's workers.dev subdomain, and wrangler registers none without a prompt | **confirmed** | wrangler's source: `GET /accounts/{id}/workers/subdomain` answers error 10007 when there is none, then wrangler asks, which fails in CI. The deploy registers it first (`PUT …/workers/subdomain`; error 10031: the name is taken) |

**What differs from Pages:**

- **No "fail open" at the daily limit.** Past 100,000 Worker requests a day on account A,
  Cloudflare answers `/battles/*` with its own 429 "This website has been temporarily rate
  limited" page until 00:00 UTC (the router's source); every other page is static and keeps
  working. Pages Functions could skip the Function and serve the static shell. On account B the
  same would turn captures into 429s (the players' thumbnails are the fallback, §5).
  `scripts/deploy-check.mjs` names that page. At ~1,000 battles a month neither is near.
- **The sandbox's unknown paths** get its new `404.html` (404, with the `/*` headers) instead
  of an empty 404, so they invoke no Worker.
- **Redirects of the HTML handling** (`/battles/` → `/battles`, `/v2` → `/v2/`) are 307 (Pages:
  308). Nothing links to those forms.
- **Addresses:** `<worker>.<subdomain>.workers.dev`; no per-version preview addresses
  (`preview_urls: false`), no per-deployment `<hash>.<project>.pages.dev` aliases.
- **Deploys are Worker versions:** rollback in Workers & Pages → the Worker → Deployments.
  Logs: `wrangler tail` with the account's token.
- **CPU:** the code is the same. The Worker's isolate no longer runs Pages' routing shim
  (`_routes.json`): the router is a separate worker, so T-038's numbers (§3.3), which include
  the shim, lean pessimistic.

## 3. Link previews (T-038)

**Question:** can a Pages Function give every battle its own link preview (title, `og:*`
with the rank-1 screenshot) and a real 404 for an unknown battle, within Workers Free's 10 ms
of CPU per request, without ever breaking the page?

### 3.1 Verdict

**GO.** On this machine the Function costs **1.2–1.7 ms** of isolate CPU per request in a warm
isolate (median; p95 1.8–3.2 ms) and **3.2–4.2 ms** in a fresh one (median; p95 4.3–7.3 ms,
worst of 60 fresh samples 8.8 ms), in every case: a battle with its screenshot, a removed
rank 1, an unknown id, a malformed id, Supabase slow and Supabase down. That is a 6× margin
warm and 2.4× at the fresh-isolate median. The numbers include wrangler's local routing shim
(about 0.4 ms warm and 1.2 ms fresh: the cost of a static path in the same table), which
Cloudflare does not run in the Function's isolate. The caveat is the fresh-isolate tail on a
slower core (§3.3). It is no reason to simplify further: the Function's own code is a small
share of it.

### 3.2 Design

**A Pages "advanced mode" worker.** `pnpm build` (scripts/pages-config.ts) bundles
`src/lib/hosting/preview-worker.ts` with esbuild into `out/_worker.js` (13 KiB, 5 KiB gzip) and
writes `out/_routes.json` with `"include": ["/battles/*"]`: every other path is a static file
that invokes nothing. It is a `_worker.js` rather than a `functions/` directory for the same
reason as the sandbox shell's capture gate: its settings are inlined at build time, like the
bundles', so the Function, the bundles and the CSP always agree.

**Since T-043 a Worker module** (§2.7): the same bundle is `dist/worker.js`, outside `out/`
(never a static file), and `main` of `apps/web/wrangler.jsonc`, deployed as is (`no_bundle`);
`run_worker_first: ["/battles/*"]` takes the place of `_routes.json`. The code did not change:
a Pages `_worker.js` already is a Worker module with `env.ASSETS`.

- **Supabase:** the URL and the anon key are the build's `NEXT_PUBLIC_SUPABASE_URL` and
  `NEXT_PUBLIC_SUPABASE_ANON_KEY` (or `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`), inlined into the
  worker exactly as Next inlines them into the bundles (`lib/supabase/config.ts`; the build
  fails if the worker still reads `process.env`). The anon key is public by design and already
  in every bundle. **No Pages environment variable is involved:** nothing to set on Pages (or,
  since T-043, on the Worker) and no second copy of the settings to keep in sync. (Pages env vars would have needed the
  values in `wrangler.jsonc`, the project's source of truth once it has one, or in the
  dashboard, and could drift from the build.)
- **The site's origin** for `og:url` and the canonical link: `NEXT_PUBLIC_SITE_URL` (already
  the origin of `metadataBase`), else the request's own origin.
- **The headers:** the `/*` rule of `_headers` (the CSP and the rest), so the Function can set
  them itself (below).

**Per request** (`src/lib/hosting/preview-handler.ts`):

| Request | Supabase | Status | Head | `x-br-preview` |
|---|---|---|---|---|
| `/battles/{id}`, a public battle (RESULTS or DESTROYED) | `get_public_battle` | 200 | the battle's | `battle` |
| an unknown id, or a battle not public yet | `get_public_battle` (`battle_not_found`) | **404** | "Battle not found", `noindex` | `not-found` |
| a malformed id (not a UUID, or a broken escape) | **not called** | **404** | "Battle not found", `noindex` | `malformed` |
| Supabase does not answer within **1.5 s**, answers an error, or answers something without `get_public_battle`'s shape | called, given up | 200 | the shell's own (generic title, static card) | `fail-open; reason=timeout\|error\|shape` |
| anything that throws in the Function | — | what the static assets serve without it (the shell, 200) | the shell's own | — |
| `/battles`, `/battles/{id}/more`, a method other than GET/HEAD | — | Pages' own answer | — | — |

The shell (`/battles` from `env.ASSETS`) and `get_public_battle` (with the anon key over
PostgREST: `fetchPublicBattle`, the page's own call) are requested at the same time. A 404 is
still the shell's HTML, so in a browser the page loads its data and shows its not-found view
as before (e2e). HEAD gets the same status and headers without a body.

**The head** (`src/lib/hosting/battle-preview.ts`, from `battleMeta` and `battleOgImage`, the
same text as the tab title): `HTMLRewriter` removes the shell's `<title>`, `description`,
`robots`, `og:*`, `twitter:*` and canonical tags and appends the battle's to `<head>`:

- `<title>` and `og:title`/`twitter:title`: "{rank-1 build} by {builder}", or "{challenge} ·
  Battle results" when rank 1 was taken down;
- `description`, `og:description`, `twitter:description`: "Winner: {build} by {builder}." when
  there is a winner (rank 1, not removed), then "BUILD: … · RULE: … · STYLE: … · {time}";
- `og:image` (with `og:image:width`/`height`/`type`/`alt` when known) and `twitter:image`:
  T-033's rule, the rank-1 screenshot in Storage, or the static card when rank 1 has none or
  was taken down. **T-028:** a removed rank 1 is never named and its screenshot never shown,
  and the next build is not promoted (no "Winner:", no runner-up screenshot);
- `og:url` and `<link rel="canonical">`: `{origin}/battles/{id}`; `og:type` `article`,
  `og:site_name`, `twitter:card` `summary_large_image`.

**Escaping.** Build and player names are user data, challenge texts deck data. Every value is
HTML-escaped (`& < > " '`) into tags that the module writes itself; nothing from the data is
parsed as HTML. The unit tests round-trip `"><script>alert(1)</script>`,
`'><img src=x onerror=…>`, `</title><script>`, a fake `og:image` tag and already-escaped text
through an HTML parser (each value comes back exactly, no element is added; weakening the
escaping fails 4 of them), and the e2e inserts a real build named
`"><script>alert(1)</script>` by `Ana <b>&amp;</b>`.

**Headers and the CSP.** The injected tags are `<meta>`, `<title>` and `<link>`, not
scripts, and the shell's inline scripts are untouched, so the hash-based CSP (§2.4) is
unchanged. Cloudflare's docs say `_headers` does not apply to responses generated by a Pages
Function; whether it applies to a shell fetched through `env.ASSETS` is not documented. The
Function therefore sets the `/*` headers itself on every answer it writes (locally,
`wrangler pages dev` applies `_headers` either way; the e2e check the CSP, `X-Frame-Options`
and `nosniff` on the Function's 200s, 404s and fail-opens). It keeps the shell's
`Cache-Control` and drops its `ETag` (the body differs per battle and per moment). On Workers
(T-043) the static assets do apply `_headers` to the shell that `env.ASSETS.fetch` hands the
Worker (workers-shared source, measured; §2.7), and still not to an answer the Worker builds,
so the Worker keeps setting them: the same headers either way, and the e2e still check them
under `wrangler dev`.

**In the browser** the page hydrates as before and reads the battle itself. React then
re-adds the shell's generic `og:*` tags after the battle's (it matches head tags by
content); only crawlers read those tags, and they read the HTML as sent, where the battle's
tags are the only ones. React claims the injected `<title>`, so the tab title stays right.

### 3.3 CPU

**Method:** T-033's tool (§1.2), `pnpm --filter @br/web measure:cpu`, on `wrangler pages dev`
4.147.0 (workerd 1.20261001.1) with the local stack. It inserts two settled battles with 4
builds and a 1280×800 PNG screenshot of rank 1 (in one, rank 1 is then taken down), then
measures each case 40 times warm (20 profiled) and 20 times in a fresh isolate (workerd
restarted before each sample, 10 profiled). Supabase slow and down run on a variant of the
built site whose Function is bundled against a local stand-in that never answers or refuses
connections (`scripts/preview-variant.ts`). A sample whose `x-br-preview` is not its case's
is reported and left out (none of the 600 was). Run on 2026-10-09; per-scenario statistics:
[data/t038-cpu.csv](data/t038-cpu.csv).

| Request | Isolate CPU warm: median / p95 (n=20) | Fresh isolate: median / p95 / max (n=10) | workerd thread warm / fresh (median, unprofiled) | Wall, warm (median) |
|---|---|---|---|---|
| `/battles/{id}`: settled battle, rank-1 PNG screenshot | 1.5 / 2.4 | 4.2 / 7.3 / 8.8 | 5.9 / 16.1 | 13.7 |
| `/battles/{id}`: rank 1 taken down (static card) | 1.5 / 2.3 | 4.2 / 5.5 / 5.5 | 5.4 / 13.5 | 13.0 |
| `/battles/{unknown id}` (404) | 1.2 / 3.2 | 4.2 / 5.0 / 5.5 | 5.3 / 14.1 | 11.7 |
| `/battles/{malformed id}` (404, no Supabase call) | 1.3 / 2.0 | 3.2 / 4.7 / 5.2 | 4.4 / 13.7 | 10.6 |
| Supabase hangs (1.5 s timeout, fail open) | 1.7 / 2.6 | 4.2 / 5.2 / 5.2 | 7.5 / 15.9 | 1,511 |
| Supabase refuses connections (fail open) | 1.2 / 1.8 | 4.0 / 4.3 / 4.3 | 6.1 / 14.6 | 11.9 |
| *For comparison, no Function:* `/`, `/r/{code}`, a JS chunk, the 404 page | 0.3–0.5 / 0.9–1.1 | 1.1–1.3 / 1.3–1.7 / 1.4–1.9 | 3.5–4.3 / 11.9–13.7 | 9–11 |

All in ms. The last row is wrangler's local routing shim, which runs in the same isolate
(`_routes.json` matching, asset forwarding); in production a static path invokes no Worker,
and the Function's isolate does not run the shim. The workerd thread column is an upper bound
(it adds the local asset server and routing on the same thread, §1.2).

Where a fresh isolate's ~4.5 ms goes (5 saved profiles of the screenshot case,
`measure:cpu --profiles`): ~1.6 ms in the runtime itself (its first `fetch`, the
`HTMLRewriter` transform, `Headers`) and ~3 ms of JavaScript, of which ~1 ms is wrangler's
shim and the rest the first, lazily compiled run of the Function's ~15 small functions; no
function takes more than 0.2 ms of self time. Waiting for Supabase is not CPU (the slow case's
1.5 s costs the same as a fast answer). A malformed id, which skips the fetch and the JSON,
saves ~1 ms; so injecting only `og:image` and `og:title`, or any other trimming of the head,
would save a fraction of a millisecond. A minified bundle (8 KiB) measured the same (fresh
4.6, warm 2.1 ms median; n=8 and 5).

**Against the 10 ms limit.** Warm: at most 3.4 ms in any sample. Fresh isolate: median
3.2–4.2 ms, one sample of 60 at 8.8 ms. **The remaining uncertainty is Cloudflare's CPU
speed** (§1.2): this VM (Xeon @ 2.10 GHz) ran the calibration loops about 1.5× faster than
T-033's (loop 10⁶: 33.6 ms on the thread against 50.8 ms), so on a core as slow as T-033's VM
the fresh-isolate median would be ~6 ms and the tail could reach 10 ms; warm requests stay far
below either way. Fresh isolates are a minority of requests (§1.3, §1.5), the shim's ~1.2 ms
is not part of the production Function, and a request that went over would first draw on the
per-isolate rollover leeway (§1.3). After the first deploy, the Function's CPU time per
invocation in the Workers & Pages metrics settles it (apps/web/DEPLOY.md).

Method check of this run (calibrate.ts):

| Workload | workerd thread, unprofiled (median) | isolate CPU from the profile (median) | wall (median) |
|---|---|---|---|
| empty request | 2.7 ms | 0.2 ms | 7.3 ms |
| wait 300 ms on a fetch | 4.4 ms | 0.5 ms | 309.4 ms |
| loop 2·10⁵ | 8.2 ms | 6.4 ms | 12.3 ms |
| loop 10⁶ | 33.6 ms | 32.9 ms | 40.7 ms |
| loop 4·10⁶ | 124.7 ms | 135.9 ms | 139.0 ms |

### 3.4 Caching, and how long a preview can lag

**Decision: no cache.** The Function reads `get_public_battle` on every request and answers
with the shell's `Cache-Control: public, max-age=0, must-revalidate` and no `ETag`, so a
browser or crawler gets a fresh answer every time. Considered and rejected:

- **The Cache API for settled battles** (DESTROYED with `destroyed_at`): it would save the
  Supabase round trip (wall time: ~3 ms locally, 13.7 against 10.6 ms without the call, tens
  of ms to a hosted project; not CPU: waiting is free, and the cache lookup is itself a call
  into the runtime), but a takedown would then reach the preview only
  when the entry expires. Settled battles are exactly the ones takedowns are about (a report
  usually comes after RESULTS), and purging the entry from `/admin` would need a second moving
  part. The Cache API also only stores on a zone the account controls (a custom domain), not
  reliably on `*.pages.dev` or `*.workers.dev` (assumed, not testable here).
- **`Cache-Control` with a lifetime on the HTML:** browsers and Cloudflare's edge would serve
  a stale preview to the next visitor: the same takedown problem, and the page (which reads
  its own data) gains nothing.
- **The cost of not caching:** one ~1 KB (gzip) read of `get_public_battle` per view, next to
  the one the browser already makes: well inside Supabase Free (docs/07 §7). Each view of
  `/battles/*` is one Function request either way (a cache does not avoid the invocation).

**How long a preview can lag on our side: 0.** The request right after a takedown, or right
after a screenshot lands, gets the new head (moderation.spec.ts checks the static card and no
winner on the first request after the takedown). What can lag is outside our control: **the
networks' own preview caches** (Slack, Discord, X, Facebook and LinkedIn keep a URL's preview
from minutes to days; most have a refresh or debugger tool), and the screenshot file itself,
until the takedown job deletes it (seconds), plus up to 5 minutes in Storage's CDN
(docs/runbooks/removed-content-still-visible.md).

### 3.5 Limits and failure modes

- **Requests:** every view of `/battles/{id}` (people and crawlers) is one Worker request,
  counted in Workers Free's **100,000 a day**, shared with every Worker of account A (T-034
  ended up with no Worker: its jobs run as a Supabase Edge Function, §5; the sandbox shell's
  capture gate is on account B since T-043) and reset at 00:00 UTC. Static requests are not
  counted (`run_worker_first`; `_routes.json` on Pages). On Pages, past the allowance, Pages
  Functions **failed open by default** (the static shell, the page as in T-037). **On Workers
  (T-043) there is no such setting:** past the allowance Cloudflare answers `/battles/*` with
  its own 429 "temporarily rate limited" page until 00:00 UTC, while every static page keeps
  working (§2.7). At ~1,000 battles a month it is far away; deploy-check names that page.
- **CPU:** §3.3. Error 1102 would be the failure mode if a request exceeded the limit with no
  rollover left; no warm sample came within 6 ms of it.
- **Supabase slow:** a crawler waits up to 1.5 s more, then gets the generic preview (crawlers
  generally allow several seconds per page; assumed). The browser reads its data itself, as
  before. Each fail-open is logged (`battle preview: fail open (…)`, visible with
  `wrangler tail build-roulette-web` and account A's token).
- **Supabase down:** the generic preview at once (connection refused) or after 1.5 s.
- **Previews of `/u/{id}` and `/r/{code}`** stay generic (not in scope).
- **WebP screenshots** as `og:image` rely on the crawler accepting WebP (T-033's note); the
  image is fetched from Supabase Storage and counts against its egress.
- **Startup:** the worker's global scope only defines constants (13 KiB), far from the 1 s
  startup limit.

### 3.6 Verification

```sh
pnpm --filter @br/web test                 # battle-preview.test.ts (head, escaping, T-028), preview-handler.test.ts (every case)
pnpm --filter @br/web test:e2e             # static-site.spec: /battles/x is the Function's 404; other paths untouched
pnpm --filter @br/web test:e2e:moderation  # link-preview.spec (crawler view, 404s, Supabase slow and down) + the takedown
pnpm --filter @br/web test:e2e:solo        # og:image = the solo build's screenshot
pnpm --filter @br/web test:e2e:multi       # og:image = the winner's screenshot
pnpm --filter @br/web measure:cpu          # §3.3 (~15 min; --only/--warm/--cold to narrow it)
```

## 4. Package CDN (T-035): removed in M6

From T-035 to M5, production loaded every build's npm packages from the public **esm.sh**,
because our own `@br/pkg-cdn` would have needed Cloudflare Containers (paid only). The same
base URL was set in the web app (`NEXT_PUBLIC_PKG_CDN_URL`), the sandbox shell
(`BR_PKG_CDN_URL`) and the screenshot jobs (`PKG_CDN_URL`); the compatibility suite ran
against esm.sh in CI (52/57, then 56/58 after T-040's one-instance URLs).

**Import mode (M6, [09](09-import-mode.md)) removed it.** Players build with their own tools,
and a built site carries its own packages, so there is no bundler, no import map and no
package CDN of ours: nothing to deploy, configure or watch, and no third party on the
preview's critical path (docs/02 R10). A built site may still load scripts from public CDNs
itself (the site CSP allows `https:`); while such a CDN is down, only that site breaks, and
its capture falls back to the client thumbnail. The three settings are ignored; the deploy
deletes the leftover function secret and warns about the variable (`DEPLOY.md`).

## 5. Screenshots and jobs (T-034)

**Question:** the capture worker (`apps/capture-worker`: Playwright Chromium + sharp) is an
always-on Node process that claims capture, destroy and takedown jobs. No free host runs one.
What runs those jobs on free plans?

Sources are marked like §1: **confirmed** (Cloudflare's OpenAPI schema in the official
`cloudflare` npm SDK 7.3.0 of 2026-10-03; Supabase's and Cloudflare's docs as found by search on
2026-10-09, since this container cannot open either site), **measured** (here), or
**assumed**.

### 5.1 Verdict

**A Supabase Edge Function, started by pg_cron, rendering through Cloudflare Browser
Rendering's REST API.** No server, no Worker. Production uses it; the Node worker stays as the
self-hosted (paid) option against the same job contract (§5.6).

- The function `supabase/functions/jobs` processes all three kinds. Destroy and takedown are
  Storage API calls, and capture is one REST call per screenshot. Its code is
  `apps/capture-worker/src/edge`: the worker's capture, destroy and takedown jobs, unchanged,
  with a REST renderer and a WebP path without sharp. esbuild bundles it into
  `supabase/functions/jobs/core.js` (60 KiB, committed; a unit test fails when it is stale).
- A **Cloudflare cron Worker** with the browser binding was the alternative. It would face
  Workers Free's 10 ms CPU per invocation (§1), and a capture's own work (signing, JSON,
  base64, Storage calls) has no reason to fit that. Nothing in the REST design needed it.

### 5.2 Who calls what

```
pg_cron 'br-jobs-run' (every minute)
  └─ private.run_jobs_function()            only when a job is due; URL + cron secret from Vault
       └─ pg_net POST https://<ref>.supabase.co/functions/v1/jobs   x-br-cron-secret: …
            └─ the function: 202 at once, then in the background (EdgeRuntime.waitUntil):
                 claim_job round robin (capture, destroy, takedown) for ≤ 50 s
                 capture:  browser_budget_reserve ─► Browser Rendering POST /snapshot
                           (the signed capture URL; Cloudflare's browser opens the shell's
                           capture page, which loads the site pack from Storage and serves
                           it through the site worker) ─► WebP ─► screenshots/{battle}/{build}.webp
                           ─► complete_capture ─► browser_budget_settle
                 destroy / takedown: Storage list + delete ─► complete_destroy / complete_takedown
```

- **Secrets.** The function's: `JOBS_CRON_SECRET`, `CAPTURE_HMAC_SECRET` (the shell's capture
  gate secret), `BROWSER_RENDERING_ACCOUNT_ID`, `BROWSER_RENDERING_API_TOKEN`, plus
  `CAPTURE_SHELL_URL` (`supabase secrets set`; `PKG_CDN_URL` until M6; `SUPABASE_URL` and
  `SUPABASE_SERVICE_ROLE_KEY` come from Supabase). The database's: the function URL and the
  same cron secret, in **Vault** (`br_jobs_function_url`, `br_jobs_cron_secret`). Steps:
  `apps/web/DEPLOY.md` "Screenshots and jobs".
- **Why a cron secret in Vault, not the service key in SQL:** pg_cron has to send something
  that the public function URL checks. Vault keeps it encrypted at rest and out of the
  migration, `cron.job` and `cron.job_run_details`, which is Supabase's documented pattern.
  The cron secret is a narrow capability: it starts a run, and a run only processes jobs that
  are due anyway, so a leak costs invocations, never data. The service key would expose the
  whole database wherever SQL or request logs show it. The function compares the header in
  constant time; `verify_jwt = false` for this one function (`supabase/config.toml`). One
  place the secret does appear in clear: pg_net keeps each request, header included, in
  `net.http_request_queue` until its background worker sends it (about a second). Supabase's
  pg_net grants that table to every role, but the Data API exposes only `public` and
  `graphql_public`, so players cannot read it (measured locally: the grants, and the
  `config.toml` schemas).
- **Wall time.** New jobs are claimed for 50 s (`JOBS_RUN_WINDOW_MS`), so runs rarely overlap
  the next minute's. When they do, `claim_job`'s SKIP LOCKED keeps them apart and the budget
  is atomic. A capture job ends within 72 s (35 s REST timeout, pacing, one short 429 wait,
  Storage), inside its 2-minute lease. At 140 s (`JOBS_RUN_HARD_STOP_MS`), under the free
  plan's 150 s, jobs still in flight are aborted and handed back with `fail_job`. If the
  platform kills the run first (wall clock, the 2 s CPU limit, a deploy), the lease expires
  and the next run claims the job again. The integration test kills the runtime mid-capture
  to show it.

### 5.3 The capture over REST

One `POST /accounts/{id}/browser-rendering/snapshot?cacheTTL=0` (confirmed: the endpoint
and every field below are in Cloudflare's schema):

| Field | Value | Why |
|---|---|---|
| `viewport` | 1280×800, `deviceScaleFactor` 1 | capture mode (docs/03 §3.7) |
| `gotoOptions` | `waitUntil: 'load'`, 10 s | the capture page itself; the build loads after |
| `waitForSelector` | `html[data-br-capture]`, **6 s** | the build's ready signal (or a page failure); the timeout **is the 6 s cap** |
| `bestAttempt` | `true` | the cap passing is not an error: shoot anyway ("proceed when awaited events fail or time out") |
| `actionTimeout` | 10 s | a frozen page cannot hold the screenshot forever |
| `screenshotOptions` | `type: 'webp'`, `quality: 70` | the worker's quality (82 until T-036, §6.3); nothing to encode, so no sharp |

**Why `/snapshot`, not `/screenshot`:** it takes the same options and returns the
screenshot **and the capture page's HTML from the same browser session**. The function
cannot decode WebP (no sharp in Deno), so it cannot look at pixels for the worker's blank
check. Instead the capture page reports on its `<html>` element: `data-br-capture-page`
(served by the gate, not a 403), `data-br-capture` (`ready` / `failed`, with
`data-br-capture-error`), and `data-br-paint` (`content` / `empty`: does anything in the build's
frame paint? `apps/sandbox-shell/src/paint.ts`). An `empty` frame (the build threw before
rendering) or a failed page falls back to the client thumbnail, as the worker does. The
attributes are untrusted, but a build can only change its own screenshot with them.

**What the size can't tell (measured):** Chromium's WebP at quality 82 is 2,364 bytes for a
blank 1280×800 page and 2,512 bytes for a full-page gradient (max channel std dev 14.7, not
blank), so the size cannot replace the pixel check.

**The client thumbnail without sharp:** the worker decodes and re-encodes it. The function
rebuilds its container instead (`src/webp.ts`): one still image, lossy or lossless, keeping
alpha. It drops EXIF, XMP, ICC and unknown chunks and refuses animations and images larger
than 1280×800 (thumbnails are 640×400). A broken bitstream fails to decode like any corrupt
image.

**Differences from the Playwright renderer (accepted):**

- **No "network idle + 2 s" rule:** the REST API can't express "first of". A site that
  calls `buildRoulette.ready()` after its first paint is shot at once (the editor's starter
  templates did, before M6); a site that never calls it waits the full 6 s cap.
- **No navigation guard:** the capture page's CSP sandbox still blocks popups, modals and
  downloads. A build that navigates its own page gets a shot of what it navigated to, which it
  could have painted itself.
- **Blank check by DOM, not pixels:** see above. White-on-white or a blank canvas counts as
  content.

### 5.4 The daily budget

Workers Free includes **10 browser-minutes a day** (confirmed, Cloudflare's limits page as
found by search; the docs also call the REST endpoints "Quick Actions" and the product
"Browser Run"). The function stops at **9.5 min** (`BROWSER_BUDGET_MS_PER_DAY` = 570,000):

- `private.browser_budget` keeps one row per **UTC day**: used, reserved, renders, refusals,
  429s.
- Before a render, `browser_budget_reserve(20000, 570000)` is granted only while used +
  reserved + 20 s ≤ 9.5 min. Afterwards `browser_budget_settle` releases the 20 s and adds
  what the render was billed.
- **Billed time:** the `X-Browser-Ms-Used` response header when present (reported by
  Cloudflare since 2025-08 per third-party guides; **not in the API schema, so assumed**).
  Otherwise the call's wall time, which is at least the browser time.
- A reservation not settled within 2 minutes (the run died) counts as used.
- **Spent:** captures fall back to the client thumbnail at once (`capture_status = fallback`;
  without a thumbnail the job retries with backoff and fails on the 5th attempt, as before).
  Everything else is unchanged: destroys and takedowns need no browser, and the capture
  deadline (10 min) and the destroy gate apply as before.

**Rate limits:** REST requests on Workers Free are limited to **6 a minute, enforced as one
every 10 s** (confirmed, same source). The function spaces its calls 10 s apart
(`BROWSER_RENDERING_MIN_INTERVAL_MS`). A 429 with `Retry-After` ≤ 12 s is waited out once in
place. Otherwise the job is handed back (`fail_job`, 10 s then 20 s backoff) and falls back to
the thumbnail on its 3rd attempt (`SERVICE_FALLBACK_ATTEMPT`), so an outage costs about 2–3
minutes, well inside the capture deadline. The same holds for 5xx answers, network errors, no
answer, and a refused token (logged as an error). Other free limits (3 concurrent browsers,
60 s per browser): one capture at a time per run, at most ~35 s.

**Budget math.**

- Browser time per capture, **measured** with the local stand-in (local Chromium, no
  network): **0.9 s** for a React build that calls `ready()` in a warm browser (the solo
  e2e), **3.1 s** for the same kind of build when the capture also starts the browser (the
  first capture of `test:function`; Cloudflare starts a browser for every REST call), and
  **6.5–6.6 s** for one that never paints (the 6 s cap; the solo CDN-outage e2e and
  `test:function`).
- **Assumed** for Cloudflare: about **3 s** with the ready signal (browser start + page + React
  from esm.sh + shot; M5) and about **8–9 s** without it (the 6 s cap). Since M6 the page also
  registers the site worker and the site loads its own code from the pack; to be re-measured.
  Browser Rendering must run Service Workers for it at all (docs/02 R11). Check `used_ms / renders`
  in `private.browser_budget` after the first days (runbook below).

| Seconds per capture | Captures a day (570 s) | Solo battles a day | 4-player battles | 8-player battles |
|---|---|---|---|---|
| 3 (assumed, ready signal) | 190 | 190 | 47 | 23 |
| 5 | 114 | 114 | 28 | 14 |
| 9 (no ready signal: 6 s cap) | 63 | 63 | 15 | 7 |

Beyond that, every screenshot of the day is the client thumbnail (640×400, from the player's
own preview). Battles still finish on time. The pacing (one call per 10 s) caps a burst at
about 5 captures a minute, so an 8-player battle's screenshots take about 2 minutes, inside
the 10-minute capture deadline (RESULTS waits for them as before).

**Supabase Free** (confirmed by search: 500,000 Edge Function invocations a month, 2 s CPU per
request, 150 s wall clock, 256 MB): pg_cron calls the function only in minutes with a due job,
so at most 43,200 invocations a month (8.6%). A run's CPU is JSON, base64 and HMAC over
kilobytes. The local Edge Runtime enforces the same 2 s CPU limit, and every integration run
stayed under it (not measured in production).

### 5.5 Local and test path

`apps/capture-worker/src/stand-in.ts` is a stand-in for the REST API. It implements the
`/snapshot` subset above on Playwright Chromium (`PlaywrightRenderer.session()`, with no
navigation guard, like the real service). Each step works as in Puppeteer (goto, wait for
the selector, `bestAttempt`, the CDP WebP screenshot, the page's HTML), and it refuses any
other field. `BROWSER_RENDERING_API_URL` points the function at it. Test controls inject
429s, 5xx and hangs; `minIntervalMs` emulates the free plan's fill rate. Its page-side error
statuses and `X-Browser-Ms-Used` (wall time here) are guesses where Cloudflare documents
nothing.

- **The e2e suites** (solo, moderation, rooms, chaos, telemetry) now run the production path:
  `apps/web/scripts/solo-services.ts` serves the function (`supabase functions serve`), starts
  the stand-in, puts the function URL (`http://kong:8000/…`) and a fresh cron secret in Vault,
  and schedules `e2e-jobs-run` every 2 s next to the production `br-jobs-run`. All of that is
  undone on stop. `--worker` (or `BR_JOBS=worker`) runs the Node worker instead.
- **Integration** (`pnpm --filter @br/capture-worker test:function`): function → stand-in →
  shell capture page → Storage, with 11 tests (§5.7).
- The stack must run **with the Edge Runtime**: drop `edge-runtime` from `supabase start -x`.

### 5.6 Which one production uses, and how to switch

- **Production (free plan): the function.** After `supabase db push`, `supabase functions
  deploy jobs` and the secrets (DEPLOY.md), pg_cron starts it every minute.
- **The self-hosted worker** (`apps/capture-worker`, a paid or own host): run it with its
  `.env` (README). To switch, stop the trigger with
  `select cron.unschedule('br-jobs-run');` (or delete the Vault secret
  `br_jobs_cron_secret`); to switch back,
  `select cron.schedule('br-jobs-run', '* * * * *', 'select private.run_jobs_function()');`.
  Both can also run at once: `claim_job` never hands a job to two of them. The worker renders
  with its own Chromium, so it ignores the daily budget.

### 5.7 Verification

```sh
pnpm --filter @br/capture-worker test             # unit: webp, browser-rendering, capture-function, budget, edge, function-bundle, stand-in
pnpm --filter @br/sandbox-shell test              # paint.test: the capture page's paint check
supabase db reset && supabase test db             # 26_jobs_function: budget, trigger, grants (+ 04, 09)
pnpm --filter @br/capture-worker test:function    # the function in the local Edge Runtime: 11 tests
pnpm --filter @br/web test:e2e:solo               # and :moderation, :multi: with the function in place of the worker
pnpm --filter @br/capture-worker test:integration # the self-hosted worker, unchanged
```

## 6. Supabase Free (T-036)

**Question:** what does Supabase's Free plan allow this game, what happens at each limit, and
what keeps the project running unattended: the 7-day pause, 1 GB of file storage, a 500 MB
database, and the monthly quotas?

Sources are marked like §1 and §5: **confirmed** (Supabase's docs, read through a search tool
on 2026-10-10, since this container cannot open supabase.com), **secondary** (several
third-party summaries of the pricing page agree; the page itself was not readable here),
**measured** (here, with the command that reproduces it), or **assumed**.

### 6.1 Verdict

Supabase Free runs the game, with one daily keep-alive and one watch item:

- **The pause** is handled by a scheduled GitHub Actions workflow that calls the database
  through the Data API once a day and fails loudly when the project is paused, restricted or
  read-only (§6.2).
- **File storage is the first hard wall over time.** Screenshots are permanent, so storage
  only grows: 1 GB holds about **2,750 battles** (6 players) at WebP quality 70, the quality
  this task moved to from 82 (2,180 battles at 82; §6.3). At 1,000 battles a month that is
  under three months. Nothing is deleted on a timer; `/admin` → Health warns at 80 %.
- **Per month, egress comes first** (about 1,060–1,210 battles with the measured screenshot
  sizes, 926 with docs/07's 100 KB assumption; measured with M5's small bundles: M6's site
  packs make REVEAL's downloads larger, so this is to be re-measured, §6.5), about level with Browser Rendering's free
  screenshots (~1,000 battles; past it the client thumbnail, nothing breaks) and before
  Realtime's 2 M messages (~1,340 battles). The database lasts about 10,000 battles (§6.4).
- **Concurrency:** Realtime's 20 Presence messages per second hold about 10 concurrent
  6-player rooms in BUILD (5–6 of 8 players); 10 were measured clean on the Free quotas (§6.5).

docs/07 §7.8 has the per-resource table and what to upgrade first, and when.

### 6.2 The 7-day pause and the keep-alive

What Supabase says (confirmed, "Project pausing" docs): a Free project is paused when it "does
not receive sufficient user database activity over the past week"; "typically a few user
requests to the database each day" are enough. The owner gets an email about a week before. A
paused project answers every request with **HTTP 540** ("Project paused", Supabase's HTTP
status codes page) and is restored from the dashboard (Restore project; the docs found say a
restore is possible for 90 days to a year after the pause). Paid projects are never paused.

**Is our own traffic enough? No, as far as can be told:**

| Traffic | Counts as "user database activity"? |
|---|---|
| pg_cron: `sweep_deadlines` every 5 s, `br-jobs-run` every minute, the daily sweeps | **assumed not**: it runs inside Postgres (no request from a user), and once the project is paused there is no Postgres left to run it. The docs speak of user requests; no source says background jobs count. |
| pg_net → the `jobs` Edge Function → PostgREST/Storage with the service key | **assumed not**, and it stops anyway: `run_jobs_function()` calls the function only when a job is due, and jobs only come from players. A quiet week sends nothing. |
| Players and link-preview crawlers (the anon key through the Data API) | yes, but a party game can have a quiet week |

One third-party answer (a GitHub discussion) claims that a connection alone does not count but
a write does; that is not confirmed either. So the keep-alive writes, through the Data API,
with the same key a player's browser uses.

**The keep-alive** (`.github/workflows/keep-alive.yml` → `scripts/keep-alive.sh`):

- **Daily at 04:23 UTC**, off the hour (GitHub delays runs at :00 under load; its schedule
  itself adds minutes of jitter), plus a random 0–39 s sleep that stays inside the minute
  GitHub bills anyway. Daily leaves six more tries before the 7-day limit. It can also be run
  by hand (`workflow_dispatch`).
- **One request:** `POST /rest/v1/rpc/keep_alive` with the anon (or publishable) key.
  `public.keep_alive()` (migration `20261010120000_free_plan.sql`, the only new anon
  function) updates one row of `private.keep_alive` (at most once a minute, whoever calls) and
  answers `{ok, read_only, at}`. It reads and writes the database and goes through the API
  gateway, PostgREST and Postgres: everything "user activity" could mean.
- **Settings, never in the file:** the repository variable `SUPABASE_URL` and the secret
  `SUPABASE_ANON_KEY` (public by design, but masked in logs as a secret). With neither set
  the run passes with a notice (a fork, or before the deploy), with one of them it fails.
- **Fails loudly** (a red run; GitHub emails the person who last changed the schedule) on:
  540 "PAUSED: restore it", 402 "RESTRICTED: over the Free quotas", 200 with
  `read_only: true` "READ-ONLY: over 500 MB", 401/403 wrong key, 404 wrong URL or migrations
  missing, no answer after 3 tries, and anything that is not `keep_alive`'s answer. Each
  error names `docs/runbooks/free-plan-quotas.md`. Tested against a local stand-in for every
  case (`scripts/keep-alive.test.mjs`) and against the real local stack in the moderation
  e2e.
- **Health sees it:** `/admin` → Health → Plan usage shows the last ping; no ping for 36 h is
  a finding (`keep_alive_max_age_s`), so a keep-alive that stopped is noticed days before the
  pause.
- **Cost:** one job of a few seconds a day: 1 billed minute on a private repository, about
  31 of the 2,000 free minutes a month (GitHub Free); nothing on a public one.

**What could still stop it** (DEPLOY.md §5 says what to do):

1. *A private repository out of Actions minutes.* Then no workflow runs, the keep-alive
   included. **The CI workflow is the risk**: it runs on every push and nightly, nine jobs
   (three chaos shards), roughly 80–100 runner minutes a run (estimated from the jobs'
   timeouts and typical lengths, not measured here), so the nightly run alone would use
   about 2,400–3,000 minutes a month. On a private repository on GitHub Free, turn the nightly
   CI schedule off or make the repository public.
2. *A public repository without commits for 60 days*: GitHub disables its scheduled workflows
   (confirmed, GitHub docs). The workflow re-enables itself through the API on each scheduled
   run, which third-party keep-alive tools say resets that clock (**assumed**; GitHub does not
   document it). If it is disabled anyway, Supabase's warning email a week before the pause is
   the backstop.
3. *A rotated anon key* not copied into the repository secret: the run fails with "Key
   refused".

### 6.3 Storage: screenshots

**What is stored.** Per final build, one permanent screenshot in the public `screenshots`
bucket: the Browser Rendering capture (1280×800 WebP), or the client thumbnail (640×400 WebP)
when the daily browser budget is spent or the render was blank. The build files in
`ephemeral-builds` are deleted at DESTROY, minutes after RESULTS, 24 h at the latest. Since
M6 they are, per player, one site pack per import (`autosave/site.bin`, overwritten), the
shipped `site.bin` and `thumb.webp`: at most 2 × 5 MB plus the thumbnail while a battle runs
(M5's editor files were 581 KiB per 6-player battle, docs/07 §7.3; M6's are to be
re-measured). They count against the 1 GB only for minutes.

**Measured screenshot sizes** (`pnpm --filter @br/capture-worker measure:screenshots`, data in
[data/t036-screenshot-sizes.csv](data/t036-screenshot-sizes.csv)). The e2e's own test builds
are tiny (5–10 KB, docs/07 §7.3) and say nothing about real apps, so the script renders 18
sample apps in `apps/capture-worker/scripts/screenshot-corpus/` (the react-ts starter and 17
BUILD × STYLE cards of the deck, from "Zen minimal" to film grain, halftone dots and a tiled
1998 homepage), each at the capture viewport in Playwright Chromium, and takes the screenshot
the way Browser Rendering does: CDP `Page.captureScreenshot` with `format: 'webp'`, which is
Chromium's own encoder behind Puppeteer's `screenshotOptions` (smaller sizes through
`clip.scale`, which Browser Rendering's schema also has). SSIM and PSNR are against a lossless
PNG of the same frame (the encoding loss only):

| Stored as | Size | Median | Mean | p90 | Max | 18 apps | SSIM mean / min |
|---|---|---|---|---|---|---|---|
| PNG (reference) | 1280×800 | 115.2 KiB | 219.1 KiB | 456.6 KiB | 1,258.5 KiB | 3.9 MiB | 1 |
| **WebP q82 (before T-036)** | 1280×800 | 25.5 KiB | **77.0 KiB** | 205.8 KiB | 403.0 KiB | 1,385.8 KiB | 0.9926 / 0.9475 |
| WebP q75 | 1280×800 | 20.8 KiB | 63.7 KiB | 167.2 KiB | 336.8 KiB | 1,146.4 KiB | 0.9906 / 0.9401 |
| **WebP q70 (T-036)** | 1280×800 | 19.8 KiB | **60.9 KiB** | 158.4 KiB | 325.6 KiB | 1,095.8 KiB | 0.9897 / 0.9386 |
| WebP q60 | 1280×800 | 18.2 KiB | 55.6 KiB | 141.9 KiB | 298.8 KiB | 999.9 KiB | 0.9886 / 0.9359 |
| WebP q50 | 1280×800 | 16.7 KiB | 50.7 KiB | 127.8 KiB | 272.6 KiB | 911.9 KiB | 0.9865 / 0.9272 |
| WebP q82, `clip.scale` 0.75 | 960×600 | 17.9 KiB | 51.4 KiB | 141.8 KiB | 235.3 KiB | 925.5 KiB | 0.9927 / 0.9518 |
| WebP q70, `clip.scale` 0.75 | 960×600 | 13.7 KiB | 40.3 KiB | 108.5 KiB | 185.8 KiB | 725.3 KiB | 0.9873 / 0.9163 |
| ≈ the client thumbnail (q80) | 640×400 | 10.3 KiB | 24.1 KiB | 69.4 KiB | 95.9 KiB | 434.2 KiB | 0.9871 / 0.8944 |

The distribution is skewed: flat UIs take 7–35 KiB, text-dense pages 85–170 KiB, and noise,
halftone or tiled backgrounds 180–400 KiB (they dominate the mean). WebP loses to PNG only on
flat repeating patterns. Deterministic up to the Chromium build and the fonts (the pages seed
their randomness).

**The lever: quality 82 → 70** (`SCREENSHOT_WEBP_QUALITY`, used by the REST request and by
the self-hosted worker's sharp encoding; `core.js` rebuilt). It stores 21 % less (mean
77.0 → 60.9 KiB, median 25.5 → 19.8 KiB), and in side-by-side crops at 2× zoom (text, neon
gradients, film grain) no difference is visible; at 60 and below, gradients start to show
blocks. **Not taken:** 960×600 (`clip.scale` 0.75) would save another third, but text is
visibly softer when the screenshot is shown 1,200 device pixels wide (the results page on a
high-density screen) and for link previews; it is the next lever if storage gets tight
(runbook). The thumbnail fallback is untouched.

**Per battle and in 1 GB** (6 players, 5.7 final builds per battle, docs/07 §7.4.2; 1 GB taken
as 10⁹ bytes, the smaller reading; 20 MB kept free for the build files of running battles):

| Screenshots | Permanent per battle | Battles in 1 GB | At 1,000 battles a month |
|---|---|---|---|
| WebP q82 (before) | 439 KiB | ~2,180 | 2.2 months |
| **WebP q70 (now)** | **347 KiB** | **~2,760** | **2.8 months** |
| WebP q70 at 960×600 (not taken) | 230 KiB | ~4,170 | 4.2 months |
| client thumbnails only | 137 KiB | ~6,970 | 7 months |

The ephemeral build files need no room of their own beyond the reserve: a running battle holds
about 0.6 MB until DESTROY, so 20 MB covers ~30 battles at once or a day of failed deletes. Up
to ~1,000 battles a month every screenshot is a capture (Browser Rendering's 10 free minutes a
day, §5.4); beyond that the rest are thumbnails, which also slows the growth.

**What 1 GB means:** the screenshots of the first ~2,750 battles. Results are permanent and
nothing deletes them on a timer (a takedown deletes one); Health's storage meter warns at 80 %
(about 2,250 battles), and the runbook's options are the upgrade (Pro: 100 GB, docs/07 §7.8),
the 960×600 setting, or moving the bucket to Cloudflare R2 (10 GB free and no egress fees;
a code change: signing, CSP, previews and takedowns).

### 6.4 Database: 500 MB

Over 500 MB a Free database turns **read-only** (confirmed, "Database size" docs: "Free Plan
projects enter read-only mode when your database size exceeds 500 MB"; writes fail with
`cannot execute INSERT in a read-only transaction`, and it turns read-write again below the
limit). The size Supabase counts is `sum(pg_database_size(…))` over every database of the
cluster (confirmed, the same docs' query); a new project starts at 40–60 MB.

**Measured** on the local stack (Postgres 17, `supabase db reset`, then the load test on the
Free Realtime quotas: 6 rooms × 6 players × 2 battles, then 10 × 6 × 3; per-table numbers in
[data/t036-db-growth.csv](data/t036-db-growth.csv): rows per battle from the second run, bytes
per row from each table's size after both, so first-page overhead is spread over 42 battles):

- **Baseline:** 44.7 MB for every database of a fresh stack (13.8 MB of it `postgres`).
- **Whole database over the 30 battles of the second run:** 97 KB per battle, transient tables
  included: `realtime.messages` 33 KB (daily partitions that Realtime drops after a few days;
  assumed), `storage.objects` 23 KB (mostly the 48 build-file rows per battle that are inserted
  and deleted: dead rows until vacuum reuses the space), rate-limit events 6 KB (pruned hourly).
- **What stays, per 6-player battle:**

| Data | Per battle | Kept |
|---|---|---|
| Results: battle, challenge, roster, builds, votes, awards | ~23 KB (battles 2.7, challenges 1.8, roster 2.1, builds 6.8, votes 7.0, awards 3.0) | forever |
| Screenshot rows in `storage.objects` | ~5.6 KB (5.6 rows; ~1 KB each with indexes, assumed) | forever |
| Players: profile and Supabase Auth rows (users, identities, sessions, refresh tokens, audit log) | ~13 KB (2 new players per battle at 3 battles per player) | forever (Auth's own) |
| **Event logs:** `battle_events` 28.6 rows | **9.3 KB** | **30 days since T-036** (was forever) |
| **Finished jobs** (capture, destroy) 6.6 rows | **3.9 KB** | **7 days since T-036** (was forever) |
| `room_events` 18.9 rows | 6.0 KB | with the room (7 days after it closes); 30 days since T-036 |

So ~55 KB per battle stayed forever before T-036, of which the event logs and finished jobs
were 13 KB (24 %; `battle_events` is the largest single table per battle); with the sweep
~42 KB stay.

**The sweep** (`private.prune_event_logs()`, pg_cron `br-event-logs-prune` daily at 04:41
UTC): `battle_events` older than `event_log_retention_days` (30) **of battles that are over**,
`room_events` older than 30 days, and finished capture and destroy jobs older than
`job_retention_days` (7), in batches of 5,000. It never touches results, ballots, awards or
screenshots, nor takedown jobs (a failed one is what `/admin` retries). The only visible
effect: `/admin`'s battle log of a battle older than 30 days is empty (its results are not).
pgTAP (`27_free_plan`) checks that `get_public_battle`, `get_player_history` and every
permanent row and file of a pruned battle are unchanged; a variant that also deletes old
ballots fails it. The settings are in `private.ops_settings` (runbook).

**Capacity:** 500 MB − 60 MB for a new project (the docs' upper figure) − ~15 MB of
transient data (two days of pg_cron history, ~9 MB at 17,000 sweep runs a day; Realtime's
recent partitions; rooms) ≈ 425 MB → **~10,000 battles** with the sweep (~7,700 without):
about ten months at 1,000 battles a month. Health warns at 80 % (400 MB).

Not changed (Supabase's own): Auth's tables (users, sessions, the audit log) and anonymous
users that never come back; they are ~13 KB per two players. Removing old anonymous users
would remove their names from results, so it is not done.

### 6.5 Realtime, egress, functions and MAU per month

docs/07's measured per-battle numbers (§7.4.4, 6 players, 10-minute build, after T-029):
**1,490 Realtime messages** and **5.4 MB of egress**, with screenshots assumed at 100 KB and
viewed 34 times per battle (§7.3), i.e. ~3.4 MB of the 5.4 MB. With the measured sizes the
screenshot views cost 2.1 MB at q70 (60.9 KiB) and 2.7 MB at q82: **4.1 MB** per battle now
(4.7 MB at q82). **M6:** REVEAL downloads one site pack per build (each viewer, each final
build, ≤ 5 MB) instead of M5's small bundles (1.6 MB of reveal files per 6-player battle,
docs/07 §7.3), and a pack carries its own packages, so the reveal part of egress grows and
the battles a month fall. To be re-measured with the M6 load generator before relying on the
egress row.

| Free quota | Status | Per battle | Battles a month | Note |
|---|---|---|---|---|
| Egress 5 GB (uncached) | secondary | 4.1 MB (q70; 5.4 MB with docs/07's 100 KB); M5 bundles, to be re-measured for site packs | **~1,210** (926), before M6 | each extra view of a results page adds ~0.35 MB; Storage CDN hits may count as the separate 5 GB of cached egress (assumed, not counted) |
| Browser Rendering 10 min/day (Cloudflare) | confirmed (§5.4) | 5.7 captures × ~3 s (assumed) | ~1,000 rendered | then client thumbnails: soft |
| Realtime messages 2 M | secondary | 1,490 | **~1,340** | |
| Realtime Presence 20 messages/s | confirmed | 1.7–2.1/s per 6-player room in BUILD | ~10 rooms in BUILD at once ≈ 11,000 a month at a peak factor of 4 | measured: 10 rooms × 6 players on the Free quotas, 0 channels closed (below) |
| Realtime connections 200 | confirmed | 6 (one socket per player) | 33 battles at once ≈ 18,900 a month at a peak factor of 4 | |
| Realtime messages/s 100, joins/s 100 | confirmed | | not reached | the compressed run peaked at 144 inbound/s across 60 clients, no closes |
| Edge Function invocations 500,000 | secondary | 2–4 runs | never | pg_cron starts the `jobs` function at most once a minute: ≤ 43,200 a month |
| MAU 50,000 | secondary | 2 new players | ~25,000 | 3 battles per player a month (docs/07 §7.4.2); anonymous sign-ins count |
| Workers Free 100,000 Worker requests/day (Cloudflare; Pages Functions before T-043) | confirmed (§3.5) | one per results-page view | not reached | since T-043: Cloudflare's 429 page on `/battles/*` until 00:00 UTC (§2.7) |

**Load test on the Free Realtime quotas (measured, 2026-10-10):** `pnpm --filter @br/loadtest
loadtest --realtime-limits free` (200 connections, 100 messages/s, 20 Presence messages/s,
100 joins/s set on the local tenant) with 6 rooms × 6 players × 2 battles and 10 rooms × 6 ×
3 (`BR_JOBS=worker`, see below): 42/42 battles DESTROYED, phase propagation p95 19–23 ms,
100 % of broadcasts delivered, **0 channels closed by Realtime**, Presence sends throttled to
1.75 per client-minute. Phases are compressed ~10× (docs/07 §7.1.3), Presence is not
(the client throttle is per wall-clock minute), so the Presence load per room in BUILD is the
real one. The load generator still needs `BR_JOBS=worker`: since T-034 its capture services
wait for the Node worker's start line, which the function never prints.

**Which limit bites first:** per month, egress (~1,210 battles), with Browser Rendering's free
captures at ~1,000 (soft: thumbnails) and Realtime messages at ~1,340; over time, file storage
(~2,750 battles in total); at a peak, Presence (~10 busy 6-player rooms). What happens past a
monthly quota on Free (secondary): an email, a grace period, then restrictions (HTTP 402 on
the API). The runbook is [free-plan-quotas.md](runbooks/free-plan-quotas.md); Realtime's is
[realtime-quota.md](runbooks/realtime-quota.md).

### 6.6 What `/admin` → Health shows

`admin_ops_health()` has a `usage` section (`private.ops_usage()`; T-030's signals moved
unchanged to `private.ops_health_signals`), shown as **Plan usage (Supabase)**:

- **File storage:** the sum of `storage.objects.metadata.size` (what Supabase bills) per bucket
  and in total, against `storage_limit_bytes` (10⁹).
- **Database:** `sum(pg_database_size)` over the cluster against `database_limit_bytes`
  (5·10⁸), and the five largest relations (partitions folded into their table).
- **Monthly active users (at least):** users who signed in this calendar month against
  `mau_limit` (50,000). A lower bound: Supabase also counts token refreshes.
- **Keep-alive:** the last ping.
- **Retention:** the event-log settings and the oldest event kept.

A meter at `usage_warn_pct` (80) or more, and a keep-alive older than 36 h, are findings that
name the runbook. Egress, Realtime messages and function invocations are not readable from
SQL: they are on Supabase's Usage page. The limits live in one row, `private.ops_settings`; after an
upgrade, set them to the new plan's (runbook).

### 6.7 Verification

```sh
supabase db reset && supabase test db             # 27_free_plan: keep_alive, usage, the sweep keeps every result (+ 04, 09)
pnpm test:scripts                                 # keep-alive.sh against a stand-in; deploy-check.mjs parsing and checks
pnpm --filter @br/web test                        # health.test: the usage findings
pnpm --filter @br/web test:e2e:moderation         # Health → Plan usage, the 80 % warning, the keep-alive script against the stack
pnpm --filter @br/capture-worker measure:screenshots --csv out.csv --compare dir/   # §6.3
BR_JOBS=worker pnpm --filter @br/loadtest loadtest --rooms 10 --players 6 --battles-per-room 3 --realtime-limits free   # §6.4, §6.5
```
