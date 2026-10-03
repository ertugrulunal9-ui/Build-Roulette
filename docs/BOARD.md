# Task board

Status: `todo` · `in-progress` · `review` · `fix` · `done` · `blocked`

## Current milestone: M0 Foundations (+ M1 sandbox prototype started early)

| ID | Task | Scope | Status | Notes |
|---|---|---|---|---|
| T-001 | Monorepo skeleton: pnpm + Turborepo, Next.js app, lint/format/strict TS, Vitest, CI | root config, `apps/web/`, `packages/game/`, `.github/` | done | Merged in b29110a |
| T-002 | Supabase scaffold: initial schema migration, Supabase-compatible local Postgres test harness, pgTAP | `supabase/` | in-progress | Wave 1 |
| T-003 | Sandbox prototype: esbuild-wasm bundler worker, runtime shell, postMessage protocol, mock CDN, Playwright test | `packages/runtime/`, `packages/protocol/`, `apps/sandbox-shell/` | in-progress | Wave 1. External CDNs are blocked, so a local mock CDN is used. |

## Blocked on the user

| Item | Needed for |
|---|---|
| Supabase project (staging), Vercel project, Cloudflare account | Deploy previews, hosted environments (M0 end / M2) |
| App domain + separate usercontent domain | Sandbox origin isolation in production (M1 end) |

## Done

- T-001 Monorepo skeleton

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
