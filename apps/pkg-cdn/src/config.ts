/** Configuration from environment variables (all optional). */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_LIMITS, type Limits } from './policy';

/** apps/pkg-cdn (works from both src/ and the bundled dist/). */
export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Concurrency and queue limits shared by all requests (load shedding past `queue`). */
export interface WorkLimit {
  /** Running at once. */
  concurrent: number;
  /** Waiting at most; more is refused with 503 + Retry-After. */
  queue: number;
}

export interface CdnConfig {
  port: number;
  host: string;
  /** Root of the disk cache (store, trees, bundles). */
  cacheDir: string;
  registryUrl: string;
  packumentTtlMs: number;
  /** In-memory packument cache budget (sum of response sizes). */
  packumentCacheBytes: number;
  /** JSON denylist file, or null for none. */
  denylistFile: string | null;
  limits: Limits;
  /** Accept SHA-1 `shasum` for old versions without an SRI `integrity`. */
  allowSha1Fallback: boolean;
  /** Registry requests (packuments and tarballs). */
  fetches: WorkLimit;
  /** Tarball extractions. */
  extractions: WorkLimit;
  /** esbuild bundles. */
  builds: WorkLimit;
  /** Whole-request deadline (504); queued and shared work is cancelled with it. */
  requestTimeoutMs: number;
  /** `Retry-After` on 503 responses. */
  retryAfterSeconds: number;
  /** Disk quota of the cache (store + trees + bundles); 0 disables eviction. */
  cacheQuotaBytes: number;
}

export const ENV_DOCS: Record<string, string> = {
  PKG_CDN_PORT: 'Port to listen on (default 4400; PORT is also honored)',
  PKG_CDN_HOST: 'Interface to bind (default 127.0.0.1)',
  PKG_CDN_CACHE_DIR: 'Disk cache directory (default apps/pkg-cdn/node_modules/.cache/pkg-cdn)',
  PKG_CDN_CACHE_QUOTA_MB: 'Disk quota of the cache, LRU-evicted above it (default 5120; 0 = none)',
  PKG_CDN_REGISTRY: 'npm registry URL (default https://registry.npmjs.org)',
  PKG_CDN_PACKUMENT_TTL_SECONDS: 'How long packuments are cached in memory (default 300)',
  PKG_CDN_PACKUMENT_CACHE_MB: 'Memory budget of the packument cache (default 128)',
  PKG_CDN_DENYLIST: 'Denylist JSON file (default apps/pkg-cdn/denylist.json; "none" disables)',
  PKG_CDN_MAX_TARBALL_MB: 'Max compressed tarball size (default 32)',
  PKG_CDN_MAX_UNPACKED_MB: 'Max unpacked package size (default 160)',
  PKG_CDN_MAX_FILES: 'Max files per package (default 30000)',
  PKG_CDN_MAX_PACKUMENT_MB: 'Max abbreviated packument size (default 16)',
  PKG_CDN_MAX_DEPENDENCIES: 'Max packages in one dependency tree (default 250)',
  PKG_CDN_MAX_OUTPUT_MB: 'Max size of one bundled module (default 12)',
  PKG_CDN_BUNDLE_TIMEOUT_MS: 'Max time for one esbuild bundle (default 60000)',
  PKG_CDN_FETCH_TIMEOUT_MS: 'Max time for one registry request (default 60000)',
  PKG_CDN_REQUEST_TIMEOUT_MS: 'Max time for one HTTP request, queueing included (default 90000)',
  PKG_CDN_ALLOW_SHA1: 'Set to 1 to accept SHA-1 shasums for old versions without SRI (default 0)',
  PKG_CDN_MAX_CONCURRENT_FETCHES:
    'Concurrent registry requests, all requests together (default 16)',
  PKG_CDN_MAX_QUEUED_FETCHES: 'Queued registry requests before 503 (default 2000)',
  PKG_CDN_MAX_CONCURRENT_EXTRACTIONS: 'Concurrent tarball extractions (default 4)',
  PKG_CDN_MAX_QUEUED_EXTRACTIONS: 'Queued extractions before 503 (default 1000)',
  PKG_CDN_MAX_CONCURRENT_BUILDS: 'Concurrent esbuild bundles (default 4)',
  PKG_CDN_MAX_QUEUED_BUILDS: 'Queued bundles before 503 (default 64)',
  PKG_CDN_RETRY_AFTER_SECONDS: 'Retry-After of 503 responses (default 5)',
};

function num(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${key} must be a non-negative number`);
  return n;
}

const MB = 1024 * 1024;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CdnConfig {
  const denylist = env['PKG_CDN_DENYLIST'];
  const registryUrl = env['PKG_CDN_REGISTRY'] ?? 'https://registry.npmjs.org';
  const parsed = new URL(registryUrl);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('PKG_CDN_REGISTRY must be an http(s) URL');
  }
  const work = (name: string, concurrent: number, queue: number): WorkLimit => ({
    concurrent: Math.max(1, Math.floor(num(env, `PKG_CDN_MAX_CONCURRENT_${name}`, concurrent))),
    queue: Math.floor(num(env, `PKG_CDN_MAX_QUEUED_${name}`, queue)),
  });
  return {
    port: num(env, 'PKG_CDN_PORT', num(env, 'PORT', 4400)),
    host: env['PKG_CDN_HOST'] ?? '127.0.0.1',
    cacheDir: path.resolve(
      env['PKG_CDN_CACHE_DIR'] ?? path.join(APP_DIR, 'node_modules', '.cache', 'pkg-cdn'),
    ),
    registryUrl,
    packumentTtlMs: num(env, 'PKG_CDN_PACKUMENT_TTL_SECONDS', 300) * 1000,
    packumentCacheBytes: num(env, 'PKG_CDN_PACKUMENT_CACHE_MB', 128) * MB,
    denylistFile:
      denylist === 'none' ? null : path.resolve(denylist ?? path.join(APP_DIR, 'denylist.json')),
    limits: {
      maxTarballBytes: num(env, 'PKG_CDN_MAX_TARBALL_MB', DEFAULT_LIMITS.maxTarballBytes / MB) * MB,
      maxUnpackedBytes:
        num(env, 'PKG_CDN_MAX_UNPACKED_MB', DEFAULT_LIMITS.maxUnpackedBytes / MB) * MB,
      maxFilesPerPackage: num(env, 'PKG_CDN_MAX_FILES', DEFAULT_LIMITS.maxFilesPerPackage),
      maxDependencies: num(env, 'PKG_CDN_MAX_DEPENDENCIES', DEFAULT_LIMITS.maxDependencies),
      maxOutputBytes: num(env, 'PKG_CDN_MAX_OUTPUT_MB', DEFAULT_LIMITS.maxOutputBytes / MB) * MB,
      bundleTimeoutMs: num(env, 'PKG_CDN_BUNDLE_TIMEOUT_MS', DEFAULT_LIMITS.bundleTimeoutMs),
      fetchTimeoutMs: num(env, 'PKG_CDN_FETCH_TIMEOUT_MS', DEFAULT_LIMITS.fetchTimeoutMs),
      maxPackumentBytes:
        num(env, 'PKG_CDN_MAX_PACKUMENT_MB', DEFAULT_LIMITS.maxPackumentBytes / MB) * MB,
    },
    allowSha1Fallback: env['PKG_CDN_ALLOW_SHA1'] === '1',
    fetches: work('FETCHES', 16, 2000),
    extractions: work('EXTRACTIONS', 4, 1000),
    builds: work('BUILDS', 4, 64),
    // Below Cloudflare's 100 s origin timeout, so the client gets our 504, not the edge's 524.
    requestTimeoutMs: num(env, 'PKG_CDN_REQUEST_TIMEOUT_MS', 90_000),
    retryAfterSeconds: num(env, 'PKG_CDN_RETRY_AFTER_SECONDS', 5),
    cacheQuotaBytes: num(env, 'PKG_CDN_CACHE_QUOTA_MB', 5120) * MB,
  };
}
