/**
 * esbuild plugins for the in-browser bundler (docs/03 §3.4): vfs, cdn-rewrite, css, assets.
 * They only use the esbuild plugin API, so they run unchanged in esbuild-wasm (browser
 * worker) and in esbuild/esbuild-wasm under Node (tests).
 */
import type { Loader, Plugin } from 'esbuild-wasm';
import type { FileMap } from '../types';
import {
  MAX_ASSET_BYTES,
  cdnDepsPins,
  decodeAsset,
  isRelativeOrAbsolute,
  loaderForPath,
  normalizePath,
  resolveBareImport,
  resolveWorkspaceImport,
} from './resolve';

export const VFS_NAMESPACE = 'vfs';
export const CDN_CSS_NAMESPACE = 'cdn-css';

export type FetchText = (url: string) => Promise<string>;

/**
 * `vfs`: resolves the entry point and relative / workspace-absolute imports against the
 * in-memory file map, and loads files with a loader chosen by extension (`assets` and local
 * `css` are handled here too, since they are workspace files).
 */
export function vfsPlugin(files: FileMap, entry: string): Plugin {
  return {
    name: 'vfs',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === 'entry-point') {
          const p = resolveWorkspaceImport(files, '', `/${entry}`);
          if (!p) return { errors: [{ text: `Entry file "${entry}" does not exist.` }] };
          return { path: p, namespace: VFS_NAMESPACE };
        }
        if (args.namespace !== VFS_NAMESPACE || !isRelativeOrAbsolute(args.path)) return undefined;
        const p = resolveWorkspaceImport(files, args.importer, args.path);
        if (!p) {
          return {
            errors: [{ text: `Cannot find "${args.path}" imported from "${args.importer}".` }],
          };
        }
        return { path: p, namespace: VFS_NAMESPACE };
      });

      build.onLoad({ filter: /.*/, namespace: VFS_NAMESPACE }, (args) => {
        const path = normalizePath(args.path);
        const contents = files[path];
        if (contents === undefined) return { errors: [{ text: `File "${path}" does not exist.` }] };
        const loader = loaderForPath(path);
        if (loader === null) {
          return { errors: [{ text: `Unsupported file type: "${path}".` }] };
        }
        if (loader === 'asset') return loadAsset(path, contents);
        return { contents, loader: loader as Loader, resolveDir: '/' };
      });
    },
  };
}

/** `assets`: images become data URLs (both for JS imports and CSS `url()`). */
function loadAsset(path: string, contents: string) {
  const bytes = decodeAsset(contents);
  if (!bytes) {
    return {
      errors: [{ text: `Image "${path}" must be stored as a data: URL (or raw SVG markup).` }],
    };
  }
  if (bytes.byteLength > MAX_ASSET_BYTES) {
    return {
      errors: [
        {
          text: `Image "${path}" is ${Math.ceil(bytes.byteLength / 1024)} KB; the limit is ${MAX_ASSET_BYTES / 1024} KB.`,
        },
      ],
    };
  }
  return { contents: bytes, loader: 'dataurl' as const };
}

/**
 * `cdn-rewrite` + package `css`: bare imports become external CDN URLs (React stays bare
 * for the import map) that pin the manifest's versions of peers (`deps=`), package CSS is
 * fetched and inlined, undeclared packages are errors.
 */
export function cdnPlugin(opts: {
  dependencies: Record<string, string>;
  cdnBaseUrl: string;
  fetchText: FetchText;
}): Plugin {
  const deps = cdnDepsPins(opts.dependencies) ?? [];
  return {
    name: 'cdn-rewrite',
    setup(build) {
      // url()/@import inside fetched package CSS resolve against the CSS file's CDN URL.
      build.onResolve({ filter: /.*/, namespace: CDN_CSS_NAMESPACE }, (args) => {
        if (/^(data:|https?:)/.test(args.path)) return { path: args.path, external: true };
        try {
          return { path: new URL(args.path, args.importer).href, external: true };
        } catch {
          return { errors: [{ text: `Cannot resolve "${args.path}" in ${args.importer}.` }] };
        }
      });

      // Full URLs in user code are left alone (the shell CSP decides what may load).
      build.onResolve({ filter: /^https?:\/\// }, (args) => ({ path: args.path, external: true }));

      build.onResolve({ filter: /^[^./]/ }, (args) => {
        if (args.kind === 'entry-point') return undefined; // handled by vfs
        const r = resolveBareImport(args.path, opts.dependencies, opts.cdnBaseUrl, deps);
        switch (r.kind) {
          case 'import-map':
            return { path: args.path, external: true };
          case 'cdn':
            return { path: r.url, external: true };
          case 'cdn-css':
            return { path: r.url, namespace: CDN_CSS_NAMESPACE };
          case 'error':
            return { errors: [{ text: r.message }] };
        }
      });

      build.onLoad({ filter: /.*/, namespace: CDN_CSS_NAMESPACE }, async (args) => {
        try {
          return { contents: await opts.fetchText(args.path), loader: 'css' as const };
        } catch (e) {
          return {
            errors: [
              {
                text: `Failed to fetch package CSS ${args.path}: ${e instanceof Error ? e.message : String(e)}`,
              },
            ],
          };
        }
      });
    },
  };
}
