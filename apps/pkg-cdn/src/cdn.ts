/**
 * The package CDN core, independent of HTTP: version resolution, raw files and bundles.
 */
import { existsSync } from 'node:fs';
import { mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { bundlePackage, PROCESS_SHIM, type BuildRequest } from './bundler';
import { BundleCache, cacheKey, cacheKeyString, type BundleMeta } from './cache';
import type { CdnConfig } from './config';
import { CdnError } from './errors';
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

class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
}

export interface PackageCdnOptions {
  fetch?: FetchLike;
  denylist?: Denylist;
}

export class PackageCdn {
  readonly config: CdnConfig;
  readonly registry: RegistryClient;
  readonly denylist: Denylist;
  readonly store: PackageStore;
  readonly trees: TreeManager;
  readonly bundles: BundleCache;
  readonly shimDir: string;
  private readonly inflight = new Map<string, Promise<BundleResponse>>();
  private readonly builds: Semaphore;
  readonly stats = { bundlesBuilt: 0, bundleHits: 0, bundleErrors: 0 };

  constructor(config: CdnConfig, opts: PackageCdnOptions = {}) {
    this.config = config;
    this.registry = new RegistryClient({
      registryUrl: config.registryUrl,
      packumentTtlMs: config.packumentTtlMs,
      fetchTimeoutMs: config.limits.fetchTimeoutMs,
      maxPackumentBytes: config.limits.maxPackumentBytes,
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
    });
    this.trees = new TreeManager({
      cacheDir: config.cacheDir,
      registry: this.registry,
      store: this.store,
      limits: config.limits,
      denylist: this.denylist,
    });
    this.bundles = new BundleCache(config.cacheDir);
    this.shimDir = path.join(config.cacheDir, 'shims');
    this.builds = new Semaphore(config.maxConcurrentBuilds);
  }

  async init(): Promise<void> {
    await mkdir(this.shimDir, { recursive: true });
    await writeFile(path.join(this.shimDir, 'process.js'), PROCESS_SHIM);
  }

  /** Resolves the version part of a URL to an exact, existing, allowed version. */
  async resolve(ref: PackageRef): Promise<ResolvedVersion> {
    const deniedAll = this.denylist.deniesAllVersions(ref.name);
    if (deniedAll !== null) {
      throw new CdnError(403, 'denied', `${ref.name} is denied by policy: ${deniedAll}`);
    }
    const pack = await this.registry.getPackument(ref.name);
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
  ): Promise<string> {
    const pinned = pins[name];
    if (pinned !== undefined) return pinned;
    const pack = await this.registry.getPackument(name);
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

  /** A raw file from the package (CSS, fonts, images...). Returns its absolute path. */
  async rawFile(meta: PackumentVersion, subpath: string): Promise<string> {
    const dir = await realpath(await this.store.ensure(meta));
    const notFound = new CdnError(
      404,
      'not-found',
      `${meta.name}@${meta.version}${subpath} does not exist`,
    );
    const candidate = path.join(dir, ...subpath.split('/').filter(Boolean));
    if (!existsSync(candidate)) throw notFound;
    const real = await realpath(candidate);
    if (!real.startsWith(dir + path.sep)) throw notFound;
    const st = await stat(real);
    if (!st.isFile()) throw notFound;
    return real;
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

  /** Bundles (or returns the cached bundle of) a package entry. */
  bundle(req: BuildRequest, meta: PackumentVersion): Promise<BundleResponse> {
    const key = cacheKey(req);
    let job = this.inflight.get(key);
    if (!job) {
      job = this.bundleUncached(key, req, meta).finally(() => this.inflight.delete(key));
      this.inflight.set(key, job);
    }
    return job;
  }

  private async bundleUncached(
    key: string,
    req: BuildRequest,
    meta: PackumentVersion,
  ): Promise<BundleResponse> {
    const cached = await this.bundles.get(key);
    if (cached) {
      // Denylist changes apply to cached bundles too: re-check every bundled package.
      this.assertAllowed(cached.meta.packages, req);
      this.stats.bundleHits++;
      return { code: cached.code, cache: 'hit', meta: cached.meta };
    }
    const started = performance.now();
    try {
      const tree = await this.trees.ensure(meta);
      const packages = tree.tree.nodes.map((n) => `${n.realName}@${n.version}`).sort();
      this.assertAllowed(packages, req);
      const out = await this.builds.run(() =>
        bundlePackage(req, {
          tree,
          shimDir: this.shimDir,
          resolvePeerVersion: (name, range) => this.resolvePeerVersion(name, range, req.deps),
          maxOutputBytes: this.config.limits.maxOutputBytes,
          timeoutMs: this.config.limits.bundleTimeoutMs,
        }),
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
    }
  }
}
