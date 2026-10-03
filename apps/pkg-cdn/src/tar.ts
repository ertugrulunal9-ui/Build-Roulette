/**
 * Safe extraction of npm tarballs (gzip + ustar/pax/GNU tar) into a fresh directory.
 *
 * - Only regular files and directories are extracted. Symlinks, hardlinks, devices and FIFOs
 *   are skipped, so nothing we write can point outside the destination.
 * - Paths are normalized and the first component (`package/`) is stripped, like npm does.
 *   Absolute paths, `..` segments, backslashes and control characters make the whole tarball
 *   invalid (a well-formed npm tarball never has them).
 * - Limits: decompressed size (enforced while inflating), file count, path length.
 * - Files are written with mode 0644 (never executable) and `wx` (never through an existing
 *   entry). The destination is a temporary directory that is renamed into place at the end.
 */
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { CdnError, errorMessage } from './errors';

const gunzipAsync = promisify(gunzip);

const BLOCK = 512;
const MAX_PATH = 1024;
const MAX_SEGMENT = 255;

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

function unsafe(message: string): CdnError {
  return new CdnError(422, 'unsafe-tarball', message);
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

/** Iterates over the entries of an uncompressed tar archive. */
export function* parseTar(tar: Buffer): Generator<TarEntry> {
  let offset = 0;
  let paxPath: string | null = null;
  let paxSize: number | null = null;
  let longName: string | null = null;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((b) => b === 0)) return; // end-of-archive marker
    if (!checksumOk(header)) throw unsafe('corrupt tar header (checksum mismatch)');
    const typeflag = String.fromCharCode(header[156] ?? 0);
    let size = readOctal(header, 124, 12);
    if (paxSize !== null) size = paxSize;
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw unsafe('truncated tar archive');
    const data = tar.subarray(dataStart, dataEnd);
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (typeflag === 'x') {
      const pax = parsePax(data);
      paxPath = pax['path'] ?? null;
      paxSize = pax['size'] !== undefined ? Number(pax['size']) : null;
      if (paxSize !== null && (!Number.isSafeInteger(paxSize) || paxSize < 0)) {
        throw unsafe('corrupt pax size');
      }
      continue;
    }
    if (typeflag === 'g') continue; // global pax header: nothing we use
    if (typeflag === 'L') {
      longName = readString(data, 0, data.length);
      continue;
    }
    if (typeflag === 'K') continue; // GNU long link name: links are skipped anyway

    const name = readString(header, 0, 100);
    const magic = readString(header, 257, 6);
    const prefix = magic.startsWith('ustar') ? readString(header, 345, 155) : '';
    const rawPath = paxPath ?? longName ?? (prefix ? `${prefix}/${name}` : name);
    paxPath = null;
    paxSize = null;
    longName = null;

    let type: TarEntry['type'];
    switch (typeflag) {
      case '0':
      case '\0':
      case '7':
        type = 'file';
        break;
      case '5':
        type = 'directory';
        break;
      case '2':
        type = 'symlink';
        break;
      case '1':
        type = 'hardlink';
        break;
      default:
        type = 'other';
    }
    yield { path: rawPath, type, data };
  }
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

export async function gunzipLimited(tgz: Uint8Array, maxBytes: number): Promise<Buffer> {
  try {
    return await gunzipAsync(tgz, { maxOutputLength: maxBytes });
  } catch (e) {
    if ((e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE' || e instanceof RangeError) {
      throw new CdnError(
        413,
        'too-large',
        `package is larger than ${Math.round(maxBytes / 1024 / 1024)} MB unpacked`,
      );
    }
    throw unsafe(`tarball is not valid gzip: ${errorMessage(e)}`);
  }
}

export interface ExtractResult {
  files: number;
  bytes: number;
  skipped: number;
}

/**
 * Extracts a `.tgz` into `dest`, which must not exist yet. Writes into `dest + '.tmp-*'` first
 * and renames it into place, so a crash never leaves a half-extracted package behind.
 */
export async function extractTarball(
  tgz: Uint8Array,
  dest: string,
  limits: ExtractLimits,
): Promise<ExtractResult> {
  const tar = await gunzipLimited(tgz, limits.maxUnpackedBytes);
  const tmp = `${dest}.tmp-${process.pid.toString()}-${Math.random().toString(36).slice(2)}`;
  const tmpRoot = path.resolve(tmp);
  const result: ExtractResult = { files: 0, bytes: 0, skipped: 0 };
  const seen = new Set<string>();
  await mkdir(tmpRoot, { recursive: true });
  try {
    for (const entry of parseTar(tar)) {
      if (entry.type !== 'file' && entry.type !== 'directory') {
        result.skipped++;
        continue;
      }
      const rel = sanitizeEntryPath(entry.path);
      if (rel === null) continue;
      const target = path.resolve(tmpRoot, rel);
      // Defense in depth: sanitizeEntryPath already guarantees this.
      if (!target.startsWith(tmpRoot + path.sep)) throw unsafe(`path escapes package: ${rel}`);
      if (entry.type === 'directory') {
        await mkdir(target, { recursive: true });
        continue;
      }
      if (++result.files > limits.maxFiles) {
        throw new CdnError(413, 'too-large', `package has more than ${limits.maxFiles} files`);
      }
      result.bytes += entry.data.length;
      await mkdir(path.dirname(target), { recursive: true });
      // A path that appears twice: the later entry wins (tar semantics).
      if (seen.has(rel)) await rm(target, { force: true });
      seen.add(rel);
      await writeFile(target, entry.data, { flag: 'wx', mode: 0o644 });
    }
  } catch (e) {
    await rm(tmpRoot, { recursive: true, force: true });
    if (e instanceof CdnError) throw e;
    throw unsafe(`could not extract tarball: ${errorMessage(e)}`);
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
