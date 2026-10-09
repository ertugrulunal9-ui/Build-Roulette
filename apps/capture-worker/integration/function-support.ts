/**
 * The `jobs` Edge Function in the local Edge Runtime, for the function integration tests
 * (T-034): `supabase functions serve` with an env file, started and stopped from the test.
 * The stack must run with the Edge Runtime (`supabase start` without `edge-runtime` in -x).
 *
 * The function runs in Docker: it reaches Supabase as http://kong:8000 (set by the CLI), the
 * Browser Rendering stand-in on this machine as http://host.docker.internal:<port>, and hands
 * the browser (the stand-in's Chromium, on this machine) Storage URLs on the stack's public
 * API URL (JOBS_PUBLIC_SUPABASE_URL).
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
export const SUPABASE_CLI = 'supabase@2.119.0';
export const CRON_SECRET_HEADER = 'x-br-cron-secret';
/** Named after `project_id` in supabase/config.toml. */
const EDGE_RUNTIME_CONTAINER = 'supabase_edge_runtime_build-roulette';

function edgeRuntimeRunning(): boolean {
  try {
    execFileSync('docker', ['inspect', EDGE_RUNTIME_CONTAINER], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export interface ServedFunction {
  url: string;
  /** POST with the secret. `wait`: inline run, returns the summary. */
  invoke(opts?: { wait?: boolean; secret?: string }): Promise<{ status: number; body: unknown }>;
  /** Kills `supabase functions serve` (and with it the Edge Runtime container). */
  stop(): Promise<void>;
  log(): string;
}

export async function serveFunction(opts: {
  apiUrl: string;
  env: Record<string, string>;
}): Promise<ServedFunction> {
  const dir = mkdtempSync(join(tmpdir(), 'br-jobs-fn-'));
  const envFile = join(dir, 'jobs.env');
  writeFileSync(
    envFile,
    Object.entries(opts.env)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
  );
  let out = '';
  // Own process group, so stop() reaches npx and the CLI below it.
  const child: ChildProcess = spawn(
    'npx',
    ['-y', SUPABASE_CLI, 'functions', 'serve', '--env-file', envFile],
    { cwd: REPO, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout?.on('data', (c: Buffer) => (out += c.toString()));
  child.stderr?.on('data', (c: Buffer) => (out += c.toString()));
  const url = `${opts.apiUrl}/functions/v1/jobs`;
  const secret = opts.env['JOBS_CRON_SECRET'] ?? '';

  const invoke: ServedFunction['invoke'] = async ({ wait = true, secret: s = secret } = {}) => {
    let res: Response | null = null;
    // A keep-alive connection Kong dropped after a restart: retry (a run is safe to repeat).
    for (let attempt = 0; !res; attempt++) {
      try {
        res = await fetch(`${url}${wait ? '?wait=1' : ''}`, {
          method: 'POST',
          headers: { [CRON_SECRET_HEADER]: s },
          signal: AbortSignal.timeout(170_000),
        });
      } catch (e) {
        if (attempt >= 2 || !(e instanceof TypeError)) throw e;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: res.status, body };
  };

  const stop = async () => {
    // First the runtime itself, at once (what a platform kill looks like to a run in flight),
    // then the CLI.
    try {
      execFileSync('docker', ['rm', '-f', EDGE_RUNTIME_CONTAINER], { stdio: 'ignore' });
    } catch {
      // not running
    }
    if (child.exitCode === null && child.pid !== undefined) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        // already gone
      }
      await Promise.race([exited, new Promise((r) => setTimeout(r, 20_000))]);
    }
    // npx can exit before the CLI has removed the container: wait until it is gone, so a
    // new serve never talks to the old runtime.
    for (let i = 0; i < 60 && edgeRuntimeRunning(); i++) {
      await new Promise((r) => setTimeout(r, 500));
    }
    rmSync(dir, { recursive: true, force: true });
  };

  // Ready when the CLI says so and the function itself answers (401 without the secret).
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`functions serve exited:\n${out}`);
    if (!out.includes('Serving functions on')) {
      if (Date.now() > deadline) {
        await stop();
        throw new Error(`functions serve did not start:\n${out}`);
      }
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    const status = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(5_000) })
      .then(async (r) => {
        const body = await r.text();
        return r.status === 401 && body.includes('unauthorized') ? 401 : r.status;
      })
      .catch(() => 0);
    if (status === 401) break;
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`the jobs function did not come up (last status ${String(status)}):\n${out}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { url, invoke, stop, log: () => out };
}
