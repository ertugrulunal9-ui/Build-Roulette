import { ImportMapSchema } from '@br/protocol';
import { describe, expect, it } from 'vitest';
import {
  MAX_CDN_EXTERNALS,
  REACT_DOM_SCHEDULER,
  buildImportMap,
  cdnExternals,
  decodeAsset,
  isPinnedVersion,
  loaderForPath,
  normalizePath,
  parseBareSpecifier,
  resolveBareImport,
  resolveWorkspaceImport,
  schedulerPin,
} from '../src/bundler/resolve';

const CDN = 'https://pkg.example.net/';
const TEMPLATE = { react: '19.3.0', 'react-dom': '19.3.0' };
const DEPS = {
  react: '19.3.0',
  'react-dom': '19.3.0',
  zustand: '5.0.15',
  three: '0.170.0',
  '@scope/ui': '1.2.3-beta.1',
  'animate.css': '4.1.1',
  loose: '^1.0.0',
};
/** The build's externals with DEPS (T-040): React, React DOM and every exact package, sorted. */
const EXTERNALS = ['@scope/ui', 'animate.css', 'react', 'react-dom', 'three', 'zustand'];
/** The query of a JS CDN URL of `name` in a build with DEPS: every other package external. */
const q = (name: string) => `?external=${EXTERNALS.filter((n) => n !== name).join(',')}`;

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
    // `scheduler` only when the manifest lists it (an undeclared import stays an error).
    expect(resolveBareImport('scheduler', DEPS, CDN).kind).toBe('error');
    expect(resolveBareImport('scheduler', { ...DEPS, scheduler: '0.28.0' }, CDN)).toEqual({
      kind: 'import-map',
    });
  });
  it('rewrites other packages to pinned CDN URLs that externalize every other package, keeping subpaths', () => {
    expect(resolveBareImport('zustand', DEPS, CDN)).toEqual({
      kind: 'cdn',
      url: `https://pkg.example.net/zustand@5.0.15${q('zustand')}`,
    });
    expect(resolveBareImport('three/examples/jsm/controls/OrbitControls.js', DEPS, CDN)).toEqual({
      kind: 'cdn',
      url: `https://pkg.example.net/three@0.170.0/examples/jsm/controls/OrbitControls.js${q('three')}`,
    });
    expect(resolveBareImport('@scope/ui/button', DEPS, CDN)).toEqual({
      kind: 'cdn',
      url: `https://pkg.example.net/@scope/ui@1.2.3-beta.1/button${q('@scope/ui')}`,
    });
  });
  it('gives the React set fixed queries, whatever else the manifest holds', () => {
    // React DOM's own subpaths externalize its pinned scheduler (T-040), React's do not.
    expect(resolveBareImport('react-dom/server', DEPS, CDN)).toEqual({
      kind: 'cdn',
      url: 'https://pkg.example.net/react-dom@19.3.0/server?external=react,react-dom,scheduler',
    });
    expect(resolveBareImport('react/compiler-runtime', DEPS, CDN)).toEqual({
      kind: 'cdn',
      url: 'https://pkg.example.net/react@19.3.0/compiler-runtime?external=react,react-dom',
    });
  });
  it("gives a package the same URL in the bundle as in the import map, so another package's import of it is the one instance", () => {
    const deps = {
      react: '19.3.0',
      'react-dom': '19.3.0',
      three: '0.170.0',
      '@react-three/fiber': '9.4.0',
    };
    const three = resolveBareImport('three', deps, CDN);
    const fiber = resolveBareImport('@react-three/fiber', deps, CDN);
    expect(three).toEqual({
      kind: 'cdn',
      url: 'https://pkg.example.net/three@0.170.0?external=@react-three/fiber,react,react-dom',
    });
    // fiber leaves `three` bare: the import map sends it to the URL above.
    expect(fiber).toEqual({
      kind: 'cdn',
      url: 'https://pkg.example.net/@react-three/fiber@9.4.0?external=react,react-dom,three',
    });
    const map = buildImportMap(deps, CDN);
    expect(three.kind === 'cdn' && three.url).toBe(map.imports['three']);
    expect(fiber.kind === 'cdn' && fiber.url).toBe(map.imports['@react-three/fiber']);
  });
  it('accepts precomputed externals (one list per build), null meaning React only', () => {
    expect(resolveBareImport('zustand', DEPS, CDN, ['react', 'react-dom', 'zustand'])).toEqual({
      kind: 'cdn',
      url: 'https://pkg.example.net/zustand@5.0.15?external=react,react-dom',
    });
    expect(resolveBareImport('zustand', DEPS, CDN, null)).toEqual({
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

describe('cdnExternals', () => {
  it('lists React, React DOM and every exact manifest package, sorted as the CDN sorts them', () => {
    expect(cdnExternals(DEPS)).toEqual(EXTERNALS);
    // Sorted as strings, like apps/pkg-cdn's `parseQuery` ('-' < '@' < letters).
    expect(cdnExternals({ 'a-b': '1.0.0', a: '2.0.0' })).toEqual([
      'a',
      'a-b',
      'react',
      'react-dom',
    ]);
    expect(cdnExternals({ react: '19.3.0', 'react-dom': '19.3.0' })).toEqual([
      'react',
      'react-dom',
    ]);
    expect(cdnExternals({})).toEqual(['react', 'react-dom']);
  });
  it('is deterministic regardless of manifest key order', () => {
    const reversed = Object.fromEntries(Object.entries(DEPS).reverse());
    expect(cdnExternals(reversed)).toEqual(cdnExternals(DEPS));
  });
  it('leaves out entries the CDN would reject', () => {
    expect(
      cdnExternals({
        ok: '1.0.0',
        ranged: '^1.0.0',
        meta: '1.0.0+build.5', // build metadata: not an exact version for the CDN
        'Upper-Case': '1.0.0',
        'tilde~name': '1.0.0',
        node_modules: '1.0.0',
        'a&external=evil': '1.0.0', // never reaches the query string
        'a,b': '1.0.0',
        lead0: '01.0.0',
        long: `1.0.0-${'x'.repeat(200)}`,
      }),
    ).toEqual(['ok', 'react', 'react-dom']);
  });
  it('returns null above the CDN limit; URLs then externalize React only', () => {
    const many: Record<string, string> = { react: '19.3.0', 'react-dom': '19.3.0' };
    for (let i = 0; i < MAX_CDN_EXTERNALS - 1; i++) many[`pkg-${String(i)}`] = '1.0.0';
    // The package itself is never in its own list: 32 others is the most.
    expect(cdnExternals(many)).toHaveLength(MAX_CDN_EXTERNALS + 1);
    many['one-more'] = '1.0.0';
    expect(cdnExternals(many)).toBeNull();
    expect(resolveBareImport('pkg-1', many, CDN)).toEqual({
      kind: 'cdn',
      url: 'https://pkg.example.net/pkg-1@1.0.0?external=react,react-dom',
    });
    // The import map then holds the React set only.
    expect(Object.keys(buildImportMap(many, CDN).imports).sort()).toEqual(
      Object.keys(buildImportMap({ react: '19.3.0', 'react-dom': '19.3.0' }, CDN).imports).sort(),
    );
  });
  it('returns null when the list would not fit in a URL', () => {
    const long: Record<string, string> = {};
    for (let i = 0; i < 6; i++) long[`@scope-${String(i)}/${'n'.repeat(200)}`] = '1.0.0';
    expect(cdnExternals(long)).toBeNull();
  });
});

describe('schedulerPin', () => {
  it("pins the scheduler of the manifest's React DOM minor", () => {
    expect(schedulerPin({ 'react-dom': '19.3.0' })).toBe('0.28.0');
    expect(schedulerPin({ 'react-dom': '19.2.4' })).toBe('0.27.0');
    expect(schedulerPin({ 'react-dom': '19.0.8' })).toBe('0.25.0');
    expect(Object.values(REACT_DOM_SCHEDULER).every((v) => isPinnedVersion(v))).toBe(true);
  });
  it("prefers the manifest's own scheduler pin", () => {
    expect(schedulerPin({ 'react-dom': '19.3.0', scheduler: '0.27.0' })).toBe('0.27.0');
    expect(schedulerPin({ scheduler: '0.28.0' })).toBe('0.28.0');
    expect(schedulerPin({ 'react-dom': '19.3.0', scheduler: '^0.28.0' })).toBeNull();
  });
  it('is null for an unknown, unpinned or prerelease React DOM', () => {
    expect(schedulerPin({})).toBeNull();
    expect(schedulerPin({ 'react-dom': '18.3.1' })).toBeNull();
    expect(schedulerPin({ 'react-dom': '^19.3.0' })).toBeNull();
    expect(schedulerPin({ 'react-dom': '19.3.0-canary-d5736f09-20260507' })).toBeNull();
  });
});

describe('buildImportMap', () => {
  it('maps the React set to one pinned instance each, scheduler included (T-040)', () => {
    expect(buildImportMap(TEMPLATE, 'http://localhost:4312')).toEqual({
      imports: {
        react: 'http://localhost:4312/react@19.3.0',
        'react/jsx-runtime':
          'http://localhost:4312/react@19.3.0/jsx-runtime?external=react,react-dom',
        'react/jsx-dev-runtime':
          'http://localhost:4312/react@19.3.0/jsx-dev-runtime?external=react,react-dom',
        'react/': 'http://localhost:4312/react@19.3.0&external=react,react-dom/',
        'react-dom': 'http://localhost:4312/react-dom@19.3.0?external=react,react-dom,scheduler',
        'react-dom/client':
          'http://localhost:4312/react-dom@19.3.0/client?external=react,react-dom,scheduler',
        'react-dom/': 'http://localhost:4312/react-dom@19.3.0&external=react,react-dom,scheduler/',
        scheduler: 'http://localhost:4312/scheduler@0.28.0',
      },
    });
  });
  it('keeps the React set the same whatever else the manifest holds (T-032 cache)', () => {
    const template = buildImportMap(TEMPLATE, CDN).imports;
    const withMore = buildImportMap(DEPS, CDN).imports;
    for (const [k, v] of Object.entries(template)) expect(withMore[k], k).toBe(v);
  });
  it('maps every other exact package of the manifest, with a prefix for its subpaths', () => {
    const map = buildImportMap(DEPS, CDN).imports;
    expect(map['zustand']).toBe(`https://pkg.example.net/zustand@5.0.15${q('zustand')}`);
    expect(map['three']).toBe(`https://pkg.example.net/three@0.170.0${q('three')}`);
    expect(map['three/']).toBe(
      'https://pkg.example.net/three@0.170.0&external=@scope%252Fui,animate.css,react,react-dom,zustand/',
    );
    expect(map['@scope/ui']).toBe(
      `https://pkg.example.net/@scope/ui@1.2.3-beta.1${q('@scope/ui')}`,
    );
    expect(map['@scope/ui/']).toBe(
      'https://pkg.example.net/@scope/ui@1.2.3-beta.1&external=animate.css,react,react-dom,three,zustand/',
    );
    // Not pinned: never mapped.
    expect(map['loose']).toBeUndefined();
    expect(Object.keys(map)).toHaveLength(8 + 2 * 4);
  });
  it('resolves a subpath through the prefix to the same build arguments as the main URL', () => {
    const map = buildImportMap(DEPS, CDN).imports;
    const viaPrefix = new URL('examples/jsm/controls/OrbitControls.js', map['three/']);
    // What the CDN reads from the path (decode once, split at `&`, read it as a query).
    const path = decodeURIComponent(viaPrefix.pathname);
    const head = path.slice(1, path.indexOf('/', 1));
    const query = new URLSearchParams(head.slice(head.indexOf('&') + 1));
    const main = new URL(map['three'] ?? '');
    expect(query.get('external')).toBe(main.searchParams.get('external'));
    expect(path.slice(head.length + 1)).toBe('/examples/jsm/controls/OrbitControls.js');
  });
  it('only has exact-version URLs: no redirect hop that expires (T-032)', () => {
    const exact = /^(?:@[^/@]+\/)?[^/@]+@\d+\.\d+\.\d+(?:-[\w.]+)?(?:[&/].*)?$/;
    for (const deps of [TEMPLATE, DEPS]) {
      for (const url of Object.values(buildImportMap(deps, 'https://pkg.example.net').imports)) {
        expect(decodeURIComponent(new URL(url).pathname).slice(1), url).toMatch(exact);
      }
    }
    // A range or tag is never mapped (it would be a 302 that is only cached for 5 minutes).
    expect(buildImportMap({ react: '^19.3.0', 'react-dom': 'latest' }, CDN)).toEqual({
      imports: {},
    });
  });
  it('maps React DOM without scheduler when its scheduler is not known', () => {
    expect(buildImportMap({ react: '18.3.1', 'react-dom': '18.3.1' }, CDN).imports).toEqual({
      react: 'https://pkg.example.net/react@18.3.1',
      'react/jsx-runtime':
        'https://pkg.example.net/react@18.3.1/jsx-runtime?external=react,react-dom',
      'react/jsx-dev-runtime':
        'https://pkg.example.net/react@18.3.1/jsx-dev-runtime?external=react,react-dom',
      'react/': 'https://pkg.example.net/react@18.3.1&external=react,react-dom/',
      'react-dom': 'https://pkg.example.net/react-dom@18.3.1?external=react,react-dom',
      'react-dom/client':
        'https://pkg.example.net/react-dom@18.3.1/client?external=react,react-dom',
      'react-dom/': 'https://pkg.example.net/react-dom@18.3.1&external=react,react-dom/',
    });
  });
  it('maps nothing but CDN URLs from a hostile manifest (REVEAL and capture read stored ones)', () => {
    const hostile = {
      ...TEMPLATE,
      'https://evil.example/x': '1.0.0',
      '../../x': '1.0.0',
      'a&external=evil': '1.0.0',
      'a?b': '1.0.0',
      'a#b': '1.0.0',
      ok: '1.0.0/../../evil',
      fine: '1.0.0',
    };
    const map = buildImportMap(hostile, 'https://esm.sh').imports;
    const template = buildImportMap(TEMPLATE, 'https://esm.sh').imports;
    expect(Object.keys(map).sort()).toEqual([...Object.keys(template), 'fine', 'fine/'].sort());
    for (const url of Object.values(map)) expect(url.startsWith('https://esm.sh/')).toBe(true);
  });
  it('maps packages without React too (vanilla templates)', () => {
    expect(buildImportMap({ zustand: '5.0.15' }, CDN)).toEqual({
      imports: {
        zustand: 'https://pkg.example.net/zustand@5.0.15?external=react,react-dom',
        'zustand/': 'https://pkg.example.net/zustand@5.0.15&external=react,react-dom/',
      },
    });
  });
  it('stays within the bridge limits for the largest manifest it accepts', () => {
    const many: Record<string, string> = { ...TEMPLATE };
    for (let i = 0; i < MAX_CDN_EXTERNALS - 1; i++) many[`@scope-${String(i)}/pkg`] = '10.20.30';
    expect(cdnExternals(many)).not.toBeNull();
    const parsed = ImportMapSchema.safeParse(buildImportMap(many, 'https://esm.sh'));
    expect(parsed.success).toBe(true);
    expect(Object.keys(parsed.data?.imports ?? {})).toHaveLength(8 + 2 * (MAX_CDN_EXTERNALS - 1));
  });
});

/**
 * T-035: the public esm.sh is production's CDN on the free plan, @br/pkg-cdn stays the local
 * and future option. The CDN is configuration only: the same base URL setting, and the same
 * URL shapes, which esm.sh documents (`/pkg@x.y.z[/sub]`, `?external=`, `/pkg@x.y.z&external=…/`).
 */
describe('esm.sh as the package CDN (T-035, T-040)', () => {
  it('builds the import map on esm.sh: exact versions, the same as on any other base URL', () => {
    for (const base of ['https://esm.sh', 'https://esm.sh/']) {
      const map = buildImportMap(TEMPLATE, base).imports;
      expect(map).toEqual(
        Object.fromEntries(
          Object.entries(buildImportMap(TEMPLATE, 'http://localhost:4312').imports).map(
            ([k, v]) => [k, v.replace('http://localhost:4312', 'https://esm.sh')],
          ),
        ),
      );
      expect(map['scheduler']).toBe('https://esm.sh/scheduler@0.28.0');
    }
  });

  it('gives the same paths and queries on esm.sh and on @br/pkg-cdn, only the origin differs', () => {
    const deps = { ...TEMPLATE, three: '0.186.1', '@react-three/fiber': '9.8.1', leaflet: '1.9.4' };
    const specs = [
      'three',
      'three/examples/jsm/controls/OrbitControls.js',
      '@react-three/fiber',
      'leaflet/dist/leaflet.css',
    ];
    const ours = specs.map((s) => resolveBareImport(s, deps, 'http://localhost:4400'));
    const esm = specs.map((s) => resolveBareImport(s, deps, 'https://esm.sh'));
    expect(esm).toEqual([
      {
        kind: 'cdn',
        url: 'https://esm.sh/three@0.186.1?external=@react-three/fiber,leaflet,react,react-dom',
      },
      {
        kind: 'cdn',
        url: 'https://esm.sh/three@0.186.1/examples/jsm/controls/OrbitControls.js?external=@react-three/fiber,leaflet,react,react-dom',
      },
      {
        kind: 'cdn',
        url: 'https://esm.sh/@react-three/fiber@9.8.1?external=leaflet,react,react-dom,three',
      },
      // Raw file: no query, so esm.sh serves the file as it is in the package.
      { kind: 'cdn-css', url: 'https://esm.sh/leaflet@1.9.4/dist/leaflet.css' },
    ]);
    expect(
      ours.map((r) =>
        r.kind === 'cdn' || r.kind === 'cdn-css'
          ? r.url.replace('http://localhost:4400', 'https://esm.sh')
          : r,
      ),
    ).toEqual(esm.map((r) => (r.kind === 'cdn' || r.kind === 'cdn-css' ? r.url : r)));
    // No `target=` and no `deps=`: esm.sh picks the target from the User-Agent, and every
    // package of the manifest is external, so there is nothing left for `deps=` to pin.
    for (const r of esm) {
      expect('url' in r ? r.url : '').not.toContain('target=');
      expect('url' in r ? r.url : '').not.toContain('deps=');
    }
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
