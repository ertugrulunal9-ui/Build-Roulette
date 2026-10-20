/**
 * The site's child frame, shared by the preview shell (`shell.ts`) and the capture page
 * (`capture.ts`).
 *
 * Fresh frame per load: a NEW same-origin child iframe navigated to `/?__br_site=<id>`, which
 * the site worker serves (`sw.ts`). Removing the frame destroys the site's realm: its timers,
 * rAF loops, audio, workers and DOM go with it.
 *
 * Every HTML document the worker serves starts with the bootstrap (`bootstrap.ts`), which
 * calls the attach hook the page defines here (`defineAttachHook`) with the document's
 * window, before any of the site's own scripts run: console and error forwarding, and
 * `window.buildRoulette`, for every document of the site (an in-site navigation to
 * `/about.html` gets them too).
 */
import { ATTACH_HOOK } from './site-protocol';

/**
 * The API a build can call as `window.buildRoulette` (documented in the sandbox-shell
 * README). Sites should call it as `window.buildRoulette?.ready()`.
 */
export interface BuildRouletteApi {
  /**
   * "My first meaningful frame is on screen." A hint for the capture renderer, which may
   * take the screenshot sooner. It never delays a capture (the renderer caps its wait) and
   * does nothing in the live and reveal previews.
   */
  ready(): void;
}

export type SiteWindow = Window & typeof globalThis;

/**
 * Creates the child iframe, appends it to the body (or the root element while there is no
 * body yet) and navigates it to `src`. Fullscreen is delegated via `allow` only.
 */
export function createChildFrame(
  doc: Document,
  allow: string,
  cssText: string,
  src: string,
): HTMLIFrameElement {
  const f = doc.createElement('iframe');
  // Adding the legacy `allowfullscreen` too makes Chromium warn that `allow` takes precedence.
  f.setAttribute('allow', allow);
  f.title = 'Build';
  f.style.cssText = cssText;
  f.src = src;
  const body = doc.body as HTMLElement | null;
  (body ?? doc.documentElement).appendChild(f);
  return f;
}

/** Defines `window.buildRoulette` in a site realm (read-only, not enumerable). */
export function installBuildApi(w: SiteWindow, onReady: () => void): void {
  const api: BuildRouletteApi = Object.freeze({
    ready: () => {
      onReady();
    },
  });
  try {
    Object.defineProperty(w, 'buildRoulette', {
      value: api,
      writable: false,
      enumerable: false,
      configurable: false,
    });
  } catch {
    // Already defined in this realm: keep the first one.
  }
}

/**
 * Defines the attach hook (`window.__brAttach`) the bootstrap calls on `parent`. `attach`
 * runs at most once per document, and only for the window `currentFrame()` shows: a nested
 * frame of the site, or build code calling the hook with something else, is ignored.
 * Build code can call it (it is same-origin): that only attaches its own document again,
 * which is a no-op.
 */
export function defineAttachHook(
  host: Window,
  currentFrame: () => HTMLIFrameElement | null,
  attach: (w: SiteWindow) => void,
): (w: unknown) => void {
  const attached = new WeakSet<Document>();
  const hook = (w: unknown): void => {
    const f = currentFrame();
    if (!f || w === null || w !== f.contentWindow) return;
    const sw = w as SiteWindow;
    let doc: Document;
    try {
      doc = sw.document;
    } catch {
      return; // navigated to another origin
    }
    if (attached.has(doc)) return;
    attached.add(doc);
    attach(sw);
  };
  Object.defineProperty(host, ATTACH_HOOK, {
    value: hook,
    writable: false,
    enumerable: false,
    configurable: false,
  });
  return hook;
}

/** The URL of a script or stylesheet element that failed to load, if `target` is one. */
function failedResource(target: EventTarget | null): string | null {
  const el = target as { tagName?: unknown; src?: unknown; href?: unknown; rel?: unknown } | null;
  if (!el || typeof el.tagName !== 'string') return null;
  if (el.tagName === 'SCRIPT' && typeof el.src === 'string' && el.src) return el.src;
  if (
    el.tagName === 'LINK' &&
    typeof el.rel === 'string' &&
    /\bstylesheet\b/i.test(el.rel) &&
    typeof el.href === 'string'
  )
    return el.href;
  return null;
}

/**
 * Calls `report` with the URL (its path, on the site's own origin) of every `<script src>`
 * or stylesheet `<link>` of the site that fails to load, e.g. a 404 from the site worker.
 * Resource errors do not bubble, so this listens in the capture phase.
 */
export function onResourceError(w: SiteWindow, report: (url: string) => void): void {
  w.addEventListener(
    'error',
    (ev: Event) => {
      if (ev.target === w) return;
      const url = failedResource(ev.target);
      if (url === null) return;
      let shown = url;
      try {
        const u = new URL(url);
        if (u.origin === w.location.origin) shown = u.pathname;
      } catch {
        // keep the URL as it is
      }
      report(shown);
    },
    true,
  );
}
