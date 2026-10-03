# Task board

Status: `todo` · `in-progress` · `review` · `fix` · `done` · `blocked`

## Current milestone: M0 Foundations (+ M1 sandbox prototype started early)

| ID | Task | Scope | Status | Notes |
|---|---|---|---|---|
| T-001 | Monorepo skeleton: pnpm + Turborepo, Next.js app, lint/format/strict TS, Vitest, CI | root config, `apps/web/`, `packages/game/`, `.github/` | done | Merged in b29110a |
| T-002 | Supabase scaffold: initial schema migration, Supabase-compatible local Postgres test harness, pgTAP | `supabase/` | done | Merged |
| T-003 | Sandbox prototype: esbuild-wasm bundler worker, runtime shell, postMessage protocol, mock CDN, Playwright test | `packages/runtime/`, `packages/protocol/`, `apps/sandbox-shell/` | in-progress | Wave 1. External CDNs are blocked, so a local mock CDN is used. |

## Blocked on the user

| Item | Needed for |
|---|---|
| Supabase project (staging), Vercel project, Cloudflare account | Deploy previews, hosted environments (M0 end / M2) |
| App domain + separate usercontent domain | Sandbox origin isolation in production (M1 end) |

## Done

- T-001 Monorepo skeleton
- T-002 Supabase schema + RLS + test harness

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
  - Wire `supabase/scripts/test.sh` into CI (apt install works on ubuntu runners).
  - Add a drift test `@br/game` ↔ SQL `battle_phase` enum.
