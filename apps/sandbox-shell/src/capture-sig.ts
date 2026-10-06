/**
 * Signed capture URLs (docs/03 §3.7).
 *
 *   https://{build}.<usercontent>/v1/capture?src=<url>&css=<url>&map=<json>&exp=<unix>&sig=<hmac>
 *
 * The capture worker signs the URL with a secret it shares with the shell host's capture
 * gate (`capture-gate.ts`), which runs server-side: a Cloudflare Pages `_worker.js` in
 * production, the local Node server in dev and tests. The secret never reaches the
 * browser: the capture page is only served after the gate verified the signature, so the
 * page's JS can use `location.search` as is.
 *
 * Canonical string (what is signed), one field per line:
 *
 *   br-capture-v1
 *   <host>        lowercase host[:port] of the capture URL (binds the URL to one build origin)
 *   <pathname>    /v1/capture
 *   <query>       every parameter except `sig`, sorted by name, `name=value` with both parts
 *                 encoded by encodeURIComponent and joined with `&`
 *
 * Verification parses the query with URLSearchParams (so any equivalent percent-encoding of
 * a value is accepted, and the decoded value is what the page uses), rejects unknown or
 * repeated parameters, requires `src`, `exp` and `sig`, and accepts `exp` only while
 * `now <= exp <= now + CAPTURE_MAX_TTL_SECONDS`. The MAC is compared by WebCrypto's
 * `verify`, which is constant-time.
 *
 * WebCrypto only (no `node:` imports), so the same module runs in Node 22, Cloudflare
 * Workers and browsers.
 */

export const CAPTURE_SIG_VERSION = 'br-capture-v1';
/** Parameters covered by the signature. `sig` itself is the only other one allowed. */
export const CAPTURE_SIGNED_PARAMS = ['css', 'exp', 'map', 'src'] as const;
export type CaptureParamName = (typeof CAPTURE_SIGNED_PARAMS)[number];
/** Longest allowed lifetime of a signed URL, in seconds. Captures need well under a minute. */
export const CAPTURE_MAX_TTL_SECONDS = 600;
/** Shortest accepted secret, in characters (32 random bytes as hex or base64 are longer). */
export const CAPTURE_MIN_SECRET_LENGTH = 32;
/** Upper bound for the whole query string, to keep the gate's work bounded. */
export const CAPTURE_MAX_QUERY_CHARS = 16_384;

export interface CaptureParams {
  /** URL of the bundle's JS (a short-lived signed Storage URL). */
  src: string;
  /** URL of the bundle's CSS, if the build has any. */
  css?: string;
  /** The import map as JSON (`{"imports": {...}}`), validated again by the capture page. */
  map?: string;
  /** Expiry, unix seconds. */
  exp: number;
}

export type CaptureRejectReason =
  | 'malformed'
  | 'unknown-param'
  | 'duplicate-param'
  | 'missing-param'
  | 'bad-url'
  | 'bad-exp'
  | 'expired'
  | 'ttl-too-long'
  | 'bad-signature';

export type CaptureVerifyResult =
  { ok: true; params: CaptureParams } | { ok: false; reason: CaptureRejectReason };

const EXP_RE = /^[1-9]\d{0,11}$/;
const SIG_RE = /^[A-Za-z0-9_-]{43}$/; // base64url of 32 bytes, no padding

/** The exact string that is signed. `params` must not contain `sig`. */
export function canonicalCaptureString(
  host: string,
  pathname: string,
  params: Readonly<Record<string, string>>,
): string {
  const query = Object.keys(params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k] ?? '')}`)
    .join('&');
  return [CAPTURE_SIG_VERSION, host.toLowerCase(), pathname, query].join('\n');
}

function assertSecret(secret: string): void {
  if (secret.length < CAPTURE_MIN_SECRET_LENGTH) {
    throw new Error(
      `capture HMAC secret must be at least ${String(CAPTURE_MIN_SECRET_LENGTH)} characters`,
    );
  }
}

async function hmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  );
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Computes the base64url HMAC-SHA256 of the canonical string. */
export async function signCaptureParams(
  secret: string,
  host: string,
  pathname: string,
  params: Readonly<Record<string, string>>,
): Promise<string> {
  assertSecret(secret);
  const key = await hmacKey(secret, 'sign');
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(canonicalCaptureString(host, pathname, params)),
  );
  return toBase64Url(new Uint8Array(mac));
}

export interface SignCaptureUrlInput {
  /** The capture page URL without a query, e.g. `https://b1.usercontent.example/v1/capture`. */
  captureUrl: string;
  src: string;
  css?: string | undefined;
  map?: string | undefined;
  /** Expiry, unix seconds. */
  exp: number;
  secret: string;
}

/** Builds the full signed capture URL. */
export async function signCaptureUrl(input: SignCaptureUrlInput): Promise<string> {
  const url = new URL(input.captureUrl);
  if (url.search || url.hash) throw new Error('captureUrl must not have a query or fragment');
  if (!Number.isInteger(input.exp) || !EXP_RE.test(String(input.exp))) {
    throw new Error('exp must be a positive integer (unix seconds)');
  }
  if (!isHttpUrl(input.src)) throw new Error('src must be an http(s) URL');
  if (input.css !== undefined && !isHttpUrl(input.css))
    throw new Error('css must be an http(s) URL');
  const params: Record<string, string> = { src: input.src, exp: String(input.exp) };
  if (input.css !== undefined) params['css'] = input.css;
  if (input.map !== undefined) params['map'] = input.map;
  const sig = await signCaptureParams(input.secret, url.host, url.pathname, params);
  const query = Object.keys(params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k] ?? '')}`);
  query.push(`sig=${sig}`);
  url.search = `?${query.join('&')}`;
  return url.toString();
}

/**
 * Verifies a capture URL. `nowSeconds` is unix seconds. Never throws for bad input; a
 * missing or too-short secret is a configuration error and does throw.
 */
export async function verifyCaptureUrl(
  input: string | URL,
  secret: string,
  nowSeconds: number,
): Promise<CaptureVerifyResult> {
  assertSecret(secret);
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (url.search.length > CAPTURE_MAX_QUERY_CHARS) return { ok: false, reason: 'malformed' };

  const seen = new Map<string, string>();
  for (const [k, v] of new URLSearchParams(url.search)) {
    if (k !== 'sig' && !(CAPTURE_SIGNED_PARAMS as readonly string[]).includes(k)) {
      return { ok: false, reason: 'unknown-param' };
    }
    if (seen.has(k)) return { ok: false, reason: 'duplicate-param' };
    seen.set(k, v);
  }
  const sig = seen.get('sig');
  const src = seen.get('src');
  const expRaw = seen.get('exp');
  if (sig === undefined || src === undefined || expRaw === undefined) {
    return { ok: false, reason: 'missing-param' };
  }
  const css = seen.get('css');
  const map = seen.get('map');
  if (!isHttpUrl(src) || (css !== undefined && !isHttpUrl(css))) {
    return { ok: false, reason: 'bad-url' };
  }
  if (!EXP_RE.test(expRaw)) return { ok: false, reason: 'bad-exp' };
  const exp = Number(expRaw);
  if (!SIG_RE.test(sig)) return { ok: false, reason: 'bad-signature' };

  const params: Record<string, string> = {};
  for (const [k, v] of seen) if (k !== 'sig') params[k] = v;
  const key = await hmacKey(secret, 'verify');
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    fromBase64Url(sig),
    new TextEncoder().encode(canonicalCaptureString(url.host, url.pathname, params)),
  );
  if (!valid) return { ok: false, reason: 'bad-signature' };
  // Time checks only after the MAC: a forged URL is always `bad-signature`.
  if (nowSeconds > exp) return { ok: false, reason: 'expired' };
  if (exp - nowSeconds > CAPTURE_MAX_TTL_SECONDS) return { ok: false, reason: 'ttl-too-long' };

  return {
    ok: true,
    params: {
      src,
      exp,
      ...(css === undefined ? {} : { css }),
      ...(map === undefined ? {} : { map }),
    },
  };
}
