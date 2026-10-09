/**
 * The Browser Rendering REST renderer (T-034) against a fake `fetch`: the request it builds,
 * how it reads the answer (the capture page's report in the HTML), and how it classifies
 * failures, rate limits and pacing.
 */
import { describe, expect, it } from 'vitest';
import {
  BROWSER_RENDERING_API_URL,
  BrowserRenderingRenderer,
  CAPTURE_SIGNAL_SELECTOR,
  browserMsHeader,
  errorForStatus,
  htmlElementAttributes,
  parseRetryAfter,
  readCaptureReport,
  snapshotRequestBody,
  snapshotUrl,
  type BrowserRenderingOptions,
} from '../src/browser-rendering';
import { classifyRenderFailure } from '../src/capture-policy';
import { createLogger } from '../src/log';
import { RenderError, type RenderRequest } from '../src/renderer';
import { bodyText, urlOf } from './fakes';

const REQ: RenderRequest = {
  url: 'https://b1.usercontent.test/v1/capture?src=https%3A%2F%2Fx.supabase.co%2Fsign%3Ftoken%3Dsecret&sig=abc',
  viewport: { width: 1280, height: 800 },
  timeoutMs: 5000,
};
const WEBP = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]);
const B64 = btoa(String.fromCharCode(...WEBP));

function page(attrs: string): string {
  return `<!DOCTYPE html><html lang="en" data-br-capture-page="1" ${attrs}><head></head><body><iframe></iframe></body></html>`;
}

function ok(content: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ success: true, result: { content, screenshot: B64 } }), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function fail(status: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ success: false, errors: [{ code: status, message }] }), {
    status,
    headers,
  });
}

interface Call {
  url: string;
  init: RequestInit;
  at: number;
}

function renderer(
  answers: (Response | Error | (() => Promise<Response>))[],
  opts: Partial<BrowserRenderingOptions> = {},
) {
  const calls: Call[] = [];
  const lines: string[] = [];
  const r = new BrowserRenderingRenderer({
    accountId: 'acc123',
    apiToken: 'tok',
    minIntervalMs: 0,
    log: createLogger({ write: (l) => lines.push(l) }),
    fetch: (input, init) => {
      calls.push({ url: urlOf(input), init: init ?? {}, at: Date.now() });
      const next = answers.shift();
      if (!next) return Promise.reject(new Error('no more answers'));
      if (next instanceof Error) return Promise.reject(next);
      return typeof next === 'function' ? next() : Promise.resolve(next);
    },
    ...opts,
  });
  return { r, calls, lines };
}

async function renderError(p: Promise<unknown>): Promise<RenderError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  if (!(e instanceof RenderError)) throw new Error(`expected a RenderError, got ${String(e)}`);
  return e;
}

describe('the REST request', () => {
  it('is a /snapshot call: viewport at DPR 1, load, the ready selector capped at 6 s, WebP at 82', () => {
    expect(snapshotUrl(BROWSER_RENDERING_API_URL, 'acc123')).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acc123/browser-rendering/snapshot?cacheTTL=0',
    );
    expect(snapshotRequestBody(REQ)).toEqual({
      url: REQ.url,
      viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
      gotoOptions: { waitUntil: 'load', timeout: 10_000 },
      waitForSelector: { selector: CAPTURE_SIGNAL_SELECTOR, timeout: 6000 },
      bestAttempt: true,
      actionTimeout: 10_000,
      screenshotOptions: { type: 'webp', quality: 82, fullPage: false },
    });
    expect(CAPTURE_SIGNAL_SELECTOR).toBe('html[data-br-capture]');
  });

  it('sends the token as a Bearer header and the body as JSON', async () => {
    const { r, calls } = renderer([ok(page('data-br-capture="ready" data-br-paint="content"'))], {
      apiUrl: 'http://stand-in.test:4325/client/v4/',
    });
    await r.render(REQ);
    expect(calls[0]?.url).toBe(
      'http://stand-in.test:4325/client/v4/accounts/acc123/browser-rendering/snapshot?cacheTTL=0',
    );
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.headers).toMatchObject({
      authorization: 'Bearer tok',
      'content-type': 'application/json',
    });
    expect(JSON.parse(bodyText(calls[0]?.init))).toEqual(snapshotRequestBody(REQ));
  });
});

describe('the answer', () => {
  it('a ready build: WebP bytes, ready by signal, paint from the page, browser time from the header', async () => {
    const { r } = renderer([
      ok(page('data-br-capture="ready" data-br-paint="content"'), { 'x-browser-ms-used': '2345' }),
    ]);
    const out = await r.render(REQ);
    expect(out.image).toEqual(WEBP);
    expect(out.format).toBe('webp');
    expect(out.ready.reason).toBe('signal');
    expect(out.paint).toBe('content');
    expect(out.browserMs).toBe(2345);
  });

  it('no signal: the cap; no header: the wall time counts; a page without a paint report is empty', async () => {
    const { r } = renderer([ok(page(''))]);
    const out = await r.render(REQ);
    expect(out.ready.reason).toBe('cap');
    expect(out.paint).toBe('empty');
    expect(out.browserMs).toBeGreaterThanOrEqual(0);
    expect(out.browserMs).toBe(out.durationMs);
  });

  it('the page failed: a render failure with the page text (URLs redacted)', async () => {
    const { r } = renderer([
      ok(
        page(
          'data-br-capture="failed" data-br-capture-error="bundle.js: HTTP 404 https://x.test/a?token=s"',
        ),
      ),
    ]);
    const e = await renderError(r.render(REQ));
    expect(e.code).toBe('navigation');
    expect(e.message).toContain('bundle.js: HTTP 404');
    expect(e.message).not.toContain('token=s');
    expect(classifyRenderFailure(e)).toBe('render');
  });

  it('the capture page was not served (the gate refused): shell-refused', async () => {
    const { r } = renderer([ok('<html><head></head><body></body></html>')]);
    expect((await renderError(r.render(REQ))).code).toBe('shell-refused');
  });

  it('a 200 that is not the expected envelope: the service is unavailable', async () => {
    const { r } = renderer([new Response('not json', { status: 200 })]);
    expect((await renderError(r.render(REQ))).code).toBe('unavailable');
    const { r: r2 } = renderer([
      new Response(JSON.stringify({ success: false, errors: [] }), { status: 200 }),
    ]);
    expect((await renderError(r2.render(REQ))).code).toBe('unavailable');
  });

  it('an answer over the size limit (the page grew its HTML): a render failure', async () => {
    const { r } = renderer([ok(page(`data-x="${'a'.repeat(5000)}"`))], { maxResponseBytes: 2000 });
    const e = await renderError(r.render(REQ));
    expect(e.code).toBe('screenshot');
    expect(classifyRenderFailure(e)).toBe('render');
  });
});

describe('failures', () => {
  it('maps HTTP statuses: auth and 5xx are the service, 4xx and 5xx timeouts are the page', () => {
    expect(errorForStatus(401, '{}', 0, null).code).toBe('unavailable');
    expect(errorForStatus(403, '{}', 0, null).code).toBe('unavailable');
    expect(errorForStatus(400, '{}', 0, null).code).toBe('unavailable');
    expect(
      errorForStatus(503, '{"errors":[{"code":1,"message":"overloaded"}]}', 0, null).code,
    ).toBe('unavailable');
    expect(
      errorForStatus(
        500,
        '{"errors":[{"code":1,"message":"Navigation timeout of 10000 ms exceeded"}]}',
        0,
        null,
      ).code,
    ).toBe('timeout');
    expect(errorForStatus(422, '{}', 0, null).code).toBe('navigation');
    expect(errorForStatus(429, '{}', 0, 3000)).toMatchObject({
      code: 'rate-limited',
      extra: { retryAfterMs: 3000 },
    });
  });

  it('a refused token is logged as an error (a configuration problem) and retried later', async () => {
    const { r, lines } = renderer([fail(401, 'Authentication error')]);
    const e = await renderError(r.render(REQ));
    expect(e.code).toBe('unavailable');
    expect(classifyRenderFailure(e)).toBe('service');
    expect(
      lines.some((l) => l.includes('"level":"error"') && l.includes('renderer.request_refused')),
    ).toBe(true);
  });

  it('a network error or no answer in time: unavailable, with the time spent counted', async () => {
    const { r } = renderer([new TypeError('fetch failed')]);
    expect((await renderError(r.render(REQ))).code).toBe('unavailable');
    const slow = renderer([
      () =>
        new Promise<Response>((_, reject) => {
          setTimeout(() => {
            reject(new DOMException('timed out', 'TimeoutError'));
          }, 60);
        }),
    ]);
    const e = await renderError(slow.r.render({ ...REQ, timeoutMs: 50 }));
    expect(e.code).toBe('unavailable');
    expect(e.extra.browserMs).toBeGreaterThanOrEqual(40);
  });

  it('an abort of the caller (shutdown, end of the run) is `aborted`', async () => {
    const ctrl = new AbortController();
    const { r } = renderer([
      () =>
        new Promise<Response>((_, reject) => {
          setTimeout(() => {
            ctrl.abort();
            reject(new DOMException('aborted', 'AbortError'));
          }, 10);
        }),
    ]);
    expect((await renderError(r.render({ ...REQ, signal: ctrl.signal }))).code).toBe('aborted');
  });
});

describe('rate limits', () => {
  it('a 429 with a short Retry-After is retried once in place', async () => {
    const { r, calls } = renderer([
      fail(429, 'Rate limit exceeded', { 'retry-after': '0' }),
      ok(page('data-br-capture="ready" data-br-paint="content"')),
    ]);
    const out = await r.render(REQ);
    expect(calls).toHaveLength(2);
    expect(out.ready.reason).toBe('signal');
  });

  it('a 429 with a long or missing Retry-After, or a second 429: rate-limited, no browser time', async () => {
    const long = renderer([fail(429, 'x', { 'retry-after': '60' })]);
    const e = await renderError(long.r.render(REQ));
    expect(e).toMatchObject({
      code: 'rate-limited',
      extra: { retryAfterMs: 60_000, browserMs: 0 },
    });
    expect(classifyRenderFailure(e)).toBe('service');
    expect(long.calls).toHaveLength(1);

    const twice = renderer([
      fail(429, 'x', { 'retry-after': '0' }),
      fail(429, 'x', { 'retry-after': '0' }),
    ]);
    expect((await renderError(twice.r.render(REQ))).code).toBe('rate-limited');
    expect(twice.calls).toHaveLength(2);

    const none = renderer([fail(429, 'x')]);
    expect((await renderError(none.r.render(REQ))).code).toBe('rate-limited');
  });

  it('spaces its calls minIntervalMs apart (the free plan: one every 10 s)', async () => {
    const answer = () => ok(page('data-br-capture="ready" data-br-paint="content"'));
    const { r, calls } = renderer([answer(), answer()], { minIntervalMs: 150 });
    await r.render(REQ);
    await r.render(REQ);
    expect((calls[1]?.at ?? 0) - (calls[0]?.at ?? 0)).toBeGreaterThanOrEqual(145);
  });

  it('parses Retry-After as seconds or an HTTP date', () => {
    const now = Date.parse('2026-10-09T12:00:00Z');
    expect(parseRetryAfter('10', now)).toBe(10_000);
    expect(parseRetryAfter('Fri, 09 Oct 2026 12:00:30 GMT', now)).toBe(30_000);
    expect(parseRetryAfter('Fri, 09 Oct 2026 11:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfter(null, now)).toBeNull();
    expect(parseRetryAfter('soon', now)).toBeNull();
  });

  it('reads X-Browser-Ms-Used only when it is a number', () => {
    expect(browserMsHeader(new Headers({ 'x-browser-ms-used': '1520' }))).toBe(1520);
    expect(browserMsHeader(new Headers({ 'x-browser-ms-used': '12.6' }))).toBe(13);
    expect(browserMsHeader(new Headers({ 'x-browser-ms-used': 'lots' }))).toBeNull();
    expect(browserMsHeader(new Headers())).toBeNull();
  });
});

describe("the capture page's report", () => {
  it('reads the attributes of <html> after the doctype and comments, with entities', () => {
    const attrs = htmlElementAttributes(
      `\uFEFF<!DOCTYPE html>\n<!-- c --><html lang=en data-br-capture='ready' data-br-capture-error="a &amp; b &quot;c&quot; &#60;d&#x3e;" data-flag><head>`,
    );
    expect(attrs?.get('lang')).toBe('en');
    expect(attrs?.get('data-br-capture')).toBe('ready');
    expect(attrs?.get('data-br-capture-error')).toBe('a & b "c" <d>');
    expect(attrs?.has('data-flag')).toBe(true);
    expect(htmlElementAttributes('<body></body>')).toBeNull();
  });

  it('only the document element counts: a marker in a comment or the body is not the page', () => {
    expect(
      readCaptureReport('<!--<html data-br-capture-page="1">--><html><body></body></html>').page,
    ).toBe(false);
    expect(readCaptureReport('<html><body data-br-capture-page="1"></body></html>').page).toBe(
      false,
    );
    expect(readCaptureReport(page('data-br-capture="ready" data-br-paint="empty"'))).toEqual({
      page: true,
      state: 'ready',
      paint: 'empty',
      detail: null,
    });
    expect(readCaptureReport(page('data-br-capture="weird" data-br-paint="maybe"'))).toMatchObject({
      state: null,
      paint: null,
    });
  });
});
