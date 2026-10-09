# @br/pkg-cdn: esm.sh-compatible package CDN (npm registry)

Serves npm packages as browser-ready ES modules for the sandbox runtime
([docs/03-sandbox.md](../../docs/03-sandbox.md) §3.4), so builds need not depend on esm.sh
([docs/02-risks.md](../../docs/02-risks.md) R1, R10). On the free plan production uses the
public esm.sh instead, since this server would need Cloudflare Containers (T-035,
[docs/08-free-tier.md](../../docs/08-free-tier.md) §4); it stays the CDN of local runs, the
tests and the compatibility suite, and the option for a paid plan. It speaks the URL shape
that `@br/runtime`'s `cdn-rewrite` plugin emits:

```
GET /zustand@5.0.15?external=react,react-dom            bundled ES module
GET /@react-three/fiber@9.8.1?external=react,react-dom  scoped packages
GET /three@0.186.1/examples/jsm/controls/OrbitControls.js?external=react,react-dom
GET /react-dom@19.3.0/client?external=react,react-dom   (import map entries, React is CJS)
GET /leaflet@1.9.4/dist/leaflet.css                     raw file
GET /zustand@^5  /zustand@latest  /zustand              302 -> /zustand@5.0.15 (query kept)
```

Query parameters: `external=a,b` (left as bare imports for the page's import map), `deps=x@1.2.3`
(pins the version of peer dependencies that are emitted as CDN URLs), `target=es2020…esnext`
(default `es2022`), `dev` (unminified, `NODE_ENV=development`), `module` (serve a `.json`
subpath as an ES module). Unknown parameters are ignored and kept on redirects.

## How a request is served

```
URL ─► parse + validate name/version/subpath ─► denylist ─► packument (memory, TTL 5 min)
    ─► exact version?  no ─► 302 to /name@exact (Cache-Control: max-age=300)
                       yes ─► raw file?  ─► store: tarball → sha512 check → safe extract ─► file
                              module    ─► bundle cache hit? ─► served
                                           miss ─► dependency tree ─► esbuild bundle ─► cache
```

Registry requests, extractions and esbuild builds each go through one global limiter shared by
all requests (see [Availability](#availability-limits-load-shedding-cancellation)).

Disk cache (`PKG_CDN_CACHE_DIR`, default `apps/pkg-cdn/node_modules/.cache/pkg-cdn`):

| Path                                 | Contents                                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `store/<name>/<version>/`            | One extracted tarball per exact version, shared by all trees                                                  |
| `trees/v1/<name>@<version>/`         | npm-style `node_modules` tree of hard links into the store, plus `tree.json`                                  |
| `bundles/<xx>/<sha256>.js` + `.json` | Bundled module + metadata, keyed by (name, version, subpath, externals, deps pins, target, dev, build format) |
| `shims/process.js`                   | The injected `process` shim                                                                                   |
| `cache-index.json`                   | Sizes and last-access times for the disk quota (LRU)                                                          |
| `tmp/`, `trash/`                     | Tarballs being downloaded; entries being evicted (both cleaned at startup)                                    |

Every directory is written to a temp path and renamed into place, so a crash never leaves a
half-written entry, and concurrent requests for the same work are de-duplicated in memory.

### Dependency trees

For `name@version` the tree is resolved from packuments with `semver` (npm's rule: the
`latest` tag when it satisfies the range, else the highest match) and laid out like npm:
hoisted to the top level when the name is free, nested in the dependent's `node_modules` on a
version conflict. esbuild then resolves imports natively (`exports` with the `browser`,
`module`, `production`/`development` conditions; `browser`/`module`/`main` fields; `browser:
false` maps). `npm:` aliases and dist-tag specs are supported; git/file/URL specs are not.
Optional dependencies that do not exist, have no matching version or are platform-specific
(`os`/`cpu`) are skipped; a _transient_ failure (registry error, overload, timeout) fails the
request instead, so it is never baked into a cached tree. Install scripts are never run.

### Bundling rules (one ES module per URL)

1. `external` packages (and subpaths) stay bare: `import … from "react"`.
2. **Peer dependencies** of the requested package, and peers of a dependency that the tree does
   not provide, become CDN URLs (`/three@0.186.1?external=react,react-dom`), so e.g. `three` is
   one shared module and not a second copy inside `@react-three/fiber`. The version is the
   `deps=` pin, else npm's pick for the peer range.
3. A bare import of the requested package itself from inside it (`zustand` → `zustand/vanilla`,
   `three/examples/…` → `three`) becomes the CDN URL of that entry.
4. Everything else is bundled. Node built-ins the tree cannot provide become empty modules
   (`X-Pkg-Cdn-Stubbed-Builtins` header). CSS imported by package JS is injected as a `<style>`.
5. A CommonJS `require()` of anything external becomes an ES import through a small shim.
6. A CommonJS entry gets real named exports from cjs-module-lexer (static analysis, following
   `module.exports = require(…)` re-exports), and `default` = `module.exports` (or
   `exports.default` with `__esModule`), like esm.sh. React is served this way for the import map.
7. `process.env.NODE_ENV` is defined, `global` → `globalThis`, other `process` uses get a shim.

## Policy and limits

- `denylist.json`: `{ "packages": [{ "name", "versions"?, "reason" }] }` (semver range; no
  range = every version). Checked for the requested package and every package in its tree:
  `403` with the reason.
- Limits (env, see below): tarball size, unpacked size, files per package, packument size,
  packages per tree, bundle size, bundle time, registry request time, request time. Exceeding
  one is a `413` (`504` for time).

### Default limits and why

Measured on the R1 compat suite's real dependency trees (279 packages, 2026-10-03, abbreviated
packuments and latest tarballs from registry.npmjs.org):

| Limit                 | Default           | Largest in the compat trees                                                   | Other frontend packages for scale                               |
| --------------------- | ----------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Tarball (compressed)  | 32 MB (was 40)    | react-icons 21.7 MB, phaser 18.6, pixi.js 15.1                                | plotly.js 21.0, monaco-editor 17.7                              |
| Unpacked package      | 160 MB (was 250)  | phaser 107 MB, react-icons 84, pixi.js 73                                     | monaco-editor 97, plotly.js / aws-sdk 94, cesium 76             |
| Files per package     | 30000 (unchanged) | react-aria 7243, date-fns 5136                                                | @tabler/icons-react 12458; @mui/icons-material 43010 is refused |
| Abbreviated packument | 16 MB (was 64)    | react-aria 3.6 MB, react-reconciler 3.1, react-dom 3.0 (median 0.04, p95 1.6) | typescript 8.3; `next` 24 MB is refused (not a browser package) |
| Packument cache       | 128 MB            | all 279 packuments of a full compat run: 71 MB                                |                                                                 |
| Disk quota            | 5 GB              | a full compat run: 678 MB store + 17 MB trees + 14 MB bundles                 |                                                                 |

Each default is roughly 1.5x the largest real package (4x for packuments, whose size grows with
every release). Tarballs are streamed to disk and extracted as a stream, so the tarball and
unpacked limits now bound disk use and time, not memory; memory per download or extraction is a
few 16-64 KB buffers. A packument is parsed as one JSON document, so its limit (times the fetch
concurrency) is the main memory bound: worst case 16 fetches x 16 MB of buffers, plus their
parsed objects, if every in-flight request were a maximum-size packument; typically a few MB.

## Security

- Package code never runs on the server: tarballs are only extracted and parsed by esbuild and
  the lexers. Install scripts are ignored.
- Names are validated against npm's rules (and a filesystem-safe charset) before any registry
  request or path join; subpaths reject `..`, `.`, empty segments, `\` and control characters
  (on the raw request target, before any URL normalization).
- Tarballs: only fetched from the registry's own origin; `dist.integrity` (sha512) must match
  (no SRI hash → refused, unless `PKG_CDN_ALLOW_SHA1=1`; the digest is computed while the
  tarball streams to a temp file and checked before extraction); extraction is a stream
  (gunzip + tar parser) that writes regular files and directories only (no symlinks/hardlinks,
  `wx`, mode 0644), rejects absolute paths and traversal, and enforces the size, entry and
  file-count limits from each entry's header before inflating its data, so a gzip bomb is
  refused once the parser reaches the header that crosses a limit (inflating is pulled by the
  parser, so only the streams' read-ahead is ever inflated beyond it); nothing after the
  end-of-archive marker is inflated.
- The cache contains no symlinks; esbuild may only load files whose real path is inside the
  tree being bundled (a plugin `onLoad` guard), so `browser` maps or relative imports cannot read
  server files. Raw files are served only if their real path is inside the package.
- Raw file responses carry `Content-Security-Policy: default-src 'none'; sandbox`.

## Configuration

| Variable                                                         | Default                                        |
| ---------------------------------------------------------------- | ---------------------------------------------- |
| `PKG_CDN_PORT` (or `PORT`)                                       | `4400`                                         |
| `PKG_CDN_HOST`                                                   | `127.0.0.1`                                    |
| `PKG_CDN_CACHE_DIR`                                              | `apps/pkg-cdn/node_modules/.cache/pkg-cdn`     |
| `PKG_CDN_CACHE_QUOTA_MB`                                         | `5120` (`0` = no eviction)                     |
| `PKG_CDN_REGISTRY`                                               | `https://registry.npmjs.org`                   |
| `PKG_CDN_PACKUMENT_TTL_SECONDS` / `_PACKUMENT_CACHE_MB`          | `300` / `128`                                  |
| `PKG_CDN_DENYLIST`                                               | `apps/pkg-cdn/denylist.json` (`none` disables) |
| `PKG_CDN_MAX_TARBALL_MB` / `_MAX_UNPACKED_MB` / `_MAX_FILES`     | `32` / `160` / `30000`                         |
| `PKG_CDN_MAX_PACKUMENT_MB`                                       | `16`                                           |
| `PKG_CDN_MAX_DEPENDENCIES`                                       | `250`                                          |
| `PKG_CDN_MAX_OUTPUT_MB`                                          | `12`                                           |
| `PKG_CDN_BUNDLE_TIMEOUT_MS` / `_FETCH_TIMEOUT_MS`                | `60000` / `60000`                              |
| `PKG_CDN_REQUEST_TIMEOUT_MS`                                     | `90000`                                        |
| `PKG_CDN_MAX_CONCURRENT_FETCHES` / `_MAX_QUEUED_FETCHES`         | `16` / `2000`                                  |
| `PKG_CDN_MAX_CONCURRENT_EXTRACTIONS` / `_MAX_QUEUED_EXTRACTIONS` | `4` / `1000`                                   |
| `PKG_CDN_MAX_CONCURRENT_BUILDS` / `_MAX_QUEUED_BUILDS`           | `4` / `64`                                     |
| `PKG_CDN_RETRY_AFTER_SECONDS`                                    | `5`                                            |
| `PKG_CDN_ALLOW_SHA1`                                             | `0`                                            |

### Error reporting (T-030)

Off unless `SENTRY_DSN` is set (`SENTRY_ENVIRONMENT`, `SENTRY_RELEASE` optional); the startup
log says which. With it, a request that ends in **500** (an unexpected exception, a bundling
failure that is ours) or **502** (the npm registry failed: the first sign of a registry
outage) is reported to Sentry with the request path without its query string, the method,
the status and the error code (`src/reporting.ts`, built on `@br/telemetry`). Package
problems (4xx), load shedding (503), slow cold builds (504) and clients that went away (499)
are not. A crash of the process is reported before it exits.
`docs/runbooks/package-cdn-outage.md` says what to do with them.

## Availability: limits, load shedding, cancellation

- **Global limits.** Three limiters are shared by all requests: registry requests (packuments
  and tarballs, 16), tarball extractions (4) and esbuild builds (4). Up to the queue depth
  (2000 / 1000 / 64) more wait in FIFO order; past it the request fails at once with **`503`**,
  `Retry-After: 5` and `X-Pkg-Cdn-Error: overloaded` instead of queueing without bound. A dependency
  tree still downloads at most 8 packages at a time, inside the global registry limit. The queue
  depths are roughly what drains well inside the request timeout (16 fetches of ~0.25 s each
  clear 2000 in ~30 s; 4 builds of 0.5-2 s clear 64 in ~30 s).
- **Coalescing.** Concurrent requests for the same bundle, dependency tree, package
  (download + extraction) or packument share one in-flight job. Only successful results are
  kept (disk cache, packument cache); a failed job is forgotten as soon as it settles, so the
  next request retries.
- **Cancellation.** Every request has a deadline (`PKG_CDN_REQUEST_TIMEOUT_MS`, 90 s: below
  Cloudflare's 100 s origin timeout, so clients get our `504` and not the edge's `524`) and is
  cancelled when the client disconnects. A queued task leaves its queue at once. Shared work
  runs under its own signal that fires only when _every_ request waiting for it is gone; it
  then aborts its registry fetches, stops inflating, removes its temp files, cancels esbuild,
  and releases its slots (nested jobs compose: bundle → tree → package → tarball). Nothing
  half-done is cached.
- **Memory.** Tarballs stream to `tmp/` while hashed and are extracted as a stream; bundles
  (≤ 12 MB) and packuments (≤ 16 MB) are the only whole documents in memory. The packument
  cache is an LRU with a byte budget (128 MB).
- zlib and file I/O share libuv's thread pool (4 threads by default). With more than 4
  concurrent extractions, raise `UV_THREADPOOL_SIZE` to match.

### Disk quota and eviction

The cache tracks the disk usage of the store, trees and bundles (estimated: files rounded up to
4 KB blocks, plus a block per directory; a tree only counts what it does not share with the
store through hard links). Above `PKG_CDN_CACHE_QUOTA_MB` the least recently used store and
bundle entries are evicted until usage is under 90% of the quota.

- Evicting a store entry also evicts the trees that link to it (their hard links would keep
  the data on disk); bundles are self-contained and stay.
- Nothing in use is evicted: a build leases its tree, laying out a tree leases its store
  entries, serving a raw file leases its package until the file is open. A store entry whose
  tree is leased is skipped. Users take the lease before checking that an entry exists and wait
  for an eviction already in progress, then re-create the entry.
- Crash safety: a store or tree directory is renamed into `trash/` (atomic) before it is
  deleted, so its live path holds either the whole entry or nothing; a bundle's `.json` (whose
  presence means "complete") is removed before its `.js`. Startup removes `trash/`, stale temp
  directories and downloads, bundle `.js` files without a `.json`, and trees whose store entries
  are gone.
- Access times are kept in memory and written to `cache-index.json` (atomically, at most once a
  minute, only when something changed). That costs no syscall per cache hit, unlike touching
  mtimes, and does not depend on filesystem atime (often `noatime`/`relatime`). Losing up to a
  minute of access times in a crash only changes the eviction order. Sizes never change after
  an entry is created, so they are measured once. At startup the index is reconciled with the
  directory listing: unknown entries are measured (mtime as access time), missing ones dropped.
  Only paths found in the listing are ever deleted, never paths read from the index file.
- One process owns a cache directory (eviction state is in memory).

### Metrics: `GET /health`

JSON, `Cache-Control: no-store`, no secrets or paths:

| Field                                                 | Contents                                                                                                                                                          |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queues.registry` / `.extraction` / `.build`          | `active`, `queued`, `maxActive`, `maxQueue`, `completed`, `shed` (503s), `cancelled` (left the queue)                                                             |
| `inflight`                                            | Shared jobs in flight: `bundles`, `trees`, `packages`, `packuments`                                                                                               |
| `cache`                                               | `bytes`, `quotaBytes`, `entries` (store/trees/bundles), `leased`, `evicting`, `evictionRuns`, `evictedEntries`, `evictedBytes`, `evictionErrors`, `skippedLeased` |
| `requests`                                            | `active`, `total`, `byStatus`, `shed` (503), `timedOut` (504), `clientClosed`                                                                                     |
| `packuments`, `registry`, `store`, `trees`, `bundles` | Cache sizes, fetch counts and bytes (incl. largest packument/tarball seen), builds, hits, errors                                                                  |

(`/metrics` would shadow the npm package `metrics`; `/health` already existed.)

## Running behind the Cloudflare cache

What the edge can cache (the origin's `Cache-Control` is authoritative; turn on "respect origin
cache headers" and a Cache Rule that makes every path eligible, since module URLs have no `.js`
extension; keep the full query string in the cache key):

| Response                                                  | `Cache-Control`                       | At the edge                                                                                                                  |
| --------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `200` module or raw file at an exact version              | `public, max-age=31536000, immutable` | Cache for a year: the bytes for a URL never change (the denylist is the exception: purge the package's URLs when you add it) |
| `302` from a range, tag or bare name                      | `public, max-age=300, stale-while-revalidate=60, stale-if-error=86400` | Cache for 5 minutes (new releases show up after that); a stale copy may be served for a minute while revalidating, and for a day while the origin fails |
| `4xx`/`5xx` errors, incl. `503` + `Retry-After` and `504` | `no-store`                            | Never cached; clients retry                                                                                                  |
| `/health`                                                 | `no-store`                            | Never cached; block it from the public internet (WAF rule) or allow only monitoring IPs                                      |

Only cache misses reach the origin, so rate limits should count requests to the origin:

- **Per IP: 120 origin requests per minute** (block with `429` for a minute). A user opening a
  new app makes ~5-40 cold module requests in a burst (the compat cases need 1-10 each, plus 4
  for React), so this leaves room for a few apps per minute and stops a single client from
  walking the registry.
- **Per IP: 600 requests per minute in total**, cached or not, as a coarse flood limit.
- Optionally a lower per-IP limit (e.g. 30/min) on non-exact URLs (`302`s), which force a
  packument lookup: `/name`, `/name@^1`, `/name@latest`.
- Behind those, the origin's own limits (queue depths, `503`) protect it from many IPs at once.
  Alert on `requests.shed` and `queues.*.queued` from `/health`.

Every response carries `Content-Length` (no chunked encoding).

### Origin outages (T-032)

Goal: when the container is down, every package somebody already requested keeps being
served by the edge, and the browser of a player who already loaded a package keeps it.

- **In the browser** this works today: exact-version responses are `immutable` for a year,
  and the sandbox shell warms the template's React entry points into the build frame's HTTP
  cache partition. Measurements and limits: docs/03-sandbox.md "Package cache and CDN
  outages". No Service Worker, on purpose (same section).
- **At the edge** (deploy checklist). *Assumption* marks what could not be checked without
  a Cloudflare account; verify each on staging by stopping the container and requesting a
  URL that was requested before (`cf-cache-status: HIT`, or `STALE` / `UPDATING`).
  1. **The cache must sit in front of the container.** *Assumption:* with Cloudflare
     Containers the request path is edge → Worker → container (a Durable Object binding).
     Cache Rules apply to fetches from a zone to its origin, not to a Worker's own responses,
     and a Worker runs before the cache. So the Worker in front of the container has to use
     the Cache API itself:
     - `caches.default.match(request)` first, keyed by the full URL including the query;
     - on a miss, `container.fetch(request)`, then `cache.put()` for `200` (`immutable`)
       and `302` responses (`ctx.waitUntil`);
     - on a container error or exception, answer from `caches.default` if it has the URL,
       otherwise with the error (`no-store`).

     If the container is instead reachable as an ordinary proxied origin (a hostname with
     a Cache Rule "Eligible for cache", origin cache headers respected, the full query string
     in the cache key), the rules above in this section are enough. *Assumption:* the
     Cache API in a Worker is per data center (no tiered cache), so the zone cache is the
     better place if the container can be an origin.
  2. **Exact-version URLs stay cached for a year:** `public, max-age=31536000, immutable`
     (in code). Cloudflare can still evict rarely used objects from a data center. Turn on
     **Tiered Cache** (Smart Tiered Caching) so one upper tier keeps them. *Assumption:*
     **Cache Reserve** (paid, R2-backed) keeps cacheable objects with a TTL of at least
     10 hours and a `Content-Length` for much longer. Both hold for every module and file
     response. That is the strongest "origin down, still served" option.
  3. **Serve stale on origin errors:** `302`s carry `stale-if-error=86400` and
     `stale-while-revalidate=60` (in code). *Assumption:* the zone cache honours both for
     origin errors and timeouts. A Worker using the Cache API does not: `match()` never
     returns an expired entry. That Worker would need to keep its own longer-lived copy of a
     `302` under a second key. Builds never request `302` URLs (their versions are exact), so
     this matters for people and tools only.
  4. **Never cache errors:** `4xx`/`5xx` are `no-store` (in code). Don't add an "Edge TTL"
     override that would cache them.
  5. **Pre-warm** the template packages after each deploy and after any purge, through the
     public URL (the runbook has the command). Don't purge everything during an incident:
     the cache is what keeps the game running.

## Commands

```
pnpm --filter @br/pkg-cdn dev        # tsx src/main.ts
pnpm --filter @br/pkg-cdn build      # dist/main.js (esbuild, deps external); then `start`
pnpm --filter @br/pkg-cdn test       # unit + server tests against an in-memory registry (offline)
pnpm --filter @br/pkg-cdn compat     # R1 compatibility suite (needs the npm registry + Chromium)
pnpm --filter @br/pkg-cdn compat --cdn https://esm.sh   # the same cases against another CDN
```

`compat` options (`compat/options.ts`): `--cdn <baseUrl>` (or `COMPAT_CDN`; empty, `own` or
`pkg-cdn` = this server), `--only zustand,three`, `--keep-cache`, `--cache-dir <dir>`,
`--no-write`, `--verbose`. A full run writes [compat/RESULTS.md](compat/RESULTS.md) for this
server, or `compat/RESULTS-<host>.md` for another CDN (`RESULTS-esm.sh.md`), and
`node_modules/.cache/pkg-cdn-compat/results.json` (every probed URL with its headers).

**With `--cdn`** (T-035) the suite does not start this server: the sandbox shell's CSP allows
the given CDN's origin and the runtime uses its base URL, as a production build would. Each
case then runs exactly as against this server. Besides rendering, every URL a case requests
and every module those import from the CDN are checked against what the sandbox needs
(`compat/contract.ts`): `200` without a redirect, `max-age` of at least 30 days, CORS, the
content type, imports only from the CDN's own origin, and whether the shell's import scan
sees them. Requests carry Chromium's User-Agent and an `Origin`, so the CDN answers as it
answers the browser. The run fails when fewer than 90% of the cases pass or when the React
import map breaks that contract. In CI: the `compat` job of a manual run, input `compat_cdn`
(`.github/workflows/ci.yml`; the results are the job's `compat-results` artifact).

## Not replicated from esm.sh

esm.sh answers an entry URL (`/react@19.3.0`) with a re-export of an internal build path
(`/react@19.3.0/es2022/react.mjs`); this server answers with the module itself. The sandbox
shell handles both (it follows a module's imports on the CDN's origin when it warms or checks
packages, T-035). Also not replicated:

- Shared chunks between entry points of one package: each subpath is its own bundle, so
  internals that two subpaths both import by _relative_ path are duplicated (bare
  self-references are shared). Example: `pixi.js/unsafe-eval` patches its own copy.
- Named exports of CommonJS modules that static analysis cannot see (webpack-style UMD such as
  `matter-js`: `import Matter from 'matter-js'` works, `import { Engine } from 'matter-js'` does
  not). esm.sh evaluates such modules on its server; we deliberately do not run package code.
- Node built-in polyfills (`buffer`, `events`, …) unless the package depends on the npm polyfill.
- `/v135/`-style version prefixes, `?bundle`/`?standalone`, `?alias`, `?css`, `?worker`, `?raw`,
  `X-TypeScript-Types`, user-agent target detection, `gh:`/`jsr:` packages, HTTP compression
  (expected from the edge in front of it), `new URL('./asset', import.meta.url)` rewriting.
