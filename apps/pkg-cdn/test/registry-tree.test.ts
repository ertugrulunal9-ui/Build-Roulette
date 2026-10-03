import { describe, expect, it, vi } from 'vitest';
import { CdnError } from '../src/errors';
import { Denylist } from '../src/policy';
import { pickVersion, RegistryClient, sanitizePackument } from '../src/registry';
import { locationOf, packageLocationOf, parseDepSpec, resolveTree } from '../src/tree';
import { createFakeRegistry, FAKE_REGISTRY, type FakePackage } from './helpers/fake-registry';

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
    await expect(registry.fetchTarball('https://evil.example/x.tgz', 1000)).rejects.toThrow(
      /not on the registry origin/,
    );
  });

  it('enforces the tarball size limit', async () => {
    const { registry } = client({
      a: { versions: { '1.0.0': { files: { 'big.txt': 'x'.repeat(50_000) } } } },
    });
    const pack = await registry.getPackument('a');
    const url = pack.versions['1.0.0']?.dist.tarball ?? '';
    await expect(registry.fetchTarball(url, 10)).rejects.toMatchObject({ status: 413 });
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
