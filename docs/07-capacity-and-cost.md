# 7. Capacity and cost (M5, T-025)

How many concurrent rooms the stack holds, what one battle uses, and what 1,000 battles
cost. Every number is marked **measured** (with the run it comes from) or **assumed** (with
the date the assumption was written). Prices could not be checked: the container that ran
the test reaches only the npm registry, so **every price below is an assumption from
model knowledge, dated 2026-10-07**, kept in one table (§4.1, `PRICES` in
`tools/loadtest/src/cost.ts`) to make updating them easy.

## 7.0 Summary

- **M5 exit criterion (p95 phase-change propagation < 1 s): met at the full target size,
  under conditions.** 50 rooms × 8 players = 400 clients, 2 battles per room (100 battles)
  on the local stack: **p95 137.6 ms, p99 215.1 ms over 9,981 phase-event deliveries,
  99.90 % of battle events delivered, 100/100 battles reached DESTROYED** (measured, run
  `20261008t001944-full`). The conditions: Realtime quotas of Supabase **Pro without a spend
  cap** (§7.2), phases compressed about 10× (§7.1.3), everything on one 4-vCPU machine.
- **With the presence quota we assumed for Pro with a spend cap (50 presence messages/s)
  it is NOT met**: p95 1,877.9 ms, 95.0 % delivery (measured, run `20261008t000150-full`).
  Realtime closed room channels 17,726 times ("Too many presence messages per second"),
  and the clients' rejoins fed the overload. Even 10 rooms × 8 players hit that quota.
  **This is the first limit we would hit in production** (§7.5).
- **Cost per 1,000 battles** (6 players, 10-minute builds): **$50.59 all-in at 1,000
  battles a month** (the fixed plans dominate), **$13.80 at 10,000 a month**, and **$17.53
  marginal** once every included quota is used up. Monthly totals: **$50.59 at 100 and at
  1,000 battles, $138.01 at 10,000** (§7.4). All prices assumed.
- **Biggest variable cost: Realtime messages, and 92 % of them are Presence** (each
  activity update fans out to every member). Then Browser Rendering hours and MAU.
- **Product bottlenecks found** (evidence in §7.5, fixes proposed, product code unchanged):
  the client's deadline nudges every 5 s while RESULTS waits for screenshots (275
  `advance_battle` + 361 `get_battle_snapshot` per battle under a capture backlog); the
  storage RLS lookup on every reveal download is the top database consumer; Realtime's
  authorization pool turns battle-start join bursts into 23 s joins when it has one
  connection.

## 7.1 How it was measured

### 7.1.1 The generator (`tools/loadtest`, workspace package `@br/loadtest`)

Node + TypeScript, `@supabase/supabase-js` 2.117.2 (the web app's version), no browsers.
Each simulated player has its own supabase-js client, so its own Realtime WebSocket, and
follows the web client's rules (`apps/web/src/lib/room/sync.ts`, `reveal-vote.ts`, the
solo controller in external mode). The code is `tools/loadtest/src/session.ts`.

| Area | What a simulated player does |
|---|---|
| Sign-in | `auth.admin.createUser` (service key, email + password, confirmed), then `signInWithPassword`, then `realtime.setAuth`. The local stack allows 300 anonymous sign-ups per hour (`supabase/config.toml`), which a 400-client run exceeds; the admin API has no limit and password sign-ins were not rate limited locally (measured: 45 in 12 s, then 400 in a run). `--auth anonymous` uses `signInAnonymously` like the app. The users are not anonymous; no game RPC treats them differently (only `is_admin` looks). |
| Room | Host `create_room`; others `join_room` 0.2–2.5 s apart. `room:{id}` with Presence (`{user_id, display_name, device, activity}`), `get_room_snapshot` on subscribe, on a version gap and when a heartbeat shows a newer `room_version`. |
| Presence | Throttled like the client: ≤ 1 per 2 s and ≤ 4 per 30 s, latest payload wins. During BUILDING the activity (`lines`, `typing`) changes every 4–8 s, so the throttle binds (measured: 7.95 sends per BUILDING minute, cap 8). A channel the server closes is re-subscribed after 1, 2, 4 … 30 s. |
| Heartbeat | `heartbeat` every 10 s plus the T-023 version check (`battles.version` via PostgREST) while a battle runs; `server_now` × 3 at start and every 60 s (lowest round trip kept). |
| Battle | Host `start_battle` (the current host, if the role moved). Every player waits for the room event that names the battle (3 s, then a snapshot), subscribes `battle:{id}` without Presence, applies the version rules (stale ignored, gap → refetch), refetches `get_battle_snapshot` after every `phase` event except REVEAL slot steps and after `capture`/`sync` events, and nudges `advance_battle` at every deadline (+0–500 ms), then refetches, again every 5 s while the version does not move. |
| BUILDING | Plans per player: 75 % ship by hand, 20 % auto-ship from their autosave, 5 % DNF (no uploads, a phone player). Autosave every 30 s (`autosave/bundle.js`, `bundle.css`, `source.json`, plus `manifest.json` once), a final autosave 3 s before the deadline and one in the SHIPPING grace. Ship at 35–95 % of the build time: `source.json`, `bundle.js`, `bundle.css`, `manifest.json`, `thumb.webp`, then `ship_build` with stats. |
| File sizes | Log-normal, **assumed** (2026-10-07; no production data yet): `source.json` median 14 KB (p90 60 KB, max 1 MB = the workspace limit), `bundle.js` median 12 KB (p90 70 KB; minified, packages external, images inlined), `bundle.css` 2 KB, `thumb.webp` 18 KB (640×400), `manifest.json` 0.1 KB. Autosaves grow with build progress. The bundle is real JavaScript that renders a coloured page with the build name, so the capture worker makes real screenshots; half call `window.buildRoulette.ready()`. |
| REVEAL | `get_reveal_builds` once, every build's `thumb.webp`, the spotlighted and the next build's `bundle.js`, `bundle.css`, `manifest.json` (prefetch). The host clicks `reveal_next` in 60 % of the slots (CAS, resent up to 3× with the same spotlight), the other slots time out. |
| VOTING | `get_my_votes`, then 4 × `cast_vote` (overall, rule, style, chaos) for random other final builds, 10 % revote; 5 % of voters stay silent, so VOTING runs to its deadline. |
| RESULTS | Every screenshot through its public URL (what the results page's `<img>` loads), again after each `capture` event. |
| End | Back to the lobby, `set_ready`, the next battle; after the last one `leave_room`. |

**Not simulated:** the sandbox preview itself (bundling, iframes, the package CDN, the
pages of the Next.js app), spectators, kicks, refreshes and leaves mid-battle (the chaos
e2e covers those), solo battles, reports, the admin page, Turnstile. Uploads always
succeed on the first try unless the server refuses them.

### 7.1.2 Measurement

- **Propagation:** a client records the receipt time of every broadcast (`performance.timeOrigin + performance.now()`, epoch ms). After the run the receipts are joined on `(topic, version)` with `battle_events.created_at` / `room_events.created_at`. `created_at` is the transaction's `now()` (its start), so the figure includes the transaction itself, the WAL path to Realtime, the fan-out and the WebSocket. **Clock:** the database runs in a Docker container on the same kernel, so the clocks are the same; the generator also measured client − server offsets with `server_now` (p50 −0.3 ms, p95 1.7 ms in the full run, the round trip included) and **no correction is applied**. The headline metric is battle `phase` events (every phase change and REVEAL slot), reported also by cause (an RPC or the sweep), per event type, and for room events.
- **Delivery:** every battle event from version 3 on (all players are subscribed by then) should reach every player; the report counts the receipts.
- **Requests:** an instrumented `fetch` (supabase-js `global.fetch`) times and sizes every Auth, PostgREST and Storage request (p50/p95/p99 per RPC); a 20 s timeout counts as `timeout`. RPC failures are counted by their stable code (`rate_limited`, `wrong_phase`, …).
- **Realtime:** a counting WebSocket class (supabase-js `realtime.transport`) counts connections and every frame in and out by Phoenix event, with bytes; billable messages per second; `system` messages by reason; channel statuses and error reasons.
- **Database:** `pg_stat_activity` (active backends), `pg_locks` (waiting), `pg_stat_database` (commits/s, deadlocks), the job queue by status every 5 s, `pg_stat_statements` (reset at the start), rows per battle and database size after the run.
- **Containers and host:** `docker stats` back to back (CPU %, 100 % = 1 core; memory), `/proc/stat` host CPU busy %, the load average, the generator processes' own CPU time and event-loop delay.
- **Capture:** the capture worker's JSON log (`job.end`, `capture.rendered`), the backlog (queued + running capture jobs) every 5 s, and `builds.captured_at − battles.shipping_ended_at`.

### 7.1.3 Time compression (scaling factors)

The generator shortens every phase of each battle it starts with one SQL statement right
after `start_battle` (`tools/loadtest/src/db.ts`, `compressBattle`): it merges shorter
durations into `battles.settings` (read by every later transition), moves the SPINNING
deadline and sets the challenge's time limit (BUILDING starts from it). Clients therefore
see consistent deadlines in every event. A battle takes about 2 minutes instead of about
20.

| Phase | Product | Load test | Factor |
|---|---|---|---|
| SPINNING | 6 s | 3 s | 0.5 |
| BUILDING | 300 / 600 / 900 s (drawn) | 60 s (the schema's minimum, `time_limit_seconds ≥ 60`) | 0.2 / 0.1 / 0.067 |
| SHIPPING grace | 15 s | 5 s | 0.33 |
| REVEAL slot | `round(clamp(300/n, 30, 60))` = 38–60 s | 5 s | ≈ 0.1 |
| VOTING | 60 s (ends early when all present voted) | 20 s | 0.33 |
| RESULTS | 60 s | 10 s | 0.17 |
| Capture deadline | 600 s | 240 s (smoke 180 s) | 0.4 |

**Not compressed:** heartbeat 10 s, autosave 30 s, clock resync 60 s, the presence
throttle. The load per connected client is therefore the real one, but **event-driven
load is about 10× the real rate** (a room plays a battle every ~2.5 min instead of
~20 min): ships, reveals, votes, captures. The cost model (§7.4) therefore takes
event-driven traffic per battle and rate-driven traffic per client-minute, and rebuilds a
real battle from them.

### 7.1.4 Environment and test-only changes

- **Machine (measured):** a cloud container with 4 vCPUs and 15.7 GiB RAM, Node 22.22.
  The local Supabase stack (CLI 2.119.0: Postgres 17.11, PostgREST 16.4, Realtime 2.140.3,
  Storage 1.79.28, GoTrue 2.197, Kong 2.8.1), the capture worker (Playwright Chromium,
  concurrency 2) and the generator (4 processes for the full profile) all share it.
  Production runs each of these on separate, larger infrastructure; the latencies here
  are pessimistic for the server side.
- **Kong `worker_connections` 512 → 8192 (test-only).** The local gateway's nginx has no
  `worker_connections`, so the default 512 applies, and every Realtime WebSocket holds two
  of them. The first full run (`20261007t234956-full`) failed from about 240 clients on:
  "512 worker_connections are not enough" in the Kong log, 10,060 heartbeats with network
  errors, the capture worker unable to claim jobs (18 of 18 captures failed). Hosted
  Supabase does not run this gateway. The generator now raises the limit inside the
  running container and reloads nginx (`src/gateway.ts`, `--gateway-connections`).
- **Realtime tenant quotas (test-only).** The local tenant starts with the Free plan's
  numbers (200 connections, 100 events/s). `--realtime-limits` sets a plan's quotas
  through Realtime's tenant API and restores them afterwards: `pro` = 500 connections,
  500 messages/s, 500 joins/s, **50 presence messages/s**; `pro-nocap` = 10,000 / 2,500 /
  2,500 / **1,000**. These numbers are **assumed** (Supabase's Realtime limits page as the
  author knew it; not re-checked 2026-10-07).
- **Realtime authorization pool.** Realtime checks private-channel joins against the
  database through a per-tenant pool (`db_pool`), which is 1 connection when unset, as
  locally. `--realtime-db-pool 10` raises it (§7.5.4).
- **Realtime rebalancing.** The local Realtime drops its database feed every 10 minutes
  ("Rebalancing Tenant database connection", known since T-023); broadcasts sent until the
  next channel join are lost and clients recover through the heartbeat's version check.
  Runs longer than 10 minutes show it (§7.2).

## 7.2 Runs and the M5 verdict

All measured on the machine above. "Phase p95" = battle `phase` events, server
`created_at` → client receipt.

| Run | Size (rooms × players × battles) | Realtime quotas / pool | Battles DESTROYED | Phase p50 / p95 / p99 (ms) | Battle events delivered | Notes |
|---|---|---|---|---|---|---|
| `20261007t234956-full` | 50 × 8 × 2 | `pro` / 1 | 2 of 30 started | 66.5 / 126.5 / 287.6 (only 973 deliveries) | 96.6 % | Invalid: Kong's 512 connections exhausted at ~240 clients (§7.1.4). |
| `20261008t000150-full` | 50 × 8 × 2 | `pro` (presence 50/s) / 1 | 93 (7 not started) | 54.8 / **1,877.9** / 3,149.6 | 95.0 % | 17,726 room-channel closes "Too many presence messages per second"; RPC timeouts (504) at 10 s; **not met**. |
| `20261008t001559-custom` | 10 × 8 × 1 | `pro` / 1 | 10 | 13.0 / 31.7 / 43.3 | 100 % | Met, but already 2,379 room-channel closes for the presence quota. |
| **`20261008t001944-full`** | **50 × 8 × 2** | **`pro-nocap` / 1** | **100** | **29.0 / 137.6 / 215.1** | **99.90 %** | **Largest stable run; met.** Battle-channel joins p95 23.1 s (pool of 1, 284 CHANNEL_ERROR then rejoin). |
| `20261008t003410-full` | 50 × 8 × 2 | `pro-nocap` / 10 | 100 | 42.6 / 201.7 / 386.4 | 94.98 % | Met. Joins p95 213 ms. Realtime rebalanced at minute 10: 100 % delivered before, 0 of 1,264 events after (recovered by the version check). Storage timeouts (591) from host saturation. |
| `20261008t004651-custom` | 10 × 6 × 2 | `pro-nocap` / 1 | 20 | 13.2 / 33.4 / 61.9 | 100 % | Cost basis (6 players, captures keep up). |
| `20261008t005452-smoke` | 3 × 4 × 1 | local / 1 | 3 | 11.6 / 17.7 / 18.7 | 100 % | Smoke profile on a fresh stack, 2 min 19 s. |

**Verdict:** the M5 criterion is **met at 400 concurrent clients (50 rooms × 8 players)**
when Realtime has the quotas of Supabase Pro **without** a spend cap (1,000 presence
messages/s), and **not met** with the presence quota we assume for Pro with a spend cap
(50/s). Conditions: phases compressed about 10× (§7.1.3), everything on one 4-vCPU
machine that ran 69 % busy on average and 95–99 % during the ramp, the capture worker
falling behind (backlog up to 331 jobs).

### 7.2.1 The full run in detail (`20261008t001944-full`, measured)

400 clients, 100 battles, 712 s, peak 400 WebSockets, 3,657 client-minutes; plans: 613
ship, 146 auto-ship, 41 DNF; final builds per battle p50 8.

**Propagation (ms)**

| Events | n | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| battle `phase` (all) | 9,981 | 29.0 | 137.6 | 215.1 | 349.8 |
| `phase` spinning → building | 709 | 28.3 | 147.0 | 283.4 | 322.8 |
| `phase` building → shipping | 800 | 27.4 | 129.7 | 221.1 | 308.5 |
| `phase` shipping → reveal | 800 | 33.0 | 148.8 | 275.8 | 308.6 |
| `phase` reveal slot steps | 5,272 | 29.1 | 135.8 | 209.0 | 349.8 |
| `phase` reveal → voting | 800 | 28.8 | 130.5 | 185.9 | 199.9 |
| `phase` voting → results | 800 | 44.6 | 172.1 | 217.2 | 280.1 |
| `phase` results → destroyed | 800 | 18.2 | 113.1 | 176.5 | 236.0 |
| all battle events | 26,530 | 25.4 | 149.1 | 289.9 | 702.9 |
| all room events | 17,759 | 30.7 | 176.5 | 318.7 | 603.4 |

**Requests (ms)**

| Call | n | p50 | p95 | p99 | Errors |
|---|---|---|---|---|---|
| `heartbeat` | 21,647 | 15.0 | 274.5 | 750.6 | 0 |
| `battles.version` (REST) | 21,064 | 11.7 | 262.2 | 748.8 | 0 |
| `server_now` | 11,463 | 7.9 | 319.4 | 906.8 | 0 |
| `get_battle_snapshot` | 36,881 | 15.3 | 189.4 | 569.7 | 0 |
| `advance_battle` | 27,499 | 14.2 | 189.3 | 554.2 | 0 |
| `cast_vote` | 3,142 | 43.7 | 496.1 | 1,158.6 | 1 `wrong_phase` |
| `ship_build` | 613 | 45.6 | 504.9 | 960.2 | 0 |
| `reveal_next` | 450 | 27.0 | 322.7 | 791.5 | 0 |
| `get_reveal_builds` | 800 | 53.1 | 386.8 | 1,170.4 | 0 |
| `start_battle` / `create_room` / `join_room` | 100 / 50 / 350 | 52.7 / 67.8 / 89.8 | 358.5 / 623.1 / 554.2 | – | 0 |
| Storage upload | 6,437 | 241.7 | 1,516.0 | 2,416.5 | 27 RLS refusals (late autosaves after the deadline) |
| Storage download (reveal) | 23,120 | 196.7 | 1,028.9 | 1,555.1 | 0 |
| Storage public (screenshots) | 4,502 | 33.3 | 225.3 | 703.0 | 0 |
| Realtime join, room / battle | 400 / 800 | 48.4 / 109.2 | 392.5 / 23,147 | – | 284 CHANNEL_ERROR, rejoined |
| Auth admin create / password sign-in | 402 / 400 | 1,058 / 1,219 | 5,875 / 6,696 | – | 2 HTTP 500 (retried) |

No `rate_limited`, no timeouts, no conflicts.

**Realtime:** 400 WebSockets; billable messages (rule assumed, §7.4.2) in 105,057, out
7,467; inbound billable messages per second p50 128, p99 560, **max 937** (above the 500/s
we assume for Pro with a spend cap); presence sent 7,467, deferred by the throttle 5,899.

**Database:** max 18 active backends, max 5 waiting locks, commits/s p50 305 (max 603),
0 deadlocks. Top statements by total time: the Storage object lookup (`SELECT … FROM
storage.objects WHERE name = $1 AND bucket_id = $2`, 23,120 calls, **4.75 ms mean, 110 s
in total**), Storage inserts (6,410 calls, 23 s). Size 38.5 → 49.3 MiB.

**Containers (docker stats, mean / max, 100 % = 1 core):** db 62.6 / 116.8, storage 28.3 /
97.0, rest 23.7 / 82.8, kong 14.2 / 35.6, auth 10.3 / 139.9 (bcrypt at sign-in), realtime
7.8 / 23.9. Generator 0.38 cores; event-loop delay p99 30 ms, max 545 ms (the
generator added at most that to a receipt time at its worst moment).

**Capture:** 588 captured, 171 failed at the 240 s deadline; 56.2 captures/min with one
Chromium at concurrency 2 (job p50 2.9 s, p95 3.7 s under load); backlog up to 331;
SHIPPING end → captured p50 206 s. The compressed run asks for about 10× the real capture
rate (§7.5.6).

## 7.3 Measured per-battle resource usage

From the cost-basis run `20261008t004651-custom` (10 rooms × **6** players × 2 battles,
captures keeping up, **compressed** phases): totals divided by its 20 battles (event-driven)
or by its 234.1 client-minutes (rate-driven). §7.4 turns them into a real battle.

**Calls per battle (event-driven, measured):**

| Call | Per battle | Call | Per battle |
|---|---|---|---|
| `get_battle_snapshot` | 81.4 | `cast_vote` | 24.0 |
| `advance_battle` (nudges) | 6.7 | `get_my_votes` | 6.0 |
| `ship_build` | 4.7 | `get_reveal_builds` | 6.0 |
| `reveal_next` | 3.7 | `set_ready` | 6.0 |
| `start_battle` | 1.0 | Storage uploads | 48.2 |
| `get_room_snapshot` | 3.0 | Storage downloads (reveal) | 129.9 |
| Realtime joins (room + battle, per player) | 1 + 1 | Screenshot views (public URL) | 33.9 |

**Rate-driven, per client-minute (measured):** `heartbeat` 5.96, `battles.version` 5.60,
`server_now` 3.17 (14.7 calls/min, about 0.25 requests/s per connected player); presence
sends 7.95 per BUILDING minute (the throttle's cap is 8) and 1.4 per player-battle outside
BUILDING.

**Realtime messages per battle (measured, compressed, 6 players):** 275 broadcast
deliveries (`binary:4` frames: battle and room events × members), 337 presence diffs
received, 56 presence sends; protocol frames (join replies, heartbeats) are not counted.

**Storage per battle (measured):** uploaded mean 581 KiB (autosaves 6.7 per battle, ships
4.7); downloaded mean 1,795 KiB, of which reveal files 1,606 KiB (`bundle.js` 652 KiB,
`thumb.webp` 641 KiB, `bundle.css` 88 KiB, autosave bundles 224 KiB) and screenshots
189 KiB (test screenshots are only 5.6 KB; a real app's are assumed 100 KB). The
ephemeral files are all deleted at DESTROY (0 objects left, measured).

**Capture (measured locally, Playwright Chromium):** 5.65 captures per battle; job p50
0.78 s, p95 3.2 s; render p50 0.54 s; readiness: the build's signal 58 %, network idle
+ 2 s 42 %; screenshot p50 5.8 KB (test builds).

**Database rows per battle (measured):** 1 battle, 1 challenge, 6 `battle_players`, 6
`builds`, 28.9 `battle_events`, 23.6 `votes`, 7 `awards`, 6.7 `jobs`, 21.4 `room_events`,
5.7 screenshot objects. The database grew 63 KB per battle including users, rate-limit
events and logs (measured: 1.26 MB for 20 battles and 60 users).

## 7.4 Cost model

Code: `tools/loadtest/src/cost.ts`; `pnpm --filter @br/loadtest cost <report.json>` prints
§7.4.3–§7.4.5 for any run.

### 7.4.1 Parameters: prices and quotas (all ASSUMED, 2026-10-07)

| Item | Value | Note |
|---|---|---|
| Supabase Pro | $25/month | includes $10 compute credit (Micro: shared 2 vCPU ARM, 1 GB) |
| Supabase compute Small / Medium / Large | $15 / $60 / $110 per month | before the $10 credit |
| Realtime peak connections | 500 included, then $10 per 1,000 | Pro |
| Realtime messages | 5 M/month included, then $2.50 per 1 M | Pro |
| Realtime rate limits | 500 messages/s, 500 joins/s, **50 presence messages/s** with spend cap; 2,500 / 2,500 / 1,000 without | used for `--realtime-limits` |
| Egress (uncached: Auth, PostgREST, Storage, Realtime) | 250 GB/month included, then $0.09/GB | Pro |
| File storage | 100 GB included, then $0.021/GB-month | Pro |
| Database disk | 8 GB included, then $0.125/GB-month | Pro |
| MAU | 100,000 included, then $0.00325/MAU | anonymous sign-ins count |
| Cloudflare Workers Paid | $5/month: 10 M requests + 30 M CPU-ms, then $0.30/M requests, $0.02/M CPU-ms | needed for Containers and Browser Rendering |
| Cloudflare Pages | $0 | static sandbox shell, free and unlimited |
| Browser Rendering | 10 browser-hours/month included, then $0.09/hour; 10 concurrent browsers (monthly average), then $2 each | Workers Paid |
| Containers | $0.0000025/GiB-s memory, $0.000020/vCPU-s, $0.00000007/GB-s disk; 25 GiB-h, 375 vCPU-min, 200 GB-h included; egress $0.025/GB after 1 TB | package CDN |
| R2 | $0 | OpenNext ISR cache within the free tier |
| Domain | $10.44/year | app domain (.com, at-cost registrar); the usercontent domain only in stage 2 |

### 7.4.2 Behaviour of a real battle (ASSUMED, 2026-10-07)

6 players; 10-minute build; 2 min lobby, 6 s SPINNING, 15 s SHIPPING, REVEAL 6 slots × 50 s
(F = 6 × 0.95 final builds), VOTING 1 min, RESULTS 1 min: **19.4 online minutes per
player**. Billing rule for Realtime messages: every broadcast or presence message delivered
to a client, plus every presence message a client sends (joins, replies and heartbeats not
counted). Screenshots 100 KB. 3 battles per unique player per month (MAU). Peak-hour
concurrency 4× the monthly average. 15 Worker requests × 10 ms CPU per player per battle.
6 s of Browser Rendering per capture (local job p50 0.8–2.9 s; a remote session adds a
launch). Package-CDN container always on (1 GiB, ¼ vCPU billed): the worst case.

### 7.4.3 Formulas

With P players, F final builds, T online minutes, P_t the players per battle of the
measured run and s = (P / P_t)²:

- **Realtime messages / battle** = broadcast deliveries_measured × s + P × (presence per
  BUILDING minute × build minutes + other presence per player) × (1 + P)
- **Egress / battle** = (API bytes_event + reveal download bytes + screenshot views ×
  100 KB) × s + API bytes per client-minute × T × P + Realtime bytes + Auth bytes × P
- **Peak connections** = battles/month × P × T / 43,800 × peak factor
- **Browser hours / battle** = F × 6 s / 3,600; **storage** = F × 100 KB, accumulated
- **Monthly cost** = fixed bases + Σ max(0, usage − included) × price
- **Cost per 1,000 battles** = monthly cost / battles × 1,000

### 7.4.4 One real battle (derived from the measured run, 6 players)

| Quantity | Per battle | Measured / assumed |
|---|---|---|
| Realtime messages | **3,673** (275 broadcasts + 3,398 presence) | measured rates, assumed billing rule |
| Realtime connection-minutes | 116 | assumed timeline |
| Supabase egress | **7.1 MB** | measured: API 498 KiB, reveal 1,606 KiB, 34 screenshot views, 1.0 KiB per client-minute; screenshots assumed 100 KB |
| Supabase HTTP calls | 2,036 | measured: 327 event-driven + 14.7 per client-minute |
| Screenshot storage added | 0.61 MB | assumed |
| Browser Rendering | 36 s | assumed 6 s × 6 |
| Worker requests / CPU | 90 / 900 ms | assumed |

### 7.4.5 Worked example: monthly cost and cost per 1,000 battles

| Item | 100 battles | 1,000 battles | 10,000 battles |
|---|---|---|---|
| Supabase Pro (Micro compute) | $25.00 | $25.00 | $25.00 |
| Realtime messages | $0 (0.37 M) | $0 (3.67 M) | $79.32 (36.7 M) |
| Realtime peak connections | $0 (2) | $0 (11) | $0 (107) |
| Egress | $0 (0.7 GB) | $0 (7.1 GB) | $0 (71 GB) |
| Storage (screenshots after 12 months) | $0 (0.7 GB) | $0 (7.4 GB) | $0 (74 GB) |
| MAU | $0 (200) | $0 (2,000) | $0 (20,000) |
| Cloudflare Workers Paid | $5.00 | $5.00 | $5.00 |
| Workers requests + CPU | $0 | $0 | $0 (0.9 M req) |
| Browser Rendering | $0 (1 h) | $0 (10 h) | $8.10 (100 h) |
| Containers (package CDN, always on) | $19.72 | $19.72 | $19.72 |
| Pages, R2 | $0 | $0 | $0 |
| Domain | $0.87 | $0.87 | $0.87 |
| **Total per month** | **$50.59** | **$50.59** | **$138.01** |
| **Per 1,000 battles** | $505.90 | **$50.59** | **$13.80** |

Marginal cost per 1,000 battles once every quota is used up: **$17.53** (Realtime
messages $9.18, MAU $6.50, Browser Rendering $0.90, egress $0.64, the rest pennies). At
100,000 battles a month the model gives $1,432 (Realtime messages $906, MAU $325, Browser
Rendering $89, egress $41).

Not in the totals: a larger Supabase compute size (§7.5.5), and the spend cap. **With the
spend cap on, quotas are not billed but enforced**, and the presence limit (§7.5.1) makes
it unusable for this game; the totals above therefore assume the cap is off.

## 7.5 Bottlenecks and scaling limits

Ordered by when they bite. "Battles/month" assumes the §7.4.2 behaviour.

1. **Realtime presence rate (Pro with spend cap: 50/s, assumed). First, at about 10
   concurrent 8-player rooms.** Measured: with that quota, 10 rooms × 8 players
   (`20261008t001559-custom`) got 2,379 room-channel closes with `system` "Too many
   presence messages per second" (Realtime log: `PresenceRateLimitReached`); at 50 rooms
   17,726 closes, each followed by a rejoin (an RLS check, a `presence_state`, a new
   track), which fed the overload: p95 1.9 s, 95 % delivery, RPC timeouts. The clients
   sent only ~4.8 presence messages/s in total, so the quota evidently counts the fan-out
   (each track reaches every member) and the rejoins. With the spend cap off (1,000/s) the
   same full run had 1 close. **Limit: spend cap on → ~10 busy rooms.**
2. **Included Browser Rendering hours: ~1,000 battles/month** (10 h ÷ 36 s). Cheap beyond
   ($0.09/hour). Concurrency: 10 browsers included; one capture takes 1–6 s, so ~100–600
   captures/min, far above what 1,000 concurrent players need.
3. **Realtime messages: ~1,360 battles/month** within 5 M; then $9.18 per 1,000 battles,
   the largest variable cost. 92 % are presence.
4. **Realtime messages per second: Pro with spend cap 500/s.** Measured max 937/s inbound
   (p99 560/s) at 400 clients in the compressed run; the real rate is lower (events ~10×
   slower), but presence is real-time: 400 building players × 8/min × 9 deliveries ≈
   480/s on its own. **Limit: about 400 concurrent players with the cap on.**
5. **Realtime peak connections: 500 included** = 83 concurrent 6-player battles, the peak
   hour of ~47,000 battles/month (peak factor 4). Then $10 per 1,000.
6. **Egress 250 GB: ~35,000 battles/month.** Reveal downloads grow with P² (every member
   downloads every build).
7. **MAU 100,000: ~50,000 battles/month** (3 battles per player); then $6.50 per 1,000
   battles.
8. **Storage 100 GB: ~13,500 battles/month** if screenshots are kept 12 months.

Bottlenecks of the system itself (measured, and what the 400-client test corresponds to:
the peak hour of about 37,600 battles/month at peak factor 4):

- **§7.5.4 Realtime authorization pool.** With Realtime's default `db_pool` of 1, the
  battle-start burst (8 joins per room within a second) produced 284 CHANNEL_ERROR and
  `IncreaseConnectionPool: Please increase your connection pool size` in the Realtime log;
  battle-channel joins p95 23.1 s (they succeed on supabase-js's retry). With 10
  connections (`20261008t003410-full`): p95 213 ms, no errors. Events published before a
  client's join are recovered by its snapshot, so propagation stays fine, but a slow join
  delays the first snapshot.
- **§7.5.5 Database.** At 400 clients the Postgres container used 0.63 cores on average
  and 1.2 at peak (commits 305/s, max 603/s), 18 active backends, no deadlocks, ≤ 5
  waiting locks. Micro (shared 2 vCPU, 1 GB) is probably enough at launch volumes (the
  1,000-battle month averages 3 concurrent players) and not at the 400-client peak; plan
  Small/Medium before marketing pushes. The top consumer is the Storage RLS lookup of
  reveal downloads: 23,120 reads × 4.75 ms = 110 s of database time, more than any RPC.
- **§7.5.6 Capture throughput.** One Chromium at concurrency 2 on this machine: 56
  captures/min under full load. 400 concurrent players with real 10-minute builds need
  about 400 × 0.95 / 19.4 min ≈ 20 captures/min, so the real rate fits; the compressed
  test asked for ~10× more and built a 331-job backlog (171 captures failed at the
  deadline). Production uses Browser Rendering; its concurrency (10 included) is the knob.
- **§7.5.7 Deadline nudges while RESULTS waits for screenshots.** Every client nudges
  every 5 s (`advance_battle` + `get_battle_snapshot`) while the battle cannot leave
  RESULTS. Under the capture backlog that was **275 `advance_battle` and 361 snapshots per
  battle** (vs 6.7 and 81 when captures keep up); the two calls made up 41 % of all
  requests of the full run. Any capture slowdown in production multiplies API load the same way.
- **Local stack only:** Kong's 512 connections (fails at ~240 clients, §7.1.4) and the
  10-minute Realtime rebalancing (§7.2).

## 7.6 Recommendations

1. **Launch on Supabase Pro with the spend cap off** (or Team), and set a billing alert
   instead. With the cap on, the presence quota (§7.5.1) breaks rooms at ~10 concurrent
   rooms. Re-check the Realtime limits page for the presence and messages-per-second
   numbers first (assumed here).
2. **Cut presence traffic** (most of the Realtime bill): send activity at most once per
   15 s instead of 4 per 30 s, only on changes that matter (typing on/off, a build error),
   and nothing during REVEAL/VOTING/RESULTS. Estimated: presence ÷ 4 → ~1,125 messages per
   battle instead of 3,673, the 5 M quota then covers ~4,400 battles/month. Also back off
   harder after a server-closed channel (start at 5 s, never reset to 1 s on the next
   success), so a rate limit cannot turn into a rejoin storm.
3. **Back off the deadline nudge** in `apps/web/src/lib/solo/controller.ts` when the
   battle does not move: 5, 10, 20, 30 s; or do not nudge in RESULTS at all (the sweep
   ends it). Proposed as a follow-up task; product code was not changed here.
4. **Return the battle version from `heartbeat`** (T-023's own suggestion) and resync the
   clock with one sample: 14.7 → ~7 calls per client-minute.
5. **Realtime database pool:** check the hosted project's Realtime authorization pool
   (the tenant's `db_pool`; in the dashboard's Realtime settings as the database connection
   pool size, as far as the author knows) and raise it above 1–2 before launch; stagger
   battle-topic joins by a random 0–500 ms on the client.
6. **Reveal downloads:** ship `bundle.js`, `bundle.css` and `manifest.json` as one object
   (3× fewer Storage reads, each an RLS check), and consider serving revealed bundles
   through signed URLs cached at the edge (they are immutable once shipped). Egress and the
   top database statement shrink together.
7. **Screenshots:** keep WebP ≤ 100 KB (quality 82, as now) and serve the RESULTS grid
   through Supabase image transforms at thumbnail size: 34 screenshot views per battle are
   the second largest egress item after reveal files.
8. **Capture:** run Browser Rendering captures with a short per-capture session and keep
   the builds' ready signal (58 % used it in the test, half the render time).
9. **Package CDN container:** use `sleepAfter` so it does not run 730 h/month at low volume
   ($19.72 of the $50.59 at 1,000 battles).
10. **Repeat the test on staging** (hosted Supabase, deployed Workers) before launch with
    `pnpm --filter @br/loadtest loadtest --profile full`: the local numbers are a
    pessimistic single-machine view of the server and an assumption-laden view of prices.

## 7.7 Running it

```bash
# local stack WITH Realtime (supabase/README.md), Playwright Chromium for the capture worker
pnpm --filter @br/loadtest smoke                         # 3 rooms × 4 players, ~2.5 min
pnpm --filter @br/loadtest loadtest --profile full       # 50 × 8 × 2, pro-nocap quotas, ~12 min
pnpm --filter @br/loadtest loadtest --rooms 10 --players 6 --battles-per-room 2 --realtime-limits pro
pnpm --filter @br/loadtest loadtest --help               # every option
pnpm --filter @br/loadtest cost loadtest-results/<run>/report.json   # §7.4 for a run
```

Reports go to `tools/loadtest/loadtest-results/<run>/` (`report.md`, `report.json`,
`receipts.json.gz` with the raw receipts and event times, `capture-services.log`). The run
fails (exit 1) when a battle does not reach DESTROYED. CI: the manual `loadtest` input of
the CI workflow runs the smoke profile on a fresh stack and uploads the report.
