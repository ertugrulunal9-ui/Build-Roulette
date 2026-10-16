// Unit tests of scripts/deploy (T-042), without any network: an injected fetch emulates the
// Cloudflare and Supabase endpoints the deploy uses (with their error codes), and a fake
// runner records every command (its environment with secrets replaced by their names) and
// answers like the Supabase CLI, pnpm, wrangler and deploy-check would.
//   node --test scripts/deploy/*.test.mjs
// No key-shaped literal anywhere: every token and key is built at runtime (docs/WORKFLOW.md).
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  CLI_TOKEN_FORMAT,
  PLANS,
  SHELL_PATH,
  SMOKE_DELAYS_MS,
  TOKEN_HINT,
  deploy,
  explainCliFailure,
  mergeAllowList,
  parseArgs,
  projectStatusProblem,
} from './deploy.mjs';
import { createOutput, escapeData } from './output.mjs';
import { createRunner } from './run.mjs';
import { anonKeyProblems, childEnv, readSettings } from './settings.mjs';
import {
  EXPECTED_SCHEMA,
  VAULT,
  addAdminSql,
  evaluateSchema,
  isValidEmail,
  quoteValue,
  resultOf,
} from './sql.mjs';

const hex = (n) => randomBytes(n).toString('hex');
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (payload) => [b64({ alg: 'HS256', typ: 'JWT' }), b64(payload), hex(16)].join('.');

const REF = 'abcdefghijklmnopqrst';
const ACCOUNT = hex(16);
/** Every secret of a run, built at runtime. */
const T = {
  cf: `cfdeploy${hex(16)}`,
  br: `cfbrowser${hex(16)}`,
  sb: ['sbp', hex(20)].join('_'),
  db: `pw-${hex(12)}%x`,
  anon: jwt({ iss: 'supabase', ref: REF, role: 'anon' }),
  turnstileSecret: `0x${hex(16)}`,
};
const TURNSTILE_SITE = `0x${hex(10)}`;
const MIGRATIONS = ['20261003120000', '20261009120000', '20261010120000'];

function baseEnv(over = {}) {
  return {
    PATH: '/usr/bin',
    HOME: '/home/runner',
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
    SUPABASE_URL: `https://${REF}.supabase.co`,
    CLOUDFLARE_API_TOKEN: T.cf,
    BROWSER_RENDERING_API_TOKEN: T.br,
    SUPABASE_ACCESS_TOKEN: T.sb,
    SUPABASE_DB_PASSWORD: T.db,
    SUPABASE_ANON_KEY: T.anon,
    ...over,
  };
}

const passResults = () => [
  { level: 'PASS', name: 'app / answers 200', detail: '' },
  { level: 'PASS', name: 'shell: the capture gate refuses an unsigned request (403)', detail: '' },
  { level: 'WARN', name: 'preview: a finished battle', detail: 'skipped: pass --battle <id>' },
];

// ─── The emulated world ─────────────────────────────────────────────────────

function world(over = {}) {
  const st = {
    tokens: new Map([
      [T.cf, { status: 'active', kind: 'user', pages: true }],
      [T.br, { status: 'active', kind: 'user', pages: false }],
    ]),
    projects: new Map(),
    subdomains: {},
    sbProject: {
      ref: REF,
      name: 'build-roulette',
      region: 'eu-central-1',
      status: 'ACTIVE_HEALTHY',
    },
    anonKeys: new Set([T.anon]),
    vault: new Map(),
    auth: {
      site_url: 'http://localhost:3000',
      uri_allow_list: '',
      external_anonymous_users_enabled: false,
      external_email_enabled: true,
      security_captcha_enabled: false,
      security_captcha_provider: null,
      security_captcha_secret: null,
    },
    fnSecrets: new Map(),
    users: new Set(),
    admins: new Set(),
    remote: [],
    remoteOnly: [],
    schema: {
      jobs: Object.fromEntries(
        Object.entries(EXPECTED_SCHEMA.jobs).map(([k, v]) => [k, v ?? '* * * * *']),
      ),
      buckets: { ...EXPECTED_SCHEMA.buckets },
      cards: 130,
    },
    resultAsText: false,
    sbToken: T.sb,
    deny: new Set(),
    smoke: [],
    fail: null,
    events: [],
    sql: [],
    ...over,
  };
  const json = (status, body) =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const cfOk = (result) => json(200, { success: true, errors: [], messages: [], result });
  const cfErr = (status, code, message) =>
    json(status, { success: false, errors: [{ code, message }], messages: [], result: null });
  const masked = (p) => {
    const env = p.deployment_configs.production.env_vars;
    return {
      ...p,
      deployment_configs: {
        ...p.deployment_configs,
        production: {
          ...p.deployment_configs.production,
          env_vars: Object.fromEntries(
            Object.entries(env).map(([k, v]) => [k, { type: v.type, value: '' }]),
          ),
        },
      },
    };
  };
  const literal = (q) => /\$(q_[0-9a-f]{16})\$([\s\S]*?)\$\1\$/.exec(q)?.[2];

  function runSql(q) {
    st.sql.push(q);
    const result = (r) => [{ result: st.resultAsText ? JSON.stringify(r) : r }];
    if (q.includes('from vault.decrypted_secrets')) return result(Object.fromEntries(st.vault));
    if (q === "select json_build_object('ok', true) as result") return result({ ok: true });
    let m = /vault\.create_secret\(\$(q_[0-9a-f]{16})\$([\s\S]*?)\$\1\$, '([a-z_]+)'/.exec(q);
    if (m) {
      if (st.vault.has(m[3])) throw new Error('duplicate key value violates unique constraint');
      st.vault.set(m[3], m[2]);
      return result({ id: 'b1f0a2e4-0000-4000-8000-000000000001' });
    }
    m =
      /vault\.update_secret\(s\.id, \$(q_[0-9a-f]{16})\$([\s\S]*?)\$\1\$\) from vault\.secrets s where s\.name = '([a-z_]+)'/.exec(
        q,
      );
    if (m) {
      const had = st.vault.has(m[3]);
      if (had) st.vault.set(m[3], m[2]);
      return result({ updated: had ? 1 : 0 });
    }
    if (q.includes('from cron.job')) return result(st.schema);
    if (q.includes('insert into private.admins')) {
      const email = literal(q).toLowerCase();
      const users = st.users.has(email) ? 1 : 0;
      const inserted = users && !st.admins.has(email) ? 1 : 0;
      if (inserted) st.admins.add(email);
      return result({ users, inserted });
    }
    if (q.includes('from auth.users'))
      return result({ users: st.users.has(literal(q).toLowerCase()) ? 1 : 0 });
    if (q.includes('from private.admins')) return result({ admins: st.admins.size });
    throw new Error(`unexpected SQL: ${q.slice(0, 80)}`);
  }

  async function fetchImpl(url, init = {}) {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    const body = init.body ? JSON.parse(init.body) : undefined;
    const bearer = (headers.get('authorization') ?? '').replace(/^Bearer /, '');
    const token = Object.entries(T).find(([, v]) => v === bearer)?.[0];
    st.events.push({ kind: 'http', method, host: u.host, path: u.pathname, body, token });

    if (u.host === 'api.cloudflare.com') {
      const p = u.pathname.replace(/^\/client\/v4/, '');
      const t = st.tokens.get(bearer);
      if (p === '/user/tokens/verify') {
        if (!t || t.kind !== 'user') return cfErr(401, 1000, 'Invalid API Token');
        return cfOk({ id: 't1', status: t.status });
      }
      if (p === `/accounts/${ACCOUNT}/tokens/verify`) {
        if (!t || t.kind !== 'account') return cfErr(401, 1000, 'Invalid API Token');
        return cfOk({ id: 't2', status: t.status });
      }
      const m = /^\/accounts\/([^/]+)\/pages\/projects(?:\/([^/]+))?$/.exec(p);
      if (m) {
        if (!t?.pages || m[1] !== ACCOUNT) return cfErr(403, 10000, 'Authentication error');
        if (!m[2] && method === 'POST') {
          if (st.projects.has(body.name)) return cfErr(409, 8000002, 'name taken');
          const project = {
            name: body.name,
            subdomain: st.subdomains[body.name] ?? `${body.name}.pages.dev`,
            production_branch: body.production_branch,
            deployment_configs: { production: { env_vars: {} }, preview: { env_vars: {} } },
          };
          st.projects.set(body.name, project);
          return cfOk(masked(project));
        }
        const proj = st.projects.get(decodeURIComponent(m[2] ?? ''));
        if (!proj) return cfErr(404, 8000007, 'Project not found');
        if (method === 'GET') return cfOk(masked(proj));
        if (method === 'PATCH') {
          Object.assign(
            proj.deployment_configs.production.env_vars,
            body.deployment_configs.production.env_vars,
          );
          return cfOk(masked(proj));
        }
      }
      return cfErr(404, 7000, 'No route for that URI');
    }

    if (u.host === 'api.supabase.com') {
      if (bearer !== st.sbToken) return json(401, { message: 'Unauthorized' });
      const m = /^\/v1\/projects\/([a-z]+)(\/.*)?$/.exec(u.pathname);
      if (!m || m[1] !== st.sbProject.ref) return json(404, { message: 'Project not found' });
      const sub = m[2] ?? '';
      // A token scoped to the project, without some permission.
      if (st.deny.has(`${method} ${sub}`)) return json(403, { message: 'Forbidden resource' });
      if (sub === '' && method === 'GET') return json(200, st.sbProject);
      if (sub === '/database/query' && method === 'POST') {
        try {
          return json(201, runSql(body.query));
        } catch (e) {
          return json(400, { message: `Failed to run sql query: ERROR: ${e.message}` });
        }
      }
      if (sub === '/config/auth' && method === 'GET') return json(200, { ...st.auth });
      if (sub === '/config/auth' && method === 'PATCH') {
        Object.assign(st.auth, body);
        return json(200, { ...st.auth });
      }
      if (sub === '/secrets' && method === 'GET')
        return json(
          200,
          [...st.fnSecrets].map(([name, value]) => ({ name, value: sha256(value) })),
        );
      if (sub === '/secrets' && method === 'POST') {
        for (const { name, value } of body) st.fnSecrets.set(name, value);
        return json(201);
      }
      return json(404, { message: 'no route' });
    }

    if (u.host === `${REF}.supabase.co` && u.pathname === '/auth/v1/settings') {
      return st.anonKeys.has(headers.get('apikey') ?? '')
        ? json(200, { external: { anonymous_users: st.auth.external_anonymous_users_enabled } })
        : json(401, { message: 'Invalid API key' });
    }
    return json(404, {});
  }

  /** The environment of a command, with every secret value replaced by its name. */
  const describeEnv = (env = {}) => {
    const known = [
      ...Object.entries({
        CLOUDFLARE_API_TOKEN: T.cf,
        BROWSER_RENDERING_API_TOKEN: T.br,
        SUPABASE_ACCESS_TOKEN: T.sb,
        SUPABASE_DB_PASSWORD: T.db,
        SUPABASE_ANON_KEY: T.anon,
        TURNSTILE_SECRET_KEY: T.turnstileSecret,
      }),
      ['JOBS_CRON_SECRET', st.vault.get(VAULT.cronSecret)],
      ['CAPTURE_HMAC_SECRET', st.vault.get(VAULT.captureSecret)],
    ].filter(([, v]) => v);
    return Object.fromEntries(
      Object.entries(env).map(([k, v]) => {
        const hit = known.find(([, secret]) => secret === v);
        return [k, hit ? `<secret:${hit[0]}>` : v];
      }),
    );
  };

  const makeRunner =
    (out) =>
    async (cmd, args, opts = {}) => {
      const rec = { kind: 'run', cmd, args, env: describeEnv(opts.env), cwd: opts.cwd };
      st.events.push(rec);
      // Child output goes through the deploy's redaction; echo secrets to prove it.
      const say = (s) => out.passthrough(`${s}\n`);
      const done = { code: 0, stdout: '', stderr: '' };
      // `fail` answers true (a generic failure) or the stderr the command prints.
      const failure = st.fail?.(cmd, args);
      if (failure) {
        const stderr = typeof failure === 'string' ? failure : `boom ${T.sb}\nlast line\n`;
        return { code: 1, stdout: '', stderr };
      }
      if (cmd === 'npx') {
        assert.deepEqual(args.slice(0, 2), ['-y', 'supabase@2.119.0']);
        const [sub] = args.slice(2);
        if (sub === 'link') {
          say(
            `linking with ${opts.env.SUPABASE_ACCESS_TOKEN} and ${opts.env.SUPABASE_DB_PASSWORD}`,
          );
          return done;
        }
        if (sub === 'migration') {
          const migrations = [
            ...MIGRATIONS.map((v) => ({
              local: v,
              remote: st.remote.includes(v) ? v : '',
              time: '',
            })),
            ...st.remoteOnly.map((v) => ({ local: '', remote: v, time: '' })),
          ];
          return { ...done, stdout: JSON.stringify({ migrations, message: 'Migrations listed' }) };
        }
        if (sub === 'db') {
          st.remote = [...MIGRATIONS];
          return done;
        }
        if (sub === 'functions') return done;
      }
      if (cmd === 'pnpm') {
        say(`pnpm ${args.join(' ')} with ${JSON.stringify(opts.env)}`);
        return done;
      }
      if (cmd === process.execPath && args[0].endsWith('deploy-check.mjs')) {
        const results = st.smoke.length ? st.smoke.shift() : passResults();
        return {
          code: results.some((r) => r.level === 'FAIL') ? 1 : 0,
          stdout: JSON.stringify(results),
          stderr: '',
        };
      }
      return { code: 127, stdout: '', stderr: `unknown command ${cmd}` };
    };

  return { st, fetch: fetchImpl, makeRunner };
}

async function run(w, { argv = ['--target', 'all'], env = {}, github = true } = {}) {
  let stdout = '';
  let stderr = '';
  const files = {};
  const sleeps = [];
  const e = baseEnv(env);
  if (github) {
    Object.assign(e, {
      GITHUB_ACTIONS: 'true',
      GITHUB_STEP_SUMMARY: '/tmp/summary.md',
      GITHUB_OUTPUT: '/tmp/output.txt',
    });
  }
  const code = await deploy({
    argv,
    env: e,
    fetch: w.fetch,
    makeRunner: w.makeRunner,
    stdout: (s) => {
      stdout += s;
    },
    stderr: (s) => {
      stderr += s;
    },
    appendFile: (p, t) => {
      files[p] = (files[p] ?? '') + t;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    repoRoot: '/repo',
  });
  return {
    code,
    stdout,
    stderr,
    sleeps,
    summary: files['/tmp/summary.md'] ?? '',
    outputs: files['/tmp/output.txt'] ?? '',
  };
}

const runs = (w) => w.st.events.filter((e) => e.kind === 'run');
const http = (w) => w.st.events.filter((e) => e.kind === 'http');
const writes = (w) => http(w).filter((e) => e.method !== 'GET');
const readOnlySql = (e) =>
  e.path.endsWith('/database/query') &&
  /^select /.test(e.body.query) &&
  !/insert|create_secret|update_secret|delete/.test(e.body.query);
/** Requests that can change something: every non-GET but the read-only SQL. */
const changes = (w) => writes(w).filter((e) => !readOnlySql(e));
const commandOf = (r) =>
  r.cmd === 'npx'
    ? `supabase ${r.args[2]} ${r.args[3] ?? ''}`.trim()
    : `${r.cmd === 'pnpm' ? 'pnpm' : 'node'} ${r.args.join(' ')}`;
const findRun = (w, pred) => runs(w).find(pred);
const pnpmRun = (w, needle) =>
  findRun(w, (r) => r.cmd === 'pnpm' && r.args.join(' ').includes(needle));
const smokeRun = (w) => findRun(w, (r) => r.cmd === process.execPath);
const argAfter = (args, flag) => args[args.indexOf(flag) + 1];

/** Asserts that no secret is printed anywhere but in its own ::add-mask:: line, which comes first. */
function assertNoLeaks(res, secrets) {
  for (const secret of secrets) {
    const lines = res.stdout.split('\n');
    const first = lines.findIndex((l) => l.includes(secret));
    if (first === -1) continue;
    assert.equal(lines[first], `::add-mask::${escapeData(secret)}`, 'the mask comes first');
    lines.forEach((l, i) => {
      if (i !== first)
        assert.ok(
          !l.includes(secret),
          `a secret leaked in stdout line ${String(i)}: ${l.slice(0, 60)}`,
        );
    });
    assert.ok(!res.stderr.includes(secret), 'a secret leaked in stderr');
    assert.ok(!res.summary.includes(secret), 'a secret leaked in the summary');
    assert.ok(!res.outputs.includes(secret), 'a secret leaked in the step outputs');
  }
}
const allSecrets = (w) => [
  ...Object.values(T),
  ...[VAULT.cronSecret, VAULT.captureSecret].map((n) => w.st.vault.get(n)).filter(Boolean),
];

// ─── Pure helpers ───────────────────────────────────────────────────────────

describe('parseArgs', () => {
  it('reads --target and --admin-email, with DEPLOY_TARGET and ADMIN_EMAIL as fallbacks', () => {
    assert.deepEqual(parseArgs(['--target', 'web']), { target: 'web', adminEmail: undefined });
    assert.deepEqual(parseArgs(['--target=check', '--admin-email', 'm@x.io']), {
      target: 'check',
      adminEmail: 'm@x.io',
    });
    assert.deepEqual(parseArgs([], { DEPLOY_TARGET: 'shell', ADMIN_EMAIL: ' ' }), {
      target: 'shell',
      adminEmail: undefined,
    });
    assert.equal(parseArgs([]).target, 'all');
    assert.deepEqual(parseArgs(['--help']), { help: true });
    assert.throws(() => parseArgs(['--target', 'prod']), /must be one of/);
    assert.throws(() => parseArgs(['--nope']), /unknown argument/);
    assert.throws(() => parseArgs(['--target']), /needs a value/);
  });
});

describe('settings', () => {
  it('names every missing required setting at once, and only what the target needs', () => {
    const { problems } = readSettings({}, 'all');
    for (const name of [
      'CLOUDFLARE_ACCOUNT_ID',
      'SUPABASE_URL',
      'CLOUDFLARE_API_TOKEN',
      'BROWSER_RENDERING_API_TOKEN',
      'SUPABASE_ACCESS_TOKEN',
      'SUPABASE_DB_PASSWORD',
      'SUPABASE_ANON_KEY',
    ]) {
      assert.ok(
        problems.some((p) => p.startsWith(`${name} is missing`)),
        name,
      );
    }
    const web = readSettings({}, 'web').problems.join('\n');
    assert.doesNotMatch(web, /SUPABASE_DB_PASSWORD|BROWSER_RENDERING_API_TOKEN/);
    assert.match(web, /SUPABASE_ANON_KEY/);
    assert.doesNotMatch(readSettings({}, 'shell').problems.join('\n'), /SUPABASE_ANON_KEY/);
  });

  it('derives the ref and the defaults; empty variables count as unset', () => {
    const { settings: s, problems } = readSettings(
      baseEnv({ APP_URL: '', PKG_CDN_URL: '' }),
      'all',
    );
    assert.deepEqual(problems, []);
    assert.equal(s.ref, REF);
    assert.equal(s.supabaseUrl, `https://${REF}.supabase.co`);
    assert.equal(s.appUrl, undefined);
    assert.equal(s.pkgCdnUrl, 'https://esm.sh');
    assert.equal(s.webProject, 'build-roulette-web');
    assert.equal(s.shellProject, 'build-roulette-sandbox');
  });

  it('refuses malformed values without echoing them', () => {
    const bad = {
      CLOUDFLARE_ACCOUNT_ID: 'acct-123',
      SUPABASE_URL: 'https://example.com',
      BROWSER_RENDERING_API_TOKEN: T.cf,
      APP_URL: 'http://play.example.com/x',
      CF_PAGES_WEB_PROJECT: 'Same_Name',
      NEXT_PUBLIC_SENTRY_DSN: 'not a dsn',
    };
    const { problems } = readSettings(baseEnv(bad), 'all');
    const text = problems.join('\n');
    assert.match(text, /CLOUDFLARE_ACCOUNT_ID must be the 32-character/);
    assert.match(text, /SUPABASE_URL must be/);
    assert.match(text, /must be a separate token/);
    assert.match(text, /APP_URL must start with https/);
    assert.match(text, /CF_PAGES_WEB_PROJECT must be a Pages project name/);
    assert.match(text, /NEXT_PUBLIC_SENTRY_DSN/);
    assert.ok(!text.includes(T.cf));
    assert.match(
      readSettings(
        baseEnv({ CF_PAGES_SHELL_PROJECT: 'build-roulette-web' }),
        'all',
      ).problems.join(),
      /must differ/,
    );
    assert.match(
      readSettings(baseEnv({ APP_URL: 'https://play.example.com/game' }), 'all').problems.join(),
      /origin only/,
    );
  });

  it('accepts a Sentry DSN with its public key, a custom APP_URL and a CDN with a path', () => {
    const { settings: s, problems } = readSettings(
      baseEnv({
        NEXT_PUBLIC_SENTRY_DSN: `https://${hex(16)}@o1.ingest.sentry.io/2`,
        APP_URL: 'https://play.example.com/',
        PKG_CDN_URL: 'https://cdn.example.com/npm/',
      }),
      'all',
    );
    assert.deepEqual(problems, []);
    assert.equal(s.appUrl, 'https://play.example.com');
    assert.equal(s.pkgCdnUrl, 'https://cdn.example.com/npm');
  });

  it('refuses a secret-shaped anon key (the web build rule), and one of another project', () => {
    assert.deepEqual(anonKeyProblems(T.anon, REF), []);
    assert.deepEqual(anonKeyProblems(['sb', 'publishable', hex(12)].join('_'), REF), []);
    assert.match(anonKeyProblems(['sb', 'secret', hex(12)].join('_'), REF)[0], /SECRET key/);
    assert.match(anonKeyProblems(jwt({ role: 'service_role', ref: REF }), REF)[0], /service_role/);
    assert.match(
      anonKeyProblems(jwt({ role: 'anon', ref: 'zzzzzzzzzzzzzzzzzzzz' }), REF)[0],
      /belongs to project/,
    );
    assert.match(anonKeyProblems('hello', REF)[0], /neither/);
  });

  it('warns about a half-configured Turnstile and settings that are not used', () => {
    const { warnings } = readSettings(
      baseEnv({
        TURNSTILE_SITE_KEY: TURNSTILE_SITE,
        JOBS_CRON_SECRET: hex(32),
        SHELL_URL: 'https://x/v1/',
      }),
      'all',
    );
    assert.match(
      warnings.join('\n'),
      /half configured.*TURNSTILE_SITE_KEY is set but not TURNSTILE_SECRET_KEY/,
    );
    assert.match(warnings.join('\n'), /JOBS_CRON_SECRET from the environment is not used/);
    assert.match(warnings.join('\n'), /SHELL_URL/);
  });

  it('childEnv drops every secret and build setting of the parent', () => {
    const env = childEnv(
      {
        ...baseEnv(),
        NEXT_PUBLIC_SITE_URL: 'https://stale',
        BR_APP_ORIGINS: 'x',
        TURNSTILE_SECRET_KEY: 'y',
      },
      { BR_PKG_CDN_URL: 'https://esm.sh' },
    );
    assert.deepEqual(env, {
      PATH: '/usr/bin',
      HOME: '/home/runner',
      BR_PKG_CDN_URL: 'https://esm.sh',
    });
  });
});

describe('SQL values', () => {
  const fixed = () => Buffer.from('0123456789abcdef', 'hex').subarray(0, 8);

  it('dollar-quotes a validated value with a random tag', () => {
    assert.equal(
      quoteValue('mod+1@example.co.uk', 'email', fixed),
      '$q_0123456789abcdef$mod+1@example.co.uk$q_0123456789abcdef$',
    );
    const a = quoteValue('a@b.io', 'email');
    const b = quoteValue('a@b.io', 'email');
    assert.notEqual(a, b, 'a new tag each time');
    assert.match(a, /^\$q_[0-9a-f]{16}\$a@b\.io\$q_[0-9a-f]{16}\$$/);
    const secret = hex(32);
    assert.ok(quoteValue(secret, 'hex').includes(secret));
    assert.ok(quoteValue(`https://${REF}.supabase.co/functions/v1/jobs`, 'functionUrl'));
  });

  it('refuses hostile or malformed values before they reach SQL, without echoing them', () => {
    const hostile = [
      "o'brien@example.com",
      "x@example.com'); delete from private.admins; --",
      'x$q$@example.com',
      '$q_0123456789abcdef$@example.com',
      'a@b',
      'a b@example.com',
      'a@example.com\n::add-mask::x',
      `${'a'.repeat(65)}@example.com`,
      `a@${'b'.repeat(250)}.com`,
      '',
    ];
    for (const email of hostile) {
      assert.equal(isValidEmail(email), false, JSON.stringify(email));
      assert.throws(
        () => addAdminSql(email),
        (e) => /expected shape/.test(e.message) && !e.message.includes(email || '@'),
      );
    }
    assert.throws(() => quoteValue('ABC', 'hex'), /expected shape/);
    assert.throws(() => quoteValue(`${hex(32)}$`, 'hex'), /expected shape/);
    assert.throws(
      () => quoteValue('https://evil.example/functions/v1/jobs', 'functionUrl'),
      /expected shape/,
    );
    assert.throws(() => quoteValue('x', 'sql'), /unknown kind/);
  });

  it('reads the single json result, as an object or as text', () => {
    assert.deepEqual(resultOf([{ result: { a: 1 } }]), { a: 1 });
    assert.deepEqual(resultOf([{ result: '{"a":1}' }]), { a: 1 });
    assert.throws(() => resultOf([]), /no result row/);
  });

  it('evaluates the post-push checks of DEPLOY.md §3.3', () => {
    const good = world().st.schema;
    assert.deepEqual(evaluateSchema(good), { problems: [], warnings: [] });
    const bad = {
      jobs: { ...good.jobs, 'br-sweep-deadlines': '1 minute', 'my-job': '* * * * *' },
      buckets: { screenshots: false },
      cards: 0,
    };
    delete bad.jobs['br-jobs-run'];
    const r = evaluateSchema(bad);
    assert.match(r.problems.join('\n'), /br-jobs-run is missing/);
    assert.match(r.problems.join('\n'), /br-sweep-deadlines runs every "1 minute"/);
    assert.match(r.problems.join('\n'), /ephemeral-builds is missing/);
    assert.match(r.problems.join('\n'), /screenshots is private/);
    assert.match(r.problems.join('\n'), /prompt_cards is empty/);
    assert.match(r.warnings.join('\n'), /my-job/);
    assert.match(evaluateSchema({ ...good, cards: 131 }).warnings.join(), /131 prompt cards/);
  });
});

describe('Supabase access problems', () => {
  it('the CLI token format is the CLI 2.119.0 regex', () => {
    assert.ok(CLI_TOKEN_FORMAT.test(['sbp', hex(20)].join('_')));
    assert.ok(CLI_TOKEN_FORMAT.test(['sbp', 'v0', hex(20)].join('_')));
    assert.ok(!CLI_TOKEN_FORMAT.test(['sbp', 'v1', hex(20)].join('_')));
    assert.ok(!CLI_TOKEN_FORMAT.test(['sbp', hex(19)].join('_')));
  });

  it('explainCliFailure names the part that failed', () => {
    const cases = [
      [
        'link',
        'Invalid access token format. Must be like `sbp_0102...1920`.',
        /^Access token format/,
      ],
      ['link', 'unexpected status 401: {"message":"Unauthorized"}', /^Access token: .*401/],
      ['link', 'unexpected get api keys status 403: Forbidden', /^Access token permissions/],
      [
        'link',
        'Unexpected error retrieving remote project status: 404 not found',
        /^Project access/,
      ],
      ['link', 'project is paused', /PAUSED/],
      ['link', 'something else', /^supabase link failed/],
      [
        'database',
        'FATAL: password authentication failed for user "postgres"',
        /^Database password/,
      ],
      [
        'database',
        'IPv6 is not supported on your current network',
        /^Database connection: .*pooler/,
      ],
      ['database', 'connection refused', /^Database: supabase migration list could not connect/],
    ];
    for (const [stage, stderr, want] of cases) {
      const m = explainCliFailure(stderr, stage, REF);
      assert.match(m, want, stderr);
      if (/^(Access|Project|Database connection)/.test(m)) assert.ok(m.includes(TOKEN_HINT), m);
    }
  });
});

describe('helpers', () => {
  it('merges the redirect allow list without clobbering it', () => {
    assert.deepEqual(mergeAllowList(null, ['https://a.pages.dev']), {
      value: 'https://a.pages.dev',
      added: ['https://a.pages.dev'],
    });
    assert.deepEqual(
      mergeAllowList(' http://localhost:3000, https://a.pages.dev/ ,,https://x.example/**', [
        'https://a.pages.dev',
        'https://play.example.com',
        'https://play.example.com',
      ]),
      {
        value:
          'http://localhost:3000,https://a.pages.dev/,https://x.example/**,https://play.example.com',
        added: ['https://play.example.com'],
      },
    );
  });

  it('explains a paused or unready project', () => {
    assert.equal(projectStatusProblem('ACTIVE_HEALTHY', REF), null);
    assert.match(projectStatusProblem('INACTIVE', REF), /PAUSED.*Restore project/);
    assert.match(projectStatusProblem('COMING_UP', REF), /not ready yet/);
    assert.match(projectStatusProblem('ACTIVE_UNHEALTHY', REF), /not healthy/);
  });

  it("the shell's version path is the protocol version", () => {
    const src = readFileSync(
      new URL('../../packages/protocol/src/messages.ts', import.meta.url),
      'utf8',
    );
    const version = /export const PROTOCOL_VERSION = (\d+);/.exec(src)?.[1];
    assert.equal(SHELL_PATH, `/v${String(version)}/`);
  });

  it('every target starts with the preflight; only `all` runs deploy-check', () => {
    for (const plan of Object.values(PLANS)) assert.equal(plan[0], 'preflight');
    assert.deepEqual(PLANS.check, ['preflight']);
    assert.ok(PLANS.all.includes('smoke'));
    assert.ok(Object.entries(PLANS).every(([t, p]) => t === 'all' || !p.includes('smoke')));
    assert.ok(PLANS.web.indexOf('captcha') > PLANS.web.indexOf('web'));
    assert.ok(PLANS.all.indexOf('captcha') > PLANS.all.indexOf('web'));
  });
});

// ─── Whole runs ─────────────────────────────────────────────────────────────

describe('deploy: settings and preflight', () => {
  it('fails once, naming every missing setting, before any request or command', async () => {
    const w = world();
    const res = await run(w, {
      env: {
        CLOUDFLARE_API_TOKEN: '',
        SUPABASE_URL: '',
        SUPABASE_DB_PASSWORD: '',
        SUPABASE_ANON_KEY: '',
      },
    });
    assert.equal(res.code, 1);
    for (const name of [
      'CLOUDFLARE_API_TOKEN',
      'SUPABASE_URL',
      'SUPABASE_DB_PASSWORD',
      'SUPABASE_ANON_KEY',
    ])
      assert.match(res.summary, new RegExp(`${name} is missing`));
    assert.match(res.summary, /4 setting\(s\) missing or malformed; nothing was changed/);
    assert.equal(w.st.events.length, 0);
    assertNoLeaks(res, Object.values(T));
  });

  it('refuses a hostile admin_email before anything else', async () => {
    const w = world();
    const res = await run(w, {
      argv: ['--target', 'supabase', '--admin-email', "x@y.io'; drop table x; --"],
    });
    assert.equal(res.code, 1);
    assert.match(res.summary, /admin_email.*is not an email address/);
    assert.ok(!res.stdout.includes('drop table'));
    assert.equal(w.st.events.length, 0);
  });

  it('`check` verifies everything and changes nothing', async () => {
    const w = world();
    const res = await run(w, {
      argv: ['--target', 'check'],
      env: { ADMIN_EMAIL: 'mod@example.com' },
    });
    assert.equal(res.code, 1, 'the moderator does not exist yet');
    assert.deepEqual(
      writes(w).filter((e) => !e.path.endsWith('/database/query')),
      [],
    );
    assert.match(res.summary, /No user with the email mod@example\.com.*Add user/);

    const w2 = world({ users: new Set(['mod@example.com']) });
    const ok = await run(w2, {
      argv: ['--target', 'check'],
      env: { ADMIN_EMAIL: 'mod@example.com' },
    });
    assert.equal(ok.code, 0, ok.stdout);
    for (const e of writes(w2)) {
      assert.ok(e.path.endsWith('/database/query'), `${e.method} ${e.path}`);
      assert.match(e.body.query, /^select /);
      assert.doesNotMatch(e.body.query, /insert|create_secret|update_secret|delete/);
    }
    assert.deepEqual(runs(w2).map(commandOf), [
      'supabase link --project-ref',
      'supabase migration list',
    ]);
    assert.match(ok.summary, /### Checks/);
    assert.match(ok.summary, /Pages project build-roulette-web\*\*: missing: it will be created/);
    assert.match(ok.summary, /3 migration\(s\) to apply/);
    assert.match(ok.summary, /mod@example\.com exists/);
    assert.match(ok.summary, /run the workflow again with target \*\*all\*\*/);
    assert.equal(w2.st.projects.size, 0);
    assert.equal(w2.st.vault.size, 0);
  });

  it('a paused project: a clear message, and nothing changes', async () => {
    const w = world();
    w.st.sbProject.status = 'INACTIVE';
    const res = await run(w);
    assert.equal(res.code, 1);
    assert.match(res.summary, /PAUSED.*Restore project/);
    assert.match(res.stdout, /::error title=Deploy failed: Preflight::/);
    assert.deepEqual(changes(w), []);
    assert.deepEqual(runs(w), [], 'not even supabase link');
  });

  it('names token and permission problems together', async () => {
    const w = world();
    w.st.tokens.get(T.cf).pages = false;
    w.st.tokens.set(T.br, { status: 'expired', kind: 'user', pages: true });
    w.st.anonKeys.clear();
    const res = await run(w);
    assert.equal(res.code, 1);
    assert.match(
      res.summary,
      /CLOUDFLARE_API_TOKEN cannot use Cloudflare Pages.*Cloudflare Pages → Edit/,
    );
    assert.match(res.summary, /BROWSER_RENDERING_API_TOKEN is expired/);
    assert.match(res.summary, /SUPABASE_ANON_KEY is not a key of the project/);
    assert.deepEqual(changes(w), []);
  });

  it('the Browser Rendering token is only verified (/user/tokens/verify), nothing else', async () => {
    const w = world();
    const res = await run(w, { argv: ['--target', 'check'] });
    assert.equal(res.code, 0, res.summary);
    const used = http(w).filter((e) => e.token === 'br');
    assert.deepEqual(
      used.map((e) => `${e.method} ${e.path}`),
      ['GET /client/v4/user/tokens/verify'],
    );
    assert.match(res.summary, /BROWSER_RENDERING_API_TOKEN\*\*: active/);
    // An account-owned token is not tried on the account: the docs ask for a user token.
    w.st.tokens.get(T.br).kind = 'account';
    const refused = await run(w, { argv: ['--target', 'check'] });
    assert.equal(refused.code, 1);
    assert.match(refused.summary, /BROWSER_RENDERING_API_TOKEN was refused.*Browser Run → Edit/);
  });

  it('accepts an account-owned Cloudflare deploy token', async () => {
    const w = world();
    w.st.tokens.get(T.cf).kind = 'account';
    const res = await run(w, { argv: ['--target', 'check'] });
    assert.equal(res.code, 0, res.summary);
    assert.match(res.summary, /CLOUDFLARE_API_TOKEN\*\*: active \(account token\)/);
  });

  it('refuses a wrong Supabase access token, a Git-connected project, remote-only migrations', async () => {
    const w = world({ remoteOnly: ['20250101000000'] });
    w.st.projects.set('build-roulette-web', {
      name: 'build-roulette-web',
      subdomain: 'build-roulette-web.pages.dev',
      production_branch: 'main',
      source: { type: 'github' },
      deployment_configs: { production: { env_vars: {} } },
    });
    const res = await run(w, { argv: ['--target', 'check'] });
    assert.match(res.summary, /connected to Git \(github\)/);
    assert.match(res.summary, /migrations that this repository does not \(20250101000000\)/);
    const w2 = world();
    const res2 = await run(w2, {
      argv: ['--target', 'check'],
      env: { SUPABASE_ACCESS_TOKEN: `sbp_${hex(20)}` },
    });
    assert.match(
      res2.summary,
      /Access token: Supabase refused SUPABASE_ACCESS_TOKEN \(HTTP 401\) when the run tried to read the project: create a token with full access to this project, or a legacy token/,
    );
  });

  it('explains a wrong database password, and shows the CLI output redacted', async () => {
    const stderr = `connecting with ${T.db}\nFATAL: password authentication failed for user "postgres" (SQLSTATE 28P01)\n`;
    const w = world({ fail: (cmd, args) => cmd === 'npx' && args[2] === 'migration' && stderr });
    const res = await run(w, { argv: ['--target', 'check'] });
    assert.equal(res.code, 1);
    assert.match(res.summary, /Database password: the database refused SUPABASE_DB_PASSWORD/);
    assert.match(res.summary, /- \(supabase CLI\) connecting with \*\*\*/);
    assertNoLeaks(res, Object.values(T));
  });

  it('`check` proves the CLI accepts the token: a format it refuses is named, with no CLI run', async () => {
    // A token our API calls accept, in a format the CLI 2.119.0 refuses (built at runtime).
    const scoped = ['sbp', 'v1', hex(24)].join('_');
    const w = world({ sbToken: scoped });
    const res = await run(w, {
      argv: ['--target', 'check'],
      env: { SUPABASE_ACCESS_TOKEN: scoped },
    });
    assert.equal(res.code, 1);
    assert.match(
      res.summary,
      /Access token format: SUPABASE_ACCESS_TOKEN does not have the format the Supabase CLI 2\.119\.0 accepts.*create a token with full access to this project, or a legacy token/,
    );
    assert.match(res.summary, /Supabase project\*\*: build-roulette/, 'the API checks still ran');
    assert.deepEqual(runs(w), []);
    assertNoLeaks(res, [...Object.values(T), scoped]);
    // The web target does not use the CLI: the same token is fine there.
    const web = await run(world({ sbToken: scoped }), {
      argv: ['--target', 'web'],
      env: { SUPABASE_ACCESS_TOKEN: scoped },
    });
    assert.equal(web.code, 0, web.summary);
  });

  it('names the part of a `supabase link` failure: permissions, project access', async () => {
    const forbidden =
      'Unexpected error retrieving remote project status: {"message":"Forbidden resource"} (403)\n';
    const w = world({ fail: (cmd, args) => cmd === 'npx' && args[2] === 'link' && forbidden });
    const res = await run(w, { argv: ['--target', 'check'] });
    assert.equal(res.code, 1);
    assert.match(
      res.summary,
      /Access token permissions: the token may not do what supabase link needs.*full access to this project, or a legacy token/,
    );
    assert.deepEqual(runs(w).map(commandOf), ['supabase link --project-ref']);
    assert.deepEqual(
      writes(w).filter((e) => !e.path.endsWith('/database/query')),
      [],
    );
  });

  it('names a Management API permission the scoped token lacks, before any change', async () => {
    const w = world({ deny: new Set(['GET /secrets']) });
    const res = await run(w);
    assert.equal(res.code, 1);
    assert.match(
      res.summary,
      /Access token permissions: the token may not read the functions' secrets on project abcdefghijklmnopqrst \(HTTP 403\): create a token with full access to this project, or a legacy token/,
    );
    assert.deepEqual(
      writes(w).filter((e) => !e.path.endsWith('/database/query')),
      [],
    );
    assert.equal(w.st.projects.size, 0);
  });

  it('a write the scoped token may not do fails with the token hint', async () => {
    const w = world({ deny: new Set(['PATCH /config/auth']) });
    const res = await run(w);
    assert.equal(res.code, 1);
    assert.match(res.summary, /### Failed: Auth settings/);
    assert.match(res.summary, /changing the Auth settings .*HTTP 403/);
    assert.match(
      res.summary,
      /Access token permissions: SUPABASE_ACCESS_TOKEN may not make this change/,
    );
  });

  it('refuses to deploy an app without a site key while CAPTCHA is on in Supabase', async () => {
    const w = world();
    w.st.auth.security_captcha_enabled = true;
    const res = await run(w, { argv: ['--target', 'web'] });
    assert.equal(res.code, 1);
    assert.match(res.summary, /CAPTCHA is ON in Supabase but TURNSTILE_SITE_KEY is not set/);
    assert.deepEqual(changes(w), []);
  });
});

describe('deploy: target all', () => {
  it('a first run creates the projects, generates both secrets and deploys everything, in order', async () => {
    const w = world();
    const res = await run(w);
    assert.equal(res.code, 0, res.summary);

    // Pages projects created, with production branch main.
    const creates = writes(w).filter(
      (e) => e.method === 'POST' && e.path.endsWith('/pages/projects'),
    );
    assert.deepEqual(
      creates.map((e) => e.body),
      [
        { name: 'build-roulette-web', production_branch: 'main' },
        { name: 'build-roulette-sandbox', production_branch: 'main' },
      ],
    );
    // Vault: two generated secrets (64 hex) and the function URL.
    const cron = w.st.vault.get(VAULT.cronSecret);
    const capture = w.st.vault.get(VAULT.captureSecret);
    assert.match(cron, /^[0-9a-f]{64}$/);
    assert.match(capture, /^[0-9a-f]{64}$/);
    assert.notEqual(cron, capture);
    assert.equal(w.st.vault.get(VAULT.functionUrl), `https://${REF}.supabase.co/functions/v1/jobs`);
    // The function's secrets.
    assert.deepEqual(Object.fromEntries(w.st.fnSecrets), {
      JOBS_CRON_SECRET: cron,
      CAPTURE_SHELL_URL: 'https://build-roulette-sandbox.pages.dev/v1/capture',
      CAPTURE_HMAC_SECRET: capture,
      PKG_CDN_URL: 'https://esm.sh',
      BROWSER_RENDERING_ACCOUNT_ID: ACCOUNT,
      BROWSER_RENDERING_API_TOKEN: T.br,
    });
    // The shell's Pages secret is the same capture secret.
    const shellVars =
      w.st.projects.get('build-roulette-sandbox').deployment_configs.production.env_vars;
    assert.deepEqual(shellVars.CAPTURE_HMAC_SECRET, { type: 'secret_text', value: capture });
    // Auth.
    assert.equal(w.st.auth.external_anonymous_users_enabled, true);
    assert.equal(w.st.auth.site_url, 'https://build-roulette-web.pages.dev');
    assert.equal(w.st.auth.uri_allow_list, 'https://build-roulette-web.pages.dev');
    assert.equal(w.st.auth.security_captcha_enabled, false);

    // The commands, in order, with what each needs and nothing more.
    assert.deepEqual(runs(w).map(commandOf), [
      'supabase link --project-ref',
      'supabase migration list',
      'supabase db push',
      'supabase functions deploy',
      'pnpm --filter @br/sandbox-shell build',
      'pnpm --filter @br/web exec wrangler pages deploy dist --cwd ../sandbox-shell --project-name build-roulette-sandbox --branch main',
      'pnpm --filter @br/web build',
      'pnpm --filter @br/web pages:deploy --branch main',
      `node /repo/scripts/deploy-check.mjs --app https://build-roulette-web.pages.dev --shell https://build-roulette-sandbox.pages.dev/v1/ --supabase https://${REF}.supabase.co --cdn https://esm.sh --json`,
    ]);
    const [link, list, push, fn, shellBuild, shellDeploy, webBuild, webDeploy, check] = runs(w);
    for (const r of [link, list, push]) {
      assert.equal(r.env.SUPABASE_ACCESS_TOKEN, '<secret:SUPABASE_ACCESS_TOKEN>');
      assert.equal(r.env.SUPABASE_DB_PASSWORD, '<secret:SUPABASE_DB_PASSWORD>');
      assert.ok(
        !r.args.some((a) => a.includes(T.db)),
        'the password never goes on the command line',
      );
    }
    assert.deepEqual(push.args.slice(2), ['db', 'push', '--linked', '--yes', '--skip-vault']);
    assert.deepEqual(fn.args.slice(2), [
      'functions',
      'deploy',
      'jobs',
      '--no-verify-jwt',
      '--use-api',
      '--project-ref',
      REF,
    ]);
    assert.equal(fn.env.SUPABASE_DB_PASSWORD, undefined);
    assert.equal(shellBuild.env.BR_APP_ORIGINS, 'https://build-roulette-web.pages.dev');
    assert.equal(shellBuild.env.BR_PKG_CDN_URL, 'https://esm.sh');
    for (const r of [shellDeploy, webDeploy]) {
      assert.equal(r.env.CLOUDFLARE_API_TOKEN, '<secret:CLOUDFLARE_API_TOKEN>');
      assert.equal(r.env.CLOUDFLARE_ACCOUNT_ID, ACCOUNT);
      assert.equal(r.env.SUPABASE_ACCESS_TOKEN, undefined);
    }
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(webBuild.env).filter(([k]) => k.startsWith('NEXT_PUBLIC_')),
      ),
      {
        NEXT_PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co`,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: '<secret:SUPABASE_ANON_KEY>',
        NEXT_PUBLIC_SANDBOX_SHELL_URL: 'https://build-roulette-sandbox.pages.dev/v1/',
        NEXT_PUBLIC_PKG_CDN_URL: 'https://esm.sh',
        NEXT_PUBLIC_SITE_URL: 'https://build-roulette-web.pages.dev',
      },
    );
    for (const r of [shellBuild, webBuild]) {
      for (const name of [
        'CLOUDFLARE_API_TOKEN',
        'SUPABASE_ACCESS_TOKEN',
        'SUPABASE_DB_PASSWORD',
        'BROWSER_RENDERING_API_TOKEN',
      ])
        assert.equal(r.env[name], undefined, `${name} in a build`);
      assert.ok(
        !Object.values(r.env).some(
          (v) => String(v).startsWith('<secret:') && v !== '<secret:SUPABASE_ANON_KEY>',
        ),
      );
    }
    assert.equal(check.env.SUPABASE_ANON_KEY, '<secret:SUPABASE_ANON_KEY>');
    assert.equal(check.env.JOBS_CRON_SECRET, '<secret:JOBS_CRON_SECRET>');

    // The summary: URLs, outcomes, deploy-check, next steps.
    assert.match(res.summary, /## Deploy, target `all`: succeeded/);
    assert.match(res.summary, /\| App \| https:\/\/build-roulette-web\.pages\.dev \|/);
    assert.match(res.summary, /\| Pages project build-roulette-web \| created \|/);
    assert.match(res.summary, /\| JOBS_CRON_SECRET \(Vault br_jobs_cron_secret\) \| created \|/);
    assert.match(res.summary, /\| CAPTCHA \| skipped \| no Turnstile keys set \|/);
    assert.match(res.summary, /### deploy-check\n\n2 passed, 1 warnings, 0 failed/);
    assert.match(res.summary, /\| WARN \| preview: a finished battle \|/);
    assert.match(res.summary, /Create the moderator: Supabase → Authentication → Users/);
    assert.match(res.summary, /DEPLOY\.md §6\.2/);
    assert.match(res.outputs, /^app_url=https:\/\/build-roulette-web\.pages\.dev$/m);
    assert.match(res.outputs, /^shell_url=https:\/\/build-roulette-sandbox\.pages\.dev\/v1\/$/m);
    assert.match(res.stdout, /Next steps:/, 'a readable form on stdout too');
    assertNoLeaks(res, allSecrets(w));
  });

  it('a second run is idempotent: no creates, the same secrets, nothing re-set', async () => {
    const w = world();
    assert.equal((await run(w)).code, 0);
    const vaultBefore = new Map(w.st.vault);
    const fnBefore = new Map(w.st.fnSecrets);
    w.st.events.length = 0;
    w.st.sql.length = 0;

    const res = await run(w);
    assert.equal(res.code, 0, res.summary);
    assert.deepEqual(w.st.vault, vaultBefore);
    assert.deepEqual(w.st.fnSecrets, fnBefore);
    const changes = writes(w).filter((e) => !e.path.endsWith('/database/query'));
    // Only the shell's Pages secret is set again (Cloudflare never shows it back).
    assert.deepEqual(
      changes.map((e) => `${e.method} ${e.path.replace(/^.*\/pages\/projects/, 'pages/projects')}`),
      ['PATCH pages/projects/build-roulette-sandbox'],
    );
    assert.ok(
      w.st.sql.every((q) => !/create_secret|update_secret/.test(q)),
      'no Vault writes',
    );
    assert.match(res.summary, /\| Pages project build-roulette-web \| unchanged \|/);
    assert.match(
      res.summary,
      /\| JOBS_CRON_SECRET \(Vault br_jobs_cron_secret\) \| unchanged \| kept \|/,
    );
    assert.match(
      res.summary,
      /\| CAPTURE_HMAC_SECRET \(Vault br_capture_hmac_secret\) \| unchanged \|/,
    );
    assert.match(res.summary, /\| Vault br_jobs_function_url \| unchanged \|/);
    assert.match(res.summary, /\| Database migrations \| unchanged \| already up to date \|/);
    assert.match(res.summary, /\| Auth settings \| unchanged \|/);
    assert.match(res.summary, /\| Function secrets \| unchanged \|/);
    assert.match(
      res.summary,
      /\| Pages secret CAPTURE_HMAC_SECRET \| updated \| set again from Vault/,
    );
    assertNoLeaks(res, allSecrets(w));
  });

  it('updates (never re-creates) a Vault value that changed, and adopts existing secrets', async () => {
    const cron = hex(32);
    const w = world({
      vault: new Map([
        [VAULT.cronSecret, cron],
        [VAULT.functionUrl, 'https://zyxwvutsrqponmlkjihg.supabase.co/functions/v1/jobs'],
      ]),
    });
    const res = await run(w);
    assert.equal(res.code, 0, res.summary);
    assert.equal(w.st.vault.get(VAULT.cronSecret), cron, 'the existing cron secret is kept');
    assert.equal(w.st.fnSecrets.get('JOBS_CRON_SECRET'), cron);
    assert.equal(w.st.vault.get(VAULT.functionUrl), `https://${REF}.supabase.co/functions/v1/jobs`);
    assert.equal(w.st.sql.filter((q) => q.includes('vault.update_secret')).length, 1);
    assert.equal(
      w.st.sql.filter((q) => q.includes('vault.create_secret')).length,
      1,
      'only the capture secret',
    );
    assert.match(res.summary, /\| Vault br_jobs_function_url \| updated \|/);
    assertNoLeaks(res, [...allSecrets(w), cron]);
  });

  it('refuses an unusable Vault secret instead of deploying it', async () => {
    const w = world({ vault: new Map([[VAULT.cronSecret, 'short']]) });
    const res = await run(w);
    assert.equal(res.code, 1);
    assert.match(res.summary, /br_jobs_cron_secret is not usable.*delete from vault\.secrets/);
  });

  it('a suffixed pages.dev name reaches every URL, origin and build setting', async () => {
    const w = world({
      subdomains: {
        'build-roulette-web': 'build-roulette-web-3xk.pages.dev',
        'build-roulette-sandbox': 'build-roulette-sandbox-9q2.pages.dev',
      },
    });
    const res = await run(w);
    assert.equal(res.code, 0, res.summary);
    const app = 'https://build-roulette-web-3xk.pages.dev';
    const shell = 'https://build-roulette-sandbox-9q2.pages.dev/v1/';
    assert.equal(w.st.fnSecrets.get('CAPTURE_SHELL_URL'), `${shell}capture`);
    assert.equal(pnpmRun(w, 'sandbox-shell build').env.BR_APP_ORIGINS, app);
    const webBuild = pnpmRun(w, '@br/web build');
    assert.equal(webBuild.env.NEXT_PUBLIC_SITE_URL, app);
    assert.equal(webBuild.env.NEXT_PUBLIC_SANDBOX_SHELL_URL, shell);
    assert.equal(w.st.auth.site_url, app);
    assert.equal(w.st.auth.uri_allow_list, app);
    const check = smokeRun(w);
    assert.equal(argAfter(check.args, '--app'), app);
    assert.equal(argAfter(check.args, '--shell'), shell);
    assert.match(res.summary, new RegExp(`\\| App \\| ${app.replaceAll('.', '\\.')} \\|`));
    assert.match(res.outputs, new RegExp(`app_url=${app}`));
  });

  it('a custom APP_URL: the app address everywhere, and the pages.dev origin may frame the shell too', async () => {
    const w = world({ auth: { ...world().st.auth, uri_allow_list: 'http://localhost:3000' } });
    const res = await run(w, { env: { APP_URL: 'https://play.example.com' } });
    assert.equal(res.code, 0, res.summary);
    assert.equal(
      pnpmRun(w, 'sandbox-shell build').env.BR_APP_ORIGINS,
      'https://play.example.com,https://build-roulette-web.pages.dev',
    );
    assert.equal(pnpmRun(w, '@br/web build').env.NEXT_PUBLIC_SITE_URL, 'https://play.example.com');
    assert.equal(w.st.auth.site_url, 'https://play.example.com');
    assert.equal(
      w.st.auth.uri_allow_list,
      'http://localhost:3000,https://play.example.com,https://build-roulette-web.pages.dev',
    );
    assert.equal(argAfter(smokeRun(w).args, '--app'), 'https://play.example.com');
  });

  it("refuses an APP_URL on pages.dev that is not the web project's", async () => {
    const w = world();
    const res = await run(w, { env: { APP_URL: 'https://build-roulette-web.pages.dev' } });
    assert.equal(res.code, 0, 'the default address itself is fine');
    const w2 = world({ subdomains: { 'build-roulette-web': 'build-roulette-web-3xk.pages.dev' } });
    const res2 = await run(w2, { env: { APP_URL: 'https://build-roulette-web.pages.dev' } });
    assert.equal(res2.code, 1);
    assert.match(
      res2.summary,
      /not the web project's \(https:\/\/build-roulette-web-3xk\.pages\.dev\)/,
    );
  });

  it('other project names, an existing production branch, and the optional build settings', async () => {
    const w = world();
    w.st.projects.set('my-shell', {
      name: 'my-shell',
      subdomain: 'my-shell.pages.dev',
      production_branch: 'production',
      deployment_configs: { production: { env_vars: {}, wrangler_config_hash: 'h1' } },
    });
    const sentry = `https://${hex(16)}@o1.ingest.sentry.io/2`;
    const res = await run(w, {
      env: {
        CF_PAGES_WEB_PROJECT: 'my-web',
        CF_PAGES_SHELL_PROJECT: 'my-shell',
        PKG_CDN_URL: 'https://cdn.example.com/',
        NEXT_PUBLIC_SENTRY_DSN: sentry,
        NEXT_PUBLIC_POSTHOG_KEY: `phc_${hex(10)}`,
        NEXT_PUBLIC_POSTHOG_HOST: 'https://eu.i.posthog.com',
      },
    });
    assert.equal(res.code, 0, res.summary);
    const shellDeploy = pnpmRun(w, 'wrangler pages deploy');
    assert.equal(argAfter(shellDeploy.args, '--project-name'), 'my-shell');
    assert.equal(argAfter(shellDeploy.args, '--branch'), 'production');
    const webDeploy = pnpmRun(w, 'pages:deploy');
    assert.deepEqual(webDeploy.args.slice(3), ['--branch', 'main', '--project-name', 'my-web']);
    const env = pnpmRun(w, '@br/web build').env;
    assert.equal(env.NEXT_PUBLIC_SENTRY_DSN, sentry);
    assert.equal(env.NEXT_PUBLIC_POSTHOG_HOST, 'https://eu.i.posthog.com');
    assert.equal(env.NEXT_PUBLIC_PKG_CDN_URL, 'https://cdn.example.com');
    assert.equal(w.st.fnSecrets.get('PKG_CDN_URL'), 'https://cdn.example.com');
    const patch = writes(w).find((e) => e.method === 'PATCH' && e.path.endsWith('/my-shell'));
    assert.equal(patch.body.deployment_configs.production.wrangler_config_hash, 'h1');
    assert.match(res.summary, /with Sentry, PostHog/);
  });

  it('turns CAPTCHA on only with both keys, and only after the web deploy', async () => {
    const w = world();
    const res = await run(w, {
      env: { TURNSTILE_SITE_KEY: TURNSTILE_SITE, TURNSTILE_SECRET_KEY: T.turnstileSecret },
    });
    assert.equal(res.code, 0, res.summary);
    const events = w.st.events;
    const webDeploy = events.findIndex((e) => e.kind === 'run' && e.args.includes('pages:deploy'));
    const captchaPatch = events.findIndex(
      (e) => e.kind === 'http' && e.method === 'PATCH' && e.body?.security_captcha_enabled === true,
    );
    assert.ok(webDeploy >= 0 && captchaPatch > webDeploy, 'CAPTCHA after the web deploy');
    assert.equal(events[captchaPatch].body.security_captcha_provider, 'turnstile');
    assert.equal(w.st.auth.security_captcha_secret, T.turnstileSecret);
    assert.equal(pnpmRun(w, '@br/web build').env.NEXT_PUBLIC_TURNSTILE_SITE_KEY, TURNSTILE_SITE);
    assert.match(res.summary, /\| CAPTCHA \| created \| Cloudflare Turnstile \|/);
    assertNoLeaks(res, allSecrets(w));

    w.st.events.length = 0;
    const again = await run(w, {
      env: { TURNSTILE_SITE_KEY: TURNSTILE_SITE, TURNSTILE_SECRET_KEY: T.turnstileSecret },
    });
    assert.match(again.summary, /\| CAPTCHA \| unchanged \|/);
    assert.ok(!writes(w).some((e) => e.body?.security_captcha_enabled !== undefined));
  });

  it('a failed web deploy leaves CAPTCHA off', async () => {
    const w = world({ fail: (cmd, args) => cmd === 'pnpm' && args.includes('pages:deploy') });
    const res = await run(w, {
      env: { TURNSTILE_SITE_KEY: TURNSTILE_SITE, TURNSTILE_SECRET_KEY: T.turnstileSecret },
    });
    assert.equal(res.code, 1);
    assert.equal(w.st.auth.security_captcha_enabled, false);
    assert.match(res.summary, /### Failed: Web app/);
    assert.match(res.summary, /wrangler pages deploy \(web app\) failed \(exit 1\)/);
    assert.match(res.summary, /- last line/);
    assertNoLeaks(res, allSecrets(w));
  });

  it('half-configured Turnstile: a warning, the site key in the build, CAPTCHA untouched', async () => {
    const w = world();
    const res = await run(w, { env: { TURNSTILE_SITE_KEY: TURNSTILE_SITE } });
    assert.equal(res.code, 0, res.summary);
    assert.match(res.stdout, /::warning title=Deploy::Turnstile is half configured/);
    assert.match(res.summary, /### Warnings\n\n- Turnstile is half configured/);
    assert.match(
      res.summary,
      /\| CAPTCHA \| skipped \| only one of TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY is set \|/,
    );
    assert.equal(w.st.auth.security_captcha_enabled, false);
    assert.ok(!writes(w).some((e) => e.body?.security_captcha_enabled !== undefined));
  });

  it('lists the moderator: unknown user fails early, then created, then unchanged', async () => {
    const w = world();
    const missing = await run(w, { env: { ADMIN_EMAIL: 'Mod@Example.com' } });
    assert.equal(missing.code, 1);
    assert.match(
      missing.summary,
      /No user with the email Mod@Example\.com.*Authentication → Users.*Auto Confirm User/,
    );
    assert.deepEqual(
      writes(w).filter((e) => !e.path.endsWith('/database/query')),
      [],
      'nothing changed',
    );

    w.st.users.add('mod@example.com');
    const first = await run(w, { env: { ADMIN_EMAIL: 'Mod@Example.com' } });
    assert.equal(first.code, 0, first.summary);
    assert.deepEqual([...w.st.admins], ['mod@example.com']);
    assert.match(first.summary, /\| Moderator Mod@Example\.com \| created \|/);
    assert.doesNotMatch(first.summary, /Create the moderator/);
    const insert = w.st.sql.find((q) => q.includes('insert into private.admins'));
    assert.match(insert, /lower\(\$q_[0-9a-f]{16}\$Mod@Example\.com\$q_[0-9a-f]{16}\$\)/);

    const second = await run(w, {
      argv: ['--target', 'supabase', '--admin-email', 'mod@example.com'],
    });
    assert.equal(second.code, 0, second.summary);
    assert.match(second.summary, /\| Moderator mod@example\.com \| unchanged \|/);
  });

  it('retries deploy-check while Pages propagates; WARNs go to the summary', async () => {
    const fail = [{ level: 'FAIL', name: 'app / answers 200', detail: 'HTTP 404' }];
    const w = world({ smoke: [fail, fail] });
    const res = await run(w);
    assert.equal(res.code, 0, res.summary);
    assert.deepEqual(res.sleeps, SMOKE_DELAYS_MS.slice(0, 2));
    assert.equal(runs(w).filter((r) => r.cmd === process.execPath).length, 3);
    assert.match(res.summary, /\| WARN \| preview: a finished battle \|/);
  });

  it('fails when deploy-check still FAILs after every try', async () => {
    const fail = [
      { level: 'PASS', name: 'app / answers 200', detail: '' },
      {
        level: 'FAIL',
        name: 'shell: the capture gate',
        detail: '503: CAPTURE_HMAC_SECRET is not set',
      },
    ];
    const w = world({ smoke: [fail, fail, fail, fail] });
    const res = await run(w);
    assert.equal(res.code, 1);
    assert.deepEqual(res.sleeps, SMOKE_DELAYS_MS);
    assert.match(res.summary, /deploy-check still FAILs after 4 tries/);
    assert.match(res.summary, /\| FAIL \| shell: the capture gate \| 503/);
    assert.match(res.summary, /1 passed, 0 warnings, 1 failed/);
  });

  it('stops when the schema checks fail after db push', async () => {
    const w = world();
    w.st.schema = { ...w.st.schema, cards: 0 };
    const res = await run(w);
    assert.equal(res.code, 1);
    assert.match(res.summary, /### Failed: Supabase schema \(db push\)/);
    assert.match(res.summary, /prompt_cards is empty/);
    assert.ok(!runs(w).some((r) => r.cmd === 'pnpm'), 'nothing deployed after a bad schema');
  });

  it('reads json results given as text', async () => {
    const w = world({ resultAsText: true });
    assert.equal((await run(w)).code, 0);
  });
});

describe('deploy: partial targets', () => {
  it('`shell` alone needs the capture secret from Vault, and fails before any change without it', async () => {
    const w = world();
    const res = await run(w, { argv: ['--target', 'shell'] });
    assert.equal(res.code, 1);
    assert.match(
      res.summary,
      /CAPTURE_HMAC_SECRET is not in Supabase Vault yet.*target supabase \(or all\) first/,
    );
    assert.deepEqual(
      writes(w).filter((e) => !e.path.endsWith('/database/query')),
      [],
    );
    assert.deepEqual(runs(w), []);
  });

  it('`shell` alone takes the secret from Vault and deploys only the shell', async () => {
    const capture = hex(32);
    const w = world({ vault: new Map([[VAULT.captureSecret, capture]]) });
    const res = await run(w, { argv: ['--target', 'shell'] });
    assert.equal(res.code, 0, res.summary);
    assert.deepEqual(runs(w).map(commandOf), [
      'pnpm --filter @br/sandbox-shell build',
      'pnpm --filter @br/web exec wrangler pages deploy dist --cwd ../sandbox-shell --project-name build-roulette-sandbox --branch main',
    ]);
    const vars = w.st.projects.get('build-roulette-sandbox').deployment_configs.production.env_vars;
    assert.equal(vars.CAPTURE_HMAC_SECRET.value, capture);
    assert.match(res.summary, /Run target \*\*all\*\*/);
    assertNoLeaks(res, [...Object.values(T), capture]);
  });

  it('`web` alone builds and deploys the app (and CAPTCHA), nothing else', async () => {
    const w = world();
    const res = await run(w, {
      argv: ['--target', 'web', '--admin-email', 'mod@example.com'],
      env: { SUPABASE_DB_PASSWORD: '', BROWSER_RENDERING_API_TOKEN: '' },
    });
    assert.equal(res.code, 0, res.summary);
    assert.deepEqual(runs(w).map(commandOf), [
      'pnpm --filter @br/web build',
      'pnpm --filter @br/web pages:deploy --branch main',
    ]);
    assert.match(res.summary, /admin_email is used by the targets all and supabase/);
    assert.equal(w.st.vault.size, 0);
  });

  it('`supabase` deploys the database side and the function, not the sites', async () => {
    const w = world();
    const res = await run(w, { argv: ['--target', 'supabase'] });
    assert.equal(res.code, 0, res.summary);
    assert.deepEqual(runs(w).map(commandOf), [
      'supabase link --project-ref',
      'supabase migration list',
      'supabase db push',
      'supabase functions deploy',
    ]);
    assert.equal(
      w.st.fnSecrets.get('CAPTURE_SHELL_URL'),
      'https://build-roulette-sandbox.pages.dev/v1/capture',
    );
    assert.match(res.summary, /Create the moderator/);
  });
});

describe('the command runner', () => {
  it('passes output through the redaction, captures stdout on request, feeds stdin', async () => {
    let stdout = '';
    let stderr = '';
    const out = createOutput({
      stdout: (s) => {
        stdout += s;
      },
      stderr: (s) => {
        stderr += s;
      },
      github: false,
      appendFile: () => {},
    });
    const secret = hex(16);
    out.addSecret(secret);
    const run = createRunner(out);
    const script = `process.stdin.on('data', (d) => { process.stdout.write('in:' + d + '\\nout ${secret} end'); process.stderr.write('err ${secret}\\n'); process.exitCode = 3; });`;
    const r = await run(process.execPath, ['-e', script], { input: 'hello', env: { PATH: '' } });
    assert.equal(r.code, 3);
    assert.equal(stdout, 'in:hello\nout *** end\n');
    assert.equal(stderr, 'err ***\n');
    assert.ok(r.stderr.includes(secret), 'the raw stderr tail is returned; callers redact it');
    const c = await run(process.execPath, ['-e', 'console.log(JSON.stringify({a: 1}))'], {
      capture: true,
    });
    assert.deepEqual(JSON.parse(c.stdout), { a: 1 });
    assert.equal(c.code, 0);
  });
});

describe('output', () => {
  it('masks every secret before printing anything, outside GitHub too it redacts', async () => {
    const w = world();
    const res = await run(w, { github: false });
    assert.equal(res.code, 0, res.stdout);
    assert.ok(!res.stdout.includes('::add-mask::'));
    for (const secret of allSecrets(w)) {
      assert.ok(!res.stdout.includes(secret), 'stdout');
      assert.ok(!res.stderr.includes(secret), 'stderr');
    }
    assert.match(res.stdout, /linking with \*\*\* and \*\*\*/, 'child output is redacted');
  });

  it('on GitHub the first lines are the masks (escaped), in a fixed order', async () => {
    const w = world();
    const res = await run(w, { argv: ['--target', 'check'] });
    const lines = res.stdout.split('\n');
    const masks = lines.slice(0, 5);
    assert.ok(
      masks.every((l) => l.startsWith('::add-mask::')),
      masks.join('\n'),
    );
    assert.ok(
      masks.includes(`::add-mask::${T.db.replace('%', '%25')}`),
      'the % of the password is escaped',
    );
  });
});
