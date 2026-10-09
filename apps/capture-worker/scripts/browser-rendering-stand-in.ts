/**
 * The Browser Rendering stand-in (src/stand-in.ts) on its own, for running the `jobs` Edge
 * Function locally by hand:
 *
 *   pnpm --filter @br/capture-worker stand-in
 *   → API base http://host.docker.internal:4325/client/v4 (BROWSER_RENDERING_API_URL for the
 *     function, which runs in Docker), account `local`, token from the environment
 *
 * Env: STAND_IN_PORT (4325), BROWSER_RENDERING_ACCOUNT_ID (`local`),
 * BROWSER_RENDERING_API_TOKEN (required, the function's value), STAND_IN_MIN_INTERVAL_MS
 * (0; 10000 emulates the free plan's rate limit with 429s).
 * Test controls (curl): POST /__stand-in/faults {"status":429,"retryAfterS":30,"count":3}
 * or {"hang":true}, DELETE /__stand-in/faults, GET /__stand-in/requests.
 */
import { createLogger } from '../src/log';
import { startBrowserRenderingStandIn } from '../src/stand-in';

const env = process.env;
const apiToken = env['BROWSER_RENDERING_API_TOKEN'];
if (!apiToken) {
  process.stderr.write(
    'BROWSER_RENDERING_API_TOKEN is required (the same value as the function)\n',
  );
  process.exit(2);
}
const standIn = await startBrowserRenderingStandIn({
  accountId: env['BROWSER_RENDERING_ACCOUNT_ID'] ?? 'local',
  apiToken,
  port: Number(env['STAND_IN_PORT'] ?? 4325),
  minIntervalMs: Number(env['STAND_IN_MIN_INTERVAL_MS'] ?? 0),
  control: true,
  log: createLogger({ base: { svc: 'browser-rendering-stand-in' } }),
});
console.log(`Browser Rendering stand-in  ${standIn.url}`);
console.log(`from the Edge Runtime       ${standIn.urlFor('host.docker.internal')}`);

const stop = () => {
  void standIn.close().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
