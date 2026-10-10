/**
 * Image handling for the self-hosted worker: blank detection (pure, unit tested), and WebP
 * encoding with `sharp` (prebuilt libvips from npm; no build step). `sharpImaging` is the
 * worker's `CaptureImaging` (imaging.ts); the `jobs` Edge Function uses `webpImaging`
 * instead, since sharp does not run in Deno.
 */
import sharp from 'sharp';
import { MAX_SCREENSHOT_BYTES, SCREENSHOT_WEBP_QUALITY, type CaptureImaging } from './imaging';

export interface RawImage {
  data: Uint8Array;
  width: number;
  height: number;
  /** Interleaved channels per pixel (3 = RGB, 4 = RGBA; alpha is ignored). */
  channels: number;
}

export interface PixelStats {
  /** Largest standard deviation of the R, G and B channels (0..~128). */
  maxStdDev: number;
  /** Most common colour (quantized to 32 levels per channel, reported as the bucket centre). */
  dominant: { r: number; g: number; b: number; share: number };
}

/** Per-channel spread and dominant colour of an image. O(pixels), no allocation per pixel. */
export function pixelStats(img: RawImage): PixelStats {
  const { data, channels } = img;
  const pixels = img.width * img.height;
  if (pixels === 0 || channels < 3 || data.length < pixels * channels) {
    throw new Error('pixelStats: empty or malformed image');
  }
  const sum = [0, 0, 0];
  const sumSq = [0, 0, 0];
  const hist = new Uint32Array(32 * 32 * 32);
  for (let i = 0; i < pixels; i++) {
    const o = i * channels;
    const r = data[o] ?? 0;
    const g = data[o + 1] ?? 0;
    const b = data[o + 2] ?? 0;
    sum[0] = (sum[0] ?? 0) + r;
    sum[1] = (sum[1] ?? 0) + g;
    sum[2] = (sum[2] ?? 0) + b;
    sumSq[0] = (sumSq[0] ?? 0) + r * r;
    sumSq[1] = (sumSq[1] ?? 0) + g * g;
    sumSq[2] = (sumSq[2] ?? 0) + b * b;
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    hist[key] = (hist[key] ?? 0) + 1;
  }
  let maxStdDev = 0;
  for (let c = 0; c < 3; c++) {
    const mean = (sum[c] ?? 0) / pixels;
    const variance = Math.max(0, (sumSq[c] ?? 0) / pixels - mean * mean);
    maxStdDev = Math.max(maxStdDev, Math.sqrt(variance));
  }
  let best = 0;
  for (let k = 1; k < hist.length; k++) if ((hist[k] ?? 0) > (hist[best] ?? 0)) best = k;
  return {
    maxStdDev,
    dominant: {
      r: ((best >> 10) << 3) + 4,
      g: (((best >> 5) & 31) << 3) + 4,
      b: ((best & 31) << 3) + 4,
      share: (hist[best] ?? 0) / pixels,
    },
  };
}

/**
 * Below this spread an image counts as blank. A white page with one short line of 16 px
 * text is roughly 4–7; a page with nothing on it (or a single flat colour) is 0, and lossy
 * encoding noise stays well below 1.
 */
export const BLANK_STDDEV_THRESHOLD = 1.5;

/**
 * A capture is blank when every colour channel is (almost) uniform: an empty page, a page
 * that crashed before rendering, or a single flat colour. Such a screenshot is replaced by
 * the client thumbnail when there is one.
 */
export function isBlank(stats: PixelStats, threshold = BLANK_STDDEV_THRESHOLD): boolean {
  return stats.maxStdDev < threshold;
}

/** Decodes any image sharp can read into raw RGB. */
export async function decodeRaw(input: Uint8Array): Promise<RawImage> {
  const { data, info } = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

/** Decompression-bomb guard for images we did not make (client thumbnails). */
export const MAX_INPUT_PIXELS = 4096 * 4096;

/**
 * Encodes to WebP, stepping the quality down until it fits the bucket limit. Metadata is
 * never copied. With `fit`, the image is first scaled down to fit inside the box.
 */
export async function encodeWebp(
  input: Uint8Array,
  opts: { fit?: { width: number; height: number } } = {},
): Promise<Uint8Array> {
  for (const quality of [SCREENSHOT_WEBP_QUALITY, 55, 40]) {
    let img = sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).removeAlpha();
    if (opts.fit) {
      img = img.resize({
        width: opts.fit.width,
        height: opts.fit.height,
        fit: 'inside',
        withoutEnlargement: true,
      });
    }
    const out = await img.webp({ quality, effort: 4 }).toBuffer();
    if (out.byteLength <= MAX_SCREENSHOT_BYTES) return new Uint8Array(out);
  }
  throw new Error('the screenshot does not fit the bucket limit even at low quality');
}

/**
 * The worker's imaging: the render's pixels decide whether it is blank (`isBlank`), then
 * WebP; a thumbnail is decoded, scaled to fit and re-encoded.
 */
export const sharpImaging: CaptureImaging = {
  async screenshot(render) {
    const stats = pixelStats(await decodeRaw(render.image));
    if (isBlank(stats)) {
      return {
        ok: false,
        reason: `blank render (max channel std dev ${stats.maxStdDev.toFixed(2)})`,
      };
    }
    return { ok: true, webp: await encodeWebp(render.image) };
  },
  thumbnail(bytes, fit) {
    return encodeWebp(bytes, { fit });
  },
};
