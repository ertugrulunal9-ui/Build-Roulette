/**
 * Disk cache of bundled modules, keyed by everything that changes the output:
 * (name, exact version, subpath, external set, deps pins, build target, dev flag, build format).
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BUILD_FORMAT, type BuildRequest } from './bundler';
import { bundleKey, type CacheIndex } from './disk-cache';
import { diskSize } from './tar';

/** Canonical cache key string (external and deps sorted, so order in the URL does not matter). */
export function cacheKeyString(req: BuildRequest): string {
  const deps = Object.entries(req.deps)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([n, v]) => `${n}@${v}`);
  return JSON.stringify([
    BUILD_FORMAT,
    req.name,
    req.version,
    req.subpath,
    [...new Set(req.external)].sort(),
    deps,
    req.target,
    req.dev ? 'dev' : 'prod',
  ]);
}

export function cacheKey(req: BuildRequest): string {
  return createHash('sha256').update(cacheKeyString(req)).digest('hex');
}

export interface CachedBundle {
  code: string;
  meta: BundleMeta;
}

export interface BundleMeta {
  key: string;
  request: string;
  format: string;
  buildMs: number;
  warnings: string[];
  stubbedBuiltins: string[];
  externalUrls: string[];
  /** Every `name@version` in the dependency tree (re-checked against the denylist on hits). */
  packages: string[];
  createdAt: string;
}

export class BundleCache {
  readonly root: string;
  private readonly index: CacheIndex;

  constructor(cacheDir: string, index: CacheIndex) {
    this.root = path.resolve(cacheDir, 'bundles');
    this.index = index;
  }

  private paths(key: string): { js: string; meta: string } {
    const dir = path.join(this.root, key.slice(0, 2));
    return { js: path.join(dir, `${key}.js`), meta: path.join(dir, `${key}.json`) };
  }

  async get(key: string): Promise<CachedBundle | null> {
    const p = this.paths(key);
    // The meta file is written last (and evicted first), so its presence means the entry is
    // complete. An entry evicted while being read fails to read and counts as a miss.
    if (!existsSync(p.meta)) return null;
    try {
      const [code, meta] = await Promise.all([readFile(p.js, 'utf8'), readFile(p.meta, 'utf8')]);
      this.index.touch(bundleKey(key));
      return { code, meta: JSON.parse(meta) as BundleMeta };
    } catch {
      return null;
    }
  }

  async put(key: string, code: string, meta: BundleMeta): Promise<void> {
    const p = this.paths(key);
    await mkdir(path.dirname(p.js), { recursive: true });
    const suffix = `.tmp-${process.pid.toString()}-${Math.random().toString(36).slice(2)}`;
    const metaJson = JSON.stringify(meta);
    await writeFile(p.js + suffix, code);
    await rename(p.js + suffix, p.js);
    await writeFile(p.meta + suffix, metaJson);
    await rename(p.meta + suffix, p.meta);
    this.index.record(
      bundleKey(key),
      diskSize(Buffer.byteLength(code)) + diskSize(Buffer.byteLength(metaJson)),
    );
  }
}
