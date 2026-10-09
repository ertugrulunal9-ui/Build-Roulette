/**
 * How every e2e suite serves the app (T-037): the static export in `out/` (built by
 * `pnpm build`, which every `test:e2e*` script runs first) through `wrangler pages dev`,
 * Cloudflare's own local Pages server (workerd with the Pages asset router): the same
 * `_redirects` rewrites (`/battles/{id}` → the shell), `_headers` (the CSP and the other
 * security headers) and 404 handling as production. No Next server is involved.
 *
 * wrangler reads `wrangler.jsonc` (`pages_build_output_dir: ./out`). It binds `localhost`,
 * the origin the sandbox shell is started with (`BR_APP_ORIGINS`).
 */
export function appServerCommand(port: number): string {
  return `wrangler pages dev --port ${String(port)} --ip localhost --show-interactive-dev-session=false --log-level warn`;
}

/** Environment for the app server: no wrangler metrics, no Next telemetry. */
export const APP_SERVER_ENV = {
  WRANGLER_SEND_METRICS: 'false',
  NEXT_TELEMETRY_DISABLED: '1',
};
