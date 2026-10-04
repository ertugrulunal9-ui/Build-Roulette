/**
 * Response headers for the sandbox shell (docs/03 §3.5), as a single source of truth for
 * both the static host (`dist/_headers`, Cloudflare Pages format) and the local dev server.
 */

export interface ShellHeaderOptions {
  /** Origins allowed to frame the shell (`frame-ancestors`). */
  appOrigins: readonly string[];
  /** Origin of the package CDN (module scripts and package CSS). */
  cdnOrigin: string;
  /** Extra script hosts (e.g. the Tailwind browser runtime host for the tailwind template). */
  extraScriptSrc?: readonly string[];
  /**
   * Extra `connect-src` sources. Production allows `'self' https: wss:` only; local dev adds
   * the http mock CDN origin because localhost is plain http.
   */
  extraConnectSrc?: readonly string[];
  /** Cache-Control for the shell files. Immutable in production (versioned paths). */
  cacheControl?: string;
}

/**
 * `form-action 'none'`: a build handles forms in JavaScript (`onSubmit` + `preventDefault`).
 * A real form submission would either navigate the build's own frame (to the shell URL or
 * `about:blank`, wiping the running app, which is what a forgotten `preventDefault` does) or
 * send the form fields to another origin by navigating the frame there. Neither is something
 * a build needs, so submissions are blocked: the form stays on screen and Chromium logs a CSP
 * violation instead. `allow-forms` stays in the iframe `sandbox`, so the `submit` event,
 * `requestSubmit()` and constraint validation keep working, and `method="dialog"` forms (no
 * navigation) are not affected.
 */
export const FORM_ACTION = "'none'";

/**
 * CSP for the shell document. The user's document is created by the shell as a same-origin
 * child (about:blank + document.write), so it inherits this policy.
 *
 * Deviations from docs/03 in `script-src`:
 * - `'unsafe-inline'`: the shell installs the import map as an inline
 *   `<script type="importmap">`, which CSP treats like any inline script, and its contents
 *   depend on the build's pinned React version, so neither a static hash nor a per-response
 *   nonce from a static host can allow it.
 * - `'unsafe-eval'`: packages such as pixi.js v8 compile code with `new Function` at runtime.
 * Neither widens what a build can do: the build is arbitrary JS already and `blob:` is
 * allowed for its module.
 *
 * `connect-src` includes `'self'` for the shell's own `/v{N}/reset` endpoint
 * (`Clear-Site-Data`, see `RESET_HEADERS`). In production `https:` covers it already, but
 * local dev is plain http. `base-uri 'none'` stops a `<base>` element from re-pointing
 * relative URLs. `form-action` is explained at `FORM_ACTION`.
 */
export function shellCsp(opts: ShellHeaderOptions): string {
  return cspDirectives(opts, `frame-ancestors ${opts.appOrigins.join(' ')}`).join('; ');
}

/**
 * Sandbox flags of the capture page (`/v{N}/capture`), applied with the CSP `sandbox`
 * directive because the page is top-level (there is no app iframe to carry a `sandbox`
 * attribute). Same flags as the `reveal`/`capture` preview iframe in @br/runtime
 * (`PREVIEW_SANDBOX_BY_MODE.capture`; the capture worker's tests check they match): no
 * popups, no modals (an `alert()` would stall the renderer), no top-level navigation of
 * other contexts, no downloads. The build's child frame inherits them.
 */
export const CAPTURE_SANDBOX_FLAGS = [
  'allow-scripts',
  'allow-same-origin',
  'allow-forms',
  'allow-pointer-lock',
] as const;

/**
 * CSP of the capture page: the shell's policy (same sources, so a build behaves the same as
 * in the preview), except that the page is loaded top-level by the renderer, so
 * `frame-ancestors 'none'` (nobody may frame it) and the `sandbox` directive replaces the
 * app iframe's `sandbox` attribute.
 */
export function captureCsp(opts: ShellHeaderOptions): string {
  return [
    ...cspDirectives(opts, "frame-ancestors 'none'"),
    `sandbox ${CAPTURE_SANDBOX_FLAGS.join(' ')}`,
  ].join('; ');
}

function cspDirectives(opts: ShellHeaderOptions, frameAncestors: string): string[] {
  const scriptSrc = [
    "'self'",
    "'unsafe-inline'",
    "'unsafe-eval'",
    'blob:',
    opts.cdnOrigin,
    ...(opts.extraScriptSrc ?? []),
  ];
  const styleSrc = ["'self'", "'unsafe-inline'", 'blob:', 'https:'];
  if (!opts.cdnOrigin.startsWith('https:')) styleSrc.push(opts.cdnOrigin);
  const connectSrc = ["'self'", 'https:', 'wss:', ...(opts.extraConnectSrc ?? [])];
  return [
    "default-src 'none'",
    `script-src ${dedupe(scriptSrc).join(' ')}`,
    `style-src ${dedupe(styleSrc).join(' ')}`,
    'img-src * data: blob:',
    'font-src * data:',
    'media-src * data: blob:',
    `connect-src ${dedupe(connectSrc).join(' ')}`,
    'worker-src blob:',
    frameAncestors,
    "base-uri 'none'",
    `form-action ${FORM_ACTION}`,
  ];
}

/**
 * Powerful features no build may use. Only feature names Chromium recognises are listed: an
 * unknown name makes Chromium log "Unrecognized feature" on every load (an e2e test checks
 * that there is none). Features a build may use (autoplay, fullscreen, gamepad, and
 * clipboard-write in live mode) are delegated per frame through the iframe `allow` attribute.
 *
 * `bluetooth` is deliberately absent: Chromium 141 logs "Unrecognized feature: 'bluetooth'"
 * (it is not a shipped policy-controlled feature there). Chromium does not offer Web
 * Bluetooth to cross-origin iframes, and it always needs a user gesture and a device chooser.
 */
export const PERMISSIONS_POLICY_FEATURES = [
  'camera',
  'microphone',
  'geolocation',
  'payment',
  'usb',
  'serial',
  'hid',
  'display-capture',
  'screen-wake-lock',
  'idle-detection',
  'midi',
  'publickey-credentials-get',
  'publickey-credentials-create',
  'xr-spatial-tracking',
] as const;

export const PERMISSIONS_POLICY = PERMISSIONS_POLICY_FEATURES.map((f) => `${f}=()`).join(', ');

/** File name of the storage-wipe endpoint, under the shell's versioned base path. */
export const RESET_ENDPOINT = 'reset';

/**
 * Headers of `/v{N}/reset`, which the shell fetches during `reset-storage`.
 * `Clear-Site-Data` makes the browser drop the origin's HTTP cache, its cookies (all paths,
 * HttpOnly ones too; the browser clears them for the whole registrable domain) and its DOM
 * storage (localStorage, IndexedDB, CacheStorage, service workers, OPFS). That includes data
 * the shell's JS cannot enumerate.
 */
export const RESET_HEADERS: Readonly<Record<string, string>> = {
  'Clear-Site-Data': '"cache", "cookies", "storage"',
  'Cache-Control': 'no-store',
};

/** Headers for every response of the sandbox host (any path, 404s included). */
export function securityHeaders(opts: ShellHeaderOptions): Record<string, string> {
  return {
    'Content-Security-Policy': shellCsp(opts),
    'Permissions-Policy': PERMISSIONS_POLICY,
    'Cross-Origin-Resource-Policy': 'same-site',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    // Origin-keyed agent cluster: `document.domain` is disabled and the origin does not share
    // an agent cluster with sibling build subdomains, even before the usercontent apex is on
    // the Public Suffix List.
    'Origin-Agent-Cluster': '?1',
  };
}

/** Headers for the shell files themselves: the security headers plus caching. */
export function shellHeaders(opts: ShellHeaderOptions): Record<string, string> {
  return {
    ...securityHeaders(opts),
    'Cache-Control': opts.cacheControl ?? 'public, max-age=31536000, immutable',
  };
}

/**
 * Headers of the capture page response (`/v{N}/capture`, served only by the capture gate
 * after the signature check): the security headers with `captureCsp`, never cached (every
 * URL is single-use and short-lived), and not indexed.
 */
export function captureHeaders(opts: ShellHeaderOptions): Record<string, string> {
  return {
    ...securityHeaders(opts),
    'Content-Security-Policy': captureCsp(opts),
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow',
  };
}

export interface HeaderRule {
  /** Cloudflare Pages / Netlify path pattern, e.g. `/*` or `/v1/shell.js`. */
  pattern: string;
  headers: Readonly<Record<string, string>>;
}

/**
 * The static host's header rules. Cloudflare Pages applies every rule whose pattern matches
 * and joins repeated header names with a comma, so only rules that cannot overlap set
 * `Cache-Control`: `/*` carries the security headers (every path, 404s included), each shell
 * file gets its own caching rule, and `/v{N}/reset` gets `Clear-Site-Data` + `no-store`.
 * `/v{N}/capture` is not a static file: the capture gate (`_worker.js`, see
 * `pages-worker.ts`) answers it with `captureHeaders`.
 */
export function staticHeaderRules(opts: ShellHeaderOptions, basePath: string): HeaderRule[] {
  const immutable = {
    'Cache-Control': opts.cacheControl ?? 'public, max-age=31536000, immutable',
  };
  return [
    { pattern: '/*', headers: securityHeaders(opts) },
    { pattern: basePath, headers: immutable },
    { pattern: `${basePath}index.html`, headers: immutable },
    { pattern: `${basePath}shell.js`, headers: immutable },
    { pattern: `${basePath}capture.js`, headers: immutable },
    { pattern: `${basePath}${RESET_ENDPOINT}`, headers: RESET_HEADERS },
  ];
}

/** Renders a Cloudflare Pages / Netlify style `_headers` file. */
export function renderHeadersFile(rules: readonly HeaderRule[]): string {
  const blocks = rules.map(({ pattern, headers }) =>
    [pattern, ...Object.entries(headers).map(([k, v]) => `  ${k}: ${v}`)].join('\n'),
  );
  return `${blocks.join('\n\n')}\n`;
}

function dedupe(xs: readonly string[]): string[] {
  return [...new Set(xs)];
}
