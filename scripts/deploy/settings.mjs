// The deploy's settings (T-042), all from the environment: on GitHub Actions the repository's
// variables and secrets (.github/workflows/deploy.yml), locally a loaded `.env.deploy`.
// readSettings collects every missing or malformed setting at once and names them, never
// their values.

export const TARGETS = ['all', 'check', 'supabase', 'shell', 'web'];

export const DEFAULTS = {
  PKG_CDN_URL: 'https://esm.sh',
  CF_PAGES_WEB_PROJECT: 'build-roulette-web',
  CF_PAGES_SHELL_PROJECT: 'build-roulette-sandbox',
};

/** Secrets that come from the environment (GitHub secrets). Masked first, never printed. */
export const SECRET_SETTINGS = [
  'CLOUDFLARE_API_TOKEN',
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
  'GITHUB_TOKEN',
  'GH_TOKEN',
]);

/** Which required settings each target needs (`check` verifies what `all` will need). */
export const NEEDS = {
  CLOUDFLARE_ACCOUNT_ID: TARGETS,
  CLOUDFLARE_API_TOKEN: TARGETS,
  SUPABASE_URL: TARGETS,
  SUPABASE_ACCESS_TOKEN: TARGETS,
  SUPABASE_DB_PASSWORD: ['all', 'check', 'supabase'],
  BROWSER_RENDERING_API_TOKEN: ['all', 'check', 'supabase'],
  SUPABASE_ANON_KEY: ['all', 'check', 'web'],
};

/** Where each required value comes from (DEPLOY.md, "Deploy with GitHub Actions"). */
const WHERE = {
  CLOUDFLARE_ACCOUNT_ID: 'variable: Cloudflare → Workers & Pages → Overview, "Account ID"',
  CLOUDFLARE_API_TOKEN:
    'secret: a custom Cloudflare API token with Account → Cloudflare Pages → Edit',
  SUPABASE_URL: 'variable: https://<project ref>.supabase.co',
  SUPABASE_ACCESS_TOKEN: 'secret: supabase.com → Account → Access Tokens',
  SUPABASE_DB_PASSWORD: "secret: the project's database password",
  BROWSER_RENDERING_API_TOKEN:
    'secret: a second custom Cloudflare API token with Account → Browser Run → Edit (named Browser Rendering before April 2026)',
  SUPABASE_ANON_KEY: 'secret: Project Settings → API Keys, the publishable (or legacy anon) key',
};

const PAGES_NAME = /^[a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?$/;
const TOKEN = /^[A-Za-z0-9_-]{20,}$/;

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

  for (const name of ['CLOUDFLARE_API_TOKEN', 'BROWSER_RENDERING_API_TOKEN']) {
    const v = required(name);
    if (v && !TOKEN.test(v))
      problems.push(`${name} does not look like a Cloudflare API token (letters, digits, - and _)`);
    s[name === 'CLOUDFLARE_API_TOKEN' ? 'cfToken' : 'brToken'] = v;
  }
  if (s.cfToken && s.brToken && s.cfToken === s.brToken) {
    problems.push(
      'BROWSER_RENDERING_API_TOKEN must be a separate token from CLOUDFLARE_API_TOKEN (it is stored in Supabase; with Pages permissions a leak there could redeploy the site)',
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
  s.pkgCdnUrl = httpsBase(get('PKG_CDN_URL') ?? DEFAULTS.PKG_CDN_URL, 'PKG_CDN_URL', problems);

  s.webProject = get('CF_PAGES_WEB_PROJECT') ?? DEFAULTS.CF_PAGES_WEB_PROJECT;
  s.shellProject = get('CF_PAGES_SHELL_PROJECT') ?? DEFAULTS.CF_PAGES_SHELL_PROJECT;
  for (const [name, v] of [
    ['CF_PAGES_WEB_PROJECT', s.webProject],
    ['CF_PAGES_SHELL_PROJECT', s.shellProject],
  ]) {
    if (!PAGES_NAME.test(v))
      problems.push(`${name} must be a Pages project name (lower-case letters, digits and -)`);
  }
  if (s.webProject === s.shellProject) {
    problems.push(
      'CF_PAGES_WEB_PROJECT and CF_PAGES_SHELL_PROJECT must differ: the sandbox shell runs untrusted code on its own site',
    );
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
        `${name} from the environment is not used: ${name === 'SHELL_URL' ? 'the shell URL comes from its Pages project' : 'the value in Supabase Vault is the one deployed'}`,
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
    if (k.startsWith('SUPABASE_') || k.startsWith('CLOUDFLARE_') || k.startsWith('TURNSTILE_'))
      continue;
    env[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) env[k] = v;
  return env;
}
