/**
 * The `import-url` Edge Function's request handler (T-051, docs/10 §10.3): copies a player's
 * published site from its link into a site pack. Fetch API only, so it runs in Deno
 * (supabase/functions/import-url/index.ts imports the bundle of this file) and in Node for the
 * unit tests.
 *
 *   POST /functions/v1/import-url
 *   Authorization: Bearer <the user's access token (an anonymous session is fine)>
 *   Content-Type: application/json
 *   {"url": "https://my-app.lovable.app/"}
 *
 *   200  application/octet-stream: the site pack (≤ 5 MB), with
 *        X-Site-Files, X-Site-Bytes, X-Site-Skipped, X-Site-Root (the copied address)
 *   4xx/5xx  application/json {code, detail?}:
 *        400 url-invalid | url-host-not-allowed   (checked before anything is fetched)
 *        401 unauthenticated                      (no or a bad session)
 *        403 origin-not-allowed                   (a browser Origin not in APP_ORIGINS)
 *        405 method-not-allowed
 *        422 url-unreachable | url-not-html | url-private | too-large | too-many-files
 *        429 rate-limited, plus retry_after (seconds; also the Retry-After header and detail)
 *        500 internal                             (configuration, the database)
 *        504 url-timeout
 *
 * Order: the Authorization header must be there (401), the link must pass the host rules
 * (400, no slot used), then `public.claim_import_url()` is called AS THE USER through
 * PostgREST: that verifies the token (401) and takes a rate-limit slot (429) in one round trip
 * (supabase/migrations/…_import_url.sql). Only then is anything fetched.
 *
 * Environment: SUPABASE_URL and SUPABASE_ANON_KEY (set by Supabase), APP_ORIGINS (the app's
 * origins, comma-separated; none: no browser may call it), IMPORT_URL_TEST_HOSTS (local test
 * runs only, see `testOrigins`).
 *
 * Logs: one JSON line per request: the outcome, the status, the link's host (never the full
 * link), files, bytes and ms. No user ids, no tokens.
 */
import { copySite, type CopyErrorCode, type CopyLimits, type CopyResult } from '../copy';
import { MAX_URL_CHARS, checkPublicUrl } from '../hosts';

export interface ImportUrlHandlerOptions {
  env: Record<string, string | undefined>;
  /** Used for PostgREST and for the copy (tests pass a fake). Default: the global fetch. */
  fetch?: typeof fetch;
  /** One log line (JSON) at a time; default console.log. */
  write?: (line: string) => void;
  now?: () => number;
  /** The copy's limits (tests). */
  limits?: Partial<CopyLimits>;
  /** e.g. `deno 2.1.4`, logged with the first request. */
  runtime?: string;
}

export type ImportUrlErrorCode =
  CopyErrorCode | 'unauthenticated' | 'origin-not-allowed' | 'method-not-allowed' | 'internal';

/** The JSON body of every answer but a pack. */
export interface ImportUrlErrorBody {
  code: ImportUrlErrorCode;
  detail?: string;
  /** With `rate-limited`: seconds until the next link may be imported. */
  retry_after?: number;
}

/** Largest request body accepted, in bytes. */
export const MAX_BODY_BYTES = 4096;
/** How long the rate-limit call may take. */
const CLAIM_TIMEOUT_MS = 10_000;
/** The headers a page may read from the answer. */
const EXPOSED = 'retry-after, x-site-files, x-site-bytes, x-site-skipped, x-site-root';
/** Hosts of a local Supabase stack, as the Edge Runtime sees it (`supabase functions serve`). */
const LOCAL_SUPABASE_HOSTS = new Set(['kong', 'localhost', '127.0.0.1', 'host.docker.internal']);

/** The status of each error code. */
export function statusOf(code: ImportUrlErrorCode): number {
  switch (code) {
    case 'url-invalid':
    case 'url-host-not-allowed':
      return 400;
    case 'unauthenticated':
      return 401;
    case 'origin-not-allowed':
      return 403;
    case 'method-not-allowed':
      return 405;
    case 'rate-limited':
      return 429;
    case 'url-timeout':
      return 504;
    case 'internal':
      return 500;
    case 'url-unreachable':
    case 'url-not-html':
    case 'url-private':
    case 'too-large':
    case 'too-many-files':
      return 422;
  }
}

/** `APP_ORIGINS` (`https://a.example, https://b.example`) → normalized origins. */
export function parseOrigins(value: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const part of (value ?? '').split(/[\s,]+/)) {
    if (part === '') continue;
    try {
      const u = new URL(part);
      if (u.protocol === 'https:' || u.protocol === 'http:') out.add(u.origin);
    } catch {
      // not an origin: ignored
    }
  }
  return out;
}

/** Whether SUPABASE_URL is a local stack (`http://kong:8000`), never a hosted project. */
export function isLocalSupabase(supabaseUrl: string | undefined): boolean {
  try {
    const u = new URL(supabaseUrl ?? '');
    return u.protocol === 'http:' && LOCAL_SUPABASE_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

/**
 * The extra origins a local test run may copy from: IMPORT_URL_TEST_HOSTS
 * (`host.docker.internal:4321,127.0.0.1:4321`), honored ONLY when SUPABASE_URL is a local
 * stack. Supabase sets SUPABASE_URL itself (`https://<ref>.supabase.co` in a hosted project;
 * secrets starting with SUPABASE_ cannot be set), so a hosted function never honors it, even
 * if the secret were set by mistake (scripts/deploy also deletes it).
 */
export function testOrigins(env: Record<string, string | undefined>): string[] {
  if (!isLocalSupabase(env['SUPABASE_URL'])) return [];
  const out: string[] = [];
  for (const part of (env['IMPORT_URL_TEST_HOSTS'] ?? '').split(/[\s,]+/)) {
    if (!/^[a-z0-9.-]+:\d{1,5}$/i.test(part)) continue;
    out.push(`http://${part.toLowerCase()}`, `https://${part.toLowerCase()}`);
  }
  return out;
}

function retryAfter(hint: unknown): number | null {
  if (typeof hint !== 'string') return null;
  try {
    const n = (JSON.parse(hint) as { retry_after_s?: unknown } | null)?.retry_after_s;
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.ceil(n) : null;
  } catch {
    return null;
  }
}

type Claim =
  | { ok: true }
  | { ok: false; code: 'unauthenticated' }
  | { ok: false; code: 'rate-limited'; retryAfter: number }
  | { ok: false; code: 'internal'; detail: string };

export function createImportUrlHandler(
  opts: ImportUrlHandlerOptions,
): (req: Request) => Promise<Response> {
  const fetchImpl = opts.fetch ?? fetch;
  const now = opts.now ?? (() => Date.now());
  const write =
    opts.write ??
    ((line: string) => {
      console.log(line);
    });
  const env = opts.env;
  const supabaseUrl = (env['SUPABASE_URL'] ?? '').replace(/\/+$/, '');
  const anonKey = env['SUPABASE_ANON_KEY'] ?? '';
  const appOrigins = parseOrigins(env['APP_ORIGINS']);
  const extra = testOrigins(env);
  const missing = [
    ...(supabaseUrl ? [] : ['SUPABASE_URL']),
    ...(anonKey ? [] : ['SUPABASE_ANON_KEY']),
  ];
  let first = true;

  const log = (fields: Record<string, unknown>) => {
    const boot = first
      ? {
          ...(opts.runtime ? { runtime: opts.runtime } : {}),
          origins: appOrigins.size,
          ...(extra.length ? { testHosts: extra.length / 2 } : {}),
          ...(env['IMPORT_URL_TEST_HOSTS'] && !extra.length ? { testHostsIgnored: true } : {}),
        }
      : {};
    first = false;
    write(JSON.stringify({ t: new Date().toISOString(), svc: 'import-url', ...fields, ...boot }));
  };

  const cors = (origin: string | null): Record<string, string> =>
    origin !== null && appOrigins.has(origin)
      ? {
          'access-control-allow-origin': origin,
          'access-control-expose-headers': EXPOSED,
          vary: 'Origin',
        }
      : { vary: 'Origin' };

  const json = (
    status: number,
    body: ImportUrlErrorBody,
    origin: string | null,
    extraHeaders: Record<string, string> = {},
  ): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        ...cors(origin),
        ...extraHeaders,
      },
    });

  const claim = async (token: string): Promise<Claim> => {
    let res: Response;
    try {
      res = await fetchImpl(`${supabaseUrl}/rest/v1/rpc/claim_import_url`, {
        method: 'POST',
        headers: {
          apikey: anonKey,
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: '{}',
        signal: AbortSignal.timeout(CLAIM_TIMEOUT_MS),
      });
    } catch (e) {
      return { ok: false, code: 'internal', detail: e instanceof Error ? e.name : 'fetch' };
    }
    const text = await res.text().catch(() => '');
    if (res.ok) return { ok: true };
    let body: { code?: unknown; hint?: unknown } = {};
    try {
      body = (JSON.parse(text) as typeof body | null) ?? {};
    } catch {
      // not JSON (a gateway error)
    }
    const code = typeof body.code === 'string' ? body.code : '';
    if (res.status === 429 || code === 'PT429') {
      return { ok: false, code: 'rate-limited', retryAfter: retryAfter(body.hint) ?? 60 };
    }
    // PostgREST's own answers about the token or the role: 42501 (not_authenticated, or anon
    // has no EXECUTE), PGRST3xx (a missing, bad or expired JWT). Anything else (a gateway that
    // refuses the API key, a missing function) is the function's problem, not the caller's.
    if (
      (res.status === 401 || res.status === 403) &&
      (code === '42501' || code.startsWith('PGRST3'))
    ) {
      return { ok: false, code: 'unauthenticated' };
    }
    return { ok: false, code: 'internal', detail: `claim ${String(res.status)} ${code}`.trim() };
  };

  return async (req: Request): Promise<Response> => {
    const started = now();
    const origin = req.headers.get('origin');
    const done = (res: Response, fields: Record<string, unknown>): Response => {
      log({ status: res.status, ms: Math.round(now() - started), ...fields });
      return res;
    };
    const failWith = (
      code: ImportUrlErrorCode,
      fields: Record<string, unknown> = {},
      detail?: string,
    ): Response =>
      done(json(statusOf(code), detail === undefined ? { code } : { code, detail }, origin), {
        outcome: code,
        ...fields,
      });

    if (origin !== null && !appOrigins.has(origin)) return failWith('origin-not-allowed');
    if (req.method === 'OPTIONS') {
      return done(
        new Response(null, {
          status: 204,
          headers: {
            ...cors(origin),
            'access-control-allow-methods': 'POST, OPTIONS',
            'access-control-allow-headers':
              'authorization, apikey, content-type, x-client-info, x-region',
            'access-control-max-age': '600',
          },
        }),
        { outcome: 'preflight' },
      );
    }
    if (req.method !== 'POST') return failWith('method-not-allowed');
    if (missing.length) return failWith('internal', { problems: missing });

    const token = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '')?.[1];
    if (!token) return failWith('unauthenticated');

    // The link, checked before anything else is fetched.
    const declared = Number(req.headers.get('content-length') ?? 0);
    if (declared > MAX_BODY_BYTES) return failWith('url-invalid', {}, 'body too large');
    let link: unknown;
    try {
      const text = await req.text();
      if (text.length > MAX_BODY_BYTES) return failWith('url-invalid', {}, 'body too large');
      link = (JSON.parse(text) as { url?: unknown } | null)?.url;
    } catch {
      return failWith('url-invalid', {}, 'body');
    }
    if (typeof link !== 'string' || link.length > MAX_URL_CHARS) {
      return failWith('url-invalid', {}, 'url');
    }
    const checked = checkPublicUrl(link, extra);
    if (!checked.ok) {
      const host = checked.error.code === 'url-host-not-allowed' ? checked.error.detail : undefined;
      return failWith(checked.error.code, host ? { host } : {}, checked.error.detail);
    }
    const host = checked.url.host;

    // The session and the rate limit, in one call as the user.
    const claimed = await claim(token);
    if (!claimed.ok) {
      if (claimed.code === 'rate-limited') {
        const body: ImportUrlErrorBody = {
          code: 'rate-limited',
          detail: String(claimed.retryAfter),
          retry_after: claimed.retryAfter,
        };
        return done(json(429, body, origin, { 'retry-after': String(claimed.retryAfter) }), {
          outcome: 'rate-limited',
          host,
        });
      }
      if (claimed.code === 'internal')
        return failWith('internal', { host, problem: claimed.detail });
      return failWith('unauthenticated', { host });
    }

    let result: CopyResult;
    try {
      result = await copySite(checked.url, {
        fetch: (url, init) => fetchImpl(url, init),
        now,
        signal: req.signal,
        extraOrigins: extra,
        ...(opts.limits ? { limits: opts.limits } : {}),
      });
    } catch (e) {
      return failWith('internal', { host, problem: e instanceof Error ? e.name : 'copy' });
    }
    if (!result.ok) {
      return failWith(result.error.code, { host }, result.error.detail);
    }
    const { site } = result;
    return done(
      new Response(site.pack, {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'cache-control': 'no-store',
          'x-site-files': String(site.files),
          'x-site-bytes': String(site.bytes),
          'x-site-skipped': String(site.skipped),
          'x-site-root': site.root,
          ...cors(origin),
        },
      }),
      { outcome: 'ok', host, files: site.files, bytes: site.bytes, skipped: site.skipped },
    );
  };
}
