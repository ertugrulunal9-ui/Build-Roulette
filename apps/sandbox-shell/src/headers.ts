/**
 * Response headers for the sandbox shell (docs/03 §3.5, docs/09 §9.3), as a single source of
 * truth for the static host (`dist/_headers`, the format Cloudflare's static assets read:
 * Workers since T-043, Pages before), the local dev server, and the site worker (`sw.ts`),
 * which sets `siteHeaders` on everything it serves for a site.
 */
import { SITE_WORKER_FILE } from './site-protocol';

export interface ShellHeaderOptions {
  /** Origins allowed to frame the shell (`frame-ancestors`). */
  appOrigins: readonly string[];
  /**
   * Extra `connect-src` sources. Production allows `'self' https: wss:` only; local dev adds
   * plain-http origins (a local Supabase API or file server the capture page fetches site
   * packs from).
   */
  extraConnectSrc?: readonly string[];
  /** Cache-Control for the shell files. Immutable in production (versioned paths). */
  cacheControl?: string;
}

/**
 * `form-action 'none'`: a build handles forms in JavaScript (`onSubmit` + `preventDefault`).
 * A real form submission would either navigate the build's own frame (wiping the running
 * app, which is what a forgotten `preventDefault` does) or send the form fields to another
 * origin by navigating the frame there. Neither is something a build needs, so submissions
 * are blocked: the form stays on screen and Chromium logs a CSP violation instead.
 * `allow-forms` stays in the iframe `sandbox`, so the `submit` event, `requestSubmit()` and
 * constraint validation keep working, and `method="dialog"` forms (no navigation) are not
 * affected.
 */
export const FORM_ACTION = "'none'";

/**
 * Sandbox flags of the capture page (`/v{N}/capture`), applied with the CSP `sandbox`
 * directive because the page is top-level (there is no app iframe to carry a `sandbox`
 * attribute). Same flags as the `reveal`/`capture` preview iframe in @br/runtime
 * (`PREVIEW_SANDBOX_BY_MODE.capture`; the capture worker's tests check they match): no
 * popups, no modals (an `alert()` would stall the renderer), no top-level navigation of
 * other contexts, no downloads. `allow-same-origin` is what lets the page register the site
 * worker. The site's child frame inherits them.
 */
export const CAPTURE_SANDBOX_FLAGS = [
  'allow-scripts',
  'allow-same-origin',
  'allow-forms',
  'allow-pointer-lock',
] as const;

/**
 * CSP of the shell document (and of every other answer of the static host, 404s included).
 * The shell runs only its own script, fetches `/v{N}/reset` (`connect-src 'self'`; `https:`
 * is for the capture page, which fetches the site pack), registers the site worker
 * (`worker-src 'self'`), frames the site's child frame on its own origin (`frame-src
 * 'self'`) and draws client thumbnails from data URLs (`img-src data: blob:`). A site never
 * runs under this policy: its documents come from the site worker with `siteCsp`.
 * `base-uri 'none'` stops a `<base>` element from re-pointing relative URLs; `form-action`
 * is explained at `FORM_ACTION`.
 */
export function shellCsp(opts: ShellHeaderOptions): string {
  return shellDirectives(opts, `frame-ancestors ${opts.appOrigins.join(' ')}`).join('; ');
}

/**
 * CSP of the capture page: the shell document's policy, except that the page is loaded
 * top-level by the renderer, so `frame-ancestors 'none'` (nobody may frame it) and the
 * `sandbox` directive replaces the app iframe's `sandbox` attribute. The site itself runs
 * under `siteCsp(…, 'capture')`.
 */
export function captureCsp(opts: ShellHeaderOptions): string {
  return [
    ...shellDirectives(opts, "frame-ancestors 'none'"),
    `sandbox ${CAPTURE_SANDBOX_FLAGS.join(' ')}`,
  ].join('; ');
}

function shellDirectives(opts: ShellHeaderOptions, frameAncestors: string): string[] {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    'img-src data: blob:',
    `connect-src ${connectSrc(opts)}`,
    "frame-src 'self'",
    "worker-src 'self'",
    frameAncestors,
    "base-uri 'none'",
    `form-action ${FORM_ACTION}`,
  ];
}

/**
 * Where a site runs: in the preview (the shell's child frame, inside the app) or on the
 * capture page (top-level, loaded by the capture renderer).
 */
export type SiteContext = 'preview' | 'capture';

/**
 * CSP of a site (docs/09 §9.3): the site worker sets it on every response it serves for a
 * site (it applies to HTML documents and to the scripts of the site's workers).
 *
 * - `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https:`: built sites load their
 *   own chunks, run inline scripts (their own, and the injected bootstrap), compile code with
 *   `new Function` (pixi.js and other engines) and load scripts from CDNs (the Tailwind play
 *   CDN, unpkg). A build is arbitrary JavaScript already, and `connect-src https:` allowed
 *   `fetch` + `eval` of any script anyway, so this widens nothing.
 * - `worker-src 'self' blob:`: a site's own workers. Service worker scripts are fetched from
 *   the network, never from the site worker, and the host serves no script but its own, so a
 *   site cannot register a service worker of its own (README, "Site worker: threat model").
 * - `frame-ancestors 'self' <app origins>` in the preview (the shell and the app frame it);
 *   `'self'` only on the capture page, which also gets the capture page's `sandbox` flags.
 * - The rest is as for builds before M6: `default-src 'none'` (no frames, objects or
 *   manifests), `connect-src 'self' https: wss:`, images, fonts and media from anywhere,
 *   `base-uri 'none'` and `form-action 'none'`.
 */
export function siteCsp(opts: ShellHeaderOptions, context: SiteContext): string {
  const frameAncestors =
    context === 'capture' ? "'self'" : dedupe(["'self'", ...opts.appOrigins]).join(' ');
  return [
    "default-src 'none'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https:",
    "style-src 'self' 'unsafe-inline' blob: https:",
    'img-src * data: blob:',
    'font-src * data:',
    'media-src * data: blob:',
    `connect-src ${connectSrc(opts)}`,
    "worker-src 'self' blob:",
    `frame-ancestors ${frameAncestors}`,
    "base-uri 'none'",
    `form-action ${FORM_ACTION}`,
    ...(context === 'capture' ? [`sandbox ${CAPTURE_SANDBOX_FLAGS.join(' ')}`] : []),
  ].join('; ');
}

function connectSrc(opts: ShellHeaderOptions): string {
  return dedupe(["'self'", 'https:', 'wss:', ...(opts.extraConnectSrc ?? [])]).join(' ');
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
 * the shell's JS cannot enumerate, and the site worker's registration and sites: the next
 * load registers the worker again.
 */
export const RESET_HEADERS: Readonly<Record<string, string>> = {
  'Clear-Site-Data': '"cache", "cookies", "storage"',
  'Cache-Control': 'no-store',
};

/**
 * Headers of the site worker script (`/v{N}/sw.js`), on top of the security headers: it may
 * control the whole origin (`Service-Worker-Allowed: /`; the shell registers it with scope
 * `/`) and it is never cached, so a deploy reaches a browser at its next registration (the
 * shell registers with `updateViaCache: 'none'` too).
 */
export const SITE_WORKER_HEADERS: Readonly<Record<string, string>> = {
  'Service-Worker-Allowed': '/',
  'Cache-Control': 'no-store',
};

/** The security headers other than the CSP: the host's and the sites' responses share them. */
const COMMON_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Permissions-Policy': PERMISSIONS_POLICY,
  'Cross-Origin-Resource-Policy': 'same-site',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  // Origin-keyed agent cluster: `document.domain` is disabled and the origin does not share
  // an agent cluster with sibling build subdomains, even before the usercontent apex is on
  // the Public Suffix List.
  'Origin-Agent-Cluster': '?1',
};

/** Headers for every response of the sandbox host (any path, 404s included). */
export function securityHeaders(opts: ShellHeaderOptions): Record<string, string> {
  return { 'Content-Security-Policy': shellCsp(opts), ...COMMON_SECURITY_HEADERS };
}

/**
 * Headers of every response the site worker serves for a site (the `Content-Type` comes from
 * the pack): the host's security headers with `siteCsp`, never cached.
 */
export function siteHeaders(
  opts: ShellHeaderOptions,
  context: SiteContext,
): Record<string, string> {
  return {
    'Content-Security-Policy': siteCsp(opts, context),
    ...COMMON_SECURITY_HEADERS,
    'Cache-Control': 'no-store',
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
  /** Cloudflare static assets / Netlify path pattern, e.g. `/*` or `/v2/shell.js`. */
  pattern: string;
  headers: Readonly<Record<string, string>>;
}

/**
 * The static host's header rules. Cloudflare's static assets apply every rule whose pattern
 * matches and join repeated header names with a comma, so only rules that cannot overlap set
 * `Cache-Control`: `/*` carries the security headers (every path, 404s included), each shell
 * file gets its own caching rule, `/v{N}/sw.js` gets `SITE_WORKER_HEADERS`, and
 * `/v{N}/reset` gets `Clear-Site-Data` + `no-store`. `/v{N}/capture` is not a static file:
 * the capture gate (the Worker, see `worker.ts`) answers it with `captureHeaders`.
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
    { pattern: `${basePath}${SITE_WORKER_FILE}`, headers: SITE_WORKER_HEADERS },
    { pattern: `${basePath}${RESET_ENDPOINT}`, headers: RESET_HEADERS },
  ];
}

/** Renders a Cloudflare (Workers static assets, Pages) / Netlify style `_headers` file. */
export function renderHeadersFile(rules: readonly HeaderRule[]): string {
  const blocks = rules.map(({ pattern, headers }) =>
    [pattern, ...Object.entries(headers).map(([k, v]) => `  ${k}: ${v}`)].join('\n'),
  );
  return `${blocks.join('\n\n')}\n`;
}

function dedupe(xs: readonly string[]): string[] {
  return [...new Set(xs)];
}
