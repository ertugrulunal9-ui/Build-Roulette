import { describe, expect, it } from 'vitest';
import { SITE_LIMITS } from './limits';
import { SitePackError, packSite, siteBytes, unpackSite, type SiteFile } from './pack';

const enc = new TextEncoder();
const file = (path: string, text: string, type = 'text/html; charset=utf-8'): SiteFile => ({
  path,
  type,
  bytes: enc.encode(text),
});

const SITE = [
  file('index.html', '<!doctype html><script type="module" src="/assets/app.js"></script>'),
  file('assets/app.js', 'console.log(1)', 'text/javascript; charset=utf-8'),
  { path: 'logo.png', type: 'image/png', bytes: new Uint8Array([0x89, 0x50, 0, 255]) },
];

function withHeader(header: unknown, body = new Uint8Array()): Uint8Array {
  const h = enc.encode(JSON.stringify(header));
  const out = new Uint8Array(12 + h.byteLength + body.byteLength);
  out.set(enc.encode('BRSITE1\n'));
  new DataView(out.buffer).setUint32(8, h.byteLength, true);
  out.set(h, 12);
  out.set(body, 12 + h.byteLength);
  return out;
}

describe('packSite / unpackSite', () => {
  it('round-trips files, sorted by path', () => {
    const files = unpackSite(packSite(SITE));
    expect([...files.keys()]).toEqual(['assets/app.js', 'index.html', 'logo.png']);
    expect(new TextDecoder().decode(files.get('assets/app.js')?.bytes)).toBe('console.log(1)');
    expect(files.get('logo.png')?.type).toBe('image/png');
    expect([...(files.get('logo.png')?.bytes ?? [])]).toEqual([0x89, 0x50, 0, 255]);
    expect(siteBytes(files)).toBe(SITE.reduce((n, f) => n + f.bytes.byteLength, 0));
  });

  it('reads a pack from an ArrayBuffer and from a Uint8Array view with an offset', () => {
    const pack = packSite(SITE);
    expect(unpackSite(pack.slice().buffer).size).toBe(3);
    const padded = new Uint8Array(pack.byteLength + 7);
    padded.set(pack, 7);
    expect(unpackSite(padded.subarray(7)).size).toBe(3);
  });

  it('refuses a site without index.html, duplicates, bad paths and bad types', () => {
    expect(() => packSite([file('a.html', 'x')])).toThrow(SitePackError);
    expect(() => packSite([...SITE, file('index.html', 'again')])).toThrow(/duplicate/);
    expect(() => packSite([...SITE, file('../x.js', 'x')])).toThrow(/invalid path/);
    expect(() => packSite([...SITE, file('a//b.js', 'x')])).toThrow(/invalid path/);
    expect(() => packSite([...SITE, file('a\\b.js', 'x')])).toThrow(/invalid path/);
    expect(() => packSite([...SITE, file('x.js', 'x', 'text/javascript\n')])).toThrow(/type/);
  });

  it('refuses a pack over the size limit and too many files', () => {
    const big = {
      path: 'big.bin',
      type: 'application/octet-stream',
      bytes: new Uint8Array(SITE_LIMITS.maxPackBytes),
    };
    expect(() => packSite([...SITE, big])).toThrow(/too large/);
    const many = Array.from({ length: SITE_LIMITS.maxFiles }, (_, i) => file(`f${i}.js`, ''));
    expect(() => packSite([...SITE, ...many])).toThrow(/too many files/);
  });

  it('rejects anything that is not a well-formed pack', () => {
    const good = packSite(SITE);
    expect(() => unpackSite(new Uint8Array(4))).toThrow(/not a site pack/);
    expect(() => unpackSite(enc.encode('BRSITE2\n\0\0\0\0'))).toThrow(/not a site pack/);
    expect(() => unpackSite(good.subarray(0, good.byteLength - 1))).toThrow(/truncated/);
    const extra = new Uint8Array(good.byteLength + 1);
    extra.set(good);
    expect(() => unpackSite(extra)).toThrow(/trailing/);
    const badLength = good.slice();
    new DataView(badLength.buffer).setUint32(8, 0xffffffff, true);
    expect(() => unpackSite(badLength)).toThrow(/header length/);
    expect(() => unpackSite(withHeader({ v: 2, files: [] }))).toThrow(/version/);
    expect(() => unpackSite(withHeader({ v: 1, files: {} }))).toThrow(/file list/);
    expect(() =>
      unpackSite(withHeader({ v: 1, files: [{ p: '../index.html', t: 'text/html', s: 0 }] })),
    ).toThrow(/path/);
    expect(() =>
      unpackSite(withHeader({ v: 1, files: [{ p: 'index.html', t: 'text/html', s: -1 }] })),
    ).toThrow(/size/);
    expect(() =>
      unpackSite(withHeader({ v: 1, files: [{ p: 'index.html', t: 'text/html', s: 1.5 }] })),
    ).toThrow(/size/);
    expect(() =>
      unpackSite(
        withHeader({
          v: 1,
          files: [
            { p: 'index.html', t: 'text/html', s: 0 },
            { p: 'index.html', t: 'text/html', s: 0 },
          ],
        }),
      ),
    ).toThrow(/duplicate/);
    expect(() =>
      unpackSite(withHeader({ v: 1, files: [{ p: 'a.html', t: 'text/html', s: 0 }] })),
    ).toThrow(/index.html/);
    expect(() => unpackSite(withHeader('nope'))).toThrow(/bad header/);
    const notJson = withHeader({ v: 1, files: [] });
    notJson[12] = 0xff;
    expect(() => unpackSite(notJson)).toThrow(/bad header/);
  });
});
