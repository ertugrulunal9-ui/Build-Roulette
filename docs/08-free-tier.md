# 8. Free tier

The user decided on 2026-10-09 to deploy on free plans only (docs/BOARD.md, T-033…T-036).
This document collects what that takes. §1 is the web app on Workers Free (T-033); the
other free-tier tasks add their own sections.

## 1. Web app on Workers Free (T-033)

**Question:** can `@br/web` (Next.js 16 through OpenNext on Cloudflare Workers) run on
**Workers Free**, whose limits are 10 ms of CPU per HTTP request, a 1 s startup, 100,000
requests a day and (as briefed) 3 MB of compressed Worker?

Every number below is marked **measured** (this machine, 2026-10-09, with the command that
reproduces it) or comes from a source that is marked **confirmed** (Cloudflare docs or the
workerd source) or **assumed**.

### 1.1 Verdict

__VERDICT__

### 1.2 Method

**Setup (measured locally, no Cloudflare account).** The OpenNext build (`cf:build`) served
by `wrangler dev` 4.147.0, i.e. workerd 1.20261001.1, the runtime Cloudflare runs, with R2,
D1 and the Durable Object queue emulated, like `cf:preview`. The local Supabase stack holds
the data. The machine is a 4-vCPU VM (Intel Xeon @ 2.80 GHz). The script:

```sh
pnpm --filter @br/web cf:build
npx -y supabase@2.119.0 start -x studio,imgproxy,vector,logflare,edge-runtime,supavisor,mailpit
pnpm --filter @br/web measure:cpu            # ~70 min; --warm/--cold/--only to narrow it
```

(`apps/web/scripts/measure-cpu/`.) It inserts its own data (finished battles with 4 or 8
builds and a 1280×800 PNG screenshot, a player with 10 battles, open reports, an admin),
then measures every route class:

- **warm:** one unmeasured request of the same kind first, then 30 samples (15 profiled,
  15 not) in the same isolate;
- **cold:** workerd is restarted before every sample (6 per scenario, 3 profiled): a fresh
  isolate whose global scope already ran at startup, as on Cloudflare, and then the first
  request. On a cold isolate OpenNext initialises the Next server inside that first
  request (§1.3).

Each request is measured until the runtime is quiet again, so work after the response
(`waitUntil`/`after()`, the ISR cache write, a background regeneration) counts too; on
Workers it belongs to the same invocation.

**Two numbers per request:**

1. **Isolate CPU (the headline number).** A V8 CPU profile of the app's isolate, taken
   through the DevTools protocol (`Profiler.start`/`stop` around the request, via wrangler's
   inspector proxy) with a 100 µs sampling interval (about 200 µs effective). V8 records a
   sample only while the isolate is entered, so time spent waiting on Supabase, R2 or D1,
   and time spent in the other isolates of the local runtime (the emulated R2/D1/Durable
   Object, the asset router) leave no samples. Each non-idle sample is credited with the
   gap before it, capped at twice the effective interval (a longer gap is time the isolate
   did not run). JavaScript, garbage collection, compilation and native calls made from
   JavaScript are counted: that is what Cloudflare's per-request CPU covers.
2. **workerd main thread CPU, unprofiled** (`/proc/<pid>/task/<pid>/schedstat`, ns). An
   upper bound: every isolate of the local runtime runs on that thread, so it adds the
   emulated R2/D1/DO and the local routing (5–10 ms on a cached page), which are other
   machines in production.

**Cross-check:** the same scenarios on Node (`next start`, with a preload reading
`process.threadCpuUsage()` from the request's arrival until the thread is quiet).

**Method check** (`calibrate.ts`, run by the same command, on a Worker whose work is known):

__CALIBRATION__

**Precision.** For CPU-bound work the profile estimate is within about ±10 % of the
thread's own CPU (the table above); for short requests the floor is the sampling interval
(±0.2 ms) plus at most 0.4 ms per wait on I/O. The profiler itself costs a little CPU,
which inflates first-time compilation most: the cold numbers are slightly pessimistic.
Medians and p95 are over the samples of one run; the raw samples are in
`apps/web/cpu-results/<run>/samples.jsonl` (gitignored) and the per-scenario statistics in
[data/t033-cpu-before.csv](data/t033-cpu-before.csv) and
[data/t033-cpu-after.csv](data/t033-cpu-after.csv).

**What this cannot measure:** Cloudflare's CPUs. Its docs say a local profile "has a
different CPU" than production (`wrangler check startup` prints this). A production core
may be faster or slower than this VM; nothing in the verdict changes unless it is more than
about three times faster (§1.5).

### 1.3 How Cloudflare enforces the limit

| Finding | Status | Source |
|---|---|---|
| 10 ms CPU per HTTP request on Free (also 10 ms per Cron Trigger); 5 min max / 30 s default on Paid | confirmed | Workers limits page (`workers/platform/limits.mdx` in cloudflare-docs, read 2026-10-09) |
| Waiting on I/O (fetch, KV, database) does not count | confirmed | same page: "Waiting on network requests … does **not** count toward CPU time" |
| Over the limit the client gets **Error 1102** "Worker exceeded resource limits"; the invocation's outcome is `exceededCpu` | confirmed | same page |
| **The global scope runs under a separate startup limit** (1 s on both plans; at deploy, a slower Worker is refused with error 10021 "Script startup exceeded CPU time limit"), not under a request's CPU limit | confirmed (docs and workerd) | limits page; workerd `src/workerd/io/worker.c++`: the main module is evaluated inside `IsolateLimitEnforcer::enterStartupJs()`, while request code runs inside `LimitEnforcer::enterJs()` ("to enforce limits on that code execution, particularly the CPU limit", `limit-enforcer.h`) |
| How the production enforcer meters these scopes | assumed | the enforcer itself is not in workerd (open source has a no-op one); we rely on the interface and the docs |
| **OpenNext loads the Next server inside the first request**, not at startup, so on a fresh isolate that work counts toward the first request's 10 ms | confirmed (our bundle) | `.open-next/worker.js` calls `await import("./server-functions/default/handler.mjs")` inside `fetch`; wrangler's esbuild bundles it into a lazy `__esm` initialiser (`init_handler`, checked in the `wrangler deploy --dry-run` output), i.e. plain JavaScript in the request, not a separately metered dynamic import (`enterDynamicImportJs`) |
| **Leeway:** "Each isolate has some built-in flexibility to allow for cases where your Worker infrequently runs over the configured limit. If your Worker starts hitting the limit consistently, its execution will be terminated according to the limit configured." | confirmed | docs partial `isolate-cpu-flexibility` (rendered on the limits page) |
| The leeway is **rollover CPU time**: requests below the limit leave credit that later ones may use ("higher quantiles may appear to exceed CPU time limits without generating invocation errors because of a mechanism in the Workers runtime that allows rollover CPU time for requests below the CPU limit") | confirmed | `workers/observability/metrics-and-analytics.mdx`; workerd's source also mentions a "rollover bank" (`worker.c++`) |
| How big the rollover bank is, how fast it fills, whether a **fresh isolate** starts with any credit | **unknown** (not documented) | — |
| A fresh isolate gets no meaningful credit: cron ticks on cold isolates were killed at exactly 10.0 ms CPU, while warm isolates ran at a p50 of ~19 ms without errors | assumed (one third-party report) | emdash-cms/emdash issue #3858 (Workers Free, `exceededCpu` with `cpuTime: 10`) |
| No averaging across isolates or across a time window beyond the per-isolate rollover | assumed | nothing in the docs says otherwise |
| Startup limit 1 s since 2025-10-10 (was 400 ms) | confirmed | Workers changelog 2025-10-10 |
| Worker size: the brief's 3 MB (Free) / 10 MB (Paid) compressed. The limits page now lists **64 MiB uncompressed on both plans, "no compressed size limit"**; secondary reports date the change to a 2026-09-04 changelog entry, and a wrangler 4.129.1 release note says the compressed limits were removed server-side | page confirmed, date assumed | limits page; release notes (not read first-hand) |
| 100,000 requests/day on Free (Error 1027 beyond, reset at 00:00 UTC); static asset requests are not Worker invocations | confirmed | limits page |

Documentation was read through a search tool and GitHub (the container cannot reach
developers.cloudflare.com directly), on 2026-10-09.

### 1.4 Results

__RESULTS__

### 1.5 GO / NO-GO

__GONOGO__

### 1.6 What T-033 changed

__CHANGES__

### 1.7 Options for what does not fit

__OPTIONS__
