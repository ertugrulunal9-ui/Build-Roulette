/** Minimal tar (ustar + pax) writer for building test tarballs, including hostile ones. */
import { gzipSync } from 'node:zlib';

export interface TarFile {
  path: string;
  /** File contents (ignored for directories and links). */
  data?: string | Buffer;
  type?: 'file' | 'directory' | 'symlink' | 'hardlink';
  linkTarget?: string;
}

function octal(n: number, width: number): string {
  return `${n.toString(8).padStart(width - 1, '0')}\0`;
}

function header(name: string, size: number, typeflag: string, linkname = ''): Buffer {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0, 'utf8');
  h.write(octal(0o644, 8), 100, 'ascii');
  h.write(octal(0, 8), 108, 'ascii');
  h.write(octal(0, 8), 116, 'ascii');
  h.write(octal(size, 12), 124, 'ascii');
  h.write(octal(0, 12), 136, 'ascii');
  h.write('        ', 148, 'ascii');
  h.write(typeflag, 156, 'ascii');
  h.write(linkname.slice(0, 100), 157, 'utf8');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return h;
}

function pad(data: Buffer): Buffer {
  const rem = data.length % 512;
  return rem === 0 ? data : Buffer.concat([data, Buffer.alloc(512 - rem)]);
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let len = body.length + 1;
  while (`${len.toString()}${body}`.length !== len) len = `${len.toString()}${body}`.length;
  return `${len.toString()}${body}`;
}

export function tar(files: readonly TarFile[]): Buffer {
  const parts: Buffer[] = [];
  for (const f of files) {
    const type = f.type ?? 'file';
    const data =
      type === 'file'
        ? Buffer.isBuffer(f.data)
          ? f.data
          : Buffer.from(f.data ?? '')
        : Buffer.alloc(0);
    if (Buffer.byteLength(f.path) > 100) {
      const pax = Buffer.from(paxRecord('path', f.path));
      parts.push(header('PaxHeader', pax.length, 'x'), pad(pax));
    }
    const flag = { file: '0', directory: '5', symlink: '2', hardlink: '1' }[type];
    parts.push(header(f.path, data.length, flag, f.linkTarget ?? ''), pad(data));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

export function tgz(files: readonly TarFile[]): Buffer {
  return gzipSync(tar(files));
}

/** An npm-style tarball: every path under `package/`. */
export function npmTgz(files: Record<string, string>): Buffer {
  return tgz(Object.entries(files).map(([p, data]) => ({ path: `package/${p}`, data })));
}
