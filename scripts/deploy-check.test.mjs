// Unit tests of scripts/deploy-check.mjs (T-036): argument parsing, the CSP and <head>
// parsers, the keep-alive reading, the header checks, and every check end to end against
// local stand-ins of the app, the shell and Supabase (healthy, then broken one way at a time).
//   node --test scripts/deploy-check.test.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';
import {
  baseUrl,
  checkAppHeaders,
  checkShellHeaders,
  classifyKeepAlive,
  cspHas,
  decodeEntities,
  formatResults,
  parseArgs,
  parseCsp,
  parseHead,
  runChecks,
  shellUrl,
} from './deploy-check.mjs';

const KEY = ['eyJhbGciOiJIUzI1NiJ9', 'eyJyb2xlIjoiYW5vbiJ9', 'c2lnbmF0dXJl'].join('.');
const ARGS = [
  '--app',
  'https://app.example/',
  '--shell',
  'https://sandbox.example/v1',
  '--supabase',
  'https://ref.supabase.co',
];

describe('parseArgs', () => {
  it('reads the URLs, normalizes them, and defaults the CDN to esm.sh', () => {
    const cfg = parseArgs([...ARGS, '--anon-key', KEY]);
    assert.equal(cfg.app, 'https://app.example');
    assert.equal(cfg.shell, 'https://sandbox.example/v1/');
    assert.equal(cfg.supabase, 'https://ref.supabase.co');
    assert.equal(cfg.cdn, 'https://esm.sh');
    assert.equal(cfg.site, null);
    assert.equal(cfg.anonKey, KEY);
    assert.equal(cfg.cronSecret, null);
    assert.equal(cfg.battle, null);
    assert.equal(cfg.json, false);
  });

  it('takes the key and the cron secret from the environment, and --x=value', () => {
    const cfg = parseArgs([...ARGS, '--json', '--site=https://buildroulette.example'], {
      SUPABASE_ANON_KEY: KEY,
      JOBS_CRON_SECRET: 's'.repeat(64),
    });
    assert.equal(cfg.anonKey, KEY);
    assert.equal(cfg.cronSecret, 's'.repeat(64));
    assert.equal(cfg.site, 'https://buildroulette.example');
    assert.equal(cfg.json, true);
  });

  it('refuses missing settings, unknown arguments and bad values', () => {
    assert.throws(() => parseArgs(ARGS), /missing --anon-key/);
    assert.throws(
      () => parseArgs(['--app', 'https://a.example']),
      /missing --shell, --supabase, --anon-key/,
    );
    assert.throws(() => parseArgs([...ARGS, '--anon-key', KEY, '--nope', '1']), /unknown argument/);
    assert.throws(() => parseArgs([...ARGS, '--anon-key']), /--anon-key needs a value/);
    assert.throws(() => parseArgs([...ARGS, '--anon-key', KEY, '--battle', '42']), /UUID/);
    assert.deepEqual(parseArgs(['--help']), { help: true });
  });

  it('wants plain http(s) URLs and the shell with its version path', () => {
    assert.throws(() => baseUrl('ftp://x.example', '--app'), /http\(s\)/);
    assert.throws(() => baseUrl('https://u:p@x.example', '--app'), /plain URL/);
    assert.throws(() => baseUrl('https://x.example/?q=1', '--app'), /plain URL/);
    assert.throws(() => baseUrl('not a url', '--app'), /not a URL/);
    assert.equal(shellUrl('https://s.example/v1/'), 'https://s.example/v1/');
    assert.throws(() => shellUrl('https://s.example/'), /version path/);
    assert.throws(() => shellUrl('https://s.example/v1/capture'), /version path/);
  });
});

describe('parseCsp / cspHas', () => {
  it('splits directives, keeps the first of a repeated one, falls back to default-src', () => {
    const csp = parseCsp(
      "default-src 'self'; Script-Src 'self' 'wasm-unsafe-eval'  'sha256-x'; script-src *; ;frame-ancestors 'none'",
    );
    assert.deepEqual(csp.get('script-src'), ["'self'", "'wasm-unsafe-eval'", "'sha256-x'"]);
    assert.ok(cspHas(csp, 'frame-ancestors', "'none'"));
    assert.ok(cspHas(csp, 'img-src', "'self'"), 'img-src falls back to default-src');
    assert.ok(!cspHas(csp, 'script-src', '*'));
    assert.equal(parseCsp(null).size, 0);
  });
});

describe('parseHead', () => {
  it('reads og/twitter meta in any attribute order and quoting, the title and the canonical link', () => {
    const html = `<!doctype html><html><head>
      <title>Tomato Time by Ana &amp; Bob</title>
      <meta content="Tomato &quot;Time&quot; by Ana" property="og:title">
      <meta property='og:image' content='https://ref.supabase.co/storage/v1/object/public/screenshots/b/x.webp'/>
      <meta name="twitter:card" content=summary_large_image>
      <meta property="og:title" content="a second og:title is ignored">
      <link href="https://app.example/battles/1" rel="canonical">
      </head><body><meta property="og:description" content="in the body: not read"></body></html>`;
    const head = parseHead(html);
    assert.equal(head.title, 'Tomato Time by Ana & Bob');
    assert.equal(head.meta.get('og:title'), 'Tomato "Time" by Ana');
    assert.equal(
      head.meta.get('og:image'),
      'https://ref.supabase.co/storage/v1/object/public/screenshots/b/x.webp',
    );
    assert.equal(head.meta.get('twitter:card'), 'summary_large_image');
    assert.equal(head.meta.has('og:description'), false);
    assert.equal(head.canonical, 'https://app.example/battles/1');
  });

  it('decodes the five entities the preview escapes, once', () => {
    assert.equal(decodeEntities('&lt;b&gt; &amp;amp; &#39; &#x27; &quot;'), `<b> &amp; ' ' "`);
  });
});

describe('classifyKeepAlive', () => {
  const cases = [
    [200, '{"ok": true, "read_only": false, "at": "2026-10-10T04:23:00Z"}', 'PASS', /writable/],
    [200, '{"ok": false, "read_only": true}', 'FAIL', /READ-ONLY/],
    [200, '<html>', 'FAIL', /not JSON/],
    [200, '{"hello": 1}', 'FAIL', /unexpected/],
    [540, '', 'FAIL', /PAUSED/],
    [402, '', 'FAIL', /restricted/],
    [401, '', 'FAIL', /anon key/],
    [404, '{"code":"PGRST202"}', 'FAIL', /db push/],
    [503, '', 'FAIL', /HTTP 503/],
  ];
  for (const [status, body, level, text] of cases) {
    it(`HTTP ${status} ${body.slice(0, 20)} → ${level}`, () => {
      const c = classifyKeepAlive(status, body);
      assert.equal(c.level, level);
      assert.match(c.text, text);
    });
  }
});

// ─── Stand-ins ──────────────────────────────────────────────────────────────

function appCsp(cfg) {
  const sb = new URL(cfg.supabase).origin;
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval' 'sha256-abc'",
    `img-src 'self' data: blob: ${sb}`,
    `connect-src 'self' ${sb} ${sb.replace(/^http/, 'ws')} ${new URL(cfg.cdn).origin}`,
    `frame-src ${new URL(cfg.shell).origin}`,
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function appHeaders(cfg) {
  return {
    'content-security-policy': appCsp(cfg),
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    'cross-origin-opener-policy': 'same-origin',
    'strict-transport-security': 'max-age=31536000',
  };
}

const BATTLE = '0b7e1c2a-1111-4222-8333-444455556666';

/** A server whose behaviour `state` changes between tests. */
function standIns() {
  const state = {};
  const servers = {};
  const reset = () => {
    Object.assign(state, {
      appHeaders: true,
      fn: true,
      fnReachesSupabase: true,
      shellSecret: true,
      paused: false,
      readOnly: false,
      anonymous: true,
      jobs: 'ours',
      requests: [],
    });
  };
  reset();
  const cfg = () => state.cfg;
  const handlers = {
    app(req, res) {
      const url = new URL(req.url, 'http://x');
      const h = state.appHeaders ? appHeaders(cfg()) : {};
      if (url.pathname.startsWith('/battles/') && state.fn) {
        const id = url.pathname.slice('/battles/'.length);
        if (!/^[0-9a-f-]{36}$/.test(id)) {
          res.writeHead(404, { ...h, 'x-br-preview': 'malformed' }).end('<html></html>');
        } else if (!state.fnReachesSupabase) {
          res
            .writeHead(200, { ...h, 'x-br-preview': 'fail-open; reason=timeout' })
            .end('<html></html>');
        } else if (id === BATTLE) {
          const img = `${cfg().supabase}/storage/v1/object/public/screenshots/${BATTLE}/b.webp`;
          res
            .writeHead(200, { ...h, 'content-type': 'text/html', 'x-br-preview': 'battle' })
            .end(
              `<html><head><title>Tomato Time by Ana</title><meta property="og:title" content="Tomato Time by Ana"><meta property="og:url" content="${cfg().app}/battles/${BATTLE}"><meta property="og:image" content="${img}"></head></html>`,
            );
        } else {
          res.writeHead(404, { ...h, 'x-br-preview': 'not-found' }).end('<html></html>');
        }
        return;
      }
      if (
        ['/', '/r/ABCDE', '/admin'].includes(url.pathname) ||
        /^\/u\/[0-9a-f-]{36}$/.test(url.pathname)
      ) {
        const extra = url.pathname === '/admin' ? { 'x-robots-tag': 'noindex, nofollow' } : {};
        res.writeHead(200, { ...h, ...extra, 'content-type': 'text/html' }).end('<html></html>');
        return;
      }
      res.writeHead(404, { ...h, 'content-type': 'text/html' }).end('<html>404</html>');
    },
    shell(req, res) {
      const url = new URL(req.url, 'http://x');
      const csp = `default-src 'none'; script-src 'self' 'unsafe-inline' blob: ${new URL(cfg().cdn).origin}; frame-ancestors ${new URL(cfg().app).origin}`;
      if (url.pathname === '/v1/')
        res.writeHead(200, { 'content-security-policy': csp }).end('<html></html>');
      else if (url.pathname === '/v1/capture') res.writeHead(state.shellSecret ? 403 : 503).end();
      else res.writeHead(404).end();
    },
    supabase(req, res) {
      const url = new URL(req.url, 'http://x');
      state.requests.push({ method: req.method, path: url.pathname, headers: req.headers });
      if (state.paused) {
        res.writeHead(540).end('{"message":"project paused"}');
        return;
      }
      if (url.pathname === '/auth/v1/settings') {
        res.writeHead(200).end(JSON.stringify({ external: { anonymous_users: state.anonymous } }));
      } else if (url.pathname === '/rest/v1/rpc/keep_alive' && req.method === 'POST') {
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ ok: !state.readOnly, read_only: state.readOnly, at: 'now' }));
      } else if (url.pathname === '/functions/v1/jobs' && state.jobs === 'missing') {
        res.writeHead(404).end('{"code":"NOT_FOUND"}');
      } else if (url.pathname === '/functions/v1/jobs' && state.jobs === 'jwt') {
        res.writeHead(401).end('{"code":401,"message":"Missing authorization header"}');
      } else if (url.pathname === '/functions/v1/jobs') {
        const ok = req.headers['x-br-cron-secret'] === 's'.repeat(64);
        res
          .writeHead(ok ? 200 : 401)
          .end(ok ? '{"run":"r1","jobs":[]}' : '{"error":"unauthorized"}');
      } else if (url.pathname.startsWith('/storage/v1/object/public/screenshots/')) {
        res.writeHead(200, { 'content-type': 'image/webp' }).end('RIFF');
      } else {
        res.writeHead(404).end();
      }
    },
  };
  return {
    state,
    reset,
    async start() {
      for (const [name, handler] of Object.entries(handlers)) {
        const server = createServer(handler);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        servers[name] = server;
      }
      const url = (n) => `http://127.0.0.1:${String(servers[n].address().port)}`;
      state.base = { app: url('app'), shell: url('shell'), supabase: url('supabase') };
    },
    async stop() {
      await Promise.all(Object.values(servers).map((s) => new Promise((r) => s.close(r))));
    },
  };
}

describe('runChecks against stand-ins', () => {
  const s = standIns();
  let cfg;
  before(async () => {
    await s.start();
    cfg = parseArgs(
      [
        '--app',
        s.state.base.app,
        '--shell',
        `${s.state.base.shell}/v1/`,
        '--supabase',
        s.state.base.supabase,
        '--battle',
        BATTLE,
        '--cdn',
        'https://esm.sh',
      ],
      { SUPABASE_ANON_KEY: KEY, JOBS_CRON_SECRET: 's'.repeat(64) },
    );
  });
  after(() => s.stop());

  const run = async (change = {}) => {
    s.reset();
    Object.assign(s.state, change, { cfg });
    return runChecks(cfg);
  };
  const failures = (results) => results.filter((r) => r.level === 'FAIL');

  it('a healthy deployment passes every check', async () => {
    const results = await run();
    assert.deepEqual(failures(results), [], formatResults(results));
    assert.ok(results.length >= 30, `${String(results.length)} checks`);
    assert.ok(results.some((r) => r.name.includes('og:image loads') && r.detail === ''));
    // The anon key went in apikey and, being a JWT, in Authorization too; never in a URL.
    const auth = s.state.requests.find((r) => r.path === '/auth/v1/settings');
    assert.equal(auth.headers.apikey, KEY);
    assert.equal(auth.headers.authorization, `Bearer ${KEY}`);
    assert.ok(s.state.requests.every((r) => !r.path.includes(KEY)));
  });

  it('a publishable key goes in apikey only', async () => {
    const pub = { ...cfg, anonKey: 'sb_publishable_' + 'x'.repeat(20) };
    s.reset();
    Object.assign(s.state, { cfg: pub });
    await runChecks(pub);
    const auth = s.state.requests.find((r) => r.path === '/auth/v1/settings');
    assert.equal(auth.headers.authorization, undefined);
  });

  const broken = [
    ['the _headers file is missing', { appHeaders: false }, /content-security-policy.*missing/],
    ['the link-preview Function is missing', { fn: false }, /without x-br-preview/],
    ['the Function cannot reach Supabase', { fnReachesSupabase: false }, /fail-open/],
    ['the shell has no capture secret', { shellSecret: false }, /CAPTURE_HMAC_SECRET/],
    ['the project is paused', { paused: true }, /PAUSED/],
    ['the database is read-only', { readOnly: true }, /READ-ONLY/],
    ['anonymous sign-ins are off', { anonymous: false }, /anonymous sign-ins/],
    ['the jobs function is not deployed', { jobs: 'missing' }, /not deployed/],
    ['the jobs function verifies JWTs', { jobs: 'jwt' }, /--no-verify-jwt/],
  ];
  for (const [what, change, message] of broken) {
    it(`fails when ${what}`, async () => {
      const results = await run(change);
      const f = failures(results);
      assert.ok(f.length > 0, `no failure:\n${formatResults(results)}`);
      assert.ok(
        f.some((r) => message.test(`${r.name} ${r.detail}`)),
        `no failure matching ${String(message)}:\n${formatResults(results)}`,
      );
    });
  }

  it('the header checks name what the build got wrong', () => {
    const other = { ...cfg, supabase: 'https://other.supabase.co' };
    const h = new Headers(appHeaders(cfg));
    const f = failures(checkAppHeaders(h, other));
    assert.ok(f.some((r) => r.name.includes('connect-src https://other.supabase.co')));
    const unsafe = new Headers({
      ...appHeaders(cfg),
      'content-security-policy': appCsp(cfg).replace(
        "'self' 'wasm",
        "'self' 'unsafe-inline' 'wasm",
      ),
    });
    assert.ok(failures(checkAppHeaders(unsafe, cfg)).some((r) => /unsafe-inline/.test(r.detail)));
    const shell = new Headers({
      'content-security-policy': "frame-ancestors https://elsewhere.example; script-src 'self'",
    });
    const sf = failures(checkShellHeaders(shell, cfg));
    assert.equal(sf.length, 2, formatResults(sf));
  });
});
