/**
 * Best-effort client thumbnail of the running build (`capture-thumbnail` → `thumbnail`).
 *
 * The canonical screenshot is the server-side capture (docs/03 §3.7). This is only its
 * fallback, used when the server render fails or is blank, so it trades fidelity for size
 * and simplicity:
 *
 * - **Canvas builds**: when one `<canvas>` covers most of the viewport (games, generative
 *   art, charts), it is copied as is. A WebGL canvas without `preserveDrawingBuffer` may
 *   copy as transparent; the DOM path below then still gives the page around it.
 * - **Everything else**: the build's DOM is serialized into an SVG `<foreignObject>` and
 *   drawn onto a canvas (the "DOM to image" technique). The build's `<style>` elements
 *   travel with it; scripts are dropped; canvases inside the DOM are replaced by images of
 *   their pixels. External images and web fonts do not load inside an SVG image, so they are
 *   missing, which is acceptable for a fallback.
 *
 * Runs in the shell's realm against the current child frame. The result is untrusted
 * display data like every other shell message (the build can run code in this realm); the
 * capture worker decodes and re-encodes it before it is ever stored as a screenshot.
 */
import { LIMITS } from '@br/protocol';

const WEBP_PREFIX = 'data:image/webp;base64,';
const SVG_NS = 'http://www.w3.org/2000/svg';
/** A canvas covering at least this share of the viewport counts as "the build is a canvas". */
const CANVAS_COVERAGE = 0.5;

export interface ThumbnailOptions {
  /** Image decode limit for the DOM path. Default 3000 ms. */
  timeoutMs?: number;
}

/** Encodes as WebP within the protocol's size cap; null when the browser cannot. */
export function encodeWebp(canvas: HTMLCanvasElement): string | null {
  for (const quality of [0.8, 0.6, 0.4]) {
    let url: string;
    try {
      url = canvas.toDataURL('image/webp', quality);
    } catch {
      return null; // tainted canvas
    }
    // Browsers without a WebP encoder (Safari) fall back to PNG: not accepted by the schema.
    if (!url.startsWith(WEBP_PREFIX)) return null;
    if (url.length <= LIMITS.thumbnailMaxChars) return url;
  }
  return null;
}

/** The largest visible canvas covering at least half of the viewport, if any. */
export function findMainCanvas(doc: Document, vw: number, vh: number): HTMLCanvasElement | null {
  let best: HTMLCanvasElement | null = null;
  let bestArea = 0;
  for (const c of Array.from(doc.querySelectorAll('canvas'))) {
    const r = c.getBoundingClientRect();
    const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    const area = w * h;
    if (area > bestArea) {
      best = c;
      bestArea = area;
    }
  }
  return best && bestArea >= CANVAS_COVERAGE * vw * vh ? best : null;
}

function newCanvas(
  width: number,
  height: number,
): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
} | null {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  return { canvas, ctx };
}

/** Background colour of the build's page (body, then html), white if transparent. */
function pageBackground(doc: Document): string {
  const view = doc.defaultView;
  if (!view) return '#fff';
  // `body` is null in a document without one, whatever the DOM typings say.
  for (const el of [doc.body as HTMLElement | null, doc.documentElement]) {
    if (!el) continue;
    const bg = view.getComputedStyle(el).backgroundColor;
    if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') return bg;
  }
  return '#fff';
}

/** Serializes the build's DOM into an SVG document of `vw × vh` CSS pixels. */
export function domToSvg(doc: Document, vw: number, vh: number): string {
  const clone = doc.documentElement.cloneNode(true) as HTMLElement;
  for (const s of Array.from(clone.querySelectorAll('script'))) s.remove();
  // Canvases lose their pixels when cloned: put an image of each in its place.
  const live = Array.from(doc.documentElement.querySelectorAll('canvas'));
  const cloned = Array.from(clone.querySelectorAll('canvas'));
  cloned.forEach((c, i) => {
    const src = live[i];
    if (!src) return;
    try {
      const img = doc.createElement('img');
      img.src = src.toDataURL();
      img.setAttribute('style', c.getAttribute('style') ?? '');
      img.className = c.className;
      img.width = src.width;
      img.height = src.height;
      const r = src.getBoundingClientRect();
      img.style.width = `${String(r.width)}px`;
      img.style.height = `${String(r.height)}px`;
      c.replaceWith(img);
    } catch {
      // tainted: leave the empty canvas
    }
  });
  // Form state is not in the attributes; copy what the user typed.
  const liveInputs = Array.from(doc.documentElement.querySelectorAll('input, textarea'));
  const clonedInputs = Array.from(clone.querySelectorAll('input, textarea'));
  clonedInputs.forEach((el, i) => {
    // The build's elements come from another realm, so no `instanceof` checks.
    const src = liveInputs[i] as HTMLInputElement | HTMLTextAreaElement | undefined;
    if (!src) return;
    if (src.tagName === 'TEXTAREA') el.textContent = src.value;
    else el.setAttribute('value', src.value);
  });
  clone.style.width = `${String(vw)}px`;
  clone.style.height = `${String(vh)}px`;
  clone.style.overflow = 'hidden';
  const xhtml = new XMLSerializer().serializeToString(clone);
  return (
    `<svg xmlns="${SVG_NS}" width="${String(vw)}" height="${String(vh)}">` +
    `<foreignObject x="0" y="0" width="100%" height="100%">${xhtml}</foreignObject></svg>`
  );
}

function loadImage(src: string, timeoutMs: number): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    const timer = setTimeout(() => {
      resolve(null);
    }, timeoutMs);
    img.onload = () => {
      clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      clearTimeout(timer);
      resolve(null);
    };
    img.src = src;
  });
}

/**
 * A `width × height` WebP data URL of what the child frame shows, or null when there is no
 * build or the browser cannot produce one. Never throws.
 */
export async function captureThumbnail(
  frame: HTMLIFrameElement | null,
  width: number,
  height: number,
  opts: ThumbnailOptions = {},
): Promise<string | null> {
  try {
    const doc = frame?.contentDocument;
    const view = frame?.contentWindow;
    if (!doc || !view) return null;
    const vw = Math.max(1, view.innerWidth);
    // Lay the page out at the viewport's width and the thumbnail's aspect ratio.
    const vh = Math.max(1, Math.round((vw * height) / width));
    const out = newCanvas(width, height);
    if (!out) return null;
    const { canvas, ctx } = out;
    ctx.fillStyle = pageBackground(doc);
    ctx.fillRect(0, 0, width, height);

    const main = findMainCanvas(doc, vw, view.innerHeight);
    if (main) {
      try {
        const r = main.getBoundingClientRect();
        const scale = width / vw;
        ctx.drawImage(main, r.left * scale, r.top * scale, r.width * scale, r.height * scale);
        const url = encodeWebp(canvas);
        if (url) return url;
      } catch {
        // fall through to the DOM path
      }
      ctx.fillStyle = pageBackground(doc);
      ctx.fillRect(0, 0, width, height);
    }

    const svg = domToSvg(doc, vw, vh);
    const img = await loadImage(
      `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
      opts.timeoutMs ?? 3000,
    );
    if (!img) return null;
    ctx.drawImage(img, 0, 0, width, height);
    return encodeWebp(canvas);
  } catch {
    return null;
  }
}
