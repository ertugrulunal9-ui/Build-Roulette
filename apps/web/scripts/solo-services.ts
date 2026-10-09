/**
 * Everything the solo game and the rooms need locally, in one process:
 *
 *   local Supabase stack     http://127.0.0.1:54321   (`supabase start` WITH Realtime and the
 *                                                      Edge Runtime; checked or started)
 *   mock package CDN         http://localhost:4322
 *   sandbox shell            http://127.0.0.1:4321/v1/          (preview, a different site)
 *     + capture page         http://127.0.0.1:4321/v1/capture   (HMAC gate, same shell)
 *   jobs (capture, destroy, takedown), as in production (T-034):
 *     the `jobs` Edge Function   `supabase functions serve` (supabase/functions/jobs)
 *     started by pg_cron         every 2 s through pg_net (`e2e-jobs-run`, the production
 *                                schedule `br-jobs-run` is every minute), with the URL and
 *                                the cron secret in Vault, as in production
 *     Browser Rendering          a local stand-in on Playwright Chromium, port 4325
 *                                (@br/capture-worker src/stand-in.ts)
 *   or, with --worker: the self-hosted capture worker (Playwright Chromium, polling the queue)
 *   Next.js                  http://localhost:3000   (only with --next: `next dev`)
 *
 *   pnpm --filter @br/web dev:solo          # all of the above, starting the stack if needed
 *   pnpm --filter @br/web dev:multi         # the same, and Realtime must be up (rooms)
 *   tsx scripts/solo-services.ts            # without Next (the e2e suites start `wrangler pages dev`)
 *
 * Flags: --next (run `next dev`), --start-stack (run `supabase start` when the stack is not
 * up; needs Docker), --realtime (fail when the stack runs without Realtime, which rooms need:
 * private channels, broadcasts from the database, Presence), --worker (jobs by the Node
 * capture worker instead of the Edge Function; also BR_JOBS=worker). Env: BR_APP_ORIGINS
 * (default http://localhost:3000), SHELL_PORT (4321), CDN_PORT (4322), CDN_CONTROL_PORT
 * (4323: `POST /cdn-outage?mode=refuse|error|hang|off` simulates a package CDN outage, T-032
 * e2e), STAND_IN_PORT (4325), APP_PORT (3000, with --next), CAPTURE_HMAC_SECRET (default:
 * random per run), SUPABASE_INTERNAL_IMAGE_REGISTRY (passed to `supabase start`), and the
 * stack's API_URL / ANON_KEY / SERVICE_ROLE_KEY / DB_URL (default: `supabase status -o
 * env`), and BR_SERVICES_LOG (a file that also gets every line, each prefixed with an ISO
 * timestamp: the rooms e2e attach the lines of a failed test's time window, see
 * e2e/diagnostics.ts).
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPTURE_PATH } from '@br/sandbox-shell/capture-gate';
import { startShellServer, type ShellServer } from '@br/sandbox-shell/server';
// The mock CDN lives in @br/runtime's test support (imported by path, like dev:sandbox).
import {
  parseLayout,
  startMockCdn,
  startOutageControl,
} from '../../../packages/runtime/test-support/mock-cdn';
// The Browser Rendering stand-in (imported by path, like the mock CDN).
import { createLogger } from '../../capture-worker/src/log';
import { startBrowserRenderingStandIn } from '../../capture-worker/src/stand-in';

const SUPABASE_CLI = 'supabase@2.119.0';
// Realtime stays on (rooms need it, the solo game does not), and so does the Edge Runtime
// (the jobs function).
const EXCLUDED_SERVICES = 'studio,imgproxy,vector,logflare,supavisor,mailpit,postgres-meta';
/** Named after `project_id` in supabase/config.toml. */
const EDGE_RUNTIME_CONTAINER = 'supabase_edge_runtime_build-roulette';
/** A local schedule next to the production one (not `br-…`: the pgTAP schedule check). */
const E2E_CRON_JOB = 'e2e-jobs-run';
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const webDir = fileURLToPath(new URL('../', import.meta.url));

const args = new Set(process.argv.slice(2));
const env = process.env;
const useWorker = args.has('--worker') || env['BR_JOBS'] === 'worker';
const appPort = Number(env['APP_PORT'] ?? 3000);
const appOrigins = (env['BR_APP_ORIGINS'] ?? `http://localhost:${String(appPort)}`)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const shellPort = Number(env['SHELL_PORT'] ?? 4321);
const cdnPort = Number(env['CDN_PORT'] ?? 4322);
const controlPort = Number(env['CDN_CONTROL_PORT'] ?? 4323);
const standInPort = Number(env['STAND_IN_PORT'] ?? 4325);

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
  DB_URL: string;
}

function readStackEnv(): StackEnv | null {
  const fromEnv = {
    API_URL: env['API_URL'],
    ANON_KEY: env['ANON_KEY'],
    SERVICE_ROLE_KEY: env['SERVICE_ROLE_KEY'],
    DB_URL: env['DB_URL'],
  };
  if (fromEnv.API_URL && fromEnv.ANON_KEY && fromEnv.SERVICE_ROLE_KEY && fromEnv.DB_URL) {
    return fromEnv as StackEnv;
  }
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
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY, DB_URL } = found;
  return API_URL && ANON_KEY && SERVICE_ROLE_KEY && DB_URL
    ? { API_URL, ANON_KEY, SERVICE_ROLE_KEY, DB_URL }
    : null;
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
const stackEnv = stack;
log(`Supabase      ${stackEnv.API_URL}`);

// Rooms need Realtime; the solo game works without it (e.g. a stack started with -x realtime).
const realtimeUp = await fetch(`${stackEnv.API_URL}/realtime/v1/api/ping`, {
  headers: { apikey: stackEnv.ANON_KEY },
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

/** SQL as the superuser (Vault, pg_cron). */
function sql(query: string): void {
  execFileSync('psql', [stackEnv.DB_URL, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-c', query], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

const secret = env['CAPTURE_HMAC_SECRET'] ?? randomBytes(32).toString('hex');
// CDN_LAYOUT=esm.sh: the mock answers like the public esm.sh (entry modules, T-035).
const cdn = await startMockCdn({
  port: cdnPort,
  host: 'localhost',
  layout: parseLayout(env['CDN_LAYOUT']),
});
const control = await startOutageControl(cdn, controlPort);
log(`mock CDN      ${cdn.url}  (outages: POST ${control.url}/cdn-outage?mode=…)`);
const captureUrl = `http://127.0.0.1:${String(shellPort)}${CAPTURE_PATH}`;

const children: ChildProcess[] = [];
let stopping = false;
const cleanups: (() => Promise<void> | void)[] = [];
let shell: ShellServer | null = null;

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

if (useWorker) {
  // The binaries themselves rather than `pnpm …`, which does not pass SIGTERM on: a stop
  // must reach the capture worker (it hands its in-flight job back) and Next.
  const captureDir = fileURLToPath(new URL('../../capture-worker/', import.meta.url));
  run(
    'capture',
    `${captureDir}node_modules/.bin/tsx`,
    ['src/main.ts'],
    {
      SUPABASE_URL: stackEnv.API_URL,
      SUPABASE_SERVICE_ROLE_KEY: stackEnv.SERVICE_ROLE_KEY,
      CAPTURE_SHELL_URL: captureUrl,
      CAPTURE_HMAC_SECRET: secret,
      PKG_CDN_URL: cdn.url,
      // Pick up new jobs quickly while someone is playing.
      WORKER_IDLE_MAX_MS: env['WORKER_IDLE_MAX_MS'] ?? '2000',
    },
    captureDir,
  );
  log('jobs          the self-hosted capture worker (--worker)');
} else {
  await startJobsFunction();
}

/**
 * The production path, locally: the `jobs` Edge Function, Browser Rendering's stand-in, and
 * pg_cron + pg_net + Vault calling the function (every 2 s here, every minute in production).
 */
async function startJobsFunction(): Promise<void> {
  const token = randomBytes(16).toString('hex');
  const cronSecret = randomBytes(32).toString('hex');
  const standIn = await startBrowserRenderingStandIn({
    accountId: 'e2e',
    apiToken: token,
    port: standInPort,
    log: createLogger({
      write: (line) => {
        process.stdout.write(`[stand-in] ${line}\n`);
        sink(`[stand-in] ${line}`);
      },
    }),
  });
  cleanups.push(() => standIn.close());
  log(`Browser Rendering stand-in ${standIn.url}`);

  const dir = mkdtempSync(join(tmpdir(), 'br-jobs-e2e-'));
  const envFile = join(dir, 'jobs.env');
  writeFileSync(
    envFile,
    Object.entries({
      JOBS_CRON_SECRET: cronSecret,
      CAPTURE_SHELL_URL: captureUrl,
      CAPTURE_HMAC_SECRET: secret,
      PKG_CDN_URL: cdn.url,
      BROWSER_RENDERING_ACCOUNT_ID: 'e2e',
      BROWSER_RENDERING_API_TOKEN: token,
      // The function runs in Docker; the stand-in and the browser run on this machine.
      BROWSER_RENDERING_API_URL: standIn.urlFor('host.docker.internal'),
      JOBS_PUBLIC_SUPABASE_URL: stackEnv.API_URL,
      BROWSER_RENDERING_MIN_INTERVAL_MS: '0',
    })
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
  );
  const serve = run(
    'jobs',
    'npx',
    ['-y', SUPABASE_CLI, 'functions', 'serve', '--env-file', envFile],
    {},
    repoRoot,
  );
  cleanups.push(() => {
    // The whole group (npx and the CLI below it), then the runtime container if it is left.
    if (serve.pid !== undefined && serve.exitCode === null) {
      try {
        process.kill(-serve.pid, 'SIGTERM');
      } catch {
        // gone
      }
    }
    try {
      execFileSync('docker', ['rm', '-f', EDGE_RUNTIME_CONTAINER], { stdio: 'ignore' });
    } catch {
      // not running
    }
    rmSync(dir, { recursive: true, force: true });
  });

  // Ready when the function itself answers (401: no secret).
  const url = `${stackEnv.API_URL}/functions/v1/jobs`;
  const deadline = Date.now() + 120_000;
  for (;;) {
    const ok = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(5_000) })
      .then(async (r) => r.status === 401 && (await r.text()).includes('unauthorized'))
      .catch(() => false);
    if (ok) break;
    if (Date.now() > deadline || serve.exitCode !== null) {
      process.stderr.write('The jobs Edge Function did not start (see [jobs] above).\n');
      await stop(1);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  // pg_cron → pg_net → the function, with the function URL (as the database sees Kong) and
  // the cron secret in Vault. Undone at stop().
  sql(`delete from vault.secrets where name in ('br_jobs_function_url', 'br_jobs_cron_secret');
       select vault.create_secret('http://kong:8000/functions/v1/jobs', 'br_jobs_function_url');
       select vault.create_secret('${cronSecret}', 'br_jobs_cron_secret');
       select cron.schedule('${E2E_CRON_JOB}', '2 seconds', 'select private.run_jobs_function()');`);
  cleanups.unshift(() => {
    sql(`select cron.unschedule(jobid) from cron.job where jobname = '${E2E_CRON_JOB}';
         delete from vault.secrets where name in ('br_jobs_function_url', 'br_jobs_cron_secret');`);
  });
  log(`jobs          the Edge Function ${url}, started by pg_cron every 2 s`);
}

// The shell last: its URL is what the e2e configs wait for, so everything is up by then.
shell = await startShellServer({
  port: shellPort,
  host: '127.0.0.1',
  appOrigins,
  cdnOrigin: cdn.url,
  // The capture page fetches the bundle from Storage (signed URLs).
  extraConnectSrc: [new URL(stackEnv.API_URL).origin],
  captureSecret: secret,
});
if (shell.captureUrl !== captureUrl) throw new Error(`capture URL is ${shell.captureUrl}`);
log(`sandbox shell ${shell.shellUrl}  (allows ${appOrigins.join(', ')})`);
log(`capture page  ${shell.captureUrl}`);

if (args.has('--next')) {
  run(
    'next',
    `${webDir}node_modules/.bin/next`,
    ['dev', '-p', String(appPort)],
    {
      NEXT_TELEMETRY_DISABLED: '1',
      NEXT_PUBLIC_SUPABASE_URL: env.NEXT_PUBLIC_SUPABASE_URL ?? stackEnv.API_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? stackEnv.ANON_KEY,
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
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (e) {
      log(`cleanup failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const exited = children
    .filter((c) => c.exitCode === null && c.signalCode === null)
    .map((c) => new Promise((resolve) => c.once('exit', resolve)));
  // tsx and next relay the signal to their own child process.
  for (const c of children) c.kill('SIGTERM');
  // The capture worker finishes (or hands back) its current job first; cap the wait.
  await Promise.race([Promise.all(exited), new Promise((r) => setTimeout(r, 35_000))]);
  await Promise.all([shell?.close(), cdn.close(), control.close()]);
  process.exit(code);
}
process.on('SIGINT', () => void stop(0));
process.on('SIGTERM', () => void stop(0));
