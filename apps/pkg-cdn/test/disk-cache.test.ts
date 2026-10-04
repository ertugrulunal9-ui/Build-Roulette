import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bundleKey,
  CacheIndex,
  INDEX_FILE,
  storeKey,
  treeKey,
  type CacheIndexOptions,
} from '../src/disk-cache';

const KB = 1024;
const dirs: string[] = [];

function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'pkg-cdn-disk-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fake clock: every call is one second later. */
function clock(start = Date.now()) {
  let t = start;
  return () => (t += 1000);
}

function index(root: string, quotaBytes: number, extra: Partial<CacheIndexOptions> = {}) {
  return new CacheIndex({ root, quotaBytes, touchResolutionMs: 0, now: clock(), ...extra });
}

function writeStore(root: string, name: string, version: string, kb: number): string {
  const dir = path.join(root, 'store', name.replace('/', '+'), version);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'index.js'), Buffer.alloc(kb * KB));
  return storeKey(name, version);
}

function writeTree(root: string, name: string, version: string, deps: [string, string][]) {
  const dir = path.join(root, 'trees', 'v1', `${name}@${version}`);
  for (const [n, v] of deps) {
    const target = path.join(dir, 'node_modules', n);
    mkdirSync(target, { recursive: true });
    linkSync(path.join(root, 'store', n, v, 'index.js'), path.join(target, 'index.js'));
  }
  writeFileSync(
    path.join(dir, 'tree.json'),
    JSON.stringify({ nodes: deps.map(([n, v]) => ({ realName: n, version: v })) }),
  );
  return { key: treeKey('v1', name, version), deps: deps.map(([n, v]) => storeKey(n, v)) };
}

function writeBundle(root: string, hash: string, kb: number): string {
  const dir = path.join(root, 'bundles', hash.slice(0, 2));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${hash}.js`), Buffer.alloc(kb * KB));
  writeFileSync(path.join(dir, `${hash}.json`), '{}');
  return bundleKey(hash);
}

function onDisk(idx: CacheIndex, key: string): boolean {
  return key.startsWith('bundles/')
    ? existsSync(`${idx.pathOf(key)}.json`)
    : existsSync(idx.pathOf(key));
}

describe('CacheIndex eviction', () => {
  it('evicts the least recently used entries down to the low-water mark', async () => {
    const root = tempDir();
    const idx = index(root, 100 * KB, { lowWaterRatio: 0.9 });
    const a = writeStore(root, 'a', '1.0.0', 30);
    const b = writeBundle(root, 'bb00', 30);
    const c = writeStore(root, 'c', '1.0.0', 30);
    idx.record(a, 30 * KB);
    idx.record(b, 30 * KB);
    idx.record(c, 30 * KB);
    idx.touch(a); // a is now more recent than b and c
    await idx.evictIfNeeded(); // under quota: nothing happens
    expect(idx.stats().evictedEntries).toBe(0);

    const d = writeBundle(root, 'dd00', 30);
    idx.record(d, 30 * KB); // 120 KB > 100 KB: evict the oldest (b) -> 90 KB
    await idx.evictIfNeeded();
    expect(idx.bytes).toBe(90 * KB);
    expect([a, b, c, d].map((k) => onDisk(idx, k))).toEqual([true, false, true, true]);
    expect([a, b, c, d].map((k) => idx.has(k))).toEqual([true, false, true, true]);

    idx.touch(c);
    const e = writeBundle(root, 'ee00', 30);
    idx.record(e, 30 * KB); // evicts a (c was touched after it)
    await idx.evictIfNeeded();
    expect([a, c, d, e].map((k) => onDisk(idx, k))).toEqual([false, true, true, true]);
    expect(idx.stats()).toMatchObject({ evictedEntries: 2, evictedBytes: 60 * KB, bytes: 90 * KB });
    // Store entries go through trash/ (atomic rename) and are then deleted.
    expect(readdirSync(path.join(root, 'trash'))).toEqual([]);
  });

  it('never evicts a leased entry, or a store entry whose tree is leased', async () => {
    const root = tempDir();
    const idx = index(root, 100 * KB, { lowWaterRatio: 0.5 });
    const s1 = writeStore(root, 's1', '1.0.0', 40);
    const s2 = writeStore(root, 's2', '1.0.0', 40);
    idx.record(s1, 40 * KB);
    idx.record(s2, 40 * KB);
    const t = writeTree(root, 'app', '1.0.0', [['s1', '1.0.0']]);
    idx.record(t.key, 4 * KB, t.deps);
    const releaseTree = idx.lease(t.key); // an in-flight build uses the tree
    const releaseS2 = idx.lease(s2); // a raw file is being opened from s2
    const b = writeBundle(root, 'b000', 40);
    idx.record(b, 40 * KB);
    await idx.evictIfNeeded();
    // Only the bundle could go: s1 is pinned by its leased tree, s2 by its own lease.
    expect([s1, s2, t.key, b].map((k) => onDisk(idx, k))).toEqual([true, true, true, false]);
    expect(idx.stats().skippedLeased).toBeGreaterThanOrEqual(2);

    releaseTree();
    releaseS2();
    idx.record(writeBundle(root, 'c000', 40), 40 * KB);
    await idx.evictIfNeeded();
    // s1 (oldest) goes, and the tree linking it goes with it (it holds s1's data alive).
    expect(onDisk(idx, s1)).toBe(false);
    expect(onDisk(idx, t.key)).toBe(false);
    expect(idx.has(t.key)).toBe(false);
  });

  it('makes users of an entry being evicted wait, so they re-create it', async () => {
    const root = tempDir();
    const idx = index(root, 10 * KB, { lowWaterRatio: 0.5 });
    const s = writeStore(root, 's', '1.0.0', 20);
    idx.record(s, 20 * KB); // over quota: eviction starts in the background
    expect(idx.stats().evicting).toBe(1);
    expect(idx.has(s)).toBe(false); // out of the index before any await
    await idx.settled(s);
    expect(existsSync(idx.pathOf(s))).toBe(false); // gone once settled: callers re-create
    expect(idx.stats().evicting).toBe(0);
  });

  it('removes a bundle .json before its .js', async () => {
    const root = tempDir();
    const idx = index(root, 1, { lowWaterRatio: 0 });
    const b = writeBundle(root, 'ab12', 4);
    idx.record(b, 8 * KB);
    await idx.evictIfNeeded();
    expect(existsSync(`${idx.pathOf(b)}.json`)).toBe(false);
    expect(existsSync(`${idx.pathOf(b)}.js`)).toBe(false);
  });

  it('does nothing with a zero quota (unlimited)', async () => {
    const root = tempDir();
    const idx = index(root, 0);
    idx.record(writeBundle(root, 'ab12', 4), 1e12);
    await idx.evictIfNeeded();
    expect(idx.stats().evictionRuns).toBe(0);
  });
});

describe('CacheIndex persistence and recovery', () => {
  it('persists sizes and access times, and reconciles with the disk at startup', async () => {
    const root = tempDir();
    const first = index(root, 0);
    await first.init();
    const a = writeStore(root, 'a', '1.0.0', 8);
    const b = writeBundle(root, 'b000', 8);
    first.record(a, 12 * KB);
    first.record(b, 12 * KB);
    first.touch(a);
    await first.close();
    const saved = JSON.parse(readFileSync(path.join(root, INDEX_FILE), 'utf8')) as {
      entries: Record<string, [number, number]>;
    };
    expect(Object.keys(saved.entries).sort()).toEqual([a, b].sort());
    expect(saved.entries[a]?.[1]).toBeGreaterThan(saved.entries[b]?.[1] ?? Infinity);

    // Meanwhile: b vanished, and c appeared without being recorded (a crash before a flush).
    rmSync(`${first.pathOf(b)}.json`);
    rmSync(`${first.pathOf(b)}.js`);
    const c = writeStore(root, '@s/c', '2.0.0', 8);
    const logs: string[] = [];
    const second = index(root, 0, { log: (l) => logs.push(l) });
    await second.init();
    expect(second.has(a)).toBe(true);
    expect(second.has(b)).toBe(false);
    expect(second.has(c)).toBe(true);
    // a keeps its recorded size; c was measured (8 KiB file + its directory).
    expect(second.bytes).toBe(12 * KB + 8 * KB + 4 * KB);
    expect(logs.join('\n')).toMatch(/1 measured/);
  });

  it('cleans up crash leftovers and never serves a half-evicted entry', async () => {
    const root = tempDir();
    const old = new Date(Date.now() - 60 * 60 * 1000);
    // An eviction interrupted after the rename into trash/: the live path is already gone.
    mkdirSync(path.join(root, 'trash', 'x1', 'deep'), { recursive: true });
    // An interrupted extraction and download (stale), and one still in progress (fresh).
    const staleTmp = path.join(root, 'store', 'a', '1.0.0.tmp-1-abc');
    mkdirSync(staleTmp, { recursive: true });
    utimesSync(staleTmp, old, old);
    const freshTmp = path.join(root, 'store', 'a', '2.0.0.tmp-2-def');
    mkdirSync(freshTmp, { recursive: true });
    mkdirSync(path.join(root, 'tmp'), { recursive: true });
    writeFileSync(path.join(root, 'tmp', '1-x.tgz'), 'partial');
    utimesSync(path.join(root, 'tmp', '1-x.tgz'), old, old);
    // A bundle whose .json was evicted but whose .js was not (crash between the unlinks).
    mkdirSync(path.join(root, 'bundles', 'cd'), { recursive: true });
    writeFileSync(path.join(root, 'bundles', 'cd', 'cd34.js'), 'x');
    utimesSync(path.join(root, 'bundles', 'cd', 'cd34.js'), old, old);
    // A tree whose store entry is gone.
    writeStore(root, 'gone', '1.0.0', 1);
    writeTree(root, 'orphan', '1.0.0', [['gone', '1.0.0']]);
    rmSync(path.join(root, 'store', 'gone'), { recursive: true });
    // A corrupt index file is ignored.
    writeFileSync(path.join(root, INDEX_FILE), '{not json');

    const idx = index(root, 0);
    await idx.init();
    expect(existsSync(path.join(root, 'trash'))).toBe(false);
    expect(existsSync(staleTmp)).toBe(false);
    expect(existsSync(freshTmp)).toBe(true); // may belong to a running extraction
    expect(existsSync(path.join(root, 'tmp', '1-x.tgz'))).toBe(false);
    expect(existsSync(path.join(root, 'bundles', 'cd', 'cd34.js'))).toBe(false);
    expect(existsSync(path.join(root, 'trees', 'v1', 'orphan@1.0.0'))).toBe(false);
    expect(idx.stats().entries).toEqual({ store: 0, trees: 0, bundles: 0 });
  });

  it('counts a tree only for what it does not share with the store', async () => {
    const root = tempDir();
    writeStore(root, 'dep', '1.0.0', 64);
    const t = writeTree(root, 'app', '1.0.0', [['dep', '1.0.0']]);
    const idx = index(root, 0);
    await idx.init();
    const total = idx.bytes;
    // store: 64 KiB file + 1 dir; tree: 3 dirs (root, node_modules, dep) + tree.json.
    expect(total).toBe(64 * KB + 4 * KB + 3 * 4 * KB + 4 * KB);
    expect(idx.has(t.key)).toBe(true);
  });
});
