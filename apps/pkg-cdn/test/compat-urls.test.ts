import { describe, expect, it } from 'vitest';
import { CASES, REACT_VERSION } from '../compat/packages';
import { caseUrls, importsOf, reactImportMap, shortUrl } from '../compat/urls';

const OURS = 'http://localhost:4400';
const ESM = 'https://esm.sh';

function find(id: string) {
  const c = CASES.find((x) => x.id === id);
  if (!c) throw new Error(`no case ${id}`);
  return c;
}

describe('compat URLs for both CDNs (T-035)', () => {
  it('builds the same React import map on each CDN, only the origin differs', () => {
    const esm = reactImportMap(ESM);
    expect(esm.imports).toEqual({
      react: `https://esm.sh/react@${REACT_VERSION}`,
      'react/jsx-runtime': `https://esm.sh/react@${REACT_VERSION}/jsx-runtime?external=react,react-dom`,
      'react/jsx-dev-runtime': `https://esm.sh/react@${REACT_VERSION}/jsx-dev-runtime?external=react,react-dom`,
      'react-dom': `https://esm.sh/react-dom@${REACT_VERSION}?external=react,react-dom`,
      'react-dom/client': `https://esm.sh/react-dom@${REACT_VERSION}/client?external=react,react-dom`,
    });
    const ours = reactImportMap(OURS).imports;
    expect(Object.values(ours).map((u) => shortUrl(u, OURS))).toEqual(
      Object.values(esm.imports).map((u) => shortUrl(u, ESM)),
    );
  });

  it('gives a case the CDN URLs of its own imports, with the deps pins of its manifest', () => {
    const q = '?external=react,react-dom&deps=@react-three/fiber@9.8.1,three@0.186.1';
    expect(caseUrls(find('@react-three/fiber (one three)'), ESM)).toEqual({
      urls: [
        { spec: 'three', url: `https://esm.sh/three@0.186.1${q}`, kind: 'module' },
        {
          spec: '@react-three/fiber',
          url: `https://esm.sh/@react-three/fiber@9.8.1${q}`,
          kind: 'module',
        },
      ],
      error: null,
    });
    expect(caseUrls(find('@react-three/fiber (one three)'), OURS).urls.map((u) => u.url)).toEqual([
      `${OURS}/three@0.186.1${q}`,
      `${OURS}/@react-three/fiber@9.8.1${q}`,
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
});
