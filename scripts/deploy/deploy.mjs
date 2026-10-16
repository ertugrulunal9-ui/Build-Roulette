#!/usr/bin/env node
// One-command deploy of the free setup (T-042; DEPLOY.md, "Deploy with GitHub Actions"):
// what DEPLOY.md §2.2, §3.2–§3.8, §4 and §6.1 do by hand, idempotently. Run by
// .github/workflows/deploy.yml on GitHub's runners; runs the same way locally:
//
//   node --env-file=.env.deploy scripts/deploy/deploy.mjs --target <all|check|supabase|shell|web> \
//     [--admin-email <email of a user created in Supabase → Authentication → Users>]
//
// Every setting comes from the environment (scripts/deploy/settings.mjs; the target and the
// email also from DEPLOY_TARGET and ADMIN_EMAIL). A second run with nothing changed creates
// nothing and keeps every generated secret: they live in Supabase Vault.
//
//   all       preflight, Pages projects, schema, Vault, Auth, the jobs function, shell, web,
//             CAPTCHA, moderator, deploy-check
//   check     preflight only: settings, tokens, the project's status, the database password
//   supabase  preflight, Pages projects (for the URLs), schema, Vault, Auth, the jobs function,
//             moderator
//   shell     preflight, Pages projects, the sandbox shell (its secret from Vault)
//   web       preflight, Pages projects, the web app, CAPTCHA
//
// On GitHub Actions (GITHUB_ACTIONS=true) every secret is masked (::add-mask::) before
// anything can print it, and the run writes a job summary ($GITHUB_STEP_SUMMARY) and the
// step outputs app_url and shell_url ($GITHUB_OUTPUT). Node 22, no dependencies.
// Tests: node --test scripts/deploy/*.test.mjs (part of `pnpm test:scripts`).

import { createHash, randomBytes as cryptoRandomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ApiError, authSettings, cloudflareApi, supabaseApi } from './apis.mjs';
import { createOutput } from './output.mjs';
import { createRunner } from './run.mjs';
import { DEFAULTS, NEEDS, TARGETS, childEnv, readSettings, secretValues } from './settings.mjs';
import {
  VAULT,
  addAdminSql,
  countAdminsSql,
  countUsersSql,
  createVaultSecretSql,
  evaluateSchema,
  isValidEmail,
  probeSql,
  readVaultSql,
  resultOf,
  schemaChecksSql,
  updateVaultSecretSql,
} from './sql.mjs';

/** The Supabase CLI this repository is tested with (supabase/README.md). */
export const SUPABASE_CLI = 'supabase@2.119.0';
/** The shell's version path: `/v${PROTOCOL_VERSION}/` (packages/protocol/src/messages.ts). */
export const SHELL_PATH = '/v1/';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/** deploy-check: the first try at once, then after 10, 20 and 30 s (Pages propagation). */
export const SMOKE_DELAYS_MS = [10_000, 20_000, 30_000];

const USAGE = `usage: node scripts/deploy/deploy.mjs --target <${TARGETS.join('|')}> [--admin-email <email>]
  Settings come from the environment (DEPLOY.md, "Deploy with GitHub Actions"); locally:
  node --env-file=.env.deploy scripts/deploy/deploy.mjs --target check`;

const TITLES = {
  preflight: 'Preflight',
  pages: 'Cloudflare Pages projects',
  schema: 'Supabase schema (db push)',
  vault: 'Generated secrets (Supabase Vault)',
  auth: 'Auth settings',
  functions: 'The jobs function: secrets and deploy',
  shell: 'Sandbox shell',
  web: 'Web app',
  captcha: 'CAPTCHA (Turnstile)',
  admin: 'Moderator',
  smoke: 'Smoke checks (scripts/deploy-check.mjs)',
};

export const PLANS = {
  all: [
    'preflight',
    'pages',
    'schema',
    'vault',
    'auth',
    'functions',
    'shell',
    'web',
    'captcha',
    'admin',
    'smoke',
  ],
  check: ['preflight'],
  supabase: ['preflight', 'pages', 'schema', 'vault', 'auth', 'functions', 'admin'],
  shell: ['preflight', 'pages', 'shell'],
  web: ['preflight', 'pages', 'web', 'captcha'],
};

/** A failure with a message for the user (and optionally a list of problems). */
export class DeployError extends Error {
  constructor(message, { problems = [] } = {}) {
    super(message);
    this.name = 'DeployError';
    this.problems = problems;
  }
}

/** Parses the command line (and DEPLOY_TARGET / ADMIN_EMAIL as fallbacks). */
export function parseArgs(argv, env = {}) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    const m = /^--(target|admin-email)(?:=(.*))?$/.exec(arg);
    if (!m) throw new Error(`unknown argument ${JSON.stringify(arg.slice(0, 40))}\n${USAGE}`);
    const value = m[2] ?? argv[++i];
    if (value === undefined) throw new Error(`--${m[1]} needs a value\n${USAGE}`);
    opts[m[1]] = value;
  }
  const target = (opts.target ?? env.DEPLOY_TARGET ?? '').trim() || 'all';
  if (!TARGETS.includes(target))
    throw new Error(`--target must be one of ${TARGETS.join(', ')}\n${USAGE}`);
  const email = (opts['admin-email'] ?? env.ADMIN_EMAIL ?? '').trim();
  return { target, adminEmail: email === '' ? undefined : email };
}

/** Merges URLs into Auth's comma-separated redirect allow list, keeping every entry. */
export function mergeAllowList(existing, urls) {
  const entries = String(existing ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const norm = (u) => u.replace(/\/+$/, '');
  const have = new Set(entries.map(norm));
  const added = [];
  for (const u of urls) {
    if (!have.has(norm(u))) {
      have.add(norm(u));
      added.push(u);
    }
  }
  return { value: [...entries, ...added].join(','), added };
}

/** What a project status means for the deploy (GET /v1/projects/{ref} → status). */
export function projectStatusProblem(status, ref) {
  if (status === 'ACTIVE_HEALTHY') return null;
  if (status === 'INACTIVE' || status === 'PAUSING' || status === 'PAUSE_FAILED') {
    return `The Supabase project ${ref} is PAUSED (status ${status}). Restore it: Supabase dashboard → the project → Restore project; when it shows as healthy again, run this workflow again.`;
  }
  if (['COMING_UP', 'RESTORING', 'RESTARTING', 'UPGRADING', 'RESIZING'].includes(status)) {
    return `The Supabase project ${ref} is not ready yet (status ${status}): wait a few minutes, then run this workflow again.`;
  }
  return `The Supabase project ${ref} is not healthy (status ${status}): check it in the Supabase dashboard and on https://status.supabase.com.`;
}

/**
 * The access token format the Supabase CLI 2.119.0 accepts in SUPABASE_ACCESS_TOKEN, checked
 * before it sends any request (its source: `/^sbp_(oauth_|v0_)?[a-f0-9]{40}$/`, "Invalid
 * access token format. Must be like `sbp_0102...1920`."). Our own Management API calls do not
 * need it; link, db push and functions deploy do.
 */
export const CLI_TOKEN_FORMAT = /^sbp_(oauth_|v0_)?[a-f0-9]{40}$/;
export const TOKEN_HINT = 'create a token with full access to this project, or a legacy token';

/** Which part of the Supabase access failed, from a Management API error. */
export function apiAccessProblem(e, what, ref) {
  const message = e instanceof Error ? e.message : String(e);
  if (e instanceof ApiError && e.status === 401)
    return `Access token: Supabase refused SUPABASE_ACCESS_TOKEN (HTTP 401) when the run tried to ${what}: ${TOKEN_HINT}.`;
  if (e instanceof ApiError && e.status === 403)
    return `Access token permissions: the token may not ${what} on project ${ref} (HTTP 403): ${TOKEN_HINT}.`;
  if (e instanceof ApiError && e.status === 404)
    return `Project access: the token cannot see the project ${ref} (HTTP 404 when the run tried to ${what}): check SUPABASE_URL; ${TOKEN_HINT}.`;
  return `Supabase, ${what}: ${message}`;
}

/**
 * Which part failed when the Supabase CLI did (`link`: the token and project access;
 * `database`: `migration list`, the database password and the connection), from its stderr.
 */
export function explainCliFailure(stderr, stage, ref) {
  const t = String(stderr ?? '').toLowerCase();
  if (t.includes('invalid access token format')) {
    return `Access token format: the Supabase CLI refuses the format of SUPABASE_ACCESS_TOKEN (it accepts sbp_ followed by 40 hex characters): ${TOKEN_HINT}.`;
  }
  if (t.includes('project is paused')) return projectStatusProblem('INACTIVE', ref);
  if (stage === 'database') {
    if (/password authentication failed|28p01/.test(t)) {
      return 'Database password: the database refused SUPABASE_DB_PASSWORD. Reset it (Supabase → Project Settings → Database → Reset database password) and update the secret.';
    }
    if (t.includes('ipv6 is not supported')) {
      return `Database connection: the CLI has no IPv4 address (the connection pooler) for the database. supabase link reads it with the access token, so the token may lack the permission to read the project's database settings: ${TOKEN_HINT}.`;
    }
    if (/\b401\b/.test(t))
      return `Access token: Supabase refused SUPABASE_ACCESS_TOKEN (HTTP 401): ${TOKEN_HINT}.`;
    if (/\b403\b/.test(t))
      return `Access token permissions: the token may not do what the CLI needs on project ${ref} (HTTP 403): ${TOKEN_HINT}.`;
    return 'Database: supabase migration list could not connect (its output is below). If SUPABASE_DB_PASSWORD is wrong: Supabase → Project Settings → Database → Reset database password, then update the secret.';
  }
  if (/\b401\b|unauthori[sz]ed|invalid (jwt|token)/.test(t))
    return `Access token: Supabase refused SUPABASE_ACCESS_TOKEN (HTTP 401) when supabase link used it: ${TOKEN_HINT}.`;
  if (/\b403\b|forbidden|permission|not allowed|insufficient/.test(t)) {
    return `Access token permissions: the token may not do what supabase link needs on project ${ref} (HTTP 403; it reads the project, its API keys and its database settings): ${TOKEN_HINT}.`;
  }
  if (/\b404\b|not found/.test(t)) {
    return `Project access: supabase link cannot find the project ${ref} with this token (HTTP 404): check SUPABASE_URL; ${TOKEN_HINT}.`;
  }
  return 'supabase link failed (its output is below).';
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const PAGES_HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.pages\.dev$/;
/** A Vault value we can deploy: no whitespace, at least 32 characters (both readers' minimum). */
const SECRET_VALUE = /^\S{32,}$/;
const tail = (text, lines = 12) =>
  String(text ?? '')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .slice(-lines);

// ─── Steps ──────────────────────────────────────────────────────────────────

/** `supabase link` once per run; then `migration list` tells what db push will apply. */
async function linkAndList(ctx) {
  if (ctx.migrations) return ctx.migrations;
  const { s } = ctx;
  // Writes supabase/.temp locally (the project ref, the pooler's address); nothing on the server.
  const link = await ctx.cli(['link', '--project-ref', s.ref], { db: true });
  if (link.code !== 0) {
    throw new DeployError(explainCliFailure(link.stderr, 'link', s.ref), {
      problems: tail(ctx.out.redact(link.stderr), 8),
    });
  }
  const r = await ctx.cli(['migration', 'list', '--linked', '--output-format', 'json'], {
    db: true,
    capture: true,
  });
  if (r.code !== 0) {
    throw new DeployError(explainCliFailure(r.stderr, 'database', s.ref), {
      problems: tail(ctx.out.redact(r.stderr), 8),
    });
  }
  let list;
  try {
    list = JSON.parse(r.stdout).migrations;
  } catch {
    list = undefined;
  }
  if (!Array.isArray(list)) throw new DeployError('supabase migration list: unexpected output');
  ctx.migrations = {
    pending: list.filter((m) => m.local && !m.remote).map((m) => m.local),
    remoteOnly: list.filter((m) => m.remote && !m.local).map((m) => m.remote),
  };
  return ctx.migrations;
}

async function preflight(ctx) {
  const { s, out, report } = ctx;
  const problems = [];
  const item = (name, detail) => {
    report.preflight.push({ name, detail });
    out.log(`  ok  ${name}: ${detail}`);
  };
  const reason = (e) => (e instanceof Error ? e.message : String(e));

  // ── Cloudflare: the deploy token, and Pages on the account (reading both projects) ──
  try {
    const v = await ctx.cf.verifyToken();
    if (v.status === 'active') item('CLOUDFLARE_API_TOKEN', `active (${v.kind} token)`);
    else problems.push(`CLOUDFLARE_API_TOKEN is ${v.status}, not active: create a new token`);
  } catch (e) {
    problems.push(
      `CLOUDFLARE_API_TOKEN was refused by Cloudflare (${reason(e)}): check the secret`,
    );
  }
  for (const [label, name, variable] of [
    ['web', s.webProject, 'CF_PAGES_WEB_PROJECT'],
    ['shell', s.shellProject, 'CF_PAGES_SHELL_PROJECT'],
  ]) {
    try {
      const p = await ctx.cf.getProject(name);
      ctx.projects[label] = p;
      if (p?.source) {
        problems.push(
          `The Pages project ${name} is connected to Git (${String(p.source.type ?? 'source')}); this workflow uploads builds directly. Set ${variable} to another name, or delete that project.`,
        );
      } else {
        item(
          `Pages project ${name}`,
          p ? `exists (https://${String(p.subdomain)})` : 'missing: it will be created',
        );
      }
    } catch (e) {
      problems.push(
        `CLOUDFLARE_API_TOKEN cannot use Cloudflare Pages on account ${s.accountId} (${reason(e)}). The token needs Account → Cloudflare Pages → Edit, for the account of CLOUDFLARE_ACCOUNT_ID.`,
      );
      break;
    }
  }

  // ── The Browser Rendering token (stored in Supabase as a function secret) ──
  // Only "is it active": Cloudflare renamed the product to Browser Run (2026-04), so its
  // permission is not checked by name; the first screenshot proves it (DEPLOY.md §6.3).
  const needs = (setting) => NEEDS[setting].includes(s.target);
  if (s.brToken && needs('BROWSER_RENDERING_API_TOKEN')) {
    try {
      const v = await ctx.cfBr.verifyToken({ accountFallback: false });
      if (v.status === 'active') item('BROWSER_RENDERING_API_TOKEN', 'active');
      else
        problems.push(`BROWSER_RENDERING_API_TOKEN is ${v.status}, not active: create a new token`);
    } catch (e) {
      problems.push(
        `BROWSER_RENDERING_API_TOKEN was refused by Cloudflare (${reason(e)}): create a custom token under My Profile → API Tokens with Account → Browser Run → Edit`,
      );
    }
  }

  // ── Supabase ──
  // The targets that change Supabase run its CLI (link, db push, functions deploy), which
  // checks the access token's format itself before any request.
  const changesSupabase = needs('SUPABASE_DB_PASSWORD');
  const cliTokenOk = !s.sbToken || CLI_TOKEN_FORMAT.test(s.sbToken);
  if (changesSupabase && !cliTokenOk) {
    problems.push(
      `Access token format: SUPABASE_ACCESS_TOKEN does not have the format the Supabase CLI ${SUPABASE_CLI.split('@')[1]} accepts (sbp_ followed by 40 hex characters; also sbp_v0_… or sbp_oauth_…), so supabase link, db push and functions deploy would refuse it: ${TOKEN_HINT}.`,
    );
  }
  try {
    const p = await ctx.sb.getProject();
    ctx.project = p;
    const problem = projectStatusProblem(p.status, s.ref);
    if (problem) problems.push(problem);
    else item('Supabase project', `${String(p.name)} (${s.ref}, ${String(p.region)}): healthy`);
  } catch (e) {
    problems.push(apiAccessProblem(e, 'read the project', s.ref));
  }
  const healthy = ctx.project?.status === 'ACTIVE_HEALTHY';

  // What the run will read or change through the Management API, read once now (a token
  // scoped to the project may lack one of them). Writing is proven by the run itself.
  if (healthy) {
    const probes = [
      changesSupabase && ['run SQL (database/query)', () => ctx.sql(probeSql())],
      s.target !== 'shell' && [
        'read the Auth settings',
        async () => (ctx.authConfig = await ctx.sb.getAuthConfig()),
      ],
      changesSupabase && ["read the functions' secrets", () => ctx.sb.listSecrets()],
    ].filter(Boolean);
    const failed = [];
    for (const [what, probe] of probes) {
      try {
        await probe();
      } catch (e) {
        failed.push(what);
        problems.push(apiAccessProblem(e, what, s.ref));
      }
    }
    if (!failed.length) item('SUPABASE_ACCESS_TOKEN', `can ${probes.map(([w]) => w).join(', ')}`);
  }

  if (healthy && s.anonKey && needs('SUPABASE_ANON_KEY')) {
    try {
      const r = await authSettings(ctx.http, s.supabaseUrl, s.anonKey);
      if (r.status === 200) item('SUPABASE_ANON_KEY', "the project's API accepts it");
      else if (r.status === 401 || r.status === 403)
        problems.push(
          `SUPABASE_ANON_KEY is not a key of the project ${s.ref} (HTTP ${String(r.status)}): copy the publishable (or anon) key from Project Settings → API Keys`,
        );
      else
        problems.push(
          `Checking SUPABASE_ANON_KEY: ${s.supabaseUrl}/auth/v1/settings answered HTTP ${String(r.status)}`,
        );
    } catch (e) {
      problems.push(`Checking SUPABASE_ANON_KEY: ${reason(e)}`);
    }
  }

  // CAPTCHA already on without a site key in the app would lock every player out.
  if (
    ctx.authConfig?.security_captcha_enabled === true &&
    ['all', 'check', 'web'].includes(s.target) &&
    !s.turnstileSiteKey
  ) {
    problems.push(
      'CAPTCHA is ON in Supabase but TURNSTILE_SITE_KEY is not set: the app would not be able to sign anyone in. Set the TURNSTILE_SITE_KEY variable (and TURNSTILE_SECRET_KEY), or turn CAPTCHA off (Authentication → Attack Protection).',
    );
  }

  // The CLI and the database password: `supabase link` (it writes supabase/.temp locally and
  // changes nothing on the server) and `migration list` (it connects and reads).
  if (healthy && s.dbPassword && changesSupabase && cliTokenOk) {
    try {
      const m = await linkAndList(ctx);
      item('Supabase CLI', 'supabase link accepted the access token');
      if (m.remoteOnly.length) {
        problems.push(
          `The database has migrations that this repository does not (${m.remoteOnly.join(', ')}): db push would refuse. Is SUPABASE_URL the project made for Build Roulette?`,
        );
      } else {
        item(
          'Database (SUPABASE_DB_PASSWORD)',
          m.pending.length
            ? `connected; ${String(m.pending.length)} migration(s) to apply`
            : 'connected; the schema is up to date',
        );
      }
    } catch (e) {
      const output = e instanceof DeployError ? e.problems : [];
      problems.push(reason(e), ...output.map((l) => `(supabase CLI) ${l}`));
    }
  }

  // The moderator's account must exist before the run changes anything.
  if (healthy && ctx.adminEmail && ['all', 'check', 'supabase'].includes(s.target)) {
    try {
      const users = await ctx.sql(countUsersSql(ctx.adminEmail, ctx.random));
      if (Number(users.users) === 0) problems.push(noUserMessage(ctx.adminEmail));
      else item('Moderator account', `${ctx.adminEmail} exists`);
    } catch (e) {
      problems.push(apiAccessProblem(e, "look up the moderator's account (SQL)", s.ref));
    }
  }

  // The shell alone takes its secret from Vault: it must be there.
  if (healthy && s.target === 'shell') {
    try {
      await readVault(ctx);
      if (!ctx.secrets.capture) problems.push(noCaptureSecretMessage());
      else item('CAPTURE_HMAC_SECRET', 'found in Supabase Vault');
    } catch (e) {
      problems.push(
        e instanceof DeployError
          ? reason(e)
          : apiAccessProblem(e, 'read Supabase Vault (SQL)', s.ref),
      );
    }
  }

  if (problems.length)
    throw new DeployError('The preflight checks failed; nothing was changed.', { problems });
  ctx.step('Preflight', 'ok', `${String(report.preflight.length)} checks passed`);
}

const noUserMessage = (email) =>
  `No user with the email ${email} in Supabase. Create the user first: Supabase → Authentication → Users → Add user → Create new user (Auto Confirm User checked), then run this workflow again with admin_email.`;
const noCaptureSecretMessage = () =>
  'CAPTURE_HMAC_SECRET is not in Supabase Vault yet (br_capture_hmac_secret): run the workflow with target supabase (or all) first.';

async function pages(ctx) {
  const { s, out } = ctx;
  for (const [label, name] of [
    ['web', s.webProject],
    ['shell', s.shellProject],
  ]) {
    let p = ctx.projects[label];
    if (p === undefined) p = await ctx.cf.getProject(name);
    if (p === null) {
      p = await ctx.cf.createProject(name, 'main');
      ctx.step(`Pages project ${name}`, 'created', `https://${String(p?.subdomain)}`);
    } else {
      ctx.step(`Pages project ${name}`, 'unchanged', `https://${String(p.subdomain)}`);
    }
    if (typeof p?.subdomain !== 'string' || !PAGES_HOST.test(p.subdomain)) {
      throw new DeployError(
        `The Pages project ${name} has no *.pages.dev address (subdomain ${JSON.stringify(p?.subdomain ?? null)})`,
      );
    }
    ctx.projects[label] = p;
  }
  const pagesApp = `https://${ctx.projects.web.subdomain}`;
  if (s.appUrl && s.appUrl.endsWith('.pages.dev') && s.appUrl !== pagesApp) {
    throw new DeployError(
      `APP_URL (${s.appUrl}) is a pages.dev address, but not the web project's (${pagesApp}). Delete the APP_URL variable (the default is the project's own address) or set it to your custom domain.`,
    );
  }
  const app = s.appUrl ?? pagesApp;
  ctx.urls = {
    app,
    pagesApp,
    shell: `https://${ctx.projects.shell.subdomain}${SHELL_PATH}`,
    // The shell may be framed by the app's address and, with a custom domain, its pages.dev one.
    appOrigins: app === pagesApp ? [app] : [app, pagesApp],
  };
  ctx.report.urls = { app: ctx.urls.app, shell: ctx.urls.shell };
  out.setOutput('app_url', ctx.urls.app);
  out.setOutput('shell_url', ctx.urls.shell);
}

async function schema(ctx) {
  const m = await linkAndList(ctx);
  await ctx.must(
    ctx.cli(['db', 'push', '--linked', '--yes', '--skip-vault'], { db: true }),
    'supabase db push',
  );
  ctx.step(
    'Database migrations',
    m.pending.length ? 'updated' : 'unchanged',
    m.pending.length
      ? `applied ${String(m.pending.length)} migration(s), up to ${m.pending[m.pending.length - 1]}`
      : 'already up to date',
  );
  const { problems, warnings } = evaluateSchema(await ctx.sql(schemaChecksSql()));
  for (const w of warnings) ctx.warn(w);
  if (problems.length)
    throw new DeployError('The checks after db push failed (DEPLOY.md §3.3)', { problems });
  ctx.step('Schema checks (DEPLOY.md §3.3)', 'ok', '6 cron jobs, 2 buckets, the prompt deck');
}

/** Reads our Vault secrets into ctx.secrets, masking them first. */
async function readVault(ctx) {
  const stored = await ctx.sql(readVaultSql());
  for (const name of [VAULT.cronSecret, VAULT.captureSecret]) {
    const v = stored[name];
    if (typeof v === 'string' && v.length >= 4) ctx.out.addSecret(v);
  }
  ctx.vault = stored;
  for (const [key, name] of [
    ['cron', VAULT.cronSecret],
    ['capture', VAULT.captureSecret],
  ]) {
    const v = stored[name];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string' || !SECRET_VALUE.test(v)) {
      throw new DeployError(
        `The Vault secret ${name} is not usable (it needs at least 32 characters, no spaces). Delete it in the SQL Editor (delete from vault.secrets where name = '${name}';) and run the workflow again: a new one is generated.`,
      );
    }
    ctx.secrets[key] = v;
  }
  return stored;
}

async function vault(ctx) {
  const { s, out } = ctx;
  const stored = await readVault(ctx);
  for (const [key, name, label] of [
    ['cron', VAULT.cronSecret, 'JOBS_CRON_SECRET'],
    ['capture', VAULT.captureSecret, 'CAPTURE_HMAC_SECRET'],
  ]) {
    if (ctx.secrets[key]) {
      ctx.step(`${label} (Vault ${name})`, 'unchanged', 'kept');
      continue;
    }
    const value = ctx.random(32).toString('hex');
    out.addSecret(value);
    await ctx.sql(createVaultSecretSql(name, value, 'hex', ctx.random));
    ctx.secrets[key] = value;
    ctx.step(`${label} (Vault ${name})`, 'created', 'generated: 32 random bytes');
  }
  const url = `https://${s.ref}.supabase.co/functions/v1/jobs`;
  const current = stored[VAULT.functionUrl];
  if (current === url) {
    ctx.step(`Vault ${VAULT.functionUrl}`, 'unchanged', url);
  } else if (current === undefined || current === null) {
    await ctx.sql(createVaultSecretSql(VAULT.functionUrl, url, 'functionUrl', ctx.random));
    ctx.step(`Vault ${VAULT.functionUrl}`, 'created', url);
  } else {
    const r = await ctx.sql(
      updateVaultSecretSql(VAULT.functionUrl, url, 'functionUrl', ctx.random),
    );
    if (Number(r.updated) !== 1)
      throw new DeployError(`Updating ${VAULT.functionUrl} changed nothing`);
    ctx.step(`Vault ${VAULT.functionUrl}`, 'updated', url);
  }
}

async function auth(ctx) {
  // Field names: the Management API's auth config (UpdateAuthConfigBody), as the Supabase CLI
  // 2.119.0 sends them for `config push`; uri_allow_list is one comma-separated string.
  const cfg = await ctx.sb.getAuthConfig();
  const patch = {};
  const changes = [];
  if (cfg.external_anonymous_users_enabled !== true) {
    patch.external_anonymous_users_enabled = true;
    changes.push('anonymous sign-ins on');
  }
  if (String(cfg.site_url ?? '').replace(/\/+$/, '') !== ctx.urls.app) {
    patch.site_url = ctx.urls.app;
    changes.push(`site URL ${ctx.urls.app}`);
  }
  const allow = mergeAllowList(cfg.uri_allow_list, ctx.urls.appOrigins);
  if (allow.added.length) {
    patch.uri_allow_list = allow.value;
    changes.push(`redirect URLs + ${allow.added.join(', ')}`);
  }
  if (cfg.external_email_enabled === false) {
    ctx.warn(
      'Email sign-in is OFF in Supabase: moderators sign in with email and password (Authentication → Sign In / Providers → Email).',
    );
  }
  if (changes.length) {
    await ctx.sb.patchAuthConfig(patch);
    ctx.step('Auth settings', 'updated', changes.join('; '));
  } else {
    ctx.step('Auth settings', 'unchanged', `anonymous sign-ins on; site URL ${ctx.urls.app}`);
  }
}

async function functions(ctx) {
  const { s } = ctx;
  const wanted = {
    JOBS_CRON_SECRET: ctx.secrets.cron,
    CAPTURE_SHELL_URL: `${ctx.urls.shell}capture`,
    CAPTURE_HMAC_SECRET: ctx.secrets.capture,
    PKG_CDN_URL: s.pkgCdnUrl,
    BROWSER_RENDERING_ACCOUNT_ID: s.accountId,
    BROWSER_RENDERING_API_TOKEN: s.brToken,
  };
  // The list holds digests (assumed: SHA-256 hex of the value, as the dashboard shows them).
  // A digest we cannot match only means the secret is set again with the same value.
  const existing = new Map((await ctx.sb.listSecrets()).map((x) => [x.name, x.value]));
  const changed = Object.entries(wanted).filter(
    ([name, value]) => existing.get(name) !== sha256(value),
  );
  if (changed.length) {
    await ctx.sb.setSecrets(changed.map(([name, value]) => ({ name, value })));
    const isNew = changed.every(([name]) => !existing.has(name));
    ctx.step('Function secrets', isNew ? 'created' : 'updated', changed.map(([n]) => n).join(', '));
  } else {
    ctx.step('Function secrets', 'unchanged', Object.keys(wanted).join(', '));
  }
  await ctx.must(
    ctx.cli([
      'functions',
      'deploy',
      'jobs',
      '--no-verify-jwt',
      '--use-api',
      '--project-ref',
      s.ref,
    ]),
    'supabase functions deploy jobs',
  );
  ctx.step('Edge Function jobs', 'deployed', `${s.supabaseUrl}/functions/v1/jobs`);
}

async function shell(ctx) {
  const { s } = ctx;
  if (!ctx.secrets.capture) {
    await readVault(ctx);
    if (!ctx.secrets.capture) throw new DeployError(noCaptureSecretMessage());
  }
  const p = ctx.projects.shell;
  const production = p.deployment_configs?.production ?? {};
  const had = Boolean(production.env_vars?.CAPTURE_HMAC_SECRET);
  // Before the deploy: a Pages secret applies to the next deployment.
  await ctx.cf.setSecret(
    p.name ?? s.shellProject,
    'CAPTURE_HMAC_SECRET',
    ctx.secrets.capture,
    production.wrangler_config_hash,
  );
  ctx.step(
    'Pages secret CAPTURE_HMAC_SECRET',
    had ? 'updated' : 'created',
    had ? 'set again from Vault (the same value unless Vault changed)' : 'from Vault',
  );
  await ctx.must(
    ctx.pnpm(['--filter', '@br/sandbox-shell', 'build'], {
      BR_APP_ORIGINS: ctx.urls.appOrigins.join(','),
      BR_PKG_CDN_URL: s.pkgCdnUrl,
    }),
    'the sandbox shell build',
  );
  const branch = p.production_branch || 'main';
  await ctx.must(
    ctx.pnpm(
      [
        '--filter',
        '@br/web',
        'exec',
        'wrangler',
        'pages',
        'deploy',
        'dist',
        '--cwd',
        '../sandbox-shell',
        '--project-name',
        s.shellProject,
        '--branch',
        branch,
      ],
      ctx.cloudflareEnv(),
    ),
    'wrangler pages deploy (sandbox shell)',
  );
  ctx.step('Sandbox shell', 'deployed', ctx.urls.shell);
}

async function web(ctx) {
  const { s } = ctx;
  const build = {
    NEXT_PUBLIC_SUPABASE_URL: s.supabaseUrl,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: s.anonKey,
    NEXT_PUBLIC_SANDBOX_SHELL_URL: ctx.urls.shell,
    NEXT_PUBLIC_PKG_CDN_URL: s.pkgCdnUrl,
    NEXT_PUBLIC_SITE_URL: ctx.urls.app,
    NEXT_TELEMETRY_DISABLED: '1',
  };
  if (s.turnstileSiteKey) build.NEXT_PUBLIC_TURNSTILE_SITE_KEY = s.turnstileSiteKey;
  if (s.sentryDsn) build.NEXT_PUBLIC_SENTRY_DSN = s.sentryDsn;
  if (s.posthogKey) build.NEXT_PUBLIC_POSTHOG_KEY = s.posthogKey;
  if (s.posthogHost) build.NEXT_PUBLIC_POSTHOG_HOST = s.posthogHost;
  await ctx.must(ctx.pnpm(['--filter', '@br/web', 'build'], build), 'the web app build');
  const args = [
    '--filter',
    '@br/web',
    'pages:deploy',
    '--branch',
    ctx.projects.web.production_branch || 'main',
  ];
  // apps/web/wrangler.jsonc names the default project; another name must be passed.
  if (s.webProject !== DEFAULTS.CF_PAGES_WEB_PROJECT) args.push('--project-name', s.webProject);
  await ctx.must(ctx.pnpm(args, ctx.cloudflareEnv()), 'wrangler pages deploy (web app)');
  const extras = [
    s.turnstileSiteKey && 'Turnstile',
    s.sentryDsn && 'Sentry',
    s.posthogKey && 'PostHog',
  ].filter(Boolean);
  ctx.step(
    'Web app',
    'deployed',
    `${ctx.urls.app}${extras.length ? ` (with ${extras.join(', ')})` : ''}`,
  );
}

async function captcha(ctx) {
  const { s } = ctx;
  if (!s.turnstileSiteKey || !s.turnstileSecret) {
    ctx.step(
      'CAPTCHA',
      'skipped',
      s.turnstileSiteKey || s.turnstileSecret
        ? 'only one of TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY is set'
        : 'no Turnstile keys set',
    );
    return;
  }
  // Only after the web app with the site key is live (this step runs after `web`).
  const cfg = await ctx.sb.getAuthConfig();
  if (
    cfg.security_captcha_enabled === true &&
    cfg.security_captcha_provider === 'turnstile' &&
    cfg.security_captcha_secret === s.turnstileSecret
  ) {
    ctx.step('CAPTCHA', 'unchanged', 'Cloudflare Turnstile');
    return;
  }
  await ctx.sb.patchAuthConfig({
    security_captcha_enabled: true,
    security_captcha_provider: 'turnstile',
    security_captcha_secret: s.turnstileSecret,
  });
  ctx.step(
    'CAPTCHA',
    cfg.security_captcha_enabled === true ? 'updated' : 'created',
    'Cloudflare Turnstile',
  );
}

async function admin(ctx) {
  if (ctx.adminEmail) {
    const r = await ctx.sql(addAdminSql(ctx.adminEmail, ctx.random));
    if (Number(r.users) === 0) throw new DeployError(noUserMessage(ctx.adminEmail));
    ctx.step(
      `Moderator ${ctx.adminEmail}`,
      Number(r.inserted) > 0 ? 'created' : 'unchanged',
      'listed in private.admins',
    );
  }
  ctx.admins = Number((await ctx.sql(countAdminsSql())).admins);
  if (!ctx.adminEmail) {
    ctx.step(
      'Moderator',
      'skipped',
      ctx.admins > 0
        ? `${String(ctx.admins)} moderator(s) listed`
        : 'none yet (see the next steps)',
    );
  }
}

async function smoke(ctx) {
  const { s, out } = ctx;
  const args = [
    path.join(ctx.repoRoot, 'scripts', 'deploy-check.mjs'),
    '--app',
    ctx.urls.app,
    '--shell',
    ctx.urls.shell,
    '--supabase',
    s.supabaseUrl,
    '--cdn',
    s.pkgCdnUrl,
    '--json',
  ];
  const env = childEnv(ctx.env, {
    SUPABASE_ANON_KEY: s.anonKey,
    JOBS_CRON_SECRET: ctx.secrets.cron,
  });
  let results = null;
  let failures = [];
  for (let attempt = 0; attempt <= SMOKE_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      out.log(
        `  deploy-check: ${String(failures.length)} failure(s); trying again in ${String(SMOKE_DELAYS_MS[attempt - 1] / 1000)} s (Pages takes a moment to serve a new deployment)`,
      );
      await ctx.sleep(SMOKE_DELAYS_MS[attempt - 1]);
    }
    const r = await ctx.run(process.execPath, args, { env, cwd: ctx.repoRoot, capture: true });
    if (r.code === 2)
      throw new DeployError('scripts/deploy-check.mjs refused its arguments', {
        problems: tail(out.redact(r.stderr)),
      });
    try {
      results = JSON.parse(r.stdout);
    } catch {
      results = null;
    }
    if (!Array.isArray(results)) {
      failures = [
        { level: 'FAIL', name: 'deploy-check', detail: `no results (exit ${String(r.code)})` },
      ];
      continue;
    }
    failures = results.filter((x) => x.level === 'FAIL');
    if (failures.length === 0) break;
  }
  ctx.report.checks = Array.isArray(results) ? results : failures;
  if (failures.length) {
    throw new DeployError(
      `deploy-check still FAILs after ${String(SMOKE_DELAYS_MS.length + 1)} tries`,
      {
        problems: failures.map((f) => `${f.name}: ${f.detail}`),
      },
    );
  }
  const warns = results.filter((x) => x.level === 'WARN').length;
  ctx.step(
    'deploy-check',
    'ok',
    `${String(results.length - warns)} passed, ${String(warns)} warning(s)`,
  );
}

const STEPS = {
  preflight,
  pages,
  schema,
  vault,
  auth,
  functions,
  shell,
  web,
  captcha,
  admin,
  smoke,
};

// ─── Report ─────────────────────────────────────────────────────────────────

function nextSteps(ctx) {
  const { report } = ctx;
  const next = [];
  const target = report.target;
  if (report.failed) {
    next.push(
      'Fix what the failure above says, then run the workflow again: every step is safe to repeat.',
    );
    return next;
  }
  if (target === 'check') {
    next.push('Everything needed is in place: run the workflow again with target **all**.');
    return next;
  }
  if ((target === 'all' || target === 'supabase') && ctx.admins === 0) {
    next.push(
      'Create the moderator: Supabase → Authentication → Users → Add user → Create new user (an email, a long password, **Auto Confirm User** checked). Then run this workflow again with target **supabase** and **admin_email** set to that address.',
    );
  }
  if (target === 'all') {
    next.push(
      'Keep the project awake: Actions → **Keep Supabase awake** → Run workflow, once (DEPLOY.md §5).',
    );
    next.push(
      `Play a battle: open ${report.urls.app ?? 'the app'} in two browsers (DEPLOY.md §6.2).`,
    );
    next.push(
      'Then DEPLOY.md §6.3–§6.6 (screenshots, link preview, admin) and §7 (rehearse the runbooks).',
    );
  } else {
    next.push(
      'Run target **all** (or the other targets) when the rest should follow; deploy-check runs with **all**.',
    );
  }
  return next;
}

const cell = (s) =>
  String(s ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\s*\n\s*/g, ' ');

export function renderSummary(report) {
  const lines = [];
  const status = report.failed ? 'FAILED' : 'succeeded';
  lines.push(`## Deploy, target \`${report.target}\`: ${status}`, '');
  const project = report.project;
  lines.push('| | |', '|---|---|');
  lines.push(`| App | ${cell(report.urls.app ?? '(not known yet)')} |`);
  lines.push(`| Sandbox shell | ${cell(report.urls.shell ?? '(not known yet)')} |`);
  lines.push(
    `| Supabase project | ${cell(project ? `\`${project.ref}\` (${project.name ?? '?'}, ${project.region ?? '?'})` : (report.ref ?? '(not known)'))} |`,
  );
  lines.push('');
  if (report.target === 'check' && report.preflight.length) {
    lines.push('### Checks', '');
    for (const p of report.preflight) lines.push(`- **${cell(p.name)}**: ${cell(p.detail)}`);
    lines.push('');
  }
  if (report.steps.length) {
    lines.push('### Steps', '', '| Step | Outcome | Details |', '|---|---|---|');
    for (const st of report.steps)
      lines.push(`| ${cell(st.name)} | ${st.outcome} | ${cell(st.detail)} |`);
    lines.push('');
  }
  if (report.failed) {
    lines.push(`### Failed: ${cell(report.failed.step)}`, '', cell(report.failed.message), '');
    for (const p of report.failed.problems) lines.push(`- ${cell(p)}`);
    lines.push('');
  }
  if (report.warnings.length) {
    lines.push('### Warnings', '');
    for (const w of report.warnings) lines.push(`- ${cell(w)}`);
    lines.push('');
  }
  if (report.checks) {
    const n = (l) => report.checks.filter((r) => r.level === l).length;
    lines.push(
      '### deploy-check',
      '',
      `${String(n('PASS'))} passed, ${String(n('WARN'))} warnings, ${String(n('FAIL'))} failed.`,
      '',
    );
    const notable = report.checks.filter((r) => r.level !== 'PASS');
    if (notable.length) {
      lines.push('| Level | Check | Details |', '|---|---|---|');
      for (const r of notable) lines.push(`| ${r.level} | ${cell(r.name)} | ${cell(r.detail)} |`);
      lines.push('');
    }
  }
  if (report.next.length) {
    lines.push('### Next steps', '');
    report.next.forEach((n, i) => lines.push(`${String(i + 1)}. ${n}`));
    lines.push('');
  }
  return lines.join('\n');
}

export function renderText(report) {
  const lines = [];
  lines.push('', `Deploy, target ${report.target}: ${report.failed ? 'FAILED' : 'succeeded'}`);
  lines.push(`  App:              ${report.urls.app ?? '(not known yet)'}`);
  lines.push(`  Sandbox shell:    ${report.urls.shell ?? '(not known yet)'}`);
  const p = report.project;
  lines.push(
    `  Supabase project: ${p ? `${p.ref} (${p.name ?? '?'}, ${p.region ?? '?'})` : (report.ref ?? '(not known)')}`,
  );
  if (report.steps.length) {
    lines.push('', 'Steps:');
    const w = Math.max(...report.steps.map((s) => s.name.length));
    for (const st of report.steps)
      lines.push(`  ${st.outcome.padEnd(9)}  ${st.name.padEnd(w)}  ${st.detail ?? ''}`);
  }
  if (report.failed) {
    lines.push('', `Failed: ${report.failed.step}: ${report.failed.message}`);
    for (const x of report.failed.problems) lines.push(`  - ${x}`);
  }
  if (report.warnings.length) {
    lines.push('', 'Warnings:');
    for (const x of report.warnings) lines.push(`  - ${x}`);
  }
  if (report.checks) {
    const n = (l) => report.checks.filter((r) => r.level === l).length;
    lines.push(
      '',
      `deploy-check: ${String(n('PASS'))} passed, ${String(n('WARN'))} warnings, ${String(n('FAIL'))} failed`,
    );
    for (const r of report.checks.filter((x) => x.level !== 'PASS'))
      lines.push(`  ${r.level}  ${r.name}  ${r.detail ?? ''}`);
  }
  if (report.next.length) {
    lines.push('', 'Next steps:');
    report.next.forEach((n, i) => lines.push(`  ${String(i + 1)}. ${n.replace(/\*\*/g, '')}`));
  }
  return lines.join('\n');
}

// ─── Main ───────────────────────────────────────────────────────────────────

/**
 * Runs a deploy. Everything with a side effect is injected (tests: scripts/deploy/deploy.test.mjs).
 * @returns {Promise<number>} the exit code: 0 done, 1 failed, 2 bad arguments
 */
export async function deploy({
  argv = [],
  env = {},
  fetch: fetchImpl = globalThis.fetch,
  makeRunner = createRunner,
  stdout = (s) => process.stdout.write(s),
  stderr = (s) => process.stderr.write(s),
  appendFile = appendFileSync,
  sleep = (ms) => delay(ms),
  random = cryptoRandomBytes,
  repoRoot = REPO_ROOT,
} = {}) {
  const out = createOutput({
    stdout,
    stderr,
    github: env.GITHUB_ACTIONS === 'true',
    appendFile,
    summaryPath: env.GITHUB_STEP_SUMMARY || undefined,
    outputPath: env.GITHUB_OUTPUT || undefined,
  });
  // Before anything else can print them.
  for (const v of secretValues(env)) out.addSecret(v);

  let args;
  try {
    args = parseArgs(argv, env);
  } catch (e) {
    out.error('Bad arguments', e instanceof Error ? e.message : String(e));
    return 2;
  }
  if (args.help) {
    out.log(USAGE);
    return 0;
  }

  const report = {
    target: args.target,
    urls: {},
    project: null,
    ref: undefined,
    preflight: [],
    steps: [],
    warnings: [],
    checks: null,
    next: [],
    failed: null,
  };
  const { settings: s, problems, warnings } = readSettings(env, args.target);
  report.ref = s.ref;
  if (args.adminEmail !== undefined && !isValidEmail(args.adminEmail)) {
    problems.push(
      'admin_email (--admin-email) is not an email address this script accepts: letters, digits and . _ + - before the @, a domain after it',
    );
  }
  const adminEmail = isValidEmail(args.adminEmail) ? args.adminEmail : undefined;

  const ctx = {
    s,
    env,
    out,
    report,
    repoRoot,
    random,
    sleep,
    adminEmail,
    projects: {},
    secrets: {},
    urls: {},
    http: { fetch: fetchImpl, sleep },
    run: makeRunner(out),
    step(name, outcome, detail = '') {
      report.steps.push({ name, outcome, detail });
      out.log(`  ${outcome.padEnd(9)}  ${name}${detail ? `: ${detail}` : ''}`);
    },
    warn(message) {
      report.warnings.push(message);
      out.warn('Deploy', message);
    },
    async must(promise, what) {
      const r = await promise;
      if (r.code !== 0) {
        throw new DeployError(`${what} failed (exit ${String(r.code)})`, {
          problems: tail(out.redact(r.stderr)),
        });
      }
      return r;
    },
    cli(cliArgs, { db = false, capture = false } = {}) {
      return ctx.run('npx', ['-y', SUPABASE_CLI, ...cliArgs], {
        cwd: repoRoot,
        capture,
        env: childEnv(env, {
          SUPABASE_ACCESS_TOKEN: s.sbToken,
          ...(db ? { SUPABASE_DB_PASSWORD: s.dbPassword } : {}),
        }),
      });
    },
    pnpm(pnpmArgs, extraEnv) {
      return ctx.run('pnpm', pnpmArgs, { cwd: repoRoot, env: childEnv(env, extraEnv) });
    },
    cloudflareEnv() {
      return {
        CLOUDFLARE_API_TOKEN: s.cfToken,
        CLOUDFLARE_ACCOUNT_ID: s.accountId,
        WRANGLER_SEND_METRICS: 'false',
      };
    },
    async sql(text) {
      return resultOf(await ctx.sb.query(text));
    },
  };
  if (adminEmail && !['all', 'check', 'supabase'].includes(args.target)) {
    warnings.push(
      `admin_email is used by the targets all and supabase; target ${args.target} ignores it`,
    );
  }
  for (const w of warnings) ctx.warn(w);

  let current = 'Settings';
  if (problems.length) {
    report.failed = {
      step: current,
      message: `${String(problems.length)} setting(s) missing or malformed; nothing was changed.`,
      problems,
    };
  } else {
    ctx.cf = cloudflareApi({ fetch: fetchImpl, sleep, token: s.cfToken, accountId: s.accountId });
    if (s.brToken)
      ctx.cfBr = cloudflareApi({
        fetch: fetchImpl,
        sleep,
        token: s.brToken,
        accountId: s.accountId,
      });
    ctx.sb = supabaseApi({ fetch: fetchImpl, sleep, token: s.sbToken, ref: s.ref });
    try {
      for (const name of PLANS[args.target]) {
        current = TITLES[name];
        out.group(current);
        try {
          await STEPS[name](ctx);
          if (name === 'preflight' && ctx.project) {
            report.project = { ref: s.ref, name: ctx.project.name, region: ctx.project.region };
          }
        } finally {
          out.endGroup();
        }
      }
    } catch (e) {
      report.failed = {
        step: current,
        message: e instanceof Error ? e.message : String(e),
        problems: e instanceof DeployError ? e.problems : [],
      };
      // A token scoped to the project may read but not write some part (the preflight only reads).
      if (e instanceof ApiError && e.api === 'supabase' && [401, 403].includes(e.status)) {
        report.failed.problems.push(
          `Access token permissions: SUPABASE_ACCESS_TOKEN may not make this change (HTTP ${String(e.status)}): ${TOKEN_HINT}.`,
        );
      }
      if (
        !(e instanceof DeployError) &&
        !(e instanceof ApiError) &&
        e instanceof Error &&
        e.stack
      ) {
        out.log(e.stack);
      }
    }
  }
  if (ctx.project && !report.project) {
    report.project = { ref: s.ref, name: ctx.project.name, region: ctx.project.region };
  }
  report.next = nextSteps(ctx);
  if (report.failed) {
    out.error(
      `Deploy failed: ${report.failed.step}`,
      [report.failed.message, ...report.failed.problems.map((p) => `- ${p}`)].join('\n'),
    );
  }
  out.log(renderText(report));
  out.summary(renderSummary(report));
  return report.failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await deploy({ argv: process.argv.slice(2), env: process.env });
}
