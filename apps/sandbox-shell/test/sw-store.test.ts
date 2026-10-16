import { describe, expect, it } from 'vitest';
import { SITE_LIMITS } from '@br/site';
import {
  SITE_ID_RE,
  newSiteId,
  parseSiteUpload,
  siteUrl,
  type SiteUploadFile,
} from '../src/site-protocol';
import { SiteStore, type CacheLike, type CacheStorageLike } from '../src/sw-store';

/** Cache Storage in memory (what a restarted worker finds again). */
class FakeCaches implements CacheStorageLike {
  readonly caches = new Map<string, Map<string, Response>>();
  open(name: string): Promise<CacheLike> {
    let entries = this.caches.get(name);
    if (!entries) {
      entries = new Map();
      this.caches.set(name, entries);
    }
    const map = entries;
    return Promise.resolve({
      match: (key: string) => Promise.resolve(map.get(key)?.clone()),
      put: async (key: string, res: Response) => {
        map.set(key, new Response(await res.arrayBuffer(), { headers: res.headers }));
      },
      delete: (key: string) => Promise.resolve(map.delete(key)),
      keys: () => Promise.resolve([...map.keys()].map((url) => ({ url }))),
    });
  }
}

const ORIGIN = 'https://sandbox.example';
const id = (c: string) => c.repeat(32);
const file = (path: string, text: string, type = 'text/plain; charset=utf-8') => ({
  path,
  type,
  bytes: new TextEncoder().encode(text),
});
const text = async (s: SiteStore, site: string, path: string) => {
  const f = await s.file(site, path);
  return f ? new TextDecoder().decode(f.bytes) : null;
};
const store = (caches: CacheStorageLike, maxSites = 3) =>
  new SiteStore(caches, { origin: ORIGIN, cacheName: 'sites', maxSites, maxClients: 4 });

describe('SiteStore', () => {
  it('keeps sites and the client map in memory and in Cache Storage across a restart', async () => {
    const caches = new FakeCaches();
    const first = store(caches);
    await first.load();
    await first.put(id('a'), 'preview', [
      file('index.html', '<h1>A</h1>', 'text/html; charset=utf-8'),
    ]);
    await first.mapClient('client-1', id('a'));
    expect(first.latest).toBe(id('a'));
    expect(await text(first, id('a'), 'index.html')).toBe('<h1>A</h1>');

    // The browser stops the worker: a new instance starts with empty memory.
    const second = store(caches);
    expect(second.isLoaded()).toBe(false);
    expect(second.siteOfClient('client-1')).toBeUndefined();
    await second.load();
    expect(second.isLoaded()).toBe(true);
    expect(second.siteOfClient('client-1')).toBe(id('a'));
    expect(second.hasSite(id('a'))).toBe(true);
    expect(second.latest).toBe(id('a'));
    expect(await second.site(id('a'))).toEqual({
      profile: 'preview',
      types: new Map([['index.html', 'text/html; charset=utf-8']]),
    });
    expect(await text(second, id('a'), 'index.html')).toBe('<h1>A</h1>');
    expect(await second.file(id('a'), 'missing.js')).toBeNull();
  });

  it('keeps only the most recent sites, and drops the clients of an evicted one', async () => {
    const caches = new FakeCaches();
    const s = store(caches, 2);
    await s.put(id('a'), 'preview', [file('index.html', 'A')]);
    await s.mapClient('ca', id('a'));
    await s.put(id('b'), 'capture', [file('index.html', 'B')]);
    await s.put(id('c'), 'preview', [file('index.html', 'C')]);
    expect(s.hasSite(id('a'))).toBe(false);
    expect(s.siteOfClient('ca')).toBeUndefined();
    expect(await s.file(id('a'), 'index.html')).toBeNull();
    expect(s.latest).toBe(id('c'));
    const keys = [...(caches.caches.get('sites')?.keys() ?? [])];
    expect(keys.some((k) => k.includes(id('a')))).toBe(false);
    expect(keys.filter((k) => k.includes(id('b')))).toHaveLength(2); // manifest + one file

    const restarted = store(caches, 2);
    await restarted.load();
    expect([id('a'), id('b'), id('c')].map((x) => restarted.hasSite(x))).toEqual([
      false,
      true,
      true,
    ]);
    expect((await restarted.site(id('b')))?.profile).toBe('capture');
  });

  it('caps the client map, oldest first', async () => {
    const s = store(new FakeCaches());
    await s.put(id('a'), 'preview', [file('index.html', 'A')]);
    for (const c of ['c1', 'c2', 'c3', 'c4', 'c5']) await s.mapClient(c, id('a'));
    expect(s.siteOfClient('c1')).toBeUndefined();
    expect(s.siteOfClient('c5')).toBe(id('a'));
  });

  it('picks up a site another instance stored meanwhile (refresh)', async () => {
    const caches = new FakeCaches();
    const old = store(caches);
    await old.load();
    const fresh = store(caches);
    await fresh.put(id('d'), 'preview', [file('index.html', 'D')]);
    expect(old.hasSite(id('d'))).toBe(false);
    await old.refresh();
    expect(old.hasSite(id('d'))).toBe(true);
    expect(old.latest).toBe(id('d'));
    expect(await text(old, id('d'), 'index.html')).toBe('D');
  });

  it('an unreadable or deleted state is an empty one (build code can write the cache)', async () => {
    const caches = new FakeCaches();
    const cache = await caches.open('sites');
    await cache.put(`${ORIGIN}/__br_sw/state`, new Response('{not json'));
    const s = store(caches);
    await s.load();
    expect(s.latest).toBeNull();
    // A site whose manifest is gone is not served.
    await s.put(id('e'), 'preview', [file('index.html', 'E')]);
    const fresh = store(caches);
    await fresh.load();
    await cache.delete(`${ORIGIN}/__br_sw/sites/${id('e')}/manifest`);
    expect(await fresh.site(id('e'))).toBeNull();
  });
});

describe('site uploads', () => {
  const html = (): SiteUploadFile => ({
    path: 'index.html',
    type: 'text/html; charset=utf-8',
    bytes: new ArrayBuffer(4),
  });
  const upload = (over: Record<string, unknown> = {}) => ({
    type: 'br-site',
    id: newSiteId(),
    files: [html()],
    ...over,
  });

  it('site ids are 128 random bits, fresh every time', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newSiteId()));
    expect(ids.size).toBe(50);
    for (const x of ids) expect(x).toMatch(SITE_ID_RE);
    expect(siteUrl(ORIGIN, id('a'))).toBe(`${ORIGIN}/?__br_site=${id('a')}`);
  });

  it('accepts a well-formed upload', () => {
    const u = upload();
    expect(parseSiteUpload(u)).toEqual(u);
  });

  it('refuses anything else, without throwing', () => {
    const bad: unknown[] = [
      null,
      'x',
      upload({ type: 'load' }),
      upload({ id: 'short' }),
      upload({ id: 'A'.repeat(32) }),
      upload({ files: 'x' }),
      upload({ files: [] }), // no index.html
      upload({ files: [{ ...html(), path: '../index.html' }] }),
      upload({ files: [{ ...html(), path: '/index.html' }] }),
      upload({ files: [html(), html()] }),
      upload({ files: [{ ...html(), type: 'text/html; charset=latin1' }] }),
      upload({ files: [{ ...html(), bytes: new Uint8Array(4) }] }),
      upload({
        files: [
          html(),
          {
            path: 'big.bin',
            type: 'application/octet-stream',
            bytes: new ArrayBuffer(SITE_LIMITS.maxPackBytes),
          },
        ],
      }),
      upload({
        files: Array.from({ length: SITE_LIMITS.maxFiles + 1 }, (_, i) => ({
          ...html(),
          path: i === 0 ? 'index.html' : `f${String(i)}.txt`,
        })),
      }),
      new Proxy(
        {},
        {
          get: () => {
            throw new Error('trap');
          },
        },
      ),
    ];
    for (const b of bad) expect(parseSiteUpload(b), String(bad.indexOf(b))).toBeNull();
  });
});
