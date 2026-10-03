# Task board

Status: `todo` · `in-progress` · `review` · `fix` · `done` · `blocked`

## Current milestone: M1 Sandbox (M0 code complete; M0 accounts/domains blocked on user)

| ID | Task | Scope | Status | Notes |
|---|---|---|---|---|
| T-001 | Monorepo skeleton: pnpm + Turborepo, Next.js app, lint/format/strict TS, Vitest, CI | root config, `apps/web/`, `packages/game/`, `.github/` | done | Merged in b29110a |
| T-002 | Supabase scaffold: initial schema migration, Supabase-compatible local Postgres test harness, pgTAP | `supabase/` | done | Merged |
| T-004 | Run DB tests in CI + add a `@br/game` ↔ SQL enum drift test | `.github/workflows/ci.yml`, `packages/game/` | done | Merged |
| T-005 | `/playground` in apps/web: CodeMirror 6, file tree, `@br/workspace` (limits, templates, IndexedDB, paste-import), runtime + preview wiring, console/diagnostics | `apps/web/`, `packages/workspace/` | done | Merged |
| T-006 | `@br/pkg-cdn`: esm.sh-compatible package CDN that resolves from the npm registry, plus an R1 compatibility suite and an e2e CI job | `apps/pkg-cdn/`, `.github/workflows/ci.yml` | done | Merged |
| T-003 | Sandbox prototype: esbuild-wasm bundler worker, runtime shell, postMessage protocol, mock CDN, Playwright test | `packages/runtime/`, `packages/protocol/`, `apps/sandbox-shell/` | done | Merged in 3172db8 |

## Blocked on the user

| Item | Needed for |
|---|---|
| Hosting choice for `@br/pkg-cdn` origin (Fly.io vs Cloudflare Containers) | Production package CDN (before M5) |
| Supabase project (staging), Vercel project, Cloudflare account | Deploy previews, hosted environments (M0 end / M2) |
| App domain + separate usercontent domain | Sandbox origin isolation in production (M1 end) |

## Done

- T-001 Monorepo skeleton
- T-002 Supabase schema + RLS + test harness
- T-003 Sandbox runtime prototype
- T-004 DB tests in CI + schema drift test
- T-005 Playground (editor, file tree, workspace persistence)
- T-006 Package CDN + R1 compatibility suite

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
