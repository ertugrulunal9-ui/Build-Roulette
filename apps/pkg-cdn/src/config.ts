/** Configuration from environment variables (all optional). */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_LIMITS, type Limits } from './policy';

/** apps/pkg-cdn (works from both src/ and the bundled dist/). */
export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface CdnConfig {
  port: number;
  host: string;
  /** Root of the disk cache (store, trees, bundles). */
  cacheDir: string;
  registryUrl: string;
  packumentTtlMs: number;
  /** JSON denylist file, or null for none. */
  denylistFile: string | null;
  limits: Limits;
  /** Accept SHA-1 `shasum` for old versions without an SRI `integrity`. */
  allowSha1Fallback: boolean;
  /** Concurrent esbuild bundles. */
  maxConcurrentBuilds: number;
}

export const ENV_DOCS: Record<string, string> = {
  PKG_CDN_PORT: 'Port to listen on (default 4400; PORT is also honored)',
  PKG_CDN_HOST: 'Interface to bind (default 127.0.0.1)',
  PKG_CDN_CACHE_DIR: 'Disk cache directory (default apps/pkg-cdn/node_modules/.cache/pkg-cdn)',
  PKG_CDN_REGISTRY: 'npm registry URL (default https://registry.npmjs.org)',
  PKG_CDN_PACKUMENT_TTL_SECONDS: 'How long packuments are cached in memory (default 300)',
  PKG_CDN_DENYLIST: 'Denylist JSON file (default apps/pkg-cdn/denylist.json; "none" disables)',
  PKG_CDN_MAX_TARBALL_MB: 'Max compressed tarball size (default 40)',
  PKG_CDN_MAX_UNPACKED_MB: 'Max unpacked package size (default 250)',
  PKG_CDN_MAX_FILES: 'Max files per package (default 30000)',
  PKG_CDN_MAX_DEPENDENCIES: 'Max packages in one dependency tree (default 250)',
  PKG_CDN_MAX_OUTPUT_MB: 'Max size of one bundled module (default 12)',
  PKG_CDN_BUNDLE_TIMEOUT_MS: 'Max time for one esbuild bundle (default 60000)',
  PKG_CDN_FETCH_TIMEOUT_MS: 'Max time for one registry request (default 60000)',
  PKG_CDN_ALLOW_SHA1: 'Set to 1 to accept SHA-1 shasums for old versions without SRI (default 0)',
  PKG_CDN_MAX_CONCURRENT_BUILDS: 'Concurrent esbuild bundles (default 4)',
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
  return {
    port: num(env, 'PKG_CDN_PORT', num(env, 'PORT', 4400)),
    host: env['PKG_CDN_HOST'] ?? '127.0.0.1',
    cacheDir: path.resolve(
      env['PKG_CDN_CACHE_DIR'] ?? path.join(APP_DIR, 'node_modules', '.cache', 'pkg-cdn'),
    ),
    registryUrl,
    packumentTtlMs: num(env, 'PKG_CDN_PACKUMENT_TTL_SECONDS', 300) * 1000,
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
      maxPackumentBytes: DEFAULT_LIMITS.maxPackumentBytes,
    },
    allowSha1Fallback: env['PKG_CDN_ALLOW_SHA1'] === '1',
    maxConcurrentBuilds: Math.max(1, num(env, 'PKG_CDN_MAX_CONCURRENT_BUILDS', 4)),
  };
}
