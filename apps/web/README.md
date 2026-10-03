# @br/web

The Next.js app (App Router). Routes: `/` (landing), `/playground` (single-player editor and
live preview), and placeholders for rooms and battles.

## `/playground` local setup

The preview runs on a different site from the app (docs/03 §3.5), so `/playground` needs two
local servers next to Next.js:

| Server | Default URL | Configured in the app by |
|---|---|---|
| Sandbox shell (`@br/sandbox-shell`) | `http://127.0.0.1:4321/v1/` | `NEXT_PUBLIC_SANDBOX_SHELL_URL` |
| Package CDN (mock, from `@br/runtime/test-support`) | `http://localhost:4322` | `NEXT_PUBLIC_PKG_CDN_URL` |

`127.0.0.1` and `localhost` are different sites, which gives the cross-site iframe the
production setup has.

```sh
# terminal 1: shell + mock CDN, allowing the dev app origin
pnpm --filter @br/web dev:sandbox

# terminal 2: the app
pnpm --filter @br/web dev        # http://localhost:3000/playground
```

The shell only talks to app origins it was built for: they are baked into `shell.js`
(postMessage target) and into its CSP `frame-ancestors`. `dev:sandbox` allows
`http://localhost:3000` by default. For another origin or port, set `BR_APP_ORIGINS`
(comma-separated), for example `BR_APP_ORIGINS=http://localhost:3100 pnpm --filter @br/web
dev:sandbox`. Ports: `SHELL_PORT` (4321) and `CDN_PORT` (4322); if you change them, set the two
`NEXT_PUBLIC_*` variables to match. They are inlined at build time, so rebuild after changing
them.

If the shell is not running, or does not allow the app origin, the preview shows
"The preview could not start" after 10 s.

The mock CDN serves only the packages installed in `packages/runtime` (`react`,
`react-dom`, `zustand`, `animate.css`) at their installed versions. The self-hosted package
CDN (T-006) replaces it.

### How the bundler is served

- The bundler worker is `src/lib/playground/bundler.worker.ts` (it imports
  `@br/runtime/worker`). `new Worker(new URL('./bundler.worker.ts', import.meta.url))` in
  `src/lib/playground/sandbox.ts` makes Turbopack bundle it as a separate worker chunk.
- `esbuild.wasm` is imported from this app's `esbuild-wasm` dependency. A Turbopack rule in
  `next.config.ts` (`'*.wasm': { type: 'asset' }`) emits it as a content-hashed file under
  `/_next/static/media/` and the import returns its URL. `next.config.ts` fails the build if
  this app's `esbuild-wasm` version differs from the one `@br/runtime` pins, because esbuild
  refuses to start with mismatched JS and wasm versions.
- `/playground` loads the editor with `next/dynamic` (`ssr: false`), so other routes never
  download CodeMirror, the runtime or the worker.

## Tests

```sh
pnpm --filter @br/web test:e2e
```

Runs `next build`, then Playwright starts `next start -p 3100` and `scripts/sandbox-servers.ts`
(allowing `http://localhost:3100`) and runs `e2e/`. It uses full Chromium (`channel:
'chromium'`), because the infinite-loop test needs site isolation (see
`packages/runtime/README.md`). `@playwright/test` is pinned to 1.56.1 to match the preinstalled
browser. Not part of `pnpm test`.
