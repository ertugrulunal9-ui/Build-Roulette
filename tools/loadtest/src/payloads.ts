/**
 * Synthetic build files with realistic sizes. The shapes are ASSUMPTIONS, set from the
 * product's limits and typical static builds, not from production data (there is none yet):
 *
 * - `site.bin`: the site pack of one import (import mode, docs/09 §9.2; `packSite` of
 *   `@br/site`, limit 5 MB). A built site carries its own packages now (no package CDN since
 *   M6), so a Vite + React build is a few hundred KB of JavaScript; a plain HTML page is a
 *   few KB; image-heavy sites approach the limit. Re-estimated for M6 (2026-10-16): to be
 *   replaced by measured sizes once there are real imports.
 * - `thumb.webp` (640×400 client thumbnail, best effort at ship).
 *
 * The pack is a real site in Vite's layout (`index.html` loading root-relative hashed
 * assets), so the capture page's site worker serves it and the capture produces a real
 * screenshot (not a blank-page fallback). Half of the builds call
 * `window.buildRoulette.ready()`; the others are shot at network idle + 2 s, like builds
 * that never call it.
 */
import { contentTypeOf, packSite } from '@br/site';
import type { Rng } from './rng';

export interface SizeShape {
  median: number;
  p90: number;
  min: number;
  max: number;
}

export const SIZE_SHAPES: Record<'site' | 'thumb', SizeShape> = {
  site: { median: 180_000, p90: 900_000, min: 3_000, max: 4_500_000 },
  thumb: { median: 18_000, p90: 40_000, min: 4_000, max: 150_000 },
};

/** The final sizes of one player's build (drawn once per battle). */
export interface BuildSizes {
  /** The site pack, in bytes. */
  site: number;
  thumb: number;
  readySignal: boolean;
  hue: number;
}

export function drawBuildSizes(rng: Rng): BuildSizes {
  const s = (k: keyof typeof SIZE_SHAPES) => {
    const sh = SIZE_SHAPES[k];
    return rng.logNormal(sh.median, sh.p90, sh.min, sh.max);
  };
  return {
    site: s('site'),
    thumb: s('thumb'),
    readySignal: rng.chance(0.5),
    hue: rng.int(0, 359),
  };
}

const WORDS = [
  'const',
  'return',
  'useState',
  'onClick',
  'props',
  'className',
  'function',
  'items',
  'map',
  'filter',
  'score',
  'timer',
  'player',
  'board',
  'render',
];

/** Code-like filler of about `bytes` bytes (compresses like minified JS, roughly). */
function filler(rng: Rng, bytes: number): string {
  const parts: string[] = [];
  let n = 0;
  let i = 0;
  while (n < bytes) {
    const w = `${rng.pick(WORDS)}${String(rng.int(0, 999))}`;
    const piece =
      i % 3 === 0
        ? `function ${w}(a,b){return a+b*${String(i)}}`
        : i % 3 === 1
          ? `var ${w}='${rng.pick(WORDS)}-${String(rng.int(0, 99999))}';`
          : `${w}.push(${String(rng.int(0, 9999))});`;
    parts.push(piece);
    n += piece.length;
    i++;
  }
  return parts.join('').slice(0, Math.max(0, bytes));
}

/** The site's script, about `bytes` long: real JS that renders `name`. */
export function siteJs(rng: Rng, sizes: BuildSizes, name: string, bytes: number): string {
  const head =
    `const r=document.createElement('div');r.className='app';` +
    `r.style.cssText='font:56px sans-serif;padding:48px;min-height:100vh;box-sizing:border-box;` +
    `color:#fff;background:hsl(${String(sizes.hue)},65%,40%)';` +
    `r.textContent=${JSON.stringify(name)};document.body.style.margin='0';document.body.appendChild(r);` +
    (sizes.readySignal ? `requestAnimationFrame(()=>window.buildRoulette?.ready());` : '');
  const pad = filler(rng, Math.max(0, bytes - head.length - 40));
  return `${head}\nconst __pad=${JSON.stringify(pad)};void __pad;\n`;
}

function siteCss(rng: Rng, bytes: number): string {
  const rules: string[] = ['.app{display:block}'];
  let n = rules[0]?.length ?? 0;
  while (n < bytes) {
    const r = `.c${String(rng.int(0, 99999))}{margin:${String(rng.int(0, 40))}px;color:#${rng
      .int(0, 0xffffff)
      .toString(16)
      .padStart(6, '0')}}`;
    rules.push(r);
    n += r.length;
  }
  return rules.join('\n');
}

const encoder = new TextEncoder();

/**
 * `site.bin` of one import at a given progress (0–1) of the build: `index.html` and its
 * hashed script and stylesheet under `/assets/`, about the drawn size (later imports are
 * bigger).
 */
export function sitePack(
  rng: Rng,
  sizes: BuildSizes,
  name: string,
  progress: number,
): Uint8Array<ArrayBuffer> {
  const target = Math.round(sizes.site * (0.6 + 0.4 * progress));
  const hash = rng.int(0, 0xffffff).toString(16).padStart(6, '0');
  const html =
    `<!doctype html><html lang="en"><head><meta charset="UTF-8">` +
    `<title>${name.replace(/[<&"]/g, '')}</title>` +
    `<script type="module" crossorigin src="/assets/index-${hash}.js"></script>` +
    `<link rel="stylesheet" crossorigin href="/assets/index-${hash}.css"></head>` +
    `<body><div id="root"></div></body></html>`;
  const css = siteCss(rng, Math.round(target * 0.05));
  // The pack's own header and file list are a few hundred bytes.
  const js = siteJs(rng, sizes, name, Math.max(0, target - html.length - css.length - 300));
  const files: [string, string][] = [
    ['index.html', html],
    [`assets/index-${hash}.js`, js],
    [`assets/index-${hash}.css`, css],
  ];
  return packSite(
    files.map(([path, text]) => ({ path, type: contentTypeOf(path), bytes: encoder.encode(text) })),
  );
}

/** A WebP-looking blob of the drawn size (RIFF/WEBP header + filler; never decoded here). */
export function thumbWebp(rng: Rng, sizes: BuildSizes): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(sizes.thumb);
  out.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  for (let i = 12; i < out.length; i++) out[i] = Math.floor(rng.next() * 256);
  return out;
}
