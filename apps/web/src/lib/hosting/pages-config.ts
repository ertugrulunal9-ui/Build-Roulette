/**
 * Cloudflare Pages' own files for the static export (T-037), as pure functions:
 * `scripts/pages-config.ts` runs them after `next build` and writes `out/_headers` and
 * `out/_redirects`; the unit tests check them without a build.
 *
 * - `_redirects`: the shells' rewrites (shells.ts).
 * - `_headers`: the security headers of every response, and a long cache for the
 *   content-hashed build output. The app had no server-set security headers before T-037
 *   (`next start` and the Worker sent none but the asset cache rule); a static host can only
 *   send fixed headers, so they are fixed at build time, from the same `NEXT_PUBLIC_*`
 *   values the bundles are built with.
 *
 * The Content-Security-Policy has no `'unsafe-inline'` for scripts: each exported page has
 * two inline scripts (Next's flight data), and their SHA-256 hashes are listed instead. One
 * policy covers every page (about ten hashes in all), so the 404 page and the shells that a
 * rewrite serves under any path get the same one. Pages limits one header line to 2,000
 * characters and a file to 100 rules: `checkHeaders` fails the build before that.
 * https://developers.cloudflare.com/pages/configuration/headers/
 */
import { createHash } from 'node:crypto';

export interface CspSources {
  /** Supabase project URL (REST, Auth, Storage, Realtime). */
  supabaseUrl: string;
  /** The sandbox shell URL (the preview iframe). */
  shellUrl: string;
  /** The package CDN (the bundler worker fetches from it). */
  cdnUrl: string;
  /** Sentry DSN, or null (error reporting off). */
  sentryDsn: string | null;
  /** PostHog host when analytics is on (a key is set), else null. */
  posthogHost: string | null;
  /** Whether Cloudflare Turnstile is on (`NEXT_PUBLIC_TURNSTILE_SITE_KEY`). */
  turnstile: boolean;
  /** `'sha256-…'` of every inline script of the exported pages. */
  scriptHashes: readonly string[];
}

export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

/** Pages limits (https://developers.cloudflare.com/pages/platform/limits/). */
export const PAGES_LIMITS = {
  headerRules: 100,
  headerLineChars: 2_000,
  staticRedirects: 2_000,
  dynamicRedirects: 100,
  fileBytes: 25 * 1024 * 1024,
  files: 20_000,
};

function origin(url: string): string {
  return new URL(url).origin;
}

/** The WebSocket origin of an http(s) origin (Supabase Realtime). */
function wsOrigin(httpOrigin: string): string {
  return httpOrigin.replace(/^http/, 'ws');
}

/** The ingest origin of a Sentry DSN (`https://key@o1.ingest.sentry.io/2` → `https://o1.ingest.sentry.io`). */
export function sentryOrigin(dsn: string | null): string | null {
  if (!dsn) return null;
  try {
    return new URL(dsn).origin;
  } catch {
    return null;
  }
}

/** `'sha256-…'` of every inline `<script>` (one without `src`) in an HTML document. */
export function inlineScriptHashes(html: string): string[] {
  const out: string[] = [];
  const re = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const body = m[1] ?? '';
    out.push(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`);
  }
  return out;
}

/** The values without nulls, empties and repeats, in their first order. */
const unique = (xs: readonly (string | null)[]): string[] => [
  ...new Set(xs.filter((x): x is string => x !== null && x !== '')),
];

/** The app's Content-Security-Policy (see the top of this file). */
export function contentSecurityPolicy(s: CspSources): string {
  const supabase = origin(s.supabaseUrl);
  const turnstile = s.turnstile ? TURNSTILE_ORIGIN : null;
  const directives: [string, ...(string | null)[]][] = [
    ['default-src', "'self'"],
    // Next's chunks, the hashed inline flight data, WebAssembly for the bundler's esbuild.
    ['script-src', "'self'", "'wasm-unsafe-eval'", ...unique(s.scriptHashes).sort(), turnstile],
    ['worker-src', "'self'", 'blob:'],
    // React style attributes and CodeMirror's injected <style> elements.
    ['style-src', "'self'", "'unsafe-inline'"],
    // Screenshots in Supabase Storage; ship-time thumbnails are blob:/data: URLs.
    ['img-src', "'self'", 'data:', 'blob:', supabase],
    ['font-src', "'self'", 'data:'],
    [
      'connect-src',
      "'self'",
      supabase,
      wsOrigin(supabase),
      origin(s.cdnUrl),
      sentryOrigin(s.sentryDsn),
      s.posthogHost ? origin(s.posthogHost) : null,
      turnstile,
    ],
    // The sandbox shell (previews run there, a different site) and the Turnstile widget.
    ['frame-src', origin(s.shellUrl), turnstile],
    ['object-src', "'none'"],
    ['base-uri', "'self'"],
    ['form-action', "'self'"],
    // Nothing frames the app (clickjacking).
    ['frame-ancestors', "'none'"],
  ];
  return directives
    .map(([name, ...values]) => [name, ...unique(values)].join(' '))
    .join('; ');
}

/**
 * Features the app never uses, refused for it and every frame in it. The sandbox iframe's
 * own `allow` (autoplay, fullscreen, gamepad, clipboard-write: @br/runtime) is left alone.
 */
export const PERMISSIONS_POLICY =
  'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=(), midi=(), display-capture=(), browsing-topics=()';

export interface HeaderRule {
  path: string;
  headers: [string, string][];
}

/** The `_headers` rules (see the top of this file). */
export function headerRules(csp: string): HeaderRule[] {
  return [
    {
      path: '/*',
      headers: [
        ['Content-Security-Policy', csp],
        ['X-Content-Type-Options', 'nosniff'],
        ['X-Frame-Options', 'DENY'],
        ['Referrer-Policy', 'strict-origin-when-cross-origin'],
        ['Permissions-Policy', PERMISSIONS_POLICY],
        ['Cross-Origin-Opener-Policy', 'same-origin'],
        ['Strict-Transport-Security', 'max-age=31536000'],
      ],
    },
    // Content-hashed build output: cache for a year (a new build has new names).
    {
      path: '/_next/static/*',
      headers: [['Cache-Control', 'public, max-age=31536000, immutable']],
    },
    // The moderators' pages: never indexed (they are not linked from anywhere either).
    { path: '/admin', headers: [['X-Robots-Tag', 'noindex, nofollow']] },
    { path: '/admin/*', headers: [['X-Robots-Tag', 'noindex, nofollow']] },
  ];
}

/** The `_headers` file text. */
export function headersFile(rules: readonly HeaderRule[]): string {
  return `${rules
    .map((r) => [r.path, ...r.headers.map(([k, v]) => `  ${k}: ${v}`)].join('\n'))
    .join('\n\n')}\n`;
}

/** Problems with the `_headers` rules against Pages' limits (empty: fine). */
export function checkHeaders(rules: readonly HeaderRule[]): string[] {
  const problems: string[] = [];
  if (rules.length > PAGES_LIMITS.headerRules) {
    problems.push(`${String(rules.length)} header rules (Pages allows ${String(PAGES_LIMITS.headerRules)})`);
  }
  for (const r of rules) {
    for (const [k, v] of r.headers) {
      const line = `${k}: ${v}`;
      if (line.length > PAGES_LIMITS.headerLineChars) {
        problems.push(
          `${r.path} ${k} is ${String(line.length)} characters (Pages allows ${String(PAGES_LIMITS.headerLineChars)})`,
        );
      }
    }
  }
  return problems;
}

/**
 * Supabase keys that must never ship to the browser, found in a file's text: a JWT whose role
 * is not `anon` (the service-role key, or any signed user token), or a new-style secret key
 * (`sb_secret_…`). The anon/publishable key is public by design.
 */
export function secretKeysIn(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/eyJ[A-Za-z0-9_-]{10,}\.(eyJ[A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+/g)) {
    try {
      const payload = JSON.parse(Buffer.from(m[1] ?? '', 'base64url').toString('utf8')) as {
        role?: unknown;
      };
      if (payload.role !== 'anon') found.push(`a JWT with role ${JSON.stringify(payload.role)}`);
    } catch {
      // not a JWT
    }
  }
  if (/sb_secret_[A-Za-z0-9_-]{8,}/.test(text)) found.push('an sb_secret_ key');
  return found;
}
