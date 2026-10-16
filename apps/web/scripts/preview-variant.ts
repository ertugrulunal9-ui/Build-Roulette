/**
 * The link-preview Worker (T-038) against a Supabase that is slow or down, for the CPU
 * measurement (scripts/measure-cpu) and the outage e2e (e2e/link-preview.spec.ts).
 *
 * The Worker's Supabase URL is baked in at build time (scripts/preview-worker.ts), so an
 * outage is simulated with a **variant** of the built site: a small Worker directory
 * (T-043) with `assets/` (the battle shell and the host files of `out/`: `_headers`,
 * `_redirects`, `404.html`, `og-card.png`), `worker.js` (the same Worker bundled with one
 * change, `NEXT_PUBLIC_SUPABASE_URL` pointing at a {@link MockSupabase} that hangs, refuses
 * connections or answers 503) and a `wrangler.json` routed like apps/web/wrangler.jsonc.
 * Nothing in the production build can be redirected at run time.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { bundlePreviewWorker, siteWranglerConfig } from './preview-worker';

const webDir = fileURLToPath(new URL('../', import.meta.url));
const outDir = join(webDir, 'out');

/** The headers of the `/*` rule of a `_headers` file (src/lib/hosting/pages-config.ts writes it). */
export function everyPathHeaders(headersFile: string): Record<string, string> {
  const headers: Record<string, string> = {};
  let inRule = false;
  for (const line of headersFile.split('\n')) {
    if (!line.startsWith(' ')) {
      inRule = line.trim() === '/*';
      continue;
    }
    const m = /^\s+([^:]+):\s*(.*)$/.exec(line);
    if (inRule && m?.[1] && m[2] !== undefined) headers[m[1]] = m[2];
  }
  return headers;
}

/** The variant's wrangler config, in the directory `writePreviewVariant` wrote. */
export const variantConfig = (dir: string): string => join(dir, 'wrangler.json');

/**
 * Writes the variant site to `dir` (replacing it): the build's shell and host files as its
 * assets, the Worker bundled against `supabaseUrl` (everything else as the build had it), and
 * its wrangler config ({@link variantConfig}).
 */
export async function writePreviewVariant(dir: string, supabaseUrl: string): Promise<void> {
  rmSync(dir, { recursive: true, force: true });
  const assets = join(dir, 'assets');
  mkdirSync(assets, { recursive: true });
  for (const f of ['battles.html', '404.html', 'og-card.png', '_headers', '_redirects']) {
    copyFileSync(join(outDir, f), join(assets, f));
  }
  const worker = await bundlePreviewWorker({
    env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: supabaseUrl },
    headers: everyPathHeaders(readFileSync(join(outDir, '_headers'), 'utf8')),
  });
  writeFileSync(join(dir, 'worker.js'), worker);
  writeFileSync(
    variantConfig(dir),
    `${JSON.stringify(siteWranglerConfig({ name: 'build-roulette-web-variant', main: './worker.js', assets: './assets' }), null, 2)}\n`,
  );
}

export type SupabaseOutage = 'hang' | 'refuse' | 'error';

/**
 * A stand-in for Supabase's API that is down: `hang` accepts and never answers (slow),
 * `refuse` stops listening (connection refused), `error` answers every request with a 503.
 */
export class MockSupabase {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  port = 0;
  mode: SupabaseOutage = 'hang';

  get url(): string {
    return `http://127.0.0.1:${String(this.port)}`;
  }

  async start(): Promise<void> {
    await this.listen();
  }

  private async listen(): Promise<void> {
    const server = createServer((_req, res) => {
      if (this.mode === 'error') {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end('{"message":"upstream unavailable"}');
      }
      // `hang`: no answer until the client gives up.
    });
    server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    await new Promise<void>((resolve) => server.listen(this.port, '127.0.0.1', resolve));
    this.port = (server.address() as AddressInfo).port;
    this.server = server;
  }

  private async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }

  async setMode(mode: SupabaseOutage): Promise<void> {
    this.mode = mode;
    if (mode === 'refuse') await this.close();
    else if (!this.server) await this.listen();
  }

  async stop(): Promise<void> {
    await this.close();
  }
}

/** `wrangler dev` on the variant in `dir` (its wrangler.json) on a port, until `stop()`. */
export async function startWorkerDev(
  dir: string,
  port: number,
): Promise<{ origin: string; stop: () => Promise<void> }> {
  const child: ChildProcess = spawn(
    process.execPath,
    [
      join(webDir, 'node_modules/wrangler/bin/wrangler.js'),
      'dev',
      '--config',
      variantConfig(dir),
      '--port',
      String(port),
      '--ip',
      '127.0.0.1',
      '--show-interactive-dev-session=false',
      '--log-level',
      'warn',
    ],
    {
      cwd: webDir,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    },
  );
  let output = '';
  child.stdout?.on('data', (c: Buffer) => (output += c.toString()));
  child.stderr?.on('data', (c: Buffer) => (output += c.toString()));
  const origin = `http://127.0.0.1:${String(port)}`;
  const stop = async () => {
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        // already gone
      }
    }
    await Promise.race([new Promise((r) => child.once('exit', r)), sleep(5_000)]);
  };
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited:\n${output}`);
    try {
      const res = await fetch(`${origin}/og-card.png`);
      await res.arrayBuffer();
      if (res.ok) return { origin, stop };
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`wrangler dev not ready:\n${output}`);
    }
    await sleep(250);
  }
}
