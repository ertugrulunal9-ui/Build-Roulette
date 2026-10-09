/**
 * The link-preview Function (T-038) against a Supabase that is slow or down, for the CPU
 * measurement (scripts/measure-cpu) and the outage e2e (e2e/link-preview.spec.ts).
 *
 * The Function's Supabase URL is baked in at build time (scripts/preview-worker.ts), so an
 * outage is simulated with a **variant** of the built site: a small Pages directory with the
 * battle shell, the host files of `out/` (`_headers`, `_redirects`, `_routes.json`, `404.html`,
 * `og-card.png`) and the same Function bundled with one change, `NEXT_PUBLIC_SUPABASE_URL`
 * pointing at a {@link MockSupabase} that hangs, refuses connections or answers 503. Nothing
 * in the production build can be redirected at run time.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { bundlePreviewWorker, previewRoutesJson } from './preview-worker';

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

/**
 * Writes the variant site to `dir` (replacing it): the build's shell and host files, and the
 * Function bundled against `supabaseUrl` (everything else as the build had it).
 */
export async function writePreviewVariant(dir: string, supabaseUrl: string): Promise<void> {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const f of ['battles.html', '404.html', 'og-card.png', '_headers', '_redirects']) {
    copyFileSync(join(outDir, f), join(dir, f));
  }
  const worker = await bundlePreviewWorker({
    env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: supabaseUrl },
    headers: everyPathHeaders(readFileSync(join(outDir, '_headers'), 'utf8')),
  });
  writeFileSync(join(dir, '_worker.js'), worker);
  writeFileSync(join(dir, '_routes.json'), previewRoutesJson());
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

/** `wrangler pages dev <dir>` on a port, until `stop()`. */
export async function startPagesDev(
  dir: string,
  port: number,
): Promise<{ origin: string; stop: () => Promise<void> }> {
  const child: ChildProcess = spawn(
    process.execPath,
    [
      join(webDir, 'node_modules/wrangler/bin/wrangler.js'),
      'pages',
      'dev',
      dir,
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
    if (child.exitCode !== null) throw new Error(`wrangler pages dev exited:\n${output}`);
    try {
      const res = await fetch(`${origin}/og-card.png`);
      await res.arrayBuffer();
      if (res.ok) return { origin, stop };
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`wrangler pages dev not ready:\n${output}`);
    }
    await sleep(250);
  }
}
