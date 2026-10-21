/**
 * The `import-url` Edge Function (T-051) for real: the local Edge Runtime (`supabase functions
 * serve`) runs supabase/functions/import-url, which verifies the session and takes rate-limit
 * slots through PostgREST (public.claim_import_url) and copies a fixture site from a static
 * server on this machine.
 *
 *   pnpm --filter @br/site test:function
 *
 * Needs the local stack WITH the Edge Runtime (`supabase start` without `edge-runtime` in -x,
 * supabase/README.md). The function runs in Docker and reaches the fixture server as
 * http://host.docker.internal:<port>, which the allowlist refuses; the test-only override
 * IMPORT_URL_TEST_HOSTS allows it, and the function honors it only because SUPABASE_URL is the
 * local stack's (http://kong:8000), never in a hosted project.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contentTypeOf } from '../src/content-types';
import { unpackSite } from '../src/pack';
import { VITE_SITE, VITE_SITE_FILES, type FixtureSite } from '../src/test-sites';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const SUPABASE_CLI = 'supabase@2.119.0';
/** Named after `project_id` in supabase/config.toml. */
const EDGE_RUNTIME_CONTAINER = 'supabase_edge_runtime_build-roulette';
const APP_ORIGIN = 'http://localhost:3000';

const SITE: FixtureSite = {
  ...VITE_SITE,
  '/tiny/': '<!doctype html><title>tiny</title>',
  '/away': { status: 302, headers: { location: 'https://evil.example/' } },
  '/login': { status: 302, headers: { location: 'https://vercel.com/login' } },
  '/private/': { status: 401, body: 'sign in' },
  '/data.json': '{"not":"html"}',
};

interface StackEnv {
  API_URL: string;
  ANON_KEY: string;
}

function loadStackEnv(): StackEnv {
  const env: Partial<StackEnv> = {
    ...(process.env['API_URL'] ? { API_URL: process.env['API_URL'] } : {}),
    ...(process.env['ANON_KEY'] ? { ANON_KEY: process.env['ANON_KEY'] } : {}),
  };
  if (!env.API_URL || !env.ANON_KEY) {
    const out = execFileSync('npx', ['-y', SUPABASE_CLI, 'status', '-o', 'env'], {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const line of out.split('\n')) {
      const m = /^([A-Z_]+)="?(.*?)"?$/.exec(line.trim());
      if (m?.[1] === 'API_URL' && m[2]) env.API_URL ??= m[2];
      if (m?.[1] === 'ANON_KEY' && m[2]) env.ANON_KEY ??= m[2];
    }
  }
  if (!env.API_URL || !env.ANON_KEY) throw new Error('is the local stack running?');
  return { API_URL: env.API_URL, ANON_KEY: env.ANON_KEY };
}

/** A static host for fixture sites on 0.0.0.0 (the Edge Runtime container must reach it). */
async function serveSite(
  site: FixtureSite,
): Promise<{ server: Server; port: number; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture');
    hits.push(url.pathname + url.search);
    const r = site[url.pathname + url.search] ?? site[url.pathname];
    const spec = typeof r === 'string' ? { body: r } : (r ?? { status: 404, body: 'Not found' });
    const status = spec.status ?? 200;
    const headers: Record<string, string> = { ...spec.headers };
    if (!headers['content-type'] && status === 200) {
      headers['content-type'] = url.pathname.endsWith('/')
        ? 'text/html; charset=utf-8'
        : contentTypeOf(url.pathname);
    }
    res.writeHead(status, headers);
    res.end(spec.body ?? '');
  });
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
  return { server, port: (server.address() as AddressInfo).port, hits };
}

function edgeRuntimeRunning(): boolean {
  try {
    execFileSync('docker', ['inspect', EDGE_RUNTIME_CONTAINER], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

interface Served {
  url: string;
  stop(): Promise<void>;
  log(): string;
}

/** `supabase functions serve` with an env file, ready when import-url answers 401. */
async function serveFunctions(apiUrl: string, env: Record<string, string>): Promise<Served> {
  const dir = mkdtempSync(join(tmpdir(), 'br-import-url-fn-'));
  const envFile = join(dir, 'functions.env');
  writeFileSync(
    envFile,
    Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
  );
  let out = '';
  const child: ChildProcess = spawn(
    'npx',
    ['-y', SUPABASE_CLI, 'functions', 'serve', '--env-file', envFile],
    { cwd: REPO, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout?.on('data', (c: Buffer) => (out += c.toString()));
  child.stderr?.on('data', (c: Buffer) => (out += c.toString()));
  const url = `${apiUrl}/functions/v1/import-url`;

  const stop = async () => {
    try {
      execFileSync('docker', ['rm', '-f', EDGE_RUNTIME_CONTAINER], { stdio: 'ignore' });
    } catch {
      // not running
    }
    if (child.exitCode === null && child.pid !== undefined) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        // already gone
      }
      await Promise.race([exited, new Promise((r) => setTimeout(r, 20_000))]);
    }
    for (let i = 0; i < 60 && edgeRuntimeRunning(); i++) {
      await new Promise((r) => setTimeout(r, 500));
    }
    rmSync(dir, { recursive: true, force: true });
  };

  const deadline = Date.now() + 90_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`functions serve exited:\n${out}`);
    if (out.includes('Serving functions on')) {
      const status = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(5_000) })
        .then(async (r) => ((await r.text()).includes('unauthenticated') ? r.status : 0))
        .catch(() => 0);
      if (status === 401) break;
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`the import-url function did not come up:\n${out}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { url, stop, log: () => out };
}

let stack: StackEnv;
let fixture: Awaited<ReturnType<typeof serveSite>>;
let fn: Served;
/** The link the function uses for the fixture server. */
let base: string;

async function anonymousToken(): Promise<string> {
  const res = await fetch(`${stack.API_URL}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: stack.ANON_KEY, 'content-type': 'application/json' },
    body: '{}',
  });
  const body = (await res.json()) as { access_token?: string };
  if (!res.ok || !body.access_token) throw new Error(`anonymous sign-up failed: ${res.status}`);
  return body.access_token;
}

async function importUrl(
  url: string,
  token: string | null,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(fn.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...headers,
    },
    body: JSON.stringify({ url }),
    signal: AbortSignal.timeout(60_000),
  });
}

async function codeOf(
  res: Response,
): Promise<{ code: string; detail?: string; retry_after?: number }> {
  return (await res.json()) as { code: string; detail?: string; retry_after?: number };
}

beforeAll(async () => {
  stack = loadStackEnv();
  fixture = await serveSite(SITE);
  base = `http://host.docker.internal:${String(fixture.port)}`;
  fn = await serveFunctions(stack.API_URL, {
    APP_ORIGINS: APP_ORIGIN,
    IMPORT_URL_TEST_HOSTS: `host.docker.internal:${String(fixture.port)}`,
  });
});

afterAll(async () => {
  await fn.stop();
  await new Promise((r) => fixture.server.close(r));
});

describe('the import-url Edge Function', () => {
  it('401 without a session, and with the anon key alone (PostgREST refuses it)', async () => {
    const none = await importUrl(`${base}/`, null);
    expect(none.status).toBe(401);
    expect(await codeOf(none)).toEqual({ code: 'unauthenticated' });
    const anon = await importUrl(`${base}/`, stack.ANON_KEY);
    expect(anon.status).toBe(401);
    expect(await codeOf(anon)).toEqual({ code: 'unauthenticated' });
    const forged = await importUrl(`${base}/`, `${stack.ANON_KEY.slice(0, -4)}AAAA`);
    expect(forged.status).toBe(401);
    expect(fixture.hits).toEqual([]);
  });

  it('400 for a host that is not allowed, and for a redirect off the allowed hosts', async () => {
    const token = await anonymousToken();
    const res = await importUrl('https://example.com/', token);
    expect(res.status).toBe(400);
    expect(await codeOf(res)).toEqual({ code: 'url-host-not-allowed', detail: 'example.com' });
    const ip = await importUrl('http://127.0.0.1:54321/', token);
    expect(ip.status).toBe(400);
    const away = await importUrl(`${base}/away`, token);
    expect(away.status).toBe(400);
    expect(await codeOf(away)).toEqual({ code: 'url-host-not-allowed', detail: 'evil.example' });
  });

  it('422 for a private site, a login redirect and a link that is not a page', async () => {
    const token = await anonymousToken();
    const priv = await importUrl(`${base}/private/`, token);
    expect(priv.status).toBe(422);
    expect(await codeOf(priv)).toEqual({ code: 'url-private', detail: '401' });
    const login = await importUrl(`${base}/login`, token);
    expect(await codeOf(login)).toEqual({ code: 'url-private', detail: 'vercel.com' });
    const json = await importUrl(`${base}/data.json`, token);
    expect(json.status).toBe(422);
    expect((await codeOf(json)).code).toBe('url-not-html');
    const missing = await importUrl(`${base}/nope/`, token);
    expect(await codeOf(missing)).toEqual({ code: 'url-unreachable', detail: '404' });
  });

  it('copies a Vite build into a site pack', async () => {
    const token = await anonymousToken();
    const res = await importUrl(`${base}/`, token, { origin: APP_ORIGIN });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    // og.png is an absolute link to the real lovable.app address: another origin here.
    const expected = VITE_SITE_FILES.filter((f) => f !== 'og.png');
    expect(res.headers.get('x-site-files')).toBe(String(expected.length));
    expect(res.headers.get('x-site-root')).toBe(`${base}/`);
    const files = unpackSite(await res.arrayBuffer());
    expect([...files.keys()].sort()).toEqual(expected);
    expect(new TextDecoder().decode(files.get('assets/vendor-def.js')?.bytes)).toBe(
      VITE_SITE['/assets/vendor-def.js'],
    );
  });

  // The local gateway (Kong) has its own CORS plugin, which answers preflights and sets
  // `Access-Control-Allow-Origin: *` on every route; a hosted project's gateway leaves CORS to
  // the function. So the function's CORS headers are covered by the unit tests
  // (src/import-url/handler.test.ts), and here only its origin check.
  it('refuses a browser origin that is not the app, before using a slot', async () => {
    const token = await anonymousToken();
    const other = await importUrl(`${base}/tiny/`, token, { origin: 'https://evil.example' });
    expect(other.status).toBe(403);
    expect(await codeOf(other)).toEqual({ code: 'origin-not-allowed' });
    const app = await importUrl(`${base}/tiny/`, token, { origin: APP_ORIGIN });
    expect(app.status).toBe(200);
    expect(unpackSite(await app.arrayBuffer()).has('index.html')).toBe(true);
  });

  it('allows 20 links per user in 10 minutes, then 429 with retry_after', async () => {
    const token = await anonymousToken();
    // A refused link does not use a slot.
    expect((await importUrl('https://lovable.app/', token)).status).toBe(400);
    for (let i = 0; i < 20; i++) {
      const res = await importUrl(`${base}/tiny/`, token);
      expect(res.status, `import ${String(i + 1)}`).toBe(200);
      await res.arrayBuffer();
    }
    const limited = await importUrl(`${base}/tiny/`, token);
    expect(limited.status).toBe(429);
    const body = await codeOf(limited);
    expect(body.code).toBe('rate-limited');
    expect(body.retry_after).toBeGreaterThan(500);
    expect(body.retry_after).toBeLessThanOrEqual(600);
    expect(limited.headers.get('retry-after')).toBe(String(body.retry_after));
    // Another player is not limited.
    expect((await importUrl(`${base}/tiny/`, await anonymousToken())).status).toBe(200);
  });

  it('logs one line per request: host, outcome, numbers; no link paths, tokens or user ids', () => {
    const lines = fn
      .log()
      .split('\n')
      .filter((l) => l.includes('"svc":"import-url"'));
    expect(lines.length).toBeGreaterThan(25);
    const all = lines.join('\n');
    expect(all).toContain('"outcome":"ok"');
    expect(all).toContain('"outcome":"rate-limited"');
    expect(all).toContain(`"host":"host.docker.internal:${String(fixture.port)}"`);
    expect(all).toContain('"testHosts":1');
    expect(all).not.toContain('/tiny/');
    expect(all).not.toContain(stack.ANON_KEY);
    expect(all).not.toMatch(/eyJ[\w-]{10,}/);
    expect(all).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });
});
