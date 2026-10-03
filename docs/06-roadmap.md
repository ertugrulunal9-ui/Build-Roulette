# 6. Implementation plan

The plan is ordered to **retire the biggest risks first** (see [02-risks](02-risks.md)).
Each milestone ends with something you can play and a list of exit criteria. Nothing in a
later milestone starts until the current milestone's exit criteria are met.

```
M0 Foundations ─► M1 Sandbox spike ─► M2 Solo loop + capture/destroy ─► M3 Rooms + state machine ─► M4 Reveal/vote/results ─► M5 Hardening ─► M6 Polish + launch
   ~1 wk            ~2 wk                 ~2 wk                              ~2 wk                       ~2 wk                    ~2 wk           ~2 wk
```
(Rough effort for one experienced engineer, about 13 weeks in total. These are estimates, not dates.)

---

### M0: Foundations
**Scope**
- pnpm + Turborepo monorepo with the layout in [01 §1.8](01-architecture.md#18-proposed-repository-layout)
- Next.js app shell, Tailwind for app UI, ESLint, Prettier, strict TS, Vitest
- Supabase project (local via the Supabase CLI and a hosted staging project), migrations folder, pgTAP harness
- Anonymous sign-in plus Turnstile
- CI: lint, typecheck, unit tests, pgTAP, and Vercel preview deploys per PR
- Register the app domain and the **separate** usercontent domain, wildcard DNS and TLS on Cloudflare

**Exit criteria:** a PR deploys a preview. `supabase db reset` runs migrations and tests
green. Anonymous sign-in works on the preview.

### M1: Sandbox spike (retires R1, R2 design, R5 local, R7)
**Scope**
- `packages/runtime`: esbuild-wasm worker with the `vfs`, `cdn-rewrite`, `css` and `assets` plugins
- `apps/sandbox-shell`: versioned shell, CSP and permissions headers, import map, MessageChannel handshake, console and error forwarding, heartbeat, `reset-storage`
- `packages/protocol`: zod-typed messages
- CodeMirror 6 editor, file tree, `react-ts` template, IndexedDB persistence, error overlay, paste-import of multiple files
- Package proxy for esm.sh behind our hostname with a deny list
- Package compatibility smoke suite (Playwright) for about 100 popular frontend packages
- Device and browser checks

**Exit criteria**
- Standalone `/playground` page: edit React+TS and get a live preview
- Cold start < 3 s and rebuild < 300 ms p50 on a mid-range laptop, measured in Chrome, Firefox and Safari
- ≥90% of the package suite renders. Known failures are documented with reasons.
- Infinite loop in user code → watchdog recovers in ≤5 s with the app still responsive
- A security review of the iframe and shell config is done (a checklist from the threat model in [03 §3.9](03-sandbox.md#39-threat-model))

**Go/no-go:** if the performance or compatibility targets fail, evaluate the Sucrase +
native ESM fallback, or Sandpack as a stopgap, before continuing.

### M2: Solo loop, capture and destroy (retires R3, R6)
**Scope**
- Schema for `prompt_cards`, `challenges`, `battles` (solo), `battle_players`, `builds` and `jobs`, with an initial deck of about 60 builds, 40 rules and 30 styles
- Solo battle: SPIN (animation) → BUILD (timer) → SHIP → RESULTS (screenshot) → DESTROY
- `ephemeral-builds` bucket and policies, ship upload, `ship_build` RPC, autosave
- capture-worker (Edge Function → Cloudflare Worker → Browser Rendering → WebP), capture mode in the shell, client thumbnail fallback
- destroy-worker, TTL sweep, and client-side wipe
- Permanent `/battles/[id]` results page (SSR) plus an OG image

**Exit criteria**
- After DESTROY, a script confirms that zero objects remain under the battle's prefix and that IndexedDB is empty
- 50 sample builds: ≥95% non-blank canonical screenshots, p95 under 10 s
- Killing the capture worker still produces a fallback image, and destroy still completes within its deadline

### M3: Rooms and the multiplayer state machine (retires R4, R5 remote)
**Scope**
- `rooms`, `room_members`, all RPCs from [05 §5.4](05-database.md#54-rpc-surface) except voting
- Join by link or code, lobby with ready-up, settings, host controls, kick
- `advance_battle` CAS, `sweep_deadlines` cron, clock offset, client nudges
- Realtime Broadcast triggers, private channel authorization, Presence activity sidebar
- Reconnect and resync loop, auto-ship (client and server), host migration, abandonment
- `battle_events` log plus an admin page to inspect it

**Exit criteria**
- pgTAP tests cover every transition and guard in [04 §4.3](04-state-machine.md#transition-table)
- Playwright: 6 browser contexts complete a battle. A chaos variant randomly drops and
  restores network, skews clocks by ±5 min and refreshes tabs. Every run ends in a
  consistent terminal state with no lost shipped builds.
- With all clients closed at T-0, the battle still advances and auto-ships via cron alone

### M4: Reveal, vote and results
**Scope**
- Synchronized spotlight reveal: one live iframe, prefetch of the next bundle, thumbnails for the rest, host skip, "user build" chrome, report button
- Voting UI, `cast_vote`, vote progress, tally, awards, auto-awards
- Results ceremony, last-look window, then the **DESTROY** ceremony (a visual moment), then rematch into a new battle
- Player history page `/u/[id]`

**Exit criteria**
- A full party battle (SPIN → … → DESTROY → rematch) works with 2–8 players across desktop browsers, and mobile works for reveal and vote
- Tie-break and shared-award cases are covered by tests
- Ballots are never readable by other clients (verified by an RLS test)

### M5: Hardening (retires R8, R9, R10)
**Scope**
- Load test with 50 concurrent rooms × 8 players (scripted clients). Map Realtime connections, messages and egress to plan limits and costs.
- Self-hosted esm.sh behind Cloudflare, plus a Service Worker cache for template packages
- Moderation: profanity filter, report queue and admin takedown, rate limits on room creation, joins and reports
- Sentry and PostHog dashboards: funnel, sandbox metrics, capture success rate, destroy lag
- Runbooks: stuck battle, capture backlog, CDN outage

**Exit criteria:** load test passes with p95 phase-change propagation under 1 s, and
there's a written cost per 1,000 battles. Every runbook has been rehearsed once on staging.

### M6: Polish and launch
**Scope**
- Onboarding: preview the template during the spin, a first-time tooltip tour, and sounds and haptics for spin, ship and destroy
- More templates (Tailwind, Canvas game, SVG art) and an optional TS type-checking worker
- A curated deck with weights and tag-based combo filtering
- Share flows: results card image, "challenge a friend with this exact spin"
- Optional account linking (GitHub or Google) to claim history

**Exit criteria:** 20 external playtest sessions. Median time from link to first preview
is under 30 s, and at least 70% of players ship.

---

## Later (explicitly not v1)
- **Full-stack mode** with WebContainers through the `SandboxRuntime` interface (with a
  license) for builds that need a backend
- An in-editor AI assistant (cost and fairness questions: same model for everyone?)
- Public matchmaking, tournaments, daily challenge with a global leaderboard
- Spectator mode at scale (streamers): a read-only Realtime fan-out channel
- React Fast Refresh in the preview
- Builder-chosen "hero frame" screenshots and a short GIF capture of the reveal

## Testing strategy (across milestones)
| Layer | Tooling | What |
|---|---|---|
| SQL | pgTAP | Every RPC guard, transition, RLS policy (including "can't read ballots" and "can't write tables") |
| Runtime | Vitest + Playwright | Bundler plugins, protocol validation, package compatibility suite |
| Game | Playwright multi-context | Full battles, chaos (network drops, clock skew, refreshes), host leaving |
| Security | Manual + scripted | Sandbox escape checklist, CSP regression test, capture-URL signature check |
| Load | k6 / scripted supabase-js clients | Rooms × players, Realtime throughput, Storage egress |
