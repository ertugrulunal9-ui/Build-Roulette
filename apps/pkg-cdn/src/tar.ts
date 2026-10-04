/**
 * Safe, streaming extraction of npm tarballs (gzip + ustar/pax/GNU tar) into a fresh directory.
 *
 * - Streaming: the tarball is inflated (`zlib.createGunzip`) and parsed chunk by chunk, and
 *   file data is written as it arrives, so memory use does not depend on the package size.
 *   Inflating is pulled by the parser (back-pressure), so a gzip bomb is never inflated past
 *   the point where a limit trips, and nothing after the end-of-archive marker is inflated.
 * - Only regular files and directories are extracted. Symlinks, hardlinks, devices and FIFOs
 *   are skipped, so nothing we write can point outside the destination.
 * - Paths are normalized and the first component (`package/`) is stripped, like npm does.
 *   Absolute paths, `..` segments, backslashes and control characters make the whole tarball
 *   invalid (a well-formed npm tarball never has them).
 * - Limits, enforced from each entry's header before its data is inflated: total entry data
 *   (files, skipped entries and pax/GNU metadata), number of entries, file count, metadata
 *   size, path length.
 * - Files are written with mode 0644 (never executable) and `wx` (never through an existing
 *   entry). The destination is a temporary directory that is renamed into place at the end.
 */
import { mkdir, open, rename, rm, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { pipeline, Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { CdnError, errorMessage } from './errors';
import { abortReason, throwIfAborted } from './limiter';

const BLOCK = 512;
const MAX_PATH = 1024;
const MAX_SEGMENT = 255;
/** pax extended headers and GNU long names are buffered; real ones are a few hundred bytes. */
const MAX_META_BYTES = 64 * 1024;
/** Filesystem allocation unit used to estimate disk usage. */
const DISK_BLOCK = 4096;

export interface ExtractLimits {
  maxUnpackedBytes: number;
  maxFiles: number;
}

export interface TarEntry {
  /** Raw path as stored (after pax / GNU long-name overrides). */
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'hardlink' | 'other';
  data: Buffer;
}

export type TarEvent =
  | { kind: 'entry'; path: string; type: TarEntry['type']; size: number }
  | { kind: 'data'; chunk: Buffer }
  | { kind: 'entry-end' }
  /** The end-of-archive marker: everything after it is ignored. */
  | { kind: 'end' };

export interface TarParserLimits {
  /** Sum of the data sizes of every entry, including skipped and metadata entries. */
  maxDataBytes: number;
  /** Number of headers of any kind. */
  maxEntries: number;
}

function unsafe(message: string): CdnError {
  return new CdnError(422, 'unsafe-tarball', message);
}

function tooLarge(message: string): CdnError {
  return new CdnError(413, 'too-large', message);
}

function mb(bytes: number): string {
  return Math.round(bytes / 1024 / 1024).toString();
}

function readString(buf: Buffer, offset: number, length: number): string {
  const slice = buf.subarray(offset, offset + length);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? slice.length : nul).toString('utf8');
}

function readOctal(buf: Buffer, offset: number, length: number): number {
  const first = buf[offset] ?? 0;
  if (first & 0x80) {
    // GNU base-256 encoding for large values.
    let value = first & 0x7f;
    for (let i = 1; i < length; i++) value = value * 256 + (buf[offset + i] ?? 0);
    return value;
  }
  const text = readString(buf, offset, length).trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) throw unsafe(`corrupt tar header (bad number "${text}")`);
  return parseInt(text, 8);
}

function checksumOk(header: Buffer): boolean {
  const stored = readOctal(header, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : (header[i] ?? 0);
  return sum === stored;
}

/** Parses pax extended header records (`<len> <key>=<value>\n`). */
export function parsePax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space === -1) break;
    const len = parseInt(data.subarray(pos, space).toString('ascii'), 10);
    if (!Number.isFinite(len) || len <= 0 || pos + len > data.length) break;
    const record = data.subarray(space + 1, pos + len - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    pos += len;
  }
  return out;
}

function entryType(typeflag: string): TarEntry['type'] {
  switch (typeflag) {
    case '0':
    case '\0':
    case '7':
      return 'file';
    case '5':
      return 'directory';
    case '2':
      return 'symlink';
    case '1':
      return 'hardlink';
    default:
      return 'other';
  }
}

/**
 * Incremental tar parser: feed it chunks of the uncompressed archive in order, get events.
 * `data` events are views into the chunk that was pushed (no copies). Limits are checked
 * when a header is read, before any of that entry's data has to be inflated.
 */
export class TarParser {
  private readonly header = Buffer.alloc(BLOCK);
  private headerLen = 0;
  private state: 'header' | 'data' | 'meta' | 'skip' | 'pad' | 'done' = 'header';
  /** Bytes left in the current entry's data (or padding, in the `pad` state). */
  private remaining = 0;
  private padding = 0;
  private metaType = '';
  private meta: Buffer[] = [];
  private paxPath: string | null = null;
  private paxSize: number | null = null;
  private longName: string | null = null;
  private dataBytes = 0;
  private entries = 0;

  constructor(private readonly limits: TarParserLimits) {}

  get done(): boolean {
    return this.state === 'done';
  }

  push(chunk: Buffer): TarEvent[] {
    const out: TarEvent[] = [];
    let off = 0;
    while (off < chunk.length && this.state !== 'done') {
      if (this.state === 'header') {
        const take = Math.min(BLOCK - this.headerLen, chunk.length - off);
        chunk.copy(this.header, this.headerLen, off, off + take);
        this.headerLen += take;
        off += take;
        if (this.headerLen === BLOCK) {
          this.headerLen = 0;
          this.readHeader(out);
        }
        continue;
      }
      const take = Math.min(this.remaining, chunk.length - off);
      const piece = chunk.subarray(off, off + take);
      off += take;
      this.remaining -= take;
      if (this.state === 'data') out.push({ kind: 'data', chunk: piece });
      else if (this.state === 'meta') this.meta.push(Buffer.from(piece));
      if (this.remaining === 0) this.finishSection(out);
    }
    return out;
  }

  /** Call when the input has ended. Throws when the archive stopped in the middle of an entry. */
  end(): void {
    if (this.state === 'done') return;
    // No end-of-archive marker but a clean block boundary: accepted (as before).
    if (this.state === 'header' && this.headerLen === 0) return;
    throw unsafe('truncated tar archive');
  }

  private finishSection(out: TarEvent[]): void {
    switch (this.state) {
      case 'data':
        out.push({ kind: 'entry-end' });
        break;
      case 'meta':
        this.applyMeta(Buffer.concat(this.meta));
        this.meta = [];
        break;
      default:
        break;
    }
    if (this.state !== 'pad' && this.padding > 0) {
      this.state = 'pad';
      this.remaining = this.padding;
      this.padding = 0;
    } else {
      this.state = 'header';
    }
  }

  private applyMeta(data: Buffer): void {
    if (this.metaType === 'x') {
      const pax = parsePax(data);
      this.paxPath = pax['path'] ?? null;
      this.paxSize = pax['size'] !== undefined ? Number(pax['size']) : null;
      if (this.paxSize !== null && (!Number.isSafeInteger(this.paxSize) || this.paxSize < 0)) {
        throw unsafe('corrupt pax size');
      }
    } else {
      this.longName = readString(data, 0, data.length);
    }
  }

  private readHeader(out: TarEvent[]): void {
    const header = this.header;
    if (header.every((b) => b === 0)) {
      this.state = 'done';
      out.push({ kind: 'end' });
      return;
    }
    if (!checksumOk(header)) throw unsafe('corrupt tar header (checksum mismatch)');
    if (++this.entries > this.limits.maxEntries) {
      throw tooLarge(`package has more than ${this.limits.maxEntries.toString()} tar entries`);
    }
    const typeflag = String.fromCharCode(header[156] ?? 0);
    const isMeta = typeflag === 'x' || typeflag === 'g' || typeflag === 'L' || typeflag === 'K';
    let size = readOctal(header, 124, 12);
    if (!isMeta && this.paxSize !== null) size = this.paxSize;
    if (!Number.isSafeInteger(size) || size < 0) throw unsafe('corrupt tar header (bad size)');
    this.dataBytes += size;
    if (this.dataBytes > this.limits.maxDataBytes) {
      throw tooLarge(`package is larger than ${mb(this.limits.maxDataBytes)} MB unpacked`);
    }
    this.remaining = size;
    this.padding = Math.ceil(size / BLOCK) * BLOCK - size;

    if (typeflag === 'x' || typeflag === 'L') {
      if (size > MAX_META_BYTES) throw unsafe('tar metadata entry is too large');
      this.metaType = typeflag;
      this.state = 'meta';
    } else if (isMeta) {
      // Global pax header / GNU long link name: nothing we use (links are skipped anyway).
      this.state = 'skip';
    } else {
      const name = readString(header, 0, 100);
      const magic = readString(header, 257, 6);
      const prefix = magic.startsWith('ustar') ? readString(header, 345, 155) : '';
      const rawPath = this.paxPath ?? this.longName ?? (prefix ? `${prefix}/${name}` : name);
      this.paxPath = null;
      this.paxSize = null;
      this.longName = null;
      out.push({ kind: 'entry', path: rawPath, type: entryType(typeflag), size });
      this.state = 'data';
    }
    if (size === 0) this.finishSection(out);
  }
}

/** Iterates over the entries of an uncompressed tar archive held in memory. */
export function* parseTar(tar: Buffer): Generator<TarEntry> {
  const parser = new TarParser({ maxDataBytes: Infinity, maxEntries: Infinity });
  let current: { path: string; type: TarEntry['type']; chunks: Buffer[] } | null = null;
  for (const ev of parser.push(tar)) {
    if (ev.kind === 'entry') current = { path: ev.path, type: ev.type, chunks: [] };
    else if (ev.kind === 'data') current?.chunks.push(ev.chunk);
    else if (ev.kind === 'entry-end' && current) {
      yield { path: current.path, type: current.type, data: Buffer.concat(current.chunks) };
      current = null;
    } else if (ev.kind === 'end') return;
  }
  parser.end();
}

/**
 * Normalizes a tar entry path and strips the leading package directory. Returns null for the
 * package directory itself. Throws for paths that try to escape.
 */
export function sanitizeEntryPath(raw: string): string | null {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what we reject
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) throw unsafe(`forbidden character in path "${raw}"`);
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) throw unsafe(`absolute path "${raw}"`);
  const segments = raw.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.some((s) => s === '..')) throw unsafe(`path traversal in "${raw}"`);
  if (segments.some((s) => s.length > MAX_SEGMENT)) throw unsafe('path segment too long');
  const rest = segments.slice(1);
  if (rest.length === 0) return null;
  const out = rest.join('/');
  if (out.length > MAX_PATH) throw unsafe('path too long');
  return out;
}

export interface ExtractResult {
  files: number;
  /** Bytes of file data written. */
  bytes: number;
  skipped: number;
  /** Estimated disk usage: files and directories rounded up to 4 KiB blocks. */
  diskBytes: number;
}

export function diskSize(bytes: number): number {
  return Math.max(DISK_BLOCK, Math.ceil(bytes / DISK_BLOCK) * DISK_BLOCK);
}

async function writeAll(fh: FileHandle, data: Buffer): Promise<void> {
  let off = 0;
  while (off < data.length) {
    const { bytesWritten } = await fh.write(data, off, data.length - off);
    off += bytesWritten;
  }
}

function isZlibError(e: unknown): boolean {
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' && code.startsWith('Z_');
}

/**
 * Extracts a `.tgz` (bytes or a stream of bytes) into `dest`, which must not exist yet.
 * Writes into `dest + '.tmp-*'` first and renames it into place, so a crash never leaves a
 * half-extracted package behind. An aborted `signal` stops inflating at once and cleans up.
 */
export async function extractTarball(
  input: Uint8Array | Readable,
  dest: string,
  limits: ExtractLimits,
  signal?: AbortSignal,
): Promise<ExtractResult> {
  throwIfAborted(signal);
  const source = input instanceof Uint8Array ? Readable.from([Buffer.from(input)]) : input;
  const gunzip = createGunzip();
  const inflated = pipeline(source, gunzip, () => {
    // Errors reach the consumer through `inflated` (pipeline destroys it with the error).
  });
  const onAbort = () => inflated.destroy(abortReason(signal));
  signal?.addEventListener('abort', onAbort, { once: true });

  const parser = new TarParser({
    maxDataBytes: limits.maxUnpackedBytes,
    // Files, plus directories, skipped links and pax headers: each header is 512 bytes.
    maxEntries: limits.maxFiles * 3 + 64,
  });
  const tmp = `${dest}.tmp-${process.pid.toString()}-${Math.random().toString(36).slice(2)}`;
  const tmpRoot = path.resolve(tmp);
  const result: ExtractResult = { files: 0, bytes: 0, skipped: 0, diskBytes: DISK_BLOCK };
  const seen = new Set<string>();
  const dirs = new Set<string>([tmpRoot]);
  let fh: FileHandle | null = null;

  const ensureDir = async (dir: string) => {
    if (dirs.has(dir)) return;
    await mkdir(dir, { recursive: true });
    // Count every new ancestor once.
    for (let d = dir; !dirs.has(d); d = path.dirname(d)) {
      dirs.add(d);
      result.diskBytes += DISK_BLOCK;
    }
  };

  try {
    await mkdir(tmpRoot, { recursive: true });
    reading: for await (const chunk of inflated as AsyncIterable<Buffer>) {
      throwIfAborted(signal);
      for (const ev of parser.push(chunk)) {
        if (ev.kind === 'end') break reading;
        if (ev.kind === 'data') {
          if (fh) await writeAll(fh, ev.chunk);
          continue;
        }
        if (ev.kind === 'entry-end') {
          if (fh) await fh.close();
          fh = null;
          continue;
        }
        if (ev.type !== 'file' && ev.type !== 'directory') {
          result.skipped++;
          continue;
        }
        const rel = sanitizeEntryPath(ev.path);
        if (rel === null) continue;
        const target = path.resolve(tmpRoot, rel);
        // Defense in depth: sanitizeEntryPath already guarantees this.
        if (!target.startsWith(tmpRoot + path.sep)) throw unsafe(`path escapes package: ${rel}`);
        if (ev.type === 'directory') {
          await ensureDir(target);
          continue;
        }
        if (++result.files > limits.maxFiles) {
          throw tooLarge(`package has more than ${limits.maxFiles.toString()} files`);
        }
        result.bytes += ev.size;
        result.diskBytes += diskSize(ev.size);
        await ensureDir(path.dirname(target));
        // A path that appears twice: the later entry wins (tar semantics).
        if (seen.has(rel)) await rm(target, { force: true });
        seen.add(rel);
        fh = await open(target, 'wx', 0o644);
      }
    }
    throwIfAborted(signal);
    parser.end();
  } catch (e) {
    if (fh) await fh.close().catch(() => undefined);
    await rm(tmpRoot, { recursive: true, force: true });
    if (signal?.aborted) throw abortReason(signal);
    if (e instanceof CdnError) throw e;
    if (isZlibError(e)) throw unsafe(`tarball is not valid gzip: ${errorMessage(e)}`);
    throw unsafe(`could not extract tarball: ${errorMessage(e)}`);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    // Stops inflating (and reading the source) if we finished early, e.g. at the end marker.
    inflated.destroy();
  }
  await renameIntoPlace(tmpRoot, dest);
  return result;
}

/**
 * Atomically moves a finished temporary directory to `dest`. If another request (or process)
 * finished the same work first, theirs wins and ours is discarded.
 */
export async function renameIntoPlace(tmp: string, dest: string): Promise<void> {
  try {
    await rename(tmp, dest);
  } catch (e) {
    await rm(tmp, { recursive: true, force: true });
    const code = (e as { code?: string }).code;
    if (code !== 'ENOTEMPTY' && code !== 'EEXIST') throw e;
  }
}
