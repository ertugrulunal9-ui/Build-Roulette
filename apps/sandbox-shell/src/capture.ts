/**
 * Build Roulette capture page (docs/03 §3.7), `/v{N}/capture`, loaded TOP-LEVEL by the
 * capture renderer (Playwright locally, Cloudflare Browser Rendering in production).
 *
 * The page is only served by the capture gate after it verified the HMAC over the exact
 * query (`capture-gate.ts`), so this script can use `location.search` as is. It:
 *   1. wipes the origin's storage (a renderer may reuse a browser session);
 *   2. fetches the bundle JS (and CSS) from the short-lived signed URLs, `no-store`;
 *   3. validates the import map (`map`, JSON) with the protocol schema;
 *   4. runs the build in a fresh child frame at the fixed 1280×800 viewport, exactly like
 *      the preview shell does (`build-frame.ts`). `Math.random` and timers are NOT stubbed.
 *
 * Readiness is decided by the renderer, never by this page: the build can run code in this
 * realm, so everything this page reports is a hint. It reports through console lines that
 * start with `[br-capture]` (`ready`, `loaded`, `error …`, `failed …`). `ready` is sent when
 * the build calls `window.buildRoulette.ready()`; the renderer then waits for that, or for
 * network idle + 2 s, capped at 6 s (apps/capture-worker).
 *
 * For renderers that can only wait for a selector and read the page's HTML (T-034: Browser
 * Rendering's REST `/snapshot`, used by the `jobs` Edge Function), the same facts are
 * attributes of `<html>`:
 *   data-br-capture-page   in the served HTML (capture-gate.ts): the gate served this page
 *   data-br-capture        `ready` (the build's signal) or `failed` (this page could not run
 *                          the build), with `data-br-capture-error` (short text)
 *   data-br-paint          `content` or `empty`: whether the build's frame shows anything
 *                          (paint.ts), kept current every 250 ms and at the ready signal
 *
 * The page response carries a CSP `sandbox` directive (no popups, no modals, no downloads),
 * and the renderer aborts any top-level navigation away from the capture URL.
 */
import { ImportMapSchema, LIMITS, type ImportMap } from '@br/protocol';
import { createChildFrame, injectBuild, installBuildApi, openBuildDocument } from './build-frame';
import { CAPTURE_VIEWPORT } from './capture-gate';
import { RESET_ENDPOINT } from './headers';
import { paintState, type PaintState } from './paint';
import { wipeOriginStorage } from './wipe';

/** Prefix of every console line the renderer listens for. */
const MARK = '[br-capture]';
const WIPE_TIMEOUT_MS = 4000;
const FETCH_TIMEOUT_MS = 10_000;
const FRAME_ALLOW = 'autoplay; fullscreen; gamepad';
const PAINT_INTERVAL_MS = 250;
const FRAME_CSS = `position:fixed;left:0;top:0;width:${String(CAPTURE_VIEWPORT.width)}px;height:${String(CAPTURE_VIEWPORT.height)}px;border:0;margin:0;padding:0;display:block;background:transparent`;

// Keep our own reference: the build may later replace `console.info` in this realm. That
// only suppresses hints, which the renderer does not depend on.
const info = console.info.bind(console);
function signal(kind: string, detail?: string): void {
  info(detail === undefined ? `${MARK} ${kind}` : `${MARK} ${kind} ${detail.slice(0, 500)}`);
}

const root = document.documentElement;
root.setAttribute('data-br-paint', 'empty');
let buildFrame: HTMLIFrameElement | null = null;

/** Refreshes `data-br-paint` from the build's frame (never throws). */
function updatePaint(): void {
  let state: PaintState;
  try {
    // null when the build navigated its frame away (another origin): something else shows.
    state = buildFrame ? paintState(buildFrame.contentDocument, CAPTURE_VIEWPORT) : 'empty';
  } catch {
    state = 'content';
  }
  if (root.getAttribute('data-br-paint') !== state) root.setAttribute('data-br-paint', state);
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${what} timed out after ${String(ms)} ms`));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

async function fetchText(url: string, maxChars: number, what: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => {
    ctrl.abort();
  }, FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`${what}: HTTP ${String(res.status)}`);
    const text = await res.text();
    if (text.length > maxChars) throw new Error(`${what}: larger than ${String(maxChars)} chars`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function parseImportMap(raw: string | null): ImportMap {
  if (raw === null) return { imports: {} };
  const parsed = ImportMapSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error('map: not a valid import map');
  return parsed.data;
}

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const src = params.get('src');
  const css = params.get('css');
  if (!src) throw new Error('missing src');
  const importMap = parseImportMap(params.get('map'));

  const wipeErrors = await withTimeout(
    wipeOriginStorage(new URL(RESET_ENDPOINT, location.href)),
    WIPE_TIMEOUT_MS,
    'storage wipe',
  ).catch((e: unknown) => [e instanceof Error ? e.message : String(e)]);
  if (wipeErrors.length > 0) signal('warn', `storage wipe: ${wipeErrors.join('; ')}`);

  const [js, cssText] = await Promise.all([
    fetchText(src, LIMITS.bundleJsMaxChars, 'bundle.js'),
    css ? fetchText(css, LIMITS.bundleCssMaxChars, 'bundle.css') : Promise.resolve(''),
  ]);

  const f = createChildFrame(document, FRAME_ALLOW, FRAME_CSS);
  buildFrame = f;
  setInterval(updatePaint, PAINT_INTERVAL_MS);
  const opened = openBuildDocument(f, (w) => {
    installBuildApi(w, () => {
      signal('ready');
      // Also as attributes, for renderers that can only wait for a selector and read the
      // HTML (Browser Rendering's REST API: `html[data-br-capture]`).
      updatePaint();
      root.setAttribute('data-br-capture', 'ready');
    });
    w.addEventListener('error', (ev: ErrorEvent) => {
      signal('error', ev.message || 'Script error');
    });
    w.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
      signal('error', `unhandled rejection: ${String(ev.reason)}`);
    });
  });
  if (!opened) throw new Error('could not create the build document');
  injectBuild(
    opened.document,
    { js, css: cssText, importMap },
    {
      onLoad: () => {
        signal('loaded');
      },
      onError: () => {
        signal('error', 'the build or one of its packages failed to load');
      },
    },
  );
}

main().catch((e: unknown) => {
  const message = e instanceof Error ? e.message : String(e);
  signal('failed', message);
  root.setAttribute('data-br-capture-error', message.slice(0, 200));
  root.setAttribute('data-br-capture', 'failed');
});
