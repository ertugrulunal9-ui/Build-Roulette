/**
 * Has the build put anything on screen? The capture page's answer for renderers that cannot
 * look at pixels (T-034: Cloudflare Browser Rendering's REST API, whose WebP the `jobs` Edge
 * Function cannot decode). The Playwright renderer checks the pixels instead.
 *
 * `empty` when no element of the build's document, within the viewport and visible, paints
 * anything: text, a replaced element (img, svg, canvas, video, form controls…), a background,
 * a border, a shadow, an outline or a `::before`/`::after` with content. A background image
 * on `<html>` or `<body>` counts too; a plain background colour on them does not (a single
 * flat colour is "blank", as in the pixel check). That is what a build that threw before
 * rendering, or rendered nothing, looks like: the capture then uses the client thumbnail.
 *
 * Approximate on purpose: it cannot see white-on-white or an ancestor's `opacity: 0`, and a
 * blank canvas counts as content. It runs in a realm the build can reach, so it is a hint, but
 * a build can only change its own screenshot with it. Bounded: at most `maxElements` elements
 * are looked at (more than that counts as content).
 */

export type PaintState = 'content' | 'empty';

/** Elements that show something by having a box. Upper-cased tag names. */
const REPLACED = new Set([
  'IMG',
  'SVG',
  'CANVAS',
  'VIDEO',
  'PICTURE',
  'IFRAME',
  'EMBED',
  'OBJECT',
  'INPUT',
  'BUTTON',
  'SELECT',
  'TEXTAREA',
  'PROGRESS',
  'METER',
  'HR',
]);
const NOT_RENDERED = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'TEMPLATE', 'NOSCRIPT', 'TITLE']);

/** The alpha of a computed colour (`rgb(…)`, `rgba(…)`, `transparent`); 1 when unknown. */
export function colorAlpha(color: string): number {
  const c = color.trim().toLowerCase();
  if (c === 'transparent' || c === '') return 0;
  const m = /^rgba?\(([^)]*)\)$/.exec(c);
  if (!m) return 1;
  const parts = (m[1] ?? '').split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 4) return 1;
  const a = parts[3] ?? '1';
  const n = a.endsWith('%') ? Number(a.slice(0, -1)) / 100 : Number(a);
  return Number.isFinite(n) ? n : 1;
}

function hasOwnText(el: Element): boolean {
  for (const n of Array.from(el.childNodes)) {
    if (n.nodeType === 3 && /\S/.test(n.nodeValue ?? '')) return true;
  }
  return false;
}

function boxPaints(cs: CSSStyleDeclaration): boolean {
  if (colorAlpha(cs.backgroundColor) > 0) return true;
  if (cs.backgroundImage && cs.backgroundImage !== 'none') return true;
  if (cs.boxShadow && cs.boxShadow !== 'none') return true;
  for (const side of ['Top', 'Right', 'Bottom', 'Left'] as const) {
    const width = parseFloat(cs.getPropertyValue(`border-${side.toLowerCase()}-width`));
    const style = cs.getPropertyValue(`border-${side.toLowerCase()}-style`);
    const color = cs.getPropertyValue(`border-${side.toLowerCase()}-color`);
    if (width > 0 && style !== 'none' && style !== 'hidden' && colorAlpha(color) > 0) return true;
  }
  return cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
}

function pseudoPaints(win: Window, el: Element): boolean {
  for (const pseudo of ['::before', '::after']) {
    const content = win.getComputedStyle(el, pseudo).content;
    if (content && content !== 'none' && content !== 'normal' && content !== '""') return true;
  }
  return false;
}

/**
 * `content` or `empty` for the build's document (see the module comment). A document we
 * cannot read (the build navigated its frame to another origin) shows something else:
 * `content`.
 */
export function paintState(
  doc: Document | null,
  viewport: { width: number; height: number },
  maxElements = 3000,
): PaintState {
  if (!doc) return 'content';
  const win = doc.defaultView;
  const body = doc.body as HTMLElement | null;
  if (!win) return 'content';
  if (!body) return 'empty';
  for (const el of [doc.documentElement, body]) {
    const bg = win.getComputedStyle(el).backgroundImage;
    if (bg && bg !== 'none') return 'content';
  }
  if (hasOwnText(body)) return 'content';
  const all = body.getElementsByTagName('*');
  const n = Math.min(all.length, maxElements);
  for (let i = 0; i < n; i++) {
    const el = all[i];
    if (!el) continue;
    const tag = el.tagName.toUpperCase();
    if (NOT_RENDERED.has(tag)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    if (r.right <= 0 || r.bottom <= 0 || r.left >= viewport.width || r.top >= viewport.height) {
      continue;
    }
    const cs = win.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') {
      continue;
    }
    if (Number(cs.opacity) === 0) continue;
    if (REPLACED.has(tag) || hasOwnText(el) || boxPaints(cs) || pseudoPaints(win, el)) {
      return 'content';
    }
  }
  return all.length > maxElements ? 'content' : 'empty';
}
