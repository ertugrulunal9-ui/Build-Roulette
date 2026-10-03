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
 │  ├─ BundlerClient ──postMessage──► Worker  │            │  ├─ handshake, port, heartbeat   │
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
- **cdn-rewrite**: `react`, `react/jsx-runtime`, `react/jsx-dev-runtime`, `react-dom`,
  `react-dom/client` stay bare (import map). Any other bare import becomes the external URL
  `${cdnBaseUrl}/${name}@${version}${subpath}?external=react,react-dom`. A package that is not in
  `manifest.dependencies`, a version that is not exact, or a Node built-in is a **diagnostic**
  with file and line; there is never a silent `latest`.
- **css**: local CSS (including `@import` and `url()`) is bundled into one CSS output. Package CSS
  (`pkg/dist/x.css`) is fetched from the CDN by the worker, cached in memory and inlined;
  relative `url()`/`@import` inside it are rewritten to absolute CDN URLs.
- **assets**: images (`.png .jpg .gif .webp .avif .svg .ico .bmp`, ≤ 200 KB) become data URLs,
  both for JS imports and CSS `url()`. The file map is text only, so binary images are stored as
  `data:` URLs (SVG may be raw markup).
- **Import map**: generated from the pinned `react` / `react-dom` versions, one shared instance.

### Preview isolation and bridge
- The iframe gets exactly `sandbox="allow-scripts allow-same-origin allow-forms allow-modals
  allow-pointer-lock allow-popups"`, `allow="autoplay; fullscreen; gamepad; clipboard-write"`,
  `referrerpolicy="no-referrer"`, `loading="eager"`.
- Handshake: the shell posts `hello {protocol}` to each allowlisted app origin (a non-matching
  `targetOrigin` is dropped by the browser). The app accepts it only if `event.origin` is the
  shell origin **and** `event.source === iframe.contentWindow` (`checkHello`), then transfers a
  `MessageChannel` port with a random nonce in `connect`. The shell answers `connected {nonce}`
  on the port. After that, both sides use only the port. Every message is validated with
  `@br/protocol` on receipt; invalid messages are dropped and counted (`stats.rejectedMessages`).
- **Fresh document per load**: for every `load`, the shell removes the previous child iframe and
  creates a new same-origin `about:blank` child. It runs `document.open()`, installs the
  console/error hooks, writes a `<!doctype html>` skeleton with `<div id="root">`, then
  synchronously appends the import map, a `<style>` with the CSS, and
  `<script type="module" src="blob:…">`. `ready {loadId}` is sent on the script's `load`;
  a module graph fetch failure becomes `runtime-error {kind: 'module-load'}`.
- **Watchdog**: the shell sends `heartbeat` every 1 s and answers `ping`. The PreviewHandle checks
  every 250 ms, pings after 2 s of silence, and after 5 s emits `crash` and removes the iframe.
  When the app tab is hidden the check pauses, and when the tab becomes visible again the grace
  period restarts, so timer throttling cannot cause a false crash.
- **reset-storage**: tears down the running build (an open IndexedDB connection would block
  deletion), then clears `localStorage`, `sessionStorage`, every IndexedDB database,
  CacheStorage and cookies, and acknowledges with `storage-reset {ok, errors?}`.

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

# e2e (Playwright, Chromium from /opt/pw-browsers; NOT part of `pnpm test`)
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
| …of which wasm compile/instantiate inside the worker | ~160–190 ms | |
| First build (cold, fetches package CSS) | 420–520 ms | |
| First preview after boot (build → `ready`, cold CDN + React eval) | p50 **492–624 ms**, max 691 ms | < 1 s preloaded |
| Rebuild, bundler only, 10-file project, n=20 | p50 **105–115 ms**, p95 **147–159 ms** | |
| Rebuild + preview refresh (build → `ready`), 10 files, n=20 | p50 **125–135 ms**, p95 **175–183 ms** | < 300 ms p50, < 800 ms p95 |
| Watchdog: loop start → `crash` | **4.9–5.2 s** (silence at crash: 5.19–5.21 s) | ≤ 6 s |
| Watchdog: loop at module top level, build start → `crash` | 4.5–4.6 s | |
| App page during the loop (site-isolated) | evaluate RTT ≤ 9 ms, worst 50 ms timer gap ≤ 58 ms | responsive |
| `shell.js` (minified) | **36.6 KB raw, 12.0 KB gzip** | "~5 KB" |
| `esbuild.wasm` | 13.98 MB raw, 3.75 MB gzip, 2.71 MB brotli | preload in lobby |
| Bundler worker JS (minified, excl. wasm) | 76.6 KB raw, 22.4 KB gzip | |

The watchdog fires 5 s after the *last heartbeat*. Heartbeats are 1 s apart and the check runs
every 250 ms, so detection after a loop starts falls between about 4.0 s and 5.25 s.

## Design decisions and deviations from docs/03

- **Fresh document = new child realm.** I checked `document.open()` on the shell's own document
  and it keeps the same `Window`: globals and `setInterval` timers of the previous build survive,
  and so do the module map (and with it the React instance) and the import map, which can't be
  remapped once used. A new same-origin child iframe per load gives a genuinely new realm and is
  much cheaper than reloading the shell (no re-handshake). `document.write` is used only because
  the initial `about:blank` document is in quirks mode (`BackCompat`, verified), and a doctype
  gives standards mode. The heartbeat lives in the shell's outer realm, but same-origin frames
  share one event loop, so a loop in user code stops it too (verified by the e2e).
- **CSP `script-src` includes `'unsafe-inline'`.** Chromium applies `script-src` to inline
  `<script type="importmap">`. Without `'unsafe-inline'`, React fails with "Failed to resolve
  module specifier react-dom/client" (verified by temporarily removing it). The map's contents
  depend on the pinned React version and the shell is a static file, so a hash or nonce can't be
  used. This doesn't let a build do more than it already can: a build is arbitrary JS and `blob:`
  is already allowed.
- **Protocol refinements** (version 1, shell path `/v1/`): `connect {protocol, nonce}` (window)
  and `connected {nonce}` (first port message) make the handshake explicit. `load` carries a
  `loadId` that `ready` echoes. `reset-storage` has a `requestId` and gets a `storage-reset
  {ok, errors?}` ack. `runtime-error` has an optional
  `kind: 'error' | 'unhandledrejection' | 'module-load'`. `heartbeat` and `ping` have an optional
  `t`. The schemas use `zod/mini` so they tree-shake into the shell.
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
  shell only accepts `connect` from `window.parent` at one of those origins. The CDN origin for
  the CSP comes from `BR_CDN_ORIGIN`. Both default to placeholder production domains.
- **Local headers** (`apps/sandbox-shell/src/server.ts`) are the production headers with local
  origins:
  - `frame-ancestors` is the local app origin;
  - the http mock CDN origin is added to `script-src`, `style-src` and `connect-src`;
  - `Cache-Control: no-store` replaces `immutable`.
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
- **The shell is 12 KB gzip, not ~5 KB.** About 27 KB of the 36.6 KB raw is zod's core. Options:
  hand-written validators in the shell only (keeping zod on the app side), or accept it, since
  the file is immutable and cacheable. Note that per-build subdomains mean each build origin
  fetches it once.
- **Test differences from real Chrome.** Playwright disables `ThirdPartyStoragePartitioning` and
  background timer throttling. Partitioned storage should still work, because the iframe gets a
  partition keyed by the app's top-level site, but the e2e does not prove it. The
  hidden-tab grace logic is not covered by e2e.
- **The mock CDN bundles each package with its dependencies into one module.** A dependency
  shared by two packages is therefore duplicated, which esm.sh avoids. React stays single
  because of `external`. Only `react`, `react-dom`, `zustand` and `animate.css` are served, and
  only at their installed versions; anything else gets a 404 with the reason.
- Only the React entry points listed above are in the import map. Another `react-dom/*` subpath
  imported *from inside a CDN package* would fail to resolve (loudly).
- Every rebuild is a full `esbuild.build()` (no incremental context yet), and there are no
  sourcemaps yet (runtime errors point into the blob bundle).
- The client thumbnail (`capture-thumbnail`) and capture mode are schema-only / ignored. Safe-mode
  restart (timers paused until the user clicks) is not implemented. `mode` is passed through but
  not acted on.
- The console rate limit (100/s) reports the dropped count on the next console call after the
  window, not on a timer.
- Builds can render into `#root`; the shell writes `<div id="root">` into every fresh document
  (Vite-template convention).
