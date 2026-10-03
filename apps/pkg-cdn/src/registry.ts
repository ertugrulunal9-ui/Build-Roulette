/**
 * npm registry client: abbreviated packuments (cached in memory with a short TTL) and
 * tarballs (size-limited, only from the registry's own origin).
 */
import semver from 'semver';
import { CdnError, errorMessage } from './errors';
import { registryPathFor, validatePackageName } from './names';

export interface PackumentVersion {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  os?: string[];
  cpu?: string[];
  deprecated?: string;
  hasInstallScript?: boolean;
  dist: {
    tarball: string;
    integrity?: string;
    shasum?: string;
    unpackedSize?: number;
    fileCount?: number;
  };
}

export interface Packument {
  name: string;
  'dist-tags': Record<string, string>;
  versions: Record<string, PackumentVersion>;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface RegistryOptions {
  /** Default https://registry.npmjs.org */
  registryUrl: string;
  packumentTtlMs: number;
  fetchTimeoutMs: number;
  maxPackumentBytes: number;
  /** Max packuments kept in memory. Default 2000. */
  maxCachedPackuments?: number;
  fetch?: FetchLike;
}

interface CacheEntry {
  at: number;
  value: Promise<Packument>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stringRecord(v: unknown): Record<string, string> | undefined {
  if (!isRecord(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) if (typeof val === 'string') out[k] = val;
  return out;
}

/** Keeps only the fields we use and checks their types (the registry is trusted, not blindly). */
export function sanitizePackument(name: string, raw: unknown): Packument {
  if (!isRecord(raw) || !isRecord(raw['versions'])) {
    throw new CdnError(502, 'registry-error', `registry returned an invalid packument for ${name}`);
  }
  const versions: Record<string, PackumentVersion> = {};
  for (const [version, v] of Object.entries(raw['versions'])) {
    if (!isRecord(v) || !isRecord(v['dist']) || semver.valid(version) !== version) continue;
    const dist = v['dist'];
    if (typeof dist['tarball'] !== 'string') continue;
    const meta: PackumentVersion = {
      name,
      version,
      dist: { tarball: dist['tarball'] },
    };
    if (typeof dist['integrity'] === 'string') meta.dist.integrity = dist['integrity'];
    if (typeof dist['shasum'] === 'string') meta.dist.shasum = dist['shasum'];
    if (typeof dist['unpackedSize'] === 'number') meta.dist.unpackedSize = dist['unpackedSize'];
    if (typeof dist['fileCount'] === 'number') meta.dist.fileCount = dist['fileCount'];
    const deps = stringRecord(v['dependencies']);
    if (deps) meta.dependencies = deps;
    const optional = stringRecord(v['optionalDependencies']);
    if (optional) meta.optionalDependencies = optional;
    const peers = stringRecord(v['peerDependencies']);
    if (peers) meta.peerDependencies = peers;
    if (isRecord(v['peerDependenciesMeta'])) {
      const pm: Record<string, { optional?: boolean }> = {};
      for (const [k, val] of Object.entries(v['peerDependenciesMeta'])) {
        if (isRecord(val) && val['optional'] === true) pm[k] = { optional: true };
      }
      meta.peerDependenciesMeta = pm;
    }
    if (Array.isArray(v['os'])) meta.os = v['os'].filter((x): x is string => typeof x === 'string');
    if (Array.isArray(v['cpu']))
      meta.cpu = v['cpu'].filter((x): x is string => typeof x === 'string');
    if (typeof v['deprecated'] === 'string') meta.deprecated = v['deprecated'];
    if (v['hasInstallScript'] === true) meta.hasInstallScript = true;
    versions[version] = meta;
  }
  const tags = stringRecord(raw['dist-tags']) ?? {};
  return { name, 'dist-tags': tags, versions };
}

/**
 * Picks the version npm would install for `range` (a semver range or a dist-tag): the
 * `latest` tag when it satisfies the range, otherwise the highest satisfying version.
 */
export function pickVersion(pack: Packument, range: string): string | null {
  const tagged = pack['dist-tags'][range];
  if (tagged !== undefined && pack.versions[tagged]) return tagged;
  if (semver.validRange(range) === null) return null;
  const latest = pack['dist-tags']['latest'];
  if (latest !== undefined && pack.versions[latest] && semver.satisfies(latest, range)) {
    return latest;
  }
  return semver.maxSatisfying(Object.keys(pack.versions), range);
}

async function readLimited(res: Response, maxBytes: number, what: string): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new CdnError(
      413,
      'too-large',
      `${what} is larger than ${Math.round(maxBytes / 1048576)} MB`,
    );
  }
  if (!res.body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new CdnError(
        413,
        'too-large',
        `${what} is larger than ${Math.round(maxBytes / 1048576)} MB`,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export class RegistryClient {
  readonly registryUrl: string;
  private readonly origin: string;
  private readonly opts: RegistryOptions;
  private readonly fetchImpl: FetchLike;
  private readonly cache = new Map<string, CacheEntry>();
  readonly stats = { packumentFetches: 0, tarballFetches: 0, tarballBytes: 0 };

  constructor(opts: RegistryOptions) {
    this.opts = opts;
    this.registryUrl = opts.registryUrl.replace(/\/+$/, '');
    this.origin = new URL(this.registryUrl).origin;
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
  }

  /** Abbreviated packument. Unknown package -> CdnError(404). */
  getPackument(name: string): Promise<Packument> {
    const err = validatePackageName(name, { legacy: true });
    if (err !== null) {
      return Promise.reject(new CdnError(400, 'invalid-name', `invalid package name: ${err}`));
    }
    const now = Date.now();
    const hit = this.cache.get(name);
    if (hit && now - hit.at < this.opts.packumentTtlMs) return hit.value;
    const value = this.fetchPackument(name);
    this.cache.delete(name);
    this.cache.set(name, { at: now, value });
    value.catch(() => {
      if (this.cache.get(name)?.value === value) this.cache.delete(name);
    });
    const max = this.opts.maxCachedPackuments ?? 2000;
    while (this.cache.size > max) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return value;
  }

  private async fetchPackument(name: string): Promise<Packument> {
    const url = `${this.registryUrl}/${registryPathFor(name)}`;
    this.stats.packumentFetches++;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { accept: 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8' },
        signal: AbortSignal.timeout(this.opts.fetchTimeoutMs),
        redirect: 'error',
      });
    } catch (e) {
      throw new CdnError(
        502,
        'registry-error',
        `registry request for ${name} failed: ${errorMessage(e)}`,
      );
    }
    if (res.status === 404) {
      throw new CdnError(
        404,
        'unknown-package',
        `package "${name}" does not exist on the registry`,
      );
    }
    if (!res.ok) {
      throw new CdnError(
        502,
        'registry-error',
        `registry answered ${res.status.toString()} for ${name}`,
      );
    }
    const body = await readLimited(res, this.opts.maxPackumentBytes, `packument of ${name}`);
    let json: unknown;
    try {
      json = JSON.parse(body.toString('utf8'));
    } catch {
      throw new CdnError(502, 'registry-error', `registry returned invalid JSON for ${name}`);
    }
    return sanitizePackument(name, json);
  }

  /** Downloads a tarball. Only URLs on the registry's own origin are fetched (no SSRF). */
  async fetchTarball(tarballUrl: string, maxBytes: number): Promise<Buffer> {
    let url: URL;
    try {
      url = new URL(tarballUrl);
    } catch {
      throw new CdnError(502, 'registry-error', `invalid tarball URL ${tarballUrl}`);
    }
    if (url.origin !== this.origin) {
      throw new CdnError(
        502,
        'registry-error',
        `tarball URL is not on the registry origin (${url.origin})`,
      );
    }
    this.stats.tarballFetches++;
    let res: Response;
    try {
      res = await this.fetchImpl(url.href, {
        signal: AbortSignal.timeout(this.opts.fetchTimeoutMs),
        redirect: 'error',
      });
    } catch (e) {
      throw new CdnError(502, 'registry-error', `tarball download failed: ${errorMessage(e)}`);
    }
    if (!res.ok) {
      throw new CdnError(
        502,
        'registry-error',
        `tarball download answered ${res.status.toString()}`,
      );
    }
    const buf = await readLimited(res, maxBytes, 'tarball');
    this.stats.tarballBytes += buf.length;
    return buf;
  }
}
