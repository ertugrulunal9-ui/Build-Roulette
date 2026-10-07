/**
 * Test doubles: an in-memory `Backend` that mimics T-011's SQL job semantics (claim with a
 * lease, 5 attempts, fail_job giving up and marking the build failed), and a scripted
 * `Renderer`. Plus small image helpers (sharp).
 */
import sharp from 'sharp';
import {
  BackendError,
  MAX_JOB_ATTEMPTS,
  type Backend,
  type BuildRow,
  type CaptureStatus,
  type Job,
  type JobKind,
  type StorageEntry,
} from '../src/backend';
import type { RenderRequest, RenderResult, Renderer } from '../src/renderer';

export const BATTLE = '11111111-1111-4111-8111-111111111111';
export const USER = '22222222-2222-4222-8222-222222222222';
export const BUILD = '33333333-3333-4333-8333-333333333333';

export class FakeBackend implements Backend {
  jobs: Job[] = [];
  builds = new Map<string, BuildRow>();
  phases = new Map<string, string>();
  objects = new Map<string, Uint8Array>();
  calls: { fn: string; args: unknown[] }[] = [];
  /** Errors to throw from the next call of a method (consumed once). */
  failNext = new Map<string, Error>();
  /** Errors to throw from every call of a method. */
  failAlways = new Map<string, Error>();
  private nextJobId = 1;

  private record(fn: string, ...args: unknown[]): void {
    this.calls.push({ fn, args });
    const once = this.failNext.get(fn);
    if (once) {
      this.failNext.delete(fn);
      throw once;
    }
    const always = this.failAlways.get(fn);
    if (always) throw always;
  }

  callsTo(fn: string): unknown[][] {
    return this.calls.filter((c) => c.fn === fn).map((c) => c.args);
  }

  addJob(kind: JobKind, ref: string, over: Partial<Job> = {}): Job {
    const job: Job = {
      id: this.nextJobId++,
      kind,
      ref_id: ref,
      status: 'queued',
      attempts: 0,
      run_after: new Date(0).toISOString(),
      last_error: null,
      ...over,
    };
    this.jobs.push(job);
    return job;
  }

  addBuild(over: Partial<BuildRow> = {}): BuildRow {
    const b: BuildRow = {
      id: BUILD,
      battle_id: BATTLE,
      builder_id: USER,
      status: 'shipped',
      capture_status: 'pending',
      taken_down_at: null,
      ...over,
    };
    this.builds.set(b.id, b);
    return b;
  }

  put(bucket: string, path: string, data: Uint8Array | string): void {
    this.objects.set(
      `${bucket}/${path}`,
      typeof data === 'string' ? new TextEncoder().encode(data) : data,
    );
  }

  get(bucket: string, path: string): Uint8Array | undefined {
    return this.objects.get(`${bucket}/${path}`);
  }

  // ─── Backend ────────────────────────────────────────────────────────────

  claimJob(kind: JobKind): Promise<Job | null> {
    this.record('claimJob', kind);
    const job = this.jobs.find(
      (j) =>
        j.kind === kind &&
        (j.status === 'queued' || j.status === 'running') &&
        j.attempts < MAX_JOB_ATTEMPTS &&
        Date.parse(j.run_after) <= Date.now(),
    );
    if (!job) return Promise.resolve(null);
    job.status = 'running';
    job.attempts++;
    job.run_after = new Date(Date.now() + 120_000).toISOString();
    return Promise.resolve({ ...job });
  }

  completeCapture(
    buildId: string,
    status: Exclude<CaptureStatus, 'pending'>,
    path: string | null,
  ): Promise<void> {
    this.record('completeCapture', buildId, status, path);
    const b = this.builds.get(buildId);
    if (!b) return Promise.reject(new BackendError('build_not_found', 404, 'build_not_found'));
    if (b.capture_status !== 'captured') b.capture_status = status;
    for (const j of this.jobs) if (j.kind === 'capture' && j.ref_id === buildId) j.status = 'done';
    return Promise.resolve();
  }

  failJob(jobId: number, error: string): Promise<Job> {
    this.record('failJob', jobId, error);
    const j = this.jobs.find((x) => x.id === jobId);
    if (!j) return Promise.reject(new BackendError('job_not_found', 404, 'job_not_found'));
    j.last_error = error;
    if (j.attempts >= MAX_JOB_ATTEMPTS) {
      j.status = 'failed';
      const b = j.kind === 'capture' ? this.builds.get(j.ref_id) : undefined;
      if (b?.capture_status === 'pending') b.capture_status = 'failed';
    } else {
      j.status = 'queued';
      j.run_after = new Date(Date.now() + 10_000 * 2 ** (j.attempts - 1)).toISOString();
    }
    return Promise.resolve({ ...j });
  }

  completeDestroy(battleId: string): Promise<void> {
    this.record('completeDestroy', battleId);
    for (const j of this.jobs) if (j.kind === 'destroy' && j.ref_id === battleId) j.status = 'done';
    return Promise.resolve();
  }

  completeTakedown(buildId: string): Promise<void> {
    this.record('completeTakedown', buildId);
    const b = this.builds.get(buildId);
    if (!b) return Promise.reject(new BackendError('build_not_found', 404, 'build_not_found'));
    if (!b.taken_down_at) {
      return Promise.reject(new BackendError('not_taken_down', 400, 'not_taken_down'));
    }
    for (const j of this.jobs) if (j.kind === 'takedown' && j.ref_id === buildId) j.status = 'done';
    return Promise.resolve();
  }

  getBuild(buildId: string): Promise<BuildRow | null> {
    this.record('getBuild', buildId);
    const b = this.builds.get(buildId);
    return Promise.resolve(b ? { ...b } : null);
  }

  getBattlePhase(battleId: string): Promise<string | null> {
    this.record('getBattlePhase', battleId);
    return Promise.resolve(this.phases.get(battleId) ?? null);
  }

  createSignedUrl(bucket: string, path: string, expiresInSeconds: number): Promise<string | null> {
    this.record('createSignedUrl', bucket, path, expiresInSeconds);
    if (!this.objects.has(`${bucket}/${path}`)) return Promise.resolve(null);
    return Promise.resolve(
      `https://storage.test/sign/${bucket}/${path}?token=t${String(expiresInSeconds)}`,
    );
  }

  download(bucket: string, path: string): Promise<Uint8Array | null> {
    this.record('download', bucket, path);
    return Promise.resolve(this.objects.get(`${bucket}/${path}`) ?? null);
  }

  upload(bucket: string, path: string, body: Uint8Array, contentType: string): Promise<void> {
    this.record('upload', bucket, path, contentType);
    this.objects.set(`${bucket}/${path}`, body);
    return Promise.resolve();
  }

  list(bucket: string, prefix: string): Promise<StorageEntry[]> {
    this.record('list', bucket, prefix);
    const seen = new Map<string, boolean>();
    const full = `${bucket}/${prefix}`;
    for (const key of this.objects.keys()) {
      if (!key.startsWith(full)) continue;
      const rest = key.slice(full.length).split('/');
      const name = rest[0] ?? '';
      seen.set(name, (seen.get(name) ?? false) || rest.length > 1);
    }
    return Promise.resolve([...seen].map(([name, isFolder]) => ({ name, isFolder })));
  }

  remove(bucket: string, paths: readonly string[]): Promise<string[]> {
    this.record('remove', bucket, [...paths]);
    const out: string[] = [];
    for (const p of paths) if (this.objects.delete(`${bucket}/${p}`)) out.push(p);
    return Promise.resolve(out);
  }
}

export type RenderScript = (req: RenderRequest) => Promise<RenderResult>;

export class FakeRenderer implements Renderer {
  requests: RenderRequest[] = [];
  closed = false;
  constructor(public script: RenderScript) {}
  render(req: RenderRequest): Promise<RenderResult> {
    this.requests.push(req);
    return this.script(req);
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

export function rendered(png: Uint8Array): RenderResult {
  return {
    png,
    ready: { reason: 'signal', afterMs: 120 },
    durationMs: 900,
    blocked: { navigations: 0, popups: 0 },
    notes: [],
  };
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** A solid colour image, PNG (or WebP). */
export async function solidImage(
  width: number,
  height: number,
  color: Rgb,
  format: 'png' | 'webp' = 'png',
): Promise<Uint8Array> {
  const img = sharp({ create: { width, height, channels: 3, background: color } });
  return new Uint8Array(await (format === 'png' ? img.png() : img.webp()).toBuffer());
}

/** A background with a rectangle of another colour (stands in for "content on a page"). */
export async function imageWithBlock(
  width: number,
  height: number,
  bg: Rgb,
  block: Rgb & { left: number; top: number; width: number; height: number },
  format: 'png' | 'webp' = 'png',
): Promise<Uint8Array> {
  const patch = await sharp({
    create: {
      width: block.width,
      height: block.height,
      channels: 3,
      background: { r: block.r, g: block.g, b: block.b },
    },
  })
    .png()
    .toBuffer();
  const img = sharp({ create: { width, height, channels: 3, background: bg } }).composite([
    { input: patch, left: block.left, top: block.top },
  ]);
  return new Uint8Array(await (format === 'png' ? img.png() : img.webp()).toBuffer());
}
