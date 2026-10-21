import { describe, expect, it } from 'vitest';
import { unpackSite } from '../pack';
import { VITE_SITE, VITE_SITE_FILES, fakeHost } from '../test-sites';
import {
  createImportUrlHandler,
  isLocalSupabase,
  parseOrigins,
  statusOf,
  testOrigins,
  type ImportUrlErrorBody,
} from './handler';

const SUPABASE = 'https://abcdefghijklmnopqrst.supabase.co';
const APP = 'https://buildroulette.example.workers.dev';
const SITE = 'https://my-app.lovable.app';
const ANON = ['anon', 'key', 'for', 'tests'].join('-');
const TOKEN = ['user', 'token'].join('-');

interface ClaimAnswer {
  status: number;
  body?: unknown;
}

function setup(
  opts: {
    claim?: (token: string) => ClaimAnswer;
    env?: Record<string, string | undefined>;
    sites?: Parameters<typeof fakeHost>[0];
  } = {},
) {
  const lines: Record<string, unknown>[] = [];
  const claims: { apikey: string | null; authorization: string | null }[] = [];
  const host = fakeHost(opts.sites ?? { [SITE]: VITE_SITE });
  const claim = opts.claim ?? ((): ClaimAnswer => ({ status: 204 }));
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === `${SUPABASE}/rest/v1/rpc/claim_import_url`) {
      const h = new Headers(init?.headers);
      claims.push({ apikey: h.get('apikey'), authorization: h.get('authorization') });
      const a = claim((h.get('authorization') ?? '').replace(/^Bearer /, ''));
      return new Response(a.body === undefined ? null : JSON.stringify(a.body), {
        status: a.status,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.startsWith(SUPABASE)) throw new Error(`unexpected ${url}`);
    return host.fetch(url, init as Parameters<typeof host.fetch>[1]);
  }) as typeof fetch;
  const handler = createImportUrlHandler({
    env: {
      SUPABASE_URL: SUPABASE,
      SUPABASE_ANON_KEY: ANON,
      APP_ORIGINS: `${APP}, http://localhost:3000`,
      ...opts.env,
    },
    fetch: fetchImpl,
    write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { handler, lines, claims, host };
}

function post(
  body: unknown,
  headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` },
): Request {
  return new Request(`${SUPABASE}/functions/v1/import-url`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function errorOf(res: Response): Promise<ImportUrlErrorBody> {
  expect(res.headers.get('content-type')).toBe('application/json');
  return (await res.json()) as ImportUrlErrorBody;
}

describe('the import-url handler', () => {
  it('copies a site: 200 with the pack and its numbers, after claiming a slot as the user', async () => {
    const { handler, lines, claims } = setup();
    const res = await handler(
      post({ url: `${SITE}/` }, { authorization: `Bearer ${TOKEN}`, origin: APP }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('x-site-files')).toBe(String(VITE_SITE_FILES.length));
    expect(res.headers.get('x-site-root')).toBe(`${SITE}/`);
    expect(res.headers.get('access-control-allow-origin')).toBe(APP);
    expect(res.headers.get('access-control-expose-headers')).toContain('x-site-files');
    const files = unpackSite(await res.arrayBuffer());
    expect([...files.keys()].sort()).toEqual(VITE_SITE_FILES);
    expect(claims).toEqual([{ apikey: ANON, authorization: `Bearer ${TOKEN}` }]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      svc: 'import-url',
      outcome: 'ok',
      status: 200,
      host: 'my-app.lovable.app',
      files: VITE_SITE_FILES.length,
    });
    expect(typeof lines[0]?.['ms']).toBe('number');
    expect(typeof lines[0]?.['bytes']).toBe('number');
  });

  it('logs no full link, user id or token', async () => {
    const { handler, lines } = setup();
    await handler(post({ url: `${SITE}/?secret=abc#x` }));
    await handler(post({ url: 'https://example.com/private?q=1' }));
    const text = JSON.stringify(lines);
    expect(text).not.toContain('secret=abc');
    expect(text).not.toContain('private');
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(ANON);
    expect(lines.map((l) => l['outcome'])).toEqual(['ok', 'url-host-not-allowed']);
  });

  it('401 without a bearer token, without calling anything', async () => {
    const { handler, claims, host } = setup();
    for (const headers of [{}, { authorization: 'Basic abc' }, { authorization: 'Bearer' }]) {
      const res = await handler(post({ url: `${SITE}/` }, headers));
      expect(res.status).toBe(401);
      expect(await errorOf(res)).toEqual({ code: 'unauthenticated' });
    }
    expect(claims).toEqual([]);
    expect(host.calls).toEqual([]);
  });

  it('401 when PostgREST refuses the token or the role, before copying', async () => {
    for (const body of [
      { code: 'PGRST301', message: 'JWSError' },
      { code: 'PGRST303', message: 'JWT expired' },
      { code: '42501', message: 'permission denied for function claim_import_url' },
    ]) {
      const { handler, host } = setup({ claim: () => ({ status: 401, body }) });
      const res = await handler(post({ url: `${SITE}/` }));
      expect(res.status).toBe(401);
      expect(await errorOf(res)).toEqual({ code: 'unauthenticated' });
      expect(host.calls).toEqual([]);
    }
    const authed = setup({
      claim: () => ({ status: 403, body: { code: '42501', message: 'not_authenticated' } }),
    });
    expect((await authed.handler(post({ url: `${SITE}/` }))).status).toBe(401);
  });

  it('500 (not 401) when the gateway refuses the API key: a broken deploy, not a caller', async () => {
    const { handler, lines } = setup({
      claim: () => ({ status: 401, body: { message: 'Invalid API key' } }),
    });
    const res = await handler(post({ url: `${SITE}/` }));
    expect(res.status).toBe(500);
    expect(await errorOf(res)).toEqual({ code: 'internal' });
    expect(lines[0]).toMatchObject({ outcome: 'internal', problem: 'claim 401' });
  });

  it('429 with retry_after when the rate limit is reached', async () => {
    const { handler, host } = setup({
      claim: () => ({
        status: 429,
        body: {
          code: 'PT429',
          message: 'rate_limited',
          details: 'You sent too many site links recently. Try again in 3 minutes.',
          hint: '{"retry_after_s": 157}',
        },
      }),
    });
    const res = await handler(
      post({ url: `${SITE}/` }, { authorization: `Bearer ${TOKEN}`, origin: APP }),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('157');
    expect(res.headers.get('access-control-allow-origin')).toBe(APP);
    expect(await errorOf(res)).toEqual({ code: 'rate-limited', detail: '157', retry_after: 157 });
    expect(host.calls).toEqual([]);
  });

  it('400 for a bad body or a link that is not allowed, without using a slot', async () => {
    const { handler, claims, host } = setup();
    const cases: [unknown, string][] = [
      ['not json', 'url-invalid'],
      [{}, 'url-invalid'],
      [{ url: 42 }, 'url-invalid'],
      [{ url: 'nope' }, 'url-invalid'],
      [{ url: 'http://my-app.lovable.app/' }, 'url-invalid'],
      [{ url: 'https://example.com/' }, 'url-host-not-allowed'],
      [{ url: 'https://lovable.app/' }, 'url-host-not-allowed'],
      [{ url: 'https://169.254.169.254/' }, 'url-host-not-allowed'],
      [{ url: `${SITE}/${'a'.repeat(3000)}` }, 'url-invalid'],
    ];
    for (const [body, code] of cases) {
      const res = await handler(post(body));
      expect(res.status, JSON.stringify(body).slice(0, 40)).toBe(400);
      expect((await errorOf(res)).code).toBe(code);
    }
    const big = await handler(post({ url: `${SITE}/`, pad: 'x'.repeat(5000) }));
    expect(big.status).toBe(400);
    expect(claims).toEqual([]);
    expect(host.calls).toEqual([]);
  });

  it('422 for copy failures, 504 for a timeout', async () => {
    const notFound = setup({ sites: { [SITE]: {} } });
    let res = await notFound.handler(post({ url: `${SITE}/` }));
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toEqual({ code: 'url-unreachable', detail: '404' });
    const priv = setup({ sites: { [SITE]: { '/': { status: 401 } } } });
    res = await priv.handler(post({ url: `${SITE}/` }));
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe('url-private');
    const redirected = setup({
      sites: { [SITE]: { '/': { status: 302, headers: { location: 'https://evil.example/' } } } },
    });
    res = await redirected.handler(post({ url: `${SITE}/` }));
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe('url-host-not-allowed');
    const slow = createImportUrlHandler({
      env: { SUPABASE_URL: SUPABASE, SUPABASE_ANON_KEY: ANON },
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/rest/v1/')) return Promise.resolve(new Response(null, { status: 204 }));
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
      },
      write: () => undefined,
      limits: { requestTimeoutMs: 30 },
    });
    res = await slow(post({ url: `${SITE}/` }));
    expect(res.status).toBe(504);
    expect((await errorOf(res)).code).toBe('url-timeout');
  });

  it('CORS: preflights for the app origins, nothing for others; no Origin is fine', async () => {
    const { handler, claims } = setup();
    const pre = await handler(
      new Request(`${SUPABASE}/functions/v1/import-url`, {
        method: 'OPTIONS',
        headers: {
          origin: APP,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization, content-type, apikey, x-client-info',
        },
      }),
    );
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe(APP);
    expect(pre.headers.get('access-control-allow-methods')).toContain('POST');
    expect(pre.headers.get('access-control-allow-headers')).toContain('authorization');
    const local = await handler(
      new Request(`${SUPABASE}/functions/v1/import-url`, {
        method: 'OPTIONS',
        headers: { origin: 'http://localhost:3000' },
      }),
    );
    expect(local.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    for (const method of ['OPTIONS', 'POST']) {
      const res = await handler(
        new Request(`${SUPABASE}/functions/v1/import-url`, {
          method,
          headers: { origin: 'https://evil.example', authorization: `Bearer ${TOKEN}` },
          ...(method === 'POST' ? { body: JSON.stringify({ url: `${SITE}/` }) } : {}),
        }),
      );
      expect(res.status).toBe(403);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    }
    expect(claims).toEqual([]);
    // Without APP_ORIGINS no browser may call it.
    const closed = setup({ env: { APP_ORIGINS: undefined } });
    const res = await closed.handler(
      post({ url: `${SITE}/` }, { authorization: `Bearer ${TOKEN}`, origin: APP }),
    );
    expect(res.status).toBe(403);
  });

  it('405 for other methods; 500 without its configuration', async () => {
    const { handler } = setup();
    const get = await handler(new Request(`${SUPABASE}/functions/v1/import-url`));
    expect(get.status).toBe(405);
    expect((await errorOf(get)).code).toBe('method-not-allowed');
    const bare = setup({ env: { SUPABASE_URL: undefined } });
    const res = await bare.handler(post({ url: `${SITE}/` }));
    expect(res.status).toBe(500);
    expect(bare.lines[0]).toMatchObject({ outcome: 'internal', problems: ['SUPABASE_URL'] });
  });
});

describe('the test-only hosts', () => {
  it('are honored only on a local stack', () => {
    const hosts = 'host.docker.internal:4321, 127.0.0.1:4321';
    expect(testOrigins({ SUPABASE_URL: 'http://kong:8000', IMPORT_URL_TEST_HOSTS: hosts })).toEqual(
      [
        'http://host.docker.internal:4321',
        'https://host.docker.internal:4321',
        'http://127.0.0.1:4321',
        'https://127.0.0.1:4321',
      ],
    );
    expect(testOrigins({ SUPABASE_URL: SUPABASE, IMPORT_URL_TEST_HOSTS: hosts })).toEqual([]);
    expect(
      testOrigins({ SUPABASE_URL: 'https://kong:8000', IMPORT_URL_TEST_HOSTS: hosts }),
    ).toEqual([]);
    expect(testOrigins({ SUPABASE_URL: 'http://kong:8000' })).toEqual([]);
    expect(
      testOrigins({ SUPABASE_URL: 'http://kong:8000', IMPORT_URL_TEST_HOSTS: 'http://x:1/,a b' }),
    ).toEqual([]);
    expect(isLocalSupabase('http://127.0.0.1:54321')).toBe(true);
    expect(isLocalSupabase('http://kong.evil.com:8000')).toBe(false);
    expect(isLocalSupabase(undefined)).toBe(false);
  });

  it('let a hosted function copy nothing but the allowlist', async () => {
    const local = 'http://127.0.0.1:4321';
    const sites = { [local]: { '/': '<html></html>' } };
    const hosted = setup({ env: { IMPORT_URL_TEST_HOSTS: '127.0.0.1:4321' }, sites });
    const res = await hosted.handler(post({ url: `${local}/` }));
    expect(res.status).toBe(400);
    expect(hosted.lines[0]).toMatchObject({ testHostsIgnored: true });
  });
});

describe('statusOf and parseOrigins', () => {
  it('maps every code', () => {
    expect(statusOf('url-private')).toBe(422);
    expect(statusOf('url-timeout')).toBe(504);
    expect(statusOf('rate-limited')).toBe(429);
    expect([...parseOrigins(' https://a.example/x , http://localhost:3000 nope ftp://x ')]).toEqual(
      ['https://a.example', 'http://localhost:3000'],
    );
  });
});
