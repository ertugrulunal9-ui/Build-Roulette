# @br/sandbox-shell: the sandbox origin

Everything served from the sandbox (usercontent) origin, which runs players' imported sites
([docs/03-sandbox.md](../../docs/03-sandbox.md), [docs/09-import-mode.md](../../docs/09-import-mode.md)
§9.3). The app side is `PreviewHandle` in [`@br/runtime`](../../packages/runtime), which also
documents the bridge, the watchdog and the trust model.

| Path | What | Source |
|---|---|---|
| `/v2/`, `/v2/index.html` | the shell document (inside the app's preview iframe) | `index.html` |
| `/v2/shell.js` | the shell: handshake, bridge, loads, reset, thumbnails | `src/shell.ts` |
| `/v2/sw.js` | the **site worker**: serves imported sites (scope `/`) | `src/sw.ts` |
| `/v2/capture` | the capture page, served only by the capture gate (HMAC) | `src/capture-gate.ts`, `src/worker.ts` |
| `/v2/capture.js` | the capture page's script | `src/capture.ts` |
| `/v2/reset` | `Clear-Site-Data` endpoint of `reset-storage` | `src/headers.ts` |
| anything else | 404 with the security headers | `dist/404.html` |

`pnpm --filter @br/sandbox-shell build` writes `dist/` (static assets, `_headers`, the
capture gate Worker); `wrangler.jsonc` deploys it (T-043). The only build setting is
`BR_APP_ORIGINS` (comma-separated): it goes into the shell (postMessage targets) and into the
site worker (the sites' `frame-ancestors`). `src/server.ts` is the local equivalent for dev
and tests (`startShellServer`).

## Running a site (protocol v2)

Per `load {loadId, mode, site}` (`site` is a site pack, `@br/site`), in the shell's
`SerialQueue` (loads, resets and thumbnails run one at a time, in order):

1. `unpackSite(site)`; a pack that is not well formed is a `module-load` runtime error ("The
   imported site could not be read: …") and a `ready`.
2. `navigator.serviceWorker.register('/v2/sw.js', {scope: '/', updateViaCache: 'none'})`, and
   wait until the registration's worker is `activated`. Again on every load: a reset
   unregisters it. No service workers (a Firefox private window) is a `module-load` error
   that says so, and a `ready`.
3. A fresh random site id (16 bytes from `crypto.getRandomValues`, 32 hex digits).
4. The files go to the worker over a `MessageChannel` (one copied `ArrayBuffer` per file,
   transferred); the worker stores them and acknowledges.
5. The previous child frame is removed and a new one navigates to `/?__br_site=<id>`, with
   the mode's `allow` and full-size CSS.
6. `ready {loadId}` on that frame's first `load` event. An in-site navigation later sends no
   second one.

The capture page does the same after wiping the origin's storage and fetching the pack from
its signed `src` URL (`no-store`, no credentials, no redirects, at most
`SITE_LIMITS.maxPackBytes`).

### The bootstrap and `window.buildRoulette`

Every HTML response of a site gets one inline script as the first child of `<head>`
(`src/bootstrap.ts`; inserted on the bytes, so the page's encoding is kept; with no `<head>`
tag it goes where the parser creates the head, after the doctype). It:

- removes `__br_site` from the address with `history.replaceState`, keeping other query
  parameters and the hash, so a client-side router sees `/`;
- calls `parent.__brAttach(window)` (in a `try`): the shell installs console and error
  forwarding (including scripts and stylesheets that fail to load) and
  `window.buildRoulette`, before any of the site's own scripts run. The hook only attaches
  the shell's current child frame, once per document. A nested frame of the site, or a
  popup, finds no hook.

If a page's own stricter CSP blocks the inline bootstrap, the shell attaches at the frame's
`load` event instead (later: early console calls are not forwarded).

`window.buildRoulette.ready()` tells the capture renderer that the first meaningful frame is
on screen (call it as `window.buildRoulette?.ready()`); it does nothing in the previews.

### The site worker

`src/sw.ts` (wiring), `src/sw-routing.ts` (pure routing, unit tested), `src/sw-store.ts`
(memory + Cache Storage).

**Which site a request belongs to:**

- a navigation to a reserved shell path (`/v1/…`, `/v2/…`, every `/vN/…`, so a later shell version can load in a browser that still runs this worker) is never intercepted;
- a navigation with `__br_site=<id>`: that site, and the document it creates
  (`FetchEvent.resultingClientId`) is mapped to it. An id the worker does not hold is a 404,
  never another site;
- any other same-origin navigation (a link to `/about.html`, `location.reload()` after
  `history.pushState`, a nested frame): the most recently loaded site, and its document is
  mapped too;
- any other request: its client's site (`FetchEvent.clientId`), whatever the path
  (`/assets/x.js`, `/data.json`, even `/v2/…`). A worker the site starts is mapped to the
  same site (its script request's `resultingClientId`), so its own requests are served too;
- requests from clients that are not mapped (the shell page, its `/v2/reset` fetch, the
  capture page) and every cross-origin request are not intercepted.

**Static-host rules:** `/` and `…/` → `index.html` in that folder; the exact file;
`path.html`; `path/index.html` (a navigation to `/docs` is redirected to `/docs/` first, so the
page's relative URLs resolve as on any static host); an unknown navigation → the root
`index.html` with a 200 (SPA fallback); any other miss → 404. Paths are percent-decoded.
Content types come from the pack. Only `GET` and `HEAD` (anything else: 405).

**Headers:** every site response carries `siteHeaders` (`src/headers.ts`): the site CSP
(`script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https:`, `worker-src 'self' blob:`,
`frame-ancestors 'self' <app origins>` in the preview and `'self'` plus the capture `sandbox`
flags on the capture page; the rest as before M6), `Permissions-Policy`,
`Cross-Origin-Resource-Policy`, `Referrer-Policy`, `X-Content-Type-Options`,
`Origin-Agent-Cluster` and `Cache-Control: no-store`. Which variant a site gets is decided by
the page that uploaded it (the capture page's path, or not). The headers are baked into
`sw.js` at build time. `sw.js` itself is served with `Service-Worker-Allowed: /` and
`Cache-Control: no-store` (`_headers` in production, `server.ts` locally); `install` calls
`skipWaiting()`, so a deploy takes over at the next registration.

**Surviving worker restarts:** the browser stops idle workers. Sites (files and a manifest)
and the state (site ids, the latest site, the client → site map) are written to the
`br-sandbox-sites-v2` cache (only the 6 most recent sites, at most 256 clients), and a
restarted worker reads them back. While it reads (the first event after a restart),
requests that may belong to a site wait for the state; one that turns out to belong to no
site is fetched from the network as is. A navigation to an unknown id reads the cache once
more before its 404 (an updated worker may have stored the site in the meantime). The e2e
stops the worker with CDP (`ServiceWorker.stopAllWorkers`) and loads a lazy chunk afterwards.

**Uploads** are accepted only from window clients that are not mapped to a site. That is
best effort: site code shares the origin and could post from a frame of its own. Nothing
relies on it (the threat model below).

### Site worker: threat model

In [docs/03-sandbox.md](../../docs/03-sandbox.md) §3.9, "The site worker" (moved there in
T-048): what build code on the shared stage-1 origin can and cannot do to the worker, its
cache and later builds.

### Limitations

- **One latest site per browser partition.** Navigations without a site id (in-site links,
  reloads) go to the most recently loaded site of the partition, not of the requesting
  frame's shell: two previews of different sites at once (two tabs) can cross over. Stage 2's
  per-build origins fix it.
- **Browser support.** Service workers in a cross-site iframe work with storage partitioning in
  current Chromium, Firefox and Safari; Firefox private windows have none (the preview shows a
  `module-load` error; REVEAL falls back to the screenshot). The routing relies on
  `FetchEvent.resultingClientId`; only Chromium is tested here.
- **The site sees the worker's cache** (`caches.keys()` lists `br-sandbox-sites-v2`), and a
  site that clears all caches loses its files after the next worker restart (the preview
  needs a new load then).
- **Media range requests** get the whole file with a 200 (no `206`).
- A site's own service worker (a PWA's `/sw.js`) never registers: registration fails with a
  404, as above.
