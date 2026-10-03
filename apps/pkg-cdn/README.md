# @br/pkg-cdn: esm.sh-compatible package CDN (npm registry)

Serves npm packages as browser-ready ES modules for the sandbox runtime
([docs/03-sandbox.md](../../docs/03-sandbox.md) §3.4), so builds do not depend on esm.sh
([docs/02-risks.md](../../docs/02-risks.md) R1, R10). It speaks the URL shape that
`@br/runtime`'s `cdn-rewrite` plugin emits:

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

Disk cache (`PKG_CDN_CACHE_DIR`, default `apps/pkg-cdn/node_modules/.cache/pkg-cdn`):

| Path | Contents |
|---|---|
| `store/<name>/<version>/` | One extracted tarball per exact version, shared by all trees |
| `trees/v1/<name>@<version>/` | npm-style `node_modules` tree of hard links into the store, plus `tree.json` |
| `bundles/<xx>/<sha256>.js` + `.json` | Bundled module + metadata, keyed by (name, version, subpath, externals, deps pins, target, dev, build format) |
| `shims/process.js` | The injected `process` shim |

Every directory is written to a temp path and renamed into place, so a crash never leaves a
half-written entry, and concurrent requests for the same work are de-duplicated in memory.

### Dependency trees
For `name@version` the tree is resolved from packuments with `semver` (npm's rule: the
`latest` tag when it satisfies the range, else the highest match) and laid out like npm:
hoisted to the top level when the name is free, nested in the dependent's `node_modules` on a
version conflict. esbuild then resolves imports natively (`exports` with the `browser`,
`module`, `production`/`development` conditions; `browser`/`module`/`main` fields; `browser:
false` maps). `npm:` aliases and dist-tag specs are supported; git/file/URL specs are not.
Optional dependencies that fail to resolve or are platform-specific (`os`/`cpu`) are skipped.
Install scripts are never run.

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
- Limits (env, see below): tarball size, unpacked size, files per package, packages per tree,
  bundle size, bundle time, registry request time. Exceeding one is a `413` (`504` for time).

## Security

- Package code never runs on the server: tarballs are only extracted and parsed by esbuild and
  the lexers. Install scripts are ignored.
- Names are validated against npm's rules (and a filesystem-safe charset) before any registry
  request or path join; subpaths reject `..`, `.`, empty segments, `\` and control characters
  (on the raw request target, before any URL normalization).
- Tarballs: only fetched from the registry's own origin; `dist.integrity` (sha512) must match
  (no SRI hash → refused, unless `PKG_CDN_ALLOW_SHA1=1`); extraction writes regular files and
  directories only (no symlinks/hardlinks), rejects absolute paths and traversal, mode 0644,
  size and file-count limits enforced while inflating.
- The cache contains no symlinks; esbuild may only load files whose real path is inside the
  tree being bundled (a plugin `onLoad` guard), so `browser` maps or relative imports cannot read
  server files. Raw files are served only if their real path is inside the package.
- Raw file responses carry `Content-Security-Policy: default-src 'none'; sandbox`.

## Configuration

| Variable | Default |
|---|---|
| `PKG_CDN_PORT` (or `PORT`) | `4400` |
| `PKG_CDN_HOST` | `127.0.0.1` |
| `PKG_CDN_CACHE_DIR` | `apps/pkg-cdn/node_modules/.cache/pkg-cdn` |
| `PKG_CDN_REGISTRY` | `https://registry.npmjs.org` |
| `PKG_CDN_PACKUMENT_TTL_SECONDS` | `300` |
| `PKG_CDN_DENYLIST` | `apps/pkg-cdn/denylist.json` (`none` disables) |
| `PKG_CDN_MAX_TARBALL_MB` / `_MAX_UNPACKED_MB` / `_MAX_FILES` | `40` / `250` / `30000` |
| `PKG_CDN_MAX_DEPENDENCIES` | `250` |
| `PKG_CDN_MAX_OUTPUT_MB` | `12` |
| `PKG_CDN_BUNDLE_TIMEOUT_MS` / `_FETCH_TIMEOUT_MS` | `60000` / `60000` |
| `PKG_CDN_ALLOW_SHA1` | `0` |
| `PKG_CDN_MAX_CONCURRENT_BUILDS` | `4` |

## Commands

```
pnpm --filter @br/pkg-cdn dev        # tsx src/main.ts
pnpm --filter @br/pkg-cdn build      # dist/main.js (esbuild, deps external); then `start`
pnpm --filter @br/pkg-cdn test       # unit + server tests against an in-memory registry (offline)
pnpm --filter @br/pkg-cdn compat     # R1 compatibility suite (needs the npm registry + Chromium)
```

`compat` options: `--only zustand,three`, `--keep-cache`, `--cache-dir <dir>`, `--no-write`,
`--verbose`. It writes [compat/RESULTS.md](compat/RESULTS.md) (only for full runs).

## Not replicated from esm.sh

- Shared chunks between entry points of one package: each subpath is its own bundle, so
  internals that two subpaths both import by *relative* path are duplicated (bare
  self-references are shared). Example: `pixi.js/unsafe-eval` patches its own copy.
- Named exports of CommonJS modules that static analysis cannot see (webpack-style UMD such as
  `matter-js`: `import Matter from 'matter-js'` works, `import { Engine } from 'matter-js'` does
  not). esm.sh evaluates such modules on its server; we deliberately do not run package code.
- Node built-in polyfills (`buffer`, `events`, …) unless the package depends on the npm polyfill.
- `/v135/`-style version prefixes, `?bundle`/`?standalone`, `?alias`, `?css`, `?worker`, `?raw`,
  `X-TypeScript-Types`, user-agent target detection, `gh:`/`jsr:` packages, HTTP compression
  (expected from the edge in front of it), `new URL('./asset', import.meta.url)` rewriting.
