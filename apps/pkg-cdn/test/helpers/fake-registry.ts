/**
 * In-memory npm registry for tests: serves abbreviated packuments and tarballs through a
 * `fetch`-compatible function, with SRI integrity computed from the real tarball bytes.
 */
import { createHash } from 'node:crypto';
import type { FetchLike } from '../../src/registry';
import { npmTgz } from './tar-writer';

export const FAKE_REGISTRY = 'https://registry.test';

export interface FakeVersion {
  /** Files under package/ (package.json is generated unless given). */
  files?: Record<string, string>;
  /** Raw tarball, overriding `files`. */
  tarball?: Buffer;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  os?: string[];
  /** Extra package.json fields (main, module, exports, browser, scripts...). */
  pkg?: Record<string, unknown>;
  /** Override dist.integrity (e.g. a wrong hash). Null removes it. */
  integrity?: string | null;
  /** Override dist.tarball. */
  tarballUrl?: string;
  unpackedSize?: number;
}

export interface FakePackage {
  versions: Record<string, FakeVersion>;
  distTags?: Record<string, string>;
}

export interface FakeRegistry {
  fetch: FetchLike;
  /** Request log: packument names and tarball paths. */
  requests: string[];
  packages: Record<string, FakePackage>;
}

function tarballFor(name: string, version: string, v: FakeVersion): Buffer {
  if (v.tarball) return v.tarball;
  const files = { ...(v.files ?? {}) };
  if (!('package.json' in files)) {
    files['package.json'] = JSON.stringify({
      name,
      version,
      ...(v.dependencies ? { dependencies: v.dependencies } : {}),
      ...(v.optionalDependencies ? { optionalDependencies: v.optionalDependencies } : {}),
      ...(v.peerDependencies ? { peerDependencies: v.peerDependencies } : {}),
      ...(v.pkg ?? {}),
    });
  }
  return npmTgz(files);
}

function basename(name: string): string {
  return name.includes('/') ? (name.split('/')[1] ?? name) : name;
}

export function createFakeRegistry(packages: Record<string, FakePackage>): FakeRegistry {
  const requests: string[] = [];
  const tarballs = new Map<string, Buffer>();

  function packument(name: string): unknown {
    const pkg = packages[name];
    if (!pkg) return null;
    const versions: Record<string, unknown> = {};
    for (const [version, v] of Object.entries(pkg.versions)) {
      const data = tarballFor(name, version, v);
      const tarPath = `/${name}/-/${basename(name)}-${version}.tgz`;
      tarballs.set(tarPath, data);
      const integrity =
        v.integrity === undefined
          ? `sha512-${createHash('sha512').update(data).digest('base64')}`
          : v.integrity;
      versions[version] = {
        name,
        version,
        ...(v.dependencies ? { dependencies: v.dependencies } : {}),
        ...(v.optionalDependencies ? { optionalDependencies: v.optionalDependencies } : {}),
        ...(v.peerDependencies ? { peerDependencies: v.peerDependencies } : {}),
        ...(v.peerDependenciesMeta ? { peerDependenciesMeta: v.peerDependenciesMeta } : {}),
        ...(v.os ? { os: v.os } : {}),
        ...((v.pkg?.['scripts'] as Record<string, string> | undefined)?.['postinstall']
          ? { hasInstallScript: true }
          : {}),
        dist: {
          tarball: v.tarballUrl ?? `${FAKE_REGISTRY}${tarPath}`,
          shasum: createHash('sha1').update(data).digest('hex'),
          ...(integrity === null ? {} : { integrity }),
          ...(v.unpackedSize !== undefined ? { unpackedSize: v.unpackedSize } : {}),
        },
      };
    }
    const keys = Object.keys(pkg.versions);
    return {
      name,
      'dist-tags': pkg.distTags ?? { latest: keys[keys.length - 1] },
      versions,
    };
  }

  const fetchImpl: FetchLike = (input) => {
    const url = new URL(input);
    if (url.origin !== FAKE_REGISTRY) {
      return Promise.resolve(new Response('wrong host', { status: 599 }));
    }
    const p = decodeURIComponent(url.pathname);
    if (p.includes('/-/')) {
      requests.push(`tarball ${p}`);
      // Packuments generate the tarballs; make sure they exist even if fetched first.
      const name = p.slice(1, p.indexOf('/-/'));
      packument(name);
      const data = tarballs.get(p);
      return Promise.resolve(
        data ? new Response(new Uint8Array(data)) : new Response('not found', { status: 404 }),
      );
    }
    const name = p.slice(1);
    requests.push(`packument ${name}`);
    const doc = packument(name);
    return Promise.resolve(
      doc === null
        ? new Response('{"error":"Not found"}', { status: 404 })
        : new Response(JSON.stringify(doc), { headers: { 'content-type': 'application/json' } }),
    );
  };

  return { fetch: fetchImpl, requests, packages };
}
