/**
 * The site pack (docs/09 §9.2): one imported site as one immutable binary object
 * (`site.bin` in storage, the `site` of a v2 `load`).
 *
 *   "BRSITE1\n"                      8 bytes, magic
 *   header length                    u32, little endian
 *   header                           UTF-8 JSON {v: 1, files: [{p, t, s}]}
 *   file bytes                       every file's bytes, in header order
 *
 * `p` is the path inside the site, `t` its content type, `s` its size. Files are sorted by
 * path. `unpackSite` checks everything, because a pack read back from storage or posted to the
 * shell is only as trustworthy as whoever wrote it. No dependencies: the sandbox shell and the
 * capture page bundle this file.
 */
import { isValidContentType } from './content-types';
import { SITE_LIMITS } from './limits';
import { isValidSitePath } from './paths';

const MAGIC = 'BRSITE1\n';
const MAGIC_BYTES = new TextEncoder().encode(MAGIC);
const PREFIX_BYTES = MAGIC_BYTES.length + 4;
export const PACK_VERSION = 1;
/** The file a site must have at its root. */
export const SITE_ENTRY = 'index.html';

export interface SiteFile {
  path: string;
  type: string;
  bytes: Uint8Array;
}

/** An unpacked site: its files by path. */
export type SiteFiles = ReadonlyMap<string, SiteFile>;

export class SitePackError extends Error {
  override readonly name = 'SitePackError';
}

interface HeaderEntry {
  p: string;
  t: string;
  s: number;
}

/**
 * Packs `files` (paths valid, unique, `index.html` among them). Throws `SitePackError` when
 * they are not, or when the pack would exceed `SITE_LIMITS`.
 */
export function packSite(files: readonly SiteFile[]): Uint8Array<ArrayBuffer> {
  if (files.length > SITE_LIMITS.maxFiles) {
    throw new SitePackError(`too many files (${files.length} > ${SITE_LIMITS.maxFiles})`);
  }
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const seen = new Set<string>();
  for (const f of sorted) {
    if (!isValidSitePath(f.path)) throw new SitePackError(`invalid path: ${f.path}`);
    if (!isValidContentType(f.type)) throw new SitePackError(`invalid content type: ${f.type}`);
    if (seen.has(f.path)) throw new SitePackError(`duplicate path: ${f.path}`);
    seen.add(f.path);
  }
  if (!seen.has(SITE_ENTRY)) throw new SitePackError(`no ${SITE_ENTRY}`);
  const header: { v: number; files: HeaderEntry[] } = {
    v: PACK_VERSION,
    files: sorted.map((f) => ({ p: f.path, t: f.type, s: f.bytes.byteLength })),
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  if (headerBytes.byteLength > SITE_LIMITS.maxHeaderBytes) {
    throw new SitePackError('file list too large');
  }
  const total =
    PREFIX_BYTES + headerBytes.byteLength + sorted.reduce((n, f) => n + f.bytes.byteLength, 0);
  if (total > SITE_LIMITS.maxPackBytes) {
    throw new SitePackError(`site too large (${total} > ${SITE_LIMITS.maxPackBytes} bytes)`);
  }
  const out = new Uint8Array(total);
  out.set(MAGIC_BYTES, 0);
  new DataView(out.buffer).setUint32(MAGIC_BYTES.length, headerBytes.byteLength, true);
  out.set(headerBytes, PREFIX_BYTES);
  let offset = PREFIX_BYTES + headerBytes.byteLength;
  for (const f of sorted) {
    out.set(f.bytes, offset);
    offset += f.bytes.byteLength;
  }
  return out;
}

/**
 * Reads a pack. The returned files' `bytes` are views into `data` (no copy). Throws
 * `SitePackError` for anything that is not a well-formed pack within `SITE_LIMITS`.
 */
export function unpackSite(data: ArrayBuffer | Uint8Array): SiteFiles {
  const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (buf.byteLength > SITE_LIMITS.maxPackBytes) throw new SitePackError('pack too large');
  if (buf.byteLength < PREFIX_BYTES) throw new SitePackError('not a site pack');
  for (let i = 0; i < MAGIC_BYTES.length; i++) {
    if (buf[i] !== MAGIC_BYTES[i]) throw new SitePackError('not a site pack');
  }
  const headerLength = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(
    MAGIC_BYTES.length,
    true,
  );
  if (headerLength > SITE_LIMITS.maxHeaderBytes || PREFIX_BYTES + headerLength > buf.byteLength) {
    throw new SitePackError('bad header length');
  }
  let header: unknown;
  try {
    header = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        buf.subarray(PREFIX_BYTES, PREFIX_BYTES + headerLength),
      ),
    );
  } catch {
    throw new SitePackError('bad header');
  }
  const entries = parseHeader(header);
  const files = new Map<string, SiteFile>();
  let offset = PREFIX_BYTES + headerLength;
  for (const e of entries) {
    if (offset + e.s > buf.byteLength) throw new SitePackError('truncated pack');
    files.set(e.p, { path: e.p, type: e.t, bytes: buf.subarray(offset, offset + e.s) });
    offset += e.s;
  }
  if (offset !== buf.byteLength) throw new SitePackError('trailing bytes');
  return files;
}

function parseHeader(header: unknown): HeaderEntry[] {
  if (typeof header !== 'object' || header === null) throw new SitePackError('bad header');
  const h = header as { v?: unknown; files?: unknown };
  if (h.v !== PACK_VERSION) throw new SitePackError('unsupported pack version');
  if (!Array.isArray(h.files) || h.files.length > SITE_LIMITS.maxFiles) {
    throw new SitePackError('bad file list');
  }
  const seen = new Set<string>();
  const out: HeaderEntry[] = [];
  for (const raw of h.files as unknown[]) {
    if (typeof raw !== 'object' || raw === null) throw new SitePackError('bad file entry');
    const { p, t, s } = raw as { p?: unknown; t?: unknown; s?: unknown };
    if (typeof p !== 'string' || !isValidSitePath(p)) throw new SitePackError('bad file path');
    if (typeof t !== 'string' || !isValidContentType(t)) {
      throw new SitePackError('bad content type');
    }
    if (typeof s !== 'number' || !Number.isSafeInteger(s) || s < 0) {
      throw new SitePackError('bad file size');
    }
    if (seen.has(p)) throw new SitePackError('duplicate path');
    seen.add(p);
    out.push({ p, t, s });
  }
  if (!seen.has(SITE_ENTRY)) throw new SitePackError(`no ${SITE_ENTRY}`);
  return out;
}

/** Total bytes of the files in a site (what the player imported, without the pack header). */
export function siteBytes(files: SiteFiles): number {
  let n = 0;
  for (const f of files.values()) n += f.bytes.byteLength;
  return n;
}
