/**
 * End-to-end tests of the HTTP server against an in-memory registry (no network): version
 * redirects, bundling (CJS named exports, externals, peers, self-references, built-ins),
 * raw files, caching headers, policy and security failures.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { Denylist } from '../src/policy';
import { startCdnServer, type CdnServer } from '../src/server';
import { createFakeRegistry, FAKE_REGISTRY, type FakePackage } from './helpers/fake-registry';

let root: string;
let server: CdnServer;
let registry: ReturnType<typeof createFakeRegistry>;
const pwnedMarker = () => path.join(root, 'PWNED');

function packages(): Record<string, FakePackage> {
  // The tree of evil-escape@1.0.0 lives at <cache>/trees/v1/evil-escape@1.0.0/node_modules/evil-escape/.
  // Six levels up from there is <root>, where secret.js is.
  const escape = '../../../../../../secret.js';
  return {
    react: {
      versions: {
        '19.0.0': {
          files: {
            'index.js':
              "exports.createElement = function (t) { return { t: t }; };\nexports.useState = function (v) { return [v]; };\nexports.version = '19.0.0';\n",
          },
          pkg: { main: 'index.js' },
        },
      },
    },
    'dep-a': {
      versions: {
        '1.0.0': { files: { 'index.js': "exports.name = 'dep-a@1.0.0';" } },
        '1.1.0': { files: { 'index.js': "exports.name = 'dep-a@1.1.0';" } },
        '2.0.0': { files: { 'index.js': "exports.name = 'dep-a@2.0.0';" } },
      },
      distTags: { latest: '2.0.0' },
    },
    'cjs-lib': {
      versions: {
        '1.0.0': {
          dependencies: { 'dep-a': '^1.0.0' },
          files: {
            'index.js': [
              "var a = require('dep-a');",
              "exports.hello = function () { return 'hello ' + a.name; };",
              'exports.answer = 42;',
              'exports.env = process.env.NODE_ENV;',
              'exports.platform = process.platform;',
              "exports.hasGlobal = typeof global === 'object';",
            ].join('\n'),
          },
        },
        '1.2.0': { dependencies: { 'dep-a': '^1.0.0' }, files: { 'index.js': 'exports.v = 2;' } },
      },
      distTags: { latest: '1.2.0' },
    },
    'esm-lib': {
      versions: {
        '2.0.0': {
          pkg: {
            type: 'module',
            exports: {
              '.': { browser: './browser.js', default: './node.js' },
              './sub': './sub.js',
              './style.css': './style.css',
            },
          },
          files: {
            'browser.js': "export const where = 'browser';\nexport default 'esm-default';\n",
            'node.js': "export const where = 'node';\n",
            'sub.js': "import { where } from 'esm-lib';\nexport const sub = 'sub:' + where;\n",
            'style.css': '.x { color: red; }\n',
            'secret-not-exported.js': 'export const s = 1;\n',
          },
        },
      },
    },
    'react-lib': {
      versions: {
        '1.0.0': {
          peerDependencies: { react: '^19.0.0', 'peer-thing': '^3.0.0' },
          files: {
            'index.mjs':
              "import { useState } from 'react';\nimport thing from 'peer-thing';\nexport const hook = useState;\nexport const t = thing;\n",
            'cjs.js':
              "var React = require('react');\nvar thing = require('peer-thing');\nexports.el = function () { return React.createElement('div'); };\nexports.thing = thing;\n",
          },
          pkg: {
            module: 'index.mjs',
            main: 'cjs.js',
            exports: { '.': './index.mjs', './cjs': './cjs.js' },
          },
        },
      },
    },
    'peer-thing': {
      versions: {
        '3.0.0': { files: { 'index.js': 'module.exports = 3;' } },
        '3.1.0': { files: { 'index.js': 'module.exports = 31;' } },
      },
    },
    installer: {
      versions: {
        '1.0.0': {
          pkg: {
            scripts: {
              postinstall: `node -e "require('fs').writeFileSync(${JSON.stringify(path.join(tmpdir(), 'never'))}, 'x')"`,
            },
          },
          files: { 'index.js': "exports.installed = 'without scripts';" },
        },
      },
    },
    'node-user': {
      versions: {
        '1.0.0': { files: { 'index.js': "var fs = require('fs');\nexports.kind = typeof fs;" } },
      },
    },
    'evil-escape': {
      versions: { '1.0.0': { files: { 'index.js': `export { default } from '${escape}';` } } },
    },
    'evil-browser-map': {
      versions: {
        '1.0.0': {
          pkg: { browser: { './index.js': '../../../../../../secret.js' } },
          files: { 'index.js': 'export default 1;' },
        },
      },
    },
    'bad-integrity': {
      versions: {
        '1.0.0': {
          files: { 'index.js': 'x' },
          integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
        },
      },
    },
    'no-integrity': { versions: { '1.0.0': { files: { 'index.js': 'x' }, integrity: null } } },
    huge: {
      versions: { '1.0.0': { files: { 'index.js': 'x' }, unpackedSize: 10 * 1024 * 1024 * 1024 } },
    },
    'uses-evil': {
      versions: { '1.0.0': { dependencies: { 'evil-dep': '^1.0.0' }, files: { 'index.js': '' } } },
    },
    'evil-dep': { versions: { '1.0.0': { files: { 'index.js': '' } } } },
    'browser-false': {
      versions: {
        '1.0.0': {
          pkg: { browser: { ws: false, './node.js': false } },
          files: {
            'index.js':
              "var ws = require('ws');\nvar n = require('./node.js');\nexports.kinds = typeof ws + ',' + typeof n;\n",
            'node.js': "throw new Error('node only');",
          },
        },
      },
    },
    'json-lib': {
      versions: {
        '1.0.0': { files: { 'data.json': '{"a":1}', 'index.js': 'module.exports = 1;' } },
      },
    },
    'css-in-js': {
      versions: {
        '1.0.0': {
          files: {
            'index.js': "import './style.css';\nexport const styled = true;\n",
            'style.css': '.css-in-js { color: blue; }',
          },
          pkg: { type: 'module' },
        },
      },
    },
    'slow-tree': {
      versions: {
        '1.0.0': {
          dependencies: Object.fromEntries(
            Array.from({ length: 12 }, (_, i) => [`leaf${String(i)}`, '1.0.0']),
          ),
          files: { 'index.js': '' },
        },
      },
    },
    ...Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [
        `leaf${String(i)}`,
        { versions: { '1.0.0': { files: { 'index.js': '' } } } },
      ]),
    ),
  };
}

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'pkg-cdn-server-'));
  writeFileSync(path.join(root, 'secret.js'), "export default 'TOP-SECRET-VALUE';\n");
  registry = createFakeRegistry(packages());
  const config = {
    ...loadConfig({}),
    host: '127.0.0.1',
    port: 0,
    cacheDir: path.join(root, 'cache'),
    registryUrl: FAKE_REGISTRY,
  };
  config.limits = { ...config.limits, maxDependencies: 10 };
  server = await startCdnServer(config, {
    fetch: registry.fetch,
    denylist: new Denylist([
      { name: 'evil-dep', reason: 'test malware' },
      { name: 'cjs-lib', versions: '0.0.1', reason: 'bad old release' },
    ]),
  });
});

afterAll(async () => {
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

async function get(p: string, init?: RequestInit) {
  const res = await fetch(server.url + p, { redirect: 'manual', ...init });
  return { res, status: res.status, body: await res.text(), h: (k: string) => res.headers.get(k) };
}

function rawStatus(p: string): Promise<number> {
  const { port } = new URL(server.url);
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: Number(port), path: p, method: 'GET' },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Evaluates a bundle that has no imports, via a data: URL. */
async function evaluate(code: string): Promise<Record<string, unknown>> {
  return (await import(
    `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
  )) as Record<string, unknown>;
}

describe('versions and redirects', () => {
  it('redirects ranges and tags to the exact version, preserving subpath and query', async () => {
    const r = await get('/cjs-lib@^1.0.0/x?external=react,react-dom');
    expect(r.status).toBe(302);
    expect(r.h('location')).toBe('/cjs-lib@1.2.0/x?external=react,react-dom');
    expect(r.h('cache-control')).toBe(
      'public, max-age=300, stale-while-revalidate=60, stale-if-error=86400',
    );
    expect(r.h('access-control-allow-origin')).toBe('*');
    expect((await get('/cjs-lib')).h('location')).toBe('/cjs-lib@1.2.0');
    expect((await get('/cjs-lib@~1.0.0')).h('location')).toBe('/cjs-lib@1.0.0');
    expect((await get('/dep-a@^1')).h('location')).toBe('/dep-a@1.1.0');
  });

  it('returns clear 4xx errors', async () => {
    const unknown = await get('/no-such-package@1.0.0');
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatch(/does not exist on the registry/);
    expect(unknown.h('x-pkg-cdn-error')).toBe('unknown-package');
    expect(unknown.h('cache-control')).toBe('no-store');
    const badVersion = await get('/cjs-lib@9.9.9');
    expect(badVersion.status).toBe(404);
    expect(badVersion.body).toMatch(/no version matching "9.9.9" \(latest is 1.2.0\)/);
    expect((await get('/cjs-lib@^7')).status).toBe(404);
    expect((await get('/Bad_Name@1.0.0')).status).toBe(400);
    // fetch() would normalize the dots away, so send the raw request line.
    expect(await rawStatus('/x@1.0.0/../../etc/passwd')).toBe(400);
    expect(await rawStatus('/x@1.0.0/%2e%2e/%2e%2e/etc/passwd')).toBe(400);
    expect((await get('/cjs-lib@1.0.0', { method: 'POST' })).status).toBe(405);
  });
});

describe('bundling', () => {
  it('bundles a CJS package with its dependency into an ES module with named exports', async () => {
    const r = await get('/cjs-lib@1.0.0');
    expect(r.status).toBe(200);
    expect(r.h('content-type')).toBe('application/javascript; charset=utf-8');
    expect(r.h('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(r.h('access-control-allow-origin')).toBe('*');
    expect(r.h('x-cache')).toBe('MISS');
    // T-032: a known length (no chunked encoding), so edge caches can keep it.
    expect(r.h('content-length')).toBe(Buffer.byteLength(r.body).toString());
    expect(r.h('transfer-encoding')).toBeNull();
    const mod = await evaluate(r.body);
    expect((mod['hello'] as () => string)()).toBe('hello dep-a@1.1.0');
    expect(mod['answer']).toBe(42);
    expect(mod['env']).toBe('production');
    expect(mod['platform']).toBe('browser');
    expect(mod['hasGlobal']).toBe(true);
    expect((mod['default'] as { answer: number }).answer).toBe(42);

    const again = await get('/cjs-lib@1.0.0');
    expect(again.h('x-cache')).toBe('HIT');
    expect(again.body).toBe(r.body);
  });

  it('builds development bundles separately', async () => {
    const r = await get('/cjs-lib@1.0.0?dev');
    expect(r.status).toBe(200);
    expect((await evaluate(r.body))['env']).toBe('development');
  });

  it('uses the browser condition and keeps self-references as CDN URLs', async () => {
    const main = await get('/esm-lib@2.0.0');
    const mod = await evaluate(main.body);
    expect(mod['where']).toBe('browser');
    expect(mod['default']).toBe('esm-default');
    const sub = await get('/esm-lib@2.0.0/sub?external=react');
    expect(sub.status).toBe(200);
    expect(sub.body).toMatch(/from\s*"\/esm-lib@2\.0\.0\?external=react"/);
    expect(sub.body).not.toContain("'browser'");
  });

  it('respects the exports map', async () => {
    const r = await get('/esm-lib@2.0.0/secret-not-exported.js');
    expect(r.status).toBe(404);
    expect(r.body).toMatch(/no browser-loadable the subpath|check its "exports"/);
  });

  it('leaves externals bare and turns peers into CDN URLs', async () => {
    const r = await get('/react-lib@1.0.0?external=react,react-dom');
    expect(r.status).toBe(200);
    expect(r.body).toMatch(/from\s*"react"/);
    // Peer not in the tree: resolved to the highest matching version (3.1.0 is latest).
    expect(r.body).toMatch(/from\s*"\/peer-thing@3\.1\.0\?external=react,react-dom"/);
    const pinned = await get('/react-lib@1.0.0?external=react,react-dom&deps=peer-thing@3.0.0');
    expect(pinned.body).toMatch(
      /"\/peer-thing@3\.0\.0\?external=react,react-dom&deps=peer-thing@3\.0\.0"/,
    );
  });

  it('routes a CommonJS require() of an external through an ES module import', async () => {
    const r = await get('/react-lib@1.0.0/cjs?external=react,react-dom');
    expect(r.status).toBe(200);
    expect(r.body).toMatch(/import\s*\*\s*as\s*\w+\s*from\s*"react"/);
    expect(r.body).not.toMatch(/require\("react"\)/);
    // A required peer becomes an import of its CDN URL too.
    expect(r.body).toMatch(
      /import\s*\*\s*as\s*\w+\s*from\s*"\/peer-thing@3\.1\.0\?external=react,react-dom"/,
    );
  });

  it('serves React-like CJS packages with named exports for the import map', async () => {
    const mod = await evaluate((await get('/react@19.0.0')).body);
    expect(mod['version']).toBe('19.0.0');
    expect(typeof mod['useState']).toBe('function');
  });

  it('never runs install scripts', async () => {
    const r = await get('/installer@1.0.0');
    expect(r.status).toBe(200);
    expect((await evaluate(r.body))['installed']).toBe('without scripts');
    expect(existsSync(path.join(tmpdir(), 'never'))).toBe(false);
    expect(existsSync(pwnedMarker())).toBe(false);
  });

  it('replaces unavailable Node built-ins with empty modules and says so', async () => {
    const r = await get('/node-user@1.0.0');
    expect(r.status).toBe(200);
    expect(r.h('x-pkg-cdn-stubbed-builtins')).toBe('fs');
    expect((await evaluate(r.body))['kind']).toBe('object');
  });

  it('honors "browser": false mappings (empty modules)', async () => {
    const r = await get('/browser-false@1.0.0');
    expect(r.status, r.body).toBe(200);
    expect((await evaluate(r.body))['kinds']).toBe('object,object');
  });

  it('injects CSS imported by package JS', async () => {
    const r = await get('/css-in-js@1.0.0');
    expect(r.status).toBe(200);
    expect(r.body).toContain('.css-in-js');
    expect(r.body).toContain('document.createElement("style")');
  });
});

describe('raw files', () => {
  it('serves CSS and JSON raw with immutable caching', async () => {
    const css = await get('/esm-lib@2.0.0/style.css');
    expect(css.status).toBe(200);
    expect(css.h('content-type')).toBe('text/css; charset=utf-8');
    expect(css.h('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(css.h('content-security-policy')).toContain('sandbox');
    expect(css.body).toBe('.x { color: red; }\n');
    const json = await get('/json-lib@1.0.0/data.json');
    expect(json.h('content-type')).toBe('application/json; charset=utf-8');
    expect(json.body).toBe('{"a":1}');
    const head = await get('/esm-lib@2.0.0/style.css', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
  });

  it('serves JSON as a module when asked', async () => {
    const r = await get('/json-lib@1.0.0/data.json?module');
    expect(r.h('content-type')).toBe('application/javascript; charset=utf-8');
    expect((await evaluate(r.body))['default']).toEqual({ a: 1 });
  });

  it('404s for missing raw files', async () => {
    expect((await get('/esm-lib@2.0.0/missing.css')).status).toBe(404);
  });
});

describe('policy and security', () => {
  it('denies denylisted packages, directly and in the dependency tree', async () => {
    const direct = await get('/evil-dep@1.0.0');
    expect(direct.status).toBe(403);
    expect(direct.body).toMatch(/denied by policy: test malware/);
    const transitive = await get('/uses-evil@1.0.0');
    expect(transitive.status).toBe(403);
    expect(transitive.body).toMatch(/evil-dep@1\.0\.0 \(dependency of uses-evil@1\.0\.0\)/);
  });

  it('rejects tarballs whose integrity does not match, or that have no SRI hash', async () => {
    const bad = await get('/bad-integrity@1.0.0');
    expect(bad.status).toBe(502);
    expect(bad.h('x-pkg-cdn-error')).toBe('integrity');
    expect((await get('/no-integrity@1.0.0')).status).toBe(502);
  });

  it('rejects oversized packages before downloading them', async () => {
    const before = registry.requests.filter((r) => r.startsWith('tarball /huge')).length;
    const r = await get('/huge@1.0.0');
    expect(r.status).toBe(413);
    expect(registry.requests.filter((x) => x.startsWith('tarball /huge')).length).toBe(before);
  });

  it('limits the dependency count', async () => {
    const r = await get('/slow-tree@1.0.0');
    expect(r.status).toBe(413);
    expect(r.h('x-pkg-cdn-error')).toBe('too-many-dependencies');
  });

  it('never loads files outside the package tree', async () => {
    const escape = await get('/evil-escape@1.0.0');
    expect(escape.status).toBe(422);
    expect(escape.body).toMatch(/Refusing to load a file outside the package tree/);
    expect(escape.body).not.toContain('TOP-SECRET-VALUE');
    const browserMap = await get('/evil-browser-map@1.0.0');
    expect(browserMap.status).toBe(404);
    expect(browserMap.body).not.toContain('TOP-SECRET-VALUE');
  });

  it('answers CORS preflights and health checks', async () => {
    const pre = await get('/cjs-lib@1.0.0', { method: 'OPTIONS' });
    expect(pre.status).toBe(204);
    expect(pre.h('access-control-allow-methods')).toContain('GET');
    const health = await get('/health');
    expect(JSON.parse(health.body)).toMatchObject({ ok: true });
  });
});

describe('denylist and the disk cache', () => {
  it('applies a newly denied dependency to bundles that are already cached', async () => {
    // The main server has bundled cjs-lib@1.0.0 (with dep-a@1.1.0) into this cache already.
    expect((await get('/cjs-lib@1.0.0')).h('x-cache')).toBe('HIT');
    const config = {
      ...loadConfig({}),
      host: '127.0.0.1',
      port: 0,
      cacheDir: path.join(root, 'cache'),
      registryUrl: FAKE_REGISTRY,
    };
    const s = await startCdnServer(config, {
      fetch: registry.fetch,
      denylist: new Denylist([{ name: 'dep-a', versions: '1.1.0', reason: 'found to be bad' }]),
    });
    try {
      const res = await fetch(`${s.url}/cjs-lib@1.0.0`);
      expect(res.status).toBe(403);
      expect(await res.text()).toMatch(/dep-a@1\.1\.0 \(dependency of cjs-lib@1\.0\.0\)/);
    } finally {
      await s.close();
    }
  });
});

describe('bundle timeout', () => {
  it('fails with 504 when bundling exceeds the limit', async () => {
    const config = {
      ...loadConfig({}),
      host: '127.0.0.1',
      port: 0,
      cacheDir: path.join(root, 'cache-timeout'),
      registryUrl: FAKE_REGISTRY,
    };
    config.limits = { ...config.limits, bundleTimeoutMs: 1 };
    const s = await startCdnServer(config, { fetch: registry.fetch, denylist: new Denylist() });
    try {
      const res = await fetch(`${s.url}/cjs-lib@1.0.0`);
      expect(res.status).toBe(504);
      expect(await res.text()).toMatch(/bundling took longer than 1 ms/);
    } finally {
      await s.close();
    }
  });
});
