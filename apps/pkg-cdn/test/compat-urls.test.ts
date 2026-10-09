import { describe, expect, it } from 'vitest';
import { CASES, REACT_VERSION, knownFailureOn } from '../compat/packages';
import {
  caseMapUrls,
  caseUrls,
  importsOf,
  manifestNames,
  moduleUrlsOf,
  reactImportMap,
  shortUrl,
} from '../compat/urls';

const OURS = 'http://localhost:4400';
const ESM = 'https://esm.sh';

function find(id: string) {
  const c = CASES.find((x) => x.id === id);
  if (!c) throw new Error(`no case ${id}`);
  return c;
}

describe('compat URLs for both CDNs (T-035, T-040)', () => {
  it('builds the same React import map on each CDN, only the origin differs', () => {
    const esm = reactImportMap(ESM);
    expect(moduleUrlsOf(esm)).toEqual([
      `https://esm.sh/react@${REACT_VERSION}`,
      `https://esm.sh/react@${REACT_VERSION}/jsx-runtime?external=react,react-dom`,
      `https://esm.sh/react@${REACT_VERSION}/jsx-dev-runtime?external=react,react-dom`,
      `https://esm.sh/react-dom@${REACT_VERSION}?external=react,react-dom,scheduler`,
      `https://esm.sh/react-dom@${REACT_VERSION}/client?external=react,react-dom,scheduler`,
      // T-040: React DOM's scheduler at its exact version, not esm.sh's `^0.28.0` range.
      'https://esm.sh/scheduler@0.28.0',
    ]);
    // Prefix entries (react/, react-dom/) are not modules: never probed.
    expect(Object.keys(esm.imports)).toContain('react/');
    const ours = reactImportMap(OURS).imports;
    expect(Object.values(ours).map((u) => shortUrl(u, OURS))).toEqual(
      Object.values(esm.imports).map((u) => shortUrl(u, ESM)),
    );
  });

  it('gives a case the CDN URLs of its own imports, every other package of its manifest external', () => {
    expect(caseUrls(find('@react-three/fiber (one three)'), ESM)).toEqual({
      urls: [
        {
          spec: 'three',
          url: 'https://esm.sh/three@0.186.1?external=@react-three/fiber,react,react-dom',
          kind: 'module',
        },
        {
          spec: '@react-three/fiber',
          url: 'https://esm.sh/@react-three/fiber@9.8.1?external=react,react-dom,three',
          kind: 'module',
        },
      ],
      error: null,
    });
    expect(caseUrls(find('@react-three/fiber (one three)'), OURS).urls.map((u) => u.url)).toEqual([
      `${OURS}/three@0.186.1?external=@react-three/fiber,react,react-dom`,
      `${OURS}/@react-three/fiber@9.8.1?external=react,react-dom,three`,
    ]);
    // react-chartjs-2 leaves chart.js bare; the import map sends it to the app's own URL.
    expect(caseMapUrls(find('react-chartjs-2'), ESM)).toEqual([
      {
        spec: 'chart.js',
        url: 'https://esm.sh/chart.js@4.5.1?external=react,react-chartjs-2,react-dom',
        kind: 'module',
      },
      {
        spec: 'react-chartjs-2',
        url: 'https://esm.sh/react-chartjs-2@5.3.1?external=chart.js,react,react-dom',
        kind: 'module',
      },
    ]);
    expect(caseUrls(find('react-chartjs-2'), ESM).urls.map((u) => u.url)).toEqual(
      caseMapUrls(find('react-chartjs-2'), ESM).map((u) => u.url),
    );
    expect([...manifestNames(find('react-chartjs-2'))].sort()).toEqual([
      'chart.js',
      'react',
      'react-chartjs-2',
      'react-dom',
    ]);
    const leaflet = caseUrls(find('leaflet'), ESM).urls;
    expect(leaflet.find((u) => u.kind === 'css')?.url).toBe(
      'https://esm.sh/leaflet@1.9.4/dist/leaflet.css',
    );
  });

  it('leaves React to the import map: the react-dom case has no CDN URLs of its own', () => {
    expect(importsOf(find('react-dom (flushSync, one instance)').app)).toEqual([
      'react',
      'react-dom',
    ]);
    expect(caseUrls(find('react-dom (flushSync, one instance)'), ESM)).toEqual({
      urls: [],
      error: null,
    });
  });

  it('every case resolves on both CDNs, and the paths match', () => {
    for (const c of CASES) {
      const esm = caseUrls(c, ESM);
      const ours = caseUrls(c, OURS);
      expect(esm.error, c.id).toBeNull();
      expect(
        esm.urls.map((u) => shortUrl(u.url, ESM)),
        c.id,
      ).toEqual(ours.urls.map((u) => shortUrl(u.url, OURS)));
    }
    expect(shortUrl('https://other.example/x', ESM)).toBe('https://other.example/x');
  });

  it('knows which failures are known, and on which CDN (T-040)', () => {
    expect(knownFailureOn(find('p5'), ESM)).toContain('bezier-path');
    expect(knownFailureOn(find('p5'), OURS)).toBeNull();
    expect(knownFailureOn(find('matter-js (named imports)'), OURS)).toContain('UMD');
    expect(knownFailureOn(find('matter-js (named imports)'), ESM)).toContain('UMD');
    expect(knownFailureOn(find('pixi.js'), ESM)).toBeNull();
    expect(CASES.filter((c) => c.knownFailure).map((c) => c.id)).toEqual([
      'matter-js (named imports)',
      'p5',
    ]);
  });
});
