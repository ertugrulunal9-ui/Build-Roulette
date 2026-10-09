/**
 * The capture job as the `jobs` Edge Function runs it (T-034): WebP from the renderer
 * (`webpImaging`), the daily budget, and the retry-then-fallback policy for service
 * failures. Fakes only.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { BUCKET_EPHEMERAL, BUCKET_SCREENSHOTS, type Job } from '../src/backend';
import type { BudgetTicket, CaptureBudget } from '../src/budget';
import { processCaptureJob, type CaptureConfig, type CaptureDeps } from '../src/capture-job';
import {
  SERVICE_FALLBACK_ATTEMPT,
  afterNoRender,
  classifyRenderFailure,
} from '../src/capture-policy';
import { webpImaging } from '../src/imaging';
import { silentLogger } from '../src/log';
import { RenderError, type RenderResult } from '../src/renderer';
import { parseWebp } from '../src/webp';
import {
  BATTLE,
  BUILD,
  FakeBackend,
  FakeRenderer,
  USER,
  imageWithBlock,
  solidImage,
} from './fakes';

const CONFIG: CaptureConfig = {
  shellCaptureUrl: 'https://{build}.usercontent.test/v1/capture',
  hmacSecret: 'unit-secret-0123456789abcdef0123456789abcdef',
  pkgCdnUrl: 'https://pkg.test',
  signedUrlTtlSeconds: 120,
  captureTimeoutMs: 35_000,
  viewport: { width: 1280, height: 800 },
};
const PREFIX = `${BATTLE}/${USER}`;
const SHOT = `${BATTLE}/${BUILD}.webp`;

class FakeBudget implements CaptureBudget {
  granted = true;
  down = false;
  reserved = 0;
  settled: { ticket: BudgetTicket; browserMs: number; rateLimited: boolean }[] = [];
  reserve(): Promise<BudgetTicket | null> {
    if (this.down) return Promise.reject(new Error('PostgREST: HTTP 503'));
    if (!this.granted) return Promise.resolve(null);
    this.reserved++;
    return Promise.resolve({ day: '2026-10-09', reservedMs: 20_000 });
  }
  settle(ticket: BudgetTicket, usage: { browserMs: number; rateLimited: boolean }): Promise<void> {
    this.settled.push({ ticket, ...usage });
    return Promise.resolve();
  }
}

let backend: FakeBackend;
let budget: FakeBudget;
let shotWebp: Uint8Array;
let thumb: Uint8Array;

beforeEach(async () => {
  backend = new FakeBackend();
  budget = new FakeBudget();
  shotWebp = await imageWithBlock(
    1280,
    800,
    { r: 255, g: 87, b: 34 },
    { r: 255, g: 255, b: 255, left: 300, top: 350, width: 600, height: 100 },
    'webp',
  );
  thumb = await solidImage(640, 400, { r: 0, g: 160, b: 80 }, 'webp');
});

function webpResult(over: Partial<RenderResult> = {}): RenderResult {
  return {
    image: shotWebp,
    format: 'webp',
    ready: { reason: 'signal', afterMs: 1500 },
    durationMs: 2100,
    paint: 'content',
    browserMs: 1800,
    blocked: { navigations: 0, popups: 0 },
    notes: [],
    ...over,
  };
}

function deps(renderer: FakeRenderer): CaptureDeps {
  return { backend, renderer, imaging: webpImaging, budget, config: CONFIG, log: silentLogger };
}

function shippedBuild(files: Record<string, Uint8Array | string> = {}): void {
  backend.addBuild({ status: 'shipped' });
  backend.put(BUCKET_EPHEMERAL, `${PREFIX}/bundle.js`, 'console.log(1)');
  backend.put(BUCKET_EPHEMERAL, `${PREFIX}/source.json`, '{}');
  for (const [k, v] of Object.entries(files)) backend.put(BUCKET_EPHEMERAL, `${PREFIX}/${k}`, v);
  backend.addJob('capture', BUILD);
}

async function claim(): Promise<Job> {
  const job = await backend.claimJob('capture');
  if (!job) throw new Error('no job');
  return job;
}

/** Puts the job at `attempts` and makes it due, then claims it (attempts + 1). */
async function claimAtAttempt(attempt: number): Promise<Job> {
  const j = backend.jobs[0];
  if (!j) throw new Error('no job');
  j.status = 'queued';
  j.attempts = attempt - 1;
  j.run_after = new Date(0).toISOString();
  return claim();
}

const never = new AbortController().signal;

describe('capture job with Browser Rendering (WebP, no sharp)', () => {
  it('stores the WebP as rendered (no re-encoding) and settles the browser time', async () => {
    shippedBuild();
    const renderer = new FakeRenderer(() => Promise.resolve(webpResult()));
    const out = await processCaptureJob(deps(renderer), await claim(), never);
    expect(out).toEqual({ result: 'captured', path: SHOT, ready: 'signal', renderMs: 2100 });
    const stored = backend.get(BUCKET_SCREENSHOTS, SHOT);
    expect(stored).toEqual(shotWebp);
    expect(budget.reserved).toBe(1);
    expect(budget.settled).toEqual([
      { ticket: { day: '2026-10-09', reservedMs: 20_000 }, browserMs: 1800, rateLimited: false },
    ]);
  });

  it('a render the page reports as empty falls back to the client thumbnail, container rebuilt', async () => {
    shippedBuild({ 'thumb.webp': thumb });
    const renderer = new FakeRenderer(() => Promise.resolve(webpResult({ paint: 'empty' })));
    const out = await processCaptureJob(deps(renderer), await claim(), never);
    expect(out).toMatchObject({ result: 'fallback', path: SHOT });
    if (out.result === 'fallback') expect(out.reason).toContain('blank render');
    const stored = backend.get(BUCKET_SCREENSHOTS, SHOT) ?? new Uint8Array();
    expect(parseWebp(stored)).toMatchObject({ width: 640, height: 400, chunks: ['VP8 '] });
    expect(backend.callsTo('completeCapture')).toEqual([[BUILD, 'fallback', SHOT]]);
  });

  it('a render of the wrong size, or not WebP, is not stored', async () => {
    shippedBuild({ 'thumb.webp': thumb });
    const small = await solidImage(800, 600, { r: 1, g: 2, b: 3 }, 'webp');
    const renderer = new FakeRenderer(() => Promise.resolve(webpResult({ image: small })));
    const out = await processCaptureJob(deps(renderer), await claim(), never);
    expect(out.result).toBe('fallback');
    if (out.result === 'fallback') expect(out.reason).toContain('800×600');
  });

  it('budget spent: no render at all, the thumbnail at once', async () => {
    budget.granted = false;
    shippedBuild({ 'thumb.webp': thumb });
    const renderer = new FakeRenderer(() => Promise.reject(new Error('must not render')));
    const out = await processCaptureJob(deps(renderer), await claim(), never);
    expect(out).toMatchObject({ result: 'fallback' });
    if (out.result === 'fallback') expect(out.reason).toContain('budget');
    expect(renderer.requests).toHaveLength(0);
    expect(budget.settled).toHaveLength(0);
  });

  it('budget spent and no thumbnail: retried with backoff (it may come back at 00:00 UTC)', async () => {
    budget.granted = false;
    shippedBuild();
    const renderer = new FakeRenderer(() => Promise.reject(new Error('must not render')));
    const out = await processCaptureJob(deps(renderer), await claim(), never);
    expect(out).toMatchObject({ result: 'retry', attempts: 1 });
    expect(backend.jobs[0]?.last_error).toContain('budget');
  });

  it('the budget cannot be read (a database blip): retried, not a thumbnail for good', async () => {
    budget.down = true;
    shippedBuild({ 'thumb.webp': thumb });
    const renderer = new FakeRenderer(() => Promise.reject(new Error('must not render')));
    const out = await processCaptureJob(deps(renderer), await claim(), never);
    expect(out).toMatchObject({ result: 'retry', attempts: 1 });
    expect(backend.jobs[0]?.last_error).toContain('browser budget: PostgREST: HTTP 503');
    expect(renderer.requests).toHaveLength(0);
    expect(backend.get(BUCKET_SCREENSHOTS, SHOT)).toBeUndefined();
  });

  it(`a 429: handed back on attempts 1–${String(SERVICE_FALLBACK_ATTEMPT - 1)}, the thumbnail from attempt ${String(SERVICE_FALLBACK_ATTEMPT)}`, async () => {
    shippedBuild({ 'thumb.webp': thumb });
    const renderer = new FakeRenderer(() =>
      Promise.reject(
        new RenderError('rate-limited', 'HTTP 429', { browserMs: 0, retryAfterMs: 60_000 }),
      ),
    );
    const first = await processCaptureJob(deps(renderer), await claim(), never);
    expect(first).toMatchObject({ result: 'retry', attempts: 1 });
    expect(backend.jobs[0]?.last_error).toContain('429');
    expect(backend.get(BUCKET_SCREENSHOTS, SHOT)).toBeUndefined();
    const second = await processCaptureJob(deps(renderer), await claimAtAttempt(2), never);
    expect(second).toMatchObject({ result: 'retry', attempts: 2 });
    const third = await processCaptureJob(deps(renderer), await claimAtAttempt(3), never);
    expect(third).toMatchObject({ result: 'fallback', path: SHOT });
    expect(budget.settled.map((s) => s.rateLimited)).toEqual([true, true, true]);
    expect(budget.settled.map((s) => s.browserMs)).toEqual([0, 0, 0]);
  });

  it('Browser Rendering unavailable (5xx, network): retried, the browser time it used is counted', async () => {
    shippedBuild({ 'thumb.webp': thumb });
    const renderer = new FakeRenderer(() =>
      Promise.reject(new RenderError('unavailable', 'HTTP 503', { browserMs: 900 })),
    );
    const out = await processCaptureJob(deps(renderer), await claim(), never);
    expect(out).toMatchObject({ result: 'retry', attempts: 1 });
    expect(budget.settled[0]).toMatchObject({ browserMs: 900, rateLimited: false });
  });

  it("a page failure (the build's doing) falls back at once, even on attempt 1", async () => {
    shippedBuild({ 'thumb.webp': thumb });
    const renderer = new FakeRenderer(() =>
      Promise.reject(new RenderError('timeout', 'HTTP 500 Timeout', { browserMs: 16_000 })),
    );
    const out = await processCaptureJob(deps(renderer), await claim(), never);
    expect(out.result).toBe('fallback');
    expect(budget.settled[0]?.browserMs).toBe(16_000);
  });

  it('an abort (end of the run) hands the job back without a fallback and still settles', async () => {
    shippedBuild({ 'thumb.webp': thumb });
    const ctrl = new AbortController();
    const renderer = new FakeRenderer(() => {
      ctrl.abort(new Error('the function run reached its time limit'));
      return Promise.reject(new RenderError('aborted', 'aborted', { browserMs: 3000 }));
    });
    const out = await processCaptureJob(deps(renderer), await claim(), ctrl.signal);
    expect(out).toMatchObject({ result: 'retry' });
    if (out.result === 'retry') expect(out.reason).toContain('time limit');
    expect(backend.get(BUCKET_SCREENSHOTS, SHOT)).toBeUndefined();
    expect(budget.settled[0]?.browserMs).toBe(3000);
  });

  it('a client thumbnail that is not a usable WebP is not stored', async () => {
    shippedBuild({ 'thumb.webp': '<svg onload=alert(1)>' });
    const renderer = new FakeRenderer(() => Promise.resolve(webpResult({ paint: 'empty' })));
    const out = await processCaptureJob(deps(renderer), await claim(), never);
    expect(out.result).toBe('retry');
    expect(backend.jobs[0]?.last_error).toContain('not a usable image');
    expect(backend.get(BUCKET_SCREENSHOTS, SHOT)).toBeUndefined();
  });
});

describe('capture-policy', () => {
  it('service failures are 429 and unavailable; everything else is the render', () => {
    expect(classifyRenderFailure(new RenderError('rate-limited', 'x'))).toBe('service');
    expect(classifyRenderFailure(new RenderError('unavailable', 'x'))).toBe('service');
    for (const code of [
      'timeout',
      'navigation',
      'shell-refused',
      'screenshot',
      'browser',
    ] as const) {
      expect(classifyRenderFailure(new RenderError(code, 'x'))).toBe('render');
    }
    expect(classifyRenderFailure(new Error('sharp failed'))).toBe('render');
  });

  it('only service failures wait, and only until the fallback attempt', () => {
    expect([1, 2, 3, 4, 5].map((a) => afterNoRender('service', a))).toEqual([
      'retry',
      'retry',
      'fallback',
      'fallback',
      'fallback',
    ]);
    expect([1, 5].map((a) => afterNoRender('render', a))).toEqual(['fallback', 'fallback']);
    expect([1, 5].map((a) => afterNoRender('budget', a))).toEqual(['fallback', 'fallback']);
  });
});
