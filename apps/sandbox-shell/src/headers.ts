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
   * Extra `connect-src` sources. Production allows `https: wss:` only; local dev adds the
   * http mock CDN origin because localhost is plain http.
   */
  extraConnectSrc?: readonly string[];
  /** Cache-Control for the shell files. Immutable in production (versioned paths). */
  cacheControl?: string;
}

/**
 * CSP for the shell document. The user's document is created by the shell as a same-origin
 * child (about:blank + document.write), so it inherits this policy.
 *
 * Deviation from docs/03: `script-src` contains `'unsafe-inline'`. The shell installs the
 * import map as an inline `<script type="importmap">`, which CSP treats like any inline
 * script, and its contents depend on the build's pinned React version, so neither a static
 * hash nor a per-response nonce from a static host can allow it. This does not widen what a
 * build can do: the build is arbitrary JS already and `blob:` is allowed for its module.
 */
export function shellCsp(opts: ShellHeaderOptions): string {
  const scriptSrc = [
    "'self'",
    "'unsafe-inline'",
    'blob:',
    opts.cdnOrigin,
    ...(opts.extraScriptSrc ?? []),
  ];
  const styleSrc = ["'self'", "'unsafe-inline'", 'blob:', 'https:'];
  if (!opts.cdnOrigin.startsWith('https:')) styleSrc.push(opts.cdnOrigin);
  const connectSrc = ['https:', 'wss:', ...(opts.extraConnectSrc ?? [])];
  return [
    "default-src 'none'",
    `script-src ${dedupe(scriptSrc).join(' ')}`,
    `style-src ${dedupe(styleSrc).join(' ')}`,
    'img-src * data: blob:',
    'font-src * data:',
    'media-src * data: blob:',
    `connect-src ${dedupe(connectSrc).join(' ')}`,
    'worker-src blob:',
    `frame-ancestors ${opts.appOrigins.join(' ')}`,
  ].join('; ');
}

export const PERMISSIONS_POLICY =
  'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=()';

export function shellHeaders(opts: ShellHeaderOptions): Record<string, string> {
  return {
    'Content-Security-Policy': shellCsp(opts),
    'Permissions-Policy': PERMISSIONS_POLICY,
    'Cross-Origin-Resource-Policy': 'same-site',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': opts.cacheControl ?? 'public, max-age=31536000, immutable',
  };
}

/** Renders a Cloudflare Pages / Netlify style `_headers` file. */
export function renderHeadersFile(pathPattern: string, headers: Record<string, string>): string {
  const lines = [pathPattern, ...Object.entries(headers).map(([k, v]) => `  ${k}: ${v}`)];
  return `${lines.join('\n')}\n`;
}

function dedupe(xs: readonly string[]): string[] {
  return [...new Set(xs)];
}
