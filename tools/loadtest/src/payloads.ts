/**
 * Synthetic build files with realistic sizes. The shapes are ASSUMPTIONS (2026-10-07), set
 * from the product's limits and the runtime's output, not from production data (there is
 * none yet):
 *
 * - `source.json`: the workspace (limit 1 MB, docs/03 §3.3; the react-ts template is about
 *   5 KB). A 10-minute build adds a few hundred lines; some paste images as data URLs.
 * - `bundle.js`: esbuild production output (minified), packages are external (import map
 *   to the package CDN), images are inlined. So most bundles are small; image-heavy ones
 *   are not.
 * - `bundle.css`, `manifest.json` (`{dependencies}`), `thumb.webp` (640×400 client
 *   thumbnail, best effort at ship).
 *
 * The bundle is real JavaScript that renders a coloured page with the build name, so the
 * capture worker produces a real screenshot (not a blank-page fallback). Half of the
 * builds call `window.buildRoulette.ready()` (the template's hint); the others are shot
 * at network idle + 2 s, like builds that never call it.
 */
import type { Rng } from './rng';

export interface SizeShape {
  median: number;
  p90: number;
  min: number;
  max: number;
}

export const SIZE_SHAPES: Record<'source' | 'bundle' | 'css' | 'thumb', SizeShape> = {
  source: { median: 14_000, p90: 60_000, min: 2_000, max: 1_000_000 },
  bundle: { median: 12_000, p90: 70_000, min: 1_500, max: 1_500_000 },
  css: { median: 2_000, p90: 8_000, min: 200, max: 100_000 },
  thumb: { median: 18_000, p90: 40_000, min: 4_000, max: 150_000 },
};

/** The final sizes of one player's build (drawn once per battle). */
export interface BuildSizes {
  source: number;
  bundle: number;
  css: number;
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
    source: s('source'),
    bundle: s('bundle'),
    css: s('css'),
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

/** `bundle.js` at a given progress (0–1) of the build: real JS that renders `name`. */
export function bundleJs(rng: Rng, sizes: BuildSizes, name: string, progress: number): string {
  const head =
    `const r=document.createElement('div');` +
    `r.style.cssText='font:56px sans-serif;padding:48px;min-height:100vh;box-sizing:border-box;` +
    `color:#fff;background:hsl(${String(sizes.hue)},65%,40%)';` +
    `r.textContent=${JSON.stringify(name)};document.body.style.margin='0';document.body.appendChild(r);` +
    (sizes.readySignal ? `requestAnimationFrame(()=>window.buildRoulette?.ready());` : '');
  const target = Math.round(sizes.bundle * (0.3 + 0.7 * progress));
  const pad = filler(rng, Math.max(0, target - head.length - 40));
  return `${head}\nconst __pad=${JSON.stringify(pad)};void __pad;\n`;
}

export function bundleCss(rng: Rng, sizes: BuildSizes, progress: number): string {
  const target = Math.round(sizes.css * (0.3 + 0.7 * progress));
  const rules: string[] = [];
  let n = 0;
  while (n < target) {
    const r = `.c${String(rng.int(0, 99999))}{margin:${String(rng.int(0, 40))}px;color:#${rng
      .int(0, 0xffffff)
      .toString(16)
      .padStart(6, '0')}}`;
    rules.push(r);
    n += r.length;
  }
  return rules.join('\n');
}

export function sourceJson(rng: Rng, sizes: BuildSizes, progress: number): string {
  const target = Math.round(sizes.source * (0.3 + 0.7 * progress));
  const app = filler(rng, Math.max(0, target - 200));
  return JSON.stringify({
    version: 1,
    template: 'react-ts',
    entry: 'src/main.tsx',
    files: { 'src/main.tsx': `import React from 'react';\n${app}`, 'src/styles.css': 'body{}' },
  });
}

export const MANIFEST_JSON = JSON.stringify({
  dependencies: { react: '19.2.0', 'react-dom': '19.2.0' },
});

/** A WebP-looking blob of the drawn size (RIFF/WEBP header + filler; never decoded here). */
export function thumbWebp(rng: Rng, sizes: BuildSizes): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(sizes.thumb);
  out.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  for (let i = 12; i < out.length; i++) out[i] = Math.floor(rng.next() * 256);
  return out;
}
