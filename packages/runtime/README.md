# @br/runtime: in-browser sandbox runtime (M1 spike)

This package implements the v1 sandbox from [docs/03-sandbox.md](../../docs/03-sandbox.md):
esbuild-wasm in a Web Worker, npm packages as ES modules from an esm.sh-compatible CDN, and
a preview in a cross-site sandboxed iframe. It works together with:

- [`@br/protocol`](../protocol): zod schemas, types and size caps for the app <-> shell bridge.
- [`@br/sandbox-shell`](../../apps/sandbox-shell): the versioned shell (`/v1/`) served from the
  usercontent origin, plus its CSP / Permissions-Policy headers.

## Architecture

```
 App origin (trusted)                                       Sandbox origin (untrusted)
 ┌────────────────────────────────────────────┐            ┌──────────────────────────────────┐
 │ EsmBrowserRuntime (SandboxRuntime)         │            │ shell.js (/v1/, outer realm)     │
 │  ├─ BundlerClient ──postMessage──► Worker  │            │  ├─ handshake, port, ping/pong   │
 │  │                  esbuild-wasm           │            │  ├─ reset-storage                │
 │  │                  plugins: vfs,          │   port     │  └─ per load: NEW child iframe   │
 │  │                  cdn-rewrite, css,      │◄──────────►│       about:blank + doc.write    │
 │  │                  assets                 │ (Message-  │       importmap → css → module   │
 │  └─ PreviewHandle (iframe owner, watchdog) │  Channel)  │       (blob:) + console/errors   │
 └────────────────────────────────────────────┘            └──────────────────────────────────┘
          │ package CSS (fetch)                                   │ import 'react' (import map),
          ▼                                                       ▼ CDN module URLs
                                 Package CDN (esm.sh-shaped)
```

| Piece | File |
|---|---|
| `SandboxRuntime` interface + `EsmBrowserRuntime` | `src/runtime.ts` |
| Bundle step (platform-neutral) | `src/bundler/bundle.ts` |
| Plugins `vfs`, `cdn-rewrite`, `css` (package CSS), `assets` | `src/bundler/plugins.ts` |
| Pure resolution logic (unit tested) | `src/bundler/resolve.ts` |
| Worker entry + typed worker protocol + main-thread client | `src/worker/*` |
| `PreviewHandle` (handshake, validation, watchdog) | `src/preview/preview-handle.ts` |
| Mock CDN (esm.sh URL shape, CJS→ESM, externals) | `test-support/mock-cdn.ts` |
| Three-origin dev server (app, shell, CDN) | `test-support/dev-server.ts` |
| Playground (textareas, console panel) | `playground/` |

### Build pipeline
`writeFile()` → 150 ms debounce → worker `build` → esbuild-wasm `build()` with `format: 'esm'`,
`bundle: true`, `jsx: 'automatic'`, `define: process.env.NODE_ENV` (minified in production) →
`{ ok, js, css, importMap, diagnostics, durationMs }`.

- **vfs**: entry point, relative and workspace-absolute (`/src/x`) imports; tries the exact path,
  then `.tsx .ts .jsx .js .mjs .css .json`, then `index.*`. `.js` files use the JSX loader.
  `.module.css` uses esbuild's `local-css`.
- **cdn-rewrite**: the React set (`react`, `react/jsx-runtime`, `react/jsx-dev-runtime`,
  `react-dom`, `react-dom/client`, and `scheduler` when the manifest lists it) stays bare
  (import map). Any other bare import becomes the external URL
  `${cdnBaseUrl}/${name}@${version}${subpath}?external=…`. A package that is not in
  `manifest.dependencies`, a version that is not exact, or a Node built-in is a
  **diagnostic** with file and line; there is never a silent `latest`.
- **One instance per package (T-040, replaces T-035's `deps=` pins)**:
  - `?external=` lists every *other* package of the manifest plus React and React DOM, sorted
    as the CDN sorts them (`cdnExternals`, `urlExternals`). For example
    `/three@0.186.1?external=@react-three/fiber,react,react-dom` and
    `/@react-three/fiber@9.8.1?external=react,react-dom,three`. A CDN module therefore leaves
    every manifest package bare, and the import map resolves it to the one URL the bundle
    uses. That matters on esm.sh, which otherwise imports a package's own dependencies by range
    (`/chart.js@^4.1.1?target=es2022`, cached 10 minutes) or, with `deps=`, at build arguments
    of their own: a second instance either way (CI run 60).
  - A package is never in its own list: a subpath's import of its own package goes to the main
    build with the same list, on both CDNs.
  - Entries the CDN would reject are left out (non-npm names, versions with build metadata).
    Above 32 externals per URL (or 1,200 characters) URLs externalize React only, the import
    map holds the React set, and the build has a warning.
  - Trade-off: adding or bumping a dependency changes every other package's URL, so those
    modules are fetched again (and, on a cold esm.sh or pkg-cdn cache, built again). The React
    set's URLs never change with the manifest.
- **css**: local CSS (including `@import` and `url()`) is bundled into one CSS output. Package CSS
  (`pkg/dist/x.css`) is fetched from the CDN by the worker, cached in memory and inlined;
  relative `url()`/`@import` inside it are rewritten to absolute CDN URLs.
- **assets**: images (`.png .jpg .gif .webp .avif .svg .ico .bmp`, ≤ 200 KB) become data URLs,
  both for JS imports and CSS `url()`. The file map is text only, so binary images are stored as
  `data:` URLs (SVG may be raw markup).
- **Import map** (`buildImportMap`, a pure function of the manifest: REVEAL, the solo last
  look and the capture renderer rebuild it from a stored manifest):
  - the React set with fixed URLs, `scheduler` pinned to the exact version for the React DOM
    minor (`REACT_DOM_SCHEDULER`, or the manifest's own pin), so the template loads only from
    immutable URLs on esm.sh too;
  - for every other exact package, its main URL (the bundle's) and a prefix entry for subpaths
    that CDN modules import (`"konva/"`, `"react/"`, `"react-dom/"`). The prefix carries its
    query in esm.sh's in-path form, `${cdnBaseUrl}/konva@10.7.0&external=…/`, where a scoped
    name's `/` is written `%252F` (`cdnPrefixUrl`, `inPathName`).
  - Size: 8 entries for the template, plus 2 per other package.
  - Details: docs/03 "One instance per package and a fully pinned template".

### Preview isolation and bridge
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
- **Fresh document per load**: for every `load`, the shell removes the previous child iframe and
  creates a new same-origin `about:blank` child. It runs `document.open()`, installs the
  console/error hooks, writes a `<!doctype html>` skeleton with `<div id="root">`, then
  synchronously appends the import map, a `<style>` with the CSS, and
  `<script type="module" src="blob:…">`. `ready {loadId}` is sent on the script's `load`;
  a module graph fetch failure becomes `runtime-error {kind: 'module-load'}`.
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
- **Load grace (T-027)**: a `load` blocks the shell's main thread while it runs. The shell
  tears down the previous build's realm, writes the new document, then compiles and evaluates
  the whole module graph in **one task**, so no pong can be sent until it finishes. On a
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
  Storage Buckets and service worker registrations, then fetches `/v1/reset` for
  `Clear-Site-Data`, and acknowledges with `storage-reset {ok, errors?}`. `load` and
  `reset-storage` run one at a time in arrival order, so a load sent right after a reset
  starts only once the wipe is done.
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

## Packages and CDN outages (T-032)

Measurements, the decision and its security reasoning are in docs/03-sandbox.md "Package
cache and CDN outages". In short:

- The template's packages come from the **browser's HTTP cache** while the package CDN is
  down. The cache partition is (top-level app site, shell site), shared by the shell, its
  `document.write` child frame and the `blob:` module. Every import map URL is an exact
  version served `immutable` (a `resolve` unit test checks the map), so nothing expires.
- **No Service Worker or Cache Storage:** build code runs on the shell origin and could write
  to both, so one build could poison React for the next. The shell keeps wiping them.
- **Warm-up** (shell): after a build ran, its import map's URLs are fetched once per shell
  realm with `cache: 'force-cache'`, so React's other entry points are cached too. The web
  app's room lobby triggers it with an empty bundle (`TemplateWarmup`).
- **The modules behind an entry URL** (T-035): esm.sh answers `/react@19.3.0` with a few lines
  that re-export an internal build path (`/react@19.3.0/es2022/react.mjs`). The warm-up and
  the checks below follow every module's static imports on the CDN's own origin
  (`moduleImportUrls` in `@br/protocol`; at most 64 per check or warm-up), and report a
  failure behind an entry under the entry's name. @br/pkg-cdn serves React as one module, so
  there is nothing to follow there.
- **Naming failures** (shell): when the module graph fails, or still waits after 8 s, the
  build's `packages` and then the rest of the import map are checked the same way (3 s
  each). The `module-load` error says `Package server unreachable: zustand@5.0.15`, `…not
  responding…`, `Package server error (HTTP 404) for …: <CDN text>`, or `Still waiting for
  the package server after 8 s: …`. Texts: `@br/protocol` `packages.ts`, shared with the
  bundler's package CSS diagnostics (`PackageFetchError`).
- A network wait never trips the watchdog: the shell keeps answering pings.
- e2e `cdn-outage.spec.ts`: the dev server's mock CDN takes an outage on
  `POST /__test/cdn-outage?mode=refuse|error|hang|off` (`MockCdn.setOutage`). It runs twice:
  against the mock in its default layout, and in its esm.sh layout
  (`playwright.esm-sh.config.ts`). Without following the entry modules' imports, the esm.sh
  run fails: the warmed `react/jsx-dev-runtime` entry is cached but its module is not.

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
  shell's path (`/`, `/v1`, `/v1/`), for host-only, `Domain=<host>` and each parent domain,
  without security attributes, with `Secure; SameSite=None`, and with `Partitioned` on
  top. (3) `Clear-Site-Data` from `/v1/reset` removes what script cannot see at all:
  cookies on unrelated paths, HttpOnly cookies, the HTTP cache. With the usercontent apex
  not yet on the Public Suffix List, `"cookies"` clears the whole registrable domain, so
  other builds' cookies in the same browser go too. That is harmless and goes away with
  the PSL entry.
- **The `/v1/reset` endpoint on the static host.** The shell fetches `./reset` relative to
  its own URL (same origin, so `connect-src` lists `'self'`). The response needs
  `Clear-Site-Data: "cache", "cookies", "storage"` and `Cache-Control: no-store`. Two ways
  to serve it:
  - **Cloudflare Pages `_headers`** (what `pnpm --filter @br/sandbox-shell build` emits): a
    static file `dist/v1/reset` plus a `/v1/reset` rule in `dist/_headers`. Pages applies
    every matching rule and joins repeated header names with a comma, so `/*` carries only
    the security headers and `Cache-Control` is set by per-file rules (`/v1/`,
    `/v1/index.html`, `/v1/shell.js`, `/v1/reset`) that cannot overlap. Nothing else is
    needed, but the response is still a static asset, and a cache in front of Pages must
    honour `no-store`.
  - **A small Worker** in front of the static assets (Workers Static Assets or a route on
    the usercontent zone) that answers `GET /v1/reset` itself with those headers and passes
    everything else through. Use it if the host cannot set per-path headers, or to add
    per-request logic later (for example a per-build path check). The headers are the
    same: `RESET_HEADERS` in `apps/sandbox-shell/src/headers.ts`.
  Clear-Site-Data is only honoured in secure contexts (https, or http://localhost /
  127.0.0.1 locally).

## Lifecycle and errors

- **Creating the worker**: `BundlerClientOptions` (and so `EsmBrowserRuntimeOptions`) take
  either `workerUrl` (started as a module worker) or `createWorker`, never both. The type is
  a union, so passing neither or both is a type error. Untyped callers that pass neither get a
  `TypeError` from the constructor. Use `createWorker` when the app's bundler needs a literal
  `new Worker(new URL('./bundler.worker.ts', import.meta.url))` to find the worker entry
  (Turbopack, Vite).
- **`terminate()` / `destroy()` settle everything**: a pending `init()` (and so `boot()`) and
  every in-flight or queued build reject with a `BundlerAbortError` (`name === 'AbortError'`,
  `isAbortError(e)`). Nothing hangs when `boot()` races `destroy()`, for example under React
  StrictMode's double effects. After `terminate()`, the `BundlerClient` can be used again
  (a new worker); an `EsmBrowserRuntime` cannot.
- **A bundler start never hangs (T-039)**: the worker fetches `esbuild.wasm` itself (compiling
  while it downloads, like esbuild-wasm's `wasmURL` path) and posts `init-progress` when it
  runs, when the response starts, at most every 250 ms while bytes arrive, and when the
  download is complete. A start with no progress for `initStallMs` (default
  `DEFAULT_INIT_STALL_MS`, 15 s) is terminated and retried once with a fresh worker; the timer
  starts over with every message, so a slow but moving download is never cut off. If the retry
  stalls too, `boot()` rejects with a `BundlerInitTimeoutError` (`isInitTimeout(e)`, with the
  `stage` it stalled in: `worker`, `download` or `compile`). `BootTimings.attempts` says
  whether the retry was needed, and the `onInitAttempt` option reports every worker start
  (ready, stalled, error) for telemetry. Why 15 s and not a fixed bound: the wasm is 13.6 MB
  (3–4 MB compressed), so a whole-start bound would have to allow minutes on a slow phone link,
  and one shorter than the real download would fail every retry too; 15 s without a single
  byte is a stall at any link speed. The cost: the module compiles from our own `Response`
  (a counting stream), which has no URL, so Chrome's wasm code cache for fetched responses
  does not apply on later visits; measured cold starts are about 20 ms slower (table below).
- **A failed bundler start is retried**: if the worker script fails to load, `createWorker`
  throws, esbuild-wasm fails to initialize or both starts stalled, `boot()` rejects, the
  failed worker is terminated, and the failure is not cached. The next `build()` (explicit
  or debounced after `writeFile`) starts a fresh worker. Errors are not retried
  automatically: only a stall is.
- **Build failures are results, not rejections**: when the bundler cannot start, `build()`
  resolves with `ok: false` and one diagnostic with `code: 'bundler-init-failed'` (its text is
  `bundlerStartFailureText(e)`: "Couldn't start the bundler: the download stalled (no progress
  for 15 s, 2 attempts)"), and the result goes to `onBuild` listeners like any build. Debounced builds never produce unhandled
  rejections. `build()` rejects only once the runtime is destroyed.

## Running it

All commands from the repository root.

```sh
pnpm install

# unit tests (Vitest, Node; esbuild-wasm runs in Node for the bundler tests)
pnpm --filter @br/protocol test
pnpm --filter @br/runtime test
pnpm --filter @br/sandbox-shell test

# typecheck / lint (all three packages)
pnpm --filter @br/protocol --filter @br/runtime --filter @br/sandbox-shell typecheck
pnpm --filter @br/protocol --filter @br/runtime --filter @br/sandbox-shell lint

# shell static build (prints shell.js size); writes apps/sandbox-shell/dist/{v1/,_headers}
pnpm --filter @br/sandbox-shell build

# e2e (Playwright, Chromium from /opt/pw-browsers; NOT part of `pnpm test`): every suite,
# then render + CDN outage again with the mock CDN in its esm.sh layout (test:e2e:esm-sh)
pnpm --filter @br/runtime test:e2e

# playground: http://localhost:4310 (shell on 127.0.0.1:4311, mock CDN on localhost:4312)
pnpm --filter @br/runtime playground
```

`@playwright/test` is pinned to **1.56.1** because that version matches the preinstalled
`chromium-1194`. The e2e config uses `channel: 'chromium'` (full Chromium, new headless) instead of
the default headless shell. See "Site isolation" under known limitations for why.

## Measured numbers

Measured in the cloud container (4 vCPU, headless Chromium 141, everything on localhost, so
network transfer costs are excluded), from the `[metrics]` lines the e2e prints. Ranges cover the
last two full e2e runs.

| Metric | Result | Budget (docs/03 §3.8) |
|---|---|---|
| Worker cold start (`new Worker` → esbuild-wasm ready), 5 fresh contexts | p50 **192–235 ms**, max 241 ms | < 3 s cold (incl. download) |
| …with the worker's own wasm fetch for progress (T-039), 3 runs × 5 contexts each, old vs new worker | median of run medians ~205 → ~227 ms (+~20 ms on localhost) | |
| A stalled `esbuild.wasm` request (web e2e `playground.spec`): retry → first build | ~16.7 s test (15 s stall + the retry); both stalled → failed state ~30 s | no hang |
| …of which wasm compile/instantiate inside the worker | ~160–190 ms | |
| First build (cold, fetches package CSS) | 420–520 ms | |
| First preview after boot (build → `ready`, cold CDN + React eval) | p50 **492–624 ms**, max 691 ms | < 1 s preloaded |
| Rebuild, bundler only, 10-file project, n=20 | p50 **105–115 ms**, p95 **147–159 ms** | |
| Rebuild + preview refresh (build → `ready`), 10 files, n=20 | p50 **125–135 ms**, p95 **175–183 ms** | < 300 ms p50, < 800 ms p95 |
| Watchdog: loop start → `crash` | **4.1 s** (silence at crash: 5.17 s; T-009, ping/pong) | ≤ 6 s |
| Watchdog: loop at module top level (before `ready`), load sent → `crash` | **14.3 s** (silence 15.2 s; T-027 load grace, was 4.5 s) | ≤ 15.25 s |
| Watchdog: slow but finite load, shell CPU throttled x6 (e2e `watchdog-load`) | 8.0–10.1 s evaluation, longest pong gap 8.7–10.7 s, **no crash**; a loop after it: 4.2–5.0 s | no crash below 15 s |
| Watchdog: every renderer stopped 7 s, app + frame throttled x6 (e2e `watchdog-starvation`) | app stall 6.8–7.0 s, **no crash** (old: crash, silence 7.3 s); a loop with a 3 s stop in its silence: 7.1–7.5 s wall, 5.0–5.2 s awake | no crash; loop ≤ 5.25 s awake |
| Watchdog: app 6.5 s + frame 7.5 s long tasks, both throttled x6 (e2e `watchdog-starvation`) | app stall 5.6–6.4 s, **no crash** (old: crash, silence 6.0 s); a loop after it: 4.3–4.7 s | no crash; loop ≤ 6 s |
| App page during the loop (site-isolated) | evaluate RTT ≤ 9 ms, worst 50 ms timer gap ≤ 68 ms | responsive |
| `resetStorage()` (new iframe + handshake + full wipe incl. Clear-Site-Data + ack) | 100–250 ms | |
| `shell.js` (minified) | **45.5 KB raw, 15.2 KB gzip** (T-032; 42.6 / 14.3 KB before it, 39.1 / 13.0 KB at T-009) | "~5 KB" |
| CDN down (refused / 502), build imports a package this browser never loaded: `buildAndLoad` → named `module-load` error (e2e `cdn-outage`) | **155–180 ms** | fast, no crash |
| CDN accepting connections but never answering: load → "Still waiting for the package server" | **11.3 s** (8 s stall check + 3 s per-URL check timeout) | no hang, no crash |
| `esbuild.wasm` | 13.98 MB raw, 3.75 MB gzip, 2.71 MB brotli | preload in lobby |
| Bundler worker JS (minified, excl. wasm) | 76.6 KB raw, 22.4 KB gzip | |

The watchdog fires 5 s of app-awake time after the *last pong*. Pings are 1 s apart and the
check runs every 250 ms, so detection after a loop starts falls between about 4.0 s and
5.25 s (plus any time the app's own timers were stalled meanwhile, see "Starvation"). A loop
during a load, before its `ready`, is caught when the 15 s load grace ends (see "Load
grace").

## Design decisions and deviations from docs/03

- **Fresh document = new child realm.** I checked `document.open()` on the shell's own document
  and it keeps the same `Window`: globals and `setInterval` timers of the previous build survive,
  and so do the module map (and with it the React instance) and the import map, which can't be
  remapped once used. A new same-origin child iframe per load gives a genuinely new realm and is
  much cheaper than reloading the shell (no re-handshake). `document.write` is used only because
  the initial `about:blank` document is in quirks mode (`BackCompat`, verified), and a doctype
  gives standards mode. The pong is sent from the shell's outer realm, but same-origin frames
  share one event loop, so a loop in user code stops it too (verified by the e2e).
- **CSP `script-src` includes `'unsafe-inline'`.** Chromium applies `script-src` to inline
  `<script type="importmap">`. Without `'unsafe-inline'`, React fails with "Failed to resolve
  module specifier react-dom/client" (verified by temporarily removing it). The map's contents
  depend on the pinned React version and the shell is a static file, so a hash or nonce can't be
  used. This doesn't let a build do more than it already can: a build is arbitrary JS and `blob:`
  is already allowed.
- **CSP `script-src` includes `'unsafe-eval'`** (T-007). Packages such as pixi.js v8 compile
  code at runtime with `new Function` and fail without it. The reasoning is the same as for
  `'unsafe-inline'`: a build is arbitrary JS already. An e2e test checks that `eval` and
  `new Function` work inside a build.
- **Protocol refinements** (version 1, shell path `/v1/`): `connect {protocol, nonce}` (window)
  and `connected {nonce}` (first port message) make the handshake explicit. `load` carries a
  `loadId` that `ready` echoes. `reset-storage` has a `requestId` and gets a `storage-reset
  {ok, errors?}` ack. `runtime-error` has an optional
  `kind: 'error' | 'unhandledrejection' | 'module-load'`. `ping {seq, t?}` is answered by
  `pong {seq}` (T-009; `seq` is required, and the version stays 1 because nothing is deployed
  yet). `load` takes an optional `packages` list (T-032): the CDN URLs the bundle imports
  (`BuildResult.packages`), which the shell checks to name a package that can't load. Older
  shells ignore it. `heartbeat {t?}` stays in the schema but is no longer sent. The schemas
  use `zod/mini` so they tree-shake into the shell.
- **`SandboxRuntime` interface** changes:
  - `boot({files, manifest})` takes a manifest instead of a `template`, because templates come
    with workspace persistence.
  - `attachPreview(frame, {shellUrl, shellOrigin?})` replaces `(frame, buildId)`: the caller maps
    the build id to its usercontent URL.
  - Added `deleteFile`, `setManifest` and `onBuild`.
  - `build()` returns `{ok, js, css, importMap, diagnostics, durationMs}`.
  - `destroy()` terminates the worker and disposes previews. The IndexedDB wipe lands with
    persistence.
- **Shell config**: allowed app origins are baked in at build time (`BR_APP_ORIGINS`), and the
  shell only accepts `connect` from `window.parent` at one of those origins. The CDN for the
  CSP comes from `BR_PKG_CDN_URL`, the same base URL as the app's `NEXT_PUBLIC_PKG_CDN_URL`
  (its origin goes into `script-src`; `BR_CDN_ORIGIN` is the older name). The default is the
  public `https://esm.sh`, production's CDN on the free plan (T-035, docs/08-free-tier.md §4).
- **Headers on every path** (T-009): the static `_headers` puts the security headers on `/*`
  and the local server sends them on 404s too. Besides CSP, `Permissions-Policy`, CORP,
  `Referrer-Policy` and `nosniff` there is `Origin-Agent-Cluster: ?1` (no `document.domain`,
  no shared agent cluster with sibling build subdomains). The CSP adds `base-uri 'none'` and
  `form-action 'none'`: a build handles forms in JS, and a real submission would only
  navigate the build's own frame away (the usual symptom of a forgotten `preventDefault`) or
  post the fields to another origin. `Permissions-Policy` also denies `display-capture`,
  `screen-wake-lock`, `idle-detection`, `midi`, `publickey-credentials-get`,
  `publickey-credentials-create` and `xr-spatial-tracking`. `bluetooth` is left out because
  Chromium 141 logs "Unrecognized feature: 'bluetooth'"; an e2e test fails on any
  unrecognized feature.
- **Local headers** (`apps/sandbox-shell/src/server.ts`) are the production headers with local
  origins:
  - `frame-ancestors` is the local app origin;
  - the http mock CDN origin is added to `script-src`, `style-src` and `connect-src`;
  - `Cache-Control: no-store` replaces `immutable`;
  - it also serves `/v1/sw-test.js`, a same-origin script for the service-worker policy e2e
    (not part of the static build).
- **React is served in production mode** (esm.sh's default). User code is still built with
  `NODE_ENV=development`.

## Known limitations and risks found

- **Site isolation is required for the watchdog to help.** Playwright's default
  `chromium-headless-shell` does not put cross-site iframes in their own process. There, the
  build's infinite loop froze the app page itself (the `page.evaluate` never returned), and no
  JS watchdog can run on a frozen thread. Full Chromium isolates the iframe (verified via CDP
  iframe targets), and the e2e asserts that as a precondition. Real-world impact: browsers or
  devices without strict site isolation (Safari, Android Chrome on low-RAM devices, some
  enterprise policies) get no protection from the watchdog. This is the R2 residual risk, and
  it is now confirmed rather than theoretical.
- **The watchdog is best-effort.** A pong shows that *some* code holding the shell's port
  answered from a task. The build runs same-origin with the shell, so code that takes over
  the shell's realm could hand the port to a worker that keeps answering pings while the main
  thread spins. Answering from `setTimeout(0)` rules out the honest shell answering from a
  stuck port listener, not a hostile build. What protects the player is site isolation: the
  app's own thread stays responsive (see above), the UI keeps working and the preview can
  always be restarted. Timers in a hidden or off-screen cross-origin iframe can be throttled
  to about one per second, which still stays far below the 5 s limit; a hidden *app* tab
  pauses the check instead.
- **The shell is 15 KB gzip, not ~5 KB.** About 27 KB of the 45 KB raw is zod's core. Options:
  hand-written validators in the shell only (keeping zod on the app side), or accept it, since
  the file is immutable and cacheable. Note that per-build subdomains mean each build origin
  fetches it once.
- **Test differences from real Chrome.** Playwright disables `ThirdPartyStoragePartitioning` and
  background timer throttling. Partitioned storage should still work, because the iframe gets a
  partition keyed by the app's top-level site, but the e2e does not prove it. The
  hidden-tab grace logic is not covered by e2e.
- **The mock CDN** (`test-support/mock-cdn.ts`):
  - **What it serves.** `react`, `react-dom`, `scheduler`, `zustand` and `animate.css`, only at
    their installed versions, and the fixture packages
    (`test-support/fixture-packages/<name>/<version>/`, T-040) at every version they have.
    Anything else gets a 404 with the reason.
  - **Layouts.** The `bundle` layout (like @br/pkg-cdn) bundles a package's own dependencies
    into its module and ignores `deps=`. With `layout: 'esm.sh'` (`CDN_LAYOUT=esm.sh` for the
    dev server, T-035) every module URL answers like the public esm.sh: a few lines that
    re-export an internal build path (`/react@19.3.0/X-…/es2022/react.mjs`) on the same origin,
    which holds the module. Since T-040 it also imports a package's own dependencies the way
    esm.sh does: by the range in its package.json (`/scheduler@^0.28.0?target=es2022`,
    `Cache-Control: public, max-age=600`, the newest version available) unless the request
    externalizes the dependency or pins it with `deps=`.
  - **Both layouts:** a subpath's import of its own package is the main module with the same
    query, and they accept the query in the path (`/x@1.0.0&external=a/sub`).
  - **Outages.** `setOutage('refuse' | 'error' | 'hang' | null)` simulates an outage for the
    T-032 e2e (connection refused, a 502 without CORS headers, or no answer until it ends).
  - **`test:e2e`** runs the render, CDN-outage and one-instance suites a second time in the
    esm.sh layout (`playwright.esm-sh.config.ts`, ports 4316–4318).
- Every rebuild is a full `esbuild.build()` (no incremental context yet), and there are no
  sourcemaps yet (runtime errors point into the blob bundle).
- **Client thumbnail** (T-014): `PreviewHandle.captureThumbnail({width, height})` sends
  `capture-thumbnail`; the shell (`apps/sandbox-shell/src/thumbnail.ts`) copies the build's
  main canvas when one covers at least half of the viewport, otherwise it renders the build's
  DOM through an SVG `<foreignObject>` (styles included; external images, web fonts and
  WebGL without `preserveDrawingBuffer` are missing). It answers `thumbnail {webp}` or
  nothing; the handle resolves null on timeout (4 s), frame replacement or disposal, and
  accepts one answer per request. It is the fallback for the server capture only, and as
  untrusted as any shell message. Safe-mode restart (timers paused until the user clicks) is
  not implemented. `mode` selects the iframe's
  `sandbox`/`allow` (app side) and the child frame's `allow` (shell side), nothing else yet.
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
- Builds can render into `#root`; the shell writes `<div id="root">` into every fresh document
  (Vite-template convention).
