import { describe, expect, it } from 'vitest';
import { CdnError } from '../src/errors';
import {
  formatQuery,
  parseCdnUrl,
  parsePackagePath,
  parseQuery,
  parseVersionSpec,
} from '../src/url';

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof CdnError) return `${e.status.toString()} ${e.code}`;
    throw e;
  }
  return 'ok';
}

describe('parsePackagePath', () => {
  it('parses name, exact version and subpath', () => {
    expect(parsePackagePath('/zustand@5.0.15')).toEqual({
      name: 'zustand',
      versionText: '5.0.15',
      version: { kind: 'exact', version: '5.0.15' },
      subpath: '',
    });
    expect(parsePackagePath('/three@0.186.1/examples/jsm/controls/OrbitControls.js').subpath).toBe(
      '/examples/jsm/controls/OrbitControls.js',
    );
    expect(parsePackagePath('/react-dom@19.3.0/client/').subpath).toBe('/client');
  });

  it('parses scoped packages', () => {
    const r = parsePackagePath('/@react-three/fiber@9.8.1/dist/x.js');
    expect(r.name).toBe('@react-three/fiber');
    expect(r.version).toEqual({ kind: 'exact', version: '9.8.1' });
    expect(r.subpath).toBe('/dist/x.js');
    expect(parsePackagePath('/@scope/name').version).toEqual({ kind: 'tag', tag: 'latest' });
  });

  it('classifies ranges and tags (percent-encoded too)', () => {
    expect(parsePackagePath('/zustand@^5.0.0').version).toEqual({ kind: 'range', range: '^5.0.0' });
    expect(parsePackagePath('/zustand@%5E5.0.0').version).toEqual({
      kind: 'range',
      range: '^5.0.0',
    });
    expect(parsePackagePath('/zustand@5').version).toEqual({ kind: 'range', range: '5' });
    expect(parsePackagePath('/zustand@next').version).toEqual({ kind: 'tag', tag: 'next' });
    expect(parsePackagePath('/zustand').version).toEqual({ kind: 'tag', tag: 'latest' });
    expect(parsePackagePath('/react@19.0.0-rc.1').version).toEqual({
      kind: 'exact',
      version: '19.0.0-rc.1',
    });
  });

  it('keeps raw file subpaths', () => {
    expect(parsePackagePath('/leaflet@1.9.4/dist/leaflet.css').subpath).toBe('/dist/leaflet.css');
    expect(parsePackagePath('/x@1.0.0/img/icon@2x.png').subpath).toBe('/img/icon@2x.png');
  });

  it('rejects traversal, bad names and garbage', () => {
    expect(code(() => parsePackagePath('/x@1.0.0/../../etc/passwd'))).toBe('400 bad-request');
    expect(code(() => parsePackagePath('/x@1.0.0/%2e%2e/secret'))).toBe('400 bad-request');
    expect(code(() => parsePackagePath('/x@1.0.0/a//b'))).toBe('400 bad-request');
    expect(code(() => parsePackagePath('/x@1.0.0/a\\b'))).toBe('400 bad-request');
    expect(code(() => parsePackagePath('/x@1.0.0/a%00b'))).toBe('400 bad-request');
    expect(code(() => parsePackagePath('/%E0%A4%A'))).toBe('400 bad-request');
    expect(code(() => parsePackagePath('/'))).toBe('400 bad-request');
    expect(code(() => parsePackagePath('/@scope'))).toBe('400 bad-request');
    expect(code(() => parsePackagePath('/Zustand@1.0.0'))).toBe('400 invalid-name');
    expect(code(() => parsePackagePath('/.hidden@1.0.0'))).toBe('400 invalid-name');
    expect(code(() => parsePackagePath('/node_modules@1.0.0'))).toBe('400 invalid-name');
    expect(code(() => parsePackagePath('/x@not a version!'))).toBe('400 invalid-version');
    expect(code(() => parsePackagePath(`/x@${'1'.repeat(200)}`))).toBe('400 invalid-version');
  });
});

describe('parseVersionSpec', () => {
  it('distinguishes exact, range and tag', () => {
    expect(parseVersionSpec('1.2.3').kind).toBe('exact');
    expect(parseVersionSpec('~1.2.3').kind).toBe('range');
    expect(parseVersionSpec('>=1 <2').kind).toBe('range');
    expect(parseVersionSpec('*').kind).toBe('range');
    expect(parseVersionSpec('beta').kind).toBe('tag');
    expect(parseVersionSpec('v1.2.3').kind).toBe('range'); // semver treats "v1.2.3" as a range
  });
});

describe('parseQuery', () => {
  it('sorts and de-duplicates externals', () => {
    const q = parseQuery(new URLSearchParams('external=react-dom,react,react'));
    expect(q.external).toEqual(['react', 'react-dom']);
    expect(q.target).toBe('es2022');
    expect(q.dev).toBe(false);
  });

  it('parses deps pins, target, dev and module flags', () => {
    const q = parseQuery(
      new URLSearchParams('deps=three@0.186.1,@a/b@1.0.0&target=esnext&dev&module'),
    );
    expect(q.deps).toEqual({ '@a/b': '1.0.0', three: '0.186.1' });
    expect(q.target).toBe('esnext');
    expect(q.dev).toBe(true);
    expect(q.module).toBe(true);
  });

  it('rejects invalid values', () => {
    expect(code(() => parseQuery(new URLSearchParams('external=*')))).toBe('400 bad-request');
    expect(code(() => parseQuery(new URLSearchParams('external=../x')))).toBe('400 bad-request');
    expect(code(() => parseQuery(new URLSearchParams('deps=three@^1')))).toBe('400 bad-request');
    expect(code(() => parseQuery(new URLSearchParams('target=es5')))).toBe('400 bad-request');
  });
});

describe('parseCdnUrl / formatQuery', () => {
  it('round-trips the runtime URL shape', () => {
    const r = parseCdnUrl('/react-dom@19.3.0/client', '?external=react,react-dom');
    expect(r.name).toBe('react-dom');
    expect(r.subpath).toBe('/client');
    expect(r.query.external).toEqual(['react', 'react-dom']);
    expect(formatQuery(r.query)).toBe('?external=react,react-dom');
    expect(formatQuery({ external: [], deps: {}, target: 'es2022', dev: false })).toBe('');
    expect(
      formatQuery({ external: ['react'], deps: { a: '1.0.0' }, target: 'esnext', dev: true }),
    ).toBe('?external=react&deps=a@1.0.0&target=esnext&dev');
  });
});
