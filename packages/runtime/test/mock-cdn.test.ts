import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moduleImportUrls } from '@br/protocol';
import {
  esmShInternalPath,
  packageNameOf,
  parseCdnPath,
  parseLayout,
  startMockCdn,
  type MockCdn,
} from '../test-support/mock-cdn';

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

describe('mock CDN with the esm.sh layout (T-035)', () => {
  let cdn: MockCdn;
  beforeAll(async () => {
    cdn = await startMockCdn({ layout: 'esm.sh' });
  });
  afterAll(async () => {
    await cdn.close();
  });

  it('names internal build paths like esm.sh', () => {
    const ext = new Set(['react-dom', 'react']);
    expect(
      esmShInternalPath({ name: 'react', version: '19.3.0', subpath: '' }, new Set(), false),
    ).toBe('/react@19.3.0/es2022/react.mjs');
    expect(
      esmShInternalPath({ name: 'react-dom', version: '19.3.0', subpath: '/client' }, ext, false),
    ).toBe(
      `/react-dom@19.3.0/X-${Buffer.from('external=react,react-dom').toString('base64url')}/es2022/client.mjs`,
    );
    expect(
      esmShInternalPath(
        { name: '@r3f/fiber', version: '9.0.0', subpath: '/a/b.js' },
        new Set(),
        true,
      ),
    ).toBe('/@r3f/fiber@9.0.0/es2022/a/b.development.mjs');
    expect(parseLayout(undefined)).toBe('bundle');
    expect(parseLayout('esm.sh')).toBe('esm.sh');
    expect(() => parseLayout('jsdelivr')).toThrow(/CDN_LAYOUT/);
  });

  it('answers an entry URL with a re-export of the internal path, which holds the module', async () => {
    const entry = await fetch(`${cdn.url}/react-dom@19.3.0/client?external=react,react-dom`);
    expect(entry.status).toBe(200);
    expect(entry.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const stub = await entry.text();
    const internals = moduleImportUrls(stub, entry.url);
    expect(internals).toEqual([
      `${cdn.url}/react-dom@19.3.0/X-${Buffer.from('external=react,react-dom').toString('base64url')}/es2022/client.mjs`,
    ]);
    const mod = await fetch(internals[0] ?? '');
    expect(mod.status).toBe(200);
    expect(mod.headers.get('access-control-allow-origin')).toBe('*');
    const code = await mod.text();
    expect(code).toMatch(/as createRoot[,}]/);
    expect(code).toMatch(/from\s*"react-dom"/);

    // A default export is re-exported too (React is CommonJS: default = module.exports).
    const react = await (await fetch(`${cdn.url}/react@19.3.0`)).text();
    expect(react).toContain('export * from "/react@19.3.0/es2022/react.mjs"');
    expect(react).toContain('export { default } from "/react@19.3.0/es2022/react.mjs"');
    // Raw files stay raw; an internal path nobody announced is unknown.
    const css = await fetch(`${cdn.url}/animate.css@4.1.1/animate.min.css`);
    expect(await css.text()).toContain('animate__animated');
    expect((await fetch(`${cdn.url}/zustand@5.0.15/es2022/zustand.mjs`)).status).not.toBe(200);
  });
});

describe('mock CDN outages (T-032)', () => {
  let cdn: MockCdn;
  beforeAll(async () => {
    cdn = await startMockCdn();
  });
  afterAll(async () => {
    await cdn.close();
  });
  const status = (p: string, timeoutMs = 2000) =>
    fetch(cdn.url + p, { signal: AbortSignal.timeout(timeoutMs) }).then(
      (r) => ({ status: r.status, cors: r.headers.get('access-control-allow-origin') }),
      (e: unknown) => (e instanceof Error ? e.name : 'error'),
    );

  it('refuses connections, then serves again on the same port', async () => {
    expect(await status('/react@19.3.0')).toEqual({ status: 200, cors: '*' });
    await cdn.setOutage('refuse');
    expect(cdn.outage()).toBe('refuse');
    expect(await status('/react@19.3.0')).toBe('TypeError'); // connection refused
    await cdn.setOutage(null);
    expect(await status('/react@19.3.0')).toEqual({ status: 200, cors: '*' });
  });

  it('answers 502 without CORS headers, like an edge error page', async () => {
    await cdn.setOutage('error');
    expect(await status('/react@19.3.0')).toEqual({ status: 502, cors: null });
    await cdn.setOutage(null);
    expect(await status('/react@19.3.0')).toEqual({ status: 200, cors: '*' });
  });

  it('holds requests open until the outage ends, then answers them', async () => {
    await cdn.setOutage('hang');
    expect(await status('/react@19.3.0', 300)).toBe('TimeoutError');
    const waiting = status('/react@19.3.0', 5000);
    await new Promise((r) => setTimeout(r, 200));
    await cdn.setOutage(null);
    expect(await waiting).toEqual({ status: 200, cors: '*' });
    expect(await status('/react@19.3.0')).toEqual({ status: 200, cors: '*' });
  });
});
