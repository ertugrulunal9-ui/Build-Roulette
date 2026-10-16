# @br/runtime: the sandbox preview (app side)

The app side of the sandbox from [docs/03-sandbox.md](../../docs/03-sandbox.md), for imported
sites ([docs/09-import-mode.md](../../docs/09-import-mode.md), M6): a player builds a static
site with their own tools and imports the built site (`@br/site` packs it). `PreviewHandle`
runs a site pack in a cross-site sandboxed iframe, talks to the shell over a validated bridge
and watches it with a watchdog. It works together with:

- [`@br/protocol`](../protocol): zod schemas, types and size caps for the app <-> shell bridge
  (protocol v2).
- [`@br/sandbox-shell`](../../apps/sandbox-shell): the versioned shell (`/v2/`) served from the
  usercontent origin, its site worker (`/v2/sw.js`) that serves imported sites, the capture
  page, and their headers.
- [`@br/site`](../site): the site pack (`packSite`, `unpackSite`, `SITE_LIMITS`).

The in-browser bundler (esbuild-wasm), the package CDN machinery and `SandboxRuntime` are
gone with M6 (T-045): there is no build step in the browser any more.

## Architecture

```
 App origin (trusted)                     Sandbox origin (untrusted)
 ┌──────────────────────────────┐        ┌─────────────────────────────────────────────┐
 │ site pack (@br/site)         │        │ shell.js (/v2/, outer realm)                │
 │ PreviewHandle                │  port  │  ├─ handshake, port, ping/pong              │
 │  ├─ iframe owner (sandbox,   │◄──────►│  ├─ reset-storage, thumbnails               │
 │  │  allow per mode)          │(Message│  └─ per load: unpack → site worker upload   │
 │  ├─ bridge validation,       │Channel)│       → NEW child iframe /?__br_site=<id>   │
 │  │  budgets                  │        │ sw.js (site worker, scope /)                │
 │  └─ watchdog (ping/pong,     │        │  └─ serves the site: /assets/x.js, /data.json│
 │     load grace, awake clock) │        │     SPA fallback, bootstrap in every HTML   │
 └──────────────────────────────┘        └─────────────────────────────────────────────┘
```

| Piece | File |
|---|---|
| `PreviewHandle` (iframe, handshake, validation, watchdog) | `src/preview/preview-handle.ts` |
| Message budgets, retained console | `src/preview/budget.ts` |
| Two-origin dev server (app, shell, plus a third origin for tests) | `test-support/dev-server.ts` |
| Playground (import a `dist` folder, console panel; e2e driver) | `playground/` |

`PreviewHandle.load({site}, mode)` sends `load {loadId, mode, site}`. `site` is a site pack
(`ArrayBuffer` or `Uint8Array`) of at most `SITE_LIMITS.maxPackBytes`; the handle sends a
copy (never a transfer), so the caller keeps its pack for `restart()` and later loads, and a
larger pack throws a `RangeError`.

## Preview isolation and bridge
- The iframe's `sandbox` and `allow` depend on the run mode (`PREVIEW_SANDBOX_BY_MODE`,
  `PREVIEW_ALLOW_BY_MODE`), plus `referrerpolicy="no-referrer"` and `loading="eager"`:

  | Mode | `sandbox` | `allow` |
  |---|---|---|
  | `live` (your own build while building) | `allow-scripts allow-same-origin allow-forms allow-modals allow-pointer-lock allow-popups` | `autoplay; fullscreen; gamepad; clipboard-write` |
  | `reveal`, `capture` (someone else's build, the capture renderer) | `allow-scripts allow-same-origin allow-forms allow-pointer-lock` | `autoplay; fullscreen; gamepad` |

  Reveal and capture drop `allow-popups` (a popup outlives the build and can phish outside
  the app chrome), `clipboard-write`, and also `allow-modals`: `alert`/`confirm`/`prompt`/`print`
  from someone else's build would block the viewer's tab (or stall the headless capture
  renderer) and are a phishing vector, and they are not needed to show a finished build.
  Without the flag they return at once (`confirm` → `false`, `prompt` → `null`). Live keeps
  modals for `alert()` debugging. `allow-forms` stays in every mode: without it the `submit`
  event never fires, so React `onSubmit` handlers would break; actual form navigation is
  blocked by the shell's `form-action 'none'` instead. Sandbox flags only apply when the
  frame navigates, so they are set before the shell loads, and a mode switch replaces the
  iframe element (see "Reset isolation"). The shell's per-load child frame gets the same
  mode's `allow`. Fullscreen is delegated through `allow` only: setting the legacy
  `allowfullscreen` as well makes Chromium warn that `allow` takes precedence.
- Handshake: the shell posts `hello {protocol}` to each allowlisted app origin (a non-matching
  `targetOrigin` is dropped by the browser). The app accepts it only if `event.origin` is the
  shell origin **and** `event.source === iframe.contentWindow` (`checkHello`), then transfers a
  `MessageChannel` port with a random nonce in `connect`. The shell answers `connected {nonce}`
  on the port. After that, both sides use only the port. Every message is validated with
  `@br/protocol` on receipt; invalid messages are dropped and counted (`stats.rejectedMessages`).
- **One handshake per iframe load.** Every navigation the handle starts itself (attach, mode
  switch, `resetStorage()`, `restart()`) arms exactly one expected `hello`. Once it has been
  answered, any further `hello` from the frame (the shell's retry timer, a reload the build
  triggered, code running in the shell's realm) is ignored and counted
  (`stats.ignoredHellos`); the port is never replaced behind the app's back. If the real
  shell went away, the watchdog notices.
- **Fresh frame per load** (protocol v2, docs/09 §9.3): `load {loadId, mode, site}` carries a
  site pack (`@br/site`). The shell unpacks it (`unpackSite`), registers the site worker
  (`/v2/sw.js`, scope `/`, `updateViaCache: 'none'`) and waits until it is active, hands it the
  files under a fresh random site id (128 bits) over a `MessageChannel` and waits for the ack,
  then removes the previous child iframe and creates a new same-origin child navigated to
  `/?__br_site=<id>`. The worker serves the site like a static host (see
  `apps/sandbox-shell/README.md`). Every HTML document it serves starts with an inline
  bootstrap that removes `__br_site` from the address (a router sees `/`) and calls the
  shell's attach hook, which installs the console/error hooks and `window.buildRoulette`
  before the site's own scripts run, in every document of the site (an in-site link or a
  reload gets them too). `ready {loadId}` is the child frame's first `load` event for the
  load; a later navigation inside the site sends no second one. A pack that cannot be read,
  a browser without service workers, or a script or stylesheet of the site that fails to
  load becomes `runtime-error {kind: 'module-load'}` with a message that says so (the first
  two with a `ready`).
- **Watchdog (ping round trips)**: while connected, the PreviewHandle sends `ping {seq}` every
  1 s. The shell answers `pong {seq}` from a `setTimeout(0)` task on its main thread, not
  synchronously in the port listener, so a pong shows that the event loop still runs tasks.
  A pong counts only for a `seq` that is still outstanding. The handle checks every 250 ms
  and emits `crash` (reason `heartbeat-timeout`, name kept for compatibility) when no pong
  arrived for 5 s of app-awake time (see "Starvation"), then takes the iframe out of the DOM. The shell no longer sends periodic
  `heartbeat`s; a `heartbeat` that arrives is counted (`stats.heartbeats`) but does not count
  as liveness, because anything holding the port can send one. When the app tab is hidden
  the check pauses, and when the tab becomes visible again the grace period restarts, so
  timer throttling cannot cause a false crash. `setTimeout` rather than
  `requestAnimationFrame`: an iframe scrolled out of view gets no animation frames.
- **Load grace (T-027)**: a `load` blocks the shell's main thread while the site starts. The
  site's frame is same-origin with the shell, so they share one event loop: the site's module
  graph compiles and evaluates in **one task**, and no pong can be sent until it finishes. On a
  contended CPU this took over 5 s (the chaos suite, load average 13–24 on 4 CPUs:
  `heartbeat-timeout` with about 5.3 s of silence right after a rebuild, while the app page
  kept rendering). Measured with CDP CPU throttling of the shell's renderer: the longest
  shell task and the longest pong gap both span the frame swap plus the evaluation of the
  new bundle. At x20, a ~600 KB bundle that evaluates in 45 ms unthrottled gave a 2.7 s task
  and a 3.0 s pong gap. So, for **`loadGraceMs` (15 s) after the handle sends a `load`**, and
  until the shell's `ready` for that load, up to 15 s of silence is tolerated instead of 5 s:
  - Only the handle opens the window, when it sends a `load` (or flushes a pending one on
    connect). Nothing the sandbox sends can open or extend it. `ready` is untrusted, so it can
    only shorten it, to `heartbeatTimeoutMs` from its arrival. That way the queued pongs that
    arrive just after a long evaluation are not raced by a tick. A `ready` for an older load,
    a duplicate one or one over the rate budget is rejected as before. A new shell (restart,
    reset, mode switch) starts with no window.
  - Silence is capped at `loadGraceMs`, however many loads the app sends meanwhile (a player
    typing into a frozen preview): the crash comes at the latest `loadGraceMs` after the
    last pong.
  - So a loop **after** `ready` (a game loop, a click handler) is still caught 4.0–5.25 s
    after it starts. A loop **during** the load (at a module's top level, before `ready`)
    can't be told apart from a slow evaluation until the window ends, so it is caught
    14–15.25 s after the load was sent. Detection is always within
    `max(freeze + 5.25 s, load sent + 15.25 s)`.
  - `crash` carries `phase` (`connecting`, `loading`: the latest load had not reported
    `ready`, or `running`), so the UI can say "didn't finish starting" rather than "froze".
  - Why not loading progress messages from the shell? The blocking part is a single task:
    the shell can't report anything from inside it, and an untrusted milestone could only
    ever shorten the grace anyway.
- **Starvation (T-031)**: the same false crash happened after `ready`, when the app page
  itself got no CPU for about 5 s (chaos shard 1: `heartbeat-timeout silentMs=5309
  phase=running`, no loop). While the app's main thread doesn't run, it can neither send
  pings nor receive pongs, so a wall-clock silence measured the app's own stall. Now every
  limit (the 5 s heartbeat limit, the load grace, the 10 s handshake timeout) is measured on
  an **app-awake clock**:
  - each watchdog tick advances the clock by at most one `watchdogIntervalMs` plus
    `TICK_JITTER_MS` (50 ms), so a tick that runs later (the app was stalled) counts as
    300 ms. The jitter allowance keeps a merely busy page (timers a few tens of ms late) from
    slowing loop detection;
  - events between ticks (pong, `ready`, a `load` send, the handshake) read it capped the
    same way, so it never runs backwards;
  - only the app's own timers move it. Nothing the sandbox sends does.
  - While the app's timers run on time, nothing changes: a loop after `ready` is caught
    4.0–5.25 s after it starts, and a loop during a load within 15.25 s of the send. With
    stalls, those are awake times, and wall-clock time is longer by the stalls.
  - A frame that doesn't answer for 5 s while the app is awake is still a crash.
  - Hidden tabs behave as before. Hidden time is neither awake time nor a stall.
  - `crash` adds `wallSilentForMs`, `stalledMs` (wall minus awake) and `longestStallMs`.
    `stats` adds `stalls` (ticks at least `STALL_MS` = 1 s late), `stallMs`,
    `longestStallMs`, and `sparedSilences`: silences the wall-clock rule would have called a
    crash, which then ended with a pong.
  - e2e `watchdog-starvation` stops every renderer of the browser for 7 s (SIGSTOP), and
    separately blocks both CPU-throttled pages with long tasks. The old watchdog crashed in
    both (silence 7.3 s / 6.0 s); now neither crashes, and a loop is still caught.
- **`PreviewHandle` takes its iframe out of the DOM on `crash`** (a comment node keeps its
  place), and `dispose()` removes it. Callers must therefore put the iframe in a container
  that React (or any other view library) does not manage. Create the iframe imperatively in
  a host element that renders no children, as `apps/web`'s `SandboxController` does.
  Otherwise the library's reconciliation and the handle both try to own the same node. To
  recover from a crash, call `restart()` (a new iframe in the same place) and `load()` again.
- **reset-storage** (shell side): tears down the running build (an open IndexedDB connection
  would block deletion), then clears `localStorage`, `sessionStorage`, every IndexedDB
  database, CacheStorage, cookies (see "Reset isolation"), the origin private file system,
  Storage Buckets and service worker registrations (the site worker and its Cache Storage
  included), then fetches `/v2/reset` for `Clear-Site-Data`, and acknowledges with
  `storage-reset {ok, errors?}`. `load`, `reset-storage` and `capture-thumbnail` run one at a
  time in arrival order, so a load sent right after a reset starts only once the wipe is
  done, and registers the site worker again.
- **App-side budgets** (`DEFAULT_PREVIEW_BUDGETS`, overridable with `budgets`): the handle
  does not rely on the shell's own console rate limit, because a build can post to the port
  directly. Per second it accepts at most 100 `console`, 20 `runtime-error` and 10 `ready`
  messages; `ready` also only for the latest load, once. The retained console
  (`consoleEntries()`, console lines, `Uncaught …` lines for errors and the app's own notices)
  is capped at 200,000 characters and 500 entries, evicting the oldest. Excess messages are
  dropped and counted (`stats.droppedMessages`), and at most once per second a `dropped`
  event plus a `[preview] N messages from the build dropped (rate limit)` console line
  report them. `apps/web` copies the console into React state at most once per animation
  frame, so a flood costs at most one render per frame.

## Trust model

The build runs same-origin with the shell (its document is the shell's child frame), so a
build can run code in the shell's realm, use the shell's port and start a new handshake.
The app therefore treats the sandbox as hostile:

- **Every shell → app message is untrusted display data.** `console`, `runtime-error` and
  `thumbnail` may be shown (validated, size-capped, rate-limited, rendered as text), never
  interpreted as commands. The app never takes an action that matters for the game because
  of a message from the sandbox.
- **`ready`, `heartbeat`, `pong` and `storage-reset` are hints only.** They may drive UI
  state (a spinner, "running"), but must never gate capture or destroy:
  - capture readiness is decided server-side by the capture worker, with a fixed wait and a
    cap (docs/03 §3.7); a `ready` from the shell can be early, late, forged or missing;
  - destroy never waits for a `storage-reset` ack, and nothing depends on its `ok`. Isolation
    comes from per-build origins and from replacing the preview iframe;
  - the watchdog's `pong`s are best-effort liveness (see "Known limitations").
- **The handshake happens once per load the app started.** A repeated `hello` is ignored.
- The protocol schemas in `@br/protocol` carry the same rules as doc comments.

## Reset isolation

- **`resetStorage()` and mode switches replace the whole preview iframe**, not only the
  shell's per-load child frame. A build can install timers, prototype patches or listeners
  in the shell's realm (`parent` is same-origin to it), and those survive the child frame's
  teardown. A new iframe element means a new shell document and realm, and nothing from
  the old one survives. Order for a reset: replace the iframe, wait for the new shell's
  handshake, send `reset-storage` as its first message, then any pending `load`. The ack
  resolves `resetStorage()` and is a hint only.
- **`load(build, mode)` with a different mode** replaces the iframe with one that has the new
  mode's `sandbox`/`allow` (flags only apply on navigation) and sends the load to the new
  shell. Storage is not wiped by a mode switch; call `resetStorage()` when a clean slate is
  needed. In production each build has its own origin anyway.
- **`restart()`** replaces the iframe the same way (also after a crash). The `frame` event
  reports every replacement with the new element. The replacement keeps the old element's
  other attributes (`id`, `class`, `style`, `data-*`, `title`).
- **Cookies** are cleared in three layers. (1) The Cookie Store API, where it exists: every
  visible cookie is overwritten with an expired `SameSite=None` copy, because `delete()`
  writes `SameSite=Strict`, which Chromium refuses in a cross-site iframe. (2) Without it,
  and for anything left: every visible name is expired for every path prefix of the
  shell's path (`/`, `/v2`, `/v2/`), for host-only, `Domain=<host>` and each parent domain,
  without security attributes, with `Secure; SameSite=None`, and with `Partitioned` on
  top. (3) `Clear-Site-Data` from `/v2/reset` removes what script cannot see at all:
  cookies on unrelated paths, HttpOnly cookies, the HTTP cache. With the usercontent apex
  not yet on the Public Suffix List, `"cookies"` clears the whole registrable domain, so
  other builds' cookies in the same browser go too. That is harmless and goes away with
  the PSL entry.
- **The `/v2/reset` endpoint on the static host.** The shell fetches `./reset` relative to
  its own URL (same origin, so `connect-src` lists `'self'`). The response needs
  `Clear-Site-Data: "cache", "cookies", "storage"` and `Cache-Control: no-store`. Two ways
  to serve it:
  - **Cloudflare `_headers`** (what `pnpm --filter @br/sandbox-shell build` emits): a
    static file `dist/v2/reset` plus a `/v2/reset` rule in `dist/_headers`. Cloudflare applies
    every matching rule and joins repeated header names with a comma, so `/*` carries only
    the security headers and `Cache-Control` is set by per-file rules (`/v2/`,
    `/v2/index.html`, `/v2/shell.js`, `/v2/capture.js`, `/v2/sw.js`, `/v2/reset`) that cannot
    overlap. Nothing else is
    needed, but the response is still a static asset, and a cache in front of Pages must
    honour `no-store`.
  - **A small Worker** in front of the static assets (Workers Static Assets or a route on
    the usercontent zone) that answers `GET /v2/reset` itself with those headers and passes
    everything else through. Use it if the host cannot set per-path headers, or to add
    per-request logic later (for example a per-build path check). The headers are the
    same: `RESET_HEADERS` in `apps/sandbox-shell/src/headers.ts`.
  Clear-Site-Data is only honoured in secure contexts (https, or http://localhost /
  127.0.0.1 locally).

## Lifecycle

- `new PreviewHandle(iframe, {shellUrl})` (or `createPreview(container, opts)`) sets the
  mode's attributes and loads the shell. `load({site}, mode?)` sends a load (or keeps it
  pending until the handshake; only the latest pending load is sent). `resetStorage()`,
  `restart(mode?)` and a mode change replace the iframe (see "Reset isolation").
  `dispose()` removes it. After a `crash`, only `restart()` and `dispose()` are allowed.

## Running it

All commands from the repository root.

```sh
pnpm install

# unit tests (Vitest, Node)
pnpm --filter @br/protocol test
pnpm --filter @br/runtime test
pnpm --filter @br/sandbox-shell test

# typecheck / lint
pnpm --filter @br/protocol --filter @br/runtime --filter @br/sandbox-shell typecheck
pnpm --filter @br/protocol --filter @br/runtime --filter @br/sandbox-shell lint

# shell static build (prints the sizes); writes apps/sandbox-shell/dist/{v2/,_headers,…}
pnpm --filter @br/sandbox-shell build

# e2e (Playwright, Chromium from /opt/pw-browsers; NOT part of `pnpm test`)
pnpm --filter @br/runtime test:e2e

# playground: http://localhost:4310 (shell on 127.0.0.1:4311, third origin on localhost:4312)
pnpm --filter @br/runtime playground
```

`@playwright/test` is pinned to **1.56.1** because that version matches the preinstalled
`chromium-1194`. The e2e config uses `channel: 'chromium'` (full Chromium, new headless) instead of
the default headless shell. See "Site isolation" under known limitations for why.

The e2e fixtures are sites made of text files (`e2e/fixtures.ts`), packed in the page with
`packSite`: a Vite-like build (hashed `/assets/` entry and stylesheet, a lazy chunk, an image,
`fetch('/data.json')`, a module worker), a router SPA, a multi-page site, and small module
sites for the policy, storage, watchdog and thumbnail suites. `e2e/capture.spec.ts` renders
a signed capture URL: the dev server stores packs (`PUT /__test/site`), serves them from the
third origin with CORS, and signs capture URLs with a random per-process secret.

## Measured numbers

Measured in the cloud container (4 vCPU, headless Chromium 141, everything on localhost, so
network transfer costs are excluded), from the `[metrics]` lines the e2e prints (T-045).

| Metric | Result | Budget (docs/03 §3.8) |
|---|---|---|
| First preview after boot (`load` → `ready`: copy, unpack, worker registration and upload, fresh frame, site start) | **60–82 ms** | < 1 s |
| Watchdog: loop start → `crash` | **4.8 s** (silence at crash: 5.2 s) | ≤ 6 s |
| Watchdog: loop at module top level (before `ready`), load sent → `crash` | **15.2 s** (T-027 load grace) | ≤ 15.25 s |
| Watchdog: slow but finite load, shell CPU throttled x6 (e2e `watchdog-load`) | 6.6 s evaluation, longest pong gap 6.9 s, **no crash**; a loop after it: 4.8 s | no crash below 15 s |
| Watchdog: every renderer stopped 7 s, app + frame throttled x6 (e2e `watchdog-starvation`) | app stall 6.8 s, **no crash**; a loop with a 3 s stop in its silence: 7.6 s wall, 5.0 s awake | no crash; loop ≤ 5.25 s awake |
| Watchdog: app 6.5 s + frame 7.5 s long tasks, both throttled x6 | app stall 6.3 s, **no crash**; a loop after it: 5.0 s | no crash; loop ≤ 6 s |
| App page during the loop (site-isolated) | evaluate RTT ≤ 4 ms, worst 50 ms timer gap ≤ 58 ms | responsive |
| `resetStorage()` (new iframe + handshake + full wipe incl. Clear-Site-Data + ack) | 58–64 ms | |
| `shell.js` (minified) | **43.9 KB raw, 15.1 KB gzip** (most of it zod) | "~5 KB" |
| `sw.js` / `capture.js` (minified) | 11.9 KB / 12.7 KB raw, 4.3 KB / 5.3 KB gzip | |

The watchdog fires 5 s of app-awake time after the *last pong*. Pings are 1 s apart and the
check runs every 250 ms, so detection after a loop starts falls between about 4.0 s and
5.25 s (plus any time the app's own timers were stalled meanwhile, see "Starvation"). A loop
during a load, before its `ready`, is caught when the 15 s load grace ends (see "Load
grace").

## Design decisions

- **Fresh frame per load = new site realm.** A new same-origin child iframe per load gives a
  genuinely new realm (timers, workers, module map and DOM of the previous site go with the
  old frame) and is much cheaper than reloading the shell (no re-handshake). The pong is sent
  from the shell's outer realm, but same-origin frames share one event loop, so a loop in the
  site stops it too (verified by the e2e).
- **A service worker serves the site** (docs/09 §9.3): built sites use root-relative URLs
  (`/assets/index-abc.js`), lazy chunks, `fetch('/data.json')`, workers and client-side
  routers that expect `/`, which a blob URL or a `document.write` document cannot serve.
  Details and routing: `apps/sandbox-shell/README.md`; the threat model: docs/03 §3.9.
- **Protocol v2** (shell path `/v2/`): `load {loadId, mode, site}`; `js`, `css`, `importMap`
  and `packages` are gone with the import-map schemas. The handshake (`hello`, `connect
  {protocol, nonce}`, `connected {nonce}`), `ready {loadId}`, `ping {seq}`/`pong {seq}`,
  `reset-storage`/`storage-reset`, `capture-thumbnail`/`thumbnail`, `console` and
  `runtime-error {kind?}` are unchanged, and so is their trust model. The schemas use
  `zod/mini` so they tree-shake into the shell.
- **Shell config**: allowed app origins are baked in at build time (`BR_APP_ORIGINS`) into the
  shell (postMessage targets) and into the site worker (the sites' `frame-ancestors`); the
  shell only accepts `connect` from `window.parent` at one of those origins. There is no
  package CDN setting any more.
- **Headers on every path** (T-009): the static `_headers` puts the security headers on `/*`
  and the local server sends them on 404s too: CSP, `Permissions-Policy`, CORP,
  `Referrer-Policy`, `nosniff` and `Origin-Agent-Cluster: ?1`. The shell document's own CSP is
  minimal (`script-src 'self'`, `frame-src 'self'`, `worker-src 'self'`); a site runs under
  the site CSP the worker sets (`script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:
  https:`, `worker-src 'self' blob:`, `frame-ancestors 'self' <app origins>`, `base-uri
  'none'`, `form-action 'none'`). `bluetooth` is left out of `Permissions-Policy` because
  Chromium 141 logs "Unrecognized feature: 'bluetooth'"; an e2e test fails on any
  unrecognized feature.
- **Local headers** (`apps/sandbox-shell/src/server.ts`) are the production headers with
  local origins: `frame-ancestors` is the local app origin, `extraConnectSrc` adds local http
  origins (the shell's and the sites' `connect-src`), and `Cache-Control: no-store` replaces
  `immutable`.

## Known limitations and risks found

- **Site isolation is required for the watchdog to help.** Playwright's default
  `chromium-headless-shell` does not put cross-site iframes in their own process. There, the
  site's infinite loop froze the app page itself (the `page.evaluate` never returned), and no
  JS watchdog can run on a frozen thread. Full Chromium isolates the iframe (verified via CDP
  iframe targets), and the e2e asserts that as a precondition. Real-world impact: browsers or
  devices without strict site isolation (Safari, Android Chrome on low-RAM devices, some
  enterprise policies) get no protection from the watchdog. This is the R2 residual risk.
- **The watchdog is best-effort.** A pong shows that *some* code holding the shell's port
  answered from a task. The site runs same-origin with the shell, so code that takes over
  the shell's realm could hand the port to a worker that keeps answering pings while the main
  thread spins. What protects the player is site isolation: the app's own thread stays
  responsive, the UI keeps working and the preview can always be restarted. Timers in a
  hidden or off-screen cross-origin iframe can be throttled to about one per second, which
  still stays far below the 5 s limit; a hidden *app* tab pauses the check instead.
- **The shell is 15 KB gzip, not ~5 KB.** Most of it is zod's core. Options: hand-written
  validators in the shell only (keeping zod on the app side), or accept it, since the file is
  immutable and cacheable.
- **Site worker limits** (details in `apps/sandbox-shell/README.md`): one browser partition
  has one "latest site", so two previews of different sites at once (two tabs) can cross over
  on a reload or an in-site navigation; browsers without service workers in that context
  (Firefox private windows) cannot run an imported site (a `module-load` error says so); only
  Chromium is tested.
- **Test differences from real Chrome.** Playwright disables `ThirdPartyStoragePartitioning`
  and background timer throttling. Partitioned storage (and the partitioned site worker)
  should still work, because the iframe gets a partition keyed by the app's top-level site,
  but the e2e does not prove it. The hidden-tab grace logic is not covered by e2e.
- **Client thumbnail** (T-014): `PreviewHandle.captureThumbnail({width, height})` sends
  `capture-thumbnail`; the shell (`apps/sandbox-shell/src/thumbnail.ts`) copies the site's
  main canvas when one covers at least half of the viewport, otherwise it renders the site's
  DOM through an SVG `<foreignObject>` (`<style>` elements and linked same-origin stylesheets
  included; external images, web fonts and WebGL without `preserveDrawingBuffer` are
  missing). It answers `thumbnail {webp}` or nothing; the handle resolves null on timeout
  (4 s), frame replacement or disposal, and accepts one answer per request. It is the
  fallback for the server capture only, and as untrusted as any shell message. `mode`
  selects the iframe's `sandbox`/`allow` (app side) and the child frame's `allow` (shell
  side), nothing else.
- The shell's own console rate limit (100/s) reports the dropped count on the next console
  call after the window, not on a timer. The app-side budget reports on a timer.
- **Browser differences in the wipe and the headers** (only Chromium is tested):
  - Cookie Store API: Chromium, Firefox 140+, Safari 18.4+. Without it, the
    `document.cookie` sweep and Clear-Site-Data still apply.
  - Storage Buckets: Chromium only (skipped elsewhere). OPFS: all three engines.
  - `Clear-Site-Data`: Chromium and Firefox honour `"cache"`, `"cookies"` and `"storage"`.
    Safari supports it only partly (recent versions), so on Safari the script wipe is what
    counts.
  - `Partitioned` (CHIPS) cookies: Chromium and Firefox; Safari partitions third-party
    storage its own way and ignores the attribute.
  - `Origin-Agent-Cluster` is Chromium-only. Firefox does not implement the `Permissions-Policy`
    header (it uses the iframe `allow` attribute), and Safari supports a subset; the iframe
    `allow` list is the cross-browser part.
  - Firefox and Safari block popups from sandboxed frames without `allow-popups` the same
    way. Safari's clipboard API needs a user gesture in every mode.
