import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { packageNameOf, parseCdnPath, startMockCdn, type MockCdn } from '../test-support/mock-cdn';

describe('parseCdnPath', () => {
  it('parses esm.sh-shaped paths', () => {
    expect(parseCdnPath('/react@19.3.0')).toEqual({
      name: 'react',
      version: '19.3.0',
      subpath: '',
    });
    expect(parseCdnPath('/react-dom@19.3.0/client')).toEqual({
      name: 'react-dom',
      version: '19.3.0',
      subpath: '/client',
    });
    expect(parseCdnPath('/@scope/pkg@1.0.0-rc.1/a/b.css')).toEqual({
      name: '@scope/pkg',
      version: '1.0.0-rc.1',
      subpath: '/a/b.css',
    });
    expect(parseCdnPath('/animate.css@4.1.1/animate.min.css')).toEqual({
      name: 'animate.css',
      version: '4.1.1',
      subpath: '/animate.min.css',
    });
  });
  it('rejects unpinned versions and traversal', () => {
    for (const p of [
      '/react',
      '/react@latest',
      '/react@^19.0.0',
      '/react@19',
      '/@scope@1.0.0',
      '/x@1.0.0/../../etc/passwd',
      'react@1.0.0',
    ]) {
      expect(parseCdnPath(p), p).toBeNull();
    }
  });
  it('packageNameOf', () => {
    expect(packageNameOf('react-dom/client')).toBe('react-dom');
    expect(packageNameOf('@a/b/c')).toBe('@a/b');
  });
});

describe('mock CDN server', () => {
  let cdn: MockCdn;
  beforeAll(async () => {
    cdn = await startMockCdn();
  });
  afterAll(async () => {
    await cdn.close();
  });
  const get = async (p: string) => {
    const res = await fetch(cdn.url + p);
    return {
      status: res.status,
      type: res.headers.get('content-type'),
      cors: res.headers.get('access-control-allow-origin'),
      body: await res.text(),
    };
  };

  it('serves React (CJS) as ESM with real named exports', async () => {
    const r = await get('/react@19.3.0');
    expect(r.status).toBe(200);
    expect(r.type).toContain('javascript');
    expect(r.cors).toBe('*');
    for (const name of [
      'useState',
      'useEffect',
      'createElement',
      'Fragment',
      'version',
      'default',
    ]) {
      expect(r.body, name).toMatch(new RegExp(`as ${name}[,}]`));
    }
    expect(r.body).not.toMatch(/\brequire\(/);
  });

  it('keeps react / react-dom external in react-dom/client and routes CJS requires through ESM imports', async () => {
    const r = await get('/react-dom@19.3.0/client?external=react,react-dom');
    expect(r.status).toBe(200);
    expect(r.body).toMatch(/from\s*"react"/);
    expect(r.body).toMatch(/from\s*"react-dom"/);
    expect(r.body).toMatch(/as createRoot[,}]/);
    expect(r.body).not.toMatch(/\brequire\(/);
    // The target itself is bundled, not re-imported.
    expect(r.body).not.toMatch(/from\s*"react-dom\/client"/);
  });

  it('serves an ESM package with react external', async () => {
    const r = await get('/zustand@5.0.15?external=react,react-dom');
    expect(r.status).toBe(200);
    expect(r.body).toMatch(/from\s*"react"/);
    expect(r.body).toMatch(/as create[,}]/);
  });

  it('serves package CSS raw and caches bundles', async () => {
    const css = await get('/animate.css@4.1.1/animate.min.css');
    expect(css.status).toBe(200);
    expect(css.type).toContain('text/css');
    expect(css.body).toContain('animate__animated');
    const builds = cdn.stats.builds;
    await get('/zustand@5.0.15?external=react,react-dom');
    expect(cdn.stats.builds).toBe(builds);
  });

  it('accepts and ignores deps= pins (it bundles every dependency anyway)', async () => {
    const builds = cdn.stats.builds;
    const r = await get(
      '/zustand@5.0.15?external=react,react-dom&deps=three@0.186.1,zustand@5.0.15',
    );
    expect(r.status).toBe(200);
    expect(r.body).toMatch(/as create[,}]/);
    // Same bundle as without deps: the cache key ignores them.
    expect(cdn.stats.builds).toBe(builds);
  });

  it('answers 404 for other versions and unlisted packages, 400 for bad URLs', async () => {
    expect((await get('/react@18.3.1')).status).toBe(404);
    expect((await get('/react@18.3.1')).body).toContain('installed: 19.3.0');
    expect((await get('/lodash@4.17.21')).status).toBe(404);
    expect((await get('/react@latest')).status).toBe(400);
    expect((await get('/animate.css@4.1.1/missing.css')).status).toBe(404);
  });
});
