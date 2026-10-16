/**
 * The local sandbox origin for the previews (`/try`, dev and e2e):
 *
 *   sandbox shell (/v2/)   http://127.0.0.1:4321   a different *site* from the app on localhost
 *
 * The shell bakes the allowed app origins into shell.js (postMessage target + CSP
 * frame-ancestors), so it must be started with the origin the app is served from:
 *
 *   BR_APP_ORIGINS   comma-separated app origins (default http://localhost:3000)
 *   SHELL_PORT       default 4321 (must match NEXT_PUBLIC_SANDBOX_SHELL_URL)
 *
 * Imported sites need no package CDN (docs/09): what a site loads from the internet, it
 * loads itself.
 *
 * Run: pnpm --filter @br/web dev:sandbox   (next to `pnpm --filter @br/web dev`)
 */
import { startShellServer } from '@br/sandbox-shell/server';

const env = process.env;
const appOrigins = (env['BR_APP_ORIGINS'] ?? 'http://localhost:3000')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const shellPort = Number(env['SHELL_PORT'] ?? 4321);

const shell = await startShellServer({
  port: shellPort,
  host: '127.0.0.1',
  appOrigins,
});

console.log(`sandbox shell  ${shell.shellUrl}  (allows ${appOrigins.join(', ')})`);

const stop = () => {
  void shell.close().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
