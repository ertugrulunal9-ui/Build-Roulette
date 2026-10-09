/**
 * Everything the solo game and the rooms need locally, in one process:
 *
 *   local Supabase stack     http://127.0.0.1:54321   (`supabase start` WITH Realtime;
 *                                                      checked or started)
 *   mock package CDN         http://localhost:4322
 *   sandbox shell            http://127.0.0.1:4321/v1/          (preview, a different site)
 *     + capture page         http://127.0.0.1:4321/v1/capture   (HMAC gate, same shell)
 *   capture/destroy worker   @br/capture-worker (Playwright Chromium), polling the job queue
 *   Next.js                  http://localhost:3000   (only with --next: `next dev`)
 *
 *   pnpm --filter @br/web dev:solo          # all of the above, starting the stack if needed
 *   pnpm --filter @br/web dev:multi         # the same, and Realtime must be up (rooms)
 *   tsx scripts/solo-services.ts            # without Next (the e2e suites start `wrangler pages dev`)
 *
 * Flags: --next (run `next dev`), --start-stack (run `supabase start` when the stack is not
 * up; needs Docker), --realtime (fail when the stack runs without Realtime, which rooms need:
 * private channels, broadcasts from the database, Presence). Env: BR_APP_ORIGINS (default http://localhost:3000), SHELL_PORT (4321),
 * CDN_PORT (4322), CDN_CONTROL_PORT (4323: `POST /cdn-outage?mode=refuse|error|hang|off`
 * simulates a package CDN outage, T-032 e2e), APP_PORT (3000, with --next), CAPTURE_HMAC_SECRET (default: random per
 * run), SUPABASE_INTERNAL_IMAGE_REGISTRY (passed to `supabase start`), and the stack's
 * API_URL / ANON_KEY / SERVICE_ROLE_KEY (default: `supabase status -o env`), and
 * BR_SERVICES_LOG (a file that also gets every line, each prefixed with an ISO timestamp:
 * the rooms e2e attach the lines of a failed test's time window, see e2e/diagnostics.ts).
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startShellServer } from '@br/sandbox-shell/server';
// The mock CDN lives in @br/runtime's test support (imported by path, like dev:sandbox).
import {
  parseLayout,
  startMockCdn,
  startOutageControl,
} from '../../../packages/runtime/test-support/mock-cdn';

const SUPABASE_CLI = 'supabase@2.119.0';
// Realtime stays on: rooms need it (the solo game does not).
const EXCLUDED_SERVICES =
  'studio,imgproxy,vector,logflare,edge-runtime,supavisor,mailpit,postgres-meta';
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
const controlPort = Number(env['CDN_CONTROL_PORT'] ?? 4323);

const logFd = (() => {
  const file = env['BR_SERVICES_LOG'];
  if (!file) return null;
  mkdirSync(dirname(file), { recursive: true });
  return openSync(file, 'w');
})();

/** Copies complete lines to BR_SERVICES_LOG, each with a timestamp. */
function sink(text: string): void {
  if (logFd === null) return;
  const at = new Date().toISOString();
  const lines = text.split('\n').filter((l) => l.length > 0);
  writeSync(logFd, lines.map((l) => `${at} ${l}\n`).join(''));
}

function log(msg: string): void {
  process.stdout.write(`[solo] ${msg}\n`);
  sink(`[solo] ${msg}`);
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

// Rooms need Realtime; the solo game works without it (e.g. a stack started with -x realtime).
const realtimeUp = await fetch(`${stack.API_URL}/realtime/v1/api/ping`, {
  headers: { apikey: stack.ANON_KEY },
  signal: AbortSignal.timeout(5_000),
})
  .then((r) => r.ok)
  .catch(() => false);
if (realtimeUp) {
  log('Realtime      up (rooms work)');
} else if (args.has('--realtime')) {
  process.stderr.write(
    `Realtime is not running, and rooms need it. Restart the stack without "realtime" in -x:\n` +
      `  npx -y ${SUPABASE_CLI} stop && npx -y ${SUPABASE_CLI} start -x ${EXCLUDED_SERVICES}\n`,
  );
  process.exit(1);
} else {
  log('Realtime      NOT running: solo works, rooms will not (start the stack with Realtime)');
}

const secret = env['CAPTURE_HMAC_SECRET'] ?? randomBytes(32).toString('hex');
// CDN_LAYOUT=esm.sh: the mock answers like the public esm.sh (entry modules, T-035).
const cdn = await startMockCdn({
  port: cdnPort,
  host: 'localhost',
  layout: parseLayout(env['CDN_LAYOUT']),
});
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
const control = await startOutageControl(cdn, controlPort);
log(`mock CDN      ${cdn.url}  (outages: POST ${control.url}/cdn-outage?mode=…)`);

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
    // Own process group: a Ctrl+C or a stop signal reaches this script only, and stop()
    // forwards exactly one SIGTERM (a second one would force the worker to quit at once).
    detached: true,
  });
  const prefix = (chunk: Buffer) =>
    chunk
      .toString()
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => `[${name}] ${l}\n`)
      .join('');
  child.stdout.on('data', (c: Buffer) => {
    const text = prefix(c);
    process.stdout.write(text);
    sink(text);
  });
  child.stderr.on('data', (c: Buffer) => {
    const text = prefix(c);
    process.stderr.write(text);
    sink(text);
  });
  child.on('exit', (code, signal) => {
    log(`${name} exited (${String(code ?? signal)})`);
    if (!stopping) void stop(1);
  });
  children.push(child);
  return child;
}

// The binaries themselves rather than `pnpm …`, which does not pass SIGTERM on: a stop must
// reach the capture worker (it hands its in-flight job back) and Next.
const captureDir = fileURLToPath(new URL('../../capture-worker/', import.meta.url));
run(
  'capture',
  `${captureDir}node_modules/.bin/tsx`,
  ['src/main.ts'],
  {
    SUPABASE_URL: stack.API_URL,
    SUPABASE_SERVICE_ROLE_KEY: stack.SERVICE_ROLE_KEY,
    CAPTURE_SHELL_URL: shell.captureUrl,
    CAPTURE_HMAC_SECRET: secret,
    PKG_CDN_URL: cdn.url,
    // Pick up new jobs quickly while someone is playing.
    WORKER_IDLE_MAX_MS: env['WORKER_IDLE_MAX_MS'] ?? '2000',
  },
  captureDir,
);

if (args.has('--next')) {
  run(
    'next',
    `${webDir}node_modules/.bin/next`,
    ['dev', '-p', String(appPort)],
    {
      NEXT_TELEMETRY_DISABLED: '1',
      NEXT_PUBLIC_SUPABASE_URL: env.NEXT_PUBLIC_SUPABASE_URL ?? stack.API_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? stack.ANON_KEY,
      NEXT_PUBLIC_SANDBOX_SHELL_URL: shell.shellUrl,
      NEXT_PUBLIC_PKG_CDN_URL: cdn.url,
    },
    webDir,
  );
  log(`app           http://localhost:${String(appPort)}/play (solo)`);
  log(`              http://localhost:${String(appPort)}/ (Create room, then open the link in a`);
  log(`              second browser window, e.g. a private one: each window is another player)`);
}

async function stop(code: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  const exited = children
    .filter((c) => c.exitCode === null && c.signalCode === null)
    .map((c) => new Promise((resolve) => c.once('exit', resolve)));
  // tsx and next relay the signal to their own child process.
  for (const c of children) c.kill('SIGTERM');
  // The capture worker finishes (or hands back) its current job first; cap the wait.
  await Promise.race([Promise.all(exited), new Promise((r) => setTimeout(r, 35_000))]);
  await Promise.all([shell.close(), cdn.close(), control.close()]);
  process.exit(code);
}
process.on('SIGINT', () => void stop(0));
process.on('SIGTERM', () => void stop(0));
