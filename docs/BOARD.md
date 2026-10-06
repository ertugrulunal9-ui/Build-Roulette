# Task board

Status: `todo` · `in-progress` · `review` · `fix` · `done` · `blocked`

## Current milestone: M3 Rooms + multiplayer state machine + realtime (M2 complete)

| ID | Task | Scope | Status | Notes |
|---|---|---|---|---|
| T-011 | DB layer for the solo loop: RPCs (start, advance, ship, snapshot), storage buckets + policies, jobs, deadline sweep, card deck seed; tests on the real local Supabase stack | `supabase/`, `.github/workflows/ci.yml` (db job only) | done | Merged |
| T-012 | Spike: Next.js 16 on Cloudflare Workers via OpenNext (local preview, no account) | `apps/web/` (deploy config only) | done | Merged: GO with caveats |
| T-013 | Capture mode in the shell + local capture/destroy workers (Playwright stands in for Browser Rendering) | `apps/sandbox-shell/`, `apps/capture-worker/` | done | Merged |
| T-014 | Solo game UI: spin → build → ship → results → destroy, plus the `/battles/[id]` results page | `apps/web/` (+ small `supabase/` and `apps/capture-worker/` changes for the autosave CSS) | done | Merged |
| T-015 | Fix flaky playground e2e (`playground.spec.ts:206`): a click right after "Reset to template" is lost, likely a double rebuild replacing the frame (≈1/6 runs) | `apps/web/`, `packages/runtime/` | done | Merged |
| T-016 | M3 DB layer: rooms + members RPCs, multiplayer `start_battle`/`advance_battle` (shipping → results until M4), heartbeat, host migration, abandonment, kick, late joiners as spectators, Realtime broadcast triggers + private-channel authorization | `supabase/`, `ci.yml` | in-progress | M3, task 1 of 3 |
| T-017 | M3 web: create/join room (code + link), lobby with presence and ready-up, host controls, multiplayer battle flow, realtime sync loop with resync | `apps/web/`, `packages/game/` | todo | M3, task 2 of 3 |
| T-018 | M3 resilience: multi-context Playwright battles with chaos (network drops, clock skew, refresh, host leaves), admin event-log page | `apps/web/` (e2e), `supabase/` (tests) | todo | M3, task 3 of 3 |
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

| Item | Needed for |
|---|---|
| Cloudflare account (**Workers Paid, ~$5/month, at deploy time**: free-plan CPU and size limits are too tight for SSR per T-012) | Deploying the app, sandbox shell, package CDN and screenshots |
| Supabase project (free plan to start) | Hosted database, auth, storage and realtime |
| One domain for the app (optional at first; the app can run on a free Cloudflare address) | Public launch |
| Later: second (usercontent) domain + Public Suffix List entry (F1) | Per-build isolation as the game grows |

**User decisions (2026-10-04):** option A, so everything is hosted on Cloudflare and Vercel is dropped. The sandbox starts on `*.pages.dev` (already on the PSL), so there is no second domain at launch. Package CDN runs on Cloudflare Containers. Continue M2 locally.

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
