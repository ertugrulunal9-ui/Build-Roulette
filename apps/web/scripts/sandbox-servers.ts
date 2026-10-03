/**
 * Local sandbox origins for /playground (dev and e2e):
 *
 *   sandbox shell (/v1/)   http://127.0.0.1:4321   a different *site* from the app on localhost
 *   mock package CDN       http://localhost:4322
 *
 * The shell bakes the allowed app origins into shell.js (postMessage target + CSP
 * frame-ancestors), so it must be started with the origin the app is served from:
 *
 *   BR_APP_ORIGINS   comma-separated app origins (default http://localhost:3000)
 *   SHELL_PORT       default 4321 (must match NEXT_PUBLIC_SANDBOX_SHELL_URL)
 *   CDN_PORT         default 4322 (must match NEXT_PUBLIC_PKG_CDN_URL)
 *
 * Run: pnpm --filter @br/web dev:sandbox   (next to `pnpm --filter @br/web dev`)
 */
import { startShellServer } from '@br/sandbox-shell/server';
// The mock CDN lives in @br/runtime's test support and serves the packages installed there.
// It is imported by path because @br/runtime does not export its test support. Switch to
// the self-hosted package CDN (T-006) once it exists.
import { startMockCdn } from '../../../packages/runtime/test-support/mock-cdn';

const env = process.env;
const appOrigins = (env['BR_APP_ORIGINS'] ?? 'http://localhost:3000')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const shellPort = Number(env['SHELL_PORT'] ?? 4321);
const cdnPort = Number(env['CDN_PORT'] ?? 4322);

const cdn = await startMockCdn({ port: cdnPort, host: 'localhost' });
const shell = await startShellServer({
  port: shellPort,
  host: '127.0.0.1',
  appOrigins,
  cdnOrigin: cdn.url,
});

console.log(`sandbox shell  ${shell.shellUrl}  (allows ${appOrigins.join(', ')})`);
console.log(`mock CDN       ${cdn.url}`);

const stop = () => {
  void Promise.all([shell.close(), cdn.close()]).then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
