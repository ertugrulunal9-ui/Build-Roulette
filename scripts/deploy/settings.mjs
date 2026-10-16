// The deploy's settings (T-042), all from the environment: on GitHub Actions the repository's
// variables and secrets (.github/workflows/deploy.yml), locally a loaded `.env.deploy`.
// readSettings collects every missing or malformed setting at once and names them, never
// their values.

export const TARGETS = ['all', 'check', 'supabase', 'shell', 'web'];

export const DEFAULTS = {
  PKG_CDN_URL: 'https://esm.sh',
  CF_WEB_WORKER: 'build-roulette-web',
  CF_SANDBOX_WORKER: 'build-roulette-sandbox',
  /** The workers.dev subdomains the run registers when an account has none (a suffix if taken). */
  CF_WORKERS_SUBDOMAIN: 'buildroulette',
  CF_SANDBOX_WORKERS_SUBDOMAIN: 'buildroulette-sandbox',
};

/** Secrets that come from the environment (GitHub secrets). Masked first, never printed. */
export const SECRET_SETTINGS = [
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_SANDBOX_API_TOKEN',
  'BROWSER_RENDERING_API_TOKEN',
  'SUPABASE_ACCESS_TOKEN',
  'SUPABASE_DB_PASSWORD',
  'SUPABASE_ANON_KEY',
  'TURNSTILE_SECRET_KEY',
];

/** Names that never reach a child process unless the step passes them on purpose. */
export const CHILD_ENV_DENYLIST = new Set([
  ...SECRET_SETTINGS,
  'JOBS_CRON_SECRET',
  'CAPTURE_HMAC_SECRET',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SERVICE_ROLE_KEY',
  'SUPABASE_SECRET_KEY',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_SANDBOX_ACCOUNT_ID',
  'GITHUB_TOKEN',
  'GH_TOKEN',
]);

/** Which required settings each target needs (`check` verifies what `all` will need). */
export const NEEDS = {
  CLOUDFLARE_ACCOUNT_ID: TARGETS,
  CLOUDFLARE_API_TOKEN: TARGETS,
  // Every target needs both addresses: the app's (account A) and the sandbox's (account B).
  CLOUDFLARE_SANDBOX_ACCOUNT_ID: TARGETS,
  CLOUDFLARE_SANDBOX_API_TOKEN: TARGETS,
  SUPABASE_URL: TARGETS,
  SUPABASE_ACCESS_TOKEN: TARGETS,
  SUPABASE_DB_PASSWORD: ['all', 'check', 'supabase'],
  BROWSER_RENDERING_API_TOKEN: ['all', 'check', 'supabase'],
  SUPABASE_ANON_KEY: ['all', 'check', 'web'],
};

/** Where each required value comes from (DEPLOY.md, "Deploy with GitHub Actions"). */
const WHERE = {
  CLOUDFLARE_ACCOUNT_ID:
    'variable: the id of your Cloudflare account A, the web app\'s: Workers & Pages → Overview, "Account ID"',
  CLOUDFLARE_API_TOKEN:
    'secret: a custom Cloudflare API token of account A with Account → Workers Scripts → Edit',
  CLOUDFLARE_SANDBOX_ACCOUNT_ID:
    'variable: the id of a SECOND Cloudflare account, B, for the sandbox shell: its Workers & Pages → Overview, "Account ID"',
  CLOUDFLARE_SANDBOX_API_TOKEN:
    'secret: a custom Cloudflare API token of account B with Account → Workers Scripts → Edit',
  SUPABASE_URL: 'variable: https://<project ref>.supabase.co',
  SUPABASE_ACCESS_TOKEN: 'secret: supabase.com → Account → Access Tokens',
  SUPABASE_DB_PASSWORD: "secret: the project's database password",
  BROWSER_RENDERING_API_TOKEN:
    'secret: a second custom Cloudflare API token with Account → Browser Run → Edit (named Browser Rendering before April 2026)',
  SUPABASE_ANON_KEY: 'secret: Project Settings → API Keys, the publishable (or legacy anon) key',
};

/** A Worker name, also the first label of its workers.dev address. */
const WORKER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** A workers.dev subdomain, as wrangler 4.147.0 validates it before registering one. */
export const SUBDOMAIN_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const TOKEN = /^[A-Za-z0-9_-]{20,}$/;

/**
 * Why the sandbox shell needs its own Cloudflare account (DEPLOY.md, "Deploy with GitHub
 * Actions" → A): the reason given wherever account B is missing or is account A.
 */
export const SECOND_ACCOUNT_WHY =
  "The sandbox shell runs players' code, so it must be another site than the app. A Worker's address is <name>.<account subdomain>.workers.dev, and the Public Suffix List lists workers.dev (not *.workers.dev), so two Workers of ONE account share the site <account subdomain>.workers.dev. The shell therefore goes to a second, free Cloudflare account, whose own subdomain is another site.";

function decodeJwtPayload(key) {
  const parts = key.split('.');
  if (parts.length !== 3 || !parts[0].startsWith('eyJ')) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Problems with the key the app ships (the same rule as the web build's `secretKeysIn`,
 * apps/web/src/lib/hosting/pages-config.ts: a JWT whose role is not `anon`, or an
 * `sb_secret_` key, must never reach the browser). Never echoes the key.
 */
export function anonKeyProblems(key, ref) {
  if (key.startsWith('sb_secret_')) {
    return [
      'SUPABASE_ANON_KEY is a SECRET key (sb_secret_…): use the publishable key (sb_publishable_…) or the legacy anon key; the secret key must never ship in the app',
    ];
  }
  if (key.startsWith('sb_publishable_')) {
    return /^sb_publishable_[A-Za-z0-9_-]{8,}$/.test(key)
      ? []
      : ['SUPABASE_ANON_KEY looks like a truncated publishable key'];
  }
  const payload = decodeJwtPayload(key);
  if (!payload) {
    return [
      'SUPABASE_ANON_KEY is neither a publishable key (sb_publishable_…) nor the legacy anon key (a JWT, eyJ…)',
    ];
  }
  if (payload.role !== 'anon') {
    return [
      `SUPABASE_ANON_KEY is a JWT with role ${JSON.stringify(payload.role ?? null)} (the service_role key?): use the publishable or anon key; anything else must never ship in the app`,
    ];
  }
  if (ref && typeof payload.ref === 'string' && payload.ref !== ref) {
    return [`SUPABASE_ANON_KEY belongs to project ${payload.ref}, not ${ref} (SUPABASE_URL)`];
  }
  return [];
}

function httpsBase(value, name, problems, { originOnly = false } = {}) {
  let u;
  try {
    u = new URL(value);
  } catch {
    problems.push(`${name} is not a URL`);
    return undefined;
  }
  if (u.protocol !== 'https:') problems.push(`${name} must start with https://`);
  else if (u.username || u.password || u.search || u.hash)
    problems.push(`${name} must be a plain URL (no credentials, query or fragment)`);
  else if (originOnly && u.pathname !== '/')
    problems.push(`${name} must be an origin only, like https://play.example.com (no path)`);
  else return originOnly ? u.origin : `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  return undefined;
}

/**
 * Reads and validates the settings for `target`.
 * @returns {{settings: object, problems: string[], warnings: string[]}}
 */
export function readSettings(env, target) {
  const problems = [];
  const warnings = [];
  const get = (name) => {
    const v = env[name];
    if (typeof v !== 'string') return undefined;
    const t = v.trim();
    return t === '' ? undefined : t;
  };
  const required = (name) => {
    const v = get(name);
    if (v === undefined && NEEDS[name].includes(target))
      problems.push(`${name} is missing (${WHERE[name]})`);
    return v;
  };

  const s = { target };
  s.accountId = required('CLOUDFLARE_ACCOUNT_ID');
  if (s.accountId && !/^[0-9a-fA-F]{32}$/.test(s.accountId)) {
    problems.push(
      'CLOUDFLARE_ACCOUNT_ID must be the 32-character account id (Workers & Pages → Overview)',
    );
  }
  // Account B (the sandbox shell). Both missing: B is not set up yet, said once.
  const bMissing =
    get('CLOUDFLARE_SANDBOX_ACCOUNT_ID') === undefined &&
    get('CLOUDFLARE_SANDBOX_API_TOKEN') === undefined;
  if (bMissing && NEEDS.CLOUDFLARE_SANDBOX_ACCOUNT_ID.includes(target)) {
    problems.push(
      `The sandbox shell's Cloudflare account (B) is not set up yet: CLOUDFLARE_SANDBOX_ACCOUNT_ID (a variable) and CLOUDFLARE_SANDBOX_API_TOKEN (a secret) are missing. Create a second free Cloudflare account, a token there with Account → Workers Scripts → Edit, and add both (DEPLOY.md, "Deploy with GitHub Actions" → A–C). ${SECOND_ACCOUNT_WHY}`,
    );
  } else {
    s.sandboxAccountId = required('CLOUDFLARE_SANDBOX_ACCOUNT_ID');
  }
  if (s.sandboxAccountId && !/^[0-9a-fA-F]{32}$/.test(s.sandboxAccountId)) {
    problems.push(
      'CLOUDFLARE_SANDBOX_ACCOUNT_ID must be the 32-character id of account B (its Workers & Pages → Overview)',
    );
  }
  if (
    s.accountId &&
    s.sandboxAccountId &&
    s.accountId.toLowerCase() === s.sandboxAccountId.toLowerCase()
  ) {
    problems.push(
      `CLOUDFLARE_SANDBOX_ACCOUNT_ID is the same account as CLOUDFLARE_ACCOUNT_ID: the sandbox shell must be deployed to a SECOND Cloudflare account. ${SECOND_ACCOUNT_WHY}`,
    );
  }

  const url = required('SUPABASE_URL');
  if (url) {
    const m = /^https:\/\/([a-z]{20})\.supabase\.co\/?$/.exec(url);
    if (m) {
      s.ref = m[1];
      s.supabaseUrl = `https://${s.ref}.supabase.co`;
    } else {
      problems.push(
        "SUPABASE_URL must be the project's API URL, https://<project ref>.supabase.co (the ref is 20 lower-case letters)",
      );
    }
  }
  const refFromEnv = get('SUPABASE_REF');
  if (refFromEnv && s.ref && refFromEnv !== s.ref) {
    problems.push(`SUPABASE_REF (${refFromEnv}) is not the project of SUPABASE_URL (${s.ref})`);
  }

  for (const [name, key] of [
    ['CLOUDFLARE_API_TOKEN', 'cfToken'],
    ['CLOUDFLARE_SANDBOX_API_TOKEN', 'sandboxToken'],
    ['BROWSER_RENDERING_API_TOKEN', 'brToken'],
  ]) {
    const v = name === 'CLOUDFLARE_SANDBOX_API_TOKEN' && bMissing ? undefined : required(name);
    if (v && !TOKEN.test(v))
      problems.push(`${name} does not look like a Cloudflare API token (letters, digits, - and _)`);
    s[key] = v;
  }
  for (const [other, key] of [
    ['CLOUDFLARE_API_TOKEN', 'cfToken'],
    ['CLOUDFLARE_SANDBOX_API_TOKEN', 'sandboxToken'],
  ]) {
    if (s.brToken && s[key] && s[key] === s.brToken) {
      problems.push(
        `BROWSER_RENDERING_API_TOKEN must be a separate token from ${other} (it is stored in Supabase; with Workers permissions a leak there could redeploy a site)`,
      );
    }
  }
  if (s.cfToken && s.sandboxToken && s.cfToken === s.sandboxToken) {
    warnings.push(
      'CLOUDFLARE_SANDBOX_API_TOKEN is the same token as CLOUDFLARE_API_TOKEN: it works if the token reaches both accounts, but a leak of it then reaches both. One token per account (each created in its own account) is safer.',
    );
  }

  s.sbToken = required('SUPABASE_ACCESS_TOKEN');
  if (s.sbToken && /\s/.test(s.sbToken))
    problems.push('SUPABASE_ACCESS_TOKEN contains spaces or line breaks');
  s.dbPassword = required('SUPABASE_DB_PASSWORD');
  if (s.dbPassword && /[\r\n]/.test(s.dbPassword))
    problems.push('SUPABASE_DB_PASSWORD contains a line break');
  if (s.dbPassword && s.dbPassword.length < 4)
    problems.push('SUPABASE_DB_PASSWORD is too short to be the database password');

  s.anonKey = required('SUPABASE_ANON_KEY');
  if (s.anonKey) problems.push(...anonKeyProblems(s.anonKey, s.ref));

  // ── Optional ──
  const appUrl = get('APP_URL');
  if (appUrl) s.appUrl = httpsBase(appUrl, 'APP_URL', problems, { originOnly: true });
  if (s.appUrl && new URL(s.appUrl).hostname.endsWith('.pages.dev')) {
    problems.push(
      "APP_URL is a pages.dev address: the app is no longer deployed to Cloudflare Pages (pages.dev is blocked in Turkey). Delete the APP_URL variable (the default is the web Worker's workers.dev address) or set it to a custom domain.",
    );
    s.appUrl = undefined;
  }
  s.pkgCdnUrl = httpsBase(get('PKG_CDN_URL') ?? DEFAULTS.PKG_CDN_URL, 'PKG_CDN_URL', problems);

  s.webWorker = get('CF_WEB_WORKER') ?? DEFAULTS.CF_WEB_WORKER;
  s.shellWorker = get('CF_SANDBOX_WORKER') ?? DEFAULTS.CF_SANDBOX_WORKER;
  for (const [name, v] of [
    ['CF_WEB_WORKER', s.webWorker],
    ['CF_SANDBOX_WORKER', s.shellWorker],
  ]) {
    if (!WORKER_NAME.test(v))
      problems.push(
        `${name} must be a Worker name (lower-case letters, digits and -, at most 63 characters)`,
      );
  }
  // The subdomain to register when an account has none (an explicit name is used as is).
  s.webSubdomain = get('CF_WORKERS_SUBDOMAIN');
  s.shellSubdomain = get('CF_SANDBOX_WORKERS_SUBDOMAIN');
  for (const [name, v] of [
    ['CF_WORKERS_SUBDOMAIN', s.webSubdomain],
    ['CF_SANDBOX_WORKERS_SUBDOMAIN', s.shellSubdomain],
  ]) {
    if (v !== undefined && !SUBDOMAIN_NAME.test(v))
      problems.push(
        `${name} must be a workers.dev subdomain: lower-case letters, digits and -, at most 63 characters, without .workers.dev`,
      );
  }
  if (s.webSubdomain && s.webSubdomain === s.shellSubdomain) {
    problems.push(
      'CF_WORKERS_SUBDOMAIN and CF_SANDBOX_WORKERS_SUBDOMAIN must differ: each account has its own subdomain, and the two must be different sites',
    );
  }
  for (const [old, now] of [
    ['CF_PAGES_WEB_PROJECT', 'CF_WEB_WORKER'],
    ['CF_PAGES_SHELL_PROJECT', 'CF_SANDBOX_WORKER'],
  ]) {
    if (get(old)) {
      warnings.push(
        `${old} is not used any more (the sites are Workers since T-043): the name is ${now} now (default ${DEFAULTS[now]}). Delete the ${old} variable.`,
      );
    }
  }

  s.turnstileSiteKey = get('TURNSTILE_SITE_KEY');
  s.turnstileSecret = get('TURNSTILE_SECRET_KEY');
  if (s.turnstileSiteKey && !/^[A-Za-z0-9_-]{8,}$/.test(s.turnstileSiteKey))
    problems.push('TURNSTILE_SITE_KEY does not look like a Turnstile site key (0x…)');
  if (s.turnstileSecret && !/^[A-Za-z0-9_-]{8,}$/.test(s.turnstileSecret))
    problems.push('TURNSTILE_SECRET_KEY does not look like a Turnstile secret key (0x…)');
  if (Boolean(s.turnstileSiteKey) !== Boolean(s.turnstileSecret)) {
    warnings.push(
      `Turnstile is half configured: ${s.turnstileSiteKey ? 'TURNSTILE_SITE_KEY' : 'TURNSTILE_SECRET_KEY'} is set but not ${s.turnstileSiteKey ? 'TURNSTILE_SECRET_KEY' : 'TURNSTILE_SITE_KEY'}; CAPTCHA stays off (set both to turn it on)`,
    );
  }

  // A DSN carries its (public) key as the URL's user part: https://<key>@o1.ingest.sentry.io/2
  const dsn = get('NEXT_PUBLIC_SENTRY_DSN');
  if (dsn) {
    if (URL.canParse(dsn) && new URL(dsn).protocol === 'https:' && !/\s/.test(dsn))
      s.sentryDsn = dsn;
    else problems.push('NEXT_PUBLIC_SENTRY_DSN must be the https:// DSN of the Sentry project');
  }
  const phKey = get('NEXT_PUBLIC_POSTHOG_KEY');
  if (phKey) {
    if (/\s/.test(phKey)) problems.push('NEXT_PUBLIC_POSTHOG_KEY contains spaces');
    else s.posthogKey = phKey;
  }
  const phHost = get('NEXT_PUBLIC_POSTHOG_HOST');
  if (phHost) s.posthogHost = httpsBase(phHost, 'NEXT_PUBLIC_POSTHOG_HOST', problems);

  for (const name of ['JOBS_CRON_SECRET', 'CAPTURE_HMAC_SECRET', 'SHELL_URL']) {
    if (get(name)) {
      warnings.push(
        `${name} from the environment is not used: ${name === 'SHELL_URL' ? "the shell URL comes from account B's workers.dev subdomain" : 'the value in Supabase Vault is the one deployed'}`,
      );
    }
  }
  return { settings: s, problems, warnings };
}

/** The secret values among the settings (to mask before anything else is printed). */
export function secretValues(env) {
  return SECRET_SETTINGS.map((n) => env[n]?.trim()).filter(
    (v) => typeof v === 'string' && v !== '',
  );
}

/**
 * The environment for a child process: the parent's without any secret or build setting,
 * plus `extra` (what that step passes on purpose).
 */
export function childEnv(base, extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (CHILD_ENV_DENYLIST.has(k) || k.startsWith('NEXT_PUBLIC_') || k.startsWith('BR_')) continue;
    // CF_*: wrangler still reads the old CF_API_TOKEN / CF_ACCOUNT_ID names; a step passes
    // CLOUDFLARE_* for the account it deploys to, and nothing else may reach wrangler.
    if (
      k.startsWith('SUPABASE_') ||
      k.startsWith('CLOUDFLARE_') ||
      k.startsWith('CF_') ||
      k.startsWith('TURNSTILE_')
    )
      continue;
    env[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) env[k] = v;
  return env;
}
