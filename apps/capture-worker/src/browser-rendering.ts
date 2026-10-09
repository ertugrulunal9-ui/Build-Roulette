/**
 * Cloudflare Browser Rendering through its REST API (T-034): the renderer of the `jobs`
 * Edge Function on the free plan. Plain `fetch`, no Node APIs (it runs in Deno).
 *
 * One capture = one `POST /accounts/{account}/browser-rendering/snapshot?cacheTTL=0`:
 *
 *   { url: <signed capture URL>,
 *     viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
 *     gotoOptions: { waitUntil: 'load', timeout: 10000 },
 *     waitForSelector: { selector: 'html[data-br-capture]', timeout: 6000 },  // the cap
 *     bestAttempt: true,          // the cap passing is not an error: shoot anyway
 *     actionTimeout: 10000,       // a frozen page cannot hold the screenshot forever
 *     screenshotOptions: { type: 'webp', quality: 82, fullPage: false } }
 *
 * → `{ success, result: { content: <the page's HTML>, screenshot: <base64 WebP> } }`.
 *
 * Why `/snapshot` and not `/screenshot`: it takes the same options and returns the
 * screenshot AND the capture page's HTML from the same browser session. The capture page
 * (apps/sandbox-shell/src/capture.ts) reports on its `<html>` element whether it loaded
 * (`data-br-capture-page`), whether the build signalled ready or the page failed
 * (`data-br-capture`), and whether the build's frame has anything rendered in it
 * (`data-br-paint`). That replaces the worker's pixel check, which needs a WebP decoder the
 * function does not have. The attributes are untrusted (the build can run code in that
 * realm), but a build can only affect its own screenshot with them.
 *
 * Readiness: the build's `window.buildRoulette.ready()` sets `data-br-capture="ready"`, so
 * the shot is taken at once; otherwise the 6 s cap (`waitForSelector`'s timeout, with
 * `bestAttempt`). Unlike the Playwright renderer there is no "network idle + 2 s" (the REST
 * API cannot express "first of"); the templates call ready(), and a build that does not
 * waits the full cap. There is no navigation guard either (the capture page's CSP sandbox
 * still blocks popups, modals and downloads); a build that navigates its page away has its
 * shot taken of whatever it navigated to, which it could have painted itself.
 *
 * Rate limits (Workers Free: REST requests at 1 every 10 s, i.e. 6 a minute): calls are
 * spaced `minIntervalMs` apart; a 429 is retried once in place when its `Retry-After` is
 * short, otherwise it is a `rate-limited` RenderError (the capture job retries later, then
 * falls back: capture-policy.ts).
 *
 * Browser time: the `X-Browser-Ms-Used` response header when present (reported by
 * Cloudflare since 2025-08; not in the API schema, so not relied on), else the call's wall
 * time, which is at least the browser time.
 *
 * Field names are from Cloudflare's OpenAPI schema (the `cloudflare` npm SDK 7.3.0,
 * `browser-rendering/snapshot`); the behaviour of `bestAttempt` and the status codes of
 * page-side failures are not documented in detail and are handled conservatively below.
 */
import type { Logger } from './log';
import { silentLogger } from './log';
import {
  RenderError,
  type PaintReport,
  type RenderRequest,
  type RenderResult,
  type Renderer,
} from './renderer';
import { SCREENSHOT_WEBP_QUALITY } from './imaging';

export const BROWSER_RENDERING_API_URL = 'https://api.cloudflare.com/client/v4';
/** The capture page sets `data-br-capture` to `ready` or `failed` (apps/sandbox-shell). */
export const CAPTURE_SIGNAL_SELECTOR = 'html[data-br-capture]';
/** Workers Free: 6 REST requests a minute, enforced as one every 10 s. */
export const FREE_PLAN_MIN_INTERVAL_MS = 10_000;

export interface BrowserRenderingOptions {
  accountId: string;
  /** API token with "Browser Rendering - Edit". Never logged. */
  apiToken: string;
  /** Default `https://api.cloudflare.com/client/v4`; the local stand-in in tests. */
  apiUrl?: string;
  /** The readiness cap: `waitForSelector`'s timeout. Default 6000. */
  capMs?: number;
  gotoTimeoutMs?: number;
  actionTimeoutMs?: number;
  quality?: number;
  /** Space between two calls of this renderer. Default 10 s (Workers Free). */
  minIntervalMs?: number;
  /** A 429 whose Retry-After is at most this long is retried in place. Default 12 s. */
  maxInlineRetryAfterMs?: number;
  /** How many times a 429 is retried in place. Default 1. */
  rateLimitRetries?: number;
  /** Largest answer read (the page's HTML is the build's to grow). Default 8 MiB. */
  maxResponseBytes?: number;
  fetch?: typeof fetch;
  now?: () => number;
  log?: Logger;
}

const DEFAULTS = {
  apiUrl: BROWSER_RENDERING_API_URL,
  capMs: 6000,
  gotoTimeoutMs: 10_000,
  actionTimeoutMs: 10_000,
  quality: SCREENSHOT_WEBP_QUALITY,
  minIntervalMs: FREE_PLAN_MIN_INTERVAL_MS,
  maxInlineRetryAfterMs: 12_000,
  rateLimitRetries: 1,
  maxResponseBytes: 8 * 1024 * 1024,
};

/** The request body of a capture (see the module comment). */
export function snapshotRequestBody(
  req: Pick<RenderRequest, 'url' | 'viewport'>,
  opts: Pick<
    BrowserRenderingOptions,
    'capMs' | 'gotoTimeoutMs' | 'actionTimeoutMs' | 'quality'
  > = {},
): Record<string, unknown> {
  return {
    url: req.url,
    viewport: { width: req.viewport.width, height: req.viewport.height, deviceScaleFactor: 1 },
    gotoOptions: { waitUntil: 'load', timeout: opts.gotoTimeoutMs ?? DEFAULTS.gotoTimeoutMs },
    waitForSelector: { selector: CAPTURE_SIGNAL_SELECTOR, timeout: opts.capMs ?? DEFAULTS.capMs },
    bestAttempt: true,
    actionTimeout: opts.actionTimeoutMs ?? DEFAULTS.actionTimeoutMs,
    screenshotOptions: { type: 'webp', quality: opts.quality ?? DEFAULTS.quality, fullPage: false },
  };
}

/** `…/accounts/{id}/browser-rendering/snapshot?cacheTTL=0` (no cached answers). */
export function snapshotUrl(apiUrl: string, accountId: string): string {
  return `${apiUrl.replace(/\/+$/, '')}/accounts/${encodeURIComponent(accountId)}/browser-rendering/snapshot?cacheTTL=0`;
}

/** `Retry-After` in ms (delta seconds or an HTTP date), or null when absent or unusable. */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (value === null) return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - nowMs);
}

/** The browser time a response reports (`X-Browser-Ms-Used`), or null. */
export function browserMsHeader(headers: Headers): number | null {
  const raw = headers.get('x-browser-ms-used');
  if (raw === null || !/^\d+(\.\d+)?$/.test(raw.trim())) return null;
  return Math.round(Number(raw));
}

export interface CaptureReport {
  /** The capture page was served (its `<html data-br-capture-page>` marker). */
  page: boolean;
  /** `ready`: the build's signal; `failed`: the page could not run the build. */
  state: 'ready' | 'failed' | null;
  paint: PaintReport | null;
  /** The page's failure text (untrusted, for logs), capped. */
  detail: string | null;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s: string): string {
  return s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e.startsWith('#x') || e.startsWith('#X'))
      return String.fromCodePoint(parseInt(e.slice(2), 16) || 0xfffd);
    if (e.startsWith('#')) return String.fromCodePoint(Number(e.slice(1)) || 0xfffd);
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * The attributes of the document element in serialized HTML (what `/snapshot` returns as
 * `content`), or null when the document does not start with `<html`. Comments and the
 * doctype before it are skipped.
 */
export function htmlElementAttributes(html: string): Map<string, string> | null {
  let i = 0;
  for (;;) {
    while (i < html.length && /[\s﻿]/.test(html[i] ?? '')) i++;
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      if (end < 0) return null;
      i = end + 3;
    } else if (/^<!doctype/i.test(html.slice(i, i + 9))) {
      const end = html.indexOf('>', i);
      if (end < 0) return null;
      i = end + 1;
    } else {
      break;
    }
  }
  if (!/^<html[\s>/]/i.test(html.slice(i, i + 6))) return null;
  i += 5;
  const attrs = new Map<string, string>();
  const re = /\s*([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?|\s*\/?>/y;
  re.lastIndex = i;
  for (let n = 0; n < 200; n++) {
    const m = re.exec(html);
    if (!m) return attrs;
    if (m[1] === undefined) return attrs; // the end of the start tag
    const name = m[1].toLowerCase();
    if (!attrs.has(name)) attrs.set(name, decodeEntities(m[2] ?? m[3] ?? m[4] ?? ''));
  }
  return attrs;
}

/** What the capture page reported (see the module comment). */
export function readCaptureReport(html: string): CaptureReport {
  const attrs = htmlElementAttributes(html);
  if (!attrs?.has('data-br-capture-page'))
    return { page: false, state: null, paint: null, detail: null };
  const state = attrs.get('data-br-capture');
  const paint = attrs.get('data-br-paint');
  const detail = attrs.get('data-br-capture-error');
  return {
    page: true,
    state: state === 'ready' || state === 'failed' ? state : null,
    paint: paint === 'content' || paint === 'empty' ? paint : null,
    detail: detail ? detail.slice(0, 300) : null,
  };
}

/** Replaces URLs with origin + path (signed URLs carry tokens). Same rule as the worker. */
function redact(message: string): string {
  return message.replace(/\bhttps?:\/\/[^\s"'<>]+/g, (url) => {
    try {
      const u = new URL(url);
      return `${u.origin}${u.pathname}${u.search ? '?…' : ''}`;
    } catch {
      return '(url)';
    }
  });
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The body as text, or null when it is over `max` bytes (reading stops there). */
async function readLimited(res: Response, max: number): Promise<string | null> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

interface ApiEnvelope {
  success?: boolean;
  result?: { content?: unknown; screenshot?: unknown };
  errors?: { code?: number; message?: string }[];
}

function apiErrors(text: string): string {
  try {
    const body = JSON.parse(text) as ApiEnvelope;
    const msgs = (body.errors ?? []).map((e) =>
      `${String(e.code ?? '')} ${e.message ?? ''}`.trim(),
    );
    if (msgs.length > 0) return redact(msgs.join('; ')).slice(0, 300);
  } catch {
    // not JSON
  }
  return redact(text.slice(0, 200));
}

/** A failed answer as a RenderError (see the module comment for the reasoning). */
export function errorForStatus(
  status: number,
  body: string,
  browserMs: number,
  retryAfterMs: number | null,
): RenderError {
  const detail = apiErrors(body);
  const extra = { browserMs, ...(retryAfterMs === null ? {} : { retryAfterMs }) };
  if (status === 429) return new RenderError('rate-limited', `HTTP 429 ${detail}`, extra);
  if (status === 401 || status === 403) {
    return new RenderError(
      'unavailable',
      `HTTP ${String(status)}: the API token was refused (${detail})`,
      extra,
    );
  }
  if (status === 400)
    return new RenderError('unavailable', `HTTP 400: request refused (${detail})`, extra);
  if (status >= 500) {
    // A page that froze the browser can surface as a 5xx timeout: the build's fault.
    if (/time(d)? ?out|navigat|net::err/i.test(detail)) {
      return new RenderError('timeout', `HTTP ${String(status)} ${detail}`, extra);
    }
    return new RenderError('unavailable', `HTTP ${String(status)} ${detail}`, extra);
  }
  // Other 4xx (e.g. 422): the page could not be rendered.
  return new RenderError('navigation', `HTTP ${String(status)} ${detail}`, extra);
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RenderError('aborted', 'aborted'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new RenderError('aborted', 'aborted while waiting'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class BrowserRenderingRenderer implements Renderer {
  private readonly o: typeof DEFAULTS & BrowserRenderingOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly log: Logger;
  private lastCallAt = Number.NEGATIVE_INFINITY;

  constructor(opts: BrowserRenderingOptions) {
    this.o = { ...DEFAULTS, ...opts };
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? silentLogger;
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  async render(req: RenderRequest): Promise<RenderResult> {
    const url = snapshotUrl(this.o.apiUrl, this.o.accountId);
    const body = JSON.stringify(snapshotRequestBody(req, this.o));
    let browserMs = 0;
    for (let attempt = 0; ; attempt++) {
      const wait = this.lastCallAt + this.o.minIntervalMs - this.now();
      if (wait > 0) await sleep(wait, req.signal);
      this.lastCallAt = this.now();
      const started = this.now();
      const timeout = AbortSignal.timeout(req.timeoutMs);
      const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
      let res: Response;
      let text: string | null;
      try {
        res = await this.fetchImpl(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.o.apiToken}`,
            'content-type': 'application/json',
          },
          body,
          signal,
        });
        text = await readLimited(res, this.o.maxResponseBytes);
      } catch (e) {
        const elapsed = this.now() - started;
        if (req.signal?.aborted) {
          throw new RenderError('aborted', 'aborted during the REST call', {
            browserMs: browserMs + elapsed,
          });
        }
        const why = timeout.aborted
          ? `no answer within ${String(req.timeoutMs)} ms`
          : redact(e instanceof Error ? e.message : String(e));
        throw new RenderError('unavailable', `Browser Rendering: ${why}`, {
          browserMs: browserMs + elapsed,
        });
      }
      const elapsed = this.now() - started;
      const used = res.status === 429 ? 0 : (browserMsHeader(res.headers) ?? elapsed);
      browserMs += used;
      if (text === null) {
        // Only the page's HTML can grow that large: the build's doing.
        throw new RenderError(
          'screenshot',
          `the answer is over ${String(this.o.maxResponseBytes)} bytes`,
          {
            browserMs,
          },
        );
      }

      if (res.status === 429) {
        const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'), this.now());
        if (
          attempt < this.o.rateLimitRetries &&
          retryAfterMs !== null &&
          retryAfterMs <= this.o.maxInlineRetryAfterMs
        ) {
          this.log.info('renderer.rate_limited_wait', { retryAfterMs });
          await sleep(retryAfterMs, req.signal);
          continue;
        }
        throw errorForStatus(429, text, browserMs, retryAfterMs);
      }
      if (res.status !== 200) {
        const err = errorForStatus(res.status, text, browserMs, null);
        if (res.status === 400 || res.status === 401 || res.status === 403) {
          this.log.error('renderer.request_refused', { status: res.status, error: err.message });
        }
        throw err;
      }
      return this.toResult(text, elapsed, browserMs);
    }
  }

  private toResult(text: string, elapsed: number, browserMs: number): RenderResult {
    let envelope: ApiEnvelope;
    try {
      envelope = JSON.parse(text) as ApiEnvelope;
    } catch {
      throw new RenderError('unavailable', 'Browser Rendering answered 200 without JSON', {
        browserMs,
      });
    }
    const content = envelope.result?.content;
    const shot = envelope.result?.screenshot;
    if (envelope.success === false || typeof content !== 'string' || typeof shot !== 'string') {
      throw new RenderError('unavailable', `unexpected answer: ${apiErrors(text)}`, { browserMs });
    }
    const report = readCaptureReport(content);
    if (!report.page) {
      throw new RenderError(
        'shell-refused',
        'the capture page was not served (the capture gate refused the URL, or it did not load)',
        { browserMs },
      );
    }
    if (report.state === 'failed') {
      throw new RenderError(
        'navigation',
        `capture page: failed ${redact(report.detail ?? '')}`.trim(),
        {
          browserMs,
        },
      );
    }
    let image: Uint8Array;
    try {
      image = base64ToBytes(shot);
    } catch {
      throw new RenderError('screenshot', 'the screenshot is not base64', { browserMs });
    }
    return {
      image,
      format: 'webp',
      ready: { reason: report.state === 'ready' ? 'signal' : 'cap', afterMs: elapsed },
      durationMs: elapsed,
      paint: report.paint ?? 'empty',
      browserMs,
      blocked: { navigations: 0, popups: 0 },
      notes: report.detail ? [redact(report.detail)] : [],
    };
  }
}
