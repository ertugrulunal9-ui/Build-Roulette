import { describe, expect, it } from 'vitest';
import {
  MAX_CDN_DEPS,
  buildImportMap,
  cdnDepsPins,
  decodeAsset,
  isPinnedVersion,
  loaderForPath,
  normalizePath,
  parseBareSpecifier,
  resolveBareImport,
  resolveWorkspaceImport,
} from '../src/bundler/resolve';

const CDN = 'https://pkg.example.net/';
const DEPS = {
  react: '19.3.0',
  'react-dom': '19.3.0',
  zustand: '5.0.15',
  three: '0.170.0',
  '@scope/ui': '1.2.3-beta.1',
  'animate.css': '4.1.1',
  loose: '^1.0.0',
};
/** The query every JS CDN URL of a build with DEPS carries (sorted by package name). */
const Q =
  '?external=react,react-dom&deps=@scope/ui@1.2.3-beta.1,animate.css@4.1.1,three@0.170.0,zustand@5.0.15';

describe('normalizePath', () => {
  it('strips leading ./ and /, collapses . and ..', () => {
    expect(normalizePath('./src/App.tsx')).toBe('src/App.tsx');
    expect(normalizePath('/src//a/../b/./c.ts')).toBe('src/b/c.ts');
    expect(normalizePath('src\\win\\path.ts')).toBe('src/win/path.ts');
    expect(normalizePath('../../escape.ts')).toBe('escape.ts');
  });
});

describe('resolveWorkspaceImport (vfs)', () => {
  const files = {
    'src/main.tsx': '',
    'src/App.tsx': '',
    'src/util.ts': '',
    'src/legacy.js': '',
    'src/Button.jsx': '',
    'src/styles.css': '',
    'src/data.json': '',
    'src/components/index.tsx': '',
    'src/components/Card.tsx': '',
    'src/hooks/index.ts': '',
    'src/exact.ts': '',
    'src/exact.ts.tsx': '',
  };
  it('resolves exact paths first', () => {
    expect(resolveWorkspaceImport(files, 'src/main.tsx', './exact.ts')).toBe('src/exact.ts');
    expect(resolveWorkspaceImport(files, 'src/main.tsx', './styles.css')).toBe('src/styles.css');
  });
  it('tries .tsx/.ts/.jsx/.js extensions in order', () => {
    expect(resolveWorkspaceImport(files, 'src/main.tsx', './App')).toBe('src/App.tsx');
    expect(resolveWorkspaceImport(files, 'src/main.tsx', './util')).toBe('src/util.ts');
    expect(resolveWorkspaceImport(files, 'src/main.tsx', './Button')).toBe('src/Button.jsx');
    expect(resolveWorkspaceImport(files, 'src/main.tsx', './legacy')).toBe('src/legacy.js');
    expect(resolveWorkspaceImport(files, 'src/main.tsx', './data')).toBe('src/data.json');
  });
  it('resolves directories to index.*', () => {
    expect(resolveWorkspaceImport(files, 'src/main.tsx', './components')).toBe(
      'src/components/index.tsx',
    );
    expect(resolveWorkspaceImport(files, 'src/main.tsx', './hooks/')).toBe('src/hooks/index.ts');
  });
  it('handles ../ and workspace-absolute imports', () => {
    expect(resolveWorkspaceImport(files, 'src/components/Card.tsx', '../util')).toBe('src/util.ts');
    expect(resolveWorkspaceImport(files, 'src/components/Card.tsx', '/src/App')).toBe(
      'src/App.tsx',
    );
    expect(resolveWorkspaceImport(files, 'src/components/Card.tsx', '.')).toBe(
      'src/components/index.tsx',
    );
  });
  it('returns null when nothing matches', () => {
    expect(resolveWorkspaceImport(files, 'src/main.tsx', './Missing')).toBeNull();
    expect(resolveWorkspaceImport(files, 'src/main.tsx', '../../nope')).toBeNull();
  });
});

describe('parseBareSpecifier', () => {
  it('splits names and subpaths', () => {
    expect(parseBareSpecifier('zustand')).toEqual({ name: 'zustand', subpath: '' });
    expect(parseBareSpecifier('zustand/middleware')).toEqual({
      name: 'zustand',
      subpath: '/middleware',
    });
    expect(parseBareSpecifier('three/examples/jsm/controls/OrbitControls.js')).toEqual({
      name: 'three',
      subpath: '/examples/jsm/controls/OrbitControls.js',
    });
    expect(parseBareSpecifier('@scope/ui/button')).toEqual({
      name: '@scope/ui',
      subpath: '/button',
    });
    expect(parseBareSpecifier('animate.css/animate.min.css')).toEqual({
      name: 'animate.css',
      subpath: '/animate.min.css',
    });
  });
  it('rejects invalid names and path tricks', () => {
    expect(parseBareSpecifier('@scope')).toBeNull();
    expect(parseBareSpecifier('Bad Name')).toBeNull();
    expect(parseBareSpecifier('pkg/../../etc')).toBeNull();
    expect(parseBareSpecifier('pkg//x')).toBeNull();
  });
  it('rejects literal dot segments anywhere in the subpath', () => {
    for (const s of ['pkg/.', 'pkg/..', 'pkg/./x', 'pkg/a/../b', '@scope/ui/..', '@scope/ui/./x'])
      expect(parseBareSpecifier(s), s).toBeNull();
  });
  it('rejects percent-encoded dot segments (any case, alone or mixed with literal dots)', () => {
    for (const s of [
      'pkg/%2e',
      'pkg/%2E',
      'pkg/%2e%2e',
      'pkg/%2E%2E',
      'pkg/%2e%2E',
      'pkg/%2E%2e/x',
      'pkg/.%2e',
      'pkg/%2e.',
      'pkg/.%2E/etc',
      'pkg/a/%2e%2e/%2e%2e/b',
      '@scope/ui/%2e%2e',
      '@scope/ui/x/.%2E',
    ])
      expect(parseBareSpecifier(s), s).toBeNull();
  });
  it('rejects encoded separators and backslashes that could form dot segments later', () => {
    for (const s of ['pkg/a%2f..', 'pkg/a%2F%2e%2e', 'pkg/a%5c..', 'pkg/a\\..', 'pkg/%252e%252e'])
      expect(parseBareSpecifier(s), s).toBeNull();
  });
  it('still accepts names and file names that merely contain dots or percent signs elsewhere', () => {
    expect(parseBareSpecifier('pkg/.hidden')).toEqual({ name: 'pkg', subpath: '/.hidden' });
    expect(parseBareSpecifier('pkg/...')).toEqual({ name: 'pkg', subpath: '/...' });
    expect(parseBareSpecifier('pkg/file.min.js')).toEqual({
      name: 'pkg',
      subpath: '/file.min.js',
    });
    expect(parseBareSpecifier('pkg/%2e.js')).toEqual({ name: 'pkg', subpath: '/%2e.js' });
  });
});

describe('isPinnedVersion', () => {
  it('accepts exact versions only', () => {
    expect(isPinnedVersion('1.2.3')).toBe(true);
    expect(isPinnedVersion('1.2.3-beta.1')).toBe(true);
    for (const v of ['^1.2.3', '~1.2.3', 'latest', '1.x', '1.2', '*', '>=1.0.0', ''])
      expect(isPinnedVersion(v)).toBe(false);
  });
});

describe('resolveBareImport (cdn-rewrite)', () => {
  it('keeps React entry points bare for the import map', () => {
    for (const s of [
      'react',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      'react-dom',
      'react-dom/client',
    ]) {
      expect(resolveBareImport(s, DEPS, CDN)).toEqual({ kind: 'import-map' });
    }
  });
  it('rewrites other packages to pinned CDN URLs with React externals and deps pins, keeping subpaths', () => {
    expect(resolveBareImport('zustand', DEPS, CDN)).toEqual({
      kind: 'cdn',
      url: `https://pkg.example.net/zustand@5.0.15${Q}`,
    });
    expect(resolveBareImport('three/examples/jsm/controls/OrbitControls.js', DEPS, CDN)).toEqual({
      kind: 'cdn',
      url: `https://pkg.example.net/three@0.170.0/examples/jsm/controls/OrbitControls.js${Q}`,
    });
    expect(resolveBareImport('@scope/ui/button', DEPS, CDN)).toEqual({
      kind: 'cdn',
      url: `https://pkg.example.net/@scope/ui@1.2.3-beta.1/button${Q}`,
    });
    expect(resolveBareImport('react-dom/server', DEPS, CDN)).toEqual({
      kind: 'cdn',
      url: `https://pkg.example.net/react-dom@19.3.0/server${Q}`,
    });
  });
  it('gives the user import of a peer the same URL the CDN emits for that peer', () => {
    // pkg-cdn emits a peer as `/<peer>@<deps pin>` + the query of the request it serves, so
    // `three` imported by the user and by @react-three/fiber must carry the same query.
    const deps = {
      react: '19.3.0',
      'react-dom': '19.3.0',
      three: '0.170.0',
      '@react-three/fiber': '9.4.0',
    };
    const three = resolveBareImport('three', deps, CDN);
    const fiber = resolveBareImport('@react-three/fiber', deps, CDN);
    const query = '?external=react,react-dom&deps=@react-three/fiber@9.4.0,three@0.170.0';
    expect(three).toEqual({ kind: 'cdn', url: `https://pkg.example.net/three@0.170.0${query}` });
    expect(fiber).toEqual({
      kind: 'cdn',
      url: `https://pkg.example.net/@react-three/fiber@9.4.0${query}`,
    });
  });
  it('accepts a precomputed deps list (one per build)', () => {
    expect(resolveBareImport('zustand', DEPS, CDN, [])).toEqual({
      kind: 'cdn',
      url: 'https://pkg.example.net/zustand@5.0.15?external=react,react-dom',
    });
  });
  it('routes package CSS to the css fetcher (no query string)', () => {
    expect(resolveBareImport('animate.css/animate.min.css', DEPS, CDN)).toEqual({
      kind: 'cdn-css',
      url: 'https://pkg.example.net/animate.css@4.1.1/animate.min.css',
    });
  });
  it('reports undeclared packages instead of silently using latest', () => {
    const r = resolveBareImport('lodash/debounce', DEPS, CDN);
    expect(r.kind).toBe('error');
    expect(r.kind === 'error' && r.message).toContain('Package "lodash" is not in dependencies');
    expect(resolveBareImport('react', {}, CDN).kind).toBe('error');
  });
  it('reports unpinned versions, node built-ins and invalid names', () => {
    const loose = resolveBareImport('loose', DEPS, CDN);
    expect(loose.kind === 'error' && loose.message).toContain('pinned');
    const fs = resolveBareImport('fs', DEPS, CDN);
    expect(fs.kind === 'error' && fs.message).toContain('Node.js built-in');
    expect(resolveBareImport('node:path', DEPS, CDN)).toMatchObject({ kind: 'error' });
    expect(resolveBareImport('Not Valid', DEPS, CDN)).toMatchObject({ kind: 'error' });
  });
  it('does not treat prototype keys as dependencies', () => {
    expect(resolveBareImport('constructor', DEPS, CDN).kind).toBe('error');
    expect(resolveBareImport('toString', DEPS, CDN).kind).toBe('error');
  });
});

describe('cdnDepsPins', () => {
  it('lists every non-external manifest dependency as name@version, sorted by name', () => {
    expect(cdnDepsPins(DEPS)).toEqual([
      '@scope/ui@1.2.3-beta.1',
      'animate.css@4.1.1',
      'three@0.170.0',
      'zustand@5.0.15',
    ]);
    // By name, as pkg-cdn sorts them: sorting the `name@version` strings would put
    // "a-b@1.0.0" before "a@2.0.0" ('-' < '@').
    expect(cdnDepsPins({ 'a-b': '1.0.0', a: '2.0.0' })).toEqual(['a@2.0.0', 'a-b@1.0.0']);
    expect(cdnDepsPins({ react: '19.3.0', 'react-dom': '19.3.0' })).toEqual([]);
  });
  it('is deterministic regardless of manifest key order', () => {
    const reversed = Object.fromEntries(Object.entries(DEPS).reverse());
    expect(cdnDepsPins(reversed)).toEqual(cdnDepsPins(DEPS));
  });
  it('leaves out entries the CDN would reject', () => {
    expect(
      cdnDepsPins({
        ok: '1.0.0',
        ranged: '^1.0.0',
        meta: '1.0.0+build.5', // build metadata: not an exact version for the CDN
        'Upper-Case': '1.0.0',
        'tilde~name': '1.0.0',
        node_modules: '1.0.0',
        'a&external=evil': '1.0.0', // never reaches the query string
        lead0: '01.0.0',
      }),
    ).toEqual(['ok@1.0.0']);
  });
  it('returns null above the CDN limit, so no URL carries a deps list the CDN rejects', () => {
    const many: Record<string, string> = { react: '19.3.0', 'react-dom': '19.3.0' };
    for (let i = 0; i < MAX_CDN_DEPS; i++) many[`pkg-${String(i)}`] = '1.0.0';
    expect(cdnDepsPins(many)).toHaveLength(MAX_CDN_DEPS);
    many['one-more'] = '1.0.0';
    expect(cdnDepsPins(many)).toBeNull();
    expect(resolveBareImport('pkg-1', many, CDN)).toEqual({
      kind: 'cdn',
      url: 'https://pkg.example.net/pkg-1@1.0.0?external=react,react-dom',
    });
  });
});

describe('buildImportMap', () => {
  it('maps React entry points to one pinned instance', () => {
    expect(buildImportMap(DEPS, 'http://localhost:4312')).toEqual({
      imports: {
        react: 'http://localhost:4312/react@19.3.0',
        'react/jsx-runtime':
          'http://localhost:4312/react@19.3.0/jsx-runtime?external=react,react-dom',
        'react/jsx-dev-runtime':
          'http://localhost:4312/react@19.3.0/jsx-dev-runtime?external=react,react-dom',
        'react-dom': 'http://localhost:4312/react-dom@19.3.0?external=react,react-dom',
        'react-dom/client':
          'http://localhost:4312/react-dom@19.3.0/client?external=react,react-dom',
      },
    });
  });
  it('only has exact-version URLs: no redirect hop that expires (T-032)', () => {
    const exact = /^(?:@[^/@]+\/)?[^/@]+@\d+\.\d+\.\d+(?:-[\w.]+)?(?:\/[^?]*)?$/;
    const map = buildImportMap(DEPS, 'https://pkg.example.net');
    expect(Object.keys(map.imports)).toHaveLength(5);
    for (const url of Object.values(map.imports)) {
      expect(new URL(url).pathname.slice(1), url).toMatch(exact);
    }
    // A range or tag is never mapped (it would be a 302 that is only cached for 5 minutes).
    expect(buildImportMap({ react: '^19.3.0', 'react-dom': 'latest' }, CDN)).toEqual({
      imports: {},
    });
  });
  it('is empty without React (vanilla templates)', () => {
    expect(buildImportMap({ zustand: '5.0.15' }, CDN)).toEqual({ imports: {} });
  });
});

describe('loaderForPath / decodeAsset', () => {
  it('picks loaders by extension', () => {
    expect(loaderForPath('a.tsx')).toBe('tsx');
    expect(loaderForPath('a.ts')).toBe('ts');
    expect(loaderForPath('a.js')).toBe('jsx');
    expect(loaderForPath('a.css')).toBe('css');
    expect(loaderForPath('a.module.css')).toBe('local-css');
    expect(loaderForPath('a.json')).toBe('json');
    expect(loaderForPath('a.PNG')).toBe('asset');
    expect(loaderForPath('a.svg')).toBe('asset');
    expect(loaderForPath('a.exe')).toBeNull();
  });
  it('decodes data URLs and raw SVG', () => {
    expect(decodeAsset('data:image/png;base64,AAEC')).toEqual(new Uint8Array([0, 1, 2]));
    expect(
      new TextDecoder().decode(decodeAsset('data:image/svg+xml,%3Csvg%2F%3E') ?? new Uint8Array()),
    ).toBe('<svg/>');
    expect(new TextDecoder().decode(decodeAsset('<svg></svg>') ?? new Uint8Array())).toBe(
      '<svg></svg>',
    );
    expect(decodeAsset('not an image')).toBeNull();
    expect(decodeAsset('data:image/png;base64,***')).toBeNull();
  });
});
