/**
 * Everything the solo game needs locally, in one process:
 *
 *   local Supabase stack     http://127.0.0.1:54321   (`supabase start`; checked or started)
 *   mock package CDN         http://localhost:4322
 *   sandbox shell            http://127.0.0.1:4321/v1/          (preview, a different site)
 *     + capture page         http://127.0.0.1:4321/v1/capture   (HMAC gate, same shell)
 *   capture/destroy worker   @br/capture-worker (Playwright Chromium), polling the job queue
 *   Next.js                  http://localhost:3000   (only with --next: `next dev`)
 *
 *   pnpm --filter @br/web dev:solo          # all of the above, starting the stack if needed
 *   tsx scripts/solo-services.ts            # without Next (the solo e2e starts `next start`)
 *
 * Flags: --next (run `next dev`), --start-stack (run `supabase start` when the stack is not
 * up; needs Docker). Env: BR_APP_ORIGINS (default http://localhost:3000), SHELL_PORT (4321),
 * CDN_PORT (4322), APP_PORT (3000, with --next), CAPTURE_HMAC_SECRET (default: random per
 * run), SUPABASE_INTERNAL_IMAGE_REGISTRY (passed to `supabase start`), and the stack's
 * API_URL / ANON_KEY / SERVICE_ROLE_KEY (default: `supabase status -o env`).
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startShellServer } from '@br/sandbox-shell/server';
// The mock CDN lives in @br/runtime's test support (imported by path, like dev:sandbox).
import { startMockCdn } from '../../../packages/runtime/test-support/mock-cdn';

const SUPABASE_CLI = 'supabase@2.119.0';
const EXCLUDED_SERVICES =
  'studio,imgproxy,vector,logflare,edge-runtime,supavisor,mailpit,realtime,postgres-meta';
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const webDir = fileURLToPath(new URL('../', import.meta.url));

const args = new Set(process.argv.slice(2));
const env = process.env;
const appPort = Number(env['APP_PORT'] ?? 3000);
const appOrigins = (env['BR_APP_ORIGINS'] ?? `http://localhost:${String(appPort)}`)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const shellPort = Number(env['SHELL_PORT'] ?? 4321);
const cdnPort = Number(env['CDN_PORT'] ?? 4322);

function log(msg: string): void {
  process.stdout.write(`[solo] ${msg}\n`);
}

interface StackEnv {
  API_URL: string;
  ANON_KEY: string;
  SERVICE_ROLE_KEY: string;
}

function readStackEnv(): StackEnv | null {
  const fromEnv = {
    API_URL: env['API_URL'],
    ANON_KEY: env['ANON_KEY'],
    SERVICE_ROLE_KEY: env['SERVICE_ROLE_KEY'],
  };
  if (fromEnv.API_URL && fromEnv.ANON_KEY && fromEnv.SERVICE_ROLE_KEY) return fromEnv as StackEnv;
  let out: string;
  try {
    out = execFileSync('npx', ['-y', SUPABASE_CLI, 'status', '-o', 'env'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
  const found: Record<string, string> = {};
  for (const line of out.split('\n')) {
    const m = /^([A-Z_]+)="?(.*?)"?$/.exec(line.trim());
    if (m?.[1] && m[2]) found[m[1]] = m[2];
  }
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = found;
  return API_URL && ANON_KEY && SERVICE_ROLE_KEY ? { API_URL, ANON_KEY, SERVICE_ROLE_KEY } : null;
}

let stack = readStackEnv();
if (!stack && args.has('--start-stack')) {
  log('starting the local Supabase stack (Docker)…');
  execFileSync('npx', ['-y', SUPABASE_CLI, 'start', '-x', EXCLUDED_SERVICES], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  stack = readStackEnv();
}
if (!stack) {
  process.stderr.write(
    `The local Supabase stack is not running. Start it from the repository root:\n` +
      `  npx -y ${SUPABASE_CLI} start -x ${EXCLUDED_SERVICES}\n` +
      `(or run this with --start-stack). See apps/web/README.md.\n`,
  );
  process.exit(1);
}
log(`Supabase      ${stack.API_URL}`);

const secret = env['CAPTURE_HMAC_SECRET'] ?? randomBytes(32).toString('hex');
const cdn = await startMockCdn({ port: cdnPort, host: 'localhost' });
const shell = await startShellServer({
  port: shellPort,
  host: '127.0.0.1',
  appOrigins,
  cdnOrigin: cdn.url,
  // The capture page fetches the bundle from Storage (signed URLs).
  extraConnectSrc: [new URL(stack.API_URL).origin],
  captureSecret: secret,
});
log(`sandbox shell ${shell.shellUrl}  (allows ${appOrigins.join(', ')})`);
log(`capture page  ${shell.captureUrl}`);
log(`mock CDN      ${cdn.url}`);

const children: ChildProcess[] = [];
let stopping = false;

function run(
  name: string,
  cmd: string,
  argv: string[],
  extraEnv: Record<string, string>,
  cwd: string,
) {
  const child = spawn(cmd, argv, {
    cwd,
    env: { ...env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const prefix = (chunk: Buffer) =>
    chunk
      .toString()
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => `[${name}] ${l}\n`)
      .join('');
  child.stdout.on('data', (c: Buffer) => process.stdout.write(prefix(c)));
  child.stderr.on('data', (c: Buffer) => process.stderr.write(prefix(c)));
  child.on('exit', (code, signal) => {
    log(`${name} exited (${String(code ?? signal)})`);
    if (!stopping) void stop(1);
  });
  children.push(child);
  return child;
}

run(
  'capture',
  'pnpm',
  ['--filter', '@br/capture-worker', 'dev'],
  {
    SUPABASE_URL: stack.API_URL,
    SUPABASE_SERVICE_ROLE_KEY: stack.SERVICE_ROLE_KEY,
    CAPTURE_SHELL_URL: shell.captureUrl,
    CAPTURE_HMAC_SECRET: secret,
    PKG_CDN_URL: cdn.url,
    // Pick up new jobs quickly while someone is playing.
    WORKER_IDLE_MAX_MS: env['WORKER_IDLE_MAX_MS'] ?? '2000',
  },
  repoRoot,
);

if (args.has('--next')) {
  run(
    'next',
    'pnpm',
    ['exec', 'next', 'dev', '-p', String(appPort)],
    {
      NEXT_TELEMETRY_DISABLED: '1',
      NEXT_PUBLIC_SUPABASE_URL: env.NEXT_PUBLIC_SUPABASE_URL ?? stack.API_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? stack.ANON_KEY,
      NEXT_PUBLIC_SANDBOX_SHELL_URL: shell.shellUrl,
      NEXT_PUBLIC_PKG_CDN_URL: cdn.url,
    },
    webDir,
  );
  log(`app           http://localhost:${String(appPort)}/play`);
}

async function stop(code: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill('SIGTERM');
  await Promise.all([shell.close(), cdn.close()]);
  process.exit(code);
}
process.on('SIGINT', () => void stop(0));
process.on('SIGTERM', () => void stop(0));
