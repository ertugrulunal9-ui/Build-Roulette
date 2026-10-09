/**
 * A local stand-in for Cloudflare Browser Rendering's REST API (T-034): the subset the
 * `jobs` Edge Function uses, backed by Playwright Chromium (`PlaywrightRenderer.session()`).
 * Tests and local runs point the function at it with `BROWSER_RENDERING_API_URL`, so the
 * chain function → "Browser Rendering" → shell capture page → Storage runs for real.
 *
 *   POST {base}/accounts/{account}/browser-rendering/snapshot[?cacheTTL=…]
 *   Authorization: Bearer <token>
 *   { url, viewport, gotoOptions, waitForSelector, bestAttempt, actionTimeout,
 *     waitForTimeout, screenshotOptions, formats }
 *   → 200 { success: true, result: { content, screenshot } } + X-Browser-Ms-Used
 *
 * Like the real service (Puppeteer): `goto` with `waitUntil`, then `waitForSelector`, then
 * the screenshot (CDP `Page.captureScreenshot`, which is what Puppeteer uses for WebP) and
 * the page's HTML; `bestAttempt` turns a goto or selector timeout into "go on"; there is no
 * navigation guard. Any other field is refused with 400, so the function cannot start relying
 * on something this stand-in does not implement.
 *
 * NOT the real service: the answers for page-side failures (a frozen page: 500 with
 * "Timeout"; a navigation error: 422) and the 429 body are guesses (Cloudflare does not
 * document them); `X-Browser-Ms-Used` is the request's wall time here. Test controls:
 * `inject()` answers the next requests with a status (429 with Retry-After, 503…) or hangs
 * them; `minIntervalMs` emulates the free plan's fill rate (1 request / 10 s) with 429s.
 * With `control: true` the same controls are HTTP endpoints under `/__stand-in/` (for
 * manual runs: scripts/browser-rendering-stand-in.ts).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { silentLogger, type Logger } from './log';
import { PlaywrightRenderer } from './playwright-renderer';
import { RenderError } from './renderer';

export type StandInFault =
  { status: number; retryAfterS?: number; message?: string } | { hang: true };

export interface StandInRequest {
  at: number;
  /** The `url` of the body (a signed capture URL: never log it outside tests). */
  url: string | null;
  status: number;
  browserMs: number;
  /** What the page said (`data-br-*` attributes are in `content`), for tests. */
  error?: string;
}

export interface StandInOptions {
  accountId: string;
  apiToken: string;
  port?: number;
  /** Default 0.0.0.0, so the Edge Runtime container reaches it via host.docker.internal. */
  host?: string;
  /** A renderer to share (closed by the caller); default: a new one, closed by close(). */
  renderer?: PlaywrightRenderer;
  /** Cloudflare's per-browser limit. Default 60 s. */
  browserTimeoutMs?: number;
  /** Emulates the free plan's fill rate: requests closer than this get 429. Default 0 (off). */
  minIntervalMs?: number;
  /** HTTP endpoints for the test controls under /__stand-in/ (manual runs). */
  control?: boolean;
  log?: Logger;
}

export interface BrowserRenderingStandIn {
  /** The API base on this host, e.g. http://127.0.0.1:4325/client/v4. */
  url: string;
  port: number;
  /** The API base as another host sees it (e.g. `host.docker.internal`). */
  urlFor(host: string): string;
  requests: StandInRequest[];
  inject(fault: StandInFault, count?: number): void;
  clearFaults(): void;
  close(): Promise<void>;
}

const BODY_LIMIT = 1024 * 1024;
const ALLOWED_FIELDS = new Set([
  'url',
  'viewport',
  'gotoOptions',
  'waitForSelector',
  'waitForTimeout',
  'bestAttempt',
  'actionTimeout',
  'screenshotOptions',
  'formats',
]);
const PATH_RE = /^\/client\/v4\/accounts\/([^/]+)\/browser-rendering\/snapshot$/;

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function apiError(
  res: ServerResponse,
  status: number,
  message: string,
  headers: Record<string, string> = {},
) {
  send(
    res,
    status,
    { success: false, errors: [{ code: status, message }], messages: [], result: null },
    headers,
  );
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    const chunk = c as Buffer;
    total += chunk.length;
    if (total > BODY_LIMIT) throw new ApiError(413, 'request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, what: string): number | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0)
    throw new ApiError(400, `${what} must be a number`);
  return v;
};

interface SnapshotRequest {
  url: string;
  viewport: { width: number; height: number };
  goto: { waitUntil: 'load' | 'domcontentloaded' | 'networkidle'; timeout: number };
  selector: { selector: string; timeout: number; state: 'attached' | 'visible' | 'hidden' } | null;
  waitForTimeout: number;
  bestAttempt: boolean;
  actionTimeout: number;
  shot: { format: 'png' | 'jpeg' | 'webp'; quality: number | undefined };
}

/** Validates the subset (400 for anything else). */
export function parseSnapshotRequest(raw: unknown): SnapshotRequest {
  if (!isObj(raw)) throw new ApiError(400, 'body must be a JSON object');
  for (const k of Object.keys(raw)) {
    if (!ALLOWED_FIELDS.has(k))
      throw new ApiError(400, `field not supported by the stand-in: ${k}`);
  }
  const url = raw['url'];
  if (typeof url !== 'string' || !/^https?:\/\//.test(url))
    throw new ApiError(400, 'url must be an http(s) URL');
  const vp = raw['viewport'];
  let viewport = { width: 1920, height: 1080 };
  if (vp !== undefined) {
    if (!isObj(vp)) throw new ApiError(400, 'viewport must be an object');
    const width = num(vp['width'], 'viewport.width');
    const height = num(vp['height'], 'viewport.height');
    const dsf = num(vp['deviceScaleFactor'], 'viewport.deviceScaleFactor');
    if (!width || !height) throw new ApiError(400, 'viewport needs width and height');
    if (dsf !== undefined && dsf !== 1)
      throw new ApiError(400, 'the stand-in supports deviceScaleFactor 1 only');
    viewport = { width, height };
  }
  const go = raw['gotoOptions'];
  const goto: SnapshotRequest['goto'] = { waitUntil: 'load', timeout: 30_000 };
  if (go !== undefined) {
    if (!isObj(go)) throw new ApiError(400, 'gotoOptions must be an object');
    const w = go['waitUntil'];
    if (w !== undefined) {
      if (w === 'load' || w === 'domcontentloaded') goto.waitUntil = w;
      else if (w === 'networkidle0' || w === 'networkidle2') goto.waitUntil = 'networkidle';
      else throw new ApiError(400, 'gotoOptions.waitUntil is not supported');
    }
    goto.timeout = num(go['timeout'], 'gotoOptions.timeout') ?? goto.timeout;
  }
  const ws = raw['waitForSelector'];
  let selector: SnapshotRequest['selector'] = null;
  if (ws !== undefined) {
    if (!isObj(ws) || typeof ws['selector'] !== 'string') {
      throw new ApiError(400, 'waitForSelector.selector must be a string');
    }
    selector = {
      selector: ws['selector'],
      timeout: num(ws['timeout'], 'waitForSelector.timeout') ?? 30_000,
      state: ws['visible'] === true ? 'visible' : ws['hidden'] === true ? 'hidden' : 'attached',
    };
  }
  const so = raw['screenshotOptions'];
  const shot: SnapshotRequest['shot'] = { format: 'png', quality: undefined };
  if (so !== undefined) {
    if (!isObj(so)) throw new ApiError(400, 'screenshotOptions must be an object');
    for (const k of Object.keys(so)) {
      if (!['type', 'quality', 'fullPage'].includes(k)) {
        throw new ApiError(400, `screenshotOptions.${k} is not supported by the stand-in`);
      }
    }
    const t = so['type'];
    if (t !== undefined && t !== 'png' && t !== 'jpeg' && t !== 'webp') {
      throw new ApiError(400, 'screenshotOptions.type must be png, jpeg or webp');
    }
    if (t) shot.format = t;
    shot.quality = num(so['quality'], 'screenshotOptions.quality');
    if (so['fullPage'] === true)
      throw new ApiError(400, 'fullPage is not supported by the stand-in');
  }
  const formats = raw['formats'];
  if (formats !== undefined) {
    if (!Array.isArray(formats) || formats.some((f) => f !== 'content' && f !== 'screenshot')) {
      throw new ApiError(400, 'formats: the stand-in supports content and screenshot');
    }
  }
  return {
    url,
    viewport,
    goto,
    selector,
    waitForTimeout: num(raw['waitForTimeout'], 'waitForTimeout') ?? 0,
    bestAttempt: raw['bestAttempt'] === true,
    actionTimeout: num(raw['actionTimeout'], 'actionTimeout') ?? 30_000,
    shot,
  };
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new RenderError('timeout', `${what} timed out after ${String(ms)} ms`));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

export async function startBrowserRenderingStandIn(
  opts: StandInOptions,
): Promise<BrowserRenderingStandIn> {
  const log = opts.log ?? silentLogger;
  const renderer = opts.renderer ?? new PlaywrightRenderer({ log });
  const ownRenderer = !opts.renderer;
  const browserTimeoutMs = opts.browserTimeoutMs ?? 60_000;
  const requests: StandInRequest[] = [];
  const faults: StandInFault[] = [];
  const hanging = new Set<ServerResponse>();
  let lastAccepted = Number.NEGATIVE_INFINITY;
  const minIntervalMs = opts.minIntervalMs ?? 0;

  async function snapshot(body: SnapshotRequest): Promise<{ content: string; screenshot: string }> {
    return renderer.session(
      {
        url: body.url,
        viewport: body.viewport,
        timeoutMs: browserTimeoutMs,
        navigationGuard: false,
      },
      async (s) => {
        try {
          await s.page.goto(body.url, {
            waitUntil: body.goto.waitUntil,
            timeout: body.goto.timeout,
          });
        } catch (e) {
          if (!body.bestAttempt) throw e;
        }
        if (body.selector) {
          try {
            await s.page.waitForSelector(body.selector.selector, {
              state: body.selector.state,
              timeout: body.selector.timeout,
            });
          } catch (e) {
            if (!body.bestAttempt) throw e;
          }
        }
        if (body.waitForTimeout > 0) await s.page.waitForTimeout(body.waitForTimeout);
        const cdp = await s.context.newCDPSession(s.page);
        const shot = await withTimeout(
          cdp.send('Page.captureScreenshot', {
            format: body.shot.format,
            ...(body.shot.quality === undefined ? {} : { quality: body.shot.quality }),
          }),
          body.actionTimeout,
          'screenshot',
        );
        const content = await withTimeout(s.page.content(), body.actionTimeout, 'content');
        return { content, screenshot: shot.data };
      },
    );
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? '/', 'http://stand-in').pathname;
    if (opts.control && path.startsWith('/__stand-in/')) {
      if (path === '/__stand-in/faults' && req.method === 'POST') {
        const f = JSON.parse(await readBody(req)) as StandInFault & { count?: number };
        for (let i = 0; i < (f.count ?? 1); i++) faults.push(f);
        send(res, 200, { queued: faults.length });
      } else if (path === '/__stand-in/faults' && req.method === 'DELETE') {
        faults.length = 0;
        send(res, 200, { queued: 0 });
      } else if (path === '/__stand-in/requests') {
        send(
          res,
          200,
          requests.map((r) => ({ ...r, url: r.url ? new URL(r.url).origin : null })),
        );
      } else {
        apiError(res, 404, 'unknown control endpoint');
      }
      return;
    }
    const m = PATH_RE.exec(path);
    if (!m || req.method !== 'POST') {
      apiError(res, 404, 'not implemented by the stand-in');
      return;
    }
    if (
      decodeURIComponent(m[1] ?? '') !== opts.accountId ||
      req.headers.authorization !== `Bearer ${opts.apiToken}`
    ) {
      apiError(res, 401, 'Authentication error');
      return;
    }
    const started = Date.now();
    const entry: StandInRequest = { at: started, url: null, status: 0, browserMs: 0 };
    requests.push(entry);
    let body: SnapshotRequest;
    try {
      const text = await readBody(req);
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new ApiError(400, 'body is not JSON');
      }
      entry.url = isObj(raw) && typeof raw['url'] === 'string' ? raw['url'] : null;
      body = parseSnapshotRequest(raw);
    } catch (e) {
      entry.status = e instanceof ApiError ? e.status : 400;
      entry.error = e instanceof Error ? e.message : String(e);
      apiError(res, entry.status, entry.error);
      return;
    }
    const fault = faults.shift();
    if (fault && 'hang' in fault) {
      entry.status = -1;
      hanging.add(res);
      return;
    }
    if (fault) {
      entry.status = fault.status;
      apiError(res, fault.status, fault.message ?? `injected ${String(fault.status)}`, {
        ...(fault.retryAfterS === undefined ? {} : { 'retry-after': String(fault.retryAfterS) }),
      });
      return;
    }
    if (started < lastAccepted + minIntervalMs) {
      const wait = Math.ceil((lastAccepted + minIntervalMs - started) / 1000);
      entry.status = 429;
      apiError(res, 429, 'Rate limit exceeded', { 'retry-after': String(wait) });
      return;
    }
    lastAccepted = started;
    try {
      const result = await snapshot(body);
      entry.browserMs = Date.now() - started;
      entry.status = 200;
      send(
        res,
        200,
        { success: true, errors: [], messages: [], result },
        {
          'x-browser-ms-used': String(entry.browserMs),
        },
      );
    } catch (e) {
      entry.browserMs = Date.now() - started;
      const timeout = e instanceof RenderError && e.code === 'timeout';
      entry.status = timeout ? 500 : 422;
      entry.error = e instanceof Error ? e.message : String(e);
      apiError(res, entry.status, timeout ? `Timeout: ${entry.error}` : entry.error, {
        'x-browser-ms-used': String(entry.browserMs),
      });
    }
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      log.error('stand_in.error', { error: e instanceof Error ? e.message : String(e) });
      if (!res.headersSent) apiError(res, 500, 'stand-in error');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, opts.host ?? '0.0.0.0', () => {
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  const urlFor = (host: string) => `http://${host}:${String(port)}/client/v4`;
  return {
    url: urlFor('127.0.0.1'),
    port,
    urlFor,
    requests,
    inject: (fault, count = 1) => {
      for (let i = 0; i < count; i++) faults.push(fault);
    },
    clearFaults: () => {
      faults.length = 0;
    },
    close: async () => {
      for (const r of hanging) r.destroy();
      hanging.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      if (ownRenderer) await renderer.close();
    },
  };
}
