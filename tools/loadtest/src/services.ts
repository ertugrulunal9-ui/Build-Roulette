/**
 * The capture side of the test: `apps/web/scripts/solo-services.ts` (the same local
 * services the rooms e2e use) starts the sandbox shell with its capture gate, the mock
 * package CDN and `@br/capture-worker` (Playwright Chromium) polling the job queue. Its
 * output is parsed for the worker's JSON log lines (`job.end`, `capture.rendered`,
 * `capture.captured`).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, type StackEnv } from './env';

export interface JobEnd {
  t: number;
  kind: string;
  result: string;
  ms: number;
}

export interface CaptureLog {
  jobs: JobEnd[];
  renderMs: number[];
  readyReasons: Record<string, number>;
  screenshotBytes: number[];
  errors: string[];
}

export class CaptureServices {
  private child: ChildProcess | null = null;
  private log: WriteStream | null = null;
  readonly parsed: CaptureLog = {
    jobs: [],
    renderMs: [],
    readyReasons: {},
    screenshotBytes: [],
    errors: [],
  };

  constructor(
    private readonly env: StackEnv,
    private readonly concurrency: number,
    private readonly outDir: string,
  ) {}

  async start(): Promise<void> {
    const webDir = join(REPO_ROOT, 'apps/web');
    this.log = createWriteStream(join(this.outDir, 'capture-services.log'));
    const child = spawn(
      join(webDir, 'node_modules/.bin/tsx'),
      // `--worker`: since T-034 solo-services starts the jobs Edge Function by default; this
      // test parses the Node worker's JSON log lines (`worker.started`, `job.end`, …), and the
      // worker runs the same job contract.
      ['scripts/solo-services.ts', '--realtime', '--worker'],
      {
        cwd: webDir,
        env: {
          ...process.env,
          API_URL: this.env.API_URL,
          ANON_KEY: this.env.ANON_KEY,
          SERVICE_ROLE_KEY: this.env.SERVICE_ROLE_KEY,
          SHELL_PORT: '4351',
          CDN_PORT: '4352',
          CAPTURE_CONCURRENCY: String(this.concurrency),
          WORKER_IDLE_MIN_MS: '500',
          WORKER_IDLE_MAX_MS: '2000',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      },
    );
    this.child = child;
    let ready: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let buf = '';
    const onData = (chunk: Buffer) => {
      this.log?.write(chunk);
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        this.parseLine(line);
        if (line.includes('worker.started')) ready();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const exited = new Promise<never>((_, reject) => {
      child.once('exit', (code) => {
        reject(
          new Error(`capture services exited early (${String(code)}), see capture-services.log`),
        );
      });
    });
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => {
        reject(new Error('capture services did not start within 60 s'));
      }, 60_000).unref(),
    );
    await Promise.race([started, exited, timeout]);
  }

  private parseLine(line: string): void {
    const i = line.indexOf('{');
    if (!line.startsWith('[capture]') || i < 0) return;
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(line.slice(i)) as Record<string, unknown>;
    } catch {
      return;
    }
    const msg = j['msg'];
    if (msg === 'job.end') {
      this.parsed.jobs.push({
        t: Date.parse(String(j['t'])),
        kind: String(j['kind']),
        result: String(j['result']),
        ms: Number(j['ms']),
      });
    } else if (msg === 'capture.rendered') {
      this.parsed.renderMs.push(Number(j['renderMs']));
      const r = String(j['ready']);
      this.parsed.readyReasons[r] = (this.parsed.readyReasons[r] ?? 0) + 1;
    } else if (msg === 'capture.captured' || msg === 'capture.fallback') {
      this.parsed.screenshotBytes.push(Number(j['bytes']));
    } else if (j['level'] === 'error') {
      this.parsed.errors.push(String(msg));
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (child?.exitCode !== null) return;
    child.removeAllListeners('exit');
    const exited = new Promise((r) => child.once('exit', r));
    child.kill('SIGTERM');
    await Promise.race([exited, new Promise((r) => setTimeout(r, 40_000))]);
    if (child.pid && !child.killed) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    this.log?.end();
  }
}
