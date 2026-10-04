import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CdnError } from '../src/errors';
import { Limiter } from '../src/limiter';
import { Denylist } from '../src/policy';
import { pickVersion, RegistryClient, sanitizePackument } from '../src/registry';
import { locationOf, packageLocationOf, parseDepSpec, resolveTree } from '../src/tree';
import { createFakeRegistry, FAKE_REGISTRY, type FakePackage } from './helpers/fake-registry';

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'pkg-cdn-reg-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function client(packages: Record<string, FakePackage>, ttl = 60_000) {
  const reg = createFakeRegistry(packages);
  const registry = new RegistryClient({
    registryUrl: FAKE_REGISTRY,
    packumentTtlMs: ttl,
    fetchTimeoutMs: 5000,
    maxPackumentBytes: 1024 * 1024,
    fetch: reg.fetch,
  });
  return { reg, registry };
}

const versions = (...vs: string[]): FakePackage => ({
  versions: Object.fromEntries(vs.map((v) => [v, {}])),
});

describe('pickVersion', () => {
  const pack = sanitizePackument('x', {
    'dist-tags': { latest: '1.5.0', next: '2.0.0-beta.1' },
    versions: Object.fromEntries(
      ['1.0.0', '1.5.0', '1.6.0', '2.0.0-beta.1', '0.9.0'].map((v) => [
        v,
        { dist: { tarball: 'https://r/x.tgz' } },
      ]),
    ),
  });

  it('prefers latest when it satisfies the range (npm behavior)', () => {
    expect(pickVersion(pack, '^1.0.0')).toBe('1.5.0');
    expect(pickVersion(pack, '*')).toBe('1.5.0');
  });

  it('otherwise takes the highest satisfying version', () => {
    expect(pickVersion(pack, '>=1.6.0 <2')).toBe('1.6.0');
    expect(pickVersion(pack, '~0.9.0')).toBe('0.9.0');
    expect(pickVersion(pack, '^3.0.0')).toBeNull();
  });

  it('resolves dist-tags and skips prereleases unless asked', () => {
    expect(pickVersion(pack, 'next')).toBe('2.0.0-beta.1');
    expect(pickVersion(pack, 'latest')).toBe('1.5.0');
    expect(pickVersion(pack, '^2.0.0-beta.0')).toBe('2.0.0-beta.1');
    expect(pickVersion(pack, 'nonexistent-tag')).toBeNull();
  });

  it('drops malformed versions from the packument', () => {
    const p = sanitizePackument('x', {
      versions: { 'not-semver': { dist: { tarball: 't' } }, '1.0.0': { dist: {} } },
    });
    expect(Object.keys(p.versions)).toEqual([]);
  });
});

describe('RegistryClient', () => {
  it('caches packuments for the TTL and maps 404 to unknown-package', async () => {
    const { reg, registry } = client({ a: versions('1.0.0') });
    await registry.getPackument('a');
    await registry.getPackument('a');
    expect(reg.requests.filter((r) => r === 'packument a')).toHaveLength(1);
    await expect(registry.getPackument('missing')).rejects.toMatchObject({
      status: 404,
      code: 'unknown-package',
    });
  });

  it('refetches after the TTL', async () => {
    vi.useFakeTimers();
    try {
      const { reg, registry } = client({ a: versions('1.0.0') }, 1000);
      await registry.getPackument('a');
      vi.setSystemTime(Date.now() + 1500);
      await registry.getPackument('a');
      expect(reg.requests.filter((r) => r === 'packument a')).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('validates names before any request', async () => {
    const { reg, registry } = client({});
    await expect(registry.getPackument('../../etc')).rejects.toMatchObject({ status: 400 });
    expect(reg.requests).toEqual([]);
  });

  it('only downloads tarballs from the registry origin', async () => {
    const { registry } = client({});
    await expect(
      registry.downloadTarball('https://evil.example/x.tgz', path.join(tempDir(), 'x.tgz'), {
        maxBytes: 1000,
        algorithm: 'sha512',
      }),
    ).rejects.toThrow(/not on the registry origin/);
  });

  it('streams tarballs to disk while hashing, and enforces the size limit', async () => {
    const { registry } = client({
      a: { versions: { '1.0.0': { files: { 'big.txt': 'x'.repeat(50_000) } } } },
    });
    const pack = await registry.getPackument('a');
    const dist = pack.versions['1.0.0']?.dist;
    const url = dist?.tarball ?? '';
    const file = path.join(tempDir(), 'a.tgz');
    const ok = await registry.downloadTarball(url, file, { maxBytes: 1e6, algorithm: 'sha512' });
    expect(`sha512-${ok.digest.toString('base64')}`).toBe(dist?.integrity);
    expect(statSync(file).size).toBe(ok.bytes);
    const small = path.join(tempDir(), 'small.tgz');
    await expect(
      registry.downloadTarball(url, small, { maxBytes: 10, algorithm: 'sha512' }),
    ).rejects.toMatchObject({ status: 413 });
    expect(existsSync(small)).toBe(false); // partial download removed
  });

  it('asks for the abbreviated packument', async () => {
    const accepts: string[] = [];
    const reg = createFakeRegistry({ a: versions('1.0.0') });
    const registry = new RegistryClient({
      registryUrl: FAKE_REGISTRY,
      packumentTtlMs: 60_000,
      fetchTimeoutMs: 5000,
      maxPackumentBytes: 1024 * 1024,
      fetch: (url, init) => {
        accepts.push(new Headers(init?.headers).get('accept') ?? '');
        return reg.fetch(url, init);
      },
    });
    await registry.getPackument('a');
    expect(accepts[0]).toMatch(/^application\/vnd\.npm\.install-v1\+json/);
  });

  it('enforces the packument size limit while reading, without a Content-Length', async () => {
    let pulled = 0;
    const endless = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulled++;
            controller.enqueue(new Uint8Array(64 * 1024).fill(0x20));
          },
        }),
      );
    const registry = new RegistryClient({
      registryUrl: FAKE_REGISTRY,
      packumentTtlMs: 60_000,
      fetchTimeoutMs: 5000,
      maxPackumentBytes: 256 * 1024,
      fetch: () => Promise.resolve(endless()),
    });
    await expect(registry.getPackument('a')).rejects.toMatchObject({
      status: 413,
      message: /packument of a is larger than/,
    });
    // Cut off right after the limit (plus the stream's read-ahead), not after buffering it all.
    expect(pulled).toBeLessThan(10);
    // A lying or present Content-Length is refused before reading.
    const declared = new RegistryClient({
      registryUrl: FAKE_REGISTRY,
      packumentTtlMs: 60_000,
      fetchTimeoutMs: 5000,
      maxPackumentBytes: 10,
      fetch: () =>
        Promise.resolve(new Response('{}'.padEnd(100), { headers: { 'content-length': '100' } })),
    });
    await expect(declared.getPackument('a')).rejects.toMatchObject({ status: 413 });
  });

  it('coalesces concurrent packument requests and never caches a failure', async () => {
    const reg = createFakeRegistry({ a: versions('1.0.0') });
    let calls = 0;
    let fail = true;
    const registry = new RegistryClient({
      registryUrl: FAKE_REGISTRY,
      packumentTtlMs: 60_000,
      fetchTimeoutMs: 5000,
      maxPackumentBytes: 1024 * 1024,
      fetch: async (url, init) => {
        calls++;
        await new Promise((r) => setTimeout(r, 20));
        if (fail) return new Response('boom', { status: 500 });
        return reg.fetch(url, init);
      },
    });
    const first = await Promise.allSettled([
      registry.getPackument('a'),
      registry.getPackument('a'),
      registry.getPackument('a'),
    ]);
    expect(calls).toBe(1);
    expect(first.every((r) => r.status === 'rejected')).toBe(true);
    fail = false;
    const [x, y] = await Promise.all([registry.getPackument('a'), registry.getPackument('a')]);
    expect(calls).toBe(2);
    expect(x).toBe(y);
    await registry.getPackument('a'); // cached now
    expect(calls).toBe(2);
  });

  it('cancels a shared packument request only when every waiter is gone', async () => {
    const signals: AbortSignal[] = [];
    const registry = new RegistryClient({
      registryUrl: FAKE_REGISTRY,
      packumentTtlMs: 60_000,
      fetchTimeoutMs: 60_000,
      maxPackumentBytes: 1024 * 1024,
      fetch: (_url, init) => {
        const signal = init?.signal ?? new AbortController().signal;
        signals.push(signal);
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(signal.reason as Error);
          });
        });
      },
    });
    const c1 = new AbortController();
    const c2 = new AbortController();
    const p1 = registry.getPackument('a', c1.signal);
    const p2 = registry.getPackument('a', c2.signal);
    await new Promise((r) => setTimeout(r, 5));
    expect(signals).toHaveLength(1);
    c1.abort(new Error('client 1 left'));
    await expect(p1).rejects.toThrow('client 1 left');
    expect(signals[0]?.aborted).toBe(false); // client 2 still wants it
    c2.abort(new Error('client 2 left'));
    await expect(p2).rejects.toThrow('client 2 left');
    expect(signals[0]?.aborted).toBe(true);
    expect(registry.limiter.stats()).toMatchObject({ active: 0, queued: 0 });
  });

  it('applies one global limit to all registry requests and sheds load past the queue', async () => {
    let active = 0;
    let peak = 0;
    const reg = createFakeRegistry(
      Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`p${String(i)}`, versions('1.0.0')])),
    );
    const registry = new RegistryClient({
      registryUrl: FAKE_REGISTRY,
      packumentTtlMs: 60_000,
      fetchTimeoutMs: 5000,
      maxPackumentBytes: 1024 * 1024,
      limiter: new Limiter('registry', 2, 3, 7),
      fetch: async (url, init) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
        return reg.fetch(url, init);
      },
    });
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => registry.getPackument(`p${String(i)}`)),
    );
    expect(peak).toBe(2);
    // 2 running + 3 queued; the 6th is refused at once with a Retry-After hint.
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({
      status: 503,
      code: 'overloaded',
      retryAfterSeconds: 7,
    });
    expect(registry.limiter.stats()).toMatchObject({ shed: 1, completed: 5, active: 0 });
  });

  it('keeps the packument cache within its byte budget (LRU)', async () => {
    const reg = createFakeRegistry({
      a: versions('1.0.0'),
      b: versions('1.0.0'),
      c: versions('1.0.0'),
    });
    const probe = new RegistryClient({
      registryUrl: FAKE_REGISTRY,
      packumentTtlMs: 60_000,
      fetchTimeoutMs: 5000,
      maxPackumentBytes: 1024 * 1024,
      fetch: reg.fetch,
    });
    await probe.getPackument('a');
    const one = probe.cacheStats().bytes; // all three have the same size
    const budget = Math.floor(one * 2.5);
    const registry = new RegistryClient({
      registryUrl: FAKE_REGISTRY,
      packumentTtlMs: 60_000,
      fetchTimeoutMs: 5000,
      maxPackumentBytes: 1024 * 1024,
      maxCachedPackumentBytes: budget,
      fetch: reg.fetch,
    });
    await registry.getPackument('a');
    await registry.getPackument('b');
    await registry.getPackument('a'); // a is now the most recently used
    await registry.getPackument('c');
    expect(registry.cacheStats()).toMatchObject({ entries: 2, bytes: one * 2 });
    reg.requests.length = 0;
    await registry.getPackument('a');
    expect(reg.requests).toEqual([]); // still cached
    await registry.getPackument('b');
    expect(reg.requests).toEqual(['packument b']); // evicted
  });
});

describe('parseDepSpec', () => {
  it('handles ranges, tags, aliases and unsupported specs', () => {
    expect(parseDepSpec('a', '^1.0.0')).toEqual({ ok: true, realName: 'a', range: '^1.0.0' });
    expect(parseDepSpec('a', '')).toEqual({ ok: true, realName: 'a', range: '*' });
    expect(parseDepSpec('a', 'next')).toEqual({ ok: true, realName: 'a', range: 'next' });
    expect(parseDepSpec('a', 'npm:@s/b@^2')).toEqual({ ok: true, realName: '@s/b', range: '^2' });
    expect(parseDepSpec('a', 'github:u/r').ok).toBe(false);
    expect(parseDepSpec('a', 'file:../x').ok).toBe(false);
    expect(parseDepSpec('a', 'https://x/y.tgz').ok).toBe(false);
    // Install names become directories: an alias key must not escape node_modules.
    expect(parseDepSpec('../../x', 'npm:react@1').ok).toBe(false);
    expect(parseDepSpec('a/b', '^1').ok).toBe(false);
  });
});

describe('resolveTree', () => {
  async function resolve(
    packages: Record<string, FakePackage>,
    root: string,
    version: string,
    opts = {},
  ) {
    const { registry } = client(packages);
    const pack = await registry.getPackument(root);
    const meta = pack.versions[version];
    if (!meta) throw new Error('bad test');
    const { tree } = await resolveTree(meta, (n) => registry.getPackument(n), {
      maxDependencies: 50,
      denylist: new Denylist(),
      ...opts,
    });
    return Object.fromEntries(
      tree.nodes.map((n) => [locationOf(n.path), `${n.realName}@${n.version}`]),
    );
  }

  it('hoists, reuses satisfying copies and nests conflicts', async () => {
    const layout = await resolve(
      {
        root: { versions: { '1.0.0': { dependencies: { a: '^1.0.0', b: '^1.0.0' } } } },
        a: { versions: { '1.0.0': { dependencies: { c: '^1.0.0' } } } },
        b: { versions: { '1.0.0': { dependencies: { c: '^2.0.0', a: '^1.0.0' } } } },
        c: versions('1.0.0', '1.2.0', '2.0.0'),
      },
      'root',
      '1.0.0',
    );
    expect(layout).toEqual({
      'node_modules/root': 'root@1.0.0',
      'node_modules/a': 'a@1.0.0',
      'node_modules/b': 'b@1.0.0',
      // latest is 2.0.0, so ^1.0.0 takes the highest 1.x
      'node_modules/c': 'c@1.2.0',
      'node_modules/b/node_modules/c': 'c@2.0.0',
    });
  });

  it('refuses dependency names that would escape node_modules', async () => {
    await expect(
      resolve(
        {
          root: { versions: { '1.0.0': { dependencies: { '../../escape': 'npm:real@^1.0.0' } } } },
          real: versions('1.0.0'),
        },
        'root',
        '1.0.0',
      ),
    ).rejects.toMatchObject({ status: 422, code: 'unsupported' });
  });

  it('does not install peers, skips platform-specific optional deps, supports aliases', async () => {
    const layout = await resolve(
      {
        root: {
          versions: {
            '1.0.0': {
              dependencies: { 'my-alias': 'npm:real@^1.0.0' },
              peerDependencies: { react: '^19.0.0' },
              optionalDependencies: { fsevents: '^2.0.0', missing: '^1.0.0' },
            },
          },
        },
        real: versions('1.0.0'),
        fsevents: { versions: { '2.0.0': { os: ['darwin'] } } },
        react: versions('19.0.0'),
      },
      'root',
      '1.0.0',
    );
    expect(layout).toEqual({
      'node_modules/root': 'root@1.0.0',
      'node_modules/my-alias': 'real@1.0.0',
    });
  });

  it('does not skip an optional dependency because of a transient failure', async () => {
    const { registry } = client({
      root: { versions: { '1.0.0': { optionalDependencies: { opt: '^1.0.0' } } } },
      opt: versions('1.0.0'),
    });
    const meta = (await registry.getPackument('root')).versions['1.0.0'];
    if (!meta) throw new Error('bad test');
    const busy = (name: string) =>
      name === 'opt'
        ? Promise.reject(new CdnError(503, 'overloaded', 'busy'))
        : registry.getPackument(name);
    // Skipping it would bake an incomplete tree into the disk cache for good.
    await expect(
      resolveTree(meta, busy, { maxDependencies: 50, denylist: new Denylist() }),
    ).rejects.toMatchObject({ status: 503 });
    const aborted = new AbortController();
    aborted.abort(new CdnError(499, 'cancelled', 'gone'));
    await expect(
      resolveTree(meta, (n) => registry.getPackument(n), {
        maxDependencies: 50,
        denylist: new Denylist(),
        signal: aborted.signal,
      }),
    ).rejects.toMatchObject({ status: 499 });
  });

  it('handles cycles', async () => {
    const layout = await resolve(
      {
        a: { versions: { '1.0.0': { dependencies: { b: '1' } } } },
        b: { versions: { '1.0.0': { dependencies: { a: '1' } } } },
      },
      'a',
      '1.0.0',
    );
    expect(Object.keys(layout)).toEqual(['node_modules/a', 'node_modules/b']);
  });

  it('fails clearly on unknown deps, too many deps and denied deps', async () => {
    await expect(
      resolve(
        { root: { versions: { '1.0.0': { dependencies: { ghost: '^1' } } } } },
        'root',
        '1.0.0',
      ),
    ).rejects.toThrow(/does not exist.*dependency of root@1.0.0/);
    await expect(
      resolve(
        { root: { versions: { '1.0.0': { dependencies: { a: '^9' } } } }, a: versions('1.0.0') },
        'root',
        '1.0.0',
      ),
    ).rejects.toMatchObject({ status: 404, code: 'unknown-version' });
    const many: Record<string, FakePackage> = {
      root: {
        versions: {
          '1.0.0': {
            dependencies: Object.fromEntries(
              Array.from({ length: 10 }, (_, i) => [`d${String(i)}`, '1']),
            ),
          },
        },
      },
    };
    for (let i = 0; i < 10; i++) many[`d${String(i)}`] = versions('1.0.0');
    await expect(resolve(many, 'root', '1.0.0', { maxDependencies: 5 })).rejects.toMatchObject({
      status: 413,
      code: 'too-many-dependencies',
    });
    await expect(
      resolve(
        { root: { versions: { '1.0.0': { dependencies: { bad: '1' } } } }, bad: versions('1.0.0') },
        'root',
        '1.0.0',
        { denylist: new Denylist([{ name: 'bad', reason: 'nope' }]) },
      ),
    ).rejects.toThrow(CdnError);
  });
});

describe('packageLocationOf', () => {
  it('finds the innermost package of a file', () => {
    expect(packageLocationOf('node_modules/a/index.js')).toBe('node_modules/a');
    expect(packageLocationOf('node_modules/@s/b/lib/x.js')).toBe('node_modules/@s/b');
    expect(packageLocationOf('node_modules/a/node_modules/@s/b/x.js')).toBe(
      'node_modules/a/node_modules/@s/b',
    );
    expect(packageLocationOf('tree.json')).toBeNull();
  });
});
