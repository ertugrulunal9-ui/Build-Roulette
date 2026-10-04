/**
 * The package CDN core, independent of HTTP: version resolution, raw files and bundles.
 *
 * Every entry point takes the request's AbortSignal. Work is shared between concurrent
 * requests (bundles, trees, packages, packuments) and bounded globally (registry requests,
 * extractions, builds), see ./limiter.ts; the disk cache has a quota, see ./disk-cache.ts.
 */
import { existsSync } from 'node:fs';
import { mkdir, open, realpath, writeFile, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { bundlePackage, PROCESS_SHIM, type BuildRequest } from './bundler';
import { BundleCache, cacheKey, cacheKeyString, type BundleMeta } from './cache';
import type { CdnConfig } from './config';
import { CacheIndex } from './disk-cache';
import { CdnError } from './errors';
import { Limiter, SingleFlight } from './limiter';
import { Denylist } from './policy';
import { pickVersion, RegistryClient, type FetchLike, type PackumentVersion } from './registry';
import { PackageStore } from './store';
import { TreeManager } from './tree';
import type { PackageRef } from './url';

/** Subpath extensions served as files instead of bundled modules. */
export const RAW_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

/** Content type when `subpath` is served raw, or null when it is bundled as a module. */
export function rawContentType(subpath: string, asModule: boolean): string | null {
  const ext = path.extname(subpath).toLowerCase();
  if (ext === '.json' && asModule) return null;
  return RAW_TYPES[ext] ?? null;
}

export interface ResolvedVersion {
  name: string;
  version: string;
  /** True when the URL already named this exact version. */
  exact: boolean;
  meta: PackumentVersion;
}

export interface BundleResponse {
  code: string;
  cache: 'hit' | 'miss';
  meta: BundleMeta;
}

/** An open raw file. The caller closes it. */
export interface RawFile {
  handle: FileHandle;
  size: number;
}

export interface PackageCdnOptions {
  fetch?: FetchLike;
  denylist?: Denylist;
  log?: (line: string) => void;
}

export class PackageCdn {
  readonly config: CdnConfig;
  readonly registry: RegistryClient;
  readonly denylist: Denylist;
  readonly store: PackageStore;
  readonly trees: TreeManager;
  readonly bundles: BundleCache;
  readonly index: CacheIndex;
  readonly shimDir: string;
  readonly limiters: { fetches: Limiter; extractions: Limiter; builds: Limiter };
  private readonly flights = new SingleFlight<BundleResponse>();
  readonly stats = { bundlesBuilt: 0, bundleHits: 0, bundleErrors: 0 };

  constructor(config: CdnConfig, opts: PackageCdnOptions = {}) {
    this.config = config;
    const limiter = (name: string, l: CdnConfig['fetches']) =>
      new Limiter(name, l.concurrent, l.queue, config.retryAfterSeconds);
    this.limiters = {
      fetches: limiter('registry', config.fetches),
      extractions: limiter('extraction', config.extractions),
      builds: limiter('build', config.builds),
    };
    this.index = new CacheIndex({
      root: config.cacheDir,
      quotaBytes: config.cacheQuotaBytes,
      ...(opts.log ? { log: opts.log } : {}),
    });
    this.registry = new RegistryClient({
      registryUrl: config.registryUrl,
      packumentTtlMs: config.packumentTtlMs,
      fetchTimeoutMs: config.limits.fetchTimeoutMs,
      maxPackumentBytes: config.limits.maxPackumentBytes,
      maxCachedPackumentBytes: config.packumentCacheBytes,
      limiter: this.limiters.fetches,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
    this.denylist =
      opts.denylist ??
      (config.denylistFile ? Denylist.fromFile(config.denylistFile) : new Denylist());
    this.store = new PackageStore({
      cacheDir: config.cacheDir,
      registry: this.registry,
      limits: config.limits,
      denylist: this.denylist,
      allowSha1Fallback: config.allowSha1Fallback,
      extractions: this.limiters.extractions,
      index: this.index,
    });
    this.trees = new TreeManager({
      cacheDir: config.cacheDir,
      registry: this.registry,
      store: this.store,
      limits: config.limits,
      denylist: this.denylist,
      index: this.index,
    });
    this.bundles = new BundleCache(config.cacheDir, this.index);
    this.shimDir = path.join(config.cacheDir, 'shims');
  }

  async init(): Promise<void> {
    await mkdir(this.shimDir, { recursive: true });
    await writeFile(path.join(this.shimDir, 'process.js'), PROCESS_SHIM);
    await this.index.init();
  }

  /** Persists the cache index (call on shutdown). */
  async close(): Promise<void> {
    await this.index.close();
  }

  /** Resolves the version part of a URL to an exact, existing, allowed version. */
  async resolve(ref: PackageRef, signal?: AbortSignal): Promise<ResolvedVersion> {
    const deniedAll = this.denylist.deniesAllVersions(ref.name);
    if (deniedAll !== null) {
      throw new CdnError(403, 'denied', `${ref.name} is denied by policy: ${deniedAll}`);
    }
    const pack = await this.registry.getPackument(ref.name, signal);
    let version: string | null;
    switch (ref.version.kind) {
      case 'exact':
        version = pack.versions[ref.version.version] ? ref.version.version : null;
        break;
      case 'range':
        version = pickVersion(pack, ref.version.range);
        break;
      case 'tag':
        version = pack['dist-tags'][ref.version.tag] ?? null;
        break;
    }
    const meta = version === null ? undefined : pack.versions[version];
    if (version === null || !meta) {
      const latest = pack['dist-tags']['latest'];
      throw new CdnError(
        404,
        'unknown-version',
        `${ref.name} has no version matching "${ref.versionText || 'latest'}"${latest ? ` (latest is ${latest})` : ''}`,
      );
    }
    this.denylist.assertAllowed(ref.name, version);
    return { name: ref.name, version, exact: ref.version.kind === 'exact', meta };
  }

  /** Version used for a peer dependency that is emitted as a CDN URL. */
  async resolvePeerVersion(
    name: string,
    range: string,
    pins: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<string> {
    const pinned = pins[name];
    if (pinned !== undefined) return pinned;
    const pack = await this.registry.getPackument(name, signal);
    const version = pickVersion(pack, range);
    if (version === null) {
      throw new CdnError(
        422,
        'build-failed',
        `peer dependency ${name}@"${range}" has no matching version on the registry`,
      );
    }
    return version;
  }

  /**
   * A raw file from the package (CSS, fonts, images...), opened. The store entry is leased
   * until the file is open; an open file stays readable even if the entry is evicted later.
   */
  async rawFile(meta: PackumentVersion, subpath: string, signal?: AbortSignal): Promise<RawFile> {
    const release = this.index.lease(this.store.keyFor(meta.name, meta.version));
    try {
      const dir = await realpath(await this.store.ensure(meta, undefined, signal));
      const notFound = new CdnError(
        404,
        'not-found',
        `${meta.name}@${meta.version}${subpath} does not exist`,
      );
      const candidate = path.join(dir, ...subpath.split('/').filter(Boolean));
      if (!existsSync(candidate)) throw notFound;
      const real = await realpath(candidate);
      if (!real.startsWith(dir + path.sep)) throw notFound;
      const handle = await open(real, 'r');
      const st = await handle.stat();
      if (!st.isFile()) {
        await handle.close();
        throw notFound;
      }
      return { handle, size: st.size };
    } finally {
      release();
    }
  }

  /** Throws CdnError(403) when any `name@version` in a bundle's tree is denied. */
  private assertAllowed(packages: readonly string[], req: BuildRequest): void {
    const via = `${req.name}@${req.version}`;
    for (const p of packages) {
      const at = p.lastIndexOf('@');
      const name = p.slice(0, at);
      const version = p.slice(at + 1);
      if (name === req.name && version === req.version) continue; // checked in resolve()
      this.denylist.assertAllowed(name, version, via);
    }
  }

  /**
   * Bundles (or returns the cached bundle of) a package entry. Concurrent requests for the
   * same bundle share one build; it is cancelled only when all of them have gone away.
   */
  bundle(req: BuildRequest, meta: PackumentVersion, signal?: AbortSignal): Promise<BundleResponse> {
    const key = cacheKey(req);
    return this.flights.run(key, (s) => this.bundleUncached(key, req, meta, s), signal);
  }

  private async bundleUncached(
    key: string,
    req: BuildRequest,
    meta: PackumentVersion,
    signal: AbortSignal,
  ): Promise<BundleResponse> {
    const cached = await this.bundles.get(key);
    if (cached) {
      // Denylist changes apply to cached bundles too: re-check every bundled package.
      this.assertAllowed(cached.meta.packages, req);
      this.stats.bundleHits++;
      return { code: cached.code, cache: 'hit', meta: cached.meta };
    }
    const started = performance.now();
    // The tree must not be evicted while esbuild reads it.
    const release = this.index.lease(this.trees.keyFor(meta.name, meta.version));
    try {
      const tree = await this.trees.ensure(meta, signal);
      const packages = tree.tree.nodes.map((n) => `${n.realName}@${n.version}`).sort();
      this.assertAllowed(packages, req);
      const out = await this.limiters.builds.run(
        () =>
          bundlePackage(req, {
            tree,
            shimDir: this.shimDir,
            resolvePeerVersion: (name, range) =>
              this.resolvePeerVersion(name, range, req.deps, signal),
            maxOutputBytes: this.config.limits.maxOutputBytes,
            timeoutMs: this.config.limits.bundleTimeoutMs,
            signal,
          }),
        signal,
      );
      const bundleMeta: BundleMeta = {
        key: cacheKeyString(req),
        request: `${req.name}@${req.version}${req.subpath}`,
        format: out.format,
        buildMs: Math.round(performance.now() - started),
        warnings: out.warnings.slice(0, 20),
        stubbedBuiltins: out.stubbedBuiltins,
        externalUrls: out.externalUrls,
        packages,
        createdAt: new Date().toISOString(),
      };
      await this.bundles.put(key, out.code, bundleMeta);
      this.stats.bundlesBuilt++;
      return { code: out.code, cache: 'miss', meta: bundleMeta };
    } catch (e) {
      this.stats.bundleErrors++;
      throw e;
    } finally {
      release();
    }
  }

  /** Queue depths, in-flight work, cache usage and evictions (no secrets, no paths). */
  metrics() {
    return {
      queues: {
        registry: this.limiters.fetches.stats(),
        extraction: this.limiters.extractions.stats(),
        build: this.limiters.builds.stats(),
      },
      inflight: {
        bundles: this.flights.size,
        trees: this.trees.inflight,
        packages: this.store.inflight,
        packuments: this.registry.cacheStats().inflight,
      },
      cache: this.index.stats(),
      packuments: this.registry.cacheStats(),
      registry: this.registry.stats,
      store: this.store.stats,
      trees: this.trees.stats,
      bundles: { ...this.stats, ...this.flights.stats() },
    };
  }
}
