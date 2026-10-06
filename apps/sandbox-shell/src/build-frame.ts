/**
 * The build's document, shared by the preview shell (`shell.ts`) and the capture page
 * (`capture.ts`).
 *
 * Fresh document per load: a NEW same-origin child iframe (about:blank), then
 * `document.open()` + `document.write()` for a standards-mode document, then, in order and
 * synchronously, the import map, the CSS and a `<script type="module" src="blob:...">`.
 * Because no module has started loading in that brand-new realm yet, the import map always
 * applies before user code runs. Removing the frame destroys the build's realm.
 */
import type { ImportMap } from '@br/protocol';

/**
 * The API a build can call as `window.buildRoulette` (documented for templates in the
 * sandbox-shell README). Templates should call it as `window.buildRoulette?.ready()`.
 */
export interface BuildRouletteApi {
  /**
   * "My first meaningful frame is on screen." A hint for the capture renderer, which may
   * take the screenshot sooner. It never delays a capture (the renderer caps its wait) and
   * does nothing in the live and reveal previews.
   */
  ready(): void;
}

/**
 * Creates the child iframe and appends it to the body (or the root element while there is no
 * body yet). Fullscreen is delegated via `allow` only.
 */
export function createChildFrame(doc: Document, allow: string, cssText: string): HTMLIFrameElement {
  const f = doc.createElement('iframe');
  // Adding the legacy `allowfullscreen` too makes Chromium warn that `allow` takes precedence.
  f.setAttribute('allow', allow);
  f.title = 'Build';
  f.style.cssText = cssText;
  const body = doc.body as HTMLElement | null;
  (body ?? doc.documentElement).appendChild(f);
  return f;
}

/**
 * Opens a standards-mode document in `f`. `prepare` runs right after `document.open()`
 * (which erases listeners) and before anything else, to install hooks and the build API.
 * Returns null when the frame has no window or document.
 */
export function openBuildDocument(
  f: HTMLIFrameElement,
  prepare: (w: Window & typeof globalThis) => void,
): { window: Window & typeof globalThis; document: Document } | null {
  const w = f.contentWindow as (Window & typeof globalThis) | null;
  const d = f.contentDocument;
  if (!w || !d) return null;
  d.open();
  prepare(w);
  // document.write is deprecated for parser-inserted content in normal pages, but writing
  // into a document we just opened is the one reliable way to get a standards-mode
  // document (an about:blank initial document is in quirks mode).
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  d.write(
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div></body></html>',
  );
  d.close();
  return { window: w, document: d };
}

/** Defines `window.buildRoulette` in the build's realm (read-only, not enumerable). */
export function installBuildApi(w: Window & typeof globalThis, onReady: () => void): void {
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
    // Already defined in this realm (cannot happen for a fresh frame): keep the old one.
  }
}

export interface BuildPayload {
  js: string;
  css: string;
  importMap: ImportMap;
}

/**
 * Appends the import map, the CSS and the module script (in that order) to `d`. Returns the
 * blob URL of the module, which the caller revokes when the frame goes away.
 */
export function injectBuild(
  d: Document,
  payload: BuildPayload,
  handlers: { onLoad: () => void; onError: () => void },
): string {
  const importMap = d.createElement('script');
  importMap.type = 'importmap';
  importMap.textContent = JSON.stringify(payload.importMap);
  d.head.appendChild(importMap);

  if (payload.css) {
    const style = d.createElement('style');
    style.textContent = payload.css;
    d.head.appendChild(style);
  }

  const url = URL.createObjectURL(new Blob([payload.js], { type: 'text/javascript' }));
  const script = d.createElement('script');
  script.type = 'module';
  script.src = url;
  script.addEventListener('load', handlers.onLoad);
  script.addEventListener('error', handlers.onError);
  d.head.appendChild(script);
  return url;
}
