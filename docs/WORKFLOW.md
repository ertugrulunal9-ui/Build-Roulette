# How we work

This project is run by a **hub** that coordinates **worker** agents.

## Roles

| Role | Owns | Does not |
|---|---|---|
| **User** | Product decisions, accounts (Supabase/Cloudflare/domain), secrets, final say | — |
| **Hub** (main session) | The plan, design docs, the [board](BOARD.md), task briefs, reviews, merges into the working branch, pushes | Writes large features itself |
| **Workers** (sub-agents) | One task each, in an isolated git worktree | Touch files outside their task's scope, push, edit the board or design docs |

## Cycle

```
PLAN → BRIEF → DISPATCH → REVIEW → MERGE / FIX → NEXT WAVE
```

1. **Plan:** the hub splits the current milestone ([roadmap](06-roadmap.md)) into small tasks that can be done independently.
2. **Brief:** every task gets a self-contained brief:
   - Goal
   - Scope, as an allowlist of paths the worker may touch
   - Context (which design docs to read)
   - Acceptance criteria
   - Verification commands
   - What's out of scope
   - Report format
3. **Dispatch:** **one worker at a time** (user decision 2026-10-04, after hitting the session usage limit twice). Earlier waves ran up to 3 in parallel; parallel workers must never share a path. Workers
   run in the background in their own git worktree and commit on their own local branch.
4. **Review:** the hub never relies on the worker's report alone. For each task it:
   - reads the full diff;
   - runs the verification commands itself;
   - checks the work against the acceptance criteria and the design docs;
   - looks for scope creep, missing tests and hidden failures.
5. **Decision:**
   - **Accept:** merge into `claude/build-roulette-architecture-9dl8zr`, update the board, push.
   - **Fix:** send concrete review notes back to the same worker, which keeps its context.
   - **Reject:** rewrite the brief and redispatch.
6. **Next wave:** the hub plans the next tasks based on what was learned.

## Git

- One integration branch: `claude/build-roulette-architecture-9dl8zr`. Only the hub pushes,
  and only to this branch.
- Workers commit locally in their worktree. The hub merges accepted work with a merge commit.
- Commit messages use the imperative mood and say what changed and why.
- Never commit a key-shaped literal, not even the local Supabase CLI's well-known demo keys
  (`sb_secret_…`, the service-role JWT). GitHub push protection rejects the push. That happened
  with T-037's test fixture, and the unpushed history had to be rewritten. Build such values at
  runtime instead (`'sb_secret_' + 'abcd1234'.repeat(4)`), or read them from `supabase status`.

## Reporting

- **Within a milestone:** the hub runs the waves on its own and contacts the user only
  for blockers (accounts, secrets, product decisions).
- **At the end of a milestone:** a report covering what was built, how it was verified,
  whether the exit criteria were met, open risks, and the plan for the next milestone.

## Environment notes (cloud container)

- Available: Node 22, pnpm 10, PostgreSQL 16 binaries (`/usr/lib/postgresql/16/bin`),
  apt packages (e.g. `postgresql-16-pgtap`), the npm registry, and Playwright Chromium
  (`/opt/pw-browsers`).
- **Not reachable:** esm.sh and other external CDNs, and github.com (except git push
  through the proxy). Tests must not depend on them, so use local mock servers.
- Docker works once the daemon is started (`dockerd &`). Docker Hub pulls work, but `public.ecr.aws` is blocked. **The local Supabase stack runs** with
  `SUPABASE_INTERNAL_IMAGE_REGISTRY=docker.io npx -y supabase@2.119.0 start -x studio,imgproxy,vector,logflare,edge-runtime,supavisor,mailpit`.
  Verified: migrations apply on Supabase Postgres 17, `supabase test db` passes 194/194, and anonymous sign-up returns 200.
  The containers are named after `project_id`, so only one worktree may run the stack at a time.
  Since T-011, DB tests run only on this stack (`supabase db reset && supabase test db`, plus `node supabase/scripts/e2e-solo.mjs`); the old `scripts/test.sh` harness was retired.
