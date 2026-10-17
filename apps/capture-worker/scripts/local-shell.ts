/**
 * Local sandbox origin for running the worker by hand (`pnpm --filter @br/capture-worker
 * dev:shell`, next to `pnpm --filter @br/capture-worker dev`):
 *
 *   sandbox shell (v2) + capture gate   http://127.0.0.1:4331/v2/capture   (CAPTURE_SHELL_URL)
 *
 * The capture page fetches the build's site pack (`site.bin`) from Storage, so the Supabase
 * origin is allowed in its connect-src. Env: CAPTURE_HMAC_SECRET (required, same value as the
 * worker), SUPABASE_URL (default http://127.0.0.1:54321), SHELL_PORT.
 */
import { startShellServer } from '@br/sandbox-shell/server';

const env = process.env;
const secret = env['CAPTURE_HMAC_SECRET'];
if (!secret) {
  process.stderr.write('CAPTURE_HMAC_SECRET is required\n');
  process.exit(2);
}
const supabaseUrl = env['SUPABASE_URL'] ?? 'http://127.0.0.1:54321';
const shell = await startShellServer({
  port: Number(env['SHELL_PORT'] ?? 4331),
  host: '127.0.0.1',
  appOrigins: ['http://localhost:3000'],
  extraConnectSrc: [new URL(supabaseUrl).origin],
  captureSecret: secret,
});
console.log(`capture page   ${shell.captureUrl}`);

const stop = () => {
  void shell.close().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
