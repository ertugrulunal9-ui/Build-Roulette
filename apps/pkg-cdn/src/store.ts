/**
 * Disk store of extracted packages: `<cacheDir>/store/<name>/<version>/`, one directory per
 * exact version, shared by every dependency tree. A package directory only appears once its
 * tarball was downloaded, verified and fully extracted (atomic rename), so its existence
 * means "complete".
 */
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { CdnError } from './errors';
import { verifyIntegrity } from './integrity';
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
}

export class PackageStore {
  readonly root: string;
  private readonly opts: PackageStoreOptions;
  private readonly inflight = new Map<string, Promise<string>>();
  readonly stats = { extracted: 0 };

  constructor(opts: PackageStoreOptions) {
    this.opts = opts;
    this.root = path.resolve(opts.cacheDir, 'store');
  }

  /** Directory of an exact package version in the store (it may not exist yet). */
  dirFor(name: string, version: string): string {
    return path.join(this.root, encodeNameForPath(name), version);
  }

  /** Downloads, verifies and extracts the package if needed. Returns its directory. */
  ensure(meta: PackumentVersion, via?: string): Promise<string> {
    this.opts.denylist.assertAllowed(meta.name, meta.version, via);
    const dir = this.dirFor(meta.name, meta.version);
    if (existsSync(dir)) return Promise.resolve(dir);
    const key = `${meta.name}@${meta.version}`;
    let job = this.inflight.get(key);
    if (!job) {
      job = this.download(meta, dir).finally(() => this.inflight.delete(key));
      this.inflight.set(key, job);
    }
    return job;
  }

  private async download(meta: PackumentVersion, dir: string): Promise<string> {
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
    const tgz = await this.opts.registry.fetchTarball(meta.dist.tarball, limits.maxTarballBytes);
    verifyIntegrity(tgz, meta.dist, { allowSha1Fallback: this.opts.allowSha1Fallback });
    await mkdir(path.dirname(dir), { recursive: true });
    await extractTarball(tgz, dir, {
      maxUnpackedBytes: limits.maxUnpackedBytes,
      maxFiles: limits.maxFilesPerPackage,
    });
    this.stats.extracted++;
    return dir;
  }
}
