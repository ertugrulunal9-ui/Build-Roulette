/**
 * Package policy: a denylist (config file) and resource limits.
 *
 * Denylist file format (JSON):
 *
 *   { "packages": [
 *       { "name": "flatmap-stream", "reason": "malware (event-stream incident)" },
 *       { "name": "ua-parser-js", "versions": "0.7.29 || 0.8.0 || 1.0.0", "reason": "hijacked releases" }
 *   ] }
 *
 * `versions` is a semver range; without it every version is denied. A denied package is
 * refused as the requested package and anywhere in its dependency tree.
 */
import { readFileSync } from 'node:fs';
import semver from 'semver';
import { CdnError } from './errors';
import { validatePackageName } from './names';

export interface DenyRule {
  name: string;
  /** Semver range of denied versions. Undefined means every version. */
  versions?: string;
  reason: string;
}

export interface Limits {
  /** Compressed tarball size. */
  maxTarballBytes: number;
  /** Decompressed size of one package. */
  maxUnpackedBytes: number;
  /** Files in one package. */
  maxFilesPerPackage: number;
  /** Packages in one dependency tree, including the requested one. */
  maxDependencies: number;
  /** Size of one bundled ES module. */
  maxOutputBytes: number;
  /** Wall-clock limit for one esbuild bundle. */
  bundleTimeoutMs: number;
  /** Timeout for one registry request (packument or tarball). */
  fetchTimeoutMs: number;
  /** Size of one packument response. */
  maxPackumentBytes: number;
}

/**
 * Defaults sized from the R1 compat suite's real dependency trees (279 packages, measured
 * 2026-10-03; see the README): largest tarball react-icons 21.7 MB, largest unpacked phaser
 * 107 MB, most files react-aria 7243, largest abbreviated packument react-aria 3.6 MB.
 * Tarballs are streamed to disk and extracted as a stream, so these bound disk and time, not
 * memory; the packument limit bounds memory (a packument is parsed as one JSON document).
 */
export const DEFAULT_LIMITS: Limits = {
  maxTarballBytes: 32 * 1024 * 1024,
  maxUnpackedBytes: 160 * 1024 * 1024,
  maxFilesPerPackage: 30_000,
  maxDependencies: 250,
  maxOutputBytes: 12 * 1024 * 1024,
  bundleTimeoutMs: 60_000,
  fetchTimeoutMs: 60_000,
  maxPackumentBytes: 16 * 1024 * 1024,
};

export class Denylist {
  private readonly rules = new Map<string, DenyRule[]>();

  constructor(rules: readonly DenyRule[] = []) {
    for (const rule of rules) {
      const err = validatePackageName(rule.name, { legacy: true });
      if (err !== null) throw new Error(`denylist: invalid name "${rule.name}": ${err}`);
      if (rule.versions !== undefined && semver.validRange(rule.versions) === null) {
        throw new Error(`denylist: invalid range "${rule.versions}" for ${rule.name}`);
      }
      const list = this.rules.get(rule.name) ?? [];
      list.push(rule);
      this.rules.set(rule.name, list);
    }
  }

  static fromJson(text: string): Denylist {
    const parsed = JSON.parse(text) as unknown;
    const packages = (parsed as { packages?: unknown }).packages;
    if (!Array.isArray(packages)) throw new Error('denylist: expected { "packages": [...] }');
    const rules = packages.map((p: unknown, i): DenyRule => {
      const r = p as Partial<DenyRule>;
      if (typeof r.name !== 'string' || typeof r.reason !== 'string') {
        throw new Error(`denylist: entry ${i.toString()} needs "name" and "reason"`);
      }
      if (r.versions !== undefined && typeof r.versions !== 'string') {
        throw new Error(`denylist: entry ${i.toString()} "versions" must be a string`);
      }
      return r.versions === undefined
        ? { name: r.name, reason: r.reason }
        : { name: r.name, versions: r.versions, reason: r.reason };
    });
    return new Denylist(rules);
  }

  static fromFile(file: string): Denylist {
    return Denylist.fromJson(readFileSync(file, 'utf8'));
  }

  /** Reason when every version of `name` is denied (checked before any registry request). */
  deniesAllVersions(name: string): string | null {
    return this.rules.get(name)?.find((r) => r.versions === undefined)?.reason ?? null;
  }

  /** Reason when `name@version` is denied, else null. */
  check(name: string, version: string): string | null {
    for (const rule of this.rules.get(name) ?? []) {
      if (rule.versions === undefined) return rule.reason;
      if (semver.satisfies(version, rule.versions, { includePrerelease: true })) return rule.reason;
    }
    return null;
  }

  /** Throws CdnError(403) when denied. `via` names the package that depends on it. */
  assertAllowed(name: string, version: string, via?: string): void {
    const reason = this.check(name, version);
    if (reason === null) return;
    const where = via ? ` (dependency of ${via})` : '';
    throw new CdnError(403, 'denied', `${name}@${version}${where} is denied by policy: ${reason}`);
  }

  get size(): number {
    return this.rules.size;
  }
}
