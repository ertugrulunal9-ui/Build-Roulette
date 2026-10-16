/**
 * How every e2e suite serves the app (T-037; T-043): the static export in `out/` and the
 * link-preview Worker `dist/worker.js` (both built by `pnpm build`, which every `test:e2e*`
 * script runs first) through `wrangler dev`, Cloudflare's own local runtime (workerd with the
 * static-assets router): the same `_redirects` rewrites (`/u/{id}` → the shell), `_headers`
 * (the CSP and the other security headers), 404 page and `run_worker_first` routing
 * (`/battles/*` to the Worker) as production. No Next server is involved.
 *
 * wrangler reads `wrangler.jsonc` (`main: ./dist/worker.js`, `assets.directory: ./out`). It
 * binds `localhost`, the origin the sandbox shell is started with (`BR_APP_ORIGINS`).
 */
export function appServerCommand(port: number): string {
  return `wrangler dev --port ${String(port)} --ip localhost --show-interactive-dev-session=false --log-level warn`;
}

/** Environment for the app server: no wrangler metrics, no Next telemetry. */
export const APP_SERVER_ENV = {
  WRANGLER_SEND_METRICS: 'false',
  NEXT_TELEMETRY_DISABLED: '1',
};
