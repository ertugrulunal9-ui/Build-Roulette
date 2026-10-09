/**
 * The CDN URLs a compatibility case makes the runtime request, computed with the runtime's own
 * functions (`resolveBareImport`, `buildImportMap`), for any CDN base URL. Pure, so it is unit
 * tested for @br/pkg-cdn and esm.sh alike (test/compat-urls.test.ts).
 */
import type { ImportMap } from '@br/protocol';
import type { Manifest } from '@br/runtime';
import { buildImportMap, resolveBareImport } from '@br/runtime/bundler';
import { REACT_VERSION, type CompatCase } from './packages';

export function manifestFor(c: CompatCase): Manifest {
  return {
    entry: 'src/main.tsx',
    dependencies: {
      react: REACT_VERSION,
      'react-dom': REACT_VERSION,
      [c.name]: c.version,
      ...(c.deps ?? {}),
    },
  };
}

/** Bare imports of a smoke app, in source order (relative imports left out). */
export function importsOf(source: string): string[] {
  const out = new Set<string>();
  for (const m of source.matchAll(
    /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]/g,
  )) {
    const spec = m[1] ?? m[2];
    if (spec && !spec.startsWith('.') && !spec.startsWith('/')) out.add(spec);
  }
  const pragma = /@jsxImportSource\s+(\S+)/.exec(source);
  if (pragma?.[1]) out.add(`${pragma[1]}/jsx-runtime`);
  return [...out];
}

export interface CaseUrl {
  spec: string;
  url: string;
  /** `module`: an ES module the shell imports; `css`: package CSS the bundler fetches. */
  kind: 'module' | 'css';
}

/**
 * The CDN URLs of a case's own imports (React entry points stay with the import map), or the
 * runtime's error for an import it refuses.
 */
export function caseUrls(
  c: CompatCase,
  cdnBaseUrl: string,
): { urls: CaseUrl[]; error: string | null } {
  const deps = manifestFor(c).dependencies;
  const urls: CaseUrl[] = [];
  for (const spec of importsOf(c.app)) {
    const r = resolveBareImport(spec, deps, cdnBaseUrl);
    if (r.kind === 'import-map') continue;
    if (r.kind === 'error') {
      return { urls, error: `runtime rejects import "${spec}": ${r.message}` };
    }
    urls.push({ spec, url: r.url, kind: r.kind === 'cdn-css' ? 'css' : 'module' });
  }
  return { urls, error: null };
}

/** The import map every case runs with (React at the suite's version). */
export function reactImportMap(cdnBaseUrl: string): ImportMap {
  return buildImportMap({ react: REACT_VERSION, 'react-dom': REACT_VERSION }, cdnBaseUrl);
}

/** A URL without the CDN base, for reports (`/zustand@5.0.15?external=…`). */
export function shortUrl(url: string, cdnBaseUrl: string): string {
  return url.startsWith(cdnBaseUrl) ? url.slice(cdnBaseUrl.length) || '/' : url;
}
