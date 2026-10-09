import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  BLANK_STDDEV_THRESHOLD,
  decodeRaw,
  encodeWebp,
  isBlank,
  pixelStats,
  type RawImage,
} from '../src/image';
import { MAX_SCREENSHOT_BYTES } from '../src/imaging';
import { imageWithBlock, solidImage } from './fakes';

function raw(width: number, height: number, fill: (x: number, y: number) => number[]): RawImage {
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r = 0, g = 0, b = 0] = fill(x, y);
      data.set([r, g, b], (y * width + x) * 3);
    }
  }
  return { data, width, height, channels: 3 };
}

describe('pixelStats', () => {
  it('a flat image has zero spread and is its own dominant colour', () => {
    const s = pixelStats(raw(10, 10, () => [255, 87, 34]));
    expect(s.maxStdDev).toBe(0);
    expect(s.dominant.share).toBe(1);
    expect(s.dominant.r).toBe(252); // bucket centre of 255 at 32 levels
    expect(Math.abs(s.dominant.g - 87)).toBeLessThanOrEqual(4);
    expect(Math.abs(s.dominant.b - 34)).toBeLessThanOrEqual(4);
  });

  it('half black, half white: std dev 127.5 on every channel', () => {
    const s = pixelStats(raw(10, 10, (x) => (x < 5 ? [0, 0, 0] : [255, 255, 255])));
    expect(s.maxStdDev).toBeCloseTo(127.5, 5);
    expect(s.dominant.share).toBeCloseTo(0.5, 5);
  });

  it('ignores alpha and rejects malformed input', () => {
    const rgba = new Uint8Array([1, 2, 3, 0, 1, 2, 3, 255]);
    expect(pixelStats({ data: rgba, width: 2, height: 1, channels: 4 }).maxStdDev).toBe(0);
    expect(() =>
      pixelStats({ data: new Uint8Array(3), width: 2, height: 1, channels: 3 }),
    ).toThrow();
    expect(() =>
      pixelStats({ data: new Uint8Array(0), width: 0, height: 0, channels: 3 }),
    ).toThrow();
  });
});

describe('isBlank (simple pixel-variance check)', () => {
  it('flat white and flat colour pages are blank', () => {
    expect(isBlank(pixelStats(raw(64, 40, () => [255, 255, 255])))).toBe(true);
    expect(isBlank(pixelStats(raw(64, 40, () => [30, 144, 255])))).toBe(true);
  });

  it('a white 1280×800 page with a small dark word on it is not blank', () => {
    // 60×16 px of "text": 0.09 % of the pixels.
    const img = raw(1280, 800, (x, y) =>
      x >= 600 && x < 660 && y >= 392 && y < 408 ? [20, 20, 20] : [255, 255, 255],
    );
    const s = pixelStats(img);
    expect(s.maxStdDev).toBeGreaterThan(BLANK_STDDEV_THRESHOLD);
    expect(isBlank(s)).toBe(false);
  });

  it('a flat page stays blank after lossy WebP encoding (codec noise is below the threshold)', async () => {
    const webp = await solidImage(1280, 800, { r: 250, g: 250, b: 250 }, 'webp');
    expect(isBlank(pixelStats(await decodeRaw(webp)))).toBe(true);
  });

  it('a real screenshot-like image survives a PNG → raw round trip as not blank', async () => {
    const png = await imageWithBlock(
      1280,
      800,
      { r: 255, g: 255, b: 255 },
      { r: 255, g: 87, b: 34, left: 100, top: 100, width: 400, height: 200 },
    );
    const s = pixelStats(await decodeRaw(png));
    expect(isBlank(s)).toBe(false);
    expect(s.dominant).toMatchObject({ r: 252, g: 252, b: 252 });
  });
});

describe('encodeWebp', () => {
  it('encodes a PNG to WebP without metadata and keeps the size', async () => {
    const png = await imageWithBlock(
      1280,
      800,
      { r: 0, g: 0, b: 0 },
      { r: 255, g: 255, b: 255, left: 0, top: 0, width: 640, height: 800 },
    );
    const webp = await encodeWebp(png);
    const meta = await sharp(webp).metadata();
    expect(meta.format).toBe('webp');
    expect([meta.width, meta.height]).toEqual([1280, 800]);
    expect(meta.exif).toBeUndefined();
    expect(webp.byteLength).toBeLessThan(MAX_SCREENSHOT_BYTES);
  });

  it('fit: scales a large thumbnail down into the box, never up', async () => {
    const big = await solidImage(2560, 1600, { r: 1, g: 2, b: 3 }, 'webp');
    const small = await solidImage(320, 200, { r: 1, g: 2, b: 3 }, 'webp');
    const box = { width: 1280, height: 800 };
    const a = await sharp(await encodeWebp(big, { fit: box })).metadata();
    const b = await sharp(await encodeWebp(small, { fit: box })).metadata();
    expect([a.width, a.height]).toEqual([1280, 800]);
    expect([b.width, b.height]).toEqual([320, 200]);
  });

  it('rejects bytes that are not an image', async () => {
    await expect(encodeWebp(new TextEncoder().encode('not an image'))).rejects.toThrow();
  });
});
