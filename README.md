# Build Roulette

A multiplayer party game for vibe coders.

Everyone in the room gets the same random **BUILD**, **RULE**, **STYLE** and **TIME LIMIT**.
You race to make a small browser app with your own AI tools on your own computer (Cursor,
Claude Code, Windsurf, Lovable, Bolt, …), build it, drop the built site into the game, ship
it, reveal everyone's builds, vote, and see the results.

```
SPIN → BUILD (locally, any tool) → IMPORT dist/ → SHIP → REVEAL → VOTE → RESULTS → DESTROY BUILD
```

> **Builds are temporary. Results are permanent.**

No accounts required, and nothing to deploy: players build with their own tools and import
the built static site (the `dist/` folder or a `.zip`); the game runs it in an isolated
preview. Once a battle ends, each build's imported site is deleted. What stays is the
challenge, the builder, the build name, the completion time, a screenshot, the awards and the
battle results.

## Status

Milestones M1–M5 are implemented (docs/BOARD.md); M5's sign-off waits on a rehearsal on a
deployed copy. M6 (import mode, [docs/09](docs/09-import-mode.md)) replaces the in-browser
editor with imports of built sites. **To deploy it on free plans** (Cloudflare Workers,
Supabase Free), follow [DEPLOY.md](DEPLOY.md) step by step. The design docs:

| # | Document | Covers |
|---|----------|--------|
| 1 | [Production architecture](docs/01-architecture.md) | System diagram, components, what runs on the client vs. the server vs. the sandbox, key flows, decisions, cost |
| 2 | [Technical risks](docs/02-risks.md) | The hardest problems, ranked, with mitigations and validation spikes |
| 3 | [Disposable sandbox](docs/03-sandbox.md) | Preview isolation, the bridge and watchdog, the site worker, capture, destroy, threat model |
| 4 | [Multiplayer state machine](docs/04-state-machine.md) | Room / battle / player / build states, transitions, timers, realtime, reconnects |
| 5 | [Database schema](docs/05-database.md) | Postgres DDL, RLS, RPCs, storage buckets, jobs, retention |
| 6 | [Implementation plan](docs/06-roadmap.md) | Milestones with exit criteria, riskiest work first |
| 7 | [Capacity and cost](docs/07-capacity-and-cost.md) | Load-test results, quotas, cost per 1,000 battles, bottlenecks; the Free plan in battles per month (§7.8) |
| 8 | [Free tier](docs/08-free-tier.md) | What running on free plans takes: the static site, link previews, screenshots without a server, Supabase Free |
| 9 | [Import mode](docs/09-import-mode.md) | M6: players build locally and import the built site; the site pack, the site worker, storage |
| — | [Deploy](DEPLOY.md) · [Runbooks](docs/runbooks/README.md) | The free-plan deploy checklist; what to do when something breaks in production |
| — | [Workflow](docs/WORKFLOW.md) · [Board](docs/BOARD.md) | How the hub and worker agents operate; live task status |

## Stack (summary)

- **App:** Next.js (App Router), React, TypeScript, exported as a static site and served by a Cloudflare Worker with static assets (T-037, T-043; data loads in the browser)
- **Backend:** Supabase (Postgres + RPC, Realtime Broadcast/Presence, Storage, Edge Functions, pg_cron, anonymous auth)
- **Building:** on the player's own computer, with any tool. The BUILD stage imports the built static site (a folder or a `.zip`) and packs it into one `site.bin` (`@br/site`)
- **Sandbox:** a cross-site sandboxed iframe on a second site; the shell's service worker (`/v2/sw.js`) serves the imported site as if from a static host (`apps/sandbox-shell`, `@br/runtime`)
- **Screenshots:** headless Chromium (Cloudflare Browser Rendering) renders the shipped site through the same site worker, with a client-captured thumbnail as fallback
