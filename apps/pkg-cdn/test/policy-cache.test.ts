import { describe, expect, it } from 'vitest';
import type { BuildRequest } from '../src/bundler';
import { cacheKey, cacheKeyString } from '../src/cache';
import { CdnError } from '../src/errors';
import { Denylist } from '../src/policy';

describe('Denylist', () => {
  const list = Denylist.fromJson(
    JSON.stringify({
      packages: [
        { name: 'evil', reason: 'malware' },
        { name: 'ua-parser-js', versions: '0.7.29 || 1.0.0', reason: 'hijacked' },
      ],
    }),
  );

  it('denies every version or a version range', () => {
    expect(list.deniesAllVersions('evil')).toBe('malware');
    expect(list.check('evil', '9.9.9')).toBe('malware');
    expect(list.deniesAllVersions('ua-parser-js')).toBeNull();
    expect(list.check('ua-parser-js', '0.7.29')).toBe('hijacked');
    expect(list.check('ua-parser-js', '0.7.30')).toBeNull();
    expect(list.check('react', '19.3.0')).toBeNull();
  });

  it('throws a 403 with the reason and the dependent', () => {
    try {
      list.assertAllowed('evil', '1.0.0', 'nice@2.0.0');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(CdnError);
      expect((e as CdnError).status).toBe(403);
      expect((e as CdnError).message).toBe(
        'evil@1.0.0 (dependency of nice@2.0.0) is denied by policy: malware',
      );
    }
  });

  it('validates the config file', () => {
    expect(() => Denylist.fromJson('{}')).toThrow(/expected/);
    expect(() => Denylist.fromJson('{"packages":[{"name":"x"}]}')).toThrow(/reason/);
    expect(() => Denylist.fromJson('{"packages":[{"name":"../x","reason":"r"}]}')).toThrow(
      /invalid name/,
    );
    expect(() =>
      Denylist.fromJson('{"packages":[{"name":"x","versions":"nope!","reason":"r"}]}'),
    ).toThrow(/invalid range/);
  });

  it('ships a valid default denylist', async () => {
    const { fileURLToPath } = await import('node:url');
    const list = Denylist.fromFile(fileURLToPath(new URL('../denylist.json', import.meta.url)));
    expect(list.size).toBeGreaterThan(5);
    expect(list.check('event-stream', '3.3.6')).not.toBeNull();
    expect(list.check('event-stream', '3.3.4')).toBeNull();
  });
});

describe('cache keys', () => {
  const base: BuildRequest = {
    name: 'zustand',
    version: '5.0.15',
    subpath: '',
    external: ['react', 'react-dom'],
    deps: {},
    target: 'es2022',
    dev: false,
  };

  it('ignores the order of externals and deps', () => {
    expect(cacheKey({ ...base, external: ['react-dom', 'react'] })).toBe(cacheKey(base));
    expect(cacheKey({ ...base, deps: { b: '1.0.0', a: '2.0.0' } })).toBe(
      cacheKey({ ...base, deps: { a: '2.0.0', b: '1.0.0' } }),
    );
  });

  it('changes with everything that changes the output', () => {
    const keys = new Set([
      cacheKey(base),
      cacheKey({ ...base, version: '5.0.14' }),
      cacheKey({ ...base, subpath: '/vanilla' }),
      cacheKey({ ...base, external: ['react'] }),
      cacheKey({ ...base, external: [] }),
      cacheKey({ ...base, deps: { three: '0.186.1' } }),
      cacheKey({ ...base, target: 'esnext' }),
      cacheKey({ ...base, dev: true }),
      cacheKey({ ...base, name: '@scope/zustand' }),
    ]);
    expect(keys.size).toBe(9);
    expect(cacheKey(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is unambiguous (no string concatenation collisions)', () => {
    expect(cacheKeyString({ ...base, name: 'a', subpath: '/b' })).not.toBe(
      cacheKeyString({ ...base, name: 'a/b', subpath: '' }),
    );
  });
});
