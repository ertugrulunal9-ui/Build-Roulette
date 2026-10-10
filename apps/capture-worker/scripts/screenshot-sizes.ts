/**
 * Screenshot sizes for the Supabase Free storage and egress budgets (T-036, docs/08 §6).
 *
 * Renders every page of `scripts/screenshot-corpus/` (18 small apps, BUILD × STYLE cards of
 * the deck, from flat to grainy) at the capture viewport (1280×800, DPR 1) in Playwright
 * Chromium and takes the screenshot the way Browser Rendering does: CDP
 * `Page.captureScreenshot` with `format: 'webp'` (Chromium's own encoder; the REST API's
 * `screenshotOptions` are Puppeteer's, which map onto it). A smaller stored size is the
 * same frame through `clip.scale` (in the REST schema too: `screenshotOptions.clip.scale`).
 * For each setting it prints the size and, against a lossless PNG of the same frame at the
 * same scale, PSNR and SSIM (the encoding loss; the resolution loss of a smaller scale shows
 * in the `--compare` images only).
 *
 *   pnpm --filter @br/capture-worker measure:screenshots
 *   pnpm --filter @br/capture-worker measure:screenshots --csv out.csv --compare dir/
 *
 * `--compare <dir>` also writes side-by-side crops (2×, nearest neighbour; a scaled shot is
 * shown at the same on-screen size as the full one) for a visual check. The pages draw with a
 * fixed seed, so a run is reproducible up to Chromium's version and the fonts installed.
 */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, type Browser } from 'playwright-core';
import sharp from 'sharp';

interface Setting {
  name: string;
  /** null: lossless PNG. */
  quality: number | null;
  /** `clip.scale`: the stored image is (1280 × scale) × (800 × scale). */
  scale: number;
}

const VIEWPORT = { width: 1280, height: 800 };
const SETTINGS: Setting[] = [
  { name: 'png', quality: null, scale: 1 },
  { name: 'webp-q82', quality: 82, scale: 1 },
  { name: 'webp-q75', quality: 75, scale: 1 },
  { name: 'webp-q70', quality: 70, scale: 1 },
  { name: 'webp-q60', quality: 60, scale: 1 },
  { name: 'webp-q50', quality: 50, scale: 1 },
  { name: 'webp-q82-960', quality: 82, scale: 0.75 },
  { name: 'webp-q70-960', quality: 70, scale: 0.75 },
  // Roughly the client thumbnail (the fallback when the daily browser budget is spent): the
  // shell's canvas toDataURL('image/webp', 0.8) at 640×400 (apps/sandbox-shell/src/thumbnail.ts).
  { name: 'thumb-640-q80', quality: 80, scale: 0.5 },
];
/** Crops for `--compare`, in CSS pixels of the 1280×800 frame. */
const CROPS: Record<string, { left: number; top: number; width: number; height: number }> = {
  '06-newspaper-flashcards.html': { left: 40, top: 100, width: 300, height: 180 },
  '10-synthwave-countdown.html': { left: 400, top: 40, width: 300, height: 180 },
  '13-silent-film-8ball.html': { left: 472, top: 120, width: 300, height: 180 },
  '18-dashboard-mood.html': { left: 232, top: 20, width: 300, height: 180 },
};

interface Row {
  page: string;
  setting: string;
  width: number;
  height: number;
  bytes: number;
  psnr: number;
  ssim: number;
}

const here = dirname(fileURLToPath(import.meta.url));
const corpusDir = join(here, 'screenshot-corpus');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function raw(img: Buffer): Promise<{ data: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(img).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** PSNR over R, G and B, in dB (99 for identical images). */
function psnr(a: Buffer, b: Buffer): number {
  let se = 0;
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    se += d * d;
  }
  const mse = se / a.length;
  return mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse);
}

/** Mean SSIM of the luma over non-overlapping 8×8 blocks (constants of Wang et al. 2004). */
function ssim(a: Buffer, b: Buffer, width: number, height: number): number {
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  const luma = (p: Buffer, i: number) =>
    0.299 * (p[i] ?? 0) + 0.587 * (p[i + 1] ?? 0) + 0.114 * (p[i + 2] ?? 0);
  const xa = new Float64Array(64);
  const xb = new Float64Array(64);
  let sum = 0;
  let n = 0;
  for (let by = 0; by + 8 <= height; by += 8) {
    for (let bx = 0; bx + 8 <= width; bx += 8) {
      let ma = 0;
      let mb = 0;
      for (let k = 0; k < 64; k++) {
        const i = ((by + (k >> 3)) * width + bx + (k & 7)) * 3;
        xa[k] = luma(a, i);
        xb[k] = luma(b, i);
        ma += xa[k] ?? 0;
        mb += xb[k] ?? 0;
      }
      ma /= 64;
      mb /= 64;
      let va = 0;
      let vb = 0;
      let cov = 0;
      for (let k = 0; k < 64; k++) {
        const da = (xa[k] ?? 0) - ma;
        const db = (xb[k] ?? 0) - mb;
        va += da * da;
        vb += db * db;
        cov += da * db;
      }
      va /= 63;
      vb /= 63;
      cov /= 63;
      sum += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      n++;
    }
  }
  return n ? sum / n : 1;
}

/** Every setting's shot of one page, plus the PNG reference of each scale (`png@<scale>`). */
async function shoot(browser: Browser, file: string): Promise<Map<string, Buffer>> {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  try {
    const page = await context.newPage();
    await page.goto(pathToFileURL(join(corpusDir, file)).href, { waitUntil: 'load' });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          void document.fonts.ready.then(() => {
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                resolve();
              });
            });
          });
        }),
    );
    const cdp = await context.newCDPSession(page);
    const capture = async (quality: number | null, scale: number): Promise<Buffer> => {
      const shot = await cdp.send('Page.captureScreenshot', {
        ...(quality === null ? { format: 'png' } : { format: 'webp', quality }),
        ...(scale === 1 ? {} : { clip: { x: 0, y: 0, ...VIEWPORT, scale } }),
      });
      return Buffer.from(shot.data, 'base64');
    };
    const out = new Map<string, Buffer>();
    for (const scale of new Set(SETTINGS.map((s) => s.scale))) {
      out.set(`png@${String(scale)}`, await capture(null, scale));
    }
    for (const s of SETTINGS) out.set(s.name, await capture(s.quality, s.scale));
    return out;
  } finally {
    await context.close();
  }
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return (sorted[lo] ?? 0) + ((sorted[hi] ?? 0) - (sorted[lo] ?? 0)) * (pos - lo);
}

async function compare(
  dir: string,
  page: string,
  shots: Map<string, Buffer>,
  crop: { left: number; top: number; width: number; height: number },
): Promise<string> {
  const zoom = 2;
  const cols = 3;
  const w = crop.width * zoom;
  const h = crop.height * zoom;
  const label = 28;
  const tiles = await Promise.all(
    SETTINGS.map(async (s, i) => {
      const img = shots.get(s.name);
      if (!img) throw new Error(`no ${s.name} shot of ${page}`);
      const k = s.scale;
      const tile = await sharp(img)
        .extract({
          left: Math.round(crop.left * k),
          top: Math.round(crop.top * k),
          width: Math.round(crop.width * k),
          height: Math.round(crop.height * k),
        })
        .resize(w, h, { kernel: k === 1 ? 'nearest' : 'lanczos3' })
        .png()
        .toBuffer();
      const text = `${s.name} · ${String(Math.round(img.length / 1024))} KiB`;
      const svg = Buffer.from(
        `<svg width="${String(w)}" height="${String(label)}"><rect width="100%" height="100%" fill="#fff"/><text x="8" y="20" font-family="DejaVu Sans" font-size="16">${text}</text></svg>`,
      );
      const left = (i % cols) * (w + 8);
      const top = Math.floor(i / cols) * (h + label + 8);
      return [
        { input: svg, left, top },
        { input: tile, left, top: top + label },
      ];
    }),
  );
  const out = join(dir, `compare-${page.replace(/\.html$/, '')}.png`);
  await sharp({
    create: {
      width: Math.min(SETTINGS.length, cols) * (w + 8) - 8,
      height: Math.ceil(SETTINGS.length / cols) * (h + label + 8) - 8,
      channels: 3,
      background: '#888',
    },
  })
    .composite(tiles.flat())
    .png()
    .toFile(out);
  return out;
}

async function main(): Promise<void> {
  const csvPath = arg('--csv');
  const compareDir = arg('--compare');
  const pages = readdirSync(corpusDir)
    .filter((f) => f.endsWith('.html'))
    .sort();
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  const rows: Row[] = [];
  try {
    for (const page of pages) {
      const shots = await shoot(browser, page);
      for (const s of SETTINGS) {
        const img = shots.get(s.name);
        const png = shots.get(`png@${String(s.scale)}`);
        if (!img || !png) throw new Error(`missing shot for ${page} ${s.name}`);
        const [ref, got] = await Promise.all([raw(png), raw(img)]);
        rows.push({
          page,
          setting: s.name,
          width: got.width,
          height: got.height,
          bytes: img.length,
          psnr: psnr(ref.data, got.data),
          ssim: ssim(ref.data, got.data, got.width, got.height),
        });
      }
      const crop = CROPS[page];
      if (compareDir && crop) {
        mkdirSync(compareDir, { recursive: true });
        console.error(`wrote ${await compare(compareDir, page, shots, crop)}`);
      }
      console.error(`${page}: ${String(SETTINGS.length)} settings`);
    }
  } finally {
    await browser.close();
  }

  if (csvPath) {
    const csv = ['page,setting,width,height,bytes,psnr_db,ssim'].concat(
      rows.map((r) =>
        [r.page, r.setting, r.width, r.height, r.bytes, r.psnr.toFixed(2), r.ssim.toFixed(4)].join(
          ',',
        ),
      ),
    );
    writeFileSync(csvPath, csv.join('\n') + '\n');
  }

  const kib = (n: number) => (n / 1024).toFixed(1);
  console.log(
    `| Setting | Stored size | Min | Median | Mean | p90 | Max | Total (${String(pages.length)} pages) | SSIM mean / min | PSNR mean (dB) |`,
  );
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  for (const s of SETTINGS) {
    const rs = rows.filter((r) => r.setting === s.name);
    const b = rs.map((r) => r.bytes).sort((x, y) => x - y);
    const total = b.reduce((x, y) => x + y, 0);
    const first = rs[0];
    const meanSsim = rs.reduce((x, r) => x + r.ssim, 0) / rs.length;
    const minSsim = Math.min(...rs.map((r) => r.ssim));
    const meanPsnr = rs.reduce((x, r) => x + Math.min(r.psnr, 60), 0) / rs.length;
    console.log(
      `| ${s.name} | ${String(first?.width)}×${String(first?.height)} | ${kib(b[0] ?? 0)} | ${kib(quantile(b, 0.5))} | ${kib(total / b.length)} | ${kib(quantile(b, 0.9))} | ${kib(b[b.length - 1] ?? 0)} | ${kib(total)} | ${meanSsim.toFixed(4)} / ${minSsim.toFixed(4)} | ${meanPsnr.toFixed(1)} |`,
    );
  }
  console.log('\nAll sizes in KiB.');
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
