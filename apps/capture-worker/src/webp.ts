/**
 * WebP containers without a decoder (pure TS, no sharp): for the `jobs` Edge Function
 * (T-034), where sharp cannot run. Spec: https://developers.google.com/speed/webp/docs/riff_container
 *
 * `parseWebp` reads the RIFF chunks and the image size from the bitstream header.
 * `sanitizeWebp` rebuilds a file from the image chunks only:
 * - accepted: one still image, lossy (`VP8 `, optionally with `ALPH` inside `VP8X`) or
 *   lossless (`VP8L`);
 * - dropped: `ICCP`, `EXIF`, `XMP `, unknown chunks, trailing bytes;
 * - refused: animations (`ANIM`/`ANMF`), several images, sizes that disagree, a bitstream
 *   whose header is wrong, images over the size or byte limits.
 *
 * The self-hosted worker decodes and re-encodes a client thumbnail with sharp (a client file
 * is never stored as uploaded). The function cannot, so it stores the thumbnail's own
 * bitstream in a container it wrote itself: no metadata, one still image of known size, and
 * the bucket serves it as image/webp. A broken bitstream simply fails to decode in a
 * browser, like any corrupt image.
 */

export class WebpError extends Error {
  constructor(message: string) {
    super(`webp: ${message}`);
    this.name = 'WebpError';
  }
}

export interface WebpInfo {
  width: number;
  height: number;
  /** `VP8L` (lossless) rather than `VP8 `. */
  lossless: boolean;
  /** Has an `ALPH` chunk (lossy) or the alpha hint (lossless). */
  alpha: boolean;
  /** FourCCs in file order (for logs and tests). */
  chunks: string[];
}

interface Chunk {
  fourcc: string;
  /** Payload without the 8-byte header and without the pad byte. */
  data: Uint8Array;
}

const VP8X_FLAG_ALPHA = 0x10;
const VP8X_FLAG_ANIMATION = 0x02;

function fourcc(b: Uint8Array, at: number): string {
  return String.fromCharCode(b[at] ?? 0, b[at + 1] ?? 0, b[at + 2] ?? 0, b[at + 3] ?? 0);
}

function u32le(b: Uint8Array, at: number): number {
  return (
    ((b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16)) + (b[at + 3] ?? 0) * 2 ** 24
  );
}

function u24le(b: Uint8Array, at: number): number {
  return (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16);
}

function readChunks(bytes: Uint8Array): Chunk[] {
  if (bytes.length < 20 || fourcc(bytes, 0) !== 'RIFF' || fourcc(bytes, 8) !== 'WEBP') {
    throw new WebpError('not a RIFF/WEBP file');
  }
  const riffEnd = 8 + u32le(bytes, 4);
  if (riffEnd > bytes.length) throw new WebpError('truncated (RIFF size past the end)');
  const chunks: Chunk[] = [];
  let at = 12;
  while (at < riffEnd) {
    if (at + 8 > riffEnd) throw new WebpError('truncated chunk header');
    const size = u32le(bytes, at + 4);
    const start = at + 8;
    if (start + size > riffEnd) throw new WebpError(`chunk ${fourcc(bytes, at)} past the end`);
    chunks.push({ fourcc: fourcc(bytes, at), data: bytes.subarray(start, start + size) });
    at = start + size + (size % 2);
    if (chunks.length > 64) throw new WebpError('too many chunks');
  }
  return chunks;
}

function vp8Size(data: Uint8Array): { width: number; height: number } {
  // Frame tag (3 bytes): bit 0 is 0 for a key frame. Then the start code 9d 01 2a and the
  // 14-bit width and height (the top two bits are a scale we ignore).
  if (data.length < 10) throw new WebpError('VP8 bitstream too short');
  if (((data[0] ?? 1) & 1) !== 0) throw new WebpError('VP8 bitstream is not a key frame');
  if (data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a) {
    throw new WebpError('VP8 start code missing');
  }
  return {
    width: ((data[6] ?? 0) | ((data[7] ?? 0) << 8)) & 0x3fff,
    height: ((data[8] ?? 0) | ((data[9] ?? 0) << 8)) & 0x3fff,
  };
}

function vp8lSize(data: Uint8Array): { width: number; height: number; alpha: boolean } {
  if (data.length < 5 || data[0] !== 0x2f) throw new WebpError('VP8L signature missing');
  const bits = u32le(data, 1);
  const version = Math.floor(bits / 2 ** 29) & 0x7;
  if (version !== 0) throw new WebpError('VP8L version is not 0');
  return {
    width: (bits & 0x3fff) + 1,
    height: ((bits >>> 14) & 0x3fff) + 1,
    alpha: ((bits >>> 28) & 1) === 1,
  };
}

interface Parsed {
  info: WebpInfo;
  image: Chunk;
  alph: Chunk | null;
}

function parse(bytes: Uint8Array): Parsed {
  const chunks = readChunks(bytes);
  const names = chunks.map((c) => c.fourcc);
  if (names.includes('ANIM') || names.includes('ANMF')) throw new WebpError('animated');
  const images = chunks.filter((c) => c.fourcc === 'VP8 ' || c.fourcc === 'VP8L');
  if (images.length !== 1)
    throw new WebpError(`expected one image, found ${String(images.length)}`);
  const image = images[0] as Chunk;
  const alphs = chunks.filter((c) => c.fourcc === 'ALPH');
  if (alphs.length > 1) throw new WebpError('several ALPH chunks');
  const alph = alphs[0] ?? null;
  const vp8x = chunks.find((c) => c.fourcc === 'VP8X') ?? null;
  if (vp8x && chunks[0] !== vp8x) throw new WebpError('VP8X is not the first chunk');
  if (!vp8x && chunks.length !== 1) throw new WebpError('extra chunks without VP8X');

  let width: number;
  let height: number;
  let alpha: boolean;
  if (image.fourcc === 'VP8L') {
    if (alph) throw new WebpError('ALPH next to a lossless image');
    ({ width, height, alpha } = vp8lSize(image.data));
  } else {
    ({ width, height } = vp8Size(image.data));
    alpha = alph !== null;
  }
  if (width === 0 || height === 0) throw new WebpError('zero-sized image');
  if (vp8x) {
    if (vp8x.data.length < 10) throw new WebpError('VP8X too short');
    if (((vp8x.data[0] ?? 0) & VP8X_FLAG_ANIMATION) !== 0) throw new WebpError('animated');
    const cw = u24le(vp8x.data, 4) + 1;
    const ch = u24le(vp8x.data, 7) + 1;
    if (cw !== width || ch !== height) {
      throw new WebpError('VP8X canvas size differs from the image size');
    }
  }
  return {
    info: { width, height, lossless: image.fourcc === 'VP8L', alpha, chunks: names },
    image,
    alph,
  };
}

/** Reads a WebP's chunks and image size. Throws `WebpError` when it is not a usable still WebP. */
export function parseWebp(bytes: Uint8Array): WebpInfo {
  return parse(bytes).info;
}

export interface SanitizeLimits {
  maxWidth: number;
  maxHeight: number;
  maxBytes: number;
}

function chunkBytes(fourccName: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + data.length + (data.length % 2));
  for (let i = 0; i < 4; i++) out[i] = fourccName.charCodeAt(i);
  new DataView(out.buffer).setUint32(4, data.length, true);
  out.set(data, 8);
  return out;
}

/**
 * A new WebP holding only the image (and its alpha): see the module comment. Throws
 * `WebpError` when the input is refused or over a limit.
 */
export function sanitizeWebp(bytes: Uint8Array, limits: SanitizeLimits): Uint8Array {
  const { info, image, alph } = parse(bytes);
  if (info.width > limits.maxWidth || info.height > limits.maxHeight) {
    throw new WebpError(
      `${String(info.width)}×${String(info.height)} is larger than ${String(limits.maxWidth)}×${String(limits.maxHeight)}`,
    );
  }
  const parts: Uint8Array[] = [];
  if (alph) {
    // Flags (alpha only), 3 reserved bytes, then the canvas size minus one as two 24-bit
    // little-endian numbers.
    const w = info.width - 1;
    const h = info.height - 1;
    const vp8x = new Uint8Array([
      VP8X_FLAG_ALPHA,
      0,
      0,
      0,
      w & 0xff,
      (w >> 8) & 0xff,
      (w >> 16) & 0xff,
      h & 0xff,
      (h >> 8) & 0xff,
      (h >> 16) & 0xff,
    ]);
    parts.push(chunkBytes('VP8X', vp8x), chunkBytes('ALPH', alph.data));
  }
  parts.push(chunkBytes(image.fourcc, image.data));
  const body = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(12 + body);
  out.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  new DataView(out.buffer).setUint32(4, 4 + body, true);
  out.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  let at = 12;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  if (out.length > limits.maxBytes) {
    throw new WebpError(
      `${String(out.length)} bytes is over the ${String(limits.maxBytes)}-byte limit`,
    );
  }
  return out;
}
