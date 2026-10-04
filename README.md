# Build Roulette

A multiplayer party game for vibe coders.

Everyone in the room gets the same random **BUILD**, **RULE**, **STYLE** and **TIME LIMIT**.
You race to make a small browser app in a disposable in-browser workspace, ship it,
reveal everyone's builds, vote, and see the results.

```
SPIN → BUILD → SHIP → REVEAL → VOTE → RESULTS → DESTROY BUILD
```

> **Builds are temporary. Results are permanent.**

No deploys, no installs, no accounts required. Once a battle ends, each build's source
and bundle are deleted. What stays is the challenge, the builder, the build name, the
completion time, a screenshot, the awards and the battle results.

## Status

Design phase. Nothing is implemented yet. Start with the design docs:

| # | Document | Covers |
|---|----------|--------|
| 1 | [Production architecture](docs/01-architecture.md) | System diagram, components, what runs on the client vs. the server vs. the sandbox, key flows, decisions, cost |
| 2 | [Technical risks](docs/02-risks.md) | The hardest problems, ranked, with mitigations and validation spikes |
| 3 | [Disposable sandbox](docs/03-sandbox.md) | In-browser runtime, preview isolation, npm resolution, workspace lifecycle, threat model |
| 4 | [Multiplayer state machine](docs/04-state-machine.md) | Room / battle / player / build states, transitions, timers, realtime, reconnects |
| 5 | [Database schema](docs/05-database.md) | Postgres DDL, RLS, RPCs, storage buckets, jobs, retention |
| 6 | [Implementation plan](docs/06-roadmap.md) | Milestones with exit criteria, riskiest work first |
| — | [Workflow](docs/WORKFLOW.md) · [Board](docs/BOARD.md) | How the hub and worker agents operate; live task status |

## Planned stack (summary)

- **App:** Next.js (App Router), React, TypeScript, on Cloudflare Workers (via the OpenNext adapter)
- **Backend:** Supabase (Postgres + RPC, Realtime Broadcast/Presence, Storage, Edge Functions, pg_cron, anonymous auth)
- **Sandbox:** a custom in-browser runtime: esbuild-wasm in a Web Worker, npm packages served as ES modules from an esm.sh-compatible CDN, preview in a cross-site sandboxed iframe. It sits behind an interface so WebContainers can be added later for full-stack modes.
- **Editor:** CodeMirror 6
- **Screenshots:** headless Chromium (Cloudflare Browser Rendering) renders the frozen bundle, with a client-captured thumbnail as fallback
