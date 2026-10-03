# 2. Hardest technical risks

Ranked by **impact × uncertainty**. Every risk has a mitigation and a concrete way to
validate it early. The roadmap ([06](06-roadmap.md)) is ordered to retire the top risks first.

| # | Risk | Impact | Uncertainty | Retired in |
|---|------|--------|-------------|-----------|
| R1 | In-browser runtime is fast and compatible enough with real-world frontend packages | Critical | High | M1 |
| R2 | Running untrusted builds safely in other players' browsers | Critical | Medium | M1 (design), M5 (hardening) |
| R3 | Permanent screenshots are faithful, authentic and reliable | High | High | M2 |
| R4 | Phase/timer consistency without a game server (disconnects, clock skew, races) | High | Medium | M3 |
| R5 | No lost work: tab crash, refresh or network loss at T-0 | High | Medium | M1 + M3 |
| R6 | Destroy is actually complete (every copy of the source is gone) | Medium | Medium | M2 |
| R7 | Device and browser variance (Safari, mobile, low-RAM Chromebooks) | Medium | High | M1 |
| R8 | Realtime limits and cost at scale | Medium | Low | M5 |
| R9 | Abuse: offensive builds or names, phishing, crypto-mining, vote stuffing | Medium | Medium | M5 |
| R10 | Third-party dependency outage mid-battle (package CDN, Supabase, Browser Rendering) | Medium | Low | M5 |

---

### R1: In-browser runtime speed and package compatibility
> **Status (M1): retired.** In T-003 and T-006, measured on localhost:
> - worker cold start ~200 ms, rebuild + preview p50 ~124 ms;
> - compatibility suite: **52/55 cases, 51/52 packages (94.5%)**, against our own CDN with
>   real npm packages. The hub reproduced this on an empty cache.
>
> Known failures:
> - pixi.js v8 needs `'unsafe-eval'` in the shell CSP; this is being fixed in T-007;
> - side-effect subpaths such as `pixi.js/unsafe-eval` would need shared chunks per
>   package;
> - matter-js named imports fail (a UMD build, so it needs `import Matter from 'matter-js'`).
>
> See `apps/pkg-cdn/compat/RESULTS.md`.

**Why it's hard.** The npm ecosystem assumes Node and a bundler. Some packages are CJS-only,
expect `process.env`, import CSS or assets, have peer dependency trees, or end up with two
copies of React (which breaks hooks with "Invalid hook call"). esbuild-wasm is several MB and
has to start in under a few seconds.

**Mitigations**
- The bundler only bundles *local* files. Bare imports are rewritten to ESM CDN URLs
  (esm.sh already converts CJS to ESM and resolves the dependency tree on the server).
- A single import map in the shell pins `react`, `react-dom`, `react/jsx-runtime`. Every CDN
  package is requested with `?external=react,react-dom`, so there is exactly one React.
- Package CSS (`import 'x/dist/x.css'`) is fetched by the worker and inlined.
- `process.env.NODE_ENV` is defined at build time. Node built-ins are not supported, and
  the error says so clearly.
- esbuild-wasm is preloaded during the lobby and cached by HTTP and a Service Worker. The
  worker is reused across rebuilds and incremental contexts are kept warm.
- A compatibility test suite renders a smoke test for the top ~100 frontend packages (state,
  animation, charts, 3D, audio, utility) in CI against the shell.

**Validate (M1 spike).** Cold start under 3 s on a mid-range laptop. Rebuild under 300 ms
for a 10-file project. At least 90% of the curated package list passes the smoke test.
**Fallback.** If esbuild-wasm is too heavy on low-end devices, transpile per file with
Sucrase (about 200 KB) and use native ESM plus import maps without bundling.

### R2: Running untrusted builds safely in other players' browsers
**Why it's hard.** During REVEAL every player runs every other player's code. A malicious
build could try to steal the viewer's session, phish ("your session expired, log in"),
mine crypto, freeze the tab, spawn popups, or fingerprint or attack the viewer.

**Mitigations** (full threat model in [03-sandbox §3.9](03-sandbox.md#39-threat-model))
- Builds run on a **different registrable domain**, in an `<iframe sandbox>` with no
  top-navigation and no escaping popups, plus a restrictive `allow=` permissions policy (no
  camera, mic or geolocation). They can't reach app cookies, storage or the DOM.
- The app accepts postMessage only from a `MessageChannel` port that it transferred after
  a nonce handshake. Every message is validated with a zod schema.
- A heartbeat watchdog kills the iframe if it misses heartbeats. Infinite loops get
  "Build crashed. Skip →", not a frozen game.
- Reveal shows **one live build at a time**. The rest of the gallery uses thumbnails.
- The app UI frames each build with a "user-made build" chrome bar, so phishing forms are
  visibly inside a frame.
- There is a report button. The host can skip or kick. Screenshots can be taken down.

**Residual risk.** CPU abuse in a cross-site iframe in the same process (Safari and
mobile Chrome don't always isolate cross-site frames in a separate process). We accept
this for a party game among people sharing a room link, and limit exposure with the
watchdog and the "one live build" rule.

**Confirmed by T-003 (M1 spike):** the watchdog only helps when the browser puts the
cross-site iframe in its **own process**. Playwright's headless shell keeps it in the app's
process, and there an infinite loop froze the app page itself, so no JavaScript watchdog
could run. Full Chromium with site isolation kept the app responsive (worst timer gap
≤ 58 ms) and the watchdog fired after about 5 s. On browsers without strict site isolation
(Safari, low-RAM Android Chrome), a looping build can freeze the viewer's tab. Further
mitigations:
- reveal shows a "Skip build" control *outside* the iframe that also works after a reload;
- mobile viewers see screenshots by default and open a live build by tapping;
- a future option is a loop-guard transform in the bundler (CodePen-style) as defence in depth.

### R3: Faithful, authentic, reliable screenshots
**Why it's hard.** The screenshot is the only permanent artifact. Client-side
DOM-to-canvas libraries (html2canvas, html-to-image) miss WebGL, some CSS, cross-origin
images and video. Anything the client uploads can also be forged. The screenshot has to
exist before we destroy the source, and builds that start with an empty or "press start"
screen look boring.

**Mitigations**
- The **canonical screenshot** comes from a server-side headless Chromium render of the
  exact frozen bundle, with a fixed 1280×800 viewport and deterministic fonts.
- The shell runs in *capture mode*. It reports `ready` when the app calls
  `window.buildRoulette.ready()` (optional, documented in the template), and otherwise
  after network-idle + 2 s, capped at 6 s. WebGL is created with `preserveDrawingBuffer`
  where the shell can patch `getContext`.
- A client thumbnail is captured at ship time as a **fallback** and flagged as such
  (`capture_status = 'fallback'`).
- Destroy is **gated** on capture reaching a terminal state (captured, fallback or failed)
  or a capture deadline of 10 minutes. Results are never left with no image unless both
  paths failed, and in that case we show a styled placeholder card.
- *Later:* let the builder pick a "hero frame" during the ship flow.

**Validate (M2).** 50 varied sample builds, including canvas, WebGL, SVG animation,
audio-only and empty states. At least 95% get a non-blank canonical screenshot in under
10 s.

### R4: Phase and timer consistency without a game server
**Why it's hard.** There is no process holding a `setTimeout`. Clients have skewed clocks,
disconnect, double-submit and race (two clients advance at the same moment, someone ships
at T+0.2 s). The host may leave mid-battle.

**Mitigations** (details in [04-state-machine](04-state-machine.md))
- Every transition goes through `advance_battle(battle_id, expected_version)`. It runs
  under `SELECT … FOR UPDATE` and is idempotent: callers that lose the race get a no-op.
- Deadlines are absolute server timestamps (`phase_ends_at`). Clients estimate the clock
  offset from `server_now()` round trips (NTP-style, best of 3).
- Any client may nudge an overdue battle, and pg_cron sweeps every few seconds as a backstop.
- The SHIPPING grace phase (15 s) absorbs uploads that are still in flight at T-0.
- Once BUILDING starts, the battle doesn't need the host: deadlines drive the flow. Host
  powers move to the longest-present player if the host is absent for 30 s.
- pgTAP tests cover every transition guard. Playwright runs multi-context tests with
  forced disconnects and clock skew.

### R5: No lost work
**Mitigations.** IndexedDB is written on every change (debounced 300 ms). Remote autosave
of source and the last good bundle happens every 30 s and on `visibilitychange`, so if a
player is offline at T-0 the server can **auto-ship** the last autosaved bundle
(`status = 'auto_shipped'`). Auto-ship also runs client-side at T-0. A reconnect restores
the workspace from IndexedDB first and from remote autosave second.

### R6: Destroy is actually complete
**Where copies of a build exist:** the player's IndexedDB, the ephemeral bucket, voters'
memory and the sandbox-origin storage, Browser Rendering's session, and CDN caches of
signed URLs.

**Mitigations.** We delete by prefix (`ephemeral-builds/{battle_id}/`), not file by file.
Signed URLs are short-lived and sent with `Cache-Control: no-store`, so nothing is
CDN-cached. Browser Rendering sessions are closed after each capture. The shell wipes its
origin's storage on every load and on `reset`. The hourly TTL sweep removes anything older
than 24 h, including orphans. Source never goes into Postgres, so database backups don't
keep it.

**Honest limit.** We can't force-wipe a disconnected viewer's browser. Their copy is in
memory only (or in sandbox-origin storage, which the next load of that origin wipes).

### R7: Device and browser variance
Desktop Chromium, Firefox and Safari are the build targets. Mobile is **reveal and vote
only** in v1, because building on a phone is a poor experience. Mobile players can join as
spectators or voters. Because we use a plain worker and iframe instead of WebContainers, we
avoid COOP/COEP and the SharedArrayBuffer requirements that are most fragile on Safari.
A device check in the lobby warns about low memory or unsupported browsers before the spin.

### R8: Realtime limits and cost
Presence pulses are throttled (≤1 per 2 s per player) and coalesced. Broadcast payloads are
tiny `{type, version}` hints. Each player uses one channel per battle. We load-test 50
concurrent rooms × 8 players in M5 and map the results to plan quotas.

### R9: Abuse
Display names and build names go through a profanity filter. Rooms are private unless
shared. The host can kick, and kicked players' builds are hidden. There is a report queue
with screenshot takedown. Anonymous sign-ups are rate-limited with Turnstile.
**Vote stuffing:** only players on the roster when BUILDING started can vote (a frozen
eligibility snapshot). Late joiners are spectators and can't vote (a non-ranking "crowd favorite"
for spectators is a post-v1 idea).
**Pre-built code:** a player who pastes code they wrote beforehand is inherently possible
and part of the vibe. Random rules make this less useful, and stats such as edit and
paste counts are shown for fun, not as enforcement.

### R10: Third-party outage mid-battle
The package CDN is our own service (`@br/pkg-cdn`) behind the Cloudflare cache, with no dependency on esm.sh, and the template's core packages (React)
are cached by our Service Worker after the lobby preload. A Supabase blip has no effect
on editing and preview, which are fully local. Ship retries with backoff, and auto-ship
covers the deadline. If Browser Rendering is down, the client fallback thumbnail is used.
