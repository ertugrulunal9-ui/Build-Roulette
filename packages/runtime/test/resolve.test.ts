import { describe, expect, it } from 'vitest';
import {
  buildImportMap,
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
  it('rewrites other packages to pinned CDN URLs with React externals, keeping subpaths', () => {
    expect(resolveBareImport('zustand', DEPS, CDN)).toEqual({
      kind: 'cdn',
      url: 'https://pkg.example.net/zustand@5.0.15?external=react,react-dom',
    });
    expect(resolveBareImport('three/examples/jsm/controls/OrbitControls.js', DEPS, CDN)).toEqual({
      kind: 'cdn',
      url: 'https://pkg.example.net/three@0.170.0/examples/jsm/controls/OrbitControls.js?external=react,react-dom',
    });
    expect(resolveBareImport('@scope/ui/button', DEPS, CDN)).toEqual({
      kind: 'cdn',
      url: 'https://pkg.example.net/@scope/ui@1.2.3-beta.1/button?external=react,react-dom',
    });
    expect(resolveBareImport('react-dom/server', DEPS, CDN)).toEqual({
      kind: 'cdn',
      url: 'https://pkg.example.net/react-dom@19.3.0/server?external=react,react-dom',
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
