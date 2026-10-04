/**
 * npm registry client: abbreviated packuments (cached in memory with a short TTL and a byte
 * budget) and tarballs (streamed to disk, size-limited, only from the registry's own origin).
 * Every request goes through one global limiter and honors the caller's AbortSignal.
 */
import { createHash } from 'node:crypto';
import { open, rm, type FileHandle } from 'node:fs/promises';
import semver from 'semver';
import { CdnError, errorMessage } from './errors';
import { abortReason, Limiter, SingleFlight } from './limiter';
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
  /** Max raw packument bytes kept in memory (sum of response sizes). Default unlimited. */
  maxCachedPackumentBytes?: number;
  /** Shared limit on concurrent registry requests. Default 16 active, 2000 queued. */
  limiter?: Limiter;
  fetch?: FetchLike;
}

interface CacheEntry {
  at: number;
  value: Packument;
  /** Response size, for the cache's byte budget. */
  bytes: number;
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

function tooLarge(what: string, maxBytes: number): CdnError {
  return new CdnError(
    413,
    'too-large',
    `${what} is larger than ${Math.round(maxBytes / 1048576).toString()} MB`,
  );
}

/**
 * Streams a response body to `onChunk`, enforcing `maxBytes` while reading (the declared
 * Content-Length is checked first, but a body without one, or a lying one, is cut off as
 * soon as it goes over). Returns the number of bytes read.
 */
async function readBody(
  res: Response,
  maxBytes: number,
  what: string,
  onChunk: (chunk: Uint8Array) => void | Promise<void>,
): Promise<number> {
  const declared = Number(res.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw tooLarge(what, maxBytes);
  }
  if (!res.body) return 0;
  let total = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw tooLarge(what, maxBytes);
      await onChunk(value);
    }
  } catch (e) {
    await reader.cancel().catch(() => undefined);
    throw e;
  }
  return total;
}

/** Combines the caller's signal with a per-request timeout. */
function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Maps a failed registry request: cancellation passes through, the rest becomes a 502. */
function registryFailure(e: unknown, signal: AbortSignal | undefined, what: string): unknown {
  if (signal?.aborted) return abortReason(signal);
  if (e instanceof CdnError) return e;
  const timedOut = (e as { name?: string }).name === 'TimeoutError';
  return new CdnError(
    502,
    'registry-error',
    `${what} ${timedOut ? 'timed out' : `failed: ${errorMessage(e)}`}`,
  );
}

export interface TarballDownload {
  bytes: number;
  /** Digest of the downloaded bytes with the requested algorithm. */
  digest: Buffer;
}

export class RegistryClient {
  readonly registryUrl: string;
  private readonly origin: string;
  private readonly opts: RegistryOptions;
  private readonly fetchImpl: FetchLike;
  /** Settled packuments only (in-flight ones live in `flights`); insertion order = age. */
  private readonly cache = new Map<string, CacheEntry>();
  private cacheBytes = 0;
  private readonly flights = new SingleFlight<Packument>();
  /** Global limit on concurrent registry requests (packuments and tarballs). */
  readonly limiter: Limiter;
  readonly stats = {
    packumentFetches: 0,
    packumentBytes: 0,
    largestPackumentBytes: 0,
    tarballFetches: 0,
    tarballBytes: 0,
    largestTarballBytes: 0,
  };

  constructor(opts: RegistryOptions) {
    this.opts = opts;
    this.registryUrl = opts.registryUrl.replace(/\/+$/, '');
    this.origin = new URL(this.registryUrl).origin;
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.limiter = opts.limiter ?? new Limiter('registry', 16, 2000);
  }

  /**
   * Abbreviated packument. Unknown package -> CdnError(404). Concurrent calls for the same
   * name share one request; only successful results are cached (TTL, LRU, byte budget).
   */
  getPackument(name: string, signal?: AbortSignal): Promise<Packument> {
    const err = validatePackageName(name, { legacy: true });
    if (err !== null) {
      return Promise.reject(new CdnError(400, 'invalid-name', `invalid package name: ${err}`));
    }
    const hit = this.cache.get(name);
    if (hit && Date.now() - hit.at < this.opts.packumentTtlMs) {
      // Refresh its LRU position.
      this.cache.delete(name);
      this.cache.set(name, hit);
      return Promise.resolve(hit.value);
    }
    return this.flights.run(
      name,
      async (jobSignal) => {
        const { pack, bytes } = await this.limiter.run(
          () => this.fetchPackument(name, jobSignal),
          jobSignal,
        );
        this.remember(name, pack, bytes);
        return pack;
      },
      signal,
    );
  }

  private remember(name: string, value: Packument, bytes: number): void {
    const old = this.cache.get(name);
    if (old) {
      this.cacheBytes -= old.bytes;
      this.cache.delete(name);
    }
    this.cache.set(name, { at: Date.now(), value, bytes });
    this.cacheBytes += bytes;
    const maxCount = this.opts.maxCachedPackuments ?? 2000;
    const maxBytes = this.opts.maxCachedPackumentBytes ?? Infinity;
    while (this.cache.size > maxCount || (this.cacheBytes > maxBytes && this.cache.size > 1)) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cacheBytes -= this.cache.get(oldest)?.bytes ?? 0;
      this.cache.delete(oldest);
    }
  }

  /** In-memory packument cache and in-flight requests, for metrics. */
  cacheStats() {
    return { entries: this.cache.size, bytes: this.cacheBytes, ...this.flights.stats() };
  }

  private async fetchPackument(
    name: string,
    signal: AbortSignal,
  ): Promise<{ pack: Packument; bytes: number }> {
    const url = `${this.registryUrl}/${registryPathFor(name)}`;
    this.stats.packumentFetches++;
    const what = `registry request for ${name}`;
    const fetchSignal = withTimeout(signal, this.opts.fetchTimeoutMs);
    let body: Buffer;
    try {
      const res = await this.fetchImpl(url, {
        // The abbreviated ("corgi") document: only what installs need, often 10x smaller.
        headers: { accept: 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8' },
        signal: fetchSignal,
        redirect: 'error',
      });
      if (res.status === 404) {
        await res.body?.cancel().catch(() => undefined);
        throw new CdnError(
          404,
          'unknown-package',
          `package "${name}" does not exist on the registry`,
        );
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new CdnError(
          502,
          'registry-error',
          `registry answered ${res.status.toString()} for ${name}`,
        );
      }
      const chunks: Uint8Array[] = [];
      await readBody(res, this.opts.maxPackumentBytes, `packument of ${name}`, (c) => {
        chunks.push(c);
      });
      body = Buffer.concat(chunks);
    } catch (e) {
      throw registryFailure(e, signal, what);
    }
    this.stats.packumentBytes += body.length;
    this.stats.largestPackumentBytes = Math.max(this.stats.largestPackumentBytes, body.length);
    let json: unknown;
    try {
      json = JSON.parse(body.toString('utf8'));
    } catch {
      throw new CdnError(502, 'registry-error', `registry returned invalid JSON for ${name}`);
    }
    return { pack: sanitizePackument(name, json), bytes: body.length };
  }

  /**
   * Streams a tarball to `file` (created with `wx`) while hashing it, so memory use does not
   * depend on its size. Only URLs on the registry's own origin are fetched (no SSRF). The
   * file is removed on failure.
   */
  async downloadTarball(
    tarballUrl: string,
    file: string,
    opts: { maxBytes: number; algorithm: string; signal?: AbortSignal | undefined },
  ): Promise<TarballDownload> {
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
    const { signal } = opts;
    return this.limiter.run(async () => {
      this.stats.tarballFetches++;
      const hash = createHash(opts.algorithm);
      let fh: FileHandle | null = null;
      try {
        const res = await this.fetchImpl(url.href, {
          signal: withTimeout(signal, this.opts.fetchTimeoutMs),
          redirect: 'error',
        });
        if (!res.ok) {
          await res.body?.cancel().catch(() => undefined);
          throw new CdnError(
            502,
            'registry-error',
            `tarball download answered ${res.status.toString()}`,
          );
        }
        const out = await open(file, 'wx', 0o600);
        fh = out;
        const bytes = await readBody(res, opts.maxBytes, 'tarball', async (chunk) => {
          hash.update(chunk);
          let off = 0;
          while (off < chunk.byteLength) {
            const { bytesWritten } = await out.write(chunk, off, chunk.byteLength - off);
            off += bytesWritten;
          }
        });
        await out.close();
        fh = null;
        this.stats.tarballBytes += bytes;
        this.stats.largestTarballBytes = Math.max(this.stats.largestTarballBytes, bytes);
        return { bytes, digest: hash.digest() };
      } catch (e) {
        if (fh) await fh.close().catch(() => undefined);
        await rm(file, { force: true });
        throw registryFailure(e, signal, 'tarball download');
      }
    }, signal);
  }
}
