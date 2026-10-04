/**
 * Disk store of extracted packages: `<cacheDir>/store/<name>/<version>/`, one directory per
 * exact version, shared by every dependency tree. A package directory only appears once its
 * tarball was downloaded, verified and fully extracted (atomic rename), so its existence
 * means "complete".
 *
 * A tarball is streamed to `<cacheDir>/tmp/` while it is hashed (registry limiter), verified,
 * then extracted from that file as a stream (extraction limiter): memory use per package is
 * a few buffers, whatever its size.
 */
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { storeKey, type CacheIndex } from './disk-cache';
import { CdnError } from './errors';
import { checkDigest, integrityAlgorithm } from './integrity';
import { SingleFlight, type Limiter } from './limiter';
import { encodeNameForPath } from './names';
import type { Denylist, Limits } from './policy';
import type { PackumentVersion, RegistryClient } from './registry';
import { extractTarball } from './tar';

export interface PackageStoreOptions {
  cacheDir: string;
  registry: RegistryClient;
  limits: Limits;
  denylist: Denylist;
  allowSha1Fallback: boolean;
  /** Global limit on concurrent extractions. */
  extractions: Limiter;
  index: CacheIndex;
}

export class PackageStore {
  readonly root: string;
  private readonly tmpDir: string;
  private readonly opts: PackageStoreOptions;
  private readonly flights = new SingleFlight<string>();
  readonly stats = { extracted: 0, extractedBytes: 0 };

  constructor(opts: PackageStoreOptions) {
    this.opts = opts;
    this.root = path.resolve(opts.cacheDir, 'store');
    this.tmpDir = path.resolve(opts.cacheDir, 'tmp');
  }

  /** Directory of an exact package version in the store (it may not exist yet). */
  dirFor(name: string, version: string): string {
    return path.join(this.root, encodeNameForPath(name), version);
  }

  keyFor(name: string, version: string): string {
    return storeKey(name, version);
  }

  get inflight(): number {
    return this.flights.size;
  }

  /**
   * Downloads, verifies and extracts the package if needed. Returns its directory. The caller
   * must hold a lease on `keyFor(meta.name, meta.version)` while it uses the directory.
   */
  async ensure(meta: PackumentVersion, via?: string, signal?: AbortSignal): Promise<string> {
    this.opts.denylist.assertAllowed(meta.name, meta.version, via);
    const key = this.keyFor(meta.name, meta.version);
    const dir = this.dirFor(meta.name, meta.version);
    await this.opts.index.settled(key);
    if (existsSync(dir)) {
      this.opts.index.touch(key);
      return dir;
    }
    return this.flights.run(key, (s) => this.download(meta, dir, key, s), signal);
  }

  private async download(
    meta: PackumentVersion,
    dir: string,
    key: string,
    signal: AbortSignal,
  ): Promise<string> {
    const { limits } = this.opts;
    const label = `${meta.name}@${meta.version}`;
    if (meta.dist.unpackedSize !== undefined && meta.dist.unpackedSize > limits.maxUnpackedBytes) {
      throw new CdnError(
        413,
        'too-large',
        `${label} is ${Math.round(meta.dist.unpackedSize / 1048576).toString()} MB unpacked; the limit is ${Math.round(limits.maxUnpackedBytes / 1048576).toString()} MB`,
      );
    }
    if (meta.dist.fileCount !== undefined && meta.dist.fileCount > limits.maxFilesPerPackage) {
      throw new CdnError(
        413,
        'too-large',
        `${label} has ${meta.dist.fileCount.toString()} files; the limit is ${limits.maxFilesPerPackage.toString()}`,
      );
    }
    const algorithm = integrityAlgorithm(meta.dist, {
      allowSha1Fallback: this.opts.allowSha1Fallback,
    });
    await mkdir(this.tmpDir, { recursive: true });
    const tgz = path.join(
      this.tmpDir,
      `${process.pid.toString()}-${Math.random().toString(36).slice(2)}.tgz`,
    );
    try {
      const { digest } = await this.opts.registry.downloadTarball(meta.dist.tarball, tgz, {
        maxBytes: limits.maxTarballBytes,
        algorithm,
        signal,
      });
      checkDigest(algorithm, digest, meta.dist);
      await mkdir(path.dirname(dir), { recursive: true });
      const result = await this.opts.extractions.run(
        () =>
          extractTarball(
            createReadStream(tgz),
            dir,
            { maxUnpackedBytes: limits.maxUnpackedBytes, maxFiles: limits.maxFilesPerPackage },
            signal,
          ),
        signal,
      );
      this.stats.extracted++;
      this.stats.extractedBytes += result.bytes;
      this.opts.index.record(key, result.diskBytes);
    } finally {
      await rm(tgz, { force: true });
    }
    return dir;
  }
}
