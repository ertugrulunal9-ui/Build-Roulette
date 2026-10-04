/**
 * Tarball integrity: Subresource Integrity strings from the packument (`dist.integrity`,
 * e.g. `sha512-<base64>`), with an optional fallback to the legacy SHA-1 `dist.shasum` for
 * very old versions that were published before the registry recorded SRI hashes.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { CdnError } from './errors';

const SUPPORTED = ['sha512', 'sha384', 'sha256'] as const;
type Algorithm = (typeof SUPPORTED)[number];

export interface DistIntegrity {
  integrity?: string | undefined;
  shasum?: string | undefined;
}

export interface IntegrityOptions {
  /** Accept `dist.shasum` (SHA-1) when there is no SRI string. Default false. */
  allowSha1Fallback?: boolean;
}

export interface IntegrityResult {
  algorithm: DigestAlgorithm;
}

/** Parses an SRI string into `{algorithm -> base64 digests}`; unknown algorithms are ignored. */
export function parseSri(sri: string): Map<Algorithm, string[]> {
  const out = new Map<Algorithm, string[]>();
  for (const token of sri.trim().split(/\s+/)) {
    const dash = token.indexOf('-');
    if (dash <= 0) continue;
    const alg = token.slice(0, dash) as Algorithm;
    if (!SUPPORTED.includes(alg)) continue;
    // Options after `?` are allowed by the SRI grammar; they carry no meaning here.
    const digest = token.slice(dash + 1).split('?')[0] ?? '';
    if (!/^[A-Za-z0-9+/]+=*$/.test(digest)) continue;
    const list = out.get(alg) ?? [];
    list.push(digest);
    out.set(alg, list);
  }
  return out;
}

function sameBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export type DigestAlgorithm = Algorithm | 'sha1';

const LABEL = 'tarball integrity check failed';

/**
 * The digest to compute for a tarball: the strongest algorithm listed in `dist.integrity`, or
 * SHA-1 when allowed and there is no usable SRI string. Throws CdnError(502, 'integrity')
 * when there is nothing to check against, so this runs before anything is downloaded.
 */
export function integrityAlgorithm(
  dist: DistIntegrity,
  opts: IntegrityOptions = {},
): DigestAlgorithm {
  if (dist.integrity) {
    const parsed = parseSri(dist.integrity);
    const alg = SUPPORTED.find((a) => parsed.has(a));
    if (alg) return alg;
  }
  if (opts.allowSha1Fallback && dist.shasum && /^[0-9a-f]{40}$/i.test(dist.shasum)) return 'sha1';
  throw new CdnError(
    502,
    'integrity',
    `${LABEL}: the registry did not provide a supported integrity hash (sha512/sha384/sha256)`,
  );
}

/**
 * Throws CdnError(502, 'integrity') unless `actual` (a digest computed with `alg`, e.g. while
 * streaming the download) matches `dist` (any digest of that algorithm may match, as in SRI).
 */
export function checkDigest(
  alg: DigestAlgorithm,
  actual: Buffer,
  dist: DistIntegrity,
): IntegrityResult {
  if (alg === 'sha1') {
    if (!sameBytes(Buffer.from(dist.shasum ?? '', 'hex'), actual)) {
      throw new CdnError(502, 'integrity', `${LABEL}: sha1 shasum does not match`);
    }
    return { algorithm: 'sha1' };
  }
  const expected = parseSri(dist.integrity ?? '').get(alg) ?? [];
  if (!expected.some((d) => sameBytes(Buffer.from(d, 'base64'), actual))) {
    throw new CdnError(502, 'integrity', `${LABEL}: ${alg} digest does not match`);
  }
  return { algorithm: alg };
}

/**
 * Throws CdnError(502, 'integrity') unless `data` matches the strongest algorithm listed in
 * `dist.integrity` (any digest of that algorithm may match, as in SRI).
 */
export function verifyIntegrity(
  data: Uint8Array,
  dist: DistIntegrity,
  opts: IntegrityOptions = {},
): IntegrityResult {
  const alg = integrityAlgorithm(dist, opts);
  return checkDigest(alg, createHash(alg).update(data).digest(), dist);
}
