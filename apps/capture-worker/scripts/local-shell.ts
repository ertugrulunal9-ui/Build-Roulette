/**
 * Local sandbox origins for running the worker by hand (`pnpm --filter @br/capture-worker
 * dev:shell`, next to `pnpm --filter @br/capture-worker dev`):
 *
 *   sandbox shell + capture gate   http://127.0.0.1:4331/v1/capture   (CAPTURE_SHELL_URL)
 *   mock package CDN               http://localhost:4332              (PKG_CDN_URL)
 *
 * Env: CAPTURE_HMAC_SECRET (required, same value as the worker), SUPABASE_URL (allowed in
 * the capture page's connect-src, default http://127.0.0.1:54321), SHELL_PORT, CDN_PORT.
 */
import { startShellServer } from '@br/sandbox-shell/server';
// Imported by path: @br/runtime does not export its test support (same as apps/web).
import { startMockCdn } from '../../../packages/runtime/test-support/mock-cdn';

const env = process.env;
const secret = env['CAPTURE_HMAC_SECRET'];
if (!secret) {
  process.stderr.write('CAPTURE_HMAC_SECRET is required\n');
  process.exit(2);
}
const supabaseUrl = env['SUPABASE_URL'] ?? 'http://127.0.0.1:54321';
const cdn = await startMockCdn({ port: Number(env['CDN_PORT'] ?? 4332), host: 'localhost' });
const shell = await startShellServer({
  port: Number(env['SHELL_PORT'] ?? 4331),
  host: '127.0.0.1',
  appOrigins: ['http://localhost:3000'],
  cdnOrigin: cdn.url,
  extraConnectSrc: [new URL(supabaseUrl).origin],
  captureSecret: secret,
});
console.log(`capture page   ${shell.captureUrl}`);
console.log(`mock CDN       ${cdn.url}`);

const stop = () => {
  void Promise.all([shell.close(), cdn.close()]).then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
