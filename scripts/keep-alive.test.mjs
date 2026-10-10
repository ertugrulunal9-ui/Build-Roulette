// Tests of scripts/keep-alive.sh (T-036), the step of .github/workflows/keep-alive.yml, against
// a local stand-in of the Supabase API: every answer it must pass or fail loudly on.
//   node --test scripts/keep-alive.test.mjs        (needs bash and curl)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

const SCRIPT = fileURLToPath(new URL('./keep-alive.sh', import.meta.url));
const WORKFLOW = fileURLToPath(new URL('../.github/workflows/keep-alive.yml', import.meta.url));
const JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJyb2xlIjoiYW5vbiJ9', 'c2ln'].join('.');

function runScript(env) {
  return new Promise((resolve) => {
    const child = spawn('bash', [SCRIPT], {
      env: {
        PATH: process.env.PATH,
        KEEP_ALIVE_ALLOW_HTTP: '1',
        KEEP_ALIVE_RETRY_DELAY: '0',
        KEEP_ALIVE_MAX_TIME: '5',
        ...env,
      },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
  });
}

describe('keep-alive.sh', () => {
  let server;
  let url;
  let reply = { status: 200, body: '' };
  const seen = [];
  before(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        seen.push({ method: req.method, path: req.url, headers: req.headers, body });
        res.writeHead(reply.status, { 'content-type': 'application/json' }).end(reply.body);
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${String(server.address().port)}`;
  });
  after(() => new Promise((r) => server.close(r)));

  it("passes on keep_alive's answer, with one POST carrying the key", async () => {
    reply = {
      status: 200,
      body: '{"ok": true, "read_only": false, "at": "2026-10-10T04:23:00+00:00"}',
    };
    seen.length = 0;
    const r = await runScript({ SUPABASE_URL: `${url}/`, SUPABASE_ANON_KEY: JWT });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /::notice title=Supabase is awake::/);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, 'POST');
    assert.equal(seen[0].path, '/rest/v1/rpc/keep_alive');
    assert.equal(seen[0].body, '{}');
    assert.equal(seen[0].headers.apikey, JWT);
    assert.equal(seen[0].headers.authorization, `Bearer ${JWT}`);
    assert.ok(!r.out.includes(JWT), 'the key is never printed');
  });

  it('sends a publishable key in apikey only', async () => {
    reply = { status: 200, body: '{"ok":true,"read_only":false}' };
    seen.length = 0;
    const key = 'sb_publishable_' + 'k'.repeat(24);
    const r = await runScript({ SUPABASE_URL: url, SUPABASE_ANON_KEY: key });
    assert.equal(r.code, 0, r.out);
    assert.equal(seen[0].headers.apikey, key);
    assert.equal(seen[0].headers.authorization, undefined);
  });

  const failing = [
    [540, '{"message":"Project paused"}', /Supabase project is PAUSED/],
    [402, '{"message":"restricted"}', /Supabase project is RESTRICTED/],
    [200, '{"ok": false, "read_only": true, "at": "x"}', /Supabase database is READ-ONLY/],
    [200, '<html>a login page</html>', /Unexpected answer/],
    [401, '{"message":"Invalid API key"}', /Key refused/],
    [404, '{"code":"PGRST202"}', /keep_alive not found/],
    [500, '{}', /Keep-alive failed::HTTP 500/],
  ];
  for (const [status, body, message] of failing) {
    it(`fails loudly on HTTP ${String(status)} ${body.slice(0, 24)}`, async () => {
      reply = { status, body };
      const r = await runScript({ SUPABASE_URL: url, SUPABASE_ANON_KEY: JWT });
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, new RegExp(`::error title=${message.source}`));
    });
  }

  it('fails when nothing answers', async () => {
    const r = await runScript({ SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_ANON_KEY: JWT });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /::error title=No answer::/);
  });

  it('passes with a notice when nothing is configured (a fork, no deployment yet)', async () => {
    const r = await runScript({ SUPABASE_URL: '', SUPABASE_ANON_KEY: '' });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /::notice title=Keep-alive not configured::/);
  });

  it('fails on half a configuration or a non-https URL', async () => {
    const half = await runScript({ SUPABASE_URL: url, SUPABASE_ANON_KEY: '' });
    assert.equal(half.code, 1);
    assert.match(half.out, /misconfigured/);
    const http = await runScript({
      SUPABASE_URL: url,
      SUPABASE_ANON_KEY: JWT,
      KEEP_ALIVE_ALLOW_HTTP: '',
    });
    assert.equal(http.code, 1);
    assert.match(http.out, /must be https/);
  });
});

describe('keep-alive.yml', () => {
  const yml = readFileSync(WORKFLOW, 'utf8');
  it('runs the script daily off the hour, by hand too, from repository settings', () => {
    assert.match(yml, /- cron: '23 4 \* \* \*'/);
    assert.match(yml, /workflow_dispatch:/);
    assert.match(yml, /run: bash scripts\/keep-alive\.sh/);
    assert.match(yml, /SUPABASE_URL: \$\{\{ vars\.SUPABASE_URL \}\}/);
    assert.match(yml, /SUPABASE_ANON_KEY: \$\{\{ secrets\.SUPABASE_ANON_KEY \}\}/);
  });
  it('holds no key-shaped value', () => {
    assert.doesNotMatch(yml, /eyJ[A-Za-z0-9_-]{10,}|sb_(publishable|secret)_[A-Za-z0-9]/);
  });
});
