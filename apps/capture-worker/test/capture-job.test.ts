import sharp from 'sharp';
import { beforeEach, describe, expect, it } from 'vitest';
import { verifyCaptureUrl } from '@br/sandbox-shell/capture-sig';
import { BackendError, BUCKET_EPHEMERAL, BUCKET_SCREENSHOTS } from '../src/backend';
import { processCaptureJob, type CaptureConfig, type CaptureDeps } from '../src/capture-job';
import { sharpImaging } from '../src/image';
import { silentLogger } from '../src/log';
import { RenderError } from '../src/renderer';
import {
  BATTLE,
  BUILD,
  FakeBackend,
  FakeRenderer,
  USER,
  imageWithBlock,
  rendered,
  solidImage,
} from './fakes';

const SECRET = 'unit-secret-0123456789abcdef0123456789abcdef';
const CONFIG: CaptureConfig = {
  shellCaptureUrl: 'https://{build}.usercontent.test/v2/capture',
  hmacSecret: SECRET,
  signedUrlTtlSeconds: 120,
  captureTimeoutMs: 20_000,
  viewport: { width: 1280, height: 800 },
};
const PREFIX = `${BATTLE}/${USER}`;
const SHOT = `${BATTLE}/${BUILD}.webp`;
/** The capture job never looks inside a pack: any bytes stand in for one. */
const PACK = 'BRSITE1 stand-in';

let backend: FakeBackend;
let goodPng: Uint8Array;
let thumb: Uint8Array;

beforeEach(async () => {
  backend = new FakeBackend();
  goodPng = await imageWithBlock(
    1280,
    800,
    { r: 255, g: 87, b: 34 },
    { r: 255, g: 255, b: 255, left: 300, top: 350, width: 600, height: 100 },
  );
  thumb = await imageWithBlock(
    320,
    200,
    { r: 0, g: 160, b: 80 },
    { r: 255, g: 255, b: 255, left: 0, top: 90, width: 320, height: 20 },
    'webp',
  );
});

function deps(renderer: FakeRenderer): CaptureDeps {
  return {
    backend,
    renderer,
    imaging: sharpImaging,
    config: CONFIG,
    log: silentLogger,
    now: () => 1_800_000_000_000,
  };
}

function shippedBuild(files: Record<string, Uint8Array | string> = {}) {
  backend.addBuild({ status: 'shipped' });
  backend.put(BUCKET_EPHEMERAL, `${PREFIX}/site.bin`, PACK);
  for (const [k, v] of Object.entries(files)) backend.put(BUCKET_EPHEMERAL, `${PREFIX}/${k}`, v);
  return backend.addJob('capture', BUILD);
}

async function claim() {
  const job = await backend.claimJob('capture');
  if (!job) throw new Error('no job');
  return job;
}

const never = new AbortController().signal;

describe('capture job: server render', () => {
  it('signs a v2 capture URL (src = site.bin) for the build origin, renders, stores WebP, completes as captured', async () => {
    shippedBuild();
    const renderer = new FakeRenderer(() => Promise.resolve(rendered(goodPng)));
    const out = await processCaptureJob(deps(renderer), await claim(), never);
    expect(out).toEqual({ result: 'captured', path: SHOT, ready: 'signal', renderMs: 900 });

    const [req] = renderer.requests;
    expect(req?.viewport).toEqual({ width: 1280, height: 800 });
    expect(req?.timeoutMs).toBe(20_000);
    const url = new URL(req?.url ?? '');
    expect(url.origin).toBe(`https://${BUILD}.usercontent.test`);
    expect(url.pathname).toBe('/v2/capture');
    expect([...url.searchParams.keys()].sort()).toEqual(['exp', 'sig', 'src']);
    const verified = await verifyCaptureUrl(url, SECRET, 1_800_000_000);
    if (!verified.ok) throw new Error(verified.reason);
    expect(verified.params).toEqual({
      src: `https://storage.test/sign/${BUCKET_EPHEMERAL}/${PREFIX}/site.bin?token=t120`,
      exp: 1_800_000_000 + 120,
    });
    // One signed Storage URL, and nothing downloaded (no manifest, no import map).
    expect(backend.callsTo('createSignedUrl')).toEqual([
      [BUCKET_EPHEMERAL, `${PREFIX}/site.bin`, 120],
    ]);
    expect(backend.callsTo('download')).toEqual([]);

    const stored = backend.get(BUCKET_SCREENSHOTS, SHOT);
    expect((await sharp(stored).metadata()).format).toBe('webp');
    expect(backend.callsTo('upload')).toEqual([[BUCKET_SCREENSHOTS, SHOT, 'image/webp']]);
    expect(backend.callsTo('completeCapture')).toEqual([[BUILD, 'captured', SHOT]]);
    expect(backend.builds.get(BUILD)?.capture_status).toBe('captured');
    expect(backend.callsTo('failJob')).toEqual([]);
  });

  it('auto_shipped builds render the autosave pack, never a stale top-level one', async () => {
    backend.addBuild({ status: 'auto_shipped' });
    backend.put(BUCKET_EPHEMERAL, `${PREFIX}/autosave/site.bin`, PACK);
    backend.put(BUCKET_EPHEMERAL, `${PREFIX}/site.bin`, 'stale, must not be used');
    backend.addJob('capture', BUILD);
    const renderer = new FakeRenderer(() => Promise.resolve(rendered(goodPng)));
    const out = await processCaptureJob(deps(renderer), await claim(), never);
    expect(out.result).toBe('captured');
    const verified = await verifyCaptureUrl(renderer.requests[0]?.url ?? '', SECRET, 1_800_000_000);
    if (!verified.ok) throw new Error(verified.reason);
    expect(verified.params.src).toBe(
      `https://storage.test/sign/${BUCKET_EPHEMERAL}/${PREFIX}/autosave/site.bin?token=t120`,
    );
  });

  it('an auto_shipped build without autosave/site.bin is not rendered from site.bin', async () => {
    backend.addBuild({ status: 'auto_shipped' });
    backend.put(BUCKET_EPHEMERAL, `${PREFIX}/site.bin`, 'stale, must not be used');
    backend.put(BUCKET_EPHEMERAL, `${PREFIX}/thumb.webp`, thumb);
    backend.addJob('capture', BUILD);
    const renderer = new FakeRenderer(() => Promise.reject(new Error('must not render')));
    const out = await processCaptureJob(deps(renderer), await claim(), never);
    expect(out).toMatchObject({ result: 'fallback', reason: 'autosave site.bin is missing' });
    expect(renderer.requests).toEqual([]);
  });

  it('a storage error while storing a good render is retried, not downgraded to the thumbnail', async () => {
    shippedBuild({ 'thumb.webp': thumb });
    backend.failNext.set('upload', new BackendError('upload: HTTP 500', 500, undefined));
    const renderer = new FakeRenderer(() => Promise.resolve(rendered(goodPng)));
    const out = await processCaptureJob(deps(renderer), await claim(), never);
    expect(out).toMatchObject({ result: 'retry', attempts: 1 });
    expect(backend.callsTo('completeCapture')).toEqual([]);
    expect(backend.callsTo('failJob')[0]?.[1]).toContain('upload: HTTP 500');
  });
});

describe('capture job: fallback selection', () => {
  it('blank render + client thumbnail → fallback with the re-encoded thumbnail', async () => {
    shippedBuild({ 'thumb.webp': thumb });
    const blank = await solidImage(1280, 800, { r: 255, g: 255, b: 255 });
    const renderer = new FakeRenderer(() => Promise.resolve(rendered(blank)));
    const out = await processCaptureJob(deps(renderer), await claim(), never);
    expect(out).toMatchObject({ result: 'fallback', path: SHOT });
    if (out.result === 'fallback') expect(out.reason).toContain('blank render');
    const stored = backend.get(BUCKET_SCREENSHOTS, SHOT);
    expect(stored).toBeDefined();
    expect(stored).not.toEqual(thumb); // re-encoded, never stored as uploaded
    expect((await sharp(stored).metadata()).width).toBe(320);
    expect(backend.callsTo('completeCapture')).toEqual([[BUILD, 'fallback', SHOT]]);
  });

  it('render error (e.g. timeout of a frozen build) + thumbnail → fallback', async () => {
    shippedBuild({ 'thumb.webp': thumb });
    const renderer = new FakeRenderer(() =>
      Promise.reject(new RenderError('timeout', 'capture stopped after 20000 ms')),
    );
    const out = await processCaptureJob(deps(renderer), await claim(), never);
    expect(out).toMatchObject({
      result: 'fallback',
      reason: 'timeout: capture stopped after 20000 ms',
    });
  });

  it('render error without a thumbnail → fail_job (retry with backoff)', async () => {
    const job = shippedBuild();
    const renderer = new FakeRenderer(() =>
      Promise.reject(new RenderError('navigation', 'capture page: failed site.bin: HTTP 400')),
    );
    const out = await processCaptureJob(deps(renderer), await claim(), never);
    expect(out).toEqual({
      result: 'retry',
      attempts: 1,
      reason: 'navigation: capture page: failed site.bin: HTTP 400; no client thumbnail',
    });
    expect(backend.jobs.find((j) => j.id === job.id)?.status).toBe('queued');
    expect(backend.builds.get(BUILD)?.capture_status).toBe('pending');
    expect(backend.callsTo('completeCapture')).toEqual([]);
  });

  it('on the last attempt fail_job gives up and the build ends as failed (SQL semantics)', async () => {
    const job = shippedBuild();
    job.attempts = 4;
    const blank = await solidImage(1280, 800, { r: 0, g: 0, b: 0 });
    const renderer = new FakeRenderer(() => Promise.resolve(rendered(blank)));
    const out = await processCaptureJob(deps(renderer), await claim(), never);
    expect(out.result).toBe('failed');
    expect(job.status).toBe('failed');
    expect(backend.builds.get(BUILD)?.capture_status).toBe('failed');
    expect(backend.callsTo('completeCapture')).toEqual([]);
  });

  it('a thumbnail that is not an image is not used', async () => {
    shippedBuild({ 'thumb.webp': 'GIF89a nope' });
    const renderer = new FakeRenderer(() => Promise.reject(new RenderError('timeout', 'x')));
    const out = await processCaptureJob(deps(renderer), await claim(), never);
    expect(out.result).toBe('retry');
    if (out.result === 'retry') expect(out.reason).toContain('not a usable image');
    expect(backend.get(BUCKET_SCREENSHOTS, SHOT)).toBeUndefined();
  });

  it('no site pack but a thumbnail → fallback without rendering', async () => {
    backend.addBuild({ status: 'shipped' });
    backend.put(BUCKET_EPHEMERAL, `${PREFIX}/thumb.webp`, thumb);
    backend.addJob('capture', BUILD);
    const renderer = new FakeRenderer(() => Promise.reject(new Error('must not render')));
    const out = await processCaptureJob(deps(renderer), await claim(), never);
    expect(out).toMatchObject({ result: 'fallback', reason: 'shipped site.bin is missing' });
    expect(renderer.requests).toEqual([]);
  });

  it('no site pack and no thumbnail → failed at once (retrying cannot help)', async () => {
    backend.addBuild({ status: 'shipped' });
    backend.addJob('capture', BUILD);
    const renderer = new FakeRenderer(() => Promise.reject(new Error('must not render')));
    const out = await processCaptureJob(deps(renderer), await claim(), never);
    expect(out.result).toBe('failed');
    expect(backend.callsTo('completeCapture')).toEqual([[BUILD, 'failed', null]]);
    expect(backend.callsTo('failJob')).toEqual([]);
  });
});

describe('capture job: aborts and bad rows', () => {
  it('an aborted render (shutdown) is given back with fail_job, without fallback', async () => {
    shippedBuild({ 'thumb.webp': thumb });
    const ctrl = new AbortController();
    const renderer = new FakeRenderer(() => {
      ctrl.abort(new Error('worker shutting down'));
      return Promise.reject(new RenderError('aborted', 'capture stopped after 5 ms'));
    });
    const out = await processCaptureJob(deps(renderer), await claim(), ctrl.signal);
    expect(out).toEqual({
      result: 'retry',
      attempts: 1,
      reason: 'aborted: worker shutting down',
    });
    expect(backend.get(BUCKET_SCREENSHOTS, SHOT)).toBeUndefined();
  });

  it('a missing build, a non-capturable build and a bad ref are retried via fail_job', async () => {
    const renderer = new FakeRenderer(() => Promise.reject(new Error('must not render')));
    backend.addJob('capture', BUILD);
    expect(await processCaptureJob(deps(renderer), await claim(), never)).toMatchObject({
      result: 'retry',
      reason: 'build not found',
    });

    backend = new FakeBackend();
    backend.addBuild({ status: 'dnf' });
    backend.addJob('capture', BUILD);
    expect(await processCaptureJob(deps(renderer), await claim(), never)).toMatchObject({
      result: 'retry',
      reason: 'a dnf build has nothing to capture',
    });

    backend = new FakeBackend();
    backend.addJob('capture', '../../etc');
    expect(await processCaptureJob(deps(renderer), await claim(), never)).toMatchObject({
      result: 'retry',
      reason: 'job ref_id is not a build id',
    });
    expect(renderer.requests).toEqual([]);
  });

  it('when even fail_job fails, the outcome is error (the lease brings the job back)', async () => {
    shippedBuild();
    backend.failAlways.set('failJob', new Error('network down'));
    const renderer = new FakeRenderer(() => Promise.reject(new RenderError('timeout', 'x')));
    const out = await processCaptureJob(deps(renderer), await claim(), never);
    expect(out.result).toBe('error');
  });
});
