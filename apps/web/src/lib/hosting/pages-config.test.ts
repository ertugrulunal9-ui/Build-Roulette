/**
 * The static site's host files (T-037): the shells' rewrites, the shell parameter read from
 * the browser's URL, the Content-Security-Policy built from the build's settings and its
 * inline scripts, the `_headers` file and Pages' limits, and the secret-key scan of the
 * export.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PAGES_LIMITS,
  checkHeaders,
  contentSecurityPolicy,
  headerRules,
  headersFile,
  inlineScriptHashes,
  secretKeysIn,
  sentryOrigin,
  type CspSources,
} from './pages-config';
import { SHELLS, pagesRedirects, shellParam } from './shells';

const LOCAL: CspSources = {
  supabaseUrl: 'http://127.0.0.1:54321',
  shellUrl: 'http://127.0.0.1:4321/v1/',
  cdnUrl: 'http://localhost:4322',
  sentryDsn: null,
  posthogHost: null,
  turnstile: false,
  scriptHashes: [],
};

const directive = (csp: string, name: string) =>
  csp
    .split('; ')
    .find((d) => d.startsWith(`${name} `))
    ?.split(' ')
    .slice(1);

describe('shells', () => {
  it('_redirects rewrites each shell path (one segment) to its page, status 200', () => {
    expect(pagesRedirects()).toBe('/r/:code /r 200\n/battles/:id /battles 200\n/u/:id /u 200\n');
    expect(SHELLS.length).toBeLessThanOrEqual(PAGES_LIMITS.dynamicRedirects);
  });

  it('reads the parameter of a shell path as typed', () => {
    expect(shellParam('/battles', '/battles/B0280000-0000-4000-8000-000000000001')).toBe(
      'B0280000-0000-4000-8000-000000000001',
    );
    expect(shellParam('/u', '/u/abc/')).toBe('abc');
    expect(shellParam('/r', '/r/K7%20QXM')).toBe('K7 QXM');
    for (const path of ['/battles', '/battles/', '/battles/a/b', '/battlesx/a', '/u/%E0%A4%A']) {
      expect(shellParam(path.startsWith('/u') ? '/u' : '/battles', path), path).toBe('');
    }
  });
});

describe('the Content-Security-Policy', () => {
  it('locally: the local stack, shell and CDN; no inline scripts but the hashed ones', () => {
    const csp = contentSecurityPolicy({
      ...LOCAL,
      scriptHashes: ["'sha256-b'", "'sha256-a'", "'sha256-b'"],
    });
    expect(directive(csp, 'script-src')).toEqual([
      "'self'",
      "'wasm-unsafe-eval'",
      "'sha256-a'",
      "'sha256-b'",
    ]);
    expect(directive(csp, 'connect-src')).toEqual([
      "'self'",
      'http://127.0.0.1:54321',
      'ws://127.0.0.1:54321',
      'http://localhost:4322',
    ]);
    expect(directive(csp, 'frame-src')).toEqual(['http://127.0.0.1:4321']);
    expect(directive(csp, 'img-src')).toEqual([
      "'self'",
      'data:',
      'blob:',
      'http://127.0.0.1:54321',
    ]);
    expect(directive(csp, 'frame-ancestors')).toEqual(["'none'"]);
    expect(directive(csp, 'object-src')).toEqual(["'none'"]);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-/);
  });

  it('production: https and wss, Sentry, PostHog and Turnstile only when configured', () => {
    const csp = contentSecurityPolicy({
      supabaseUrl: 'https://abc.supabase.co',
      shellUrl: 'https://sandbox.pages.dev/v1/',
      cdnUrl: 'https://esm.sh',
      sentryDsn: 'https://key@o1.ingest.de.sentry.io/42',
      posthogHost: 'https://eu.i.posthog.com',
      turnstile: true,
      scriptHashes: [],
    });
    expect(directive(csp, 'connect-src')).toEqual([
      "'self'",
      'https://abc.supabase.co',
      'wss://abc.supabase.co',
      'https://esm.sh',
      'https://o1.ingest.de.sentry.io',
      'https://eu.i.posthog.com',
      'https://challenges.cloudflare.com',
    ]);
    expect(directive(csp, 'script-src')).toContain('https://challenges.cloudflare.com');
    expect(directive(csp, 'frame-src')).toEqual([
      'https://sandbox.pages.dev',
      'https://challenges.cloudflare.com',
    ]);
    expect(sentryOrigin('not a dsn')).toBeNull();
  });

  it('hashes exactly the inline scripts (not the external ones)', () => {
    const body = '(self.__next_f=self.__next_f||[]).push([0])';
    const html = `<head><script src="/_next/a.js" async=""></script><script>${body}</script></head><body><script>x</script><script id="_R_" src="/b.js"></script></body>`;
    const sha = (s: string) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`;
    expect(inlineScriptHashes(html)).toEqual([sha(body), sha('x')]);
  });
});

describe('_headers', () => {
  const rules = headerRules(contentSecurityPolicy(LOCAL));

  it('security headers on every path, a year for hashed assets, admin pages not indexed', () => {
    const text = headersFile(rules);
    expect(text).toMatch(/^\/\*\n {2}Content-Security-Policy: default-src 'self';/);
    expect(text).toContain('\n  X-Frame-Options: DENY\n');
    expect(text).toContain('\n  X-Content-Type-Options: nosniff\n');
    expect(text).toContain('\n  Referrer-Policy: strict-origin-when-cross-origin\n');
    expect(text).toContain('/_next/static/*\n  Cache-Control: public, max-age=31536000, immutable');
    expect(text).toContain('/admin\n  X-Robots-Tag: noindex, nofollow');
    expect(checkHeaders(rules)).toEqual([]);
  });

  it('a header line over 2,000 characters (too many hashes) fails the build', () => {
    const many = Array.from({ length: 60 }, (_, i) => `'sha256-${String(i).padStart(43, 'x')}='`);
    const big = headerRules(contentSecurityPolicy({ ...LOCAL, scriptHashes: many }));
    expect(checkHeaders(big)).toEqual([
      expect.stringMatching(
        /^\/\* Content-Security-Policy is \d+ characters \(Pages allows 2000\)$/,
      ),
    ]);
  });
});

describe('secret keys in the export', () => {
  const jwt = (payload: object) =>
    `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.c2lnbmF0dXJl`;

  it('the anon key is public; a service-role JWT or an sb_secret_ key is not', () => {
    expect(secretKeysIn(`const k="${jwt({ role: 'anon', iss: 'supabase' })}"`)).toEqual([]);
    expect(secretKeysIn(`const k="${jwt({ role: 'service_role' })}"`)).toEqual([
      'a JWT with role "service_role"',
    ]);
    expect(secretKeysIn('x sb_secret_' + 'abcd1234'.repeat(4))).toEqual(['an sb_secret_ key']);
    expect(secretKeysIn('sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH')).toEqual([]);
  });
});
