# Task board

Status: `todo` · `in-progress` · `review` · `fix` · `done` · `blocked`

## Current milestone: M0 Foundations (+ M1 sandbox prototype started early)

| ID | Task | Scope | Status | Notes |
|---|---|---|---|---|
| T-001 | Monorepo skeleton: pnpm + Turborepo, Next.js app, lint/format/strict TS, Vitest, CI | root config, `apps/web/`, `packages/game/`, `.github/` | in-progress | Wave 1 |
| T-002 | Supabase scaffold: initial schema migration, Supabase-compatible local Postgres test harness, pgTAP | `supabase/` | in-progress | Wave 1 |
| T-003 | Sandbox prototype: esbuild-wasm bundler worker, runtime shell, postMessage protocol, mock CDN, Playwright test | `packages/runtime/`, `packages/protocol/`, `apps/sandbox-shell/` | in-progress | Wave 1. External CDNs are blocked, so a local mock CDN is used. |

## Blocked on the user

| Item | Needed for |
|---|---|
| Supabase project (staging), Vercel project, Cloudflare account | Deploy previews, hosted environments (M0 end / M2) |
| App domain + separate usercontent domain | Sandbox origin isolation in production (M1 end) |

## Done

_None yet._

## Review log

_Notes from each review are recorded here._
