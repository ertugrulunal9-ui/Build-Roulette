/**
 * The pure-TS WebP container code (T-034), against files libwebp (sharp) wrote.
 */
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { WebpError, parseWebp, sanitizeWebp } from '../src/webp';

const LIMITS = { maxWidth: 1280, maxHeight: 800, maxBytes: 2 * 1024 * 1024 };

async function webp(
  width: number,
  height: number,
  opts: { lossless?: boolean; alpha?: boolean; exif?: boolean } = {},
): Promise<Uint8Array> {
  let img = sharp({
    create: {
      width,
      height,
      channels: opts.alpha ? 4 : 3,
      background: opts.alpha ? { r: 10, g: 200, b: 30, alpha: 0.5 } : { r: 10, g: 200, b: 30 },
    },
  });
  if (opts.exif) img = img.withMetadata({ exif: { IFD0: { Copyright: 'secret-exif-text' } } });
  return new Uint8Array(await img.webp({ lossless: opts.lossless ?? false }).toBuffer());
}

/** A RIFF/WEBP file from chunks (fourcc, payload). */
function riff(chunks: [string, Uint8Array][]): Uint8Array {
  const parts = chunks.map(([fourcc, data]) => {
    const out = new Uint8Array(8 + data.length + (data.length % 2));
    out.set(new TextEncoder().encode(fourcc), 0);
    new DataView(out.buffer).setUint32(4, data.length, true);
    out.set(data, 8);
    return out;
  });
  const body = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(12 + body);
  out.set(new TextEncoder().encode('RIFF'), 0);
  new DataView(out.buffer).setUint32(4, 4 + body, true);
  out.set(new TextEncoder().encode('WEBP'), 8);
  let at = 12;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function chunk(bytes: Uint8Array, fourcc: string): Uint8Array {
  const info = parseWebp(bytes);
  expect(info.chunks).toContain(fourcc);
  let at = 12;
  for (;;) {
    const size = new DataView(bytes.buffer, bytes.byteOffset).getUint32(at + 4, true);
    if (new TextDecoder().decode(bytes.subarray(at, at + 4)) === fourcc) {
      return bytes.slice(at + 8, at + 8 + size);
    }
    at += 8 + size + (size % 2);
  }
}

describe('parseWebp', () => {
  it('reads the size of lossy, lossless and alpha images', async () => {
    expect(parseWebp(await webp(640, 400))).toMatchObject({
      width: 640,
      height: 400,
      lossless: false,
      alpha: false,
      chunks: ['VP8 '],
    });
    expect(parseWebp(await webp(321, 123, { lossless: true }))).toMatchObject({
      width: 321,
      height: 123,
      lossless: true,
    });
    const alpha = parseWebp(await webp(200, 100, { alpha: true }));
    expect(alpha).toMatchObject({ width: 200, height: 100, alpha: true });
    expect(alpha.chunks).toContain('VP8X');
  });

  it('refuses what is not one still WebP', async () => {
    const vp8 = chunk(await webp(64, 64), 'VP8 ');
    const bad: [string, Uint8Array][] = [
      ['not riff', new TextEncoder().encode('GIF89a not a webp at all, sorry')],
      [
        'two images',
        riff([
          ['VP8 ', vp8],
          ['VP8 ', vp8],
        ]),
      ],
      ['no image', riff([['XMP ', new Uint8Array(10)]])],
      [
        'animation',
        riff([
          ['VP8X', new Uint8Array([0x02, 0, 0, 0, 63, 0, 0, 63, 0, 0])],
          ['ANIM', new Uint8Array(6)],
          ['VP8 ', vp8],
        ]),
      ],
      [
        'extra chunk without VP8X',
        riff([
          ['VP8 ', vp8],
          ['EXIF', new Uint8Array(8)],
        ]),
      ],
      [
        'canvas size mismatch',
        riff([
          ['VP8X', new Uint8Array([0, 0, 0, 0, 99, 0, 0, 63, 0, 0])],
          ['VP8 ', vp8],
        ]),
      ],
      ['not a key frame', riff([['VP8 ', Uint8Array.from([1, ...vp8.slice(1)])]])],
      [
        'no start code',
        riff([['VP8 ', Uint8Array.from([...vp8.slice(0, 3), 0, 0, 0, ...vp8.slice(6)])]]),
      ],
    ];
    for (const [what, bytes] of bad) expect(() => parseWebp(bytes), what).toThrow(WebpError);
    const truncated = (await webp(64, 64)).slice(0, 40);
    expect(() => parseWebp(truncated)).toThrow(/truncated|past the end/);
  });
});

describe('sanitizeWebp', () => {
  it('keeps the image and drops metadata (EXIF), and the result still decodes the same', async () => {
    const input = await webp(640, 400, { exif: true });
    expect(parseWebp(input).chunks).toContain('EXIF');
    expect(new TextDecoder('latin1').decode(input)).toContain('secret-exif-text');
    const out = sanitizeWebp(input, LIMITS);
    expect(parseWebp(out).chunks).toEqual(['VP8 ']);
    expect(new TextDecoder('latin1').decode(out)).not.toContain('secret-exif-text');
    const a = await sharp(input).raw().toBuffer();
    const b = await sharp(out).raw().toBuffer();
    expect(Buffer.compare(a, b)).toBe(0);
    expect((await sharp(out).metadata()).exif).toBeUndefined();
  });

  it('keeps the alpha channel of a lossy image (VP8X + ALPH) and lossless images as they are', async () => {
    const alpha = await webp(200, 100, { alpha: true, exif: true });
    const out = sanitizeWebp(alpha, LIMITS);
    expect(parseWebp(out)).toMatchObject({ chunks: ['VP8X', 'ALPH', 'VP8 '], alpha: true });
    const meta = await sharp(out).metadata();
    expect([meta.width, meta.height, meta.hasAlpha]).toEqual([200, 100, true]);

    const lossless = await webp(50, 30, { lossless: true });
    const ll = sanitizeWebp(lossless, LIMITS);
    expect(parseWebp(ll).chunks).toEqual(['VP8L']);
    expect(
      Buffer.compare(await sharp(lossless).raw().toBuffer(), await sharp(ll).raw().toBuffer()),
    ).toBe(0);
  });

  it('refuses images over the size or byte limits', async () => {
    const big = await webp(1281, 100);
    expect(() => sanitizeWebp(big, LIMITS)).toThrow(/larger than 1280×800/);
    const ok = await webp(640, 400);
    expect(() => sanitizeWebp(ok, { ...LIMITS, maxBytes: 10 })).toThrow(/over the 10-byte limit/);
  });
});
