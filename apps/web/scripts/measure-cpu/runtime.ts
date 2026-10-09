/**
 * The local Cloudflare runtime the CPU measurement (T-033; since T-038 for the link-preview
 * Function) drives, and how one request is measured on it: `wrangler pages dev` (the static
 * site and its Function) or `wrangler dev` (a plain Worker: the calibration Worker), both
 * workerd, the runtime Cloudflare runs.
 *
 * Per request: the user isolate's CPU from a V8 CPU profile (DevTools `Profiler`, through
 * wrangler's inspector proxy) and the workerd main thread's CPU from
 * `/proc/<pid>/task/<pid>/schedstat` (nanoseconds; every isolate of the local runtime runs on
 * that thread, so it also counts the local asset and routing workers).
 *
 * A measurement waits until the server is quiet again ("settled"), so work after the response
 * (`waitUntil`) is counted too: on Workers it is part of the same invocation's CPU.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, readFileSync, readdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { isolateCpu, type CpuProfile, type IsolateCpu } from './profile';

export interface RequestSpec {
  path: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: BodyInit;
}

export interface Measurement {
  status: number;
  /** The `cf-cache-status` / `x-cache` header, if any (a Function may set one), or ''. */
  cache: string;
  /** T-038's `x-br-preview` header (which case the link-preview Function took), or ''. */
  preview: string;
  location: string;
  bytes: number;
  /** Request sent → body read, milliseconds (includes waiting on Supabase). */
  wallMs: number;
  /** The user isolate's CPU from the profile (null when not profiled). */
  isolate: IsolateCpu | null;
  /** The raw V8 profile (null when not profiled): `--profiles` saves it as a .cpuprofile. */
  profile: CpuProfile | null;
  /** workerd main thread CPU. */
  threadMs: number;
}

const webDir = fileURLToPath(new URL('../../', import.meta.url));
const quietMs = 80;
const settleTimeoutMs = 5_000;

/** The request's headers; `origin: self` becomes the server's own origin. */
function headersFor(spec: RequestSpec, origin: string): Record<string, string> {
  const h = { ...spec.headers };
  if (h['origin'] === 'self') h['origin'] = origin;
  return h;
}

async function readBody(res: Response): Promise<number> {
  return (await res.arrayBuffer()).byteLength;
}

function header(res: Response, name: string): string {
  return res.headers.get(name) ?? '';
}

/** Kills a detached child's whole process group. */
function killGroup(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // already gone
  }
}

async function waitForExit(child: ChildProcess, ms: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([new Promise((r) => child.once('exit', r)), sleep(ms)]);
}

/** Every process below `pid` (from /proc). */
function descendants(pid: number): number[] {
  const parent = new Map<number, number>();
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = readFileSync(`/proc/${d}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      parent.set(Number(d), ppid);
    } catch {
      // exited meanwhile
    }
  }
  const out: number[] = [];
  const walk = (p: number) => {
    for (const [child, pp] of parent) {
      if (pp === p) {
        out.push(child);
        walk(child);
      }
    }
  };
  walk(pid);
  return out;
}

function cmdline(pid: number): string {
  try {
    return readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8').replaceAll('\0', ' ');
  } catch {
    return '';
  }
}

/**
 * The runtime process went away under a measurement: `wrangler dev` restarted workerd (it
 * rebuilds when a file of the bundle's graph changes, package.json files included). The
 * caller restarts the runtime and measures the sample again.
 */
export class RuntimeReloaded extends Error {}

/** CPU time of one thread so far, milliseconds (ns resolution). */
export function threadCpuMs(pid: number, tid = pid): number {
  let text: string;
  try {
    text = readFileSync(`/proc/${String(pid)}/task/${String(tid)}/schedstat`, 'utf8');
  } catch {
    throw new RuntimeReloaded(`process ${String(pid)} is gone`);
  }
  return Number(text.split(' ')[0]) / 1e6;
}

/**
 * Waits until `read()` stops growing: less than `noiseMs` + 0.1 ms per 20 ms tick for
 * `quietMs`. `noiseMs` is the thread's own idle rate (a running CPU profiler signals the
 * thread every sampling interval, even when no JavaScript runs).
 */
async function settle(read: () => number, noiseMs = 0): Promise<number> {
  const start = Date.now();
  let last = read();
  let quietSince = Date.now();
  while (Date.now() - start < settleTimeoutMs) {
    await sleep(20);
    const now = read();
    if (now - last > noiseMs + 0.1) quietSince = Date.now();
    last = now;
    if (Date.now() - quietSince >= quietMs) break;
  }
  return last;
}

/** The thread's CPU per 20 ms while idle (measured over 200 ms). */
async function idleRate(read: () => number): Promise<number> {
  const a = read();
  await sleep(200);
  return ((read() - a) / 200) * 20;
}

interface DevtoolsMessage {
  id?: number;
  result?: unknown;
  error?: { message: string };
}

/** One DevTools connection to the Worker (through wrangler's inspector proxy). */
class Inspector {
  private nextId = 1;
  private readonly pending = new Map<number, (m: DevtoolsMessage) => void>();

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener('message', (e: MessageEvent) => {
      const msg = JSON.parse(String(e.data)) as DevtoolsMessage;
      if (msg.id === undefined) return;
      const done = this.pending.get(msg.id);
      if (done) {
        this.pending.delete(msg.id);
        done(msg);
      }
    });
  }

  static async connect(url: string): Promise<Inspector> {
    // Node's WebSocket (undici) accepts headers; the proxy wants a localhost Origin.
    const ws = new WebSocket(url, { headers: { origin: 'http://localhost' } } as never);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => {
        resolve();
      });
      ws.addEventListener('error', () => {
        reject(new Error(`inspector connection to ${url} failed`));
      });
    });
    return new Inspector(ws);
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++;
    const reply = new Promise<DevtoolsMessage>((resolve) => this.pending.set(id, resolve));
    this.ws.send(JSON.stringify({ id, method, params }));
    const msg = await Promise.race([
      reply,
      sleep(30_000).then(() => {
        throw new Error(`inspector: no answer to ${method}`);
      }),
    ]);
    if (msg.error) throw new Error(`inspector ${method}: ${msg.error.message}`);
    return msg.result;
  }

  close(): void {
    this.ws.close();
  }
}

export interface WorkersOptions {
  port: number;
  inspectorPort: number;
  /** Profiler sampling interval, microseconds. */
  samplingUs: number;
  logFile: string;
  /**
   * `pages`: `wrangler pages dev` on the app (apps/web/wrangler.jsonc: `out/`, with T-038's
   * link-preview Function `out/_worker.js` on `/battles/*`; every other path goes straight to
   * the asset server), or on `dir`. `worker`: `wrangler dev` on `config`.
   */
  kind: 'pages' | 'worker';
  /** The Worker's wrangler config (kind `worker`, e.g. the calibration Worker). */
  config?: string;
  /** Kind `pages`: serve this directory instead of `out/` (scripts/preview-variant.ts). */
  dir?: string;
}

/**
 * `wrangler pages dev` / `wrangler dev`. One start = one fresh isolate: workerd evaluates the
 * Worker's global scope at startup, before the first request (as Cloudflare does).
 */
export class WorkersRuntime {
  readonly origin: string;
  private child: ChildProcess | null = null;
  private runtimePid = 0;
  private inspector: Inspector | null = null;
  /** CPU of the workerd main thread while it started (global scope + the local runtime). */
  startupThreadMs = 0;

  constructor(private readonly opts: WorkersOptions) {
    this.origin = `http://127.0.0.1:${String(opts.port)}`;
  }

  async start(): Promise<void> {
    const log = createWriteStream(this.opts.logFile, { flags: 'a' });
    const child = spawn(
      process.execPath,
      [
        'node_modules/wrangler/bin/wrangler.js',
        ...(this.opts.kind === 'pages'
          ? ['pages', 'dev', ...(this.opts.dir ? [this.opts.dir] : [])]
          : ['dev']),
        '--port',
        String(this.opts.port),
        '--ip',
        '127.0.0.1',
        '--inspector-port',
        String(this.opts.inspectorPort),
        '--show-interactive-dev-session=false',
        ...(this.opts.config ? ['--config', this.opts.config] : []),
      ],
      {
        cwd: webDir,
        env: {
          ...process.env,
          WRANGLER_SEND_METRICS: 'false',
          WRANGLER_CI_DISABLE_CONFIG_WATCHING: 'true',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      },
    );
    this.child = child;
    const state = { ready: false };
    const onData = (c: Buffer) => {
      log.write(c);
      if (c.toString().includes('Ready on')) state.ready = true;
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const deadline = Date.now() + 90_000;
    while (!state.ready) {
      if (child.exitCode !== null)
        throw new Error(`wrangler dev exited (see ${this.opts.logFile})`);
      if (Date.now() > deadline)
        throw new Error(`wrangler dev not ready (see ${this.opts.logFile})`);
      await sleep(50);
    }
    // The runtime is the workerd process with the inspector (the other one is wrangler's proxy).
    const pid = child.pid ?? 0;
    for (;;) {
      const found = descendants(pid).find((p) => {
        const cmd = cmdline(p);
        return cmd.includes('workerd') && cmd.includes('--inspector-addr');
      });
      if (found) {
        this.runtimePid = found;
        break;
      }
      if (Date.now() > deadline) throw new Error('workerd runtime process not found');
      await sleep(50);
    }
    this.startupThreadMs = threadCpuMs(this.runtimePid);
    this.inspector = await Inspector.connect(
      `ws://127.0.0.1:${String(this.opts.inspectorPort)}/ws`,
    );
    await this.inspector.send('Profiler.enable');
    await this.inspector.send('Profiler.setSamplingInterval', { interval: this.opts.samplingUs });
  }

  async stop(): Promise<void> {
    this.inspector?.close();
    this.inspector = null;
    const child = this.child;
    this.child = null;
    if (!child) return;
    killGroup(child);
    await waitForExit(child, 5_000);
    killGroup(child, 'SIGKILL');
    // workerd children of the group are gone with it; give the ports a moment.
    await sleep(200);
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  /** Sends one request and measures it (see the top of this file). */
  async measure(spec: RequestSpec, profile: boolean, holdMs = 0): Promise<Measurement> {
    const inspector = this.inspector;
    if (!inspector) throw new Error('runtime not started');
    const pid = this.runtimePid;
    let noise = 0;
    if (profile) {
      await inspector.send('Profiler.start');
      noise = await idleRate(() => threadCpuMs(pid));
    }
    const before = threadCpuMs(pid);
    const t0 = performance.now();
    const res = await fetch(this.origin + spec.path, {
      method: spec.method ?? 'GET',
      headers: headersFor(spec, this.origin),
      body: spec.body ?? null,
      redirect: 'manual',
    });
    const bytes = await readBody(res);
    const wallMs = performance.now() - t0;
    if (holdMs > 0) await sleep(holdMs);
    const after = await settle(() => threadCpuMs(pid), noise);
    let isolate: IsolateCpu | null = null;
    let raw: CpuProfile | null = null;
    if (profile) {
      const result = (await inspector.send('Profiler.stop')) as { profile: CpuProfile };
      raw = result.profile;
      isolate = isolateCpu(raw, this.opts.samplingUs);
    }
    return {
      status: res.status,
      cache: header(res, 'cf-cache-status') || header(res, 'x-cache'),
      preview: header(res, 'x-br-preview'),
      location: header(res, 'location'),
      bytes,
      wallMs,
      isolate,
      profile: raw,
      threadMs: after - before,
    };
  }

  /** An unmeasured request (priming a cache, reading a page). */
  async request(spec: RequestSpec): Promise<{ status: number; cache: string; text: string }> {
    const res = await fetch(this.origin + spec.path, {
      method: spec.method ?? 'GET',
      headers: headersFor(spec, this.origin),
      body: spec.body ?? null,
      redirect: 'manual',
    });
    const text = await res.text();
    await settle(() => threadCpuMs(this.runtimePid));
    return {
      status: res.status,
      cache: header(res, 'cf-cache-status') || header(res, 'x-cache'),
      text,
    };
  }
}
