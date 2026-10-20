/**
 * Build Roulette capture page (docs/03 §3.7, docs/09 §9.3), `/v{N}/capture`, loaded
 * TOP-LEVEL by the capture renderer (Playwright locally, Cloudflare Browser Rendering in
 * production).
 *
 * The page is only served by the capture gate after it verified the HMAC over the exact
 * query (`capture-gate.ts`), so this script can use `location.search` as is. It:
 *   1. wipes the origin's storage (a renderer may reuse a browser session; this also
 *      unregisters the site worker);
 *   2. fetches the site pack (`src`, a short-lived signed URL of `site.bin`): `no-store`, no
 *      credentials, no redirects, at most `SITE_LIMITS.maxPackBytes`;
 *   3. registers the site worker, hands it the site and navigates a fresh child frame to it
 *      at the fixed 1280×800 viewport, exactly like the preview shell does
 *      (`site-loader.ts`, `build-frame.ts`). `Math.random` and timers are NOT stubbed.
 *
 * Readiness is decided by the renderer, never by this page: the site can run code in this
 * realm, so everything this page reports is a hint. It reports through console lines that
 * start with `[br-capture]` (`ready`, `loaded`, `error …`, `failed …`). `ready` is sent when
 * the site calls `window.buildRoulette.ready()`; the renderer then waits for that, or for
 * network idle + 2 s, capped at 6 s (apps/capture-worker).
 *
 * For renderers that can only wait for a selector and read the page's HTML (T-034: Browser
 * Rendering's REST `/snapshot`, used by the `jobs` Edge Function), the same facts are
 * attributes of `<html>`:
 *   data-br-capture-page   in the served HTML (capture-gate.ts): the gate served this page
 *   data-br-capture        `ready` (the site's signal) or `failed` (this page could not run
 *                          the site), with `data-br-capture-error` (short text)
 *   data-br-paint          `content` or `empty`: whether the site's frame shows anything
 *                          (paint.ts), kept current every 250 ms and at the ready signal
 *
 * The page response carries a CSP `sandbox` directive (no popups, no modals, no downloads;
 * `allow-same-origin`, which the site worker needs), and the renderer aborts any top-level
 * navigation away from the capture URL.
 */
import { SITE_LIMITS } from '@br/site';
import {
  createChildFrame,
  defineAttachHook,
  installBuildApi,
  onResourceError,
} from './build-frame';
import { CAPTURE_VIEWPORT } from './capture-viewport';
import { RESET_ENDPOINT } from './headers';
import { paintState, type PaintState } from './paint';
import { startSite } from './site-loader';
import { wipeOriginStorage } from './wipe';

/** Prefix of every console line the renderer listens for. */
const MARK = '[br-capture]';
const WIPE_TIMEOUT_MS = 4000;
const FETCH_TIMEOUT_MS = 10_000;
const FRAME_ALLOW = 'autoplay; fullscreen; gamepad';
const PAINT_INTERVAL_MS = 250;
const FRAME_CSS = `position:fixed;left:0;top:0;width:${String(CAPTURE_VIEWPORT.width)}px;height:${String(CAPTURE_VIEWPORT.height)}px;border:0;margin:0;padding:0;display:block;background:transparent`;

// Keep our own reference: the site may later replace `console.info` in this realm. That
// only suppresses hints, which the renderer does not depend on.
const info = console.info.bind(console);
function signal(kind: string, detail?: string): void {
  info(detail === undefined ? `${MARK} ${kind}` : `${MARK} ${kind} ${detail.slice(0, 500)}`);
}

const root = document.documentElement;
root.setAttribute('data-br-paint', 'empty');
let buildFrame: HTMLIFrameElement | null = null;

/** Refreshes `data-br-paint` from the site's frame (never throws). */
function updatePaint(): void {
  let state: PaintState;
  try {
    // null when the site navigated its frame away (another origin): something else shows.
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

/** Fetches the site pack: no cache, no credentials, no redirects, bounded size. */
async function fetchPack(url: string): Promise<ArrayBuffer> {
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
    if (!res.ok) throw new Error(`site.bin: HTTP ${String(res.status)}`);
    const declared = Number(res.headers.get('content-length') ?? NaN);
    const tooLarge = `site.bin: larger than ${String(SITE_LIMITS.maxPackBytes)} bytes`;
    if (declared > SITE_LIMITS.maxPackBytes) throw new Error(tooLarge);
    const pack = await res.arrayBuffer();
    if (pack.byteLength > SITE_LIMITS.maxPackBytes) throw new Error(tooLarge);
    return pack;
  } finally {
    clearTimeout(timer);
  }
}

/** The capture page's hooks in every document of the site (through the bootstrap). */
defineAttachHook(
  window,
  () => buildFrame,
  (w) => {
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
    onResourceError(w, (url) => {
      signal('error', `failed to load ${url}`);
    });
  },
);

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const src = params.get('src');
  if (!src) throw new Error('missing src');

  const wipeErrors = await withTimeout(
    wipeOriginStorage(new URL(RESET_ENDPOINT, location.href)),
    WIPE_TIMEOUT_MS,
    'storage wipe',
  ).catch((e: unknown) => [e instanceof Error ? e.message : String(e)]);
  if (wipeErrors.length > 0) signal('warn', `storage wipe: ${wipeErrors.join('; ')}`);

  const pack = await fetchPack(src);
  const url = await startSite(pack);
  const f = createChildFrame(document, FRAME_ALLOW, FRAME_CSS, url);
  buildFrame = f;
  setInterval(updatePaint, PAINT_INTERVAL_MS);
  let loaded = false;
  f.addEventListener('load', () => {
    if (loaded) return;
    loaded = true;
    signal('loaded');
  });
}

main().catch((e: unknown) => {
  const message = e instanceof Error ? e.message : String(e);
  signal('failed', message);
  root.setAttribute('data-br-capture-error', message.slice(0, 200));
  root.setAttribute('data-br-capture', 'failed');
});
