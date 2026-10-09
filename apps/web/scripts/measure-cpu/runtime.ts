/**
 * The two servers the CPU measurement (T-033) drives, and how one request is measured on each.
 *
 * - **Workers**: the OpenNext build served by `wrangler dev` (workerd, like `cf:preview`).
 *   Per request: the app isolate's CPU from a V8 CPU profile (DevTools `Profiler`, through
 *   wrangler's inspector proxy) and the workerd main thread's CPU from
 *   `/proc/<pid>/task/<pid>/schedstat` (nanoseconds; every isolate of the local runtime runs
 *   on that thread, so it also counts the emulated R2/D1/Durable Object and routing workers).
 * - **Node**: `next start` with a preload (node-hook.cjs) that reads `process.threadCpuUsage()`
 *   around each request.
 *
 * A measurement waits until the server is quiet again ("settled"), so work after the response
 * (`waitUntil`/`after`, the ISR cache write, a background regeneration) is counted too: on
 * Workers it is part of the same invocation's CPU.
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
  /** x-opennext-cache / x-nextjs-cache (HIT, MISS, STALE), or ''. */
  cache: string;
  location: string;
  bytes: number;
  /** Request sent → body read, milliseconds (includes waiting on Supabase). */
  wallMs: number;
  /** Workers: the app isolate's CPU from the profile (null when not profiled). Node: null. */
  isolate: IsolateCpu | null;
  /** Workers: workerd main thread CPU. Node: the main thread's CPU (`threadCpuUsage`). */
  threadMs: number;
  /** Node only: CPU of the main thread until the response finished. */
  toFinishMs: number | null;
}

const webDir = fileURLToPath(new URL('../../', import.meta.url));
const quietMs = 80;
const settleTimeoutMs = 5_000;

/** The request's headers; `origin: self` becomes the server's own origin (server actions check it). */
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

/** CPU time of one thread so far, milliseconds (ns resolution). */
export function threadCpuMs(pid: number, tid = pid): number {
  const ns = readFileSync(`/proc/${String(pid)}/task/${String(tid)}/schedstat`, 'utf8').split(
    ' ',
  )[0];
  return Number(ns) / 1e6;
}

/** Waits until `read()` stops growing (less than 0.1 ms per `quietMs`). */
async function settle(read: () => number): Promise<number> {
  const start = Date.now();
  let last = read();
  let quietSince = Date.now();
  while (Date.now() - start < settleTimeoutMs) {
    await sleep(20);
    const now = read();
    if (now - last > 0.1) quietSince = Date.now();
    last = now;
    if (Date.now() - quietSince >= quietMs) break;
  }
  return last;
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
}

/**
 * `wrangler dev` on the OpenNext build. One start = one fresh isolate: workerd evaluates the
 * Worker's global scope at startup, before the first request (as Cloudflare does), and the
 * first request then initialises the Next server lazily (OpenNext's `import()` of the handler,
 * bundled as a lazy module initialiser).
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
        'dev',
        '--port',
        String(this.opts.port),
        '--ip',
        '127.0.0.1',
        '--inspector-port',
        String(this.opts.inspectorPort),
        '--show-interactive-dev-session=false',
      ],
      {
        cwd: webDir,
        env: { ...process.env, WRANGLER_SEND_METRICS: 'false', NEXT_TELEMETRY_DISABLED: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      },
    );
    this.child = child;
    let ready = false;
    const onData = (c: Buffer) => {
      log.write(c);
      if (c.toString().includes('Ready on')) ready = true;
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    const deadline = Date.now() + 90_000;
    while (!ready) {
      if (child.exitCode !== null) throw new Error(`wrangler dev exited (see ${this.opts.logFile})`);
      if (Date.now() > deadline) throw new Error(`wrangler dev not ready (see ${this.opts.logFile})`);
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
    this.inspector = await Inspector.connect(`ws://127.0.0.1:${String(this.opts.inspectorPort)}/ws`);
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
    if (profile) await inspector.send('Profiler.start');
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
    const after = await settle(() => threadCpuMs(pid));
    let isolate: IsolateCpu | null = null;
    if (profile) {
      const result = (await inspector.send('Profiler.stop')) as { profile: CpuProfile };
      isolate = isolateCpu(result.profile, this.opts.samplingUs);
    }
    return {
      status: res.status,
      cache: header(res, 'x-opennext-cache') || header(res, 'x-nextjs-cache'),
      location: header(res, 'location'),
      bytes,
      wallMs,
      isolate,
      threadMs: after - before,
      toFinishMs: null,
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
      cache: header(res, 'x-opennext-cache') || header(res, 'x-nextjs-cache'),
      text,
    };
  }
}

export interface NodeOptions {
  port: number;
  probePort: number;
  logFile: string;
}

interface ProbeAnswer {
  toFinishMs: number;
  settledMs: number;
}

/** `next start` with node-hook.cjs preloaded (the cross-check on Node). */
export class NodeRuntime {
  readonly origin: string;
  private child: ChildProcess | null = null;
  private seq = 0;

  constructor(private readonly opts: NodeOptions) {
    this.origin = `http://127.0.0.1:${String(opts.port)}`;
  }

  async start(): Promise<void> {
    const log = createWriteStream(this.opts.logFile, { flags: 'a' });
    const hook = fileURLToPath(new URL('./node-hook.cjs', import.meta.url));
    const child = spawn(
      process.execPath,
      ['node_modules/next/dist/bin/next', 'start', '-p', String(this.opts.port), '-H', '127.0.0.1'],
      {
        cwd: webDir,
        env: {
          ...process.env,
          NEXT_TELEMETRY_DISABLED: '1',
          NODE_OPTIONS: `--require ${hook}`,
          CPU_PROBE_PORT: String(this.opts.probePort),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      },
    );
    this.child = child;
    child.stdout?.on('data', (c: Buffer) => log.write(c));
    child.stderr?.on('data', (c: Buffer) => log.write(c));
    const deadline = Date.now() + 60_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`next start exited (see ${this.opts.logFile})`);
      const up = await fetch(`http://127.0.0.1:${String(this.opts.probePort)}/ping`)
        .then((r) => r.ok)
        .catch(() => false);
      const app = up
        ? await fetch(`${this.origin}/favicon-probe-does-not-exist`, { method: 'HEAD' })
            .then(() => true)
            .catch(() => false)
        : false;
      if (app) break;
      if (Date.now() > deadline) throw new Error('next start not ready');
      await sleep(100);
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child) return;
    killGroup(child);
    await waitForExit(child, 5_000);
    killGroup(child, 'SIGKILL');
    await sleep(200);
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async measure(spec: RequestSpec, holdMs = 0): Promise<Measurement> {
    const id = `p${String(++this.seq)}`;
    const t0 = performance.now();
    const res = await fetch(this.origin + spec.path, {
      method: spec.method ?? 'GET',
      headers: {
        ...headersFor(spec, this.origin),
        'x-cpu-probe': id,
        'x-cpu-probe-hold': String(holdMs),
      },
      body: spec.body ?? null,
      redirect: 'manual',
    });
    const bytes = await readBody(res);
    const wallMs = performance.now() - t0;
    // Ask once the hook is likely done, so this request's own CPU is not counted.
    await sleep(250 + holdMs);
    const probe = (await (
      await fetch(`http://127.0.0.1:${String(this.opts.probePort)}/settle/${id}`)
    ).json()) as ProbeAnswer;
    return {
      status: res.status,
      cache: header(res, 'x-nextjs-cache'),
      location: header(res, 'location'),
      bytes,
      wallMs,
      isolate: null,
      threadMs: probe.settledMs,
      toFinishMs: probe.toFinishMs,
    };
  }

  async request(spec: RequestSpec): Promise<{ status: number; cache: string; text: string }> {
    const res = await fetch(this.origin + spec.path, {
      method: spec.method ?? 'GET',
      headers: headersFor(spec, this.origin),
      body: spec.body ?? null,
      redirect: 'manual',
    });
    const text = await res.text();
    await sleep(100);
    return { status: res.status, cache: header(res, 'x-nextjs-cache'), text };
  }
}
