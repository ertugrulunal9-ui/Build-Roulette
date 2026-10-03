import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { CdnError } from '../src/errors';
import { extractTarball, parsePax, parseTar, sanitizeEntryPath } from '../src/tar';
import { tar, tgz } from './helpers/tar-writer';

const LIMITS = { maxUnpackedBytes: 1024 * 1024, maxFiles: 100 };
const dirs: string[] = [];

function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'pkg-cdn-tar-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function rejection(p: Promise<unknown>): Promise<CdnError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(CdnError);
    return e as CdnError;
  }
  throw new Error('expected a rejection');
}

describe('sanitizeEntryPath', () => {
  it('strips the package directory and normalizes', () => {
    expect(sanitizeEntryPath('package/index.js')).toBe('index.js');
    expect(sanitizeEntryPath('package/./lib//a.js')).toBe('lib/a.js');
    expect(sanitizeEntryPath('some-other-root/x.js')).toBe('x.js');
    expect(sanitizeEntryPath('package/')).toBeNull();
  });

  it('rejects traversal, absolute paths and control characters', () => {
    expect(() => sanitizeEntryPath('package/../../etc/passwd')).toThrow(/path traversal/);
    expect(() => sanitizeEntryPath('package/a/../../x')).toThrow(/path traversal/);
    expect(() => sanitizeEntryPath('/etc/passwd')).toThrow(/absolute/);
    expect(() => sanitizeEntryPath('C:/x')).toThrow(/absolute/);
    expect(() => sanitizeEntryPath('package\\..\\x')).toThrow(/forbidden character/);
    expect(() => sanitizeEntryPath('package/a\nb')).toThrow(/forbidden character/);
  });
});

describe('parseTar', () => {
  it('reads files, directories, links and long pax paths', () => {
    const longName = `package/${'d/'.repeat(60)}file.js`;
    const entries = [
      ...parseTar(
        tar([
          { path: 'package/', type: 'directory' },
          { path: 'package/a.js', data: 'A' },
          { path: longName, data: 'LONG' },
          { path: 'package/link', type: 'symlink', linkTarget: '/etc/passwd' },
        ]),
      ),
    ];
    expect(entries.map((e) => [e.path, e.type])).toEqual([
      ['package/', 'directory'],
      ['package/a.js', 'file'],
      [longName, 'file'],
      ['package/link', 'symlink'],
    ]);
    expect(entries[2]?.data.toString()).toBe('LONG');
  });

  it('detects corrupt headers', () => {
    const t = tar([{ path: 'package/a.js', data: 'A' }]);
    t[0] = 0x41; // change the name without fixing the checksum
    expect(() => [...parseTar(t)]).toThrow(/checksum/);
  });

  it('parses pax records', () => {
    expect(parsePax(Buffer.from('18 path=some/path\n11 size=42\n'))).toEqual({
      path: 'some/path',
      size: '42',
    });
  });
});

describe('extractTarball', () => {
  it('extracts regular files without the package/ prefix, mode 0644, atomically', async () => {
    const root = tempDir();
    const dest = path.join(root, 'pkg');
    const res = await extractTarball(
      tgz([
        { path: 'package/package.json', data: '{"name":"x"}' },
        { path: 'package/lib/index.js', data: 'export default 1' },
      ]),
      dest,
      LIMITS,
    );
    expect(res).toEqual({ files: 2, bytes: 28, skipped: 0 });
    expect(readFileSync(path.join(dest, 'lib/index.js'), 'utf8')).toBe('export default 1');
    expect(statSync(path.join(dest, 'lib/index.js')).mode & 0o777).toBe(0o644);
    expect(readdirSync(root)).toEqual(['pkg']); // no temp dir left behind
  });

  it('never creates symlinks or hardlinks', async () => {
    const dest = path.join(tempDir(), 'pkg');
    const res = await extractTarball(
      tgz([
        { path: 'package/index.js', data: 'x' },
        { path: 'package/evil', type: 'symlink', linkTarget: '/etc/passwd' },
        { path: 'package/evil2', type: 'hardlink', linkTarget: '/etc/passwd' },
      ]),
      dest,
      LIMITS,
    );
    expect(res.skipped).toBe(2);
    expect(existsSync(path.join(dest, 'evil'))).toBe(false);
    expect(existsSync(path.join(dest, 'evil2'))).toBe(false);
    for (const f of readdirSync(dest))
      expect(lstatSync(path.join(dest, f)).isSymbolicLink()).toBe(false);
  });

  it('rejects path traversal and leaves nothing behind', async () => {
    const root = tempDir();
    const dest = path.join(root, 'nested', 'pkg');
    const err = await rejection(
      extractTarball(
        tgz([
          { path: 'package/ok.js', data: 'x' },
          { path: 'package/../../../escaped.js', data: 'pwned' },
        ]),
        dest,
        LIMITS,
      ),
    );
    expect(err.status).toBe(422);
    expect(err.message).toMatch(/path traversal/);
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(path.join(root, 'escaped.js'))).toBe(false);
  });

  it('enforces the unpacked size limit while inflating', async () => {
    const big = Buffer.alloc(200 * 1024, 0x61);
    const err = await rejection(
      extractTarball(tgz([{ path: 'package/big.txt', data: big }]), path.join(tempDir(), 'p'), {
        maxUnpackedBytes: 64 * 1024,
        maxFiles: 10,
      }),
    );
    expect(err.status).toBe(413);
  });

  it('enforces the file count limit', async () => {
    const files = Array.from({ length: 5 }, (_, i) => ({
      path: `package/f${String(i)}.js`,
      data: 'x',
    }));
    const err = await rejection(
      extractTarball(tgz(files), path.join(tempDir(), 'p'), { ...LIMITS, maxFiles: 3 }),
    );
    expect(err.status).toBe(413);
    expect(err.message).toMatch(/more than 3 files/);
  });

  it('rejects data that is not gzip', async () => {
    const err = await rejection(
      extractTarball(Buffer.from('nope'), path.join(tempDir(), 'p'), LIMITS),
    );
    expect(err.status).toBe(422);
  });

  it('rejects a truncated archive', async () => {
    const t = tar([{ path: 'package/a.js', data: 'x'.repeat(2000) }]);
    const err = await rejection(
      extractTarball(gzipSync(t.subarray(0, 1024)), path.join(tempDir(), 'p'), LIMITS),
    );
    expect(err.message).toMatch(/truncated/);
  });

  it('lets a later duplicate entry win', async () => {
    const dest = path.join(tempDir(), 'p');
    await extractTarball(
      tgz([
        { path: 'package/a.js', data: 'first' },
        { path: 'package/a.js', data: 'second' },
      ]),
      dest,
      LIMITS,
    );
    expect(readFileSync(path.join(dest, 'a.js'), 'utf8')).toBe('second');
  });
});
