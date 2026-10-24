# 2. Hardest technical risks

Ranked by **impact × uncertainty**. Every risk has a mitigation and a concrete way to
validate it early. The roadmap ([06](06-roadmap.md)) is ordered to retire the top risks first.

| # | Risk | Impact | Uncertainty | Retired in |
|---|------|--------|-------------|-----------|
| R1 | ~~In-browser runtime is fast and compatible enough with real-world frontend packages~~ | — | — | M1; no longer applies since M6 (no in-browser bundler) |
| R2 | Running untrusted builds safely in other players' browsers | Critical | Medium | M1 (design), M5 (hardening) |
| R3 | Permanent screenshots are faithful, authentic and reliable | High | High | M2 |
| R4 | Phase/timer consistency without a game server (disconnects, clock skew, races) | High | Medium | M3 |
| R5 | No lost work: tab crash, refresh or network loss at T-0 | High | Medium | M1 + M3 |
| R6 | Destroy is actually complete (every copy of the source is gone) | Medium | Medium | M2 |
| R7 | Device and browser variance (Safari, mobile, low-RAM Chromebooks) | Medium | High | M1 |
| R8 | Realtime limits and cost at scale | Medium | Low | M5 |
| R9 | Abuse: offensive builds or names, phishing, crypto-mining, vote stuffing | Medium | Medium | M5 |
| R10 | Third-party dependency outage mid-battle (Supabase, Browser Rendering) | Medium | Low | M5 |
| R11 | Service Worker support: the site worker in players' browsers and in Browser Rendering | High | Low (Browser Rendering verified 2026-10-21) | M6 |
| R12 | Players import their project's source (or a site that needs a server) instead of a static build | Medium | High | M6 |
| R13 | Cheating with a site made before the battle | Medium | High | M6 (accepted) |

---

### R1: In-browser runtime speed and package compatibility (no longer applies)
> **Status: retired in M1, then made moot by M6.** M1–M5 bundled each build in the browser
> (esbuild-wasm in a Web Worker) and loaded npm packages as ES modules from a package CDN (our
> own `@br/pkg-cdn`, then the public esm.sh on the free plan). T-003 and T-006 measured a
> ~200 ms worker cold start and a ~124 ms rebuild + preview p50; the package compatibility
> suite passed 54/55 cases on our CDN (T-007) and 52/57 on esm.sh (CI run 60). Import mode (M6, [09](09-import-mode.md))
> removed the editor, the bundler and the package CDN: players build with their own tools, and
> a built site carries its own packages. What replaces this risk is whether a built site runs
> unchanged in the sandbox (R11) and whether players import a build at all (R12).

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
- a loop-guard transform (CodePen-style) is not possible any more: since M6 the game never
  transforms a player's code, it serves the built files as they are.

**The opposite failure, false crashes (T-027, T-031):** on a starved machine the watchdog
used to report healthy builds as frozen. That happened during a slow load (T-027: a 15 s
load grace), and also when the app page itself got no CPU for 5 s (T-031). Since T-031 every
watchdog limit counts only the time the app's own timers ran, so the app's stall is never
blamed on the build. The residual trade-off: on a tab that is starved all the time, a real
loop is caught after 5 s of *app-awake* time, which is longer on the wall clock. Production
visibility: every crash is a `preview_crash` analytics event with the stall evidence, and
`sync_health` counts the false crashes avoided (`preview_spared`), docs/03 "Watchdog under
starvation".

### R3: Faithful, authentic, reliable screenshots
**Why it's hard.** The screenshot is the only permanent artifact. Client-side
DOM-to-canvas libraries (html2canvas, html-to-image) miss WebGL, some CSS, cross-origin
images and video. Anything the client uploads can also be forged. The screenshot has to
exist before we destroy the source, and builds that start with an empty or "press start"
screen look boring.

**Mitigations**
- The **canonical screenshot** comes from a server-side headless Chromium render of the
  exact shipped site pack, with a fixed 1280×800 viewport and deterministic fonts. The capture
  page loads the site through the same site worker as the preview (R11).
- The shell runs in *capture mode*. It reports `ready` when the site calls
  `window.buildRoulette.ready()` (optional), and otherwise
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
**Mitigations.** Since M6 the work itself lives on the player's computer, in their own
project; the game only holds the last import. Every import is stored in IndexedDB at once and
uploaded as `autosave/site.bin` (retried with backoff until it lands), so if a player is
offline at T-0 the server can **auto-ship** the last uploaded import
(`status = 'auto_shipped'`). A reload restores the import from IndexedDB first and from the
remote autosave second. A player who imports nothing before the deadline ends DNF.

### R6: Destroy is actually complete
**Where copies of a build exist:** the player's own project on their computer (theirs, not
ours to delete), the player's IndexedDB (the last import), the ephemeral bucket, voters'
memory, the sandbox-origin storage (the site worker keeps the few most recent sites in Cache
Storage), Browser Rendering's session, and CDN caches of signed URLs.

**Mitigations.** We delete by prefix (`ephemeral-builds/{battle_id}/`), not file by file.
Signed URLs are short-lived and sent with `Cache-Control: no-store`, so nothing is
CDN-cached. Browser Rendering sessions are closed after each capture. The shell wipes its
origin's storage (the site worker's registration and Cache Storage included) on every load
and on `reset`. The hourly TTL sweep removes anything older
than 24 h, including orphans. Source never goes into Postgres, so database backups don't
keep it.

**Honest limit.** We can't force-wipe a disconnected viewer's browser. Their copy is in
memory only (or in sandbox-origin storage, which the next load of that origin wipes).

### R7: Device and browser variance
Desktop Chromium, Firefox and Safari are the targets. Building needs a computer (the
player's own tools); phones **watch and vote**. Because we use an iframe and a Service Worker
instead of WebContainers, we avoid COOP/COEP and the SharedArrayBuffer requirements that are
most fragile on Safari. Service Workers have their own gaps (R11).

### R8: Realtime limits and cost
Presence activity goes out only during BUILDING and only on an import (≤1 per 15 s per
player, T-029; `{imported, imports}` since M6). Broadcast payloads are
tiny `{type, version}` hints. Each player uses one channel per battle. We load-test 50
concurrent rooms × 8 players in M5 and map the results to plan quotas.

### R9: Abuse
> **Status (M5): mitigated in T-024:** reporting, an admin queue with takedown, a name filter, per-user rate limits and Turnstile wiring. Production still needs the admin users, the Turnstile keys and Cloudflare per-IP rules (see the board).
> T-026 caches the public pages; a takedown from `/admin` revalidates them at once. One made with SQL does not: cached copies then show the build for up to an hour (apps/web/DEPLOY.md, "Caching").

Display names and build names go through a profanity filter. Rooms are private unless
shared. The host can kick, and kicked players' builds are hidden. There is a report queue
with screenshot takedown. Anonymous sign-ups are rate-limited with Turnstile.
**Vote stuffing:** only players on the roster when BUILDING started can vote (a frozen
eligibility snapshot). Late joiners are spectators and can't vote (a non-ranking "crowd favorite"
for spectators is a post-v1 idea).
**Pre-built code:** see R13.

### R10: Third-party outage mid-battle
**No package CDN since M6.** M1–M5 loaded every build's npm packages from a package CDN (the
public esm.sh on the free plan), and T-032 kept a browser-side warm-up so a CDN outage did not
stop a battle. Import mode removed that dependency: a built site carries its own packages. A
site may still load scripts from public CDNs itself (the Tailwind play CDN, unpkg); while such
a CDN is down, only that site breaks, and its capture falls back to the client thumbnail.

The T-032 decision "no Service Worker or Cache Storage" no longer stands: the shell now serves
every imported site from a Service Worker that keeps the most recent sites in Cache Storage.
Why that is safe enough, and what build code can and cannot do to it, is in
[03-sandbox](03-sandbox.md) §3.9 "The site worker".

A Supabase blip has no effect on building (local) or on the preview of an import (local).
An import's upload, the ship and the votes retry with backoff, and auto-ship covers the
deadline. If Browser Rendering is down, the client fallback thumbnail is used.

### R11: Service Worker support
**Why it's hard.** A built site needs a static host: root-relative URLs, lazy chunks,
`fetch('/data.json')`, a client-side router that expects `/`. The shell gives it one with a
Service Worker on the sandbox origin (docs/09 §9.3). That needs Service Workers in a
cross-site iframe in every browser that previews, and in the headless browser that captures.

**Mitigations**
- Current Chromium, Firefox and Safari run Service Workers in a cross-site iframe with
  storage partitioning. Where they are off (Firefox private windows), the preview says so
  clearly, and REVEAL shows the screenshot instead.
- The worker keeps its sites and its client → site map in Cache Storage, so a browser that
  stops an idle worker does not lose the site; the shell registers it again on every load.
- **Browser Rendering must run Service Workers** for the v2 capture page. The Playwright
  stand-in (full Chromium) does, and so does Cloudflare's REST API: verified 2026-10-21 on the
  first production solo battle after the M6 deploy (a full 1280×800 render of an imported
  Vite site, not the client thumbnail). If that ever changes, every capture falls back to the
  client thumbnail: the game still works, the screenshots are lower fidelity. DEPLOY.md "Deploying M6" and the capture-backlog runbook (step 7) say how to
  see it; the self-hosted capture worker is the way out.

**Validate (M6).** The runtime and web e2e suites run imported sites through the site worker
in Chromium; the first production battle after the deploy showed that Browser Rendering
captures them (2026-10-21). Health → "Screenshots, last 24 h" keeps watching it.

### R12: Importing source instead of a build
**Why it's hard.** Vibe coders often do not know what "the built site" is. The likely
mistakes: dropping the project folder before running the build (Vite's unbuilt `index.html`
points at `.tsx`), a Next.js project without a static export, or a site that needs its own
server (an API route, server-side rendering).

**Mitigations**
- The import recognizes the common cases and says what to do: unbuilt source → "run
  `npm run build` (or ask your AI tool to build it) and drop the `dist` folder"; `.next/`
  without `out/` → set `output: 'export'`. It prefers known output folders (`dist/`,
  `build/`, `out/`, …) when the whole project is dropped (docs/09 §9.2).
- `/try` lets a player check an import before a battle; the onboarding (T-049, planned) will explain
  the four steps and give per-tool tips.
- A site that needs a server runs as far as its static part goes; its requests to its own
  API fail inside the preview only.

**Residual.** A player who never manages a build ends DNF. Time limits start at 10 minutes
so that building and importing fit.

### R13: Cheating with a site made before the battle
**Why it's hard.** The game cannot see how a site was made. A player can import a site they
built before the battle, or someone else's.

**Mitigations.** None that enforce it, by design: it is a party game among people who share a
room link. The random BUILD, RULE and STYLE cards make a ready-made site a poor fit, players
vote on what they see, and the host can kick. Stats (`imports`, the completion time) are
shown for fun, not as proof.

**Residual (accepted).** A determined player can always cheat this way.
