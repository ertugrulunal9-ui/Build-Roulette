/**
 * Which links the `import-url` Edge Function may copy (docs/10 §10.3): published sites on the
 * static hosts of the web builders, nothing else. The function is no open proxy and no SSRF
 * tool, so every URL it fetches (the link, every redirect hop, every file) passes
 * `checkPublicUrl` first.
 *
 * One list for the function, the app's hint text and the tests.
 */

/**
 * The allowed hosts: a link's host must be a subdomain of one of these (`my-app.lovable.app`).
 * The apex itself (`lovable.app`) is the builder's own site, not a player's, and is refused.
 * The UI shows them as `*.lovable.app`.
 */
export const IMPORT_URL_HOSTS = [
  'lovable.app',
  'netlify.app',
  'vercel.app',
  'github.io',
  'pages.dev',
  'workers.dev',
  'replit.app',
  'bolt.host',
  'surge.sh',
  'web.app',
  'firebaseapp.com',
  'onrender.com',
  'glitch.me',
  'codesandbox.io',
  'stackblitz.io',
] as const;

/** Longest link accepted, in characters. */
export const MAX_URL_CHARS = 2048;

export type UrlCheckError =
  { code: 'url-invalid'; detail?: string } | { code: 'url-host-not-allowed'; detail?: string };

export type UrlCheck = { ok: true; url: URL } | { ok: false; error: UrlCheckError };

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
/** Hosts that are never public, whatever a list says. */
const LOCAL_SUFFIXES = ['localhost', 'local', 'internal', 'localdomain', 'home.arpa'];

/** Whether `host` (lowercase, as `URL.hostname` gives it) is `suffix` or one of its subdomains. */
function within(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

/**
 * Checks one link against the host rules: `https:` only, the default port, no user name or
 * password, no IP literal (v4 or v6), no local names, and a host that is a subdomain of one of
 * `IMPORT_URL_HOSTS` (suffix match on a label boundary, so `evil-lovable.app` and
 * `lovable.app.evil.com` are refused). Hosts are compared as `URL` normalizes them: lowercase,
 * internationalized names in punycode (`xn--…`). A trailing dot (`x.lovable.app.`) is refused.
 *
 * `extraOrigins` (exact origins such as `http://127.0.0.1:4321`) are accepted as well: the
 * function passes them only in a local test run (supabase/functions/import-url/index.ts).
 */
export function checkPublicUrl(
  input: string | URL,
  extraOrigins: readonly string[] = [],
): UrlCheck {
  let url: URL;
  if (typeof input === 'string') {
    const text = input.trim();
    if (text === '') return { ok: false, error: { code: 'url-invalid', detail: 'empty' } };
    if (text.length > MAX_URL_CHARS) {
      return { ok: false, error: { code: 'url-invalid', detail: 'too long' } };
    }
    try {
      url = new URL(text);
    } catch {
      return { ok: false, error: { code: 'url-invalid' } };
    }
  } else {
    url = new URL(input.href);
  }
  if (extraOrigins.includes(url.origin) && url.username === '' && url.password === '') {
    return { ok: true, url };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, error: { code: 'url-invalid', detail: 'https only' } };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, error: { code: 'url-invalid', detail: 'credentials' } };
  }
  if (url.port !== '') return { ok: false, error: { code: 'url-invalid', detail: 'port' } };
  const host = url.hostname;
  const refused: UrlCheck = { ok: false, error: { code: 'url-host-not-allowed', detail: host } };
  if (host.startsWith('[') || IPV4_RE.test(host)) return refused;
  if (host.endsWith('.') || host.split('.').some((label) => label === '')) return refused;
  if (LOCAL_SUFFIXES.some((s) => within(host, s))) return refused;
  if (!IMPORT_URL_HOSTS.some((s) => host.endsWith(`.${s}`))) return refused;
  return { ok: true, url };
}

/**
 * Where hosts send a visitor who is not signed in (a private deployment, a password page): a
 * redirect there means the site is private, not that it lives elsewhere.
 */
export const LOGIN_HOSTS = [
  'vercel.com',
  'lovable.dev',
  'netlify.com',
  'replit.com',
  'bolt.new',
  'github.com',
  'accounts.google.com',
  'codesandbox.io',
  'stackblitz.com',
  'render.com',
  'cloudflareaccess.com',
] as const;

/** Whether `url` is a known login or access page (see `LOGIN_HOSTS`). */
export function isLoginUrl(url: URL): boolean {
  return LOGIN_HOSTS.some((s) => within(url.hostname, s));
}
