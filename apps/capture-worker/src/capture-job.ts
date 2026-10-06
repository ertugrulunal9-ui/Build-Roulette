/**
 * One capture job (docs/01 §1.5 "Ship → capture → destroy", docs/03 §3.7).
 *
 *   build row ─► signed Storage URLs (bundle.js, bundle.css; short TTL)
 *             ─► import map from the build's manifest (source.json)
 *             ─► signed capture page URL (HMAC, short expiry)
 *             ─► renderer (PNG 1280×800) ─► blank check ─► WebP ─► screenshots/{battle}/{build}.webp
 *             ─► complete_capture('captured')
 *
 * Fallback when the render fails or is blank: the client thumbnail `thumb.webp`, re-encoded
 * (never stored as uploaded), `complete_capture('fallback')`.
 *
 * Neither works: `fail_job` (re-queued with backoff; at the 5th attempt SQL gives up and
 * sets capture_status = failed). One case fails at once with `complete_capture('failed')`:
 * no bundle AND no thumbnail, because retrying cannot make files appear (uploads are closed
 * once a build is shipped).
 *
 * Storing a successful render (upload, complete_capture) is outside the fallback path: if
 * Storage or the RPC hiccups there, the job is retried rather than downgraded to the
 * thumbnail.
 */
import { buildImportMap } from '@br/runtime/bundler';
import { signCaptureUrl } from '@br/sandbox-shell/capture-sig';
import {
  BUCKET_EPHEMERAL,
  BUCKET_SCREENSHOTS,
  isUuid,
  type Backend,
  type BuildRow,
  type Job,
} from './backend';
import { decodeRaw, encodeWebp, isBlank, pixelStats } from './image';
import { errorMessage, type Logger } from './log';
import { buildSources, screenshotPath, type BuildSources } from './paths';
import type { ReadyReason } from './readiness';
import { RenderError, type Renderer } from './renderer';

export interface CaptureConfig {
  /**
   * The capture page URL. `{build}` is replaced with the build id, for per-build sandbox
   * origins (`https://{build}.usercontent.example/v1/capture`).
   */
  shellCaptureUrl: string;
  hmacSecret: string;
  /** Package CDN base URL for the import map (React from the CDN, like the preview). */
  pkgCdnUrl: string;
  /** Lifetime of the signed Storage URLs and of the signed capture URL. */
  signedUrlTtlSeconds: number;
  /** Hard limit for one render. */
  captureTimeoutMs: number;
  viewport: { width: number; height: number };
}

export interface CaptureDeps {
  backend: Backend;
  renderer: Renderer;
  config: CaptureConfig;
  log: Logger;
  now?: () => number;
}

export type CaptureOutcome =
  | { result: 'captured'; path: string; ready: ReadyReason; renderMs: number }
  | { result: 'fallback'; path: string; reason: string }
  /** Given up for good: capture_status is `failed`. */
  | { result: 'failed'; reason: string }
  /** `fail_job` re-queued the job with backoff. */
  | { result: 'retry'; reason: string; attempts: number }
  /** Not even `fail_job` went through; the lease will expire and the job comes back. */
  | { result: 'error'; reason: string };

/** Largest `source.json` the worker reads for the manifest (the bucket allows 5 MB). */
const MAX_SOURCE_BYTES = 5 * 1024 * 1024;

export function captureUrlFor(config: Pick<CaptureConfig, 'shellCaptureUrl'>, buildId: string) {
  return config.shellCaptureUrl.replaceAll('{build}', buildId);
}

/** The import map for the build's pinned React, or an empty map if the manifest is unusable. */
export async function importMapFor(
  backend: Backend,
  sourcePath: string,
  cdnUrl: string,
  log: Logger,
): Promise<{ imports: Record<string, string> }> {
  try {
    const bytes = await backend.download(BUCKET_EPHEMERAL, sourcePath);
    if (!bytes) {
      log.warn('capture.no_source_json');
      return { imports: {} };
    }
    if (bytes.byteLength > MAX_SOURCE_BYTES) throw new Error('source.json is too large');
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as {
      manifest?: { dependencies?: unknown };
    };
    const deps = parsed.manifest?.dependencies;
    if (typeof deps !== 'object' || deps === null || Array.isArray(deps)) {
      throw new Error('source.json has no manifest.dependencies object');
    }
    const strings: Record<string, string> = {};
    for (const [k, v] of Object.entries(deps)) if (typeof v === 'string') strings[k] = v;
    // buildImportMap only maps exact (pinned) react / react-dom versions; anything else in a
    // hostile manifest is ignored, and the capture page validates the map again.
    return buildImportMap(strings, cdnUrl);
  } catch (e) {
    log.warn('capture.bad_manifest', { error: errorMessage(e) });
    return { imports: {} };
  }
}

type RenderAttempt =
  | { kind: 'missing' }
  | { kind: 'blank'; stdDev: number }
  | { kind: 'ok'; png: Uint8Array; ready: ReadyReason; renderMs: number };

async function renderBuild(
  deps: CaptureDeps,
  build: BuildRow,
  sources: BuildSources,
  signal: AbortSignal,
  log: Logger,
): Promise<RenderAttempt> {
  const { backend, config } = deps;
  const ttl = config.signedUrlTtlSeconds;
  const src = await backend.createSignedUrl(BUCKET_EPHEMERAL, sources.js, ttl);
  if (!src) return { kind: 'missing' };
  const css = sources.css
    ? await backend.createSignedUrl(BUCKET_EPHEMERAL, sources.css, ttl)
    : null;
  const map = await importMapFor(backend, sources.source, config.pkgCdnUrl, log);
  const now = deps.now ?? Date.now;
  const url = await signCaptureUrl({
    captureUrl: captureUrlFor(config, build.id),
    src,
    css: css ?? undefined,
    map: JSON.stringify(map),
    exp: Math.floor(now() / 1000) + ttl,
    secret: config.hmacSecret,
  });
  const result = await deps.renderer.render({
    url,
    viewport: config.viewport,
    timeoutMs: config.captureTimeoutMs,
    signal,
  });
  log.info('capture.rendered', {
    ready: result.ready.reason,
    readyAfterMs: result.ready.afterMs,
    renderMs: result.durationMs,
    blocked: result.blocked,
    notes: result.notes,
  });
  const stats = pixelStats(await decodeRaw(result.png));
  if (isBlank(stats)) return { kind: 'blank', stdDev: stats.maxStdDev };
  return { kind: 'ok', png: result.png, ready: result.ready.reason, renderMs: result.durationMs };
}

async function giveUpOrRetry(
  deps: CaptureDeps,
  job: Job,
  reason: string,
  log: Logger,
): Promise<CaptureOutcome> {
  try {
    const after = await deps.backend.failJob(job.id, reason);
    if (after.status === 'failed') {
      log.warn('capture.gave_up', { reason, attempts: after.attempts });
      return { result: 'failed', reason };
    }
    log.info('capture.retry', { reason, attempts: after.attempts, runAfter: after.run_after });
    return { result: 'retry', reason, attempts: after.attempts };
  } catch (e) {
    log.error('capture.fail_job_failed', { reason, error: errorMessage(e) });
    return { result: 'error', reason: `${reason}; fail_job: ${errorMessage(e)}` };
  }
}

/** Runs one claimed capture job to an outcome. Never throws. */
export async function processCaptureJob(
  deps: CaptureDeps,
  job: Job,
  signal: AbortSignal,
): Promise<CaptureOutcome> {
  const log = deps.log.child({
    job: job.id,
    kind: 'capture',
    build: job.ref_id,
    attempt: job.attempts,
  });
  try {
    return await runCapture(deps, job, signal, log);
  } catch (e) {
    const reason = signal.aborted
      ? `aborted: ${errorMessage(signal.reason)}`
      : `unexpected: ${errorMessage(e)}`;
    log.error('capture.error', { reason });
    return giveUpOrRetry(deps, job, reason, log);
  }
}

async function runCapture(
  deps: CaptureDeps,
  job: Job,
  signal: AbortSignal,
  log: Logger,
): Promise<CaptureOutcome> {
  const { backend, config } = deps;
  if (!isUuid(job.ref_id)) return giveUpOrRetry(deps, job, 'job ref_id is not a build id', log);
  const build = await backend.getBuild(job.ref_id);
  if (!build) return giveUpOrRetry(deps, job, 'build not found', log);
  let sources: BuildSources;
  let target: string;
  try {
    sources = buildSources(build);
    target = screenshotPath(build);
  } catch (e) {
    return giveUpOrRetry(deps, job, errorMessage(e), log);
  }

  // 1. Server render.
  let attempt: RenderAttempt | null = null;
  let renderFailure: string;
  try {
    attempt = await renderBuild(deps, build, sources, signal, log);
    renderFailure =
      attempt.kind === 'missing'
        ? `${sources.kind} bundle.js is missing`
        : attempt.kind === 'blank'
          ? `blank render (max channel std dev ${attempt.stdDev.toFixed(2)})`
          : '';
  } catch (e) {
    // Shutting down or out of time: no fallback, the job goes back to the queue.
    if (signal.aborted || (e instanceof RenderError && e.code === 'aborted')) throw e;
    renderFailure = errorMessage(e);
  }

  if (attempt?.kind === 'ok') {
    const webp = await encodeWebp(attempt.png);
    await backend.upload(BUCKET_SCREENSHOTS, target, webp, 'image/webp');
    await backend.completeCapture(build.id, 'captured', target);
    log.info('capture.captured', { path: target, bytes: webp.byteLength, ready: attempt.ready });
    return { result: 'captured', path: target, ready: attempt.ready, renderMs: attempt.renderMs };
  }
  log.warn('capture.render_unusable', { reason: renderFailure });

  // 2. Fallback: the client thumbnail, re-encoded.
  const thumb = await backend.download(BUCKET_EPHEMERAL, sources.thumb);
  let thumbProblem = 'no client thumbnail';
  if (thumb) {
    let webp: Uint8Array | null = null;
    try {
      webp = await encodeWebp(thumb, { fit: config.viewport });
    } catch (e) {
      thumbProblem = `the client thumbnail is not a usable image (${errorMessage(e)})`;
    }
    if (webp) {
      await backend.upload(BUCKET_SCREENSHOTS, target, webp, 'image/webp');
      await backend.completeCapture(build.id, 'fallback', target);
      log.info('capture.fallback', { path: target, bytes: webp.byteLength, reason: renderFailure });
      return { result: 'fallback', path: target, reason: renderFailure };
    }
  }

  // 3. Nothing to show.
  const reason = `${renderFailure}; ${thumbProblem}`;
  if (attempt?.kind === 'missing' && !thumb) {
    await backend.completeCapture(build.id, 'failed', null);
    log.warn('capture.failed', { reason });
    return { result: 'failed', reason };
  }
  return giveUpOrRetry(deps, job, reason, log);
}
