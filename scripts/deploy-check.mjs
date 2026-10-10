#!/usr/bin/env node
// Checks a deployment of Build Roulette on the free setup (T-036, DEPLOY.md §9): the web app
// on Cloudflare Pages (headers and CSP, real 404s, the shells, the link-preview Function),
// the sandbox shell (its CSP and the capture gate), and Supabase (the API, anonymous
// sign-ins, the keep-alive RPC, the jobs Edge Function). Read-only, except that it pings
// keep_alive like the daily workflow does. Node 22, no dependencies.
//
//   node scripts/deploy-check.mjs \
//     --app https://build-roulette-web.pages.dev \
//     --shell https://build-roulette-sandbox.pages.dev/v1/ \
//     --supabase https://<ref>.supabase.co --anon-key <anon or publishable key> \
//     [--cdn https://esm.sh] [--site https://<the address people share>] \
//     [--battle <id of a finished battle>] [--cron-secret <JOBS_CRON_SECRET>] [--json]
//
// The anon key and the cron secret can also come from SUPABASE_ANON_KEY and JOBS_CRON_SECRET
// (keeps them out of the shell history). Exit 0 when nothing FAILs (WARNs are allowed).
// Unit tests: node --test scripts/deploy-check.test.mjs (also part of `pnpm test`).

import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const DEFAULT_CDN = 'https://esm.sh';
const TIMEOUT_MS = 15_000;

// ─── Arguments ─────────────────────────────────────────────────────────────

const USAGE = `usage: node scripts/deploy-check.mjs --app <url> --shell <url> --supabase <url> --anon-key <key>
       [--cdn <url>] [--site <url>] [--battle <id>] [--cron-secret <secret>] [--json]`;

/** Parses argv (without node and the script) and the environment into a check config. */
export function parseArgs(argv, env = {}) {
  const opts = {};
  const flags = new Set(['json']);
  const known = new Set([
    'app',
    'shell',
    'supabase',
    'anon-key',
    'cdn',
    'site',
    'battle',
    'cron-secret',
    'json',
  ]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!m || !known.has(m[1]))
      throw new Error(`unknown argument ${JSON.stringify(arg)}\n${USAGE}`);
    const name = m[1];
    if (flags.has(name)) {
      opts[name] = true;
      continue;
    }
    const value = m[2] ?? argv[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`);
    opts[name] = value;
  }
  const anonKey = opts['anon-key'] ?? env.SUPABASE_ANON_KEY;
  const cronSecret = opts['cron-secret'] ?? env.JOBS_CRON_SECRET;
  const missing = ['app', 'shell', 'supabase'].filter((k) => !opts[k]);
  if (!anonKey) missing.push('anon-key');
  if (missing.length) {
    throw new Error(`missing ${missing.map((k) => `--${k}`).join(', ')}\n${USAGE}`);
  }
  const battle = opts.battle;
  if (battle !== undefined && !isUuid(battle))
    throw new Error('--battle must be a battle id (a UUID)');
  return {
    app: baseUrl(opts.app, '--app'),
    shell: shellUrl(opts.shell),
    supabase: baseUrl(opts.supabase, '--supabase'),
    cdn: baseUrl(opts.cdn ?? DEFAULT_CDN, '--cdn'),
    site: opts.site ? baseUrl(opts.site, '--site') : null,
    anonKey,
    cronSecret: cronSecret || null,
    battle: battle ?? null,
    json: opts.json === true,
  };
}

/** An http(s) origin-only URL without a trailing slash (`https://x.pages.dev`). */
export function baseUrl(value, name) {
  let u;
  try {
    u = new URL(value);
  } catch {
    throw new Error(`${name} is not a URL: ${JSON.stringify(value)}`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`${name} must be http(s)`);
  if (u.username || u.password || u.search || u.hash) {
    throw new Error(`${name} must be a plain URL (no credentials, query or fragment)`);
  }
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

/** The shell URL as the app uses it: ends with `/v{N}/` (NEXT_PUBLIC_SANDBOX_SHELL_URL). */
export function shellUrl(value) {
  const base = baseUrl(value, '--shell');
  const u = new URL(base);
  if (!/^\/v\d+$/.test(u.pathname)) {
    throw new Error(
      '--shell must be the shell URL with its version path, e.g. https://<sandbox>.pages.dev/v1/',
    );
  }
  return `${base}/`;
}

export function isUuid(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

// ─── Parsing ───────────────────────────────────────────────────────────────

/** A Content-Security-Policy header as a Map of directive → sources (names lower-cased). */
export function parseCsp(header) {
  const out = new Map();
  for (const part of (header ?? '').split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const name = tokens[0].toLowerCase();
    if (!out.has(name)) out.set(name, tokens.slice(1)); // the first one wins, as in browsers
  }
  return out;
}

/** Does a CSP directive (or default-src when it is absent) list this exact source? */
export function cspHas(csp, directive, source) {
  const values = csp.get(directive) ?? csp.get('default-src') ?? [];
  return values.includes(source);
}

/**
 * The `<meta property|name="…" content="…">`, `<title>` and canonical link of an HTML head.
 * Attribute order and quoting vary; entities in values are decoded (&amp; &lt; &gt; &quot; &#39;).
 */
export function parseHead(html) {
  const meta = new Map();
  const head = html.split(/<\/head>/i)[0] ?? html;
  for (const m of head.matchAll(/<meta\b([^>]*)>/gi)) {
    const attrs = parseAttributes(m[1]);
    const key = attrs.get('property') ?? attrs.get('name');
    const content = attrs.get('content');
    if (key && content !== undefined && !meta.has(key.toLowerCase())) {
      meta.set(key.toLowerCase(), content);
    }
  }
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  let canonical = null;
  for (const m of head.matchAll(/<link\b([^>]*)>/gi)) {
    const attrs = parseAttributes(m[1]);
    if ((attrs.get('rel') ?? '').toLowerCase() === 'canonical')
      canonical = attrs.get('href') ?? null;
  }
  return { meta, title: title === undefined ? null : decodeEntities(title.trim()), canonical };
}

function parseAttributes(text) {
  const attrs = new Map();
  for (const m of text.matchAll(
    /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g,
  )) {
    attrs.set(m[1].toLowerCase(), decodeEntities(m[2] ?? m[3] ?? m[4] ?? ''));
  }
  return attrs;
}

export function decodeEntities(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&#x0*27;|&apos;/gi, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** What `POST /rest/v1/rpc/keep_alive` said (the same reading as scripts/keep-alive.sh). */
export function classifyKeepAlive(status, body) {
  if (status === 540)
    return { level: 'FAIL', text: 'the Supabase project is PAUSED (restore it in the dashboard)' };
  if (status === 402)
    return {
      level: 'FAIL',
      text: 'Supabase restricted the project (over the Free quotas, HTTP 402)',
    };
  if (status === 401 || status === 403)
    return { level: 'FAIL', text: `HTTP ${status}: the anon key is not this project's` };
  if (status === 404)
    return {
      level: 'FAIL',
      text: 'keep_alive not found: migrations not applied (supabase db push)?',
    };
  if (status !== 200) return { level: 'FAIL', text: `HTTP ${status}` };
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    return { level: 'FAIL', text: 'HTTP 200 but not JSON: is --supabase the project API URL?' };
  }
  if (json?.read_only === true)
    return { level: 'FAIL', text: "the database is READ-ONLY (over the Free plan's 500 MB?)" };
  if (json?.ok === true)
    return { level: 'PASS', text: 'keep_alive answers ok (the database is writable)' };
  return { level: 'FAIL', text: `unexpected answer ${body.slice(0, 120)}` };
}

// ─── Checks ────────────────────────────────────────────────────────────────

const APP_HEADERS = [
  ['x-content-type-options', (v) => v === 'nosniff', 'nosniff'],
  ['x-frame-options', (v) => v.toUpperCase() === 'DENY', 'DENY'],
  [
    'referrer-policy',
    (v) => v === 'strict-origin-when-cross-origin',
    'strict-origin-when-cross-origin',
  ],
  [
    'permissions-policy',
    (v) => /camera=\(\)/.test(v) && /microphone=\(\)/.test(v),
    'camera=(), microphone=(), …',
  ],
  ['cross-origin-opener-policy', (v) => v === 'same-origin', 'same-origin'],
  ['strict-transport-security', (v) => /max-age=\d+/.test(v), 'max-age=…'],
];

/** The app's security headers and CSP against the configured hosts (results, no I/O). */
export function checkAppHeaders(headers, cfg, where = '/') {
  const results = [];
  const get = (k) => headers.get(k);
  for (const [name, ok, want] of APP_HEADERS) {
    const v = get(name);
    results.push(
      v !== null && ok(v)
        ? pass(`app ${where}: ${name}`)
        : fail(
            `app ${where}: ${name}`,
            v === null ? `missing (want ${want})` : `${v} (want ${want})`,
          ),
    );
  }
  const raw = get('content-security-policy');
  if (!raw) {
    results.push(fail(`app ${where}: content-security-policy`, 'missing: _headers not deployed?'));
    return results;
  }
  const csp = parseCsp(raw);
  const supabase = new URL(cfg.supabase).origin;
  const want = [
    ['frame-ancestors', "'none'", 'nothing may frame the app'],
    ['connect-src', supabase, 'Supabase (NEXT_PUBLIC_SUPABASE_URL)'],
    ['connect-src', supabase.replace(/^http/, 'ws'), 'Supabase Realtime'],
    ['connect-src', new URL(cfg.cdn).origin, 'the package CDN (NEXT_PUBLIC_PKG_CDN_URL)'],
    ['frame-src', new URL(cfg.shell).origin, 'the sandbox shell (NEXT_PUBLIC_SANDBOX_SHELL_URL)'],
    ['img-src', supabase, 'screenshots in Supabase Storage'],
    ['object-src', "'none'", 'no plugins'],
  ];
  for (const [directive, source, why] of want) {
    results.push(
      cspHas(csp, directive, source)
        ? pass(`app ${where}: CSP ${directive} ${source}`)
        : fail(
            `app ${where}: CSP ${directive} ${source}`,
            `missing (${why}); the build used other NEXT_PUBLIC_* values`,
          ),
    );
  }
  const scriptSrc = csp.get('script-src') ?? csp.get('default-src') ?? [];
  results.push(
    scriptSrc.includes("'unsafe-inline'") || scriptSrc.includes("'unsafe-eval'")
      ? fail(`app ${where}: CSP script-src`, "allows 'unsafe-inline' or 'unsafe-eval'")
      : pass(`app ${where}: CSP script-src has no 'unsafe-inline'/'unsafe-eval'`),
  );
  return results;
}

/** The shell's CSP: framed by the app only, modules from the package CDN. */
export function checkShellHeaders(headers, cfg) {
  const raw = headers.get('content-security-policy');
  if (!raw) return [fail('shell: content-security-policy', 'missing: _headers not deployed?')];
  const csp = parseCsp(raw);
  const appOrigins = [new URL(cfg.app).origin, ...(cfg.site ? [new URL(cfg.site).origin] : [])];
  const results = appOrigins.map((o) =>
    cspHas(csp, 'frame-ancestors', o)
      ? pass(`shell: frame-ancestors allows ${o}`)
      : fail(
          `shell: frame-ancestors allows ${o}`,
          'missing: rebuild the shell with BR_APP_ORIGINS including it',
        ),
  );
  const cdn = new URL(cfg.cdn).origin;
  results.push(
    cspHas(csp, 'script-src', cdn)
      ? pass(`shell: script-src allows the package CDN ${cdn}`)
      : fail(
          `shell: script-src allows the package CDN ${cdn}`,
          'missing: rebuild the shell with BR_PKG_CDN_URL',
        ),
  );
  return results;
}

function pass(name, detail = '') {
  return { level: 'PASS', name, detail };
}
function fail(name, detail) {
  return { level: 'FAIL', name, detail };
}
function warn(name, detail) {
  return { level: 'WARN', name, detail };
}

async function request(fetchImpl, url, init = {}, timeoutMs = TIMEOUT_MS) {
  const res = await fetchImpl(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
    ...init,
  });
  const body = init.method === 'HEAD' ? '' : await res.text();
  return { status: res.status, headers: res.headers, body };
}

function supabaseHeaders(key) {
  const h = { apikey: key };
  // A legacy anon key is a JWT and also goes in Authorization; a publishable key does not.
  if (key.startsWith('eyJ')) h.authorization = `Bearer ${key}`;
  return h;
}

/** Runs every check; never throws (a network error is a FAIL of that check). */
export async function runChecks(cfg, fetchImpl = fetch) {
  const results = [];
  const step = async (name, fn) => {
    try {
      const r = await fn();
      results.push(...(Array.isArray(r) ? r : [r]));
    } catch (e) {
      results.push(fail(name, e instanceof Error ? e.message : String(e)));
    }
  };

  // ── The web app (Pages) ──
  await step('app /', async () => {
    const r = await request(fetchImpl, `${cfg.app}/`);
    if (r.status !== 200) return fail('app /', `HTTP ${r.status}`);
    return [pass('app / answers 200'), ...checkAppHeaders(r.headers, cfg, '/')];
  });
  await step('app 404', async () => {
    const r = await request(fetchImpl, `${cfg.app}/deploy-check-${randomUUID().slice(0, 8)}`);
    return r.status === 404
      ? pass('app: an unknown path answers 404')
      : fail(
          'app: an unknown path answers 404',
          `HTTP ${r.status} (404.html missing from the upload?)`,
        );
  });
  await step('app shells', async () => {
    const out = [];
    for (const path of [`/r/ABCDE`, `/u/${randomUUID()}`]) {
      const r = await request(fetchImpl, `${cfg.app}${path}`);
      out.push(
        r.status === 200
          ? pass(`app ${path.replace(/\/[^/]+$/, '/{…}')} serves its shell (200)`)
          : fail(
              `app ${path.replace(/\/[^/]+$/, '/{…}')} serves its shell`,
              `HTTP ${r.status} (_redirects missing?)`,
            ),
      );
    }
    return out;
  });
  await step('app /admin', async () => {
    const r = await request(fetchImpl, `${cfg.app}/admin`);
    const robots = r.headers.get('x-robots-tag') ?? '';
    return /noindex/i.test(robots)
      ? pass('app /admin: X-Robots-Tag noindex')
      : fail('app /admin: X-Robots-Tag noindex', robots ? robots : 'missing');
  });

  // ── The link-preview Function on /battles/* ──
  await step('preview malformed', async () => {
    const r = await request(fetchImpl, `${cfg.app}/battles/not-a-battle`);
    const tag = r.headers.get('x-br-preview');
    if (tag === null) {
      return fail(
        'preview: /battles/* runs the Function',
        `HTTP ${r.status} without x-br-preview (_worker.js or _routes.json missing?)`,
      );
    }
    const out = [
      r.status === 404 && tag === 'malformed'
        ? pass('preview: a malformed battle id answers 404 (x-br-preview: malformed)')
        : fail(
            'preview: a malformed battle id answers 404',
            `HTTP ${r.status}, x-br-preview: ${tag}`,
          ),
    ];
    out.push(...checkAppHeaders(r.headers, cfg, '/battles/x').filter((x) => x.level === 'FAIL'));
    return out;
  });
  await step('preview unknown', async () => {
    const r = await request(fetchImpl, `${cfg.app}/battles/${randomUUID()}`);
    const tag = r.headers.get('x-br-preview') ?? '';
    if (r.status === 404 && tag === 'not-found') {
      return pass('preview: an unknown battle answers 404 (the Function reached Supabase)');
    }
    if (tag.startsWith('fail-open')) {
      return fail(
        'preview: the Function reaches Supabase',
        `${tag}: check NEXT_PUBLIC_SUPABASE_URL/ANON_KEY of the build and the project`,
      );
    }
    return fail(
      'preview: an unknown battle answers 404',
      `HTTP ${r.status}, x-br-preview: ${tag || 'none'}`,
    );
  });
  if (cfg.battle) {
    await step('preview battle', async () => {
      const r = await request(fetchImpl, `${cfg.app}/battles/${cfg.battle}`, {
        headers: { 'user-agent': 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)' },
      });
      const tag = r.headers.get('x-br-preview');
      if (r.status !== 200 || tag !== 'battle') {
        return fail(
          'preview: the battle has its own preview',
          `HTTP ${r.status}, x-br-preview: ${tag ?? 'none'} (is it finished?)`,
        );
      }
      const head = parseHead(r.body);
      const out = [pass('preview: the battle answers 200 (x-br-preview: battle)')];
      const title = head.meta.get('og:title');
      out.push(title ? pass(`preview: og:title "${title}"`) : fail('preview: og:title', 'missing'));
      const site = new URL(cfg.site ?? cfg.app).origin;
      const ogUrl = head.meta.get('og:url');
      out.push(
        ogUrl === `${site}/battles/${cfg.battle}`
          ? pass('preview: og:url is the canonical address')
          : warn(
              'preview: og:url',
              `${ogUrl ?? 'missing'} (want ${site}/battles/${cfg.battle}; NEXT_PUBLIC_SITE_URL?)`,
            ),
      );
      const image = head.meta.get('og:image');
      if (!image) {
        out.push(fail('preview: og:image', 'missing'));
        return out;
      }
      let imageUrl;
      try {
        imageUrl = new URL(image);
      } catch {
        out.push(fail('preview: og:image', `not an absolute URL: ${image}`));
        return out;
      }
      const img = await request(fetchImpl, imageUrl.href);
      const type = img.headers.get('content-type') ?? '';
      out.push(
        img.status === 200 && type.startsWith('image/')
          ? pass(
              `preview: og:image loads (${type}, ${imageUrl.pathname.endsWith('og-card.png') ? 'the static card' : 'the screenshot'})`,
            )
          : fail('preview: og:image loads', `HTTP ${img.status} ${type} for ${imageUrl.href}`),
      );
      return out;
    });
  } else {
    results.push(
      warn('preview: a finished battle', 'skipped: pass --battle <id> after the smoke battle'),
    );
  }

  // ── The sandbox shell (Pages) ──
  await step('shell', async () => {
    const r = await request(fetchImpl, cfg.shell);
    if (r.status !== 200) return fail('shell: the shell page answers 200', `HTTP ${r.status}`);
    return [pass('shell: the shell page answers 200'), ...checkShellHeaders(r.headers, cfg)];
  });
  await step('shell capture gate', async () => {
    const r = await request(fetchImpl, `${cfg.shell}capture`);
    if (r.status === 403) return pass('shell: the capture gate refuses an unsigned request (403)');
    if (r.status === 503) {
      return fail(
        'shell: the capture gate',
        "503: CAPTURE_HMAC_SECRET is not set on the shell's Pages project",
      );
    }
    if (r.status === 200)
      return fail('shell: the capture gate', 'served the capture page WITHOUT a signature');
    return fail('shell: the capture gate', `HTTP ${r.status} (want 403; is _worker.js deployed?)`);
  });

  // ── Supabase ──
  const sb = supabaseHeaders(cfg.anonKey);
  await step('supabase auth', async () => {
    const r = await request(fetchImpl, `${cfg.supabase}/auth/v1/settings`, { headers: sb });
    if (r.status === 540) return fail('supabase: Auth', 'the project is PAUSED');
    if (r.status !== 200) return fail('supabase: Auth answers', `HTTP ${r.status}`);
    const s = JSON.parse(r.body);
    return [
      pass('supabase: Auth answers'),
      s?.external?.anonymous_users === true
        ? pass('supabase: anonymous sign-ins are on')
        : fail(
            'supabase: anonymous sign-ins are on',
            'off: Authentication → Sign In / Providers → Allow anonymous sign-ins',
          ),
    ];
  });
  await step('supabase keep_alive', async () => {
    const r = await request(fetchImpl, `${cfg.supabase}/rest/v1/rpc/keep_alive`, {
      method: 'POST',
      headers: { ...sb, 'content-type': 'application/json' },
      body: '{}',
    });
    const c = classifyKeepAlive(r.status, r.body);
    return { level: c.level, name: 'supabase: keep_alive', detail: c.text };
  });
  await step('supabase jobs function', async () => {
    const r = await request(fetchImpl, `${cfg.supabase}/functions/v1/jobs`, { method: 'POST' });
    const out = [];
    if (r.status === 404)
      return fail(
        'supabase: the jobs function',
        '404: not deployed (supabase functions deploy jobs)',
      );
    if (r.status === 540) return fail('supabase: the jobs function', 'the project is PAUSED');
    if (r.status !== 401)
      return fail(
        'supabase: the jobs function',
        `HTTP ${r.status} without the cron secret (want 401)`,
      );
    // Our function answers {"error":"unauthorized"}; the gateway's own 401 (a missing JWT)
    // means it was deployed WITH JWT verification, and pg_cron's calls would be refused too.
    if (!/"error"\s*:\s*"unauthorized"/.test(r.body)) {
      return fail(
        'supabase: the jobs function',
        `the gateway refused the call (${r.body.slice(0, 120)}): deploy it with --no-verify-jwt`,
      );
    }
    out.push(
      pass(
        'supabase: the jobs function is deployed and refuses a call without the cron secret (401)',
      ),
    );
    if (!cfg.cronSecret) {
      out.push(
        warn(
          "supabase: the jobs function's configuration",
          'skipped: pass --cron-secret (or JOBS_CRON_SECRET) to run it once',
        ),
      );
      return out;
    }
    // ?wait=1 answers when the run is over: at once with nothing due, up to the run's hard
    // stop (140 s) while captures are being taken.
    const run = await request(
      fetchImpl,
      `${cfg.supabase}/functions/v1/jobs?wait=1`,
      { method: 'POST', headers: { 'x-br-cron-secret': cfg.cronSecret } },
      150_000,
    );
    if (run.status === 200)
      out.push(pass('supabase: the jobs function runs with its secrets (200)'));
    else if (run.status === 401)
      out.push(
        fail(
          'supabase: the jobs function runs',
          '401: the cron secret differs from JOBS_CRON_SECRET',
        ),
      );
    else
      out.push(
        fail('supabase: the jobs function runs', `HTTP ${run.status}: ${run.body.slice(0, 300)}`),
      );
    return out;
  });
  return results;
}

export function formatResults(results) {
  const width = Math.max(...results.map((r) => r.name.length), 10);
  const lines = results.map(
    (r) => `${r.level.padEnd(4)}  ${r.name.padEnd(width)}${r.detail ? `  ${r.detail}` : ''}`,
  );
  const n = (l) => results.filter((r) => r.level === l).length;
  lines.push('', `${n('PASS')} passed, ${n('WARN')} warnings, ${n('FAIL')} failed`);
  return lines.join('\n');
}

async function main() {
  let cfg;
  try {
    cfg = parseArgs(process.argv.slice(2), process.env);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
  if (cfg.help) {
    console.log(USAGE);
    return;
  }
  const results = await runChecks(cfg);
  console.log(cfg.json ? JSON.stringify(results, null, 2) : formatResults(results));
  process.exit(results.some((r) => r.level === 'FAIL') ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
