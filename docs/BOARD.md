# Task board

Status: `todo` · `in-progress` · `review` · `fix` · `done` · `blocked`

## Current milestone: M5 Hardening + free-tier deploy (all tasks merged; sign-off waits on the user's accounts and the runbook drills in DEPLOY.md)

| ID | Task | Scope | Status | Notes |
|---|---|---|---|---|
| T-022 | Rules/server fixes: one winner per vote category (tie-break: total votes → earlier ship), VOTING early end re-checked in `sweep_deadlines`, UI + e2e updates | `supabase/`, `apps/web/`, `packages/game/` | done | Merged |
| T-023 | Test reliability: root-cause the flaky 8-player chaos test (1 in 5), shard the chaos suite for CI | `apps/web/` (e2e), `ci.yml` | done | Merged |
| T-027 | Preview watchdog false "crashed" right after a rebuild under heavy CPU load (`heartbeat-timeout`, silent ~5.3 s): give a fresh `load` a longer grace, with tests | `packages/runtime/`, `apps/web/` | done | Merged |
| T-024 | Abuse controls: report build, admin page (event logs + report queue + screenshot takedown), name filter, rate limits, Turnstile wiring | `supabase/`, `apps/web/`, `apps/capture-worker/` | done | Merged |
| T-028 | Taken-down builds lose the Winner highlight and all awards (no re-rank, no reassignment) on results, `/battles/[id]`, `/u/[id]`, OG image, room RESULTS | `supabase/`, `apps/web/` | done | Merged |
| T-025 | Load test (50 rooms × 8 players), Realtime/egress mapping to plan limits, cost per 1,000 battles | `tools/loadtest/`, `docs/` input | done | Merged |
| T-029 | Scaling fixes from the load test: ~4× fewer Presence messages (≤1 activity update / 15 s, none after BUILDING) + harder backoff after server-closed channels; no nudge storm in RESULTS (backoff / stop nudging while waiting for captures); `heartbeat` returns the battle version (drop the extra read); single-sample clock resync | `apps/web/`, `supabase/` | done | Merged |
| T-026 | ISR for `/battles/[id]` (+ OG image) and `/u/[id]` on the R2 incremental cache; takedowns revalidate the affected pages | `apps/web/` | done | Merged (observability and runbooks split off → T-030) |
| T-030 | Observability (Sentry/PostHog, env-gated, no PII; sync-engine missed-event and degraded-time counts), runbooks (`docs/runbooks/`) | `apps/web/`, `apps/*`, `docs/runbooks/` | done | Merged |
| T-031 | Preview watchdog false crash **after** `ready` under whole-machine CPU starvation (chaos shard 1, `heartbeat-timeout silentMs=5309 phase=running`): count only silence while the app itself was awake and pinging; report preview crashes (phase, silence, starvation evidence) as a sandbox-health event | `packages/runtime/`, `apps/web/` | done | Merged |
| T-032 | Template packages survive a package-CDN outage after the lobby preload (R10): measure what the browser really caches for the shell and build frames (cache partitioning, opaque origins, the shell's own wipe), choose a Service Worker, an in-shell module cache or edge-only caching, implement it, and test it with an e2e that kills the CDN mid-BUILD | `apps/sandbox-shell/`, `packages/runtime/`, `apps/web/`, `apps/pkg-cdn/` | done | Merged |
| T-033 | **Free tier, step 1 (measure first):** CPU time per request of the web app on workerd for every route class (prerendered, ISR HIT/MISS, OG image, `/u/[id]`, `/r/[code]`, `/admin` and its actions, cold vs warm isolate) against the Workers Free 10 ms limit; how Cloudflare enforces it; slim what doesn't fit (e.g. OG image without runtime rendering); GO/NO-GO for Workers Free with evidence | `apps/web/`, `docs/` | done | Merged: **NO-GO** for Next on Workers Free → static site (T-037, T-038) |
| T-037 | **Free tier: the web app as a static site on Cloudflare Pages** (user decision, option C). `output: 'export'`; `/battles/[id]`, `/u/[id]`, `/r/[code]` become static shells served through Pages `_redirects` rewrites, and they load data in the browser through the anon RPCs. `/admin` runs client-side with the admin's own Supabase session (`is_admin()` in Postgres unchanged). Remove the ISR/R2/D1/DO setup and the server actions; security headers move to `_headers`; e2e runs against `wrangler pages dev`. | `apps/web/`, `docs/` | done | Merged |
| T-038 | Free tier: per-battle link previews. A tiny Pages Function on `/battles/*` injects `og:*` meta (rank-1 screenshot, or the static card; T-028 rule) with `HTMLRewriter`. Its CPU is measured cold/warm with the T-033 tool against the 10 ms limit; if it doesn't fit, fall back to the static card. | `apps/web/` | done | Merged: **GO** (3–5 ms fresh, ~2 ms warm) |
| T-039 | **Bundler start can hang forever.** `BundlerClient.init()` has no timeout: a stalled `esbuild.wasm` or worker-script fetch leaves "Starting bundler…" on screen with no error and no retry. Seen once in CI run 52 (chaos shard 1, a page stuck for 30 s at the battle start; not reproduced in CI run 53 or in 3 local runs; the artifact can't be downloaded from this environment). Fix: an init timeout, one automatic retry with a fresh worker, then the failed state with a visible Retry; e2e that stalls the wasm response. | `packages/runtime/`, `apps/web/` | done | Merged |
| T-040 | **esm.sh: one instance per package and a fully pinned template** (from CI run 60, compat against esm.sh: 52/57, React contract 1 problem). esm.sh resolves a package's own dependencies by **range** (`/scheduler@^0.28.0?target=es2022`, `/three@…`, `/chart.js@…`), cached 10 min only, and a range can resolve to a second copy. Seen as: react-dom → scheduler cached only 600 s (the template outage window); `@react-three/fiber (one three)` ok:false; `react-chartjs-2` "category is not a registered scale" (two chart.js). Fix the esm.sh way: externalize every manifest package in every other package's URL (`?external=react,react-dom,three,…`) and map each in the import map to its exact pinned URL. Pin react-dom's `scheduler` in the template map. Also look at `p5` (a dependency's missing export on esm.sh) and `pixi.js` (ready timeout; the unsafe-eval variant passes). Re-run CI compat with `compat_cdn=https://esm.sh`. | `packages/runtime/`, `apps/sandbox-shell/`, `apps/pkg-cdn/` (compat) | done | Merged; **esm.sh CI 56/58, 0 unexpected, React contract ok** |
| T-041 | **Bundler start: the stall timer can kill a slow compile.** T-039's 15 s no-progress timer gets no messages after the last wasm byte (`compileStreaming` + esbuild `initialize`), so a compile slowed by CPU contention can be killed and retried, and the retry adds load. Seen as CI run 63, chaos shard 3 (8 players on a 4-vCPU runner): a page at "Starting bundler…" for 30 s at battle start, the same symptom as run 52. Fix: a separate, generous compile-stage bound (or worker heartbeats while compiling); keep the stall retry for real network stalls. Reproduce with CPU contention and 8 concurrent boots. | `packages/runtime/`, `apps/web/` (e2e) | done | Merged |
| T-034 | Free tier: capture + destroy/takedown jobs without an always-on server. Preferred: a Supabase Edge Function (free: 2 s CPU, 500k invocations) run by pg_cron + pg_net, calling Cloudflare Browser Rendering's REST API (free: 10 browser-min/day). A Cloudflare cron Worker would face the same 10 ms CPU limit as T-033. The client thumbnail is the fallback when the budget is spent. | `supabase/` (function, cron), `apps/capture-worker/` (shared code, local stand-in) | done | Merged |
| T-035 | Free tier: public esm.sh as the package CDN (config, CSP, import-map URL shapes); compat suite against esm.sh in GitHub CI (this container cannot reach esm.sh) | `packages/runtime/`, `apps/sandbox-shell/`, `apps/web/`, `apps/pkg-cdn/` (compat), `ci.yml` | done | Merged; CI compat on esm.sh 52/57 → follow-up T-040 |
| T-036 | Free tier: Supabase Free adjustments (keep-alive against the 7-day pause, screenshot size/retention for the 1 GB storage, quotas in docs/07), deploy checklist rewritten for the free setup | `supabase/`, `docs/`, `DEPLOY.md` | done | Merged |
| T-019 | M4 DB layer: REVEAL (order, slots, host skip) + VOTING (categories, no self-vote, revotes, secret ballots) phases, vote-based ranking + category awards, reveal-phase storage read access, realtime `vote_progress` | `supabase/`, `packages/game/` (constants), `ci.yml` | done | Merged |
| T-020 | M4 web: synchronized REVEAL spotlight (one live build, thumbnails, prefetch, host skip), VOTE stage, vote-based results + permanent page | `apps/web/` (+ remove the CI pre-M4 switch) | done | Merged |
| T-021 | M4 completion: mobile reveal/vote layout, player history `/u/[id]`, chaos coverage for reveal/vote, M4 exit criteria | `apps/web/`, `supabase/` (tests) | done | Merged |
| T-011 | DB layer for the solo loop: RPCs (start, advance, ship, snapshot), storage buckets + policies, jobs, deadline sweep, card deck seed; tests on the real local Supabase stack | `supabase/`, `.github/workflows/ci.yml` (db job only) | done | Merged |
| T-012 | Spike: Next.js 16 on Cloudflare Workers via OpenNext (local preview, no account) | `apps/web/` (deploy config only) | done | Merged: GO with caveats |
| T-013 | Capture mode in the shell + local capture/destroy workers (Playwright stands in for Browser Rendering) | `apps/sandbox-shell/`, `apps/capture-worker/` | done | Merged |
| T-014 | Solo game UI: spin → build → ship → results → destroy, plus the `/battles/[id]` results page | `apps/web/` (+ small `supabase/` and `apps/capture-worker/` changes for the autosave CSS) | done | Merged |
| T-015 | Fix flaky playground e2e (`playground.spec.ts:206`): a click right after "Reset to template" is lost, likely a double rebuild replacing the frame (≈1/6 runs) | `apps/web/`, `packages/runtime/` | done | Merged |
| T-016 | M3 DB layer: rooms + members RPCs, multiplayer `start_battle`/`advance_battle` (shipping → results until M4), heartbeat, host migration, abandonment, kick, late joiners as spectators, Realtime broadcast triggers + private-channel authorization | `supabase/`, `ci.yml` | done | Merged |
| T-017 | M3 web: create/join room (code + link), lobby with presence and ready-up, host controls, multiplayer battle flow, realtime sync loop with resync | `apps/web/`, `packages/game/` | done | Merged |
| T-018 | M3 resilience: multi-context Playwright battles with chaos (network drops, clock skew, refresh, host leaves), admin event-log page | `apps/web/` (e2e + fixes), `supabase/` (tests), `apps/capture-worker/` (integration-test isolation) | done | Merged (admin event-log page moved to M5) |
| T-001 | Monorepo skeleton: pnpm + Turborepo, Next.js app, lint/format/strict TS, Vitest, CI | root config, `apps/web/`, `packages/game/`, `.github/` | done | Merged in b29110a |
| T-002 | Supabase scaffold: initial schema migration, Supabase-compatible local Postgres test harness, pgTAP | `supabase/` | done | Merged |
| T-004 | Run DB tests in CI + add a `@br/game` ↔ SQL enum drift test | `.github/workflows/ci.yml`, `packages/game/` | done | Merged |
| T-005 | `/playground` in apps/web: CodeMirror 6, file tree, `@br/workspace` (limits, templates, IndexedDB, paste-import), runtime + preview wiring, console/diagnostics | `apps/web/`, `packages/workspace/` | done | Merged |
| T-006 | `@br/pkg-cdn`: esm.sh-compatible package CDN that resolves from the npm registry, plus an R1 compatibility suite and an e2e CI job | `apps/pkg-cdn/`, `.github/workflows/ci.yml` | done | Merged |
| T-007 | Runtime/shell fixes (5 bugs from T-005), `'unsafe-eval'` in shell CSP, `deps=` peer pinning, web e2e in CI, playground template picker fix | `packages/runtime/`, `apps/sandbox-shell/`, `apps/web/`, `ci.yml` | done | Merged |
| T-008 | Independent security review of sandbox, bridge, playground and package CDN (read-only; M1 exit criterion) | none (report only) | done (partial) | Code review only; PoCs didn't run. Verification moves into T-009. |
| T-009 | Sandbox hardening from T-008 (F2–F4, F6–F9, I1–I3), verified with unit tests (fake ports/windows) and policy-conformance e2e checks | `packages/runtime/`, `apps/sandbox-shell/`, `apps/web/` | done | Merged (attempt 3) |
| T-010 | Package CDN hardening (F5): global download/extract limits, streaming extraction, disk quota/LRU | `apps/pkg-cdn/` | done | Merged |
| T-003 | Sandbox prototype: esbuild-wasm bundler worker, runtime shell, postMessage protocol, mock CDN, Playwright test | `packages/runtime/`, `packages/protocol/`, `apps/sandbox-shell/` | done | Merged in 3172db8 |

## Blocked on the user (only needed for deployment; nothing blocks local work)

Step-by-step: **[DEPLOY.md](../DEPLOY.md)** (free plans; T-036).

| Item | Needed for |
|---|---|
| **Cloudflare, free plan.** Two Pages projects (`build-roulette-web`, `build-roulette-sandbox`) and a Browser Rendering API token. Turnstile is optional (DEPLOY.md §2, §4). | App, sandbox shell, screenshots |
| **Supabase project, Free plan.** `db push`; Auth settings (anonymous sign-ins, URL configuration); the `jobs` function and its secrets; the two Vault secrets (DEPLOY.md §3). | Database, auth, storage, Realtime, jobs |
| **GitHub:** the variable `SUPABASE_URL` and the secret `SUPABASE_ANON_KEY` for the daily keep-alive (DEPLOY.md §5). The repository is public, so Actions minutes are unlimited and CI's nightly run can stay. | Keeping the Free project awake (7-day pause) |
| **First admin(s):** Auth → Add user, then the SQL insert (DEPLOY.md §3.5). | Moderation (`/admin`) |
| Optional: Turnstile keys, with CAPTCHA turned on in Supabase after the app is built with the site key. | Bot protection |
| Optional: Sentry (`NEXT_PUBLIC_SENTRY_DSN`) and PostHog at the web build. The jobs function logs to Supabase. | Errors, analytics |
| Optional: Realtime authorization pool to ~10, if the Free dashboard allows it (unconfirmed). The T-029 join stagger works without it. | Join latency |
| Optional: one domain. The app runs on `*.pages.dev`. | Public launch |
| **Watch, then decide:** Supabase Pro ($25) when the storage meter reaches 80 % (~2,250 battles; screenshots are permanent), egress passes ~4 GB/month, Realtime messages pass ~1.6M/month, or more than ~8 rooms are regularly in BUILD at once (docs/07 §7.8; Health shows the meters). The spend-cap question applies only on Pro. | Growth |
| **M5 exit criterion:** rehearse every runbook once (DEPLOY.md §7 has a drill for each). | M5 sign-off |
| Later: a second usercontent domain + PSL entry (F1). | Per-build isolation |

**User decisions (2026-10-04):** option A, so everything is hosted on Cloudflare and Vercel is dropped. The sandbox starts on `*.pages.dev` (already on the PSL), so there is no second domain at launch. Package CDN runs on Cloudflare Containers. Continue M2 locally.

**User decisions (2026-10-07):**
1. Category awards get one winner. Ties are broken by total votes, then by the earlier ship, instead of sharing.
2. `/battles/[id]` doesn't link names to histories for now; public profile handles come with account linking.
3. A phone player keeps the current behaviour: watch and vote, build ends DNF, warned in the lobby.

Start M5.

**User decision (2026-10-09): deploy on free plans only** (no $5 Workers Paid, no Vercel). Plan: Cloudflare Free (web app on Workers Free if it fits the 10 ms CPU limit, sandbox shell on Pages, screenshots on Browser Rendering's free 10 min/day with the client-thumbnail fallback, jobs on a cron Worker), public esm.sh as the package CDN (Containers are paid-only), Supabase Free, Sentry/PostHog free. Start by measuring the web app's CPU per request (T-033); if it can't fit, come back to the user with options. → T-033…T-036.

**User decision (2026-10-09, after T-033's NO-GO): option C**, the web app as a static site on Cloudflare Pages with client-side data, plus a tiny Pages Function for link previews. → T-037, T-038.

**User decision (2026-10-08):** a taken-down build keeps its rank (results are permanent, nothing is re-ranked) but loses the "Winner" highlight and all awards (vote and auto) on every public surface. Awards are not reassigned to another build. → T-028.

**User decisions (2026-10-06):** keep the `speedrun` award; the time limit stays server-random (5/10/15 min, like a fourth card); start M3. In M3, multiplayer battles go `shipping → results` like solo, and M4 inserts REVEAL + VOTE.

## Done

- T-001 Monorepo skeleton
- T-002 Supabase schema + RLS + test harness
- T-003 Sandbox runtime prototype
- T-004 DB tests in CI + schema drift test
- T-005 Playground (editor, file tree, workspace persistence)
- T-006 Package CDN + R1 compatibility suite
- T-007 Runtime/shell fixes + polish
- T-008 Security review (code-level)
- T-009 Sandbox hardening
- T-010 Package CDN availability hardening
- T-011 Solo-loop DB layer
- T-012 OpenNext / Cloudflare Workers spike
- T-013 Capture mode + capture/destroy workers
- T-014 Solo game end to end
- T-015 Lost click after template reset (root-cause fix)
- T-016 M3 DB layer: rooms, multiplayer, realtime
- T-017 M3 multiplayer web UI
- T-018 M3 resilience / chaos
- T-019 M4 DB layer: reveal + voting
- T-020 M4 web: reveal + vote
- T-021 M4 completion: mobile, history, chaos
- T-022 Single-winner awards + voting sweep
- T-023 Chaos reliability + sharding
- T-027 Watchdog load grace
- T-024 Abuse controls + admin
- T-025 Load test + cost model

## Review log

### T-001: accepted (wave 1)
- Hub re-ran on a fresh clone: `install --frozen-lockfile`, `format:check`, `lint`, `typecheck`, `test` (84/84), `build`. All green.
- Stack: Next 16.3.8, React 19.3, Tailwind 4.3, TS 6.0.3 (capped by typescript-eslint peer range), ESLint 9 (capped by eslint-config-next plugins), Vitest 5, Turbo 2.11.
- `@br/game` is consumed as TS source via `transpilePackages` (no build step).
- Follow-ups:
  - Add a drift test between `@br/game` phases/durations and the SQL enum (after T-002).
  - Decide whether the SQL reveal slot rounds (`revealSlotSeconds` does not).
  - Verify the GitHub Action major versions (checkout@v6, setup-node@v6, pnpm/action-setup@v4) on first CI run.
  - Markdown is excluded from Prettier.

### T-002: accepted (wave 1)
- Hub re-ran `bash supabase/scripts/test.sh` on a fresh clone: 194/194 pass, exit 0. Root `format:check` still passes with the new files.
- Reviewed the RLS helpers (`is_room_member`, `is_battle_member`, `can_view_battle`): `security definer`, `search_path=''`, no write policies anywhere.
- Fixed a doc bug: votes and awards could reference a build from another battle. Composite FKs to `builds(id, battle_id)` now prevent it.
- Shim lives in `supabase/scripts/shim/` (not `tests/`), so `supabase test db` won't run it as a test.
- Supabase CLI v2 works from npm (no GitHub download). `migration up --db-url` applied cleanly. `db reset` / `test db` need Docker and are untested.
- Decisions taken by the hub:
  - A kicked roster player can still read their battle (it becomes public at results anyway). Revisit when the `kick_member` RPC lands.
  - Abandoned battles are not public.
- Follow-ups:
  - Later RPC migrations must grant explicitly (default privileges are revoked) and revoke EXECUTE from `anon`.
  - `config.toml`: add `enable_manual_linking` and captcha (Turnstile) in M3.
  - Extend the shim for `storage` before the storage policy task.
  - ~~Wire DB tests into CI~~ and ~~add the drift test~~: done in T-004.

### T-004: accepted (wave 2)
- Hub re-ran on a fresh clone: format/lint/typecheck/test (90/90) and DB harness (194/194). All green.
- New CI job `db`: pinned PostgreSQL 16 + pgTAP from the Ubuntu archive, with a PGDG fallback. Linted with actionlint. A real GitHub run is not verified yet.
- Drift test replays all migrations, including `alter type ... add value`. Negative checks (swap, add, rename) fail as expected.
- `packages/game/turbo.json` adds migrations to the test inputs, so the turbo cache can't hide drift.
- Follow-up: vote categories drift check, once `@br/game` exposes categories.

### T-003: accepted (wave 1)
- Hub test-merged onto main (clean, no conflicts) and re-ran on a fresh clone:
  - install, format, lint, typecheck, build: green;
  - unit tests: game 90, protocol 15, shell 5, runtime 40;
  - e2e: 13/13;
  - DB: 194/194.
- Measured, reproduced by the hub (localhost, 4 vCPU):

  | Metric | Result | Budget |
  |---|---|---|
  | Worker cold start | ~200 ms | < 3 s |
  | First preview | ~525 ms | < 1 s |
  | Rebuild + refresh | p50 124 ms, p95 190 ms | 300 / 800 ms |
  | Watchdog | ~5.1 s | ≤ 6 s |

  Budgets from docs/03 §3.8 are met. Download time is not included: esbuild.wasm is 2.7 MB brotli.
- Security review: both sides of the handshake check origin and source. The port and nonce are used after the handshake. Inbound messages are zod-validated.
- Design findings, now written into the docs:
  - Watchdog requires site isolation (docs/02 R2).
  - CSP needs `'unsafe-inline'` for the import map (docs/03 §3.5).
  - Fresh child iframe per load (docs/03 §3.5).
- Hub decisions:
  - Shell is 12 KB gzip (mostly zod). Accepted for now; hand-written validators in the shell are a low-priority follow-up.
  - Playwright is pinned to 1.56.1 to match the preinstalled Chromium.
  - React from the CDN is the production build. Fine.
- Follow-ups (go into M1 wave 3):
  - R1 package compatibility suite (curated top-N list) against the mock CDN, which should grow into the self-hosted CDN.
  - esbuild incremental context, sourcemaps for runtime errors, safe-mode restart.
  - Integrate into `apps/web`: CodeMirror editor, IndexedDB workspace, worker + wasm serving and lobby preload.
  - e2e in CI with `channel: 'chromium'` (needs a Playwright browser install step in CI).
  - Capture mode and client thumbnail (M2).

### T-005: accepted (wave 3)
- Hub test-merged onto main (clean; only `apps/web`, `packages/workspace` and the lockfile changed). Re-ran on a fresh clone:
  - install, format, lint, typecheck, build: green;
  - unit tests: workspace 149, game 90, protocol 15, shell 5, runtime 40;
  - web e2e: 9/9;
  - runtime e2e: 13/13.
- Hub took a manual screenshot of `/playground` on `next start`: the editor, file tree and preview render, with "Built in 370 ms" shown.
- Worker served via `new URL('./bundler.worker.ts', import.meta.url)` (Turbopack). The wasm is a content-hashed asset via a Turbopack rule. The build fails if esbuild-wasm versions drift.
- The landing page bundle contains no editor or runtime code (verified by grepping the chunks).
- Bugs found in `@br/runtime` / shell (not fixed in T-005), now T-007:
  1. `BundlerClient.terminate()` never settles a pending `init()`, so `boot()` hangs under StrictMode.
  2. `scheduleBuild` → `void this.build()` gives unhandled rejections if init failed, and a failed init is never retried.
  3. `workerUrl` is required even when `createWorker` is given.
  4. The shell sets both `allow` (with fullscreen) and `allowfullscreen`, which logs a console warning.
  5. The README must say that `PreviewHandle` removes the iframe on crash.
- Other follow-ups:
  - Switch the sandbox servers and the React-pin drift test to the T-006 CDN.
  - Add web e2e to CI.
  - Ignore or disable the `AGENTS.md`/`CLAUDE.md` files that `next dev` generates.
  - The template picker shows `react-ts` after a reload.
  - "Add dependency" chip UI.

### T-006: accepted (wave 3)
- Hub test-merged onto main: the lockfile auto-merged and `pnpm install --frozen-lockfile` passes. Re-ran on a fresh clone:
  - format, lint, typecheck, build: green;
  - unit tests: pkg-cdn 81, plus all other packages;
  - runtime e2e 13/13 (in the worker's run).
- **Hub reproduced the R1 compat suite on an empty cache against the live npm registry: 52/55 (94.5%), with the same 3 failures.** The R1 exit criterion (≥ 90%) is met.
- Security skim of `tar.ts`:
  - regular files only, so symlinks and hardlinks are skipped;
  - `..` and absolute paths are rejected;
  - files are written `wx` with mode 0644;
  - unpacked size is capped while inflating.

  The integrity hash must be sha512. Package code is never executed.
- CI now has an `e2e` job (Playwright Chromium install) and a manual `compat` job (`workflow_dispatch`). Neither has run on GitHub yet.
- Hub decisions:
  - Add `'unsafe-eval'` to the shell `script-src`. Same reasoning as `'unsafe-inline'`: a build is arbitrary JS. It fixes pixi v8 and anything else that uses `new Function`. Goes into T-007.
  - The runtime's cdn-rewrite appends `&deps=` with the manifest's pinned peers. Goes into T-007.
  - matter-js named imports: accept as a known limitation, and later add a diagnostic hint suggesting the default import.
  - Package CDN hosting is a Node origin behind the Cloudflare cache (docs/01 updated). Fly.io vs Cloudflare Containers is a user decision before M5.
- Follow-ups (later):
  - shared chunks per package (subpath duplication);
  - `?exports=` tree-shaking for icon libraries;
  - cache eviction;
  - runtime e2e against pkg-cdn with an offline fixture registry.

### T-008: done, partial (wave 4)
- Code review only. A safety classifier stopped the reviewer before any PoC ran. The repo was not changed.
- Findings: 1 High (F1, same-site per-build subdomains, so PSL is needed), 4 Medium (F2 shell takeover → port forgery, F3 shell-realm persistence, F4 app-side flood, F5 CDN DoS), 4 Low, 3 Info.
- Verified OK by code: no `dangerouslySetInnerHTML`/`innerHTML` in the app (F); the bundler worker fetches only `cdnBaseUrl` with `credentials: 'omit'` (G); pkg-cdn traversal and integrity guards (H).
- Hub assessment: the findings are credible and consistent with the hub's own T-003 review. The PoCs will be written as regression tests in T-009, so every fix comes with a browser test. Threat model updated (docs/03 §3.9, "Review findings").
- Hub decisions:
  - all shell messages are untrusted, and capture readiness is decided server-side;
  - no `allow-popups`/`clipboard-write` in reveal/capture modes;
  - PSL submission goes on the user's list.

### T-007: accepted (wave 4)
- Hub test-merged onto main and re-ran on a fresh clone:
  - install, format, lint, typecheck, build: green;
  - unit tests: runtime 64 (was 40), all others unchanged;
  - runtime e2e 15/15, web e2e 11/11.
- **Hub reproduced compat on an empty cache: 54/55 (98.2%).** Both pixi.js cases now pass thanks to `'unsafe-eval'`. The only failure is matter-js named imports (accepted).
- Every fix has a regression test that the worker showed failing on the pre-fix code.
- Accepted deviation: `deps=` includes the package itself. Otherwise the user's import URL and a peer URL emitted by the CDN differ, which duplicates three.js. Cost: changing any dependency changes every CDN URL in that build (cache miss).
- Docs updated: CSP now includes `'unsafe-eval'` (docs/03 §3.5), R1 at 54/55 (docs/02).
- Follow-up: refresh `apps/pkg-cdn/compat/RESULTS.md` after T-010 merges (T-010 owns that folder).

### T-010: accepted (wave 4)
- Hub test-merged onto main and re-ran on a fresh clone:
  - install, format, lint, typecheck, build: green;
  - unit tests: pkg-cdn 118 (was 81), all others unchanged.
- **Compat on main (with T-007's `'unsafe-eval'`) is 54/55.** The hub regenerated and committed `RESULTS.md`. The worker's own 52/55 came from a branch older than T-007.
- Hardening:
  - global limiters (registry 16, extraction 4, build 4) with bounded queues and 503 + `Retry-After` load shedding;
  - AbortSignal on client disconnect or the 90 s deadline;
  - SingleFlight coalescing that never caches errors;
  - streaming integrity check + gunzip + tar with limits checked before inflating (gzip-bomb tests);
  - lower defaults justified by measuring all 279 packages;
  - disk quota (5 GB) with LRU, leases and crash-safe eviction;
  - `/health` metrics;
  - edge caching and rate-limit guidance in the README.
- Finding F5 is mitigated.

### T-009: attempts 1–2 did not produce code
- Attempt 1: interrupted by the API usage limit, nothing committed.
- Attempt 2: a safety classifier stopped the worker while it was drafting "attacker build" browser fixtures, before any change. Same pattern as T-008.
- Attempt 2 did produce useful code-reading notes:
  - I3: `parseBareSpecifier` accepts percent-encoded dot segments.
  - The dev-server 404 branch has no security headers, and `_headers` covers only `/v1/*`.
  - `connect-src` lacks `'self'`, which a `/v1/reset` endpoint will need.
  - `PreviewHandle` accepts a new `hello` at any time.
  - Ping is answered from the port listener.
  - Restart already creates a new iframe.
  - The `reset-storage` cookie wipe only covers `path=/`.
  - Console updates are unbatched and uncapped.
- Hub decision: same goals, re-scoped verification. Fixes are proven with unit tests (fake ports/windows/sources) and plain policy-conformance e2e checks (headers, iframe attributes, storage wiped, `window.open` blocked in reveal mode) instead of exploit-style fixtures.

### T-009: accepted (wave 5, attempt 3)
- Hub test-merged onto main and re-ran on a fresh clone:
  - install, format, lint, typecheck, build: green;
  - unit tests: runtime 96 (was 64), shell 19 (was 5), web 6 (new), others unchanged;
  - runtime e2e 23/23, web e2e 11/11.
- Hub read the handshake guard (`awaitingHello`, `ignoredHellos`) and the per-mode attribute tables.
- Each change has a test that the worker showed failing on the old code, by mutation or by reverting the file.
- Decisions:
  - `allow-modals` is dropped in reveal/capture, so other people's alerts can't block the viewer or stall capture;
  - `form-action 'none'`;
  - `bluetooth` is left out of Permissions-Policy (Chromium doesn't recognise it);
  - the protocol stays at v1 because nothing is deployed yet. **Bump to v2 before the first deploy.**
- Docs: mitigation table added to docs/03 §3.9.

### T-012: accepted (M2 wave 1), GO with caveats
- Hub test-merged and re-ran:
  - format, lint, typecheck, test, build: green;
  - **web e2e against the Workers preview: 11/11**;
  - `wrangler deploy --dry-run`: 4047 KiB raw / **829 KiB gzip**.
- Out-of-scope edits accepted, all minimal:
  - root `.gitignore`/`.prettierignore` gain `.open-next/`, `.wrangler/`, `.dev.vars*`;
  - `workerd` goes into `ignoredBuiltDependencies`, the same pattern as esbuild.
- Rules recorded in docs/01: Workers Paid; no `proxy.ts` unless needed; R2 incremental cache for `/battles/[id]` ISR; `metadataBase` for OG; deploy via `cf:deploy`.
- Follow-up (T-014): `/battles/[id]` ISR on the R2 cache, plus `metadataBase`.

### T-011: accepted (M2 wave 1)
- The worker was interrupted once by the usage limit and resumed with its context intact.
- Hub test-merged and re-ran on a fresh clone with the real local Supabase stack:
  - `supabase test db`: **462/462**;
  - `e2e-solo.mjs`: **44/44**, including pg_cron advancing a battle on its own;
  - repo format, lint, typecheck, test (game 93), build: green.
- Hub read the storage policies: owner-only writes through `can_write_build_object` (draft + phase + deadline), owner-only reads, no client deletes, no screenshot writes.
- The plain-Postgres harness is retired, and CI's `db` job now runs `supabase start` + `test db` + `e2e-solo.mjs`. Check the first GitHub run.
- Accepted product call: a new solo auto-award, `speedrun` (shipped using ≤ 50% of the time).
- Implementation notes recorded in docs/05 §5.7.

### T-013: accepted (M2)
- The worker was interrupted once by the usage limit and resumed.
- Hub test-merged and re-ran on a fresh clone with the real local Supabase stack:
  - repo pipeline green (capture-worker 63 unit tests, shell 47);
  - `supabase test db` 462/462;
  - **capture integration 12/12** (real Chromium + real Supabase: captured, fallback, auto_shipped, retry → failed, destroy leaves zero objects);
  - runtime e2e 23/23, web e2e 11/11.
- Hub looked at the produced screenshot: 1280×800 WebP with the build's real content.
- Design: an HMAC capture gate on the server side (Pages `_worker.js`), so there's no secret in public JS; renderer-decided readiness; navigation guard; sharp WebP; a blank check that falls back to the client thumbnail. Recorded in docs/03.
- Follow-ups:
  - the autosave has no CSS slot, handled in T-014;
  - the production Browser Rendering adapter is still a stub (needs an account);
  - the capture gate isn't verified in workerd;
  - `_worker.js` is 67 KB because of zod;
  - the web e2e file-tree test flaked once under heavy load. Watch it.

### T-014: accepted (M2, last task)
- Hub test-merged and re-ran on a fresh clone with the real local Supabase stack:
  - repo pipeline green: 663 unit tests, including web 70, runtime 99, shell 53;
  - `supabase test db` 492/492;
  - capture integration 12/12;
  - **solo e2e 2/2 on two runs** (ship → real screenshot + speedrun → destroy → permanent page; auto-ship with CSS);
  - runtime e2e 25/25.
- Web e2e: 12/13. The file-tree test (`playground.spec.ts:206`) failed. The hub repeated it 6×: 1 failure. A click right after "Reset to template" is lost (the counter stays at 0).
  - It's pre-existing: it also flaked once during T-013, so it isn't a T-014 regression.
  - It's likely a real UX bug (a double rebuild after reset replaces the frame), so it goes to **T-015** rather than a test retry.
- Hub viewed the 4 UI screenshots (spin, build, results, permanent page). The flow and design are good.
- Accepted scope extensions:
  - client thumbnail in the shell + `PreviewHandle.captureThumbnail()`;
  - a shell focus fix: live-mode frames no longer steal keyboard focus from the editor, covered by e2e.
- UX decisions relayed to the user: reel timing; the server picks the time limit; BUILD preloads under the spin; ship the last working preview if the production build fails; amber at 60 s and red at 10 s; 60 s last look; stats on the permanent page.
- Follow-ups:
  - OG image can't embed WebP (the worker should also emit a PNG card, or use CF image transforms);
  - ISR on R2 for `/battles/[id]`;
  - the local auth limit of 30 anonymous sign-ups per hour affects repeated test runs;
  - realtime instead of polling (M3).

### T-015: accepted
- **The hub's hypothesis (double rebuild) was wrong.** The worker proved with instrumentation that a reset makes exactly one build and one load.
- **Root cause:** until that load arrives, the *old* project's preview stays live and accepts clicks. Both templates show "Clicked 0 times", so the click hit the stale page and was lost. 7 of the 10 old "passing" runs were checking the old page.
- **Second bug:** concurrent builds could deliver an older result after a newer one.
- **Fix:**
  - `SandboxController.replace()` swaps files and manifest atomically, replaces the preview iframe immediately, and builds immediately (newest wins);
  - `EsmBrowserRuntime` delivers `onBuild` results in start order;
  - used by template reset/switch and paste-import replace mode (`/playground` and `/play`).
- **Tests:**
  - the e2e now clicks right after reset and asserts the new page: 9/10 fail on the old code, 10/10 pass after;
  - runtime and controller unit tests fail on the old code.
- Hub re-ran:
  - pipeline green (runtime 101, web 75);
  - runtime e2e 25/25;
  - **playground e2e ×5: 70/70**;
  - solo e2e 2/2 on the real stack.
- Known limitation: "Restart preview" after a failed build of a replaced project reloads the last good (old) build. Leave as is for now.

### T-016: accepted (M3 task 1)
- Hub test-merged and re-ran on a fresh clone, with the real local stack **including Realtime**:
  - repo pipeline green;
  - `supabase test db` **762/762**;
  - `e2e-solo` 44/44, `e2e-multiplayer` 48/48, `e2e-realtime` 33/33 (non-members refused, Presence for members only).
- Capture integration: **12/12 on a fresh DB**. It fails 2/12 when run after the multiplayer/realtime scripts on the same DB, because the test assumes an empty job queue and the worker legitimately claims leftover jobs.
  - It's test isolation, not a product bug. CI isn't affected (the capture job uses a fresh stack).
  - Hardening the test goes into **T-018**.
- Key decisions, recorded in docs/04 §4.10 and docs/05 §5.7:
  - `realtime.send` from event-log triggers (not `broadcast_changes`, which would leak full rows);
  - client Broadcast refused, Presence-only for active members;
  - kicked users lose battle visibility until RESULTS;
  - heartbeat every ~10 s;
  - M3 ranking by completion time;
  - `reveal_vote` flag as the M4 seam.
- Open: kicked users' already-open subscriptions keep receiving until they rejoin; turn off public Realtime channels in production; rate-limit join attempts by code (Turnstile).

### T-017: accepted (M3 task 2)
- Hub test-merged and re-ran on a fresh clone with the real local stack (Realtime on):
  - repo pipeline green (web 162 unit tests, game 108 including new drift checks);
  - solo e2e 2/2.
- **Multiplayer e2e:**
  - first run (fresh build + `db reset`, cold caches): **the main 3-player test failed once**, and the error wasn't captured;
  - after that: 2/2, then a repeat of the whole suite 6/6, then 6/6 of the main test alone.
  - So the main test fails about 1 in 10, plausibly cold-start timing. Root-causing it is now an explicit **T-018** item.
- Hub viewed 4 UI screenshots (lobby, BUILD with progress sidebar, spectator, ranked results with awards). Good.
- Decisions relayed to the user: Presence on the room topic only; auto-return to lobby after DESTROY with a "Last battle" podium; spectators get no last look; the ship dialog closes into a "locked" banner (solo too); only `max_players` in host settings until M4.
- Bugs the worker found and fixed: no last look for an auto-shipped player; the ship dialog stayed open.
- Test workaround to revisit in T-018: `bringToFront()` before clicks in background windows.

### T-018: accepted (M3 task 3). **M3 complete.**
- Hub test-merged and re-ran on a fresh clone with the real stack (Realtime on):
  - pipeline green (web 176 unit tests);
  - `supabase test db` 762/762;
  - e2e scripts 44/48/33;
  - **capture integration 12/12 after the other scripts on the same DB** (isolation fixed);
  - **cold-start multiplayer e2e 3/3** (fresh `.next` + `db reset`);
  - **chaos e2e 6/6 (9.3 min)**;
  - solo 2/2, runtime 25/25, playground 14/14.
- The cold-start flake was a test artefact. Chromium routes the first click after `showModal()` over a cross-site iframe by stale compositor hit-test data; the worker measured up to 21 of 40 clicks lost under CPU load. The fix is `clickRouted()`, which waits until the element itself receives a `pointermove`. 11 consecutive cold runs passed. `bringToFront()` is removed.
- **Real product bugs found and fixed:**
  1. Supabase Realtime closed the room channel of any steadily typing player (more than 5 Presence messages per 30 s), and the client never rejoined.
  2. A network drop wasn't detected for about 50 s.
  3. "Reconnecting" was only shown in the lobby.
  4. Abandoned battles said "Nobody shipped".
  5. The sync engine froze after 2 version gaps.
  6. A room battle deleted the workspace of a solo battle running in another tab.
- M3 exit criteria (docs/06): all met. The chaos suite runs nightly in CI (too long for every push). The admin `battle_events` page was not built; it moves to M5 (observability).
- Open for later:
  - "typing" activity lags because of the 4-per-30 s cap;
  - abandoned battles lose the screenshots of shipped builds;
  - the chaos suite uses 27 anonymous sign-ups per run.

### T-019: accepted (M4 task 1)
- Hub test-merged and re-ran on a fresh clone (Realtime on):
  - pipeline green (game 120 unit tests, with new drift checks);
  - `supabase test db` **926/926**;
  - `e2e-solo` 44, `e2e-multiplayer` 49, `e2e-realtime` 34, **`e2e-reveal-vote` 50**;
  - capture integration 12/12 after the scripts;
  - web multiplayer e2e 3/3 with the temporary pre-M4 switch.
- Hub checked the switch: `private.app_settings` is a private table with no API access, and production has no row, so the default stays reveal+vote ON. **T-020 must remove both CI steps.**
- Decisions recorded in docs/04 §4.11:
  - the slot is based on the number of final builds, and `revealSlotSeconds` now rounds;
  - early end of voting is based on presence;
  - tallies are frozen in `builds.vote_counts`;
  - spectators can watch the reveal;
  - `manifest.json` instead of exposing `source.json`;
  - fewer than 2 final builds skip to RESULTS.
- The web e2e that break without the switch: multiplayer main test, chaos 6-player, seeded random, and all-closed-at-T-0. Fixing them is part of T-020.

### T-020: accepted (M4 task 2)
- Hub test-merged and re-ran on a fresh clone. The pre-M4 CI steps are gone (0 left) and `private.app_settings` has 0 rows, so REVEAL/VOTE are ON everywhere:
  - pipeline green (web 222 unit tests);
  - `supabase test db` 926/926;
  - **multiplayer e2e 3/3 on a cold start** (fresh `.next` + `db reset`);
  - **chaos 6/6 (10.6 min)**, including the host vanishing mid-REVEAL and pg_cron alone running REVEAL + VOTING;
  - solo 2/2, playground 14/14, runtime 25/25.
- Hub viewed the reveal, vote and results screenshots. Good.
- Two chaos failures during development were test races and were fixed and explained: closing contexts took longer than the final-autosave margin, and the random loop shipped everyone, ending BUILD early.
- Product question for the user: with tie-sharing, a 3-way tie in a category gives everyone that award (seen in the screenshot: three "Best Build" badges with 1 vote each).
- Gaps (→ T-021):
  - mobile REVEAL/VOTE;
  - `/u/[id]` history page;
  - chaos: a drop mid-VOTE and a refresh mid-REVEAL;
  - lobby UI for `reveal_slot_s` / `voting_s` / `reveal_vote`;
  - `handshake-timeout` shown as "froze";
  - the RESULTS last-look pane doesn't wipe storage first;
  - the latest-click vote queue is covered by unit tests only.

### T-021: accepted (M4 task 3). **M4 complete.**
- Hub test-merged and re-ran on a fresh clone:
  - pipeline green (web 243 unit tests);
  - `supabase test db` **962/962**;
  - multiplayer e2e including mobile **4/4**;
  - solo 2/2, runtime 25/25, playground 14/14.
- **Chaos:**
  - 1st full run: **7/8**, with the new 8-player test failing (the error wasn't captured);
  - the same test alone: 3/3;
  - 2nd full run: **8/8 (12.8 min)**.
  - So the 8-player test failed 1 in 5. It needs a root cause in M5 (it would produce noise in nightly CI). The product path itself (an 8-player battle) completed 4 times.
- Hub viewed the mobile reveal/vote, lobby settings and history screenshots. Good.
- Bugs the worker found and fixed: one-column grids overflowing at 390 px (a 510 px page); the vote queue dropping the next click after a refused one.
- Decisions relayed to the user:
  - a phone player watches and votes, and their build is DNF;
  - REVEAL on touch devices is screenshot-first;
  - history belongs to the anonymous user;
  - unsent votes are shown as "Not counted".
- **Open product questions for the user:**
  - shared awards on ties;
  - whether `/battles/[id]` should link names to histories (that would need public ids or handles).
- M4 exit criteria:
  - met in Chromium, desktop and phone emulation (2/4/6/8-player battles);
  - tie-breaks covered by tests;
  - ballot secrecy covered by tests;
  - Firefox, Safari and real phones not verified (only Chromium is available here).
- Into M5:
  - root-cause the flaky 8-player chaos test;
  - VOTING early end in the sweep;
  - shard the chaos suite (12–13 min);
  - ISR for `/u/[id]` and `/battles/[id]`;
  - the admin event-log page;
  - real-browser testing (Firefox/Safari/real phones) once deployed.

### T-022: accepted (M5 task 1)
- Hub test-merged and re-ran on a fresh clone:
  - pipeline green (game 125 unit tests, with new drift checks on `finalize_votes` and the sweep);
  - `supabase test db` **985/985**;
  - e2e scripts 44/49/34/50;
  - capture integration 12/12;
  - multiplayer e2e including mobile 4/4.
- Rule: top count → total votes → earlier ship → lower build id. Vote ranks use `row_number()` (one winner banner, Best Build on rank 1). Legacy battles are never recomputed.
- The worker found that rank ties are reachable in practice (auto-shipped builds share `shipped_at`), so the tie-break is applied to ranks as well. Accepted.
- VOTING early end is now re-checked by the 5 s sweep (not in heartbeat, to keep it off the busiest RPC). The chaos test now covers it end to end.
- Mutation checks: the old function fails the new pgTAP; the drift tests fail without the migration.

### T-023: accepted (M5 task 2)
- **The flaky 8-player test was reproduced and root-caused, with evidence. There were two causes:**
  - **(A) Lost broadcasts.** Local Realtime v2.140 terminates its tenant DB connection every 10 min ("rebalancing": local region ≠ tenant region). Broadcasts are lost until a client joins a channel, and channels stay SUBSCRIBED meanwhile. Fix: the heartbeat checks the battle version and refetches.
  - **(B) A real product bug.** The host's Next lost a version race to the capture burst at the start of REVEAL, and was silently dropped. Fix: a bounded resend while it's still the same spotlight.
  - Both fixes have tests that fail without them, including a new chaos test that cuts the Realtime feed mid-REVEAL.
- New failure diagnostics on every rooms/chaos test: per-page state, logs and Realtime frames, a DB snapshot, service logs, and container logs.
- **CI:** chaos is now a 3-shard matrix on every push (about 5 min of tests per shard, each with its own stack), plus nightly. A CI bug was also fixed: a push cancelled the nightly run, because they shared a concurrency group.
- Hub re-ran on a fresh clone: pipeline green (web 247 unit tests); multiplayer e2e 4/4; **full chaos 9/9 (12.4 min)**.
- A third flake was found but is out of scope: a false preview watchdog crash under heavy CPU load. It's now **T-027**.
- A full chaos run signs up 41 anonymous users.

### T-027: accepted (M5 task 3)
- Root cause measured: a `load` = two long shell tasks (frame swap, then module evaluation). With x20 CPU throttling the longest pong gap was 2980 ms and ended right at `ready`. The 5.3 s chaos silence is the same effect at a higher slowdown.
- Fix: a 15 s load grace in `PreviewHandle`. It's opened only by the app's own `load` send, `ready` can only shorten it, it's bounded, and it's cleared on a new shell. A loop after `ready` is still caught in about 5 s; a loop during the load within about 15.25 s (the trade-off).
- The new throttled e2e fails on the old code with `heartbeat-timeout silentForMs 5121`.
- Hub re-ran on a fresh clone: pipeline green (runtime 112, web 250); runtime e2e 26/26; playground 14/14; multiplayer 4/4; solo 2/2. The worker also ran chaos shard 1: 3/3.
- docs/03 updated with the load-grace section.

### T-024: accepted (M5 task 4)
- Hub test-merged and re-ran on a fresh clone:
  - pipeline green (web 279, game 134, capture-worker 73 unit tests);
  - `supabase test db` **1166/1166**;
  - e2e scripts 44/49/34/50/**21 (moderation)**;
  - capture integration 13/13;
  - moderation e2e 2/2, multiplayer 4/4, solo 2/2;
  - **chaos shards 3/3, 2/2, 4/4**;
  - runtime 26/26, playground 14/14.
- Security read:
  - `is_admin()` requires a non-anonymous JWT, a non-anonymous auth user, and membership in `private.admins` (a trigger refuses anonymous users);
  - admin cookies are httpOnly, SameSite=Strict, `/admin`-scoped and Secure on https (unit-tested);
  - `/admin` 404s for non-admins;
  - admin RPCs run with the admin's own token (no service key in the web app).
- Better than the brief: the takedown hides the build immediately in the RPC; the worker only deletes the file.
- The worker hardened the T-023 lost-feed chaos test: the local Realtime restarts its tenant on a 5-min timer, and an in-flight event can arrive about 0.6 s after the cut.
- **Product question for the user:** a build taken down after RESULTS keeps its rank and still shows the "WINNER" banner (seen in a screenshot). The hub recommends no winner banner and no awards for taken-down builds, without re-ranking.
- Production setup items were added to "Blocked on the user".

### T-025: accepted (M5 task 5)
- `@br/loadtest`: real clients via supabase-js (no browsers). Covers rooms, Presence, heartbeats with the version check, autosave/ship uploads, REVEAL downloads, votes, the capture worker, and time compression via SQL. Smoke and full profiles; a `workflow_dispatch` CI job.
- **Results:**
  - **Full target 50 rooms × 8 players × 2 battles (400 clients, 100 battles):** phase propagation p95 **137.6 ms** with Realtime quotas "Pro without spend cap". **M5 criterion met.**
  - With the assumed "Pro with spend cap" Presence quota (50/s): **not met** (p95 1.9 s, 95% delivery, 17.7k channel closes).
  - One 4-vCPU container; battles about 10× compressed.
- **Cost (prices *assumed* 2026-10-07; usage *measured* and extrapolated):**
  - about $50.6/month up to about 1,000 battles/month (fixed costs dominate);
  - about $138/month at 10,000 battles/month ($13.8 per 1,000);
  - about $17.5 per 1,000 extra battles beyond the included quotas.
- Bottlenecks, in order:
  - Realtime Presence quota;
  - Browser Rendering hours (~1,000 battles/month);
  - Realtime messages (~1,360);
  - the nudge storm in RESULTS while captures are backlogged (41% of requests);
  - Realtime `db_pool = 1` (battle joins p95 23 s);
  - storage RLS lookups on reveal downloads.
- Test-only stack tweaks (Kong `worker_connections`, Realtime tenant quotas) are applied at runtime inside the local containers and restored. They are not committed config.
- Hub re-ran on a fresh clone: pipeline green (loadtest 14 unit tests); **smoke profile on a fresh stack: 3/3 battles, p95 17.4 ms, 100% delivered, 0 errors**. The full 400-client run was not re-run by the hub (about 40 min).
- Product fixes queued as **T-029**. The spend cap and `db_pool` go on the user's deploy checklist.

### T-028: accepted (M5 task 6)
- The first worker was lost in a container restart (no commits); re-dispatched with the same brief.
- **Server:** new migration `20261008130000_takedown_awards.sql`. `get_public_battle`, `get_player_history` and `get_battle_snapshot` are T-024's versions with only the `awards` reads changed (the hub diffed each function against T-024's). The stored `awards` rows are untouched.
- **Better than the brief:** the `awards_select` RLS policy also hides the awards of a taken-down build from direct table reads. Without it, any signed-in viewer of the battle could still read them.
- **Web:** shared helpers `isWinner`, `awardsOf`, `rankMedal` (`lib/solo/format.ts`) used by room RESULTS, `/battles/[id]`, `/u/[id]` and solo results. The OG text moved to `lib/solo/og-card.ts`: a removed rank-1 build gets a neutral "#1 · n VOTES" chip; nobody is promoted.
- **Decisions:** vote counts stay visible on a removed build (the hub's recommendation); no medal either (a gold highlight, treated like the banner).
- **Tests:** new pgTAP `23_takedown_awards` (24 tests; 11 fail on the T-024 functions); component tests (9 fail when the helpers are broken); `e2e/moderation.spec.ts` checks banner, chips, "#1 Removed by moderators", kept vote total, the runner-up not promoted, OG 200, `/u/[id]`.
- Hub re-ran on a fresh clone: pipeline green (web 296 unit tests); `supabase test db` **1191/1191**; `e2e-moderation.mjs` **26/26**; moderation e2e 2/2; multiplayer 4/4; solo 2/2. Screenshot checked: "#1 Removed by moderators", no banner, ring or chips, 3 votes kept; #2 keeps Best Style without a banner.

### T-029: accepted (M5 task 7)
- **Presence:** activity goes out only during BUILDING, at most once per 15 s, and only on changes that matter (`activityMatters`: active on/off, a build failing for ≥ 10 s or fixed, ±20 lines). The claim after each (re)subscribe stays. The sidebar's "typing…" became "✎ active" (edited in the last 15 s); the wire name `typing` is kept, so old clients still work.
- **Rejoin backoff** after a server-closed channel: 5, 10, 20, 30 s plus up to 50 % jitter; a SUBSCRIBED doesn't reset it, it decays one level per 60 s up.
- **Nudges:** 5, 10, 20, then 30 s while the battle doesn't move. RESULTS is not nudged while a screenshot is pending (the sweep ends it), then nudged once. Two solo bugs were fixed along the way: a 250 ms poll after a deadline, and a clock resync that never fired.
- **Heartbeat** (`20261008140000_heartbeat_battle_version.sql`) also returns `battle_id` and `battle_version`. The hub diffed it against T-016's: only the two fields were added. The client's extra version read is gone.
- **Clock:** best of 3 on open and on recovery; the 60 s resync takes 1 sample and drops a slow one. **Battle-topic join** staggered 0–500 ms.
- **Load test, before → after** (50 × 8 × 2, pro-nocap):
  - phase p95 181 → 153 ms;
  - Presence 7.96 → 2.99 sends per BUILDING minute;
  - Realtime messages per real battle 3,652 → 1,490;
  - API calls 34.1 → 13.0 per client-minute;
  - RESULTS nudges 264 → 0.02 per battle;
  - timeouts 35 → 0;
  - cost per 1,000 battles at 10,000/month $13.75 → $8.34.
- **Spend-cap quota (assumed 50/s):** 10 × 8 rooms 0 closes (was 4,571); 50 × 8 rooms 1,703 closes (T-025: 17,726), with no storm. Presence fell about 3× rather than the 4× hoped for.
- **Finding:** local Realtime only re-opens a tenant's DB feed on a join or a presence message, so with less presence traffic the local 10-minute "rebalancing" drop now lasts until the next heartbeat (81 % live delivery in the full run; every battle still DESTROYED via the heartbeat's version, 765 refetches). This shouldn't happen on hosted Supabase. T-030 will report the missed-event count so production would show it.
- Hub re-ran on a fresh clone:
  - pipeline green (web 315, game 137, loadtest 17 unit tests);
  - `supabase test db` **1218/1218**;
  - e2e scripts 44/51/34/50/26;
  - multiplayer 4/4, solo 2/2;
  - **chaos shards 3/3, 2/2, 4/4**;
  - load-test smoke 3/3 battles, p95 19 ms, 100 % delivered.
  The full runs were not repeated by the hub (about 12 min each).
- T-026 is split: ISR first (T-026), then observability + runbooks (T-030).

### T-026: accepted (M5 task 8)
- The worker was interrupted by a container restart. Its worktree survived with 4 commits plus uncommitted changes, and it was resumed (not re-dispatched) and finished.
- **`/battles/[id]` + OG image are ISR** (`force-static`, `revalidate = 3600` cap). The data comes from a `'use cache'` loader whose `cacheLife` depends on the answer:
  - a settled battle (DESTROYED with `destroyed_at`) is cached 1 h;
  - RESULTS, not-yet-destroyed, or not public yet: 5 s (so a 404 never sticks).
  Each is tagged `battle:{id}`.
- **`/u/[id]` stays dynamic** (pagination in the query string); its data is cached for 30–60 s, or 5 s while it lists an unsettled battle or is empty. Tags: `player:{id}` + `battle:{id}` per listed battle.
- **Takedown** (`takeDownAction`): `updateTag('battle:{id}')`, with the battle id taken from the RPC answer (the hub checked that both RPC return paths carry it). The page and OG image are expired again 10 s later (`after`), so a render racing the takedown can't keep the old copy.
- **Cloudflare:** R2 incremental cache, D1 tag cache, Durable Object revalidation queue; all emulated in `cf:preview`. Production steps were added to "Blocked on the user".
- **Caveats (accepted):**
  - `experimental.useCache` is deprecated in Next 16 (one build warning); revisit on a Next upgrade.
  - The Worker grew to about 2.1 MB gzip.
  - A takedown done with plain SQL doesn't revalidate (cached up to 1 h); use `/admin`.
  - The OG image now returns 500 on Supabase errors instead of caching a generic card.
- Hub re-ran on a fresh clone:
  - pipeline green (web 339 unit tests); `cf:build` OK;
  - `e2e-moderation.mjs` 26/26;
  - moderation e2e **4/4 on `next start` and 4/4 on the Workers preview** (`test:e2e:cf:moderation`: cache HIT, takedown visible on the next request on page, OG image and `/u/[id]`);
  - solo 2/2, multiplayer 4/4, playground on Workers 14/14.
  - No SQL was touched.

### T-030: accepted (M5 task 9)
- **New package `@br/telemetry`** with the shared privacy rules: an allowlist scrubber, URL/text scrubbing, a pseudonymous user id (`sha256("br-telemetry:v1:" + id)`, 128 bits), and a fetch-based Sentry reporter on `@sentry/core` that runs on Node and on Workers. `@sentry/nextjs` was rejected because its server side doesn't fit workerd.
- **Web:** browser reporting starts only with `NEXT_PUBLIC_SENTRY_DSN` (the check is on the inlined variable, so a build without it has no reporting code). The SDK chunk (27.8 KiB gzip) loads when idle. `allowUrls` is limited to our own origin, and `blob:`/`data:` stacks are dropped, so nothing from the sandbox is reported. Server errors go through `onRequestError`.
- **Capture worker and package CDN:** `SENTRY_DSN`-gated; build-caused render failures are never sent.
- **PostHog:** a typed event module (no posthog-js, no autocapture or replay). It's off under DNT/GPC. A `sync_health` event is sent per battle from the new sync-engine counters (missed, degraded time, rejoins, server closes).
- **Admin Health:** `admin_ops_health()` (admin only, `security definer`, `search_path=''`; anon and service_role refused; pgTAP 43). It covers stuck/overdue battles, job queues, screenshot outcomes, pg_cron runs and TTL leftovers. Shown on `/admin` with links to runbooks, plus "Refresh public copies" and "Send a test error". The hub checked that both new actions verify the admin first.
- **Runbooks:** `docs/runbooks/` has 7 runbooks plus an index. `check-runbooks.mjs` runs every SQL block on fixtures (writes rolled back) and syntax-checks the shell blocks. The hub added it to the CI db job, and the telemetry e2e to the CI multiplayer job.
- **Size:** Worker +36 KiB gzip; page JS +0.9 KiB without a DSN.
- **Deviation (accepted):** the bundler web worker is not instrumented, because its errors contain build code.
- Hub re-ran on a fresh clone:
  - pipeline green (web 374, telemetry 20, capture-worker 79, pkg-cdn 120 unit tests); `cf:build` OK;
  - `supabase test db` **1261/1261**; `e2e-moderation.mjs` 26/26; runbook check 42/42;
  - moderation e2e 4/4 (and 4/4 on Workers); telemetry e2e 5/5 + 1/1 (and 5/5 on Workers);
  - solo 2/2, multiplayer 4/4; chaos shards 2 and 3 passed (2/2, 4/4).
- **Chaos shard 1 failed once:** Eve's preview showed `heartbeat-timeout silentMs=5309 phase=running` with no loop in the code, under the 6-browser load. T-030 touches neither the runtime nor the preview, and telemetry is off in that test. The re-run passed 3/3. This is the T-027 failure mode after `ready` → **T-031**. The failure artifacts are kept in the hub scratchpad.
- The M5 scope item "Service Worker cache for template packages" was never done. It needs a measurement first (the shell wipes its own Service Workers, and the build frame has an opaque origin) → **T-032**.

### T-031: accepted (M5 task 10)
- **Root cause, with evidence from the hub's failure artifacts:**
  - at the start of BUILD, Eve's app main thread got no CPU for about 5 s;
  - her `building` broadcast was logged 3.9 s after the other pages';
  - four presence diffs arrived within 8 ms of each other;
  - her screencast had 4.8 s frame gaps;
  - her first build took 2.3 s instead of about 150 ms.

  The watchdog's wall-clock silence measured the app's own stall, not a loop in the frame.
- **Reproduced on the old code** with a new runtime e2e (`watchdog-starvation`): every renderer SIGSTOP'd for 7 s, or overlapping long tasks on both throttled pages, gave a false `heartbeat-timeout phase running`.
- **Fix:** every watchdog limit (5 s heartbeat, 15 s load grace, 10 s handshake) is measured in app-awake time. The 250 ms tick advances an awake clock by at most one interval plus 50 ms jitter, so a late tick (an app stall) isn't counted. Only the app's own timers move the clock, never anything the sandbox sends.
- **Bounds:**
  - a loop after `ready` is still caught in 4.0–5.25 s of awake time (measured 4.3–4.8 s);
  - a loop during a load is caught within T-027's 15.25 s;
  - hidden tabs are unchanged.
- **Hub security note (accepted):** with site isolation, a loop in the frame doesn't stall the app's timers, so detection is unchanged. A build that also saturates every core could slow the app's ticks and stretch detection (at worst about 4× on the wall clock), but it is still caught. Without site isolation (Safari, low-RAM Android) a loop freezes the app anyway; that residual risk is documented in R2.
- **Telemetry:** `preview_crash` events (reason, phase, mode, awake and wall silences, stall evidence, restarted) and preview counts in `sync_health`. No build code and no names. The hub added both to the runbook index.
- 9 new runtime unit tests, all failing on the old code.
- Hub re-ran on a fresh clone:
  - pipeline green (runtime 121, web 390 unit tests);
  - runtime e2e **28/28** (including `watchdog-starvation` 2/2);
  - playground 14/14, solo 2/2, multiplayer 4/4, telemetry 6/6 + 1/1;
  - **chaos shards 3/3, 2/2, 4/4, and shard 1 again 3/3.**
- CI run 42 on GitHub (with the runbook check and the telemetry e2e added) was green.

### T-032: accepted (M5 task 11)
- **Measured in Chromium:**
  - after the template's first preview, an edit, a preview restart, reveal mode, a storage reset, a page reload and even a browser restart all load React from the HTTP cache with the CDN down (0 CDN requests);
  - the cache partition is (top-level app site, shell site);
  - the shell's `Clear-Site-Data: "cache"` does not remove the CDN's entries;
  - every import-map URL is an exact version served `immutable`.
- **Decision: HTTP cache only, no Service Worker or Cache Storage** (the hub's constraint, confirmed by the worker). Build code runs on the shell origin and can write its Cache Storage, IndexedDB and Service Workers, so a module cache there could be poisoned for every later build a viewer sees. Page script can't write the HTTP cache. Docs 02 (R10), 03 and 06 were updated, so they no longer promise a Service Worker.
- **Gap closed:** a CDN that accepts connections but never answers used to hang the preview silently. Now:
  - the shell explains a failed module graph in about 0.2–1 s ("Package server unreachable / not responding / error (HTTP n): x@1.2.3", using a `fetch` captured before any build runs; at most 64 URLs, 3 s each);
  - it posts a "Still waiting for the package server" note after 8 s;
  - REVEAL shows the screenshot with the reason and "Run it again".
- **Warm-up:** the shell re-fetches the import map with `force-cache` after each build runs. A hidden, empty `TemplateWarmup` preview in the lobby and spectator view (desktop only) warms React before SPIN.
- **pkg-cdn:** 302s carry `stale-while-revalidate=60, stale-if-error=86400`; every response has `Content-Length`.
- **Hub security read:** the warm-up and checks only fetch URLs the build itself could already fetch (`connect-src https:`), never write anything a later build reads, and error texts are capped and rendered as text. Accepted.
- **Open limits (docs/03):**
  - only Chromium was measured;
  - per-build sites (F1) will need per-site warm-up;
  - the non-template packages of the next REVEAL build aren't warmed ahead;
  - phone spectators get no lobby warm-up.
- Hub re-ran on a fresh clone:
  - pipeline green (protocol 24, shell 62, runtime 130, pkg-cdn 120, web 397 unit tests);
  - runtime e2e **32/32**, playground 17/17;
  - runbook check 0 failed;
  - solo 3/3 and multiplayer 5/5 (both including the new outage specs), moderation 4/4, telemetry 6/6 + 1/1;
  - **chaos shards 3/3, 2/2, 4/4**.
- CI run 45 on GitHub (head 64d2905) is green in every job: check, db (with the runbook check), capture + solo + moderation, rooms + telemetry, runtime + playground, chaos shards 1–3. Load test and compat are manual-only and were skipped.
- **M5 status:** every task is merged. Sign-off (the exit criterion: every runbook rehearsed once on staging) waits on the user's accounts.

### T-033: accepted (free-tier task 1), verdict NO-GO for Next on Workers Free
- **Measured** the isolate CPU per request on workerd (a V8 profile through wrangler's inspector, calibrated; cross-checked against Node `next start` and the thread's schedstat):
  - only warm cache hits fit 10 ms (2–4 ms); fresh isolates take 11–19 ms even for cached pages;
  - every Next render is over: 20–45 ms warm, 250–370 ms in a fresh isolate, because OpenNext loads the Next server inside the first request, which counts toward the request limit (confirmed in our bundle);
  - the global scope (46 ms) runs under the separate 1 s startup limit (confirmed in the workerd source).
- **Slimming kept** (useful on any host):
  - the OG image is the rank-1 screenshot or a static card (`next/og` removed; it cost 127–344 ms; T-028 respected);
  - `/r/[code]` is one prerendered page (rewrite + the code read in the browser);
  - the Worker shrank from 2,198 to 1,318 KiB gzip.
- **Options given to the user:** A $5 plan, B cache-only Worker, C static export, D another free host. **The user chose C** (→ T-037, T-038).
- Measurement tool: `pnpm --filter @br/web measure:cpu` (needs `cf:build` and the stack). Data is in `docs/data/t033-cpu-*.csv`; the write-up is in `docs/08-free-tier.md` §1.
- Hub re-ran on a fresh clone:
  - pipeline green (web 405 unit tests); `cf:build` gzip 1317.6 KiB;
  - playground 17/17, Workers playground 17/17;
  - moderation 4/4 and 4/4 on Workers;
  - solo 3/3, multiplayer 5/5;
  - a short `measure:cpu` run finished with exit 0. It was interrupted by a session restart after its last test.

### T-037: accepted (free-tier task 2)
- **The web app is now a static export** (`apps/web/out/`) on Cloudflare Pages. No Next server and no Worker code run for the app.
- **Routes:**
  - `/r/{code}`, `/battles/{id}` and `/u/{id}` are single shells served through `_redirects` 200 rewrites; their data loads in the browser through the anon RPCs (`get_public_battle`, `get_player_history`, both granted to anon);
  - unknown paths get `404.html` with a real 404 status;
  - links to the shells are full page loads.
- **Admin is client-side:**
  - a separate supabase-js client whose session lives only in this tab (in memory, mirrored to sessionStorage; never localStorage, never supabase-js's BroadcastChannel);
  - sign-out revokes the session; a non-admin account is signed out at once;
  - `is_admin()` in Postgres stays the only authority;
  - the build fails if any exported file contains a non-anon key.
  - **Trade-off vs T-024's httpOnly cookies (accepted):** an XSS on the app origin could read the tokens in that tab. Mitigations: no user HTML on the app origin, a hash-based CSP with no inline script (an e2e proves an injected script is blocked), `frame-ancestors 'none'`, and a tab-scoped, revocable session.
- **`_headers` (new; the old app sent none):** CSP with 10 script hashes (928 chars; the build enforces Pages' 2,000-char limit), XFO, nosniff, referrer policy, permissions policy, COOP, HSTS, immutable `/_next/static`, noindex on `/admin`.
- **Removed:**
  - OpenNext and the Worker config (R2, D1, DO), `cf:*` scripts, server actions, `instrumentation.ts`;
  - the T-026 cache code and ISR e2e, and "Refresh public copies";
  - `measure-cpu` trimmed to what T-038 needs.
  Takedowns now show on the next load with no cache involved. The runbook `cache-not-revalidating` is replaced by `removed-content-still-visible`.
- **e2e:** every Playwright config serves `out/` through `wrangler pages dev`. A new `static-site.spec` covers rewrites, 404s, headers and CSP enforcement, and solo, moderation, rooms and chaos watch for CSP violations.
- Hub re-ran on a fresh clone:
  - pipeline green (web 395 unit tests);
  - export: 94 files, JS 706 KiB gzip;
  - playground 22/22, solo 3/3, moderation 2/2, multiplayer 5/5, telemetry 6/6 + 1/1;
  - **chaos shards 3/3, 2/2, 4/4**;
  - runbook check 0 failed.
- **Hub fix on top:** the worker saw the T-031 `preview_crash` e2e fail once (`silent_ms` 5635 > 5600). That isn't a flake, the bound was wrong: `ready` moves the deadline to ready + 5 s and the last pong can be up to one ping interval earlier, so the bound is 5000 + 1000 + 300 ms. Changed it to 6300 ms with that explanation.
- This hub commit also updated the stale "Blocked on the user" rows (Workers Paid, the R2/D1 cache, the Containers CDN). T-036 rewrites the whole free-setup checklist.

### T-038: accepted (free-tier task 3), link previews GO
- A Pages advanced-mode `_worker.js` (13 KiB, 5.3 KiB gzip) runs only on `/battles/*` (`_routes.json`). It fetches the shell plus `get_public_battle` in parallel and rewrites the head with `HTMLRewriter`: title, `og:*`, `twitter:card`, canonical.
- **T-028 rule:** if rank 1 was taken down, the preview shows the static card with no winner, and the runner-up is not promoted.
- **Status codes:** unknown or not-public ids get a real 404 (still the shell's HTML); malformed ids get 404 without a Supabase call.
- **Fail open:** a Supabase timeout (1.5 s) or error returns the unchanged shell with 200.
- **No cache**, so a takedown reaches the preview on the next request. Settings are inlined from the same `NEXT_PUBLIC_*` build values; nothing is set on Pages. `_headers` are baked into the Function's responses, because Pages doesn't apply them to Functions.
- **Escaping:** script and attribute injection attempts are round-tripped through a real HTML parser, and the tests fail when the escaping is weakened. The e2e uses a real build named `"><script>…`.
- **Hub re-ran on a fresh clone:**
  - pipeline green (web 426 unit tests);
  - playground 22/22, moderation 8/8 (6 link-preview), solo 3/3, multiplayer 5/5, telemetry 6/6 + 1/1;
  - runbook check 0 failed;
  - short `measure:cpu`: Function 1.2–2.3 ms warm median, 3.2–4.9 ms fresh median (n=2), matching the worker's numbers (fresh p95 up to 7.3 ms).
- **Caveat (accepted):** Cloudflare's CPUs may be slower than this VM; check the Functions CPU metric after the first deploy.

### T-039: accepted (free-tier task, from CI run 52)
- **Stall timeout, not a fixed bound.** The bundler worker now downloads `esbuild.wasm` itself (streaming compile) and reports progress. The client's timer restarts on every progress message, and **15 s with no progress** counts as a stall. A slow but moving link is never cut off.
- **On a stall:** one automatic retry with a fresh worker. If that stalls too, the preview shows "Couldn't start the bundler: the download stalled …" with a **Retry** button (new; before, only an edit retried). The code is kept. Real errors (404, refused, script load failure) still fail at once, as before.
- **Telemetry:** a `bundler_start` event for stalls and failures (battle UUID, stage, attempt, elapsed, bytes; no code, no names).
- **Cost (accepted):** Chrome's wasm code cache no longer applies, so a cold start takes about 227 ms instead of 205 ms.
- **Tests:** 9 of 10 new client tests, all web state tests and 3 e2e tests fail on the old code. The old build reproduced the CI symptom: 45 s on "Starting bundler…".
- **Hub re-ran on a fresh clone:**
  - pipeline green (runtime 142, web 433 unit tests);
  - playground 24/24, solo 3/3, multiplayer 5/5, telemetry 6/6 + 1/1;
  - **chaos shards 3/3, 2/2, 4/4**;
  - runtime e2e 31/32. The failure was T-031's `watchdog-starvation` (not touched by T-039): detection 6899.1 ms against a lower bound of 6900. That bound was wrong: the first tick after the 3 s stop credits up to 300 ms of awake time, so the minimum is 4000 + 3000 − 300 = 6700 ms. The hub fixed the bound with that explanation, and the spec passed 3 runs in a row.
- **CI run 52's root trigger stays unproven:** the artifact can't be downloaded here, and runs 53 + 3 local runs were green. The hang it exposed is fixed.

### T-035: accepted (free-tier task 4); esm.sh contract to be confirmed by the CI compat run
- **Same URLs on both CDNs.** The runtime's URLs (`/pkg@ver[/sub]?external=react,react-dom&deps=…`) already fit esm.sh.
- **The real difference:** an esm.sh entry URL re-exports an internal build path (`/…/es2022/….mjs`). T-032's warm-up and checks only fetched entries, so on esm.sh the real modules weren't cached before an outage. This was reproduced against an esm.sh-shaped mock. Fix: the shell follows each module's same-origin static imports (up to 64) during warm-up and checks; failures are still named by their entry.
- **The CDN is configuration only:** `NEXT_PUBLIC_PKG_CDN_URL` (web), `BR_PKG_CDN_URL` (shell CSP; defaults to esm.sh), `PKG_CDN_URL` (capture). Our own CDN stays the local/test and paid option.
- **Compat suite:** `--cdn <url>` / `COMPAT_CDN`; a CDN contract check (status, Cache-Control, CORS, same-origin imports, Vary); 2 new one-instance cases (react-dom, three under fiber). CI has a `compat_cdn` input, passed as an env var and never interpolated into the script.
- **Hub re-ran on a fresh clone:**
  - pipeline green (shell 70, runtime 146, pkg-cdn 135, web 433 unit tests);
  - runtime e2e 32/32 + 5/5 (esm.sh-shaped mock);
  - playground 24/24, solo 3/3, multiplayer 5/5;
  - runbook check 0 failed;
  - **compat on our CDN 56/57 (98.2%), contract ok**.
- The hub started CI `workflow_dispatch` with `compat_cdn=https://esm.sh` (this container gets 403 on esm.sh).
- **Follow-up:** our `denylist.json` doesn't apply on esm.sh.
- **CI compat against esm.sh** (run 60, workflow_dispatch). Run 57 was cancelled by a push in the same concurrency group; manual runs now get their own group.
  - **52/57 (91.2%).**
  - **React contract:** 1 problem: react-dom's `/scheduler@^0.28.0?target=es2022` is cached for only 600 s.
  - **Failures:** `react-chartjs-2` (two chart.js), `@react-three/fiber (one three)` ok:false, `pixi.js` (ready timeout), `matter-js (named imports)` (known), `p5` (`createFromCommands` missing from a range-resolved dependency).
  - **Many cases** report range sub-imports (600 s) and `/node/*.mjs` polyfills (1 day).
  - **The cause is the same everywhere:** esm.sh resolves a package's own dependencies by range, so T-035's assumptions 6/8 (`deps=` pins nested peers) don't hold. → T-040.

### T-034: accepted (free-tier task 5)
- **Jobs run in a Supabase Edge Function** (`supabase/functions/jobs`):
  - pg_cron `br-jobs-run` runs every minute → `private.run_jobs_function()` → pg_net POST, sent only when a job is due;
  - the function URL and the cron secret come from **Vault**; the function compares the secret in constant time (`verify_jwt = false` for this function only);
  - each run lasts 50 s, with an abort at 140 s (under the free 150 s wall). If the platform kills a run, the 2-minute lease expires and the next run reclaims the job.
- **Capture:**
  - Browser Rendering REST **`/snapshot`** (WebP q82 plus the page HTML from the same session), 1280×800, waiting for `html[data-br-capture]` with a 6 s cap.
  - The capture page now reports `data-br-capture`, `data-br-paint` (new `paint.ts`) and a page marker, so a blank build still falls back to its thumbnail without decoding WebP in Deno.
  - **Deploy order:** the shell must be redeployed from this version.
- **Budget:** `private.browser_budget`, one row per UTC day; reserve before and settle after each render; stop at 9.5 min/day.
- **429 and errors:** calls are spaced 10 s apart (6/min); a short `Retry-After` is waited out; anything else falls back to the thumbnail from the 3rd attempt, within the 10-minute capture deadline.
- **Client thumbnails** are rebuilt as a single-image WebP container (no EXIF/XMP/ICC, no animation).
- **Code sharing:** the worker's job code and `src/edge/*` are bundled into a committed `core.js` (60 KiB), with a staleness test.
- **`apps/capture-worker` stays** as the paid/self-hosted option (switch with `cron.unschedule`/`schedule`).
- **Hub security read:**
  - the budget RPCs are `service_role` only;
  - `run_jobs_function` is revoked from all API roles;
  - there is no service key in SQL;
  - the cron secret is in clear only in pg_net's short-lived queue (documented).
- **Accepted gaps:** no "network idle + 2 s" (a build without `ready()` waits the full 6 s), and no navigation guard (the capture CSP sandbox still blocks popups and downloads). `X-Browser-Ms-Used` and some status codes are assumptions; wall time is the fallback.
- **Hub re-ran** on a fresh clone with T-034 test-merged onto main (merge clean, including `ci.yml`) and the Edge Runtime on:
  - pipeline green (capture-worker 136, shell 78, web 433 unit tests; `core.js` unchanged by the build);
  - `supabase test db` **1295/1295**;
  - e2e scripts 44/51/34/50/26; runbook check 0 failed;
  - **function integration 11/11**, worker integration 13/13;
  - solo 3/3, moderation 8/8, multiplayer 5/5, telemetry 6/6 + 1/1;
  - **chaos shards 3/3, 2/2, 4/4**.
- **Hub follow-ups:** `docs/WORKFLOW.md` stack command now keeps the Edge Runtime (done here). docs/05 §5.4/§5.7 ("no pg_net, workers poll") is stale → T-036. The load test still starts the Node worker (noted).

### T-040: accepted (free-tier task 6); esm.sh CI re-run pending
- **Root cause**, from esm.sh's server source (read through the Go module proxy):
  - a dependency that is neither externalized nor pinned is imported by its package.json range (cached 600 s, newest match);
  - `deps=` builds a second copy with its own build arguments;
  - entry arguments aren't normalized.

  T-035's `deps=` assumption was wrong.
- **Design:**
  - every package URL externalizes every other manifest package plus React/React DOM (sorted, never itself); `deps=` is gone;
  - the import map is still a pure function of the manifest: the React set with fixed URLs (React DOM externalizes `scheduler`, which is pinned per React DOM minor, 19.3 → 0.28.0), each other package's main URL plus an in-path-query prefix entry for subpaths (scoped names as `%252F`), and `react/` and `react-dom/` prefixes;
  - limits: 32 externals and 1,200 characters per list, else React-only with a warning;
  - template map: 8 entries.
- **Our CDN:** an in-path query re-exports the `?query` URL (one instance); unlisted peers are keyed by the request's externals plus the requester; `BUILD_FORMAT` b4.
- **Shell:** warm-up covers the template entries plus the build's own packages and follows bare imports through the map; prefixes and CSS-only entries are never fetched.
- **Non-manifest range dependencies are accepted** (10-min outage window; a player can pin by listing them). `?standalone` was rejected because it duplicates shared dependencies.
- **p5 is a known esm.sh incompatibility** (esm.sh prefers the `browser` condition; `bezier-path`'s browser export has no exports). pixi.js should pass now: the probe follows up to 512 modules.
- **Mock CDN (esm.sh layout):** range sub-imports, `deps=` copies and in-path queries, with multi-version fixture packages. A new `one-instance` e2e fails on the old runtime with run 60's exact symptoms.
- **Compat:** 58 cases (a new scoped-prefix case); unlisted ranges are notes; known and unexpected failures are reported separately.
- The worker was interrupted by two container restarts, resumed both times, and lost no work.
- **Hub re-ran on a fresh clone with T-040 test-merged onto main** (merge clean):
  - pipeline green (runtime 167, pkg-cdn 144, shell 84, capture-worker 136, web 433 unit tests);
  - runtime e2e 35/35 + 8/8 (esm.sh layout);
  - playground 24/24;
  - **compat on our CDN 57/58, 0 unexpected, contract ok, 0/58 cases with problems**;
  - function integration 11/11;
  - solo 3/3, moderation 8/8, multiplayer 5/5;
  - **chaos 3/3, 2/2, 4/4**.
- **Expected on esm.sh:** 56/58, known failures matter-js named imports and p5, React contract 0 problems.
- **CI compat against esm.sh after T-040** (run 64, workflow_dispatch): **56/58 (96.6%), 0 unexpected, 2 known** (matter-js named imports, p5), **React import-map contract ok** (12 URLs), cases with problems 1/58. Exactly as T-040 predicted: react-chartjs-2, fiber (one three), pixi.js and react-konva (scoped prefix) pass.
- **Push run 63 at the same head:** every job green except chaos shard 3. The 8-player battle start had a page at "Starting bundler…" for 30 s, the same symptom as run 52. Hub analysis: T-039's stall timer sees no progress during the compile stage, so a CPU-starved compile can be killed and retried → **T-041**.

### T-036: accepted (free-tier task 7)
- **Keep-alive:** a daily GitHub Actions workflow (`keep-alive.yml`, 04:23 UTC + jitter) calls the new anon RPC `public.keep_alive()`. That RPC writes at most once a minute, answers `{ok, read_only, at}` and is the only new anon grant. The workflow fails loudly on a paused (540) or restricted (402) project, a read-only DB, or a wrong key/URL; with nothing configured it passes with a notice. The last ping shows in Health (flagged after 36 h). Our own pg_cron/pg_net traffic is assumed not to count as activity.
- **Screenshots:** WebP quality 82 → **70**, measured on an 18-app corpus: mean 77 → 61 KiB (−21 %), mean SSIM 0.9926 → 0.9897; comparison images are in the hub scratchpad. 960×600 is the documented next lever. Screenshots are never deleted on a timer.
- **Database:** about 42 KB kept per battle. The new daily `private.prune_event_logs()` removes battle events of finished battles and room events older than 30 days, plus finished capture/destroy jobs older than 7 days (configurable; takedown jobs kept). pgTAP proves public pages, histories and permanent rows stay identical; a mutant that also deleted ballots failed 2 tests.
- **Health:** storage per bucket vs 1 GB (warning at 80 %), DB size vs 500 MB, MAU vs 50k, and the last keep-alive.
- **Free-plan capacity** (docs/07 §7.8):
  - storage ~2,750 battles in total (first over time);
  - egress ~1,210 battles/month (first per month);
  - Realtime Presence ~10 rooms in BUILD at once (first at a peak; the load test on Free quotas at 10×6: 0 channel closes);
  - Browser Rendering ~1,000 battles/month (soft: thumbnails after that);
  - Realtime messages ~1,340 battles/month.
- **Docs:** root `DEPLOY.md` (accounts → Supabase → Pages → GitHub → smoke checks → runbook drills), docs/05 stale pg_net text fixed, docs/07 §7.8, docs/08 §6, a new `free-plan-quotas` runbook. `scripts/deploy-check.mjs` passed 33/33 against the local setup; it is unit-tested.
- **Hub notes:**
  - the repository is **public**, so Actions minutes are unlimited and the worker's "drop CI's nightly run on a private repo" advice doesn't apply;
  - the hub rewrote "Blocked on the user" from the worker's proposal;
  - the load test was broken since T-034 (it waits for the Node worker's log line): the hub fixes it separately.
- **Hub re-ran on a fresh clone with T-036 test-merged onto main** (clean):
  - pipeline green (web 436, capture-worker 136 unit tests; scripts tests included);
  - workflow YAML parses;
  - `supabase test db` **1347/1347**;
  - e2e scripts 44/51/34/50/26;
  - runbook check (9 runbooks) 0 failed;
  - function integration 11/11;
  - moderation 8/8, solo 3/3, multiplayer 5/5.

### T-041: accepted (free-tier follow-up, from CI runs 52/63)
- **Reproduced** on 4 vCPUs with 8 concurrent bundler starts:
  - busy loops alone never tripped the old 15 s timer (the worst compile stage was 12.8 s, on 1 CPU);
  - a **renderer freeze** (SIGSTOP, 17 s) did: the overdue timer fired on resume before the worker could finish `initialize`, giving false stalls at stage `compile`;
  - a deterministic e2e (initialize held 17 s) made all 8 old-code starts stall twice and fail with about 31 s of "Starting bundler…", which is the CI symptom.
- **Why no heartbeats:** measured, `compileStreaming` resolves 10–200 ms after the last byte and `esbuild.initialize` blocks the worker's own thread for practically all of its time, so a heartbeat couldn't be sent then.
- **Fix:**
  - the download stage keeps T-039's 15 s no-progress limit;
  - after the last byte, a separate **60 s** compile limit (`initCompileMs`);
  - both count only **page-awake time** (`AwakeClock`; at most 1 s credit per 250 ms tick, the T-031 idea);
  - one retry, then Retry, and errors still fail at once;
  - `bundler_start` gains `awake_ms`.
- **Diagnostics:** `waitForBuild` now names the stage a page reached when its build is late, and chaos battles print `[metrics] battle start`. The next CI failure will say where it stopped.
- **Tests:** 7 new or changed client tests and both new runtime e2e (`bundler-start.spec`) fail on the old client.
- **Hub re-ran on a fresh clone with T-041 test-merged** (clean):
  - pipeline green (runtime 177, web 436 unit tests);
  - **runtime e2e 3× on the new code and 3× on the old (interleaved): all green** (37/37 + 8/8, and 35/35 + 8/8). The worker's flaky T-031 long-task watchdog test did not reproduce;
  - playground 24/24, solo 3/3, multiplayer 5/5;
  - **chaos shard 3 three times 4/4** (8-player start: esbuild ready p50 4.8–5.1 s, max 6.3–7.3 s), shards 1 3/3 and 2 2/2.
- **Push CI after the merge** (run 68 at 3148476): every job green, chaos shards 1–3 included (loadtest and compat are manual-only).
